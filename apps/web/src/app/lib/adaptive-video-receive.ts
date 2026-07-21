export type VideoLayerBounds = {
  maxSpatialLayer: number;
  maxTemporalLayer: number;
};

type WebcamRenderedSize = {
  width: number | null;
  height: number | null;
  devicePixelRatio?: number | null;
};

type WebcamSpatialLayerDemandOptions = WebcamRenderedSize & {
  bounds: VideoLayerBounds;
  previousSpatialLayer?: number | null;
};

type GoodLinkWebcamSpatialAllocationOptions = {
  bounds: VideoLayerBounds;
  demandedSpatialLayer: number;
  isVisible: boolean;
  isFocus: boolean;
  hasRenderedTile: boolean;
  screenShareVideoActive: boolean;
  fullResolutionEligible: boolean;
};

export type GoodLinkWebcamSpatialAllocation = {
  spatialLayer: number;
  keepFullResolution: boolean;
};

export type WebcamContinuityLayerPreference = {
  spatialLayer: number;
  temporalLayer: number;
};

export type WebcamLayerConvergenceKeyFrameAttempt = {
  consumerId: string;
  targetSignature: string;
  requestedAtMs: number;
  attemptCount: number;
};

export type WebcamReceiveRecoveryProbeState =
  | {
      phase: "idle";
      consumerId: string;
    }
  | {
      phase: "active";
      consumerId: string;
      startedAtMs: number;
      expiresAtMs: number;
    }
  | {
      phase: "cooldown";
      consumerId: string;
      cooldownUntilMs: number;
    };

// A receiver can enter the probe while the remote publisher is still
// constrained. Twenty seconds covers that asymmetric source-recovery window;
// fresh local browser/SFU pressure still aborts immediately and expiry always
// enters the cooldown, so the override cannot become permanent.
export const WEBCAM_RECEIVE_RECOVERY_PROBE_DURATION_MS = 20_000;
export const WEBCAM_RECEIVE_RECOVERY_PROBE_COOLDOWN_MS = 20_000;

const createIdleWebcamReceiveRecoveryProbeState = (
  consumerId: string,
): WebcamReceiveRecoveryProbeState => ({ phase: "idle", consumerId });

const createCooldownWebcamReceiveRecoveryProbeState = (
  consumerId: string,
  nowMs: number,
): WebcamReceiveRecoveryProbeState => ({
  phase: "cooldown",
  consumerId,
  cooldownUntilMs: nowMs + WEBCAM_RECEIVE_RECOVERY_PROBE_COOLDOWN_MS,
});

/**
 * Break a receiver's self-induced fair/poor loop for one bounded window. A
 * probe can start only when browser network evidence and the SFU consumer
 * score independently say the path is healthy. The aggregate quality and
 * continuity values can still be poor because their rolling loss window
 * predates that independent recovery evidence. Once armed, the probe ignores
 * those stale values long enough for a higher RID to clear the history, but
 * immediately aborts on fresh browser/consumer pressure.
 */
export const advanceWebcamReceiveRecoveryProbe = ({
  previousState,
  consumerId,
  nowMs,
  connectionQuality,
  consumerScoreQuality,
  browserAllowsRecovery,
  emergencyMode,
  receiveContinuityRisk,
  dataSaverMode,
  isDocumentVisible,
  isVisible,
}: {
  previousState: WebcamReceiveRecoveryProbeState | null | undefined;
  consumerId: string;
  nowMs: number;
  connectionQuality: "good" | "fair" | "poor" | "unknown";
  consumerScoreQuality: "good" | "fair" | "poor" | "unknown";
  browserAllowsRecovery: boolean;
  emergencyMode: boolean;
  receiveContinuityRisk: boolean;
  dataSaverMode: boolean;
  isDocumentVisible: boolean;
  isVisible: boolean;
}): WebcamReceiveRecoveryProbeState => {
  if (!Number.isFinite(nowMs)) {
    return createIdleWebcamReceiveRecoveryProbeState(consumerId);
  }

  const state =
    previousState?.consumerId === consumerId
      ? previousState
      : createIdleWebcamReceiveRecoveryProbeState(consumerId);
  const independentRecoveryEvidence =
    browserAllowsRecovery &&
    consumerScoreQuality === "good" &&
    !emergencyMode &&
    !dataSaverMode &&
    isDocumentVisible &&
    isVisible;

  if (state.phase === "active") {
    if (!independentRecoveryEvidence) {
      return createCooldownWebcamReceiveRecoveryProbeState(consumerId, nowMs);
    }
    if (connectionQuality === "good") {
      return createIdleWebcamReceiveRecoveryProbeState(consumerId);
    }
    if (nowMs >= state.expiresAtMs) {
      return createCooldownWebcamReceiveRecoveryProbeState(consumerId, nowMs);
    }
    // Aggregate quality and continuity risk may temporarily worsen because
    // they still contain the low-RID loss window the probe is meant to clear.
    return state;
  }

  if (state.phase === "cooldown" && nowMs < state.cooldownUntilMs) {
    return state;
  }

  const canStart =
    independentRecoveryEvidence &&
    (connectionQuality === "fair" ||
      (connectionQuality === "poor" && receiveContinuityRisk));
  if (!canStart) {
    return createIdleWebcamReceiveRecoveryProbeState(consumerId);
  }

  return {
    phase: "active",
    consumerId,
    startedAtMs: nowMs,
    expiresAtMs: nowMs + WEBCAM_RECEIVE_RECOVERY_PROBE_DURATION_MS,
  };
};

export const isWebcamLayerConvergencePathHealthy = ({
  connectionQuality,
  consumerScoreQuality,
  emergencyMode,
  receiveContinuityRisk,
  dataSaverMode,
}: {
  connectionQuality: "good" | "fair" | "poor" | "unknown";
  consumerScoreQuality: "good" | "fair" | "poor" | "unknown";
  emergencyMode: boolean;
  receiveContinuityRisk: boolean;
  dataSaverMode: boolean;
}): boolean =>
  (connectionQuality === "good" || connectionQuality === "fair") &&
  consumerScoreQuality === "good" &&
  !emergencyMode &&
  !receiveContinuityRisk &&
  !dataSaverMode;

export const shouldParkWebcamForDataSaver = ({
  isVisible,
  isFocusOrPrimary,
}: {
  isVisible: boolean;
  isFocusOrPrimary: boolean;
}): boolean => !isVisible && !isFocusOrPrimary;

const WEBCAM_STANDARD_RENDERED_PIXEL_HEIGHT = 260;
const WEBCAM_FULL_RENDERED_PIXEL_HEIGHT = 540;
const WEBCAM_SOURCE_ASPECT_RATIO = 16 / 9;
const LAYER_DOWNGRADE_HYSTERESIS_RATIO = 0.1;
const MAX_RENDER_DEVICE_PIXEL_RATIO = 4;
const CONTINUITY_FOCUS_MIN_INCOMING_BITRATE_BPS = 240_000;
const WEBCAM_LAYER_CONVERGENCE_KEYFRAME_RETRY_MS = 4_000;
const WEBCAM_LAYER_CONVERGENCE_KEYFRAME_MAX_ATTEMPTS = 3;

// Every supported webcam publish path is intentionally single-temporal-layer:
// VP8 uses L1T1 for each simulcast encoding and VP9 uses L2T1. Asking the
// SFU for T1/T2 cannot increase camera frame rate; it only creates clamped or
// rejected preference updates and makes generation signatures churn.
export const WEBCAM_RECEIVE_TEMPORAL_LAYER = 0;

/**
 * A preferred-layer ACK confirms the request, not that mediasoup has switched
 * to that RID. Retry a clean frame only while an otherwise healthy, visible
 * webcam is observably stuck below its requested spatial layer. Callers may
 * include a fair aggregate path when the per-consumer SFU score is good: that
 * breaks the loss-history/layer-switch feedback loop without admitting a poor
 * or continuity-risk path. The bounded cadence avoids turning a truly
 * bandwidth-limited receiver into a PLI loop.
 */
export const shouldRetryWebcamLayerConvergenceKeyFrame = ({
  consumerId,
  preferredSpatialLayer,
  currentSpatialLayer,
  healthyPath,
  visiblePriority,
  nowMs,
  previousAttempt,
}: {
  consumerId: string;
  preferredSpatialLayer: number | null;
  currentSpatialLayer: number | null;
  healthyPath: boolean;
  visiblePriority: boolean;
  nowMs: number;
  previousAttempt: WebcamLayerConvergenceKeyFrameAttempt | null;
}): boolean => {
  if (
    !healthyPath ||
    !visiblePriority ||
    !Number.isFinite(nowMs) ||
    preferredSpatialLayer === null ||
    currentSpatialLayer === null ||
    currentSpatialLayer >= preferredSpatialLayer
  ) {
    return false;
  }

  const targetSignature = String(preferredSpatialLayer);
  if (
    !previousAttempt ||
    previousAttempt.consumerId !== consumerId ||
    previousAttempt.targetSignature !== targetSignature
  ) {
    return true;
  }

  return (
    previousAttempt.attemptCount <
      WEBCAM_LAYER_CONVERGENCE_KEYFRAME_MAX_ATTEMPTS &&
    nowMs - previousAttempt.requestedAtMs >=
      WEBCAM_LAYER_CONVERGENCE_KEYFRAME_RETRY_MS
  );
};

const clampSpatialLayer = (value: number, maxSpatialLayer: number): number =>
  Math.min(Math.max(0, Math.floor(value)), Math.max(0, maxSpatialLayer));

export const normalizeRenderDevicePixelRatio = (
  devicePixelRatio: number | null | undefined,
): number => {
  if (
    typeof devicePixelRatio !== "number" ||
    !Number.isFinite(devicePixelRatio) ||
    devicePixelRatio <= 0
  ) {
    return 1;
  }

  return Math.min(MAX_RENDER_DEVICE_PIXEL_RATIO, Math.max(1, devicePixelRatio));
};

export const getWebcamRenderedPixelDemandHeight = ({
  width,
  height,
  devicePixelRatio,
}: WebcamRenderedSize): number | null => {
  if (width === null && height === null) return null;

  const pixelRatio = normalizeRenderDevicePixelRatio(devicePixelRatio);
  const physicalWidth =
    typeof width === "number" && Number.isFinite(width) && width > 0
      ? width * pixelRatio
      : 0;
  const physicalHeight =
    typeof height === "number" && Number.isFinite(height) && height > 0
      ? height * pixelRatio
      : 0;
  const widthEquivalentHeight = physicalWidth / WEBCAM_SOURCE_ASPECT_RATIO;
  const demandHeight = Math.max(physicalHeight, widthEquivalentHeight);

  return demandHeight > 0 ? demandHeight : null;
};

export const getWebcamTargetSpatialLayer = ({
  bounds,
  width,
  height,
  devicePixelRatio,
  previousSpatialLayer,
}: WebcamSpatialLayerDemandOptions): number => {
  const maxSpatialLayer = Math.max(0, bounds.maxSpatialLayer);
  const demandHeight = getWebcamRenderedPixelDemandHeight({
    width,
    height,
    devicePixelRatio,
  });
  if (demandHeight === null) return maxSpatialLayer;

  const mediumLayer = Math.min(1, maxSpatialLayer);
  const fullLayer = maxSpatialLayer;
  const previous =
    typeof previousSpatialLayer === "number" &&
    Number.isFinite(previousSpatialLayer)
      ? clampSpatialLayer(previousSpatialLayer, maxSpatialLayer)
      : null;

  if (previous === null) {
    if (demandHeight < WEBCAM_STANDARD_RENDERED_PIXEL_HEIGHT) return 0;
    if (
      maxSpatialLayer >= 2 &&
      demandHeight >= WEBCAM_FULL_RENDERED_PIXEL_HEIGHT
    ) {
      return fullLayer;
    }
    return mediumLayer;
  }

  const mediumDowngradeHeight =
    WEBCAM_STANDARD_RENDERED_PIXEL_HEIGHT *
    (1 - LAYER_DOWNGRADE_HYSTERESIS_RATIO);
  const fullDowngradeHeight =
    WEBCAM_FULL_RENDERED_PIXEL_HEIGHT *
    (1 - LAYER_DOWNGRADE_HYSTERESIS_RATIO);

  if (previous === 0) {
    if (
      maxSpatialLayer >= 2 &&
      demandHeight >= WEBCAM_FULL_RENDERED_PIXEL_HEIGHT
    ) {
      return fullLayer;
    }
    return demandHeight >= WEBCAM_STANDARD_RENDERED_PIXEL_HEIGHT
      ? mediumLayer
      : 0;
  }

  if (previous === mediumLayer && maxSpatialLayer >= 2) {
    if (demandHeight < mediumDowngradeHeight) return 0;
    return demandHeight >= WEBCAM_FULL_RENDERED_PIXEL_HEIGHT
      ? fullLayer
      : mediumLayer;
  }

  if (previous >= 1 && maxSpatialLayer < 2) {
    return demandHeight < mediumDowngradeHeight ? 0 : mediumLayer;
  }

  if (demandHeight >= fullDowngradeHeight) return fullLayer;
  return demandHeight < mediumDowngradeHeight ? 0 : mediumLayer;
};

export const getGoodLinkWebcamSpatialAllocation = ({
  bounds,
  demandedSpatialLayer,
  isVisible,
  isFocus,
  hasRenderedTile,
  screenShareVideoActive,
  fullResolutionEligible,
}: GoodLinkWebcamSpatialAllocationOptions): GoodLinkWebcamSpatialAllocation => {
  const maxSpatialLayer = Math.max(0, bounds.maxSpatialLayer);
  const demand = clampSpatialLayer(demandedSpatialLayer, maxSpatialLayer);
  const physicallyNeedsFullResolution = demand >= maxSpatialLayer;
  const keepFullResolution =
    physicallyNeedsFullResolution &&
    fullResolutionEligible &&
    ((isFocus && hasRenderedTile) ||
      (!screenShareVideoActive && isVisible));

  return {
    spatialLayer: keepFullResolution
      ? maxSpatialLayer
      : isVisible
        ? Math.min(1, demand)
        : 0,
    keepFullResolution,
  };
};

/**
 * Under loss plus a long repair RTT, preserve the middle spatial raster for
 * the camera a participant is actively watching unless even that layer
 * exceeds the receive budget. Webcam cadence remains on its only T0 layer.
 */
export const getWebcamContinuityLayerPreference = ({
  bounds,
  isFocusOrPrimary,
  availableIncomingBitrateBps,
}: {
  bounds: VideoLayerBounds;
  isFocusOrPrimary: boolean;
  availableIncomingBitrateBps: number | null;
}): WebcamContinuityLayerPreference => {
  const incomingBitrateForcesBaseLayer =
    availableIncomingBitrateBps !== null &&
    Number.isFinite(availableIncomingBitrateBps) &&
    availableIncomingBitrateBps > 0 &&
    availableIncomingBitrateBps <=
      CONTINUITY_FOCUS_MIN_INCOMING_BITRATE_BPS;
  const keepFocusMiddleLayer =
    isFocusOrPrimary && !incomingBitrateForcesBaseLayer;

  return {
    spatialLayer: keepFocusMiddleLayer
      ? Math.min(1, Math.max(0, bounds.maxSpatialLayer))
      : 0,
    temporalLayer: WEBCAM_RECEIVE_TEMPORAL_LAYER,
  };
};
