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

export const WEBCAM_RECEIVE_TEMPORAL_LAYER = 0;

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
