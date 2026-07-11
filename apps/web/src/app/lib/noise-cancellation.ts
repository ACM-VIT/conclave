"use client";

// NOTE: @sapphi-red/web-noise-suppressor references AudioWorkletNode at module
// scope, so it must only ever be imported dynamically, in environments where
// AudioWorkletNode exists (a static import would throw during SSR/prerender
// and in browsers without AudioWorklet, taking the whole chunk down).
import type { RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";

type CleanupOptions = {
  stopSource?: boolean;
  stopOutput?: boolean;
};

/**
 * Which denoiser actually engaged:
 * - "rnnoise": the RNNoise neural denoiser (wasm worklet) — Krisp-style
 *   per-frame noise removal that works during speech.
 * - "gate": the hand-rolled adaptive RMS gate worklet (fallback).
 * - "filters": neither worklet was available; only the filter/dynamics chain.
 */
type NoiseCancellationEngine = "rnnoise" | "gate" | "filters";

export type NoiseCancellationPipeline = {
  sourceTrack: MediaStreamTrack;
  outputTrack: MediaStreamTrack;
  stream: MediaStream;
  usedWorklet: boolean;
  engine: NoiseCancellationEngine;
  cleanup: (options?: CleanupOptions) => void;
};

type NoiseCancellationPipelineInternal = NoiseCancellationPipeline & {
  context: AudioContext;
  nodes: AudioNode[];
  disposed: boolean;
};

const outputTrackPipelines = new WeakMap<
  MediaStreamTrack,
  NoiseCancellationPipelineInternal
>();
const sourceTrackPipelines = new WeakMap<
  MediaStreamTrack,
  NoiseCancellationPipelineInternal
>();
const workletLoadPromises = new WeakMap<AudioContext, Promise<boolean>>();
const rnnoiseWorkletLoadPromises = new WeakMap<
  AudioContext,
  Promise<boolean>
>();

// RNNoise assets are copied from @sapphi-red/web-noise-suppressor into
// public/ by scripts/sync-noise-suppressor-assets.mjs. The version suffix must
// match the installed package so the immutable cache stays correct.
const NOISE_SUPPRESSOR_ASSET_VERSION = "0.3.5";
const NOISE_SUPPRESSOR_ASSET_BASE = `/noise-suppressor/${NOISE_SUPPRESSOR_ASSET_VERSION}`;
const RNNOISE_WASM_URL = `${NOISE_SUPPRESSOR_ASSET_BASE}/rnnoise.wasm`;
const RNNOISE_SIMD_WASM_URL = `${NOISE_SUPPRESSOR_ASSET_BASE}/rnnoise_simd.wasm`;
const RNNOISE_WORKLET_URL = `${NOISE_SUPPRESSOR_ASSET_BASE}/rnnoise-worklet.js`;

// Wasm SIMD feature probe (from wasm-feature-detect): a minimal module using
// a SIMD instruction; validates only where SIMD is supported.
const WASM_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1,
  8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

const fetchWasmBinary = async (url: string): Promise<ArrayBuffer> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`wasm fetch failed: ${response.status} ${url}`);
  }
  const binary = await response.arrayBuffer();
  // A misdeployed asset path returns an HTML error page with a 200 in some
  // setups; publishing through a dead denoiser would mean a silent mic, so
  // verify the wasm magic before trusting the bytes.
  const magic = new Uint8Array(binary.slice(0, 4));
  if (
    magic[0] !== 0x00 ||
    magic[1] !== 0x61 ||
    magic[2] !== 0x73 ||
    magic[3] !== 0x6d
  ) {
    throw new Error(`not a wasm binary: ${url}`);
  }
  return binary;
};

// One wasm download per session, shared by every pipeline; reset on failure so
// a transient network error doesn't disable RNNoise until reload.
let rnnoiseWasmPromise: Promise<ArrayBuffer> | null = null;

const loadRnnoiseWasm = (): Promise<ArrayBuffer> => {
  if (!rnnoiseWasmPromise) {
    rnnoiseWasmPromise = (async () => {
      const simdSupported = WebAssembly.validate(WASM_SIMD_PROBE);
      return fetchWasmBinary(
        simdSupported ? RNNOISE_SIMD_WASM_URL : RNNOISE_WASM_URL,
      );
    })().catch((error: unknown) => {
      rnnoiseWasmPromise = null;
      throw error;
    });
  }
  return rnnoiseWasmPromise;
};

const loadRnnoiseWorklet = (context: AudioContext): Promise<boolean> => {
  if (!context.audioWorklet) {
    return Promise.resolve(false);
  }
  const existing = rnnoiseWorkletLoadPromises.get(context);
  if (existing) return existing;

  const promise = context.audioWorklet
    .addModule(RNNOISE_WORKLET_URL)
    .then(() => true)
    .catch((error: unknown) => {
      console.warn("[Meets] RNNoise worklet unavailable:", error);
      return false;
    });
  rnnoiseWorkletLoadPromises.set(context, promise);
  return promise;
};

/** RNNoise assumes 48kHz; the pipeline's AudioContext is created at 48kHz. */
const createRnnoiseNode = async (
  context: AudioContext,
): Promise<RnnoiseWorkletNode | null> => {
  if (
    typeof window === "undefined" ||
    typeof AudioWorkletNode === "undefined" ||
    typeof WebAssembly === "undefined"
  ) {
    return null;
  }
  try {
    const [{ RnnoiseWorkletNode: RnnoiseNode }, wasmBinary, workletLoaded] =
      await Promise.all([
        import("@sapphi-red/web-noise-suppressor"),
        loadRnnoiseWasm(),
        loadRnnoiseWorklet(context),
      ]);
    if (!workletLoaded) return null;
    const node = new RnnoiseNode(context, {
      wasmBinary,
      maxChannels: 2,
    });
    node.onprocessorerror = (event) => {
      console.warn("[Meets] RNNoise processor error:", event);
    };
    return node;
  } catch (error) {
    console.warn("[Meets] RNNoise unavailable; falling back to gate:", error);
    return null;
  }
};

const NOISE_CANCELLATION_WORKLET = `
class ConclaveNoiseCancellationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.noiseFloor = 0.0035;
    this.gain = 1;
    this.holdFrames = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) {
      return true;
    }

    const channels = Math.min(input.length, output.length);
    let sumSquares = 0;
    let sampleCount = 0;

    for (let c = 0; c < channels; c += 1) {
      const channel = input[c];
      for (let i = 0; i < channel.length; i += 1) {
        const sample = channel[i];
        sumSquares += sample * sample;
      }
      sampleCount += channel.length;
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, sampleCount));
    const quietEnoughForFloor = rms < this.noiseFloor * 1.45 || rms < 0.012;
    if (quietEnoughForFloor) {
      this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005;
    } else {
      this.noiseFloor = Math.max(0.0025, this.noiseFloor * 0.9995);
    }

    const openThreshold = Math.max(0.012, this.noiseFloor * 3.6);
    const closeThreshold = Math.max(0.006, this.noiseFloor * 2.2);
    let targetGain = 1;

    if (rms >= openThreshold) {
      this.holdFrames = 16;
      targetGain = 1;
    } else if (this.holdFrames > 0) {
      this.holdFrames -= 1;
      targetGain = 0.96;
    } else if (rms <= closeThreshold) {
      targetGain = 0.07;
    } else {
      const position = (rms - closeThreshold) / Math.max(0.0001, openThreshold - closeThreshold);
      targetGain = 0.07 + Math.max(0, Math.min(1, position)) * 0.89;
    }

    const smoothing = targetGain > this.gain ? 0.22 : 0.045;
    this.gain += (targetGain - this.gain) * smoothing;

    for (let c = 0; c < output.length; c += 1) {
      const inputChannel = input[Math.min(c, input.length - 1)];
      const outputChannel = output[c];
      for (let i = 0; i < outputChannel.length; i += 1) {
        outputChannel[i] = (inputChannel?.[i] ?? 0) * this.gain;
      }
    }

    return true;
  }
}

registerProcessor("conclave-noise-cancellation-processor", ConclaveNoiseCancellationProcessor);
`;

const getAudioContextConstructor = (): typeof AudioContext | null =>
  window.AudioContext ||
  (window as typeof window & { webkitAudioContext?: typeof AudioContext })
    .webkitAudioContext ||
  null;

const resumeContext = (context: AudioContext) => {
  if (context.state === "suspended") {
    void context.resume().catch(() => {});
  }
};

const loadNoiseCancellationWorklet = (context: AudioContext): Promise<boolean> => {
  if (!context.audioWorklet) {
    return Promise.resolve(false);
  }

  const existing = workletLoadPromises.get(context);
  if (existing) return existing;

  const promise = (async () => {
    const blob = new Blob([NOISE_CANCELLATION_WORKLET], {
      type: "application/javascript",
    });
    const url = URL.createObjectURL(blob);
    try {
      await context.audioWorklet.addModule(url);
      return true;
    } catch (error) {
      console.warn("[Meets] Noise cancellation worklet unavailable:", error);
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  })();

  workletLoadPromises.set(context, promise);
  return promise;
};

const disconnectNodes = (nodes: readonly AudioNode[]) => {
  for (const node of nodes) {
    try {
      node.disconnect();
    } catch {}
  }
};

const connectNodes = (nodes: readonly AudioNode[]) => {
  for (let index = 0; index < nodes.length - 1; index += 1) {
    nodes[index]?.connect(nodes[index + 1]);
  }
};

export const isNoiseCancellationProcessedTrack = (
  track?: MediaStreamTrack | null,
): boolean => Boolean(track && outputTrackPipelines.has(track));

export const getNoiseCancellationSourceTrack = (
  track?: MediaStreamTrack | null,
): MediaStreamTrack | null =>
  track ? outputTrackPipelines.get(track)?.sourceTrack ?? null : null;

const getNoiseCancellationOutputTrack = (
  track?: MediaStreamTrack | null,
): MediaStreamTrack | null =>
  track ? sourceTrackPipelines.get(track)?.outputTrack ?? null : null;

export const setNoiseCancellationTrackEnabled = (
  track: MediaStreamTrack | null | undefined,
  enabled: boolean,
): void => {
  if (!track) return;
  track.enabled = enabled;

  const linkedTrack =
    getNoiseCancellationSourceTrack(track) ??
    getNoiseCancellationOutputTrack(track);
  if (linkedTrack && linkedTrack !== track) {
    linkedTrack.enabled = enabled;
  }
};

export const stopNoiseCancellationForTrack = (
  track?: MediaStreamTrack | null,
  options: CleanupOptions = {},
): void => {
  if (!track) return;
  const pipeline =
    outputTrackPipelines.get(track) ?? sourceTrackPipelines.get(track);
  pipeline?.cleanup(options);
};

export async function createNoiseCancellationPipeline(
  sourceTrack: MediaStreamTrack,
): Promise<NoiseCancellationPipeline> {
  if (sourceTrack.kind !== "audio") {
    throw new Error("Noise cancellation requires an audio track");
  }
  if (sourceTrack.readyState !== "live") {
    throw new Error("Noise cancellation source track is not live");
  }

  const existing = sourceTrackPipelines.get(sourceTrack);
  if (existing && !existing.disposed && existing.outputTrack.readyState === "live") {
    return existing;
  }

  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) {
    throw new Error("Web Audio is not available in this browser");
  }

  const context = new AudioContextConstructor({
    latencyHint: "interactive",
    sampleRate: 48000,
  });
  resumeContext(context);

  const sourceStream = new MediaStream([sourceTrack]);
  const source = context.createMediaStreamSource(sourceStream);
  const highPass = context.createBiquadFilter();
  highPass.type = "highpass";
  highPass.frequency.value = 95;
  highPass.Q.value = 0.72;

  const hum50 = context.createBiquadFilter();
  hum50.type = "notch";
  hum50.frequency.value = 50;
  hum50.Q.value = 22;

  const hum60 = context.createBiquadFilter();
  hum60.type = "notch";
  hum60.frequency.value = 60;
  hum60.Q.value = 22;

  const voicePresence = context.createBiquadFilter();
  voicePresence.type = "peaking";
  voicePresence.frequency.value = 2900;
  voicePresence.Q.value = 0.85;
  voicePresence.gain.value = 2.2;

  const lowPass = context.createBiquadFilter();
  lowPass.type = "lowpass";
  lowPass.frequency.value = 8200;
  lowPass.Q.value = 0.55;

  // Prefer the RNNoise neural denoiser; fall back to the adaptive RMS gate
  // when the wasm or worklet cannot load. RNNoise removes noise DURING speech
  // (typing, fans, traffic), which a gate fundamentally cannot.
  const rnnoise = await createRnnoiseNode(context);
  let gate: AudioNode | null = null;
  if (!rnnoise) {
    const workletLoaded = await loadNoiseCancellationWorklet(context);
    if (workletLoaded) {
      try {
        gate = new AudioWorkletNode(
          context,
          "conclave-noise-cancellation-processor",
          {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
          },
        );
      } catch (error) {
        console.warn("[Meets] Noise cancellation worklet init failed:", error);
      }
    }
  }
  const engine: NoiseCancellationEngine = rnnoise
    ? "rnnoise"
    : gate
      ? "gate"
      : "filters";

  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -26;
  compressor.knee.value = 24;
  compressor.ratio.value = 3.2;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.16;

  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 2;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.045;

  const outputGain = context.createGain();
  outputGain.gain.value = 1.05;

  const destination = context.createMediaStreamDestination();
  // RNNoise sits right after DC/hum removal so it denoises the cleanest
  // possible signal; the voice shaping and dynamics run on its output.
  const nodes = [
    source,
    highPass,
    hum50,
    hum60,
    ...(rnnoise ? [rnnoise] : []),
    voicePresence,
    lowPass,
    ...(gate ? [gate] : []),
    compressor,
    limiter,
    outputGain,
    destination,
  ];
  connectNodes(nodes);

  const outputTrack = destination.stream.getAudioTracks()[0];
  if (!outputTrack) {
    if (rnnoise) {
      try {
        rnnoise.destroy();
      } catch {}
    }
    disconnectNodes(nodes);
    await context.close().catch(() => {});
    throw new Error("Noise cancellation did not create an output track");
  }

  outputTrack.enabled = sourceTrack.enabled;
  if ("contentHint" in outputTrack) {
    outputTrack.contentHint = "speech";
  }

  const handleSourceEnded = () => {
    pipeline.cleanup({ stopSource: false, stopOutput: true });
  };

  const pipeline: NoiseCancellationPipelineInternal = {
    sourceTrack,
    outputTrack,
    stream: destination.stream,
    usedWorklet: Boolean(gate) || Boolean(rnnoise),
    engine,
    context,
    nodes,
    disposed: false,
    cleanup: (options: CleanupOptions = {}) => {
      if (pipeline.disposed) return;
      pipeline.disposed = true;

      sourceTrack.removeEventListener("ended", handleSourceEnded);
      outputTrackPipelines.delete(outputTrack);
      sourceTrackPipelines.delete(sourceTrack);
      if (rnnoise) {
        try {
          // Frees the wasm denoiser state inside the worklet processor.
          rnnoise.destroy();
        } catch {}
      }
      disconnectNodes(nodes);

      if (options.stopOutput !== false && outputTrack.readyState === "live") {
        try {
          outputTrack.stop();
        } catch {}
      }
      if (options.stopSource === true && sourceTrack.readyState === "live") {
        try {
          sourceTrack.stop();
        } catch {}
      }

      void context.close().catch(() => {});
    },
  };

  sourceTrack.addEventListener("ended", handleSourceEnded, { once: true });
  outputTrackPipelines.set(outputTrack, pipeline);
  sourceTrackPipelines.set(sourceTrack, pipeline);

  return pipeline;
}
