export const WEBCAM_STARTUP_RESET_REASON =
  "startup-simulcast-jitter-reset" as const;

export const WEBCAM_STARTUP_RESET_STABLE_MS = 4_500;
export const WEBCAM_STARTUP_RESET_POLL_MS = 500;
export const WEBCAM_STARTUP_RESET_MAX_WAIT_MS = 15_000;
export const WEBCAM_STARTUP_RESET_MAX_ATTEMPTS = 2;
export const WEBCAM_STARTUP_RESET_RETRY_MS = 1_200;
export const WEBCAM_STARTUP_RESET_MIN_SPACING_MS = 1_000;
export const WEBCAM_STARTUP_RESET_VERIFY_POLL_MS = 100;
export const WEBCAM_STARTUP_RESET_VERIFY_TIMEOUT_MS = 4_000;
export const WEBCAM_STARTUP_RESET_RESUME_ACK_TIMEOUT_MS = 2_000;
export const WEBCAM_STARTUP_RESET_RESUME_MAX_ATTEMPTS = 2;
export const WEBCAM_STARTUP_RESET_PRESENTATION_TIMEOUT_MS = 1_500;

/**
 * Producer-scoped recovery and pause state belongs to the currently presented
 * consumer generation. Closing a displaced predecessor must never erase the
 * successor's state after a make-before-break commit.
 */
export const isCurrentConsumerGeneration = ({
  currentConsumerId,
  closingConsumerId,
}: {
  currentConsumerId: string | null;
  closingConsumerId: string;
}): boolean => currentConsumerId === closingConsumerId;

export const isProducerPauseSnapshotCurrent = ({
  requestRevision,
  currentRevision,
}: {
  requestRevision: number;
  currentRevision: number;
}): boolean => requestRevision === currentRevision;

type ScalabilityEncoding = {
  scalabilityMode?: string;
};

type MediaCodec = {
  mimeType?: string;
};

export const isVp8SimulcastConsumerEligibleForStartupReset = ({
  consumerType,
  codecs,
  maximumSpatialLayer,
}: {
  consumerType: string | null | undefined;
  codecs: readonly MediaCodec[];
  maximumSpatialLayer: number | null;
}): boolean =>
  consumerType === "simulcast" &&
  maximumSpatialLayer !== null &&
  maximumSpatialLayer > 0 &&
  codecs.some((codec) => codec.mimeType?.toLowerCase() === "video/vp8");

export const enqueueWebcamStartupResetProducer = (
  queue: readonly string[],
  producerId: string,
): string[] =>
  queue.includes(producerId)
    ? [...queue]
    : [...queue, producerId].sort((left, right) => left.localeCompare(right));

export const getWebcamStartupResetQueueDelayMs = ({
  now,
  lastFinishedAt,
  minimumSpacingMs,
}: {
  now: number;
  lastFinishedAt: number;
  minimumSpacingMs: number;
}): number =>
  lastFinishedAt <= 0
    ? 0
    : Math.max(0, minimumSpacingMs - (now - lastFinishedAt));

export const getConsumerMaximumSpatialLayer = (
  encodings: readonly ScalabilityEncoding[],
): number | null => {
  let maximumSpatialLayer: number | null = null;

  for (const encoding of encodings) {
    const match = /[LS](\d+)T\d+/i.exec(encoding.scalabilityMode ?? "");
    const spatialLayerCount = Number(match?.[1]);
    if (!Number.isInteger(spatialLayerCount) || spatialLayerCount <= 1) {
      continue;
    }
    maximumSpatialLayer = Math.max(
      maximumSpatialLayer ?? 0,
      spatialLayerCount - 1,
    );
  }

  return maximumSpatialLayer;
};

export type WebcamStartupResetPollDecision =
  | { action: "queue"; highLayerSince: number }
  | { action: "wait"; highLayerSince: number | null }
  | {
      action: "cancel";
      reason:
        | "consumer-generation-changed"
        | "consumer-not-live"
        | "producer-paused"
        | "adaptively-paused";
    }
  | { action: "fail"; reason: "high-layer-convergence-timeout" };

export const decideWebcamStartupResetPoll = ({
  now,
  deadlineAt,
  stableForMs,
  highLayerSince,
  previousConsumerId,
  currentConsumerId,
  consumerClosed,
  trackReadyState,
  trackMuted,
  producerPaused,
  adaptivelyPaused,
  observedSpatialLayer,
  maximumSpatialLayer,
}: {
  now: number;
  deadlineAt: number;
  stableForMs: number;
  highLayerSince: number | null;
  previousConsumerId: string;
  currentConsumerId: string | null;
  consumerClosed: boolean;
  trackReadyState: MediaStreamTrackState | null;
  trackMuted: boolean;
  producerPaused: boolean;
  adaptivelyPaused: boolean;
  observedSpatialLayer: number | null;
  maximumSpatialLayer: number;
}): WebcamStartupResetPollDecision => {
  if (currentConsumerId !== previousConsumerId) {
    return { action: "cancel", reason: "consumer-generation-changed" };
  }
  if (consumerClosed || trackReadyState === "ended") {
    return { action: "cancel", reason: "consumer-not-live" };
  }
  if (producerPaused) {
    return { action: "cancel", reason: "producer-paused" };
  }
  if (adaptivelyPaused) {
    return { action: "cancel", reason: "adaptively-paused" };
  }

  // This deadline is absolute from the first consumer generation. It also
  // expires producers waiting in the serialized replacement queue, preventing
  // a large room from churning tiles well after startup has finished.
  if (now >= deadlineAt) {
    return { action: "fail", reason: "high-layer-convergence-timeout" };
  }

  const isPlayable = trackReadyState === "live" && !trackMuted;
  // A generation reset only addresses the proven VP8 simulcast startup path.
  // True-single and single-SSRC SVC consumers must stay put.
  const isConverged =
    maximumSpatialLayer > 0 &&
    isPlayable &&
    observedSpatialLayer !== null &&
    observedSpatialLayer >= maximumSpatialLayer;
  if (!isConverged) {
    return { action: "wait", highLayerSince: null };
  }

  const convergenceStartedAt = highLayerSince ?? now;
  if (now - convergenceStartedAt >= stableForMs) {
    return { action: "queue", highLayerSince: convergenceStartedAt };
  }
  return { action: "wait", highLayerSince: convergenceStartedAt };
};

export type WebcamStartupResetAttemptDecision =
  | { action: "verify"; replacementConsumerId: string }
  | { action: "retry"; reason: "replacement-not-attached" }
  | { action: "fail"; reason: "replacement-attempts-exhausted" }
  | { action: "cancel"; reason: "consumer-generation-changed" };

export const decideWebcamStartupResetAttempt = ({
  previousConsumerId,
  currentConsumerId,
  attempt,
  maximumAttempts,
}: {
  previousConsumerId: string;
  currentConsumerId: string | null;
  attempt: number;
  maximumAttempts: number;
}): WebcamStartupResetAttemptDecision => {
  if (currentConsumerId && currentConsumerId !== previousConsumerId) {
    return { action: "verify", replacementConsumerId: currentConsumerId };
  }
  if (currentConsumerId !== previousConsumerId) {
    return { action: "cancel", reason: "consumer-generation-changed" };
  }
  if (attempt < maximumAttempts) {
    return { action: "retry", reason: "replacement-not-attached" };
  }
  return { action: "fail", reason: "replacement-attempts-exhausted" };
};

export type WebcamStartupResetVerificationDecision =
  | { action: "complete" }
  | { action: "wait" }
  | { action: "cancel"; reason: "replacement-generation-changed" }
  | { action: "fail"; reason: "replacement-not-playable" };

export const decideWebcamStartupResetVerification = ({
  now,
  verificationStartedAt,
  verificationTimeoutMs,
  replacementConsumerId,
  currentConsumerId,
  consumerClosed,
  trackReadyState,
  trackMuted,
  framesDecoded,
  bytesReceived,
}: {
  now: number;
  verificationStartedAt: number;
  verificationTimeoutMs: number;
  replacementConsumerId: string;
  currentConsumerId: string | null;
  consumerClosed: boolean;
  trackReadyState: MediaStreamTrackState | null;
  trackMuted: boolean;
  framesDecoded: number | null;
  bytesReceived: number | null;
}): WebcamStartupResetVerificationDecision => {
  if (currentConsumerId !== replacementConsumerId) {
    return { action: "cancel", reason: "replacement-generation-changed" };
  }
  if (
    !consumerClosed &&
    trackReadyState === "live" &&
    !trackMuted &&
    framesDecoded !== null &&
    framesDecoded > 0 &&
    bytesReceived !== null &&
    bytesReceived > 0
  ) {
    return { action: "complete" };
  }
  if (now - verificationStartedAt >= verificationTimeoutMs) {
    return { action: "fail", reason: "replacement-not-playable" };
  }
  return { action: "wait" };
};
