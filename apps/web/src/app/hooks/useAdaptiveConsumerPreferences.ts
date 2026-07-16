"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  getScreenShareReceiveNetworkProfileForAvailableIncomingBitrate,
  SCREEN_SHARE_RECEIVE_EMERGENCY_BPS,
} from "../lib/screen-share-network-profile";
import {
  advanceWebcamReceiveRecoveryProbe,
  getGoodLinkWebcamSpatialAllocation,
  isWebcamLayerConvergencePathHealthy,
  getWebcamContinuityLayerPreference,
  getWebcamTargetSpatialLayer,
  normalizeRenderDevicePixelRatio,
  shouldRetryWebcamLayerConvergenceKeyFrame,
  shouldParkWebcamForDataSaver,
  WEBCAM_RECEIVE_TEMPORAL_LAYER,
  type WebcamLayerConvergenceKeyFrameAttempt,
  type WebcamReceiveRecoveryProbeState,
  type VideoLayerBounds,
} from "../lib/adaptive-video-receive";
import {
  isConsumerGenerationDisplacedError,
  isConsumerPreferenceGenerationCurrent,
} from "../lib/consumer-preference-generation";
import {
  advanceConsumerScoreAdaptation,
  getConsumerScoreSample,
  getEffectiveConsumerReceiveQuality,
  type ConsumerScoreAdaptationState,
  type ConsumerScoreQuality,
} from "../lib/adaptive-consumer-score";
import {
  applyVideoReceiverJitterBufferTarget,
  getAdaptiveVideoJitterBufferTargetMs,
  reconcileVideoReceiverJitterBufferTarget,
  releaseVideoReceiverJitterBufferTargetState,
  type AdaptiveVideoJitterBufferTargetMs,
  type VideoJitterBufferTargetReconcileStatus,
  type VideoJitterBufferTargetState,
} from "../lib/adaptive-video-jitter-buffer";
import type { Consumer, ProducerMapEntry } from "../lib/types";
import type {
  AdaptiveVideoReceiverLifecycleEvent,
  MeetRefs,
} from "./useMeetRefs";
import type { ConnectionQuality } from "./useConnectionQuality";

type ConsumerLayerPreference = {
  spatialLayer: number;
  temporalLayer?: number;
};

type LayerBounds = VideoLayerBounds;

type DesiredConsumerPreferences = {
  preferredLayers?: ConsumerLayerPreference;
  priority: number;
  paused?: boolean;
};

type SetConsumerPreferencesResponse =
  | {
      success: true;
      consumerId: string;
      producerId: string;
      paused: boolean;
      producerPaused: boolean;
      preferredLayers?: ConsumerLayerPreference;
      currentLayers?: ConsumerLayerPreference;
      priority: number;
    }
  | { error: string };

type SetConsumerPreferencesBatchItemResponse =
  | SetConsumerPreferencesResponse
  | {
      error: string;
      consumerId?: string;
    };

type SetConsumerPreferencesBatchResponse =
  | {
      success: true;
      results: SetConsumerPreferencesBatchItemResponse[];
    }
  | { error: string };

interface UseAdaptiveConsumerPreferencesOptions {
  refs: Pick<
    MeetRefs,
    | "socketRef"
    | "consumersRef"
    | "producerMapRef"
    | "consumerTelemetryRef"
    | "adaptivelyPausedConsumerProducerIdsRef"
    | "adaptiveVideoReceiverLifecycleRef"
  >;
  enabled: boolean;
  connectionQuality: ConnectionQuality;
  emergencyMode: boolean;
  receiveContinuityRisk: boolean;
  browserAllowsFairWebcamLayerRecovery?: boolean;
  availableIncomingBitrateBps?: number | null;
  activeSpeakerId: string | null;
  dataSaverMode?: boolean;
  isDocumentVisible?: boolean;
  debugStateRef?: React.MutableRefObject<
    AdaptiveConsumerPreferencesDebugSnapshot | null
  >;
  onVideoAdaptivePauseStateChange?: (
    change: AdaptiveConsumerVideoPauseStateChange,
  ) => void;
}

const APPLY_INTERVAL_MS = 2500;
const MAX_WEBCAMS_TO_KEEP_FULL_ON_GOOD_LINKS = 4;
const MAX_CONSUMER_PREFERENCE_UPDATES_PER_CYCLE = 8;
const SCREEN_SHARE_CONSUMER_PREFERENCE_UPDATES_PER_CYCLE = 16;
const CONSUMER_PREFERENCE_EMIT_SPACING_MS = 75;
const SCREEN_SHARE_CONSUMER_PREFERENCE_EMIT_SPACING_MS = 50;
const RATE_LIMIT_RETRY_DELAY_MS = 1000;
const CONSUMER_PREFERENCE_ACK_TIMEOUT_MS = 3000;
const AUDIO_CONSUMER_PRIORITY = 255;
const UNSUPPORTED_LAYER_RETRY_AFTER_MS = 30000;
const SCREEN_SHARE_SMALL_RENDERED_HEIGHT = 220;
const SCREEN_SHARE_FULL_FPS_RENDERED_HEIGHT = 540;
const OFFSCREEN_WEBCAM_PARK_PRIORITY = 5;
const HIDDEN_SCREEN_SHARE_KEEPALIVE_PRIORITY = 60;

type PresentationTileSize = "stage" | "grid" | "rail";

type RenderedTileMetrics = {
  width: number;
  height: number;
  devicePixelRatio: number;
};

type LayoutRole = {
  primary: boolean;
  focus: boolean;
  visible: boolean;
  hidden: boolean;
  warm: boolean;
  rank: number | null;
  renderedWidth: number | null;
  renderedHeight: number | null;
  renderedDevicePixelRatio: number | null;
  presentationSize: PresentationTileSize | null;
};

type RoomTilingHints = {
  primaryIds: Set<string>;
  focusIds: Set<string>;
  visibleRemoteIds: Set<string>;
  hiddenIds: Set<string>;
  warmIds: Set<string>;
  orderedRemoteRanks: Map<string, number>;
  participantTileMetrics: Map<string, RenderedTileMetrics>;
  presentation: {
    presenterId: string | null;
    producerId: string | null;
    visible: boolean;
    primary: boolean;
    focus: boolean;
    renderedWidth: number | null;
    renderedHeight: number | null;
    size: PresentationTileSize | null;
  };
};

type ConsumerPreferenceDebugStatus =
  | "applied"
  | "fallback"
  | "error"
  | "deferred";

type ConsumerPreferenceDebugContext = {
  socketConnected: boolean;
  layoutHintsAvailable: boolean;
  webcamVideoCount: number;
};

type AdaptiveVideoJitterBufferDebugStatus =
  VideoJitterBufferTargetReconcileStatus;

export type AdaptiveConsumerPreferenceDebugEntry = {
  producerId: string;
  consumerId: string;
  userId: string;
  kind: ProducerMapEntry["kind"];
  type: ProducerMapEntry["type"];
  status: ConsumerPreferenceDebugStatus;
  priority: number;
  paused: boolean | null;
  producerPaused: boolean | null;
  requestedPaused: boolean | null;
  requestedLayers?: ConsumerLayerPreference;
  requestedJitterBufferTargetMs: AdaptiveVideoJitterBufferTargetMs | null;
  observedTargetMs: number | null;
  jitterBufferTargetStatus: AdaptiveVideoJitterBufferDebugStatus;
  emergencyKeepVideo: boolean | null;
  preferredLayers?: ConsumerLayerPreference;
  currentLayers?: ConsumerLayerPreference;
  consumerScore: number | null;
  consumerScoreQuality: ConsumerScoreQuality;
  receiveRecoveryProbePhase: WebcamReceiveRecoveryProbeState["phase"] | null;
  receiveRecoveryProbeActive: boolean;
  bounds: LayerBounds | null;
  layout: LayoutRole | null;
  requestKeyFrame: boolean;
  unsupportedLayers: boolean;
  error: string | null;
  appliedAt: number;
};

export type AdaptiveConsumerPreferencesDebugSnapshot = {
  enabled: boolean;
  timestamp: number;
  connectionQuality: ConnectionQuality;
  emergencyMode: boolean;
  receiveContinuityRisk: boolean;
  browserAllowsFairWebcamLayerRecovery: boolean;
  dataSaverMode: boolean;
  isDocumentVisible: boolean;
  activeSpeakerId: string | null;
  socketConnected: boolean;
  layoutHintsAvailable: boolean;
  webcamVideoCount: number;
  appliedCount: number;
  pausedCount: number;
  fallbackCount: number;
  errorCount: number;
  deferredCount: number;
  adaptivelyPausedProducerIds: string[];
  unsupportedLayerProducerIds: string[];
  entries: AdaptiveConsumerPreferenceDebugEntry[];
};

export type AdaptiveConsumerVideoPauseStateChange = {
  producerId: string;
  userId: string;
  adaptivelyPaused: boolean;
};

type ConsumerPreferenceDebugEntryBase = Omit<
  AdaptiveConsumerPreferenceDebugEntry,
  | "status"
  | "paused"
  | "producerPaused"
  | "preferredLayers"
  | "currentLayers"
  | "error"
  | "appliedAt"
>;

type PendingConsumerPreferenceUpdate = {
  producerId: string;
  consumer: Consumer;
  preferences: DesiredConsumerPreferences;
  preferredLayers?: ConsumerLayerPreference;
  signature: string;
  debugEntryBase: ConsumerPreferenceDebugEntryBase;
  urgency: number;
};

type UnsupportedLayerPreference = {
  consumerId: string;
  signature: string;
  retryAt: number;
};

type RoomTilingDebugWindow = Window & {
  __conclaveGetMeetRoomTilingDebug?: () => {
    current?: unknown;
  };
  __conclaveMeetRoomTilingDebug?: {
    current?: unknown;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readStringArray = (
  value: unknown,
  key: string,
): string[] => {
  if (!isRecord(value)) return [];
  const raw = value[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
};

const readNullableString = (value: unknown, key: string): string | null => {
  if (!isRecord(value)) return null;
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
};

const readBoolean = (
  value: unknown,
  key: string,
  fallback = false,
): boolean => {
  if (!isRecord(value)) return fallback;
  const raw = value[key];
  return typeof raw === "boolean" ? raw : fallback;
};

const readRoomTilingEventSignature = (event: Event): string | null => {
  if (!("detail" in event)) return null;
  const detail = (event as CustomEvent<unknown>).detail;
  if (!isRecord(detail)) return null;
  const signature = detail.signature;
  return typeof signature === "string" && signature.length > 0
    ? signature
    : null;
};

const readRoomTilingCurrentSignature = (): string | null => {
  if (typeof window === "undefined") return null;
  const debugWindow = window as RoomTilingDebugWindow;
  const snapshot =
    debugWindow.__conclaveGetMeetRoomTilingDebug?.() ??
    debugWindow.__conclaveMeetRoomTilingDebug;
  const current = snapshot?.current;
  if (!isRecord(current)) return null;
  const signature = current.signature;
  return typeof signature === "string" && signature.length > 0
    ? signature
    : null;
};

const readPresentationTileSize = (
  value: string | undefined,
): PresentationTileSize | null =>
  value === "stage" || value === "grid" || value === "rail" ? value : null;

const readPresentationElementMetrics = (
  presenterId: string | null,
): {
  width: number | null;
  height: number | null;
  size: PresentationTileSize | null;
} => {
  if (typeof document === "undefined") {
    return { width: null, height: null, size: null };
  }

  const tiles = Array.from(
    document.querySelectorAll<HTMLElement>("[data-meet-presentation-tile]"),
  );
  const tile =
    tiles.find(
      (candidate) =>
        !presenterId ||
        candidate.dataset.meetPresentationPresenterId === presenterId,
    ) ??
    tiles[0] ??
    null;
  if (!tile) return { width: null, height: null, size: null };

  const rect = tile.getBoundingClientRect();
  const width = rect.width > 0 ? Math.round(rect.width) : null;
  const height = rect.height > 0 ? Math.round(rect.height) : null;
  return {
    width,
    height,
    size: readPresentationTileSize(tile.dataset.meetPresentationSize),
  };
};

const readParticipantTileMetrics = (
  visibleRemoteIds: Set<string>,
): Map<string, RenderedTileMetrics> => {
  if (typeof document === "undefined" || visibleRemoteIds.size === 0) {
    return new Map();
  }

  const metrics = new Map<string, RenderedTileMetrics>();
  const devicePixelRatio = normalizeRenderDevicePixelRatio(
    typeof window === "undefined" ? 1 : window.devicePixelRatio,
  );
  const tiles = Array.from(
    document.querySelectorAll<HTMLElement>("[data-userid]"),
  );

  tiles.forEach((tile) => {
    const userId = tile.dataset.userid;
    if (!userId || !visibleRemoteIds.has(userId)) return;

    const rect = tile.getBoundingClientRect();
    const width = rect.width > 1 ? Math.round(rect.width) : 0;
    const height = rect.height > 1 ? Math.round(rect.height) : 0;
    if (width <= 1 || height <= 1) return;

    const existing = metrics.get(userId);
    if (!existing || width * height > existing.width * existing.height) {
      metrics.set(userId, { width, height, devicePixelRatio });
    }
  });

  return metrics;
};

const readRoomTilingHints = (): RoomTilingHints | null => {
  if (typeof window === "undefined") return null;

  const debugWindow = window as RoomTilingDebugWindow;
  const snapshot =
    debugWindow.__conclaveGetMeetRoomTilingDebug?.() ??
    debugWindow.__conclaveMeetRoomTilingDebug;
  const current = snapshot?.current;
  if (!isRecord(current)) return null;
  const presentation = isRecord(current.presentation)
    ? current.presentation
    : null;
  const presentationPresenterId = readNullableString(
    presentation,
    "presenterId",
  );
  const presentationProducerId = readNullableString(
    presentation,
    "producerId",
  );
  const presentationMetrics = readPresentationElementMetrics(
    presentationPresenterId,
  );
  const visibleRemoteIds = new Set(readStringArray(current, "visibleRemoteIds"));

  return {
    primaryIds: new Set(readStringArray(current, "primaryIds")),
    focusIds: new Set(readStringArray(current, "focusIds")),
    visibleRemoteIds,
    hiddenIds: new Set(readStringArray(current, "hiddenIds")),
    warmIds: new Set(readStringArray(current, "warmIds")),
    orderedRemoteRanks: new Map(
      readStringArray(current, "orderedRemoteIds").map((id, index) => [
        id,
        index,
      ]),
    ),
    participantTileMetrics: readParticipantTileMetrics(visibleRemoteIds),
    presentation: {
      presenterId: presentationPresenterId,
      producerId: presentationProducerId,
      visible: readBoolean(presentation, "visible"),
      primary: readBoolean(presentation, "primary"),
      focus: readBoolean(presentation, "focus"),
      renderedWidth: presentationMetrics.width,
      renderedHeight: presentationMetrics.height,
      size: presentationMetrics.size,
    },
  };
};

const getLayoutRole = (
  hints: RoomTilingHints | null,
  userId: string,
  type: ProducerMapEntry["type"],
  producerId: string,
): LayoutRole | null => {
  if (!hints) return null;
  const isScreenShare = type === "screen";
  const isPresentedScreenByProducer =
    isScreenShare &&
    Boolean(hints.presentation.producerId) &&
    hints.presentation.producerId === producerId;
  const isPresentedScreenByPresenter =
    isScreenShare &&
    !hints.presentation.producerId &&
    hints.presentation.presenterId === userId;
  const isPresentedScreen =
    type === "screen" &&
    hints.presentation.visible &&
    (isPresentedScreenByProducer || isPresentedScreenByPresenter);
  const participantVideoVisible = hints.visibleRemoteIds.has(userId);
  const participantVideoHidden = hints.hiddenIds.has(userId);
  const participantTileMetrics = isScreenShare
    ? null
    : (hints.participantTileMetrics.get(userId) ?? null);
  return {
    primary:
      (!isScreenShare && hints.primaryIds.has(userId)) ||
      (isPresentedScreen && hints.presentation.primary),
    focus:
      (!isScreenShare && hints.focusIds.has(userId)) ||
      (isPresentedScreen && hints.presentation.focus),
    visible: isScreenShare ? isPresentedScreen : participantVideoVisible,
    hidden: isScreenShare
      ? hints.presentation.visible && !isPresentedScreen
      : participantVideoHidden,
    warm: isScreenShare ? false : hints.warmIds.has(userId),
    rank: isScreenShare
      ? null
      : (hints.orderedRemoteRanks.get(userId) ?? null),
    renderedWidth: isPresentedScreen
      ? hints.presentation.renderedWidth
      : participantTileMetrics?.width ?? null,
    renderedHeight: isPresentedScreen
      ? hints.presentation.renderedHeight
      : participantTileMetrics?.height ?? null,
    renderedDevicePixelRatio: isPresentedScreen
      ? 1
      : participantTileMetrics?.devicePixelRatio ?? null,
    presentationSize: isPresentedScreen ? hints.presentation.size : null,
  };
};

const parseScalabilityMode = (mode: unknown): LayerBounds | null => {
  if (typeof mode !== "string") return null;
  const match = /[LS](\d+)T(\d+)/i.exec(mode);
  if (!match) return null;

  const spatialLayers = Number(match[1]);
  const temporalLayers = Number(match[2]);
  if (
    !Number.isInteger(spatialLayers) ||
    !Number.isInteger(temporalLayers) ||
    spatialLayers <= 0 ||
    temporalLayers <= 0
  ) {
    return null;
  }

  return {
    maxSpatialLayer: spatialLayers - 1,
    maxTemporalLayer: temporalLayers - 1,
  };
};

const inferLayerBounds = (
  consumer: Consumer,
  info: ProducerMapEntry,
): LayerBounds | null => {
  const encodings = consumer.rtpParameters.encodings ?? [];
  for (const encoding of encodings) {
    const bounds = parseScalabilityMode(encoding.scalabilityMode);
    if (bounds) return bounds;
  }

  if (info.type === "screen") {
    return { maxSpatialLayer: 0, maxTemporalLayer: 2 };
  }

  if (info.type === "webcam") {
    return {
      maxSpatialLayer: 2,
      maxTemporalLayer: WEBCAM_RECEIVE_TEMPORAL_LAYER,
    };
  }

  return null;
};

const clampLayer = (value: number, max: number): number =>
  Math.min(Math.max(0, value), Math.max(0, max));

const sameConsumerLayers = (
  left?: ConsumerLayerPreference,
  right?: ConsumerLayerPreference,
): boolean => {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.spatialLayer === right.spatialLayer &&
    (left.temporalLayer ?? null) === (right.temporalLayer ?? null)
  );
};

const isConsumerLayerUpgrade = (
  previous: ConsumerLayerPreference | undefined,
  next: ConsumerLayerPreference,
): boolean => {
  if (!previous) return true;
  if (next.spatialLayer > previous.spatialLayer) return true;
  return (
    next.spatialLayer === previous.spatialLayer &&
    (next.temporalLayer ?? -1) > (previous.temporalLayer ?? -1)
  );
};

const telemetryConfirmsPreferences = (
  telemetry:
    | {
        consumerId: string;
        priority: number;
        paused: boolean;
        preferredLayers?: ConsumerLayerPreference;
      }
    | undefined,
  consumerId: string,
  preferences: DesiredConsumerPreferences,
): boolean => {
  if (!telemetry || telemetry.consumerId !== consumerId) return false;
  if (telemetry.priority !== preferences.priority) return false;
  if (
    typeof preferences.paused === "boolean" &&
    telemetry.paused !== preferences.paused
  ) {
    return false;
  }
  if (
    typeof preferences.paused !== "boolean" &&
    preferences.priority === AUDIO_CONSUMER_PRIORITY &&
    telemetry.paused
  ) {
    return false;
  }
  if (
    preferences.preferredLayers &&
    !sameConsumerLayers(telemetry.preferredLayers, preferences.preferredLayers)
  ) {
    return false;
  }
  return true;
};

const qualityRank: Record<ConnectionQuality, number> = {
  unknown: 0,
  good: 1,
  fair: 2,
  poor: 3,
};

const worstQuality = (
  left: ConnectionQuality,
  right: ConnectionQuality,
): ConnectionQuality => {
  if (left === "unknown") return right;
  if (right === "unknown") return left;
  return qualityRank[left] >= qualityRank[right] ? left : right;
};

const getScreenShareReceiveQualityForAvailableBitrate = (
  availableIncomingBitrateBps: number | null | undefined,
): ConnectionQuality => {
  const profile =
    getScreenShareReceiveNetworkProfileForAvailableIncomingBitrate(
      availableIncomingBitrateBps,
    );
  if (profile === "emergency") return "poor";
  return profile ?? "unknown";
};

const isScreenShareReceiveEmergencyBitrate = (
  availableIncomingBitrateBps: number | null | undefined,
): boolean =>
  typeof availableIncomingBitrateBps === "number" &&
  Number.isFinite(availableIncomingBitrateBps) &&
  availableIncomingBitrateBps > 0 &&
  availableIncomingBitrateBps <= SCREEN_SHARE_RECEIVE_EMERGENCY_BPS;

const buildLayerPreference = (
  targetSpatialLayer: number,
  targetTemporalLayer: number,
  bounds: LayerBounds,
): ConsumerLayerPreference => ({
  spatialLayer: clampLayer(targetSpatialLayer, bounds.maxSpatialLayer),
  temporalLayer: clampLayer(targetTemporalLayer, bounds.maxTemporalLayer),
});

const buildWebcamLayerPreference = (
  targetSpatialLayer: number,
  bounds: LayerBounds,
): ConsumerLayerPreference =>
  buildLayerPreference(
    targetSpatialLayer,
    WEBCAM_RECEIVE_TEMPORAL_LAYER,
    bounds,
  );

const getScreenShareTargetTemporalLayer = (
  bounds: LayerBounds,
  options: {
    quality: ConnectionQuality;
    emergency: boolean;
    visible: boolean;
    primary: boolean;
    renderedHeight: number | null;
    presentationSize: PresentationTileSize | null;
  },
): number => {
  const isSmallPresentation =
    options.presentationSize === "rail" ||
    (options.renderedHeight !== null &&
      options.renderedHeight < SCREEN_SHARE_SMALL_RENDERED_HEIGHT);
  const isLargePresentation =
    options.primary ||
    options.presentationSize === "stage" ||
    (options.renderedHeight !== null &&
      options.renderedHeight >= SCREEN_SHARE_FULL_FPS_RENDERED_HEIGHT);

  if (!options.visible) {
    return options.emergency || options.quality === "poor" ? 0 : 1;
  }

  if (options.emergency) {
    return 1;
  }

  if (options.quality === "poor") {
    return isLargePresentation ? 1 : 0;
  }

  if (isSmallPresentation) {
    return 0;
  }

  if (options.quality === "fair") {
    return 1;
  }

  return isLargePresentation ? bounds.maxTemporalLayer : 1;
};

const getDesiredPreferences = (
  info: ProducerMapEntry,
  bounds: LayerBounds | null,
  options: {
    quality: ConnectionQuality;
    activeSpeakerId: string | null;
    webcamVideoCount: number;
    fallbackRank: number | null;
    fullResolutionEligible: boolean;
    layout: LayoutRole | null;
    emergencyMode: boolean;
    receiveContinuityRisk: boolean;
    receiveRecoveryProbeActive: boolean;
    emergencyKeepVideo: boolean;
    screenShareVideoActive: boolean;
    dataSaverMode: boolean;
    isDocumentVisible: boolean;
    availableIncomingBitrateBps: number | null;
    consumerScoreQuality: ConsumerScoreQuality;
    previousSpatialLayer: number | null;
  },
): DesiredConsumerPreferences | null => {
  if (info.kind === "audio") {
    return {
      priority: AUDIO_CONSUMER_PRIORITY,
    };
  }

  if (info.kind !== "video") return null;

  const screenShareReceiveQuality =
    getScreenShareReceiveQualityForAvailableBitrate(
      options.availableIncomingBitrateBps,
    );
  const screenShareReceiveEmergency = isScreenShareReceiveEmergencyBitrate(
    options.availableIncomingBitrateBps,
  );
  const consumerScoreReceiveQuality: ConnectionQuality =
    options.consumerScoreQuality;
  const quality = options.receiveRecoveryProbeActive
    ? "good"
    : getEffectiveConsumerReceiveQuality(
        options.quality,
        consumerScoreReceiveQuality,
      );

  if (info.type === "screen") {
    if (!options.isDocumentVisible) {
      return {
        preferredLayers: bounds ? buildLayerPreference(0, 0, bounds) : undefined,
        priority: HIDDEN_SCREEN_SHARE_KEEPALIVE_PRIORITY,
        paused: false,
      };
    }

    const screenShareQuality = worstQuality(
      worstQuality(
        quality,
        screenShareReceiveQuality,
      ),
      consumerScoreReceiveQuality,
    );
    const screenShareEmergency =
      options.emergencyMode || screenShareReceiveEmergency;
    const screenShareVisible =
      options.layout === null ||
      options.layout.visible === true ||
      options.layout?.primary === true ||
      options.layout?.focus === true;
    const screenSharePrimary =
      options.layout === null ||
      options.layout.primary === true ||
      options.layout.focus === true;
    const screenSharePriority = screenSharePrimary
      ? 240
      : screenShareVisible
        ? 220
        : HIDDEN_SCREEN_SHARE_KEEPALIVE_PRIORITY;
    return {
      preferredLayers: bounds
        ? buildLayerPreference(
            0,
            getScreenShareTargetTemporalLayer(bounds, {
              quality: screenShareQuality,
              emergency: screenShareEmergency,
              visible: screenShareVisible,
              primary: screenSharePrimary,
              renderedHeight: options.layout?.renderedHeight ?? null,
              presentationSize: options.layout?.presentationSize ?? null,
            }),
            bounds,
          )
        : undefined,
      priority: screenSharePriority,
      paused: false,
    };
  }

  if (!options.isDocumentVisible) {
    return {
      preferredLayers: bounds
        ? buildWebcamLayerPreference(0, bounds)
        : undefined,
      priority: OFFSCREEN_WEBCAM_PARK_PRIORITY,
      paused: true,
    };
  }

  const isActiveSpeaker = info.userId === options.activeSpeakerId;
  const layout = options.layout;
  const isPrimary = layout?.primary === true;
  const isLayoutFocus = layout?.focus === true;
  const fallbackVisible =
    !layout &&
    options.fallbackRank !== null &&
    options.fallbackRank < MAX_WEBCAMS_TO_KEEP_FULL_ON_GOOD_LINKS;
  const isVisible = layout ? layout.visible || isPrimary : fallbackVisible;
  const isWarm = layout?.warm === true || (!layout && !fallbackVisible);
  const isHidden = layout?.hidden === true && !isVisible;
  const isFocus = isActiveSpeaker || isLayoutFocus;
  const isFocusOrPrimary = isFocus || isPrimary;
  const webcamRenderedWidth = layout?.renderedWidth ?? null;
  const webcamRenderedHeight = layout?.renderedHeight ?? null;
  const webcamRenderedSpatialLayer = bounds
    ? getWebcamTargetSpatialLayer({
        bounds,
        width: webcamRenderedWidth,
        height: webcamRenderedHeight,
        devicePixelRatio: layout?.renderedDevicePixelRatio ?? 1,
        previousSpatialLayer: options.previousSpatialLayer,
      })
    : null;
  const hasRenderedWebcamTile =
    isVisible || isPrimary || webcamRenderedHeight !== null;

  if (options.dataSaverMode) {
    const shouldPark = shouldParkWebcamForDataSaver({
      isVisible,
      isFocusOrPrimary,
    });
    return {
      preferredLayers: bounds
        ? buildWebcamLayerPreference(0, bounds)
        : undefined,
      priority: isFocusOrPrimary
        ? 155
        : isVisible
          ? 70
          : OFFSCREEN_WEBCAM_PARK_PRIORITY,
      paused: shouldPark,
    };
  }

  if (options.emergencyMode) {
    if (isHidden && !isWarm && !isFocus && !options.emergencyKeepVideo) {
      return {
        preferredLayers: bounds
          ? buildWebcamLayerPreference(0, bounds)
          : undefined,
        priority: OFFSCREEN_WEBCAM_PARK_PRIORITY,
        paused: true,
      };
    }

    if (!options.emergencyKeepVideo) {
      return {
        preferredLayers: bounds
          ? buildWebcamLayerPreference(0, bounds)
          : undefined,
        priority: 8,
        paused: false,
      };
    }

    return {
      preferredLayers: bounds
        ? buildWebcamLayerPreference(0, bounds)
        : undefined,
      priority: isFocus ? 145 : 90,
      paused: false,
    };
  }

  if (
    options.receiveContinuityRisk &&
    !options.receiveRecoveryProbeActive
  ) {
    const continuityLayers = bounds
      ? getWebcamContinuityLayerPreference({
          bounds,
          isFocusOrPrimary,
          availableIncomingBitrateBps: options.availableIncomingBitrateBps,
        })
      : null;
    return {
      preferredLayers: continuityLayers ?? undefined,
      priority: isFocusOrPrimary ? 175 : isVisible ? 70 : 35,
      paused: false,
    };
  }

  const screenShareReserveQuality = options.screenShareVideoActive
    ? worstQuality(quality, screenShareReceiveQuality)
    : quality;
  const shouldParkOffscreenWebcamForScreenShare =
    options.screenShareVideoActive &&
    isHidden &&
    !isWarm &&
    !isFocus &&
    (screenShareReserveQuality === "poor" || screenShareReceiveEmergency);

  if (shouldParkOffscreenWebcamForScreenShare) {
    return {
      preferredLayers: bounds
        ? buildWebcamLayerPreference(0, bounds)
        : undefined,
      priority: OFFSCREEN_WEBCAM_PARK_PRIORITY,
      paused: true,
    };
  }

  if (
    options.screenShareVideoActive &&
    (!isFocus ||
      screenShareReserveQuality !== "good" ||
      screenShareReceiveEmergency)
  ) {
    return {
      preferredLayers: bounds
        ? buildWebcamLayerPreference(0, bounds)
        : undefined,
      priority: screenShareReceiveEmergency
        ? isFocus
          ? 55
          : isVisible
            ? 35
            : isWarm
              ? 16
              : 10
        : isFocus
          ? screenShareReserveQuality === "poor"
            ? 75
            : 105
          : isVisible
            ? screenShareReserveQuality === "poor"
              ? 45
              : 65
            : isWarm
              ? 28
              : 20,
      paused: false,
    };
  }

  if (isHidden && !isWarm && !isFocus) {
    if (quality === "poor") {
      return {
        preferredLayers: bounds
          ? buildWebcamLayerPreference(0, bounds)
          : undefined,
        priority: OFFSCREEN_WEBCAM_PARK_PRIORITY,
        paused: true,
      };
    }

    return {
      preferredLayers: bounds
        ? buildWebcamLayerPreference(0, bounds)
        : undefined,
      priority: 25,
      paused: false,
    };
  }

  if (!isVisible && isWarm && !isFocus) {
    return {
      preferredLayers: bounds
        ? buildWebcamLayerPreference(0, bounds)
        : undefined,
      priority: quality === "poor" ? 35 : 55,
      paused: false,
    };
  }

  const goodLinkSpatialAllocation = bounds
    ? getGoodLinkWebcamSpatialAllocation({
        bounds,
        demandedSpatialLayer:
          webcamRenderedSpatialLayer ?? bounds.maxSpatialLayer,
        isVisible,
        isFocus,
        hasRenderedTile: hasRenderedWebcamTile,
        screenShareVideoActive: options.screenShareVideoActive,
        fullResolutionEligible: options.fullResolutionEligible,
      })
    : null;
  const keepFull =
    quality === "good" &&
    (goodLinkSpatialAllocation?.keepFullResolution ?? false);

  if (quality === "poor") {
    return {
      preferredLayers: bounds
        ? buildWebcamLayerPreference(0, bounds)
        : undefined,
      priority: isFocus ? 155 : isVisible ? 70 : 35,
      paused: false,
    };
  }

  if (quality === "fair") {
    return {
      preferredLayers: bounds
        ? buildWebcamLayerPreference(isFocus ? 1 : 0, bounds)
        : undefined,
      priority: isFocus ? 175 : isVisible ? 90 : 50,
      paused: false,
    };
  }

  return {
    preferredLayers: bounds
      ? buildWebcamLayerPreference(
          goodLinkSpatialAllocation?.spatialLayer ?? 0,
          bounds,
        )
      : undefined,
    priority: keepFull ? 175 : isFocus ? 130 : isVisible ? 95 : 45,
    paused: false,
  };
};

const getPreferenceSignature = (
  consumerId: string,
  preferences: DesiredConsumerPreferences,
): string => {
  const layers = preferences.preferredLayers;
  return [
    consumerId,
    preferences.priority,
    preferences.paused === undefined
      ? "unchanged"
      : preferences.paused
        ? "paused"
        : "resumed",
    layers?.spatialLayer ?? "none",
    layers?.temporalLayer ?? "none",
  ].join(":");
};

const getLayerPreferenceSignature = (
  layers?: ConsumerLayerPreference,
): string =>
  layers
    ? [layers.spatialLayer, layers.temporalLayer ?? "none"].join(":")
    : "none";

const getPreferenceUpdateUrgency = (
  info: ProducerMapEntry,
  preferences: DesiredConsumerPreferences,
  options: {
    layout: LayoutRole | null;
    requestKeyFrame: boolean;
    wasPaused: boolean;
  },
): number => {
  if (info.kind === "audio") return 980;
  if (info.type === "screen") return 1000;
  if (preferences.paused === false && options.wasPaused) return 950;
  if (options.requestKeyFrame) return 900;
  if (options.layout?.primary) return 850;
  if (options.layout?.visible) return 750;
  if (preferences.paused === false) return 600;
  if (options.layout?.warm) return 450;
  if (preferences.paused === true) return 250;
  return 100;
};

const isUnsupportedLayerError = (error: string): boolean =>
  /layer|support|simulcast|svc/i.test(error);

const isConsumerControlRateLimitError = (error: string): boolean =>
  /too many consumer control requests|retry shortly/i.test(error);

export function useAdaptiveConsumerPreferences({
  refs,
  enabled,
  connectionQuality,
  emergencyMode,
  receiveContinuityRisk,
  browserAllowsFairWebcamLayerRecovery = false,
  availableIncomingBitrateBps = null,
  activeSpeakerId,
  dataSaverMode = false,
  isDocumentVisible = true,
  debugStateRef,
  onVideoAdaptivePauseStateChange,
}: UseAdaptiveConsumerPreferencesOptions) {
  const lastAppliedRef = useRef<Map<string, string>>(new Map());
  const lastLayersRef = useRef<Map<string, ConsumerLayerPreference>>(new Map());
  const layerConvergenceKeyFrameAttemptsRef = useRef<
    Map<string, WebcamLayerConvergenceKeyFrameAttempt>
  >(new Map());
  const lastPausedRef = useRef<Map<string, boolean>>(new Map());
  const unsupportedLayerPreferencesRef = useRef<
    Map<string, UnsupportedLayerPreference>
  >(new Map());
  const inFlightProducerIdsRef = useRef<Set<string>>(new Set());
  const scheduledPreferenceTimeoutsRef = useRef<Set<number>>(new Set());
  const rateLimitRetryTimeoutRef = useRef<number | null>(null);
  const preferenceDebugRef = useRef<
    Map<string, AdaptiveConsumerPreferenceDebugEntry>
  >(new Map());
  const consumerScoreAdaptationRef = useRef<
    Map<string, ConsumerScoreAdaptationState>
  >(new Map());
  const receiveRecoveryProbeStateRef = useRef<
    Map<string, WebcamReceiveRecoveryProbeState>
  >(new Map());
  const lastRoomTilingEventSignatureRef = useRef<string | null>(null);
  const lastPublishedAdaptiveVideoPauseRef = useRef<Map<string, string>>(
    new Map(),
  );
  const lastDebugContextRef = useRef<ConsumerPreferenceDebugContext>({
    socketConnected: false,
    layoutHintsAvailable: false,
    webcamVideoCount: 0,
  });
  const videoJitterBufferTargetsRef = useRef<
    Map<string, VideoJitterBufferTargetState>
  >(new Map());
  const videoJitterBufferPolicyRef = useRef({
    enabled,
    connectionQuality,
    emergencyMode,
    dataSaverMode,
    isDocumentVisible,
  });
  videoJitterBufferPolicyRef.current = {
    enabled,
    connectionQuality,
    emergencyMode,
    dataSaverMode,
    isDocumentVisible,
  };

  const reconcileVideoJitterBufferTarget = useCallback(
    (
      producerId: string,
      consumer: Consumer,
      info: ProducerMapEntry,
    ): {
      requestedTargetMs: AdaptiveVideoJitterBufferTargetMs | null;
      status: AdaptiveVideoJitterBufferDebugStatus;
      observedTargetMs: number | null;
    } => {
      if (info.kind !== "video") {
        videoJitterBufferTargetsRef.current.delete(producerId);
        return {
          requestedTargetMs: null,
          status: "not-requested",
          observedTargetMs: null,
        };
      }

      const policy = videoJitterBufferPolicyRef.current;
      const requestedTargetMs = getAdaptiveVideoJitterBufferTargetMs({
        enabled: policy.enabled,
        mediaKind: info.kind,
        sourceType: info.type,
        quality: policy.connectionQuality,
        emergencyMode: policy.emergencyMode,
        dataSaverMode: policy.dataSaverMode,
        isDocumentVisible: policy.isDocumentVisible,
      });
      const receiver = consumer.rtpReceiver;
      const reconciliation = reconcileVideoReceiverJitterBufferTarget({
        consumerId: consumer.id,
        receiver,
        requestedTargetMs,
        previousState:
          videoJitterBufferTargetsRef.current.get(producerId) ?? null,
        nowMs: Date.now(),
      });
      if (reconciliation.nextState) {
        videoJitterBufferTargetsRef.current.set(
          producerId,
          reconciliation.nextState,
        );
      } else {
        // Null policy transitions always clear ownership, including after a
        // prior unsupported receiver or transient setter/readback error.
        videoJitterBufferTargetsRef.current.delete(producerId);
      }
      return reconciliation;
    },
    [],
  );

  const releaseVideoJitterBufferTarget = useCallback(
    (producerId: string, consumer: Consumer) => {
      const currentState =
        videoJitterBufferTargetsRef.current.get(producerId) ?? null;
      const nextState = releaseVideoReceiverJitterBufferTargetState({
        removingConsumerId: consumer.id,
        receiverClosed: consumer.closed,
        currentState,
      });
      if (nextState) {
        if (nextState !== currentState) {
          videoJitterBufferTargetsRef.current.set(producerId, nextState);
        }
        return;
      }
      videoJitterBufferTargetsRef.current.delete(producerId);
    },
    [],
  );

  const resetLiveVideoJitterBufferTargets = useCallback(() => {
    videoJitterBufferTargetsRef.current.forEach((tracked, producerId) => {
      const consumer = refs.consumersRef.current.get(producerId);
      if (
        consumer?.id === tracked.consumerId &&
        !consumer.closed
      ) {
        applyVideoReceiverJitterBufferTarget(tracked.receiver, null);
      }
    });
    videoJitterBufferTargetsRef.current.clear();
  }, [refs.consumersRef]);

  const handleAdaptiveVideoReceiverLifecycle = useCallback(
    (event: AdaptiveVideoReceiverLifecycleEvent) => {
      if (event.type === "removing") {
        releaseVideoJitterBufferTarget(event.producerId, event.consumer);
        return;
      }

      reconcileVideoJitterBufferTarget(
        event.producerId,
        event.consumer,
        event.info,
      );
    },
    [reconcileVideoJitterBufferTarget, releaseVideoJitterBufferTarget],
  );

  const clearScheduledPreferenceWork = useCallback(() => {
    if (typeof window !== "undefined") {
      scheduledPreferenceTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      scheduledPreferenceTimeoutsRef.current.clear();

      if (rateLimitRetryTimeoutRef.current !== null) {
        window.clearTimeout(rateLimitRetryTimeoutRef.current);
        rateLimitRetryTimeoutRef.current = null;
      }
    }

    inFlightProducerIdsRef.current.clear();
  }, []);

  const publishAdaptiveVideoPauseChanges = useCallback(() => {
    const nextPausedByProducerId = new Map<string, string>();
    refs.adaptivelyPausedConsumerProducerIdsRef.current.forEach((producerId) => {
      const info = refs.producerMapRef.current.get(producerId);
      if (info?.kind === "video" && info.type === "webcam") {
        nextPausedByProducerId.set(producerId, info.userId);
      }
    });

    const previousPausedByProducerId =
      lastPublishedAdaptiveVideoPauseRef.current;
    if (onVideoAdaptivePauseStateChange) {
      previousPausedByProducerId.forEach((userId, producerId) => {
        if (nextPausedByProducerId.has(producerId)) return;
        onVideoAdaptivePauseStateChange({
          producerId,
          userId,
          adaptivelyPaused: false,
        });
      });
      nextPausedByProducerId.forEach((userId, producerId) => {
        const previousUserId = previousPausedByProducerId.get(producerId);
        if (previousUserId === userId) return;
        if (previousUserId) {
          onVideoAdaptivePauseStateChange({
            producerId,
            userId: previousUserId,
            adaptivelyPaused: false,
          });
        }
        onVideoAdaptivePauseStateChange({
          producerId,
          userId,
          adaptivelyPaused: true,
        });
      });
    }
    lastPublishedAdaptiveVideoPauseRef.current = nextPausedByProducerId;
  }, [
    onVideoAdaptivePauseStateChange,
    refs.adaptivelyPausedConsumerProducerIdsRef,
    refs.producerMapRef,
  ]);

  const writeDebugSnapshot = useCallback(
    (context?: ConsumerPreferenceDebugContext) => {
      publishAdaptiveVideoPauseChanges();
      if (!debugStateRef) return;
      if (context) {
        lastDebugContextRef.current = context;
      }

      const entries = Array.from(preferenceDebugRef.current.values());
      const appliedEntries = entries.filter(
        (entry) => entry.status === "applied" || entry.status === "fallback",
      );
      debugStateRef.current = {
        enabled,
        timestamp: Date.now(),
        connectionQuality,
        emergencyMode,
        receiveContinuityRisk,
        browserAllowsFairWebcamLayerRecovery,
        dataSaverMode,
        isDocumentVisible,
        activeSpeakerId,
        socketConnected: lastDebugContextRef.current.socketConnected,
        layoutHintsAvailable:
          lastDebugContextRef.current.layoutHintsAvailable,
        webcamVideoCount: lastDebugContextRef.current.webcamVideoCount,
        appliedCount: appliedEntries.length,
        pausedCount: appliedEntries.filter((entry) => entry.paused === true)
          .length,
        fallbackCount: entries.filter((entry) => entry.status === "fallback")
          .length,
        errorCount: entries.filter((entry) => entry.status === "error").length,
        deferredCount: entries.filter((entry) => entry.status === "deferred")
          .length,
        adaptivelyPausedProducerIds: Array.from(
          refs.adaptivelyPausedConsumerProducerIdsRef.current,
        ),
        unsupportedLayerProducerIds: Array.from(
          unsupportedLayerPreferencesRef.current.keys(),
        ),
        entries,
      };
    },
    [
      activeSpeakerId,
      connectionQuality,
      debugStateRef,
      enabled,
      emergencyMode,
      receiveContinuityRisk,
      browserAllowsFairWebcamLayerRecovery,
      dataSaverMode,
      isDocumentVisible,
      publishAdaptiveVideoPauseChanges,
      refs.adaptivelyPausedConsumerProducerIdsRef,
    ],
  );

  const applyPreferences = useCallback(() => {
    const socket = refs.socketRef.current;
    if (!enabled || !socket?.connected) {
      clearScheduledPreferenceWork();
      resetLiveVideoJitterBufferTargets();
      writeDebugSnapshot({
        socketConnected: socket?.connected === true,
        layoutHintsAvailable: false,
        webcamVideoCount: 0,
      });
      return;
    }

    const layoutHints = readRoomTilingHints();
    const webcamVideoCount = Array.from(
      refs.producerMapRef.current.values(),
    ).filter(
      (info) => info.kind === "video" && info.type === "webcam",
    ).length;
    const screenShareVideoActive = Array.from(
      refs.producerMapRef.current.values(),
    ).some((info) => info.kind === "video" && info.type === "screen");
    const fullResolutionWebcamUserIds = new Set<string>();
    if (layoutHints) {
      Array.from(refs.producerMapRef.current.values())
        .filter(
          (info) => info.kind === "video" && info.type === "webcam",
        )
        .map((info) => ({
          userId: info.userId,
          focus:
            info.userId === activeSpeakerId ||
            layoutHints.focusIds.has(info.userId),
          primary: layoutHints.primaryIds.has(info.userId),
          visible: layoutHints.visibleRemoteIds.has(info.userId),
          rank:
            layoutHints.orderedRemoteRanks.get(info.userId) ??
            Number.MAX_SAFE_INTEGER,
        }))
        .filter(
          (candidate) =>
            candidate.focus || candidate.primary || candidate.visible,
        )
        .sort(
          (left, right) =>
            Number(right.focus) - Number(left.focus) ||
            Number(right.primary) - Number(left.primary) ||
            left.rank - right.rank ||
            left.userId.localeCompare(right.userId),
        )
        .forEach((candidate) => {
          if (
            fullResolutionWebcamUserIds.size >=
              MAX_WEBCAMS_TO_KEEP_FULL_ON_GOOD_LINKS ||
            fullResolutionWebcamUserIds.has(candidate.userId)
          ) {
            return;
          }
          fullResolutionWebcamUserIds.add(candidate.userId);
        });
    }
    const fallbackWebcamRanks = new Map<string, number>();
    if (!layoutHints) {
      Array.from(refs.consumersRef.current.entries())
        .map(([producerId, consumer]) => {
          const info = refs.producerMapRef.current.get(producerId);
          if (
            !info ||
            consumer.closed ||
            info.kind !== "video" ||
            info.type !== "webcam"
          ) {
            return null;
          }
          return {
            producerId,
            userId: info.userId,
            active: info.userId === activeSpeakerId,
          };
        })
        .filter(
          (
            candidate,
          ): candidate is {
            producerId: string;
            userId: string;
            active: boolean;
          } => Boolean(candidate),
        )
        .sort(
          (left, right) =>
            Number(right.active) - Number(left.active) ||
            left.userId.localeCompare(right.userId) ||
            left.producerId.localeCompare(right.producerId),
        )
        .forEach((candidate, index) => {
          fallbackWebcamRanks.set(candidate.producerId, index);
        });
    }
    const emergencyVideoKeepProducerIds = new Set<string>();
    if (emergencyMode) {
      const candidates = Array.from(refs.consumersRef.current.entries())
        .map(([producerId, consumer]) => {
          const info = refs.producerMapRef.current.get(producerId);
          if (
            !info ||
            consumer.closed ||
            info.kind !== "video" ||
            info.type !== "webcam"
          ) {
            return null;
          }

          const layout = getLayoutRole(
            layoutHints,
            info.userId,
            info.type,
            producerId,
          );
          return {
            producerId,
            active: info.userId === activeSpeakerId,
            rank: layout?.rank ?? Number.MAX_SAFE_INTEGER,
            visible: layout?.visible === true || layout?.primary === true,
            warm: layout?.warm === true,
          };
        })
        .filter(
          (
            candidate,
          ): candidate is {
            producerId: string;
            active: boolean;
            rank: number;
            visible: boolean;
            warm: boolean;
          } => Boolean(candidate),
        )
        .sort(
          (left, right) =>
            Number(right.active) - Number(left.active) ||
            left.rank - right.rank ||
            Number(right.visible) - Number(left.visible) ||
            Number(right.warm) - Number(left.warm) ||
            left.producerId.localeCompare(right.producerId),
        );
      const keep = candidates[0];
      if (keep) emergencyVideoKeepProducerIds.add(keep.producerId);
    }
    const liveProducerIds = new Set(refs.consumersRef.current.keys());

    const trackedProducerIds = new Set([
      ...lastAppliedRef.current.keys(),
      ...preferenceDebugRef.current.keys(),
      ...videoJitterBufferTargetsRef.current.keys(),
      ...consumerScoreAdaptationRef.current.keys(),
      ...receiveRecoveryProbeStateRef.current.keys(),
    ]);
    for (const producerId of trackedProducerIds) {
      if (liveProducerIds.has(producerId)) continue;
      lastAppliedRef.current.delete(producerId);
      lastLayersRef.current.delete(producerId);
      layerConvergenceKeyFrameAttemptsRef.current.delete(producerId);
      lastPausedRef.current.delete(producerId);
      unsupportedLayerPreferencesRef.current.delete(producerId);
      inFlightProducerIdsRef.current.delete(producerId);
      preferenceDebugRef.current.delete(producerId);
      videoJitterBufferTargetsRef.current.delete(producerId);
      consumerScoreAdaptationRef.current.delete(producerId);
      receiveRecoveryProbeStateRef.current.delete(producerId);
      refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(producerId);
    }

    const debugContext = {
      socketConnected: true,
      layoutHintsAvailable: Boolean(layoutHints),
      webcamVideoCount,
    };
    const pendingUpdates: PendingConsumerPreferenceUpdate[] = [];
    const now = Date.now();

    refs.consumersRef.current.forEach((consumer, producerId) => {
      const info = refs.producerMapRef.current.get(producerId);
      if (!info || consumer.closed) {
        preferenceDebugRef.current.delete(producerId);
        videoJitterBufferTargetsRef.current.delete(producerId);
        consumerScoreAdaptationRef.current.delete(producerId);
        receiveRecoveryProbeStateRef.current.delete(producerId);
        refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(producerId);
        return;
      }

      const jitterBufferTarget = reconcileVideoJitterBufferTarget(
        producerId,
        consumer,
        info,
      );

      const bounds = inferLayerBounds(consumer, info);
      const layout = getLayoutRole(
        layoutHints,
        info.userId,
        info.type,
        producerId,
      );
      const emergencyKeepVideo =
        emergencyMode &&
        info.kind === "video" &&
        info.type === "webcam" &&
        emergencyVideoKeepProducerIds.has(producerId);
      const consumerTelemetry =
        refs.consumerTelemetryRef.current.get(producerId);
      const consumerScoreSample = consumerTelemetry
        ? getConsumerScoreSample({
            score: consumerTelemetry.score,
            currentSpatialLayer:
              consumerTelemetry.currentLayers?.spatialLayer ?? null,
            receivedAtMs: consumerTelemetry.receivedAt,
            nowMs: now,
          })
        : { score: null, quality: "unknown" as const };
      const consumerScoreState = advanceConsumerScoreAdaptation({
        consumerId: consumer.id,
        sampleQuality: consumerScoreSample.quality,
        previousState: consumerScoreAdaptationRef.current.get(producerId),
        nowMs: now,
      });
      consumerScoreAdaptationRef.current.set(
        producerId,
        consumerScoreState,
      );
      const consumerScore = consumerScoreSample.score;
      const consumerScoreQuality = consumerScoreState.quality;
      const fallbackRank = fallbackWebcamRanks.get(producerId) ?? null;
      const previousLayers = lastLayersRef.current.get(producerId);
      let receiveRecoveryProbeState: WebcamReceiveRecoveryProbeState | null =
        null;
      if (info.kind === "video" && info.type === "webcam") {
        const isRecoveryProbeVisible = layout
          ? layout.visible || layout.primary || layout.focus
          : fallbackRank !== null &&
            fallbackRank < MAX_WEBCAMS_TO_KEEP_FULL_ON_GOOD_LINKS;
        receiveRecoveryProbeState = advanceWebcamReceiveRecoveryProbe({
          previousState:
            receiveRecoveryProbeStateRef.current.get(producerId) ?? null,
          consumerId: consumer.id,
          nowMs: now,
          connectionQuality,
          consumerScoreQuality,
          browserAllowsRecovery: browserAllowsFairWebcamLayerRecovery,
          emergencyMode,
          receiveContinuityRisk,
          dataSaverMode,
          isDocumentVisible,
          isVisible: isRecoveryProbeVisible,
        });
        receiveRecoveryProbeStateRef.current.set(
          producerId,
          receiveRecoveryProbeState,
        );
      } else {
        receiveRecoveryProbeStateRef.current.delete(producerId);
      }
      const desired = getDesiredPreferences(info, bounds, {
        quality: connectionQuality,
        activeSpeakerId,
        webcamVideoCount,
        fallbackRank,
        fullResolutionEligible:
          webcamVideoCount <= MAX_WEBCAMS_TO_KEEP_FULL_ON_GOOD_LINKS ||
          (layoutHints
            ? fullResolutionWebcamUserIds.has(info.userId)
            : fallbackRank !== null &&
              fallbackRank < MAX_WEBCAMS_TO_KEEP_FULL_ON_GOOD_LINKS),
        layout,
        emergencyMode,
        receiveContinuityRisk,
        receiveRecoveryProbeActive:
          receiveRecoveryProbeState?.phase === "active",
        emergencyKeepVideo,
        screenShareVideoActive,
        dataSaverMode,
        isDocumentVisible,
        availableIncomingBitrateBps,
        consumerScoreQuality,
        previousSpatialLayer: previousLayers?.spatialLayer ?? null,
      });
      if (!desired) return;

      const wasPaused =
        lastPausedRef.current.get(producerId) === true ||
        refs.adaptivelyPausedConsumerProducerIdsRef.current.has(producerId);
      const desiredLayerSignature = getLayerPreferenceSignature(
        desired.preferredLayers,
      );
      const unsupportedLayerPreference =
        unsupportedLayerPreferencesRef.current.get(producerId);
      const shouldSuppressPreferredLayers = Boolean(
        desired.preferredLayers &&
          unsupportedLayerPreference &&
          unsupportedLayerPreference.consumerId === consumer.id &&
          unsupportedLayerPreference.signature === desiredLayerSignature &&
          unsupportedLayerPreference.retryAt > now,
      );
      if (
        unsupportedLayerPreference &&
        (!desired.preferredLayers ||
          unsupportedLayerPreference.consumerId !== consumer.id ||
          unsupportedLayerPreference.signature !== desiredLayerSignature ||
          unsupportedLayerPreference.retryAt <= now)
      ) {
        unsupportedLayerPreferencesRef.current.delete(producerId);
      }
      const preferredLayers = shouldSuppressPreferredLayers
        ? undefined
        : desired.preferredLayers;
      const preferences = {
        ...desired,
        preferredLayers,
      };
      const isScreenShareVideo =
        info.kind === "video" && info.type === "screen";
      const currentSpatialLayer =
        consumerTelemetry?.currentLayers?.spatialLayer ?? null;
      if (
        preferredLayers &&
        currentSpatialLayer !== null &&
        currentSpatialLayer >= preferredLayers.spatialLayer
      ) {
        layerConvergenceKeyFrameAttemptsRef.current.delete(producerId);
      }
      const retryWebcamLayerConvergence =
        info.kind === "video" &&
        info.type === "webcam" &&
        preferences.paused === false &&
        shouldRetryWebcamLayerConvergenceKeyFrame({
          consumerId: consumer.id,
          preferredSpatialLayer: preferredLayers?.spatialLayer ?? null,
          currentSpatialLayer,
          healthyPath: isWebcamLayerConvergencePathHealthy({
            connectionQuality,
            consumerScoreQuality,
            emergencyMode,
            receiveContinuityRisk,
            dataSaverMode,
          }),
          visiblePriority: Boolean(layout?.visible || layout?.primary || layout?.focus),
          nowMs: now,
          previousAttempt:
            layerConvergenceKeyFrameAttemptsRef.current.get(producerId) ?? null,
        });
      const requestKeyFrame =
        preferences.paused === false &&
        Boolean(preferredLayers) &&
        (wasPaused ||
          retryWebcamLayerConvergence ||
          (isScreenShareVideo
            ? !sameConsumerLayers(previousLayers, preferredLayers)
            : isConsumerLayerUpgrade(previousLayers, preferredLayers!)));
      const debugEntryBase = {
        producerId,
        consumerId: consumer.id,
        userId: info.userId,
        kind: info.kind,
        type: info.type,
        priority: preferences.priority,
        requestedPaused: preferences.paused ?? null,
        requestedLayers: preferredLayers,
        requestedJitterBufferTargetMs:
          jitterBufferTarget.requestedTargetMs,
        observedTargetMs: jitterBufferTarget.observedTargetMs,
        jitterBufferTargetStatus: jitterBufferTarget.status,
        emergencyKeepVideo:
          emergencyMode && info.kind === "video" && info.type === "webcam"
            ? emergencyKeepVideo
            : null,
        consumerScore,
        consumerScoreQuality,
        receiveRecoveryProbePhase:
          receiveRecoveryProbeState?.phase ?? null,
        receiveRecoveryProbeActive:
          receiveRecoveryProbeState?.phase === "active",
        bounds,
        layout,
        requestKeyFrame,
        unsupportedLayers: shouldSuppressPreferredLayers,
      };
      const signature = getPreferenceSignature(consumer.id, preferences);
      if (
        lastAppliedRef.current.get(producerId) === signature &&
        !retryWebcamLayerConvergence
      ) {
        const existingDebugEntry = preferenceDebugRef.current.get(producerId);
        if (
          telemetryConfirmsPreferences(
            consumerTelemetry ?? undefined,
            consumer.id,
            preferences,
          )
        ) {
          if (preferredLayers) {
            lastLayersRef.current.set(producerId, preferredLayers);
          }
          lastPausedRef.current.set(producerId, consumerTelemetry!.paused);
          if (consumerTelemetry!.paused) {
            refs.adaptivelyPausedConsumerProducerIdsRef.current.add(producerId);
          } else {
            refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(
              producerId,
            );
          }
          preferenceDebugRef.current.set(producerId, {
            ...debugEntryBase,
            status: "applied",
            paused: consumerTelemetry!.paused,
            producerPaused: consumerTelemetry!.producerPaused,
            preferredLayers: consumerTelemetry!.preferredLayers,
            currentLayers: consumerTelemetry!.currentLayers,
            error: null,
            appliedAt: Math.max(
              existingDebugEntry?.appliedAt ?? 0,
              consumerTelemetry!.receivedAt,
            ),
          });
          return;
        }
        if (existingDebugEntry) {
          preferenceDebugRef.current.set(producerId, {
            ...existingDebugEntry,
            consumerScore,
            consumerScoreQuality,
            requestedJitterBufferTargetMs:
              jitterBufferTarget.requestedTargetMs,
            observedTargetMs: jitterBufferTarget.observedTargetMs,
            jitterBufferTargetStatus: jitterBufferTarget.status,
          });
        }
        return;
      }

      if (inFlightProducerIdsRef.current.has(producerId)) {
        if (
          telemetryConfirmsPreferences(
            consumerTelemetry ?? undefined,
            consumer.id,
            preferences,
          )
        ) {
          lastAppliedRef.current.set(producerId, signature);
          if (preferredLayers) {
            lastLayersRef.current.set(producerId, preferredLayers);
          }
          lastPausedRef.current.set(producerId, consumerTelemetry!.paused);
          if (consumerTelemetry!.paused) {
            refs.adaptivelyPausedConsumerProducerIdsRef.current.add(producerId);
          } else {
            refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(
              producerId,
            );
          }
          inFlightProducerIdsRef.current.delete(producerId);
          preferenceDebugRef.current.set(producerId, {
            ...debugEntryBase,
            status: "applied",
            paused: consumerTelemetry!.paused,
            producerPaused: consumerTelemetry!.producerPaused,
            preferredLayers: consumerTelemetry!.preferredLayers,
            currentLayers: consumerTelemetry!.currentLayers,
            error: null,
            appliedAt: consumerTelemetry!.receivedAt,
          });
          return;
        }
        preferenceDebugRef.current.set(producerId, {
          ...debugEntryBase,
          status: "deferred",
          paused: lastPausedRef.current.get(producerId) ?? null,
          producerPaused: null,
          error: null,
          appliedAt: now,
        });
        return;
      }

      pendingUpdates.push({
        producerId,
        consumer,
        preferences,
        preferredLayers,
        signature,
        debugEntryBase,
        urgency: getPreferenceUpdateUrgency(info, preferences, {
          layout,
          requestKeyFrame,
          wasPaused,
        }),
      });
    });

    pendingUpdates.sort(
      (left, right) =>
        right.urgency - left.urgency ||
        left.producerId.localeCompare(right.producerId),
    );

    const maxUpdatesThisCycle = screenShareVideoActive
      ? SCREEN_SHARE_CONSUMER_PREFERENCE_UPDATES_PER_CYCLE
      : MAX_CONSUMER_PREFERENCE_UPDATES_PER_CYCLE;
    const emitSpacingMs = screenShareVideoActive
      ? SCREEN_SHARE_CONSUMER_PREFERENCE_EMIT_SPACING_MS
      : CONSUMER_PREFERENCE_EMIT_SPACING_MS;
    const updatesToSend = pendingUpdates.slice(
      0,
      maxUpdatesThisCycle,
    );
    const deferredUpdates = pendingUpdates.slice(
      maxUpdatesThisCycle,
    );

    for (const update of deferredUpdates) {
      preferenceDebugRef.current.set(update.producerId, {
        ...update.debugEntryBase,
        status: "deferred",
        paused: lastPausedRef.current.get(update.producerId) ?? null,
        producerPaused: null,
        error: null,
        appliedAt: Date.now(),
      });
    }

    for (const update of updatesToSend) {
      inFlightProducerIdsRef.current.add(update.producerId);
    }

    const scheduleRateLimitRetry = () => {
      if (
        typeof window === "undefined" ||
        rateLimitRetryTimeoutRef.current !== null
      ) {
        return;
      }

      rateLimitRetryTimeoutRef.current = window.setTimeout(() => {
        rateLimitRetryTimeoutRef.current = null;
        applyPreferences();
      }, RATE_LIMIT_RETRY_DELAY_MS);
    };

    const buildPreferencePayload = (update: PendingConsumerPreferenceUpdate) => ({
      consumerId: update.consumer.id,
      priority: update.preferences.priority,
      ...(update.preferredLayers
        ? { preferredLayers: update.preferredLayers }
        : {}),
      ...(typeof update.preferences.paused === "boolean"
        ? { paused: update.preferences.paused }
        : {}),
      requestKeyFrame: update.debugEntryBase.requestKeyFrame,
    });

    const isUpdateStillLive = (
      update: PendingConsumerPreferenceUpdate,
    ): boolean => {
      const liveConsumer = refs.consumersRef.current.get(update.producerId);
      return isConsumerPreferenceGenerationCurrent({
        enabled,
        socketConnected: socket.connected,
        updateConsumerClosed: update.consumer.closed,
        updateConsumerId: update.consumer.id,
        currentConsumerId: liveConsumer?.id ?? null,
      });
    };

    const markDeferredForRetry = (
      update: PendingConsumerPreferenceUpdate,
      error: string,
    ) => {
      if (!isUpdateStillLive(update)) {
        inFlightProducerIdsRef.current.delete(update.producerId);
        return;
      }
      preferenceDebugRef.current.set(update.producerId, {
        ...update.debugEntryBase,
        status: "deferred",
        paused: update.preferences.paused ?? null,
        producerPaused: null,
        error,
        appliedAt: Date.now(),
      });
      writeDebugSnapshot(debugContext);
      scheduleRateLimitRetry();
    };

    const markDisplacedGenerationForRetry = (
      update: PendingConsumerPreferenceUpdate,
      error: string,
    ) => {
      inFlightProducerIdsRef.current.delete(update.producerId);
      if (update.preferences.paused === true) {
        // Preserve the desired pause while a make-before-break candidate is
        // server-current. Clearing this optimistic marker could let that
        // candidate commit and flow until the next preference cycle.
        refs.adaptivelyPausedConsumerProducerIdsRef.current.add(
          update.producerId,
        );
      }
      preferenceDebugRef.current.set(update.producerId, {
        ...update.debugEntryBase,
        status: "deferred",
        paused: update.preferences.paused ?? null,
        producerPaused: null,
        error,
        appliedAt: Date.now(),
      });
      writeDebugSnapshot(debugContext);
      scheduleRateLimitRetry();
    };

    const markError = (
      update: PendingConsumerPreferenceUpdate,
      error: string,
      unsupportedLayers = false,
    ) => {
      if (!isUpdateStillLive(update)) {
        inFlightProducerIdsRef.current.delete(update.producerId);
        return;
      }
      preferenceDebugRef.current.set(update.producerId, {
        ...update.debugEntryBase,
        status: "error",
        paused: update.preferences.paused ?? null,
        producerPaused: null,
        error,
        appliedAt: Date.now(),
        unsupportedLayers,
      });
      if (update.preferences.paused === true) {
        refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(
          update.producerId,
        );
      }
      writeDebugSnapshot(debugContext);
    };

    const markOptimisticPauseState = (
      update: PendingConsumerPreferenceUpdate,
    ) => {
      if (update.preferences.paused === true) {
        refs.adaptivelyPausedConsumerProducerIdsRef.current.add(
          update.producerId,
        );
      } else if (update.preferences.paused === false) {
        refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(
          update.producerId,
        );
      }
    };

    const sendPriorityOnlyFallback = (
      update: PendingConsumerPreferenceUpdate,
    ) => {
      let fallbackSettled = false;
      const fallbackAckTimeoutId = window.setTimeout(() => {
        if (fallbackSettled) return;
        fallbackSettled = true;
        scheduledPreferenceTimeoutsRef.current.delete(fallbackAckTimeoutId);
        inFlightProducerIdsRef.current.delete(update.producerId);
        if (!isUpdateStillLive(update)) return;
        markDeferredForRetry(
          update,
          "setConsumerPreferences priority-only ack timeout",
        );
      }, CONSUMER_PREFERENCE_ACK_TIMEOUT_MS);
      scheduledPreferenceTimeoutsRef.current.add(fallbackAckTimeoutId);
      socket.emit(
        "setConsumerPreferences",
        {
          consumerId: update.consumer.id,
          priority: update.preferences.priority,
          ...(typeof update.preferences.paused === "boolean"
            ? { paused: update.preferences.paused }
            : {}),
        },
        (priorityOnlyResponse: SetConsumerPreferencesResponse) => {
          if (fallbackSettled) return;
          fallbackSettled = true;
          scheduledPreferenceTimeoutsRef.current.delete(fallbackAckTimeoutId);
          window.clearTimeout(fallbackAckTimeoutId);
          if (!isUpdateStillLive(update)) {
            inFlightProducerIdsRef.current.delete(update.producerId);
            return;
          }
          if ("error" in priorityOnlyResponse) {
            inFlightProducerIdsRef.current.delete(update.producerId);
            if (
              isConsumerGenerationDisplacedError(
                priorityOnlyResponse.error,
              )
            ) {
              markDisplacedGenerationForRetry(
                update,
                priorityOnlyResponse.error,
              );
              return;
            }
            if (isConsumerControlRateLimitError(priorityOnlyResponse.error)) {
              markDeferredForRetry(update, priorityOnlyResponse.error);
              return;
            }

            markError(update, priorityOnlyResponse.error, true);
            return;
          }

          inFlightProducerIdsRef.current.delete(update.producerId);
          lastAppliedRef.current.set(
            update.producerId,
            getPreferenceSignature(update.consumer.id, {
              priority: update.preferences.priority,
              paused: update.preferences.paused,
            }),
          );
          lastPausedRef.current.set(
            update.producerId,
            priorityOnlyResponse.paused,
          );
          if (
            update.preferences.paused === true &&
            priorityOnlyResponse.paused
          ) {
            refs.adaptivelyPausedConsumerProducerIdsRef.current.add(
              update.producerId,
            );
          } else {
            refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(
              update.producerId,
            );
          }
          preferenceDebugRef.current.set(update.producerId, {
            ...update.debugEntryBase,
            status: "fallback",
            paused: priorityOnlyResponse.paused,
            producerPaused: priorityOnlyResponse.producerPaused,
            currentLayers: priorityOnlyResponse.currentLayers,
            error: null,
            appliedAt: Date.now(),
            unsupportedLayers: true,
          });
          writeDebugSnapshot(debugContext);
        },
      );
    };

    const handlePreferenceResponse = (
      update: PendingConsumerPreferenceUpdate,
      response: SetConsumerPreferencesBatchItemResponse,
    ) => {
      if (!isUpdateStillLive(update)) {
        inFlightProducerIdsRef.current.delete(update.producerId);
        return;
      }

      if ("error" in response) {
        if (isConsumerGenerationDisplacedError(response.error)) {
          markDisplacedGenerationForRetry(update, response.error);
          return;
        }
        if (isConsumerControlRateLimitError(response.error)) {
          inFlightProducerIdsRef.current.delete(update.producerId);
          markDeferredForRetry(update, response.error);
          return;
        }

        markError(update, response.error);
        if (
          update.preferredLayers &&
          isUnsupportedLayerError(response.error)
        ) {
          unsupportedLayerPreferencesRef.current.set(update.producerId, {
            consumerId: update.consumer.id,
            signature: getLayerPreferenceSignature(update.preferredLayers),
            retryAt: Date.now() + UNSUPPORTED_LAYER_RETRY_AFTER_MS,
          });
          if (update.preferences.paused === true) {
            refs.adaptivelyPausedConsumerProducerIdsRef.current.add(
              update.producerId,
            );
          }
          sendPriorityOnlyFallback(update);
          return;
        }
        inFlightProducerIdsRef.current.delete(update.producerId);
        return;
      }

      inFlightProducerIdsRef.current.delete(update.producerId);
      lastAppliedRef.current.set(update.producerId, update.signature);
      if (update.preferredLayers) {
        lastLayersRef.current.set(update.producerId, update.preferredLayers);
      }
      lastPausedRef.current.set(update.producerId, response.paused);
      if (update.preferences.paused === true && response.paused) {
        refs.adaptivelyPausedConsumerProducerIdsRef.current.add(
          update.producerId,
        );
      } else {
        refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(
          update.producerId,
        );
      }
      preferenceDebugRef.current.set(update.producerId, {
        ...update.debugEntryBase,
        status: "applied",
        paused: response.paused,
        producerPaused: response.producerPaused,
        preferredLayers: response.preferredLayers,
        currentLayers: response.currentLayers,
        error: null,
        appliedAt: Date.now(),
      });
      writeDebugSnapshot(debugContext);
    };

    const emitSinglePreferenceUpdate = (
      update: PendingConsumerPreferenceUpdate,
    ) => {
      if (!isUpdateStillLive(update)) {
        inFlightProducerIdsRef.current.delete(update.producerId);
        return;
      }

      let settled = false;
      const ackTimeoutId = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        scheduledPreferenceTimeoutsRef.current.delete(ackTimeoutId);
        inFlightProducerIdsRef.current.delete(update.producerId);
        if (!isUpdateStillLive(update)) return;
        markDeferredForRetry(update, "setConsumerPreferences ack timeout");
      }, CONSUMER_PREFERENCE_ACK_TIMEOUT_MS);
      scheduledPreferenceTimeoutsRef.current.add(ackTimeoutId);

      socket.emit(
        "setConsumerPreferences",
        buildPreferencePayload(update),
        (response: SetConsumerPreferencesResponse) => {
          if (settled) return;
          settled = true;
          scheduledPreferenceTimeoutsRef.current.delete(ackTimeoutId);
          window.clearTimeout(ackTimeoutId);
          handlePreferenceResponse(update, response);
        },
      );
    };

    const emitBatchPreferenceUpdates = (
      batchUpdates: PendingConsumerPreferenceUpdate[],
    ) => {
      const liveUpdates = batchUpdates.filter((update) => {
        if (isUpdateStillLive(update)) return true;
        inFlightProducerIdsRef.current.delete(update.producerId);
        return false;
      });
      if (liveUpdates.length === 0) return;

      let settled = false;
      const ackTimeoutId = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        scheduledPreferenceTimeoutsRef.current.delete(ackTimeoutId);
        for (const update of liveUpdates) {
          emitSinglePreferenceUpdate(update);
        }
      }, CONSUMER_PREFERENCE_ACK_TIMEOUT_MS);
      scheduledPreferenceTimeoutsRef.current.add(ackTimeoutId);

      socket.emit(
        "setConsumerPreferencesBatch",
        {
          updates: liveUpdates.map(buildPreferencePayload),
        },
        (response: SetConsumerPreferencesBatchResponse) => {
          if (settled) return;
          settled = true;
          scheduledPreferenceTimeoutsRef.current.delete(ackTimeoutId);
          window.clearTimeout(ackTimeoutId);
          if ("error" in response) {
            if (isConsumerGenerationDisplacedError(response.error)) {
              for (const update of liveUpdates) {
                markDisplacedGenerationForRetry(update, response.error);
              }
              return;
            }
            if (isConsumerControlRateLimitError(response.error)) {
              for (const update of liveUpdates) {
                inFlightProducerIdsRef.current.delete(update.producerId);
                markDeferredForRetry(update, response.error);
              }
              return;
            }

            for (const update of liveUpdates) {
              emitSinglePreferenceUpdate(update);
            }
            return;
          }

          liveUpdates.forEach((update, index) => {
            handlePreferenceResponse(
              update,
              response.results[index] ?? {
                error: "Missing consumer preference batch result",
                consumerId: update.consumer.id,
              },
            );
          });
        },
      );
    };

    for (const update of updatesToSend) {
      markOptimisticPauseState(update);
      if (
        update.debugEntryBase.kind === "video" &&
        update.debugEntryBase.type === "webcam" &&
        update.debugEntryBase.requestKeyFrame &&
        update.preferredLayers
      ) {
        const targetSignature = String(
          update.preferredLayers.spatialLayer,
        );
        const previous = layerConvergenceKeyFrameAttemptsRef.current.get(
          update.producerId,
        );
        layerConvergenceKeyFrameAttemptsRef.current.set(update.producerId, {
          consumerId: update.consumer.id,
          targetSignature,
          requestedAtMs: now,
          attemptCount:
            previous?.consumerId === update.consumer.id &&
            previous.targetSignature === targetSignature
              ? previous.attemptCount + 1
              : 1,
        });
      }
    }

    if (screenShareVideoActive && updatesToSend.length > 1) {
      emitBatchPreferenceUpdates(updatesToSend);
    } else {
      updatesToSend.forEach((update, index) => {
        const timeoutId = window.setTimeout(() => {
          scheduledPreferenceTimeoutsRef.current.delete(timeoutId);
          emitSinglePreferenceUpdate(update);
        }, index * emitSpacingMs);
        scheduledPreferenceTimeoutsRef.current.add(timeoutId);
      });
    }
    writeDebugSnapshot(debugContext);
  }, [
    activeSpeakerId,
    availableIncomingBitrateBps,
    browserAllowsFairWebcamLayerRecovery,
    clearScheduledPreferenceWork,
    connectionQuality,
    dataSaverMode,
    emergencyMode,
    receiveContinuityRisk,
    enabled,
    isDocumentVisible,
    refs.adaptivelyPausedConsumerProducerIdsRef,
    refs.consumerTelemetryRef,
    refs.consumersRef,
    refs.producerMapRef,
    refs.socketRef,
    reconcileVideoJitterBufferTarget,
    resetLiveVideoJitterBufferTargets,
    writeDebugSnapshot,
  ]);

  useEffect(() => {
    const lifecycleRef = refs.adaptiveVideoReceiverLifecycleRef;
    const previousHandler = lifecycleRef.current;
    lifecycleRef.current = handleAdaptiveVideoReceiverLifecycle;

    return () => {
      if (lifecycleRef.current === handleAdaptiveVideoReceiverLifecycle) {
        lifecycleRef.current = previousHandler;
      }
    };
  }, [
    handleAdaptiveVideoReceiverLifecycle,
    refs.adaptiveVideoReceiverLifecycleRef,
  ]);

  useEffect(
    () => () => {
      resetLiveVideoJitterBufferTargets();
    },
    [resetLiveVideoJitterBufferTargets],
  );

  useEffect(() => {
    if (!enabled) {
      clearScheduledPreferenceWork();
      resetLiveVideoJitterBufferTargets();
      lastAppliedRef.current.clear();
      lastLayersRef.current.clear();
      layerConvergenceKeyFrameAttemptsRef.current.clear();
      lastPausedRef.current.clear();
      unsupportedLayerPreferencesRef.current.clear();
      preferenceDebugRef.current.clear();
      consumerScoreAdaptationRef.current.clear();
      receiveRecoveryProbeStateRef.current.clear();
      lastRoomTilingEventSignatureRef.current = null;
      refs.adaptivelyPausedConsumerProducerIdsRef.current.clear();
      writeDebugSnapshot({
        socketConnected: false,
        layoutHintsAvailable: false,
        webcamVideoCount: 0,
      });
      return;
    }

    applyPreferences();
    lastRoomTilingEventSignatureRef.current =
      readRoomTilingCurrentSignature();
    const handleRoomTilingChange = (event: Event) => {
      const signature = readRoomTilingEventSignature(event);
      if (
        signature &&
        lastRoomTilingEventSignatureRef.current === signature
      ) {
        return;
      }
      lastRoomTilingEventSignatureRef.current = signature;
      applyPreferences();
    };
    window.addEventListener("conclave:meet-room-tiling", handleRoomTilingChange);
    const interval = window.setInterval(applyPreferences, APPLY_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(
        "conclave:meet-room-tiling",
        handleRoomTilingChange,
      );
      clearScheduledPreferenceWork();
    };
  }, [
    applyPreferences,
    clearScheduledPreferenceWork,
    enabled,
    refs.adaptivelyPausedConsumerProducerIdsRef,
    resetLiveVideoJitterBufferTargets,
    writeDebugSnapshot,
  ]);
}
