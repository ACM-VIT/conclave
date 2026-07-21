export type VideoJitterBufferNetworkQuality =
  | "good"
  | "fair"
  | "poor"
  | "unknown";

export type AdaptiveVideoJitterBufferTargetMs = 40 | 70 | 120 | 180;

export const ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS = {
  good: 40,
  fair: 70,
  poor: 120,
  emergency: 180,
} as const satisfies Record<
  "good" | "fair" | "poor" | "emergency",
  AdaptiveVideoJitterBufferTargetMs
>;

export type AdaptiveVideoJitterBufferPolicyOptions = {
  enabled: boolean;
  mediaKind: "audio" | "video";
  sourceType: "webcam" | "screen";
  quality: VideoJitterBufferNetworkQuality;
  emergencyMode: boolean;
  dataSaverMode: boolean;
  isDocumentVisible: boolean;
};

/**
 * Returns a conservative requested playout buffer for received video.
 *
 * `RTCRtpReceiver.jitterBufferTarget` is a nullable millisecond target, not a
 * guarantee: the browser may clamp the actual target to its own safe range and
 * changes are intentionally gradual. Keep these requests small enough for an
 * interactive meeting while giving a decoder modest protection from a short
 * arrival-jitter burst.
 *
 * Audio is deliberately never targeted here. The WebRTC specification says a
 * user agent should use the larger target for synchronized audio/video tracks,
 * so the browser may delay paired audio to preserve A/V sync after we target
 * video. Setting audio independently would risk compounding that latency.
 */
export const getAdaptiveVideoJitterBufferTargetMs = ({
  enabled,
  mediaKind,
  sourceType,
  quality,
  emergencyMode,
  dataSaverMode,
  isDocumentVisible,
}: AdaptiveVideoJitterBufferPolicyOptions): AdaptiveVideoJitterBufferTargetMs | null => {
  if (!enabled || mediaKind !== "video") return null;

  // Webcam consumers are parked while offscreen or in data-saver mode. Do not
  // retain extra requested playout delay for a stream we intentionally pause.
  if (
    sourceType === "webcam" &&
    (dataSaverMode || !isDocumentVisible)
  ) {
    return null;
  }

  if (emergencyMode) {
    return ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.emergency;
  }

  const normalizedQuality = quality === "unknown" ? "good" : quality;
  const qualityTarget = ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS[normalizedQuality];

  // Presentations benefit from continuity and readable text, so keep at least
  // the fair-link target even when the overall receive path is healthy.
  if (sourceType === "screen") {
    return Math.max(
      qualityTarget,
      ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.fair,
    ) as AdaptiveVideoJitterBufferTargetMs;
  }

  return qualityTarget;
};

export type VideoJitterBufferTargetApplyStatus =
  | "applied"
  | "unchanged"
  | "reset"
  | "unsupported"
  | "error";

export type VideoJitterBufferTargetApplyResult = {
  status: VideoJitterBufferTargetApplyStatus;
  observedTargetMs: number | null;
};

export type VideoJitterBufferTargetReconcileStatus =
  | VideoJitterBufferTargetApplyStatus
  | "not-requested";

export type VideoJitterBufferTargetState = {
  consumerId: string;
  receiver: unknown;
  requestedTargetMs: AdaptiveVideoJitterBufferTargetMs;
  status: VideoJitterBufferTargetApplyStatus;
  observedTargetMs: number | null;
  errorAttempt: number;
  retryAtMs: number | null;
};

export type VideoJitterBufferTargetReconcileResult = {
  requestedTargetMs: AdaptiveVideoJitterBufferTargetMs | null;
  status: VideoJitterBufferTargetReconcileStatus;
  observedTargetMs: number | null;
  nextState: VideoJitterBufferTargetState | null;
};

export const VIDEO_JITTER_BUFFER_RETRY_BASE_DELAY_MS = 1_000;
export const VIDEO_JITTER_BUFFER_RETRY_MAX_DELAY_MS = 30_000;

type ReceiverWithJitterBufferTarget = {
  jitterBufferTarget: DOMHighResTimeStamp | null;
};

const readObservedTargetMs = (
  receiver: ReceiverWithJitterBufferTarget,
): { valid: true; value: number | null } | { valid: false } => {
  const value = receiver.jitterBufferTarget;
  if (value === null) return { valid: true, value };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { valid: true, value };
  }
  return { valid: false };
};

/**
 * Feature-detects and applies a video receiver target without allowing a
 * partial browser implementation to disrupt the meeting. Equality checking
 * makes repeated reconciliation idempotent and avoids redundant native calls.
 */
export const applyVideoReceiverJitterBufferTarget = (
  receiver: unknown,
  requestedTargetMs: AdaptiveVideoJitterBufferTargetMs | null,
): VideoJitterBufferTargetApplyResult => {
  if (
    (typeof receiver !== "object" || receiver === null) &&
    typeof receiver !== "function"
  ) {
    return { status: "unsupported", observedTargetMs: null };
  }

  let observedTargetMs: number | null = null;
  try {
    if (!("jitterBufferTarget" in receiver)) {
      return { status: "unsupported", observedTargetMs };
    }

    const targetReceiver = receiver as ReceiverWithJitterBufferTarget;
    const before = readObservedTargetMs(targetReceiver);
    if (!before.valid) return { status: "error", observedTargetMs };
    observedTargetMs = before.value;
    if (observedTargetMs === requestedTargetMs) {
      return { status: "unchanged", observedTargetMs };
    }

    targetReceiver.jitterBufferTarget = requestedTargetMs;
    const after = readObservedTargetMs(targetReceiver);
    if (!after.valid) return { status: "error", observedTargetMs: null };
    observedTargetMs = after.value;
    if (observedTargetMs !== requestedTargetMs) {
      return { status: "error", observedTargetMs };
    }

    return {
      status: requestedTargetMs === null ? "reset" : "applied",
      observedTargetMs,
    };
  } catch {
    return { status: "error", observedTargetMs };
  }
};

const getErrorRetryDelayMs = (errorAttempt: number): number => {
  const maximumExponent = Math.ceil(
    Math.log2(
      VIDEO_JITTER_BUFFER_RETRY_MAX_DELAY_MS /
        VIDEO_JITTER_BUFFER_RETRY_BASE_DELAY_MS,
    ),
  );
  const exponent = Math.min(
    maximumExponent,
    Math.max(0, errorAttempt - 1),
  );
  return Math.min(
    VIDEO_JITTER_BUFFER_RETRY_MAX_DELAY_MS,
    VIDEO_JITTER_BUFFER_RETRY_BASE_DELAY_MS * 2 ** exponent,
  );
};

/**
 * Reconciles one video receiver against the requested policy target. The
 * caller stores `nextState` in a ref; no React state or rendering is involved.
 * Successful same-target passes still read the receiver on every policy tick,
 * repairing browser or native drift. Errors retry forever with an exponential
 * delay capped at 30 seconds, while unsupported receivers wait for a target or
 * receiver-generation transition before probing again.
 */
export const reconcileVideoReceiverJitterBufferTarget = ({
  consumerId,
  receiver,
  requestedTargetMs,
  previousState,
  nowMs,
}: {
  consumerId: string;
  receiver: unknown;
  requestedTargetMs: AdaptiveVideoJitterBufferTargetMs | null;
  previousState: VideoJitterBufferTargetState | null;
  nowMs: number;
}): VideoJitterBufferTargetReconcileResult => {
  const sameReceiverGeneration =
    previousState?.consumerId === consumerId &&
    previousState.receiver === receiver;

  if (requestedTargetMs === null) {
    const cleared = sameReceiverGeneration
      ? applyVideoReceiverJitterBufferTarget(receiver, null)
      : { status: "not-requested" as const, observedTargetMs: null };
    return {
      requestedTargetMs,
      status: cleared.status,
      observedTargetMs: cleared.observedTargetMs,
      nextState: null,
    };
  }

  const sameRequest =
    sameReceiverGeneration &&
    previousState?.requestedTargetMs === requestedTargetMs;
  if (sameRequest && previousState?.status === "unsupported") {
    return {
      requestedTargetMs,
      status: previousState.status,
      observedTargetMs: previousState.observedTargetMs,
      nextState: previousState,
    };
  }
  if (
    sameRequest &&
    previousState?.status === "error" &&
    previousState.retryAtMs !== null &&
    nowMs < previousState.retryAtMs
  ) {
    return {
      requestedTargetMs,
      status: previousState.status,
      observedTargetMs: previousState.observedTargetMs,
      nextState: previousState,
    };
  }

  const applied = applyVideoReceiverJitterBufferTarget(
    receiver,
    requestedTargetMs,
  );
  const errorAttempt =
    applied.status === "error"
      ? sameRequest
        ? (previousState?.errorAttempt ?? 0) + 1
        : 1
      : 0;
  const nextState: VideoJitterBufferTargetState = {
    consumerId,
    receiver,
    requestedTargetMs,
    status: applied.status,
    observedTargetMs: applied.observedTargetMs,
    errorAttempt,
    retryAtMs:
      applied.status === "error"
        ? nowMs + getErrorRetryDelayMs(errorAttempt)
        : null,
  };

  return {
    requestedTargetMs,
    status: applied.status,
    observedTargetMs: applied.observedTargetMs,
    nextState,
  };
};

/**
 * Releases one consumer generation from the transient target ledger. A late
 * removal for a displaced consumer leaves the replacement generation intact.
 * Matching live receivers get a best-effort reset before ownership is cleared;
 * closed receivers are never touched.
 */
export const releaseVideoReceiverJitterBufferTargetState = ({
  removingConsumerId,
  receiverClosed,
  currentState,
}: {
  removingConsumerId: string;
  receiverClosed: boolean;
  currentState: VideoJitterBufferTargetState | null;
}): VideoJitterBufferTargetState | null => {
  if (!currentState || currentState.consumerId !== removingConsumerId) {
    return currentState;
  }

  if (!receiverClosed) {
    applyVideoReceiverJitterBufferTarget(currentState.receiver, null);
  }
  return null;
};
