"use client";

import {
  MEET_VIDEOPIPE_RUNTIME_RELEASE,
  type FaceFilterEffectGraph,
} from "./video-effects";

const MEET_VIDEOPIPE_BUNDLE_URL = `https://www.gstatic.com/video_effects/effects/${MEET_VIDEOPIPE_RUNTIME_RELEASE}/brotli/videopipe_bundle.js`;
const MEET_VIDEOPIPE_OUTPUT_TIMEOUT_MS = 15_000;

type MeetVideoPipeLogLevel = "debug" | "info" | "warn" | "error";

type MeetVideoPipeLogPayload = {
  event: string;
  level: MeetVideoPipeLogLevel;
  message?: string;
  error?: unknown;
  data?: Record<string, unknown>;
};

type MeetVideoPipeLogger = {
  log: (message: unknown) => void;
  withError: (error: unknown) => MeetVideoPipeLogger;
};

type MeetVideoPipeImpressionLogger = {
  logImpression: (
    id: number,
    extra?: { extraNumber?: number; extraString?: string },
  ) => void;
  logImpressionAtMostOnce: (
    id: number,
    extra?: { extraNumber?: number; extraString?: string },
  ) => void;
};

type MeetVideoPipeCallbacks = {
  progressUpdate: (progress: number) => void;
  handleProgress: (state: string) => void;
  setOutputStream: (
    stream: MediaStream | null,
    metadata?: Record<string, unknown>,
  ) => void;
  unrecoverableError: (error: unknown) => void;
  detectionStateChanged: () => void;
  frameMetadata: (metadata: unknown) => void;
  onVideoProcessingEvent: (event: unknown) => void;
  brightnessData: (data: unknown) => void;
  handGesture: (data: unknown) => void;
};

type MeetVideoPipeProcessor = {
  dispose?: () => void | Promise<void>;
  getEffectsUIData?: () => unknown;
  initializeInputStream?: (stream: MediaStream, timestamp?: number) => void;
  requestEffects: (request: {
    effectIds?: number[];
    lowLightModeOptions?: {
      allowInitialFade?: boolean;
      startInActiveState?: boolean;
    };
  }) => Promise<unknown>;
  setInputStream: (stream: MediaStream | null) => Promise<unknown>;
  setTransitionsEnabled?: (enabled: boolean) => void;
};

type MeetVideoPipeWindow = Window & {
  createBundleProcessorWithOptions?: (init: {
    flags: Record<string, unknown>;
    logger: MeetVideoPipeLogger;
    callbacks: MeetVideoPipeCallbacks;
    impressionLogger: MeetVideoPipeImpressionLogger;
  }) => MeetVideoPipeProcessor;
};

export type MeetVideoPipeEffectSession = {
  effectIdNumber: number;
  graphId: string;
  outputStream: MediaStream;
  outputTrack: MediaStreamTrack;
  dispose: () => Promise<void>;
};

type StartMeetVideoPipeEffectOptions = {
  sourceStream: MediaStream;
  effectGraph: FaceFilterEffectGraph;
  onLog?: (payload: MeetVideoPipeLogPayload) => void;
  onOutputStream?: (
    stream: MediaStream | null,
    metadata?: Record<string, unknown>,
  ) => void;
};

let meetVideoPipeBundlePromise: Promise<void> | null = null;

const serializeMeetRuntimeMessage = (message: unknown): string => {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message;
  try {
    return String(message);
  } catch {
    return "[unserializable Meet VideoPipe log]";
  }
};

const createMeetVideoPipeLogger = (
  onLog?: (payload: MeetVideoPipeLogPayload) => void,
  error?: unknown,
): MeetVideoPipeLogger => ({
  log: (message) => {
    onLog?.({
      event: "runtime_log",
      level: error ? "warn" : "debug",
      message: serializeMeetRuntimeMessage(message),
      error,
    });
  },
  withError: (nextError) => createMeetVideoPipeLogger(onLog, nextError),
});

const createMeetVideoPipeImpressionLogger = (
  onLog?: (payload: MeetVideoPipeLogPayload) => void,
): MeetVideoPipeImpressionLogger => {
  const seen = new Set<number>();
  return {
    logImpression: (id, extra) => {
      onLog?.({
        event: "runtime_impression",
        level: "debug",
        data: { id, ...extra },
      });
    },
    logImpressionAtMostOnce: (id, extra) => {
      if (seen.has(id)) return;
      seen.add(id);
      onLog?.({
        event: "runtime_impression_once",
        level: "debug",
        data: { id, ...extra },
      });
    },
  };
};

const loadMeetVideoPipeBundle = () => {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Meet VideoPipe requires a browser."));
  }

  const meetWindow = window as MeetVideoPipeWindow;
  if (typeof meetWindow.createBundleProcessorWithOptions === "function") {
    return Promise.resolve();
  }

  if (meetVideoPipeBundlePromise) return meetVideoPipeBundlePromise;

  meetVideoPipeBundlePromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-conclave-meet-videopipe="${MEET_VIDEOPIPE_RUNTIME_RELEASE}"]`,
    );
    if (existing) {
      existing.addEventListener(
        "load",
        () => {
          if (
            typeof (window as MeetVideoPipeWindow)
              .createBundleProcessorWithOptions === "function"
          ) {
            resolve();
            return;
          }
          reject(new Error("Meet VideoPipe bundle loaded without processor."));
        },
        { once: true },
      );
      existing.addEventListener(
        "error",
        () => reject(new Error("Meet VideoPipe bundle failed to load.")),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.dataset.conclaveMeetVideopipe = MEET_VIDEOPIPE_RUNTIME_RELEASE;
    script.src = MEET_VIDEOPIPE_BUNDLE_URL;
    script.addEventListener(
      "load",
      () => {
        if (
          typeof (window as MeetVideoPipeWindow)
            .createBundleProcessorWithOptions === "function"
        ) {
          resolve();
          return;
        }
        reject(new Error("Meet VideoPipe bundle loaded without processor."));
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => reject(new Error("Meet VideoPipe bundle failed to load.")),
      { once: true },
    );
    document.head.appendChild(script);
  });

  return meetVideoPipeBundlePromise;
};

const createMeetVideoPipeFlags = (effectIdNumber: number) => ({
  release: MEET_VIDEOPIPE_RUNTIME_RELEASE,
  fetchAssetsFromBundlePath: false,
  googleInternalFeaturesAllowed: true,
  effectExperimentConfigs: [
    {
      effectId: effectIdNumber,
      launchStage: 3,
      promoted: false,
    },
  ],
  allowBreakoutBoxWorker: false,
  forceBreakoutBox: false,
  allowWebGpuBackgroundBlurReplace: false,
  minWebGpuChromiumVersion: 999,
  allowRelaxedSimd: true,
  allowJspi: true,
  retryFetches: true,
  asyncProcessorCreationTimeoutMs: 20_000,
  initialAsyncDataWaitTimeoutMs: 10_000,
});

const getLiveVideoTrack = (stream: MediaStream | null) => {
  const track = stream?.getVideoTracks()[0] ?? null;
  return track?.readyState === "live" ? track : null;
};

export async function startMeetVideoPipeEffect({
  sourceStream,
  effectGraph,
  onLog,
  onOutputStream,
}: StartMeetVideoPipeEffectOptions): Promise<MeetVideoPipeEffectSession> {
  const effectIdNumber = effectGraph.meetEffectIdNumber;
  if (typeof effectIdNumber !== "number") {
    throw new Error(`Meet VideoPipe effect ${effectGraph.meetGraphId} has no numeric effect ID.`);
  }

  const sourceTrack = getLiveVideoTrack(sourceStream);
  if (!sourceTrack) {
    throw new Error("Meet VideoPipe requires a live source video track.");
  }

  onLog?.({
    event: "bundle_load_start",
    level: "debug",
    data: {
      release: MEET_VIDEOPIPE_RUNTIME_RELEASE,
      graphId: effectGraph.meetGraphId,
      effectIdNumber,
    },
  });
  await loadMeetVideoPipeBundle();
  onLog?.({
    event: "bundle_load_done",
    level: "debug",
    data: { graphId: effectGraph.meetGraphId, effectIdNumber },
  });

  const meetWindow = window as MeetVideoPipeWindow;
  const createBundleProcessorWithOptions =
    meetWindow.createBundleProcessorWithOptions;
  if (typeof createBundleProcessorWithOptions !== "function") {
    throw new Error("Meet VideoPipe processor factory is unavailable.");
  }

  let disposed = false;
  let outputTimeoutId: number | null = null;
  let resolveOutputPromise: (stream: MediaStream) => void = () => {};
  let rejectOutputPromise: (error: Error) => void = () => {};
  const outputPromise = new Promise<MediaStream>((resolve, reject) => {
    resolveOutputPromise = resolve;
    rejectOutputPromise = reject;
    outputTimeoutId = window.setTimeout(() => {
      reject(
        new Error(
          `Meet VideoPipe did not publish an output stream within ${MEET_VIDEOPIPE_OUTPUT_TIMEOUT_MS}ms.`,
        ),
      );
    }, MEET_VIDEOPIPE_OUTPUT_TIMEOUT_MS);
  });

  const clearOutputTimeout = () => {
    if (outputTimeoutId === null) return;
    window.clearTimeout(outputTimeoutId);
    outputTimeoutId = null;
  };

  const resolveOutput = (
    stream: MediaStream | null,
    metadata?: Record<string, unknown>,
  ) => {
    onOutputStream?.(stream, metadata);
    onLog?.({
      event: "set_output_stream",
      level: stream ? "debug" : "warn",
      data: {
        streamId: stream?.id ?? null,
        videoTrackCount: stream?.getVideoTracks().length ?? 0,
        metadata: metadata ?? null,
      },
    });

    if (disposed || !stream) return;
    const outputTrack = getLiveVideoTrack(stream);
    if (!outputTrack) return;
    if (stream === sourceStream || outputTrack.id === sourceTrack.id) {
      onLog?.({
        event: "ignore_passthrough_output_stream",
        level: "debug",
        data: { streamId: stream.id, trackId: outputTrack.id },
      });
      return;
    }
    clearOutputTimeout();
    resolveOutputPromise(stream);
  };

  let processor: MeetVideoPipeProcessor;
  try {
    processor = createBundleProcessorWithOptions({
      flags: createMeetVideoPipeFlags(effectIdNumber),
      logger: createMeetVideoPipeLogger(onLog),
      impressionLogger: createMeetVideoPipeImpressionLogger(onLog),
      callbacks: {
        progressUpdate: (progress) =>
          onLog?.({
            event: "progress_update",
            level: "debug",
            data: { progress },
          }),
        handleProgress: (state) =>
          onLog?.({
            event: "handle_progress",
            level: "debug",
            data: { state },
          }),
        setOutputStream: resolveOutput,
        unrecoverableError: (error) => {
          onLog?.({
            event: "unrecoverable_error",
            level: "error",
            error,
          });
          clearOutputTimeout();
          rejectOutputPromise(
            error instanceof Error ? error : new Error(String(error)),
          );
        },
        detectionStateChanged: () =>
          onLog?.({ event: "detection_state_changed", level: "debug" }),
        frameMetadata: (metadata) =>
          onLog?.({
            event: "frame_metadata",
            level: "debug",
            data: { metadata },
          }),
        onVideoProcessingEvent: (event) =>
          onLog?.({
            event: "video_processing_event",
            level: "debug",
            data: { event },
          }),
        brightnessData: (data) =>
          onLog?.({
            event: "brightness_data",
            level: "debug",
            data: { data },
          }),
        handGesture: (data) =>
          onLog?.({
            event: "hand_gesture",
            level: "debug",
            data: { data },
          }),
      },
    });
  } catch (error) {
    clearOutputTimeout();
    const processorError =
      error instanceof Error ? error : new Error(String(error));
    rejectOutputPromise(processorError);
    throw processorError;
  }

  const uiData = processor.getEffectsUIData?.();
  onLog?.({
    event: "processor_created",
    level: "debug",
    data: {
      graphId: effectGraph.meetGraphId,
      effectIdNumber,
      uiEffectCount: Array.isArray(uiData) ? uiData.length : null,
    },
  });

  processor.initializeInputStream?.(sourceStream, performance.now());
  processor.setTransitionsEnabled?.(true);

  try {
    onLog?.({
      event: "request_effect_start",
      level: "debug",
      data: { graphId: effectGraph.meetGraphId, effectIdNumber },
    });
    await processor.requestEffects({
      effectIds: [effectIdNumber],
      lowLightModeOptions: {
        allowInitialFade: true,
        startInActiveState: true,
      },
    });
  } catch (error) {
    await Promise.resolve(processor.dispose?.()).catch(() => {});
    throw error;
  }

  const outputStream = await outputPromise.catch(async (error) => {
    await Promise.resolve(processor?.dispose?.()).catch(() => {});
    throw error;
  });
  const outputTrack = getLiveVideoTrack(outputStream);
  if (!outputTrack) {
    await Promise.resolve(processor.dispose?.()).catch(() => {});
    throw new Error("Meet VideoPipe output stream has no live video track.");
  }

  onLog?.({
    event: "output_ready",
    level: "info",
    data: {
      graphId: effectGraph.meetGraphId,
      effectIdNumber,
      streamId: outputStream.id,
      trackId: outputTrack.id,
    },
  });

  return {
    effectIdNumber,
    graphId: effectGraph.meetGraphId,
    outputStream,
    outputTrack,
    dispose: async () => {
      disposed = true;
      onOutputStream?.(null);
      await Promise.resolve(processor?.dispose?.()).catch((error) => {
        onLog?.({
          event: "dispose_failed",
          level: "warn",
          error,
        });
      });
    },
  };
}
