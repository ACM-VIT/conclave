"use client";

import {
  FACE_FILTER_EFFECT_GRAPHS,
  MEET_VIDEOPIPE_RUNTIME_RELEASE,
  type FaceFilterEffectGraph,
} from "./video-effects";

const MEET_VIDEOPIPE_BUNDLE_URL = `/_/rtcvidproc/release/${MEET_VIDEOPIPE_RUNTIME_RELEASE}/videopipe_bundle.js`;
const MEET_VIDEOPIPE_OUTPUT_TIMEOUT_MS = 60_000;
const MEET_VIDEOPIPE_IDLE_DISPOSE_MS = 30_000;
const MEET_VIDEOPIPE_TOP_LEVEL_ASSETS = [
  "videopipe_bundle.js",
  "timer_worker.js",
  "render_worker_bundle.js",
  "async_processor_worker_bundle.js",
  "mediapipe_jspi_simd.wasm",
] as const;

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

type MeetVideoPipeMutableCallbacks = Pick<
  StartMeetVideoPipeEffectOptions,
  "onLog" | "onOutputStream"
>;

type MeetVideoPipeController = {
  processor: MeetVideoPipeProcessor;
  sourceStream: MediaStream;
  sourceTrack: MediaStreamTrack;
  sourceTrackId: string;
  callbacks: MeetVideoPipeMutableCallbacks;
  outputStream: MediaStream | null;
  outputTrack: MediaStreamTrack | null;
  outputPromise: Promise<MediaStream>;
  requestQueue: Promise<void>;
  disposeTimerId: number | null;
  disposed: boolean;
  currentEffectIdNumber: number | null;
  currentGraphId: string | null;
  disposeNow: (reason: string) => Promise<void>;
};

let meetVideoPipeBundlePromise: Promise<void> | null = null;
let meetVideoPipeAssetPrewarmPromise: Promise<void> | null = null;
let warmMeetVideoPipeController: MeetVideoPipeController | null = null;

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

  const scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-conclave-meet-videopipe="${MEET_VIDEOPIPE_RUNTIME_RELEASE}"]`,
    );
    if (existing) {
      existing.remove();
    }

    const script = document.createElement("script");
    script.async = true;
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
      () => {
        script.remove();
        reject(new Error("Meet VideoPipe bundle failed to load."));
      },
      { once: true },
    );
    document.head.appendChild(script);
  });

  meetVideoPipeBundlePromise = scriptPromise.catch((error) => {
    meetVideoPipeBundlePromise = null;
    throw error;
  });

  return meetVideoPipeBundlePromise;
};

export const prewarmMeetVideoPipeRuntime = async (
  onLog?: (payload: MeetVideoPipeLogPayload) => void,
) => {
  if (typeof window === "undefined") return;
  if (meetVideoPipeAssetPrewarmPromise) return meetVideoPipeAssetPrewarmPromise;

  meetVideoPipeAssetPrewarmPromise = (async () => {
    onLog?.({
      event: "prewarm_start",
      level: "debug",
      data: { release: MEET_VIDEOPIPE_RUNTIME_RELEASE },
    });
    await loadMeetVideoPipeBundle();
    await Promise.all(
      MEET_VIDEOPIPE_TOP_LEVEL_ASSETS.map(async (asset) => {
        const response = await fetch(
          `/_/rtcvidproc/release/${MEET_VIDEOPIPE_RUNTIME_RELEASE}/${asset}`,
          { cache: "force-cache", credentials: "same-origin" },
        );
        if (!response.ok) {
          throw new Error(
            `Meet VideoPipe prewarm failed for ${asset}: ${response.status}`,
          );
        }
      }),
    );
    onLog?.({
      event: "prewarm_done",
      level: "debug",
      data: { release: MEET_VIDEOPIPE_RUNTIME_RELEASE },
    });
  })().catch((error) => {
    meetVideoPipeAssetPrewarmPromise = null;
    onLog?.({
      event: "prewarm_failed",
      level: "warn",
      error,
      data: { release: MEET_VIDEOPIPE_RUNTIME_RELEASE },
    });
    throw error;
  });

  return meetVideoPipeAssetPrewarmPromise;
};

const getMeetVideoPipeEffectExperimentConfigs = (
  effectIdNumber: number,
) => {
  const effectIds = new Set<number>([effectIdNumber]);
  for (const graph of Object.values(FACE_FILTER_EFFECT_GRAPHS)) {
    if (
      graph?.requiresMeetVideoPipe === true &&
      typeof graph.meetEffectIdNumber === "number"
    ) {
      effectIds.add(graph.meetEffectIdNumber);
    }
  }
  return Array.from(effectIds).map((effectId) => ({
    effectId,
    launchStage: 3,
    promoted: false,
  }));
};

const createMeetVideoPipeFlags = (effectIdNumber: number) => ({
  release: MEET_VIDEOPIPE_RUNTIME_RELEASE,
  fetchAssetsFromBundlePath: true,
  googleInternalFeaturesAllowed: true,
  effectExperimentConfigs: getMeetVideoPipeEffectExperimentConfigs(effectIdNumber),
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

const clearControllerDisposeTimer = (controller: MeetVideoPipeController) => {
  if (controller.disposeTimerId === null) return;
  window.clearTimeout(controller.disposeTimerId);
  controller.disposeTimerId = null;
};

const scheduleControllerDispose = (
  controller: MeetVideoPipeController,
  reason: string,
) => {
  if (controller.disposed) return;
  clearControllerDisposeTimer(controller);
  controller.callbacks.onLog?.({
    event: "schedule_idle_dispose",
    level: "debug",
    data: {
      reason,
      delayMs: MEET_VIDEOPIPE_IDLE_DISPOSE_MS,
      sourceTrackId: controller.sourceTrackId,
      outputTrackId: controller.outputTrack?.id ?? null,
    },
  });
  controller.disposeTimerId = window.setTimeout(() => {
    void controller.disposeNow(reason);
  }, MEET_VIDEOPIPE_IDLE_DISPOSE_MS);
};

const getReusableController = (sourceTrack: MediaStreamTrack) => {
  const controller = warmMeetVideoPipeController;
  if (!controller || controller.disposed) return null;
  if (controller.sourceTrackId !== sourceTrack.id) {
    void controller.disposeNow("source-track-changed");
    return null;
  }
  if (
    controller.outputTrack &&
    controller.outputTrack.readyState !== "live"
  ) {
    void controller.disposeNow("output-track-ended");
    return null;
  }
  clearControllerDisposeTimer(controller);
  return controller;
};

const updateControllerCallbacks = (
  controller: MeetVideoPipeController,
  callbacks: MeetVideoPipeMutableCallbacks,
) => {
  controller.callbacks = callbacks;
};

const requestControllerEffect = async (
  controller: MeetVideoPipeController,
  effectGraph: FaceFilterEffectGraph,
) => {
  const effectIdNumber = effectGraph.meetEffectIdNumber;
  if (typeof effectIdNumber !== "number") {
    throw new Error(`Meet VideoPipe effect ${effectGraph.meetGraphId} has no numeric effect ID.`);
  }

  controller.requestQueue = controller.requestQueue
    .catch(() => undefined)
    .then(async () => {
      controller.callbacks.onLog?.({
        event:
          controller.currentEffectIdNumber === null
            ? "request_effect_start"
            : "request_effect_update_start",
        level: "debug",
        data: { graphId: effectGraph.meetGraphId, effectIdNumber },
      });
      await controller.processor.requestEffects({
        effectIds: [effectIdNumber],
        lowLightModeOptions: {
          allowInitialFade: true,
          startInActiveState: true,
        },
      });
      controller.currentEffectIdNumber = effectIdNumber;
      controller.currentGraphId = effectGraph.meetGraphId;
      controller.callbacks.onLog?.({
        event: "request_effect_done",
        level: "debug",
        data: { graphId: effectGraph.meetGraphId, effectIdNumber },
      });
    });

  return controller.requestQueue;
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
  const callbacks: MeetVideoPipeMutableCallbacks = { onLog, onOutputStream };

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

  let controller = getReusableController(sourceTrack);
  if (controller) {
    updateControllerCallbacks(controller, callbacks);
    controller.sourceStream = sourceStream;
    controller.sourceTrack = sourceTrack;
    onLog?.({
      event: "processor_reused",
      level: "debug",
      data: {
        graphId: effectGraph.meetGraphId,
        effectIdNumber,
        sourceTrackId: sourceTrack.id,
        outputTrackId: controller.outputTrack?.id ?? null,
        currentGraphId: controller.currentGraphId,
        currentEffectIdNumber: controller.currentEffectIdNumber,
      },
    });
    await controller.processor.setInputStream(sourceStream).catch((error) => {
      onLog?.({
        event: "set_input_stream_reuse_failed",
        level: "warn",
        error,
      });
    });
  } else {
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
    outputPromise.catch(() => {
      // The effect request can still be inside Google's async runtime when the
      // timeout fires. Keep the original promise rejectable for our await below
      // without surfacing a browser-level unhandled rejection.
    });

    const clearOutputTimeout = () => {
      if (outputTimeoutId === null) return;
      window.clearTimeout(outputTimeoutId);
      outputTimeoutId = null;
    };

    let nextController: MeetVideoPipeController | null = null;
    const resolveOutput = (
      stream: MediaStream | null,
      metadata?: Record<string, unknown>,
    ) => {
      nextController?.callbacks.onOutputStream?.(stream, metadata);
      nextController?.callbacks.onLog?.({
        event: "set_output_stream",
        level: stream ? "debug" : "warn",
        data: {
          streamId: stream?.id ?? null,
          videoTrackCount: stream?.getVideoTracks().length ?? 0,
          metadata: metadata ?? null,
        },
      });

      if (!nextController || nextController.disposed || !stream) return;
      const outputTrack = getLiveVideoTrack(stream);
      if (!outputTrack) return;
      if (stream === sourceStream || outputTrack.id === sourceTrack.id) {
        nextController.callbacks.onLog?.({
          event: "ignore_passthrough_output_stream",
          level: "debug",
          data: { streamId: stream.id, trackId: outputTrack.id },
        });
        return;
      }
      nextController.outputStream = stream;
      nextController.outputTrack = outputTrack;
      clearOutputTimeout();
      resolveOutputPromise(stream);
    };

    let processor: MeetVideoPipeProcessor;
    try {
      processor = createBundleProcessorWithOptions({
        flags: createMeetVideoPipeFlags(effectIdNumber),
        logger: createMeetVideoPipeLogger((payload) =>
          nextController?.callbacks.onLog?.(payload),
        ),
        impressionLogger: createMeetVideoPipeImpressionLogger((payload) =>
          nextController?.callbacks.onLog?.(payload),
        ),
        callbacks: {
          progressUpdate: (progress) =>
            nextController?.callbacks.onLog?.({
              event: "progress_update",
              level: "debug",
              data: { progress },
            }),
          handleProgress: (state) =>
            nextController?.callbacks.onLog?.({
              event: "handle_progress",
              level: "debug",
              data: { state },
            }),
          setOutputStream: resolveOutput,
          unrecoverableError: (error) => {
            nextController?.callbacks.onLog?.({
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
            nextController?.callbacks.onLog?.({
              event: "detection_state_changed",
              level: "debug",
            }),
          frameMetadata: (metadata) =>
            nextController?.callbacks.onLog?.({
              event: "frame_metadata",
              level: "debug",
              data: { metadata },
            }),
          onVideoProcessingEvent: (event) =>
            nextController?.callbacks.onLog?.({
              event: "video_processing_event",
              level: "debug",
              data: { event },
            }),
          brightnessData: (data) =>
            nextController?.callbacks.onLog?.({
              event: "brightness_data",
              level: "debug",
              data: { data },
            }),
          handGesture: (data) =>
            nextController?.callbacks.onLog?.({
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

    nextController = {
      processor,
      sourceStream,
      sourceTrack,
      sourceTrackId: sourceTrack.id,
      callbacks,
      outputStream: null,
      outputTrack: null,
      outputPromise,
      requestQueue: Promise.resolve(),
      disposeTimerId: null,
      disposed: false,
      currentEffectIdNumber: null,
      currentGraphId: null,
      disposeNow: async (reason) => {
        if (!nextController || nextController.disposed) return;
        nextController.disposed = true;
        clearControllerDisposeTimer(nextController);
        if (warmMeetVideoPipeController === nextController) {
          warmMeetVideoPipeController = null;
        }
        nextController.callbacks.onLog?.({
          event: "dispose",
          level: "debug",
          data: {
            reason,
            sourceTrackId: nextController.sourceTrackId,
            outputTrackId: nextController.outputTrack?.id ?? null,
          },
        });
        nextController.callbacks.onOutputStream?.(null);
        await Promise.resolve(nextController.processor.dispose?.()).catch(
          (error) => {
            nextController?.callbacks.onLog?.({
              event: "dispose_failed",
              level: "warn",
              error,
            });
          },
        );
      },
    };
    controller = nextController;
    warmMeetVideoPipeController = controller;

    const handleSourceEnded = () => {
      void controller?.disposeNow("source-track-ended");
    };
    sourceTrack.addEventListener("ended", handleSourceEnded, { once: true });

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
  }

  try {
    await requestControllerEffect(controller, effectGraph);
  } catch (error) {
    await controller.disposeNow("request-effect-failed").catch(() => {});
    throw error;
  }

  const outputStream = await controller.outputPromise.catch(async (error) => {
    await controller.disposeNow("output-timeout").catch(() => {});
    throw error;
  });
  const outputTrack = getLiveVideoTrack(outputStream) ?? controller.outputTrack;
  if (!outputTrack) {
    await controller.disposeNow("output-track-missing").catch(() => {});
    throw new Error("Meet VideoPipe output stream has no live video track.");
  }
  controller.outputStream = outputStream;
  controller.outputTrack = outputTrack;

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
      onOutputStream?.(null);
      scheduleControllerDispose(controller, "session-dispose");
    },
  };
}
