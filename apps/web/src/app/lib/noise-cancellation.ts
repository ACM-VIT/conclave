"use client";

type CleanupOptions = {
  stopSource?: boolean;
  stopOutput?: boolean;
};

export type NoiseCancellationPipeline = {
  sourceTrack: MediaStreamTrack;
  outputTrack: MediaStreamTrack;
  stream: MediaStream;
  usedWorklet: boolean;
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

export const getNoiseCancellationOutputTrack = (
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

  const workletLoaded = await loadNoiseCancellationWorklet(context);
  let gate: AudioNode | null = null;
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
  const nodes = [
    source,
    highPass,
    hum50,
    hum60,
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
    usedWorklet: Boolean(gate),
    context,
    nodes,
    disposed: false,
    cleanup: (options: CleanupOptions = {}) => {
      if (pipeline.disposed) return;
      pipeline.disposed = true;

      sourceTrack.removeEventListener("ended", handleSourceEnded);
      outputTrackPipelines.delete(outputTrack);
      sourceTrackPipelines.delete(sourceTrack);
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
