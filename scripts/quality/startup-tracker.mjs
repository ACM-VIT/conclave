export const STARTUP_TRACKER_GLOBAL = "__conclaveQualityStartupTracker";

const REMOTE_WEBCAM_SELECTOR =
  'video[data-meet-tile-video="true"][data-meet-video-stream-type="webcam"]';
const DEFAULT_TARGET_HEIGHT = 720;
const DEFAULT_POLL_INTERVAL_MS = 100;
const MIN_POLL_INTERVAL_MS = 25;
const MAX_POLL_INTERVAL_MS = 5_000;
const MAX_TARGET_HEIGHT = 4_320;

const requireIntegerInRange = (value, label, minimum, maximum) => {
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
};

export function buildStartStartupTrackerExpression({
  targetHeight = DEFAULT_TARGET_HEIGHT,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  const normalizedTargetHeight = requireIntegerInRange(
    targetHeight,
    "targetHeight",
    1,
    MAX_TARGET_HEIGHT,
  );
  const normalizedPollIntervalMs = requireIntegerInRange(
    pollIntervalMs,
    "pollIntervalMs",
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
  );

  return `(() => {
    const GLOBAL_NAME = ${JSON.stringify(STARTUP_TRACKER_GLOBAL)};
    const REMOTE_WEBCAM_SELECTOR = ${JSON.stringify(REMOTE_WEBCAM_SELECTOR)};
    const targetHeight = ${normalizedTargetHeight};
    const pollIntervalMs = ${normalizedPollIntervalMs};
    const previous = window[GLOBAL_NAME];
    if (previous && typeof previous.stop === "function") {
      previous.stop("restarted");
    }

    const state = {
      active: true,
      startedAtNavigationMs: performance.now(),
      firstDecodeAtNavigationMs: null,
      targetHeightReachedAtNavigationMs: null,
      firstDecodeToTargetHeightMs: null,
      currentVideo: null,
      resizeListener: null,
      frameCallbackId: null,
      frameCallbackSupported: null,
      presentedFrameCount: 0,
      firstPresentedFrameAtNavigationMs: null,
      lastPresentedFrameAtNavigationMs: null,
      longestPresentedFrameGapMs: null,
      longestGapBeforeFirstConsumerTransitionMs: null,
      firstDecodeThroughFirstConsumerTransitionMaximumGapMs: null,
      lastPresentedConsumerId: null,
      lastPresentedProducerId: null,
      consumerGenerationTransitions: [],
      timerId: null,
      currentResolution: null,
      transitions: [],
      stopReason: null,
      stoppedAtNavigationMs: null,
    };

    const snapshot = () => ({
      ok: true,
      version: 2,
      active: state.active,
      targetHeight,
      pollIntervalMs,
      startedAtNavigationMs: state.startedAtNavigationMs,
      firstDecodeAtNavigationMs: state.firstDecodeAtNavigationMs,
      navigationToFirstDecodeMs: state.firstDecodeAtNavigationMs,
      targetHeightReachedAtNavigationMs:
        state.targetHeightReachedAtNavigationMs,
      firstDecodeToTargetHeightMs: state.firstDecodeToTargetHeightMs,
      currentResolution: state.currentResolution
        ? { ...state.currentResolution }
        : null,
      transitions: state.transitions.map((transition) => ({ ...transition })),
      frameContinuity: {
        supported: state.frameCallbackSupported,
        presentedFrameCount: state.presentedFrameCount,
        firstPresentedFrameAtNavigationMs:
          state.firstPresentedFrameAtNavigationMs,
        lastPresentedFrameAtNavigationMs:
          state.lastPresentedFrameAtNavigationMs,
        longestPresentedFrameGapMs: state.longestPresentedFrameGapMs,
        longestGapBeforeFirstConsumerTransitionMs:
          state.longestGapBeforeFirstConsumerTransitionMs,
        firstDecodeThroughFirstConsumerTransitionMaximumGapMs:
          state.firstDecodeThroughFirstConsumerTransitionMaximumGapMs,
        lastPresentedConsumerId: state.lastPresentedConsumerId,
        lastPresentedProducerId: state.lastPresentedProducerId,
        consumerGenerationTransitions:
          state.consumerGenerationTransitions.map((transition) => ({
            ...transition,
          })),
      },
      stopReason: state.stopReason,
      stoppedAtNavigationMs: state.stoppedAtNavigationMs,
    });

    const isDecodedRemoteWebcam = (video) =>
      Boolean(
        video &&
          video.videoWidth > 0 &&
          video.videoHeight > 0 &&
          typeof window.MediaStream === "function" &&
          video.srcObject instanceof window.MediaStream,
      );

    const findDecodedRemoteWebcam = () =>
      (() => {
        const decodedVideos = Array.from(
          document.querySelectorAll(REMOTE_WEBCAM_SELECTOR),
        ).filter(isDecodedRemoteWebcam);
        const entries =
          window.__conclaveGetMeetVideoDebug?.()?.adaptiveConsumers?.entries ??
          [];
        const currentConsumerIds = entries
          .filter(
            (entry) =>
              entry?.kind === "video" &&
              entry?.type === "webcam" &&
              entry?.status === "applied" &&
              entry?.paused !== true &&
              typeof entry?.consumerId === "string",
          )
          .map((entry) => entry.consumerId);
        return (
          decodedVideos.find((video) => {
            const trackIds = video.srcObject
              .getVideoTracks()
              .map((track) => track.id);
            return currentConsumerIds.some((consumerId) =>
              trackIds.includes(consumerId),
            );
          }) ??
          decodedVideos[0] ??
          null
        );
      })();

    const readConsumerBinding = (video) => {
      if (!isDecodedRemoteWebcam(video)) {
        return { consumerId: null, producerId: null };
      }
      const track = video.srcObject
        .getVideoTracks()
        .find((candidate) => candidate?.readyState !== "ended");
      const consumerId =
        typeof track?.id === "string" && track.id.length > 0
          ? track.id
          : null;
      const adaptiveEntry = (
        window.__conclaveGetMeetVideoDebug?.()?.adaptiveConsumers?.entries ?? []
      ).find((entry) => entry?.consumerId === consumerId);
      const producerId =
        typeof adaptiveEntry?.producerId === "string" &&
        adaptiveEntry.producerId.length > 0
          ? adaptiveEntry.producerId
          : null;
      return { consumerId, producerId };
    };

    const recordResolution = (video, source) => {
      if (!state.active || !isDecodedRemoteWebcam(video)) return;
      const width = Math.round(video.videoWidth);
      const height = Math.round(video.videoHeight);
      const now = performance.now();
      if (state.firstDecodeAtNavigationMs === null) {
        state.firstDecodeAtNavigationMs = now;
      }

      const previousResolution = state.currentResolution;
      if (
        !previousResolution ||
        previousResolution.width !== width ||
        previousResolution.height !== height
      ) {
        state.currentResolution = { width, height };
        state.transitions.push({
          width,
          height,
          source:
            state.transitions.length === 0 ? "first-decode" : source,
          atNavigationMs: now,
          sinceFirstDecodeMs: Math.max(
            0,
            now - state.firstDecodeAtNavigationMs,
          ),
        });
      }

      if (
        state.targetHeightReachedAtNavigationMs === null &&
        height >= targetHeight
      ) {
        state.targetHeightReachedAtNavigationMs = now;
        state.firstDecodeToTargetHeightMs = Math.max(
          0,
          now - state.firstDecodeAtNavigationMs,
        );
      }
    };

    const cancelFrameCallback = () => {
      if (
        state.currentVideo &&
        state.frameCallbackId !== null &&
        typeof state.currentVideo.cancelVideoFrameCallback === "function"
      ) {
        try {
          state.currentVideo.cancelVideoFrameCallback(state.frameCallbackId);
        } catch {}
      }
      state.frameCallbackId = null;
    };

    const scheduleFrameCallback = () => {
      const video = state.currentVideo;
      if (
        !state.active ||
        !video ||
        state.frameCallbackId !== null ||
        typeof video.requestVideoFrameCallback !== "function"
      ) {
        return;
      }
      state.frameCallbackId = video.requestVideoFrameCallback(() => {
        state.frameCallbackId = null;
        if (!state.active || state.currentVideo !== video) return;
        const now = performance.now();
        const { consumerId, producerId } = readConsumerBinding(video);
        const previousAt = state.lastPresentedFrameAtNavigationMs;
        const previousConsumerId = state.lastPresentedConsumerId;
        const previousProducerId = state.lastPresentedProducerId;
        if (state.firstPresentedFrameAtNavigationMs === null) {
          state.firstPresentedFrameAtNavigationMs = now;
          if (state.firstDecodeAtNavigationMs !== null) {
            const firstDecodeToPresentedFrameMs = Math.max(
              0,
              now - state.firstDecodeAtNavigationMs,
            );
            state.longestGapBeforeFirstConsumerTransitionMs = Math.max(
              state.longestGapBeforeFirstConsumerTransitionMs ?? 0,
              firstDecodeToPresentedFrameMs,
            );
            state.longestPresentedFrameGapMs = Math.max(
              state.longestPresentedFrameGapMs ?? 0,
              firstDecodeToPresentedFrameMs,
            );
          }
        }
        if (previousAt !== null) {
          const gapMs = Math.max(0, now - previousAt);
          state.longestPresentedFrameGapMs = Math.max(
            state.longestPresentedFrameGapMs ?? 0,
            gapMs,
          );
          if (state.consumerGenerationTransitions.length === 0) {
            state.longestGapBeforeFirstConsumerTransitionMs = Math.max(
              state.longestGapBeforeFirstConsumerTransitionMs ?? 0,
              gapMs,
            );
          }
          if (
            previousConsumerId &&
            consumerId &&
            previousConsumerId !== consumerId
          ) {
            state.consumerGenerationTransitions.push({
              fromConsumerId: previousConsumerId,
              toConsumerId: consumerId,
              fromProducerId: previousProducerId,
              toProducerId: producerId,
              lastFrameAtNavigationMs: previousAt,
              firstFrameAtNavigationMs: now,
              visibleInterruptionMs: gapMs,
              sinceFirstDecodeMs:
                state.firstDecodeAtNavigationMs === null
                  ? null
                  : Math.max(0, now - state.firstDecodeAtNavigationMs),
            });
            if (
              state.firstDecodeThroughFirstConsumerTransitionMaximumGapMs ===
              null
            ) {
              state.firstDecodeThroughFirstConsumerTransitionMaximumGapMs =
                state.longestGapBeforeFirstConsumerTransitionMs;
            }
          }
        }
        state.presentedFrameCount += 1;
        state.lastPresentedFrameAtNavigationMs = now;
        state.lastPresentedConsumerId = consumerId;
        state.lastPresentedProducerId = producerId;
        scheduleFrameCallback();
      });
    };

    const detachVideo = () => {
      cancelFrameCallback();
      if (state.currentVideo && state.resizeListener) {
        state.currentVideo.removeEventListener("resize", state.resizeListener);
      }
      state.currentVideo = null;
      state.resizeListener = null;
    };

    const attachVideo = (video) => {
      if (state.currentVideo === video) return;
      detachVideo();
      state.currentVideo = video;
      state.resizeListener = () => recordResolution(video, "resize");
      video.addEventListener("resize", state.resizeListener);
      const supported = typeof video.requestVideoFrameCallback === "function";
      state.frameCallbackSupported =
        state.frameCallbackSupported === null
          ? supported
          : state.frameCallbackSupported && supported;
      scheduleFrameCallback();
    };

    const poll = () => {
      if (!state.active) return snapshot();
      const video = findDecodedRemoteWebcam();
      if (!video) {
        if (state.currentVideo && !state.currentVideo.isConnected) {
          detachVideo();
        }
        return snapshot();
      }
      attachVideo(video);
      recordResolution(video, "poll");
      return snapshot();
    };

    const stop = (reason = "requested") => {
      if (!state.active) return snapshot();
      state.active = false;
      state.stopReason = String(reason || "requested");
      state.stoppedAtNavigationMs = performance.now();
      detachVideo();
      if (state.timerId !== null) {
        window.clearInterval(state.timerId);
        state.timerId = null;
      }
      return snapshot();
    };

    const api = { version: 2, snapshot, poll, stop };
    Object.defineProperty(window, GLOBAL_NAME, {
      value: api,
      configurable: true,
      enumerable: false,
      writable: false,
    });

    poll();
    state.timerId = window.setInterval(poll, pollIntervalMs);
    return snapshot();
  })()`;
}

export function buildReadStartupTrackerExpression() {
  return `(() => {
    const tracker = window[${JSON.stringify(STARTUP_TRACKER_GLOBAL)}];
    return tracker && typeof tracker.snapshot === "function"
      ? tracker.snapshot()
      : { ok: false, reason: "startup-tracker-not-installed" };
  })()`;
}

export function buildStopStartupTrackerExpression() {
  return `(() => {
    const tracker = window[${JSON.stringify(STARTUP_TRACKER_GLOBAL)}];
    return tracker && typeof tracker.stop === "function"
      ? tracker.stop("requested")
      : { ok: false, reason: "startup-tracker-not-installed" };
  })()`;
}
