"use client";

type WebNoiseSuppressorModule = typeof import("@sapphi-red/web-noise-suppressor");
type RnnoiseNode = InstanceType<WebNoiseSuppressorModule["RnnoiseWorkletNode"]>;
type AudioContextConstructor = typeof AudioContext;

const RNNOISE_WORKLET_URL = "/api/rnnoise/rnnoiseWorklet.js";
const RNNOISE_WASM_URL = "/api/rnnoise/rnnoise.wasm";
const RNNOISE_SIMD_WASM_URL = "/api/rnnoise/rnnoise_simd.wasm";
const RNNOISE_CHANNEL_COUNT = 2;
const RNNOISE_SAMPLE_RATE = 48000;

export type PublishedAudioSession = {
  inputTrack: MediaStreamTrack;
  outputTrack: MediaStreamTrack;
  isProcessed: boolean;
  cleanup: () => void;
};

type RnnoiseResources = {
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  node: RnnoiseNode;
  destination: MediaStreamAudioDestinationNode;
  outputTrack: MediaStreamTrack;
};

let webNoiseSuppressorPromise: Promise<WebNoiseSuppressorModule> | null = null;
let rnnoiseWasmPromise: Promise<ArrayBuffer> | null = null;
let rnnoiseUnavailable = false;

const loadWebNoiseSuppressor = () => {
  webNoiseSuppressorPromise ??= import("@sapphi-red/web-noise-suppressor");
  return webNoiseSuppressorPromise;
};

const loadRnnoiseWasm = () => {
  rnnoiseWasmPromise ??= loadWebNoiseSuppressor().then(({ loadRnnoise }) =>
    loadRnnoise({
      url: RNNOISE_WASM_URL,
      simdUrl: RNNOISE_SIMD_WASM_URL,
    }),
  );
  return rnnoiseWasmPromise;
};

const getAudioContextConstructor = (): AudioContextConstructor | null => {
  if (typeof window === "undefined") return null;

  return (
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: AudioContextConstructor })
      .webkitAudioContext ||
    null
  );
};

const canUseRnnoise = () =>
  Boolean(
    getAudioContextConstructor() &&
      typeof AudioWorkletNode !== "undefined" &&
      typeof MediaStreamAudioSourceNode !== "undefined",
  );

const createRawAudioSession = (
  inputTrack: MediaStreamTrack,
): PublishedAudioSession => ({
  inputTrack,
  outputTrack: inputTrack,
  isProcessed: false,
  cleanup: () => {},
});

const setSpeechContentHint = (track: MediaStreamTrack) => {
  if ("contentHint" in track) {
    track.contentHint = "speech";
  }
};

const closeAudioContext = (audioContext: AudioContext) => {
  void audioContext.close().catch(() => {});
};

const cleanupRnnoiseResources = (resources: Partial<RnnoiseResources>) => {
  try {
    resources.source?.disconnect();
  } catch {}
  try {
    resources.node?.disconnect();
  } catch {}
  try {
    resources.node?.destroy();
  } catch {}
  try {
    resources.outputTrack?.stop();
  } catch {}
  if (resources.audioContext) {
    closeAudioContext(resources.audioContext);
  }
};

const createRnnoiseResources = async (
  inputTrack: MediaStreamTrack,
): Promise<RnnoiseResources> => {
  const AudioContextImpl = getAudioContextConstructor();
  if (!AudioContextImpl) {
    throw new Error("AudioContext is not available");
  }

  const audioContext = new AudioContextImpl({ sampleRate: RNNOISE_SAMPLE_RATE });
  const partialResources: Partial<RnnoiseResources> = { audioContext };

  try {
    await audioContext.audioWorklet.addModule(RNNOISE_WORKLET_URL);
    const [{ RnnoiseWorkletNode }, wasmBinary] = await Promise.all([
      loadWebNoiseSuppressor(),
      loadRnnoiseWasm(),
    ]);

    const source = audioContext.createMediaStreamSource(
      new MediaStream([inputTrack]),
    );
    const node = new RnnoiseWorkletNode(audioContext, {
      maxChannels: RNNOISE_CHANNEL_COUNT,
      wasmBinary,
    });
    const destination = audioContext.createMediaStreamDestination();

    source.connect(node);
    node.connect(destination);

    if (audioContext.state === "suspended") {
      await audioContext.resume().catch(() => {});
    }

    const outputTrack = destination.stream.getAudioTracks()[0];
    if (!outputTrack) {
      throw new Error("RNNoise did not create an output audio track");
    }
    setSpeechContentHint(outputTrack);

    return {
      audioContext,
      source,
      node,
      destination,
      outputTrack,
    };
  } catch (error) {
    cleanupRnnoiseResources(partialResources);
    throw error;
  }
};

export const cleanupPublishedAudioSession = (
  session: PublishedAudioSession | null | undefined,
) => {
  try {
    session?.cleanup();
  } catch (error) {
    console.warn("[Meets] Failed to clean up RNNoise audio session:", error);
  }
};

export const createPublishedAudioSession = async (
  inputTrack: MediaStreamTrack,
): Promise<PublishedAudioSession> => {
  if (rnnoiseUnavailable || !canUseRnnoise()) {
    return createRawAudioSession(inputTrack);
  }

  try {
    const resources = await createRnnoiseResources(inputTrack);
    let cleanedUp = false;

    return {
      inputTrack,
      outputTrack: resources.outputTrack,
      isProcessed: true,
      cleanup: () => {
        if (cleanedUp) return;
        cleanedUp = true;
        cleanupRnnoiseResources(resources);
      },
    };
  } catch (error) {
    rnnoiseUnavailable = true;
    console.warn(
      "[Meets] RNNoise setup failed; falling back to browser audio processing:",
      error,
    );
    return createRawAudioSession(inputTrack);
  }
};
