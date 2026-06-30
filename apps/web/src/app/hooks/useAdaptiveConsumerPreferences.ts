"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Consumer, ProducerMapEntry } from "../lib/types";
import type { MeetRefs } from "./useMeetRefs";
import type { ConnectionQuality } from "./useConnectionQuality";

type ConsumerLayerPreference = {
  spatialLayer: number;
  temporalLayer?: number;
};

type LayerBounds = {
  maxSpatialLayer: number;
  maxTemporalLayer: number;
};

type DesiredConsumerPreferences = {
  preferredLayers?: ConsumerLayerPreference;
  priority: number;
  paused?: boolean;
};

type ConsumerScoreQuality = "good" | "fair" | "poor" | "unknown";

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

interface UseAdaptiveConsumerPreferencesOptions {
  refs: Pick<
    MeetRefs,
    | "socketRef"
    | "consumersRef"
    | "producerMapRef"
    | "consumerTelemetryRef"
    | "adaptivelyPausedConsumerProducerIdsRef"
  >;
  enabled: boolean;
  connectionQuality: ConnectionQuality;
  emergencyMode: boolean;
  availableIncomingBitrateBps?: number | null;
  activeSpeakerId: string | null;
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
const CONSUMER_PREFERENCE_EMIT_SPACING_MS = 75;
const RATE_LIMIT_RETRY_DELAY_MS = 1000;
const CONSUMER_PREFERENCE_ACK_TIMEOUT_MS = 3000;
const AUDIO_CONSUMER_PRIORITY = 255;
const CONSUMER_SCORE_STALE_AFTER_MS = 15000;
const UNSUPPORTED_LAYER_RETRY_AFTER_MS = 30000;
const SCREEN_SHARE_RECEIVE_FAIR_BPS = 1500000;
const SCREEN_SHARE_RECEIVE_POOR_BPS = 550000;
const SCREEN_SHARE_RECEIVE_EMERGENCY_BPS = 300000;

type LayoutRole = {
  primary: boolean;
  focus: boolean;
  visible: boolean;
  hidden: boolean;
  warm: boolean;
  rank: number | null;
};

type RoomTilingHints = {
  primaryIds: Set<string>;
  focusIds: Set<string>;
  visibleRemoteIds: Set<string>;
  hiddenIds: Set<string>;
  warmIds: Set<string>;
  orderedRemoteRanks: Map<string, number>;
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
  emergencyKeepVideo: boolean | null;
  preferredLayers?: ConsumerLayerPreference;
  currentLayers?: ConsumerLayerPreference;
  consumerScore: number | null;
  consumerScoreQuality: ConsumerScoreQuality;
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

const readRoomTilingHints = (): RoomTilingHints | null => {
  if (typeof window === "undefined") return null;

  const debugWindow = window as RoomTilingDebugWindow;
  const snapshot =
    debugWindow.__conclaveGetMeetRoomTilingDebug?.() ??
    debugWindow.__conclaveMeetRoomTilingDebug;
  const current = snapshot?.current;
  if (!isRecord(current)) return null;

  return {
    primaryIds: new Set(readStringArray(current, "primaryIds")),
    focusIds: new Set(readStringArray(current, "focusIds")),
    visibleRemoteIds: new Set(readStringArray(current, "visibleRemoteIds")),
    hiddenIds: new Set(readStringArray(current, "hiddenIds")),
    warmIds: new Set(readStringArray(current, "warmIds")),
    orderedRemoteRanks: new Map(
      readStringArray(current, "orderedRemoteIds").map((id, index) => [
        id,
        index,
      ]),
    ),
  };
};

const getLayoutRole = (
  hints: RoomTilingHints | null,
  userId: string,
): LayoutRole | null => {
  if (!hints) return null;
  return {
    primary: hints.primaryIds.has(userId),
    focus: hints.focusIds.has(userId),
    visible: hints.visibleRemoteIds.has(userId),
    hidden: hints.hiddenIds.has(userId),
    warm: hints.warmIds.has(userId),
    rank: hints.orderedRemoteRanks.get(userId) ?? null,
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
    return { maxSpatialLayer: 2, maxTemporalLayer: 2 };
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

const parseConsumerScore = (score: unknown): number | null => {
  if (!isRecord(score)) return null;
  const value = score.score;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const classifyConsumerScoreQuality = (
  score: number | null,
): ConsumerScoreQuality => {
  if (score === null) return "unknown";
  if (score <= 3) return "poor";
  if (score <= 6) return "fair";
  return "good";
};

const getConsumerScoreQualityHint = (
  scoreQuality: ConsumerScoreQuality,
): ConnectionQuality => (scoreQuality === "unknown" ? "unknown" : scoreQuality);

const getScreenShareReceiveQualityForAvailableBitrate = (
  availableIncomingBitrateBps: number | null | undefined,
): ConnectionQuality => {
  if (
    typeof availableIncomingBitrateBps !== "number" ||
    !Number.isFinite(availableIncomingBitrateBps) ||
    availableIncomingBitrateBps <= 0
  ) {
    return "unknown";
  }
  if (availableIncomingBitrateBps <= SCREEN_SHARE_RECEIVE_POOR_BPS) {
    return "poor";
  }
  if (availableIncomingBitrateBps <= SCREEN_SHARE_RECEIVE_FAIR_BPS) {
    return "fair";
  }
  return "good";
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

const getDesiredPreferences = (
  info: ProducerMapEntry,
  bounds: LayerBounds | null,
  options: {
    quality: ConnectionQuality;
    activeSpeakerId: string | null;
    webcamVideoCount: number;
    fallbackRank: number | null;
    layout: LayoutRole | null;
    emergencyMode: boolean;
    emergencyKeepVideo: boolean;
    screenShareVideoActive: boolean;
    availableIncomingBitrateBps: number | null;
    consumerScoreQuality: ConsumerScoreQuality;
  },
): DesiredConsumerPreferences | null => {
  if (info.kind === "audio") {
    return {
      priority: AUDIO_CONSUMER_PRIORITY,
    };
  }

  if (info.kind !== "video") return null;

  const effectiveQuality = worstQuality(
    options.quality,
    options.quality === "good" || options.quality === "fair"
      ? "unknown"
      : getConsumerScoreQualityHint(options.consumerScoreQuality),
  );
  const quality = effectiveQuality === "unknown" ? "good" : effectiveQuality;

  if (info.type === "screen") {
    const screenShareQuality = worstQuality(
      worstQuality(
        quality,
        getScreenShareReceiveQualityForAvailableBitrate(
          options.availableIncomingBitrateBps,
        ),
      ),
      getConsumerScoreQualityHint(options.consumerScoreQuality),
    );
    const screenShareEmergency =
      options.emergencyMode ||
      isScreenShareReceiveEmergencyBitrate(options.availableIncomingBitrateBps);
    return {
      preferredLayers: bounds
        ? buildLayerPreference(
            0,
            screenShareEmergency
              ? 0
              : screenShareQuality === "poor"
                ? 1
                : bounds.maxTemporalLayer,
            bounds,
          )
        : undefined,
      priority: 240,
      paused: false,
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

  if (options.emergencyMode) {
    if (!options.emergencyKeepVideo) {
      return {
        preferredLayers: bounds ? buildLayerPreference(0, 0, bounds) : undefined,
        priority: 8,
        paused: false,
      };
    }

    return {
      preferredLayers: bounds ? buildLayerPreference(0, 0, bounds) : undefined,
      priority: isFocus ? 145 : 90,
      paused: false,
    };
  }

  if (options.screenShareVideoActive && !isFocus) {
    return {
      preferredLayers: bounds
        ? buildLayerPreference(
            0,
            quality === "poor" ? 0 : isVisible ? 1 : 0,
            bounds,
          )
        : undefined,
      priority: isVisible ? (quality === "poor" ? 45 : 65) : isWarm ? 28 : 20,
      paused: false,
    };
  }

  if (isHidden && !isWarm && !isFocus) {
    return {
      preferredLayers: bounds ? buildLayerPreference(0, 0, bounds) : undefined,
      priority: quality === "poor" ? 10 : 25,
      paused: false,
    };
  }

  if (!isVisible && isWarm && !isFocus) {
    return {
      preferredLayers: bounds
        ? buildLayerPreference(0, quality === "poor" ? 0 : 1, bounds)
        : undefined,
      priority: quality === "poor" ? 35 : 55,
      paused: false,
    };
  }

  const keepFull =
    quality === "good" &&
    (isFocus ||
      (!options.screenShareVideoActive &&
        (isVisible ||
          options.webcamVideoCount <= MAX_WEBCAMS_TO_KEEP_FULL_ON_GOOD_LINKS)));

  if (quality === "poor") {
    return {
      preferredLayers: bounds
        ? buildLayerPreference(0, isFocus ? 1 : 0, bounds)
        : undefined,
      priority: isFocus ? 155 : isVisible ? 70 : 35,
      paused: false,
    };
  }

  if (quality === "fair") {
    return {
      preferredLayers: bounds
        ? buildLayerPreference(
            isFocus ? 1 : 0,
            isVisible || isFocus ? bounds.maxTemporalLayer : 1,
            bounds,
          )
        : undefined,
      priority: isFocus ? 175 : isVisible ? 90 : 50,
      paused: false,
    };
  }

  return {
    preferredLayers: bounds
      ? keepFull
        ? buildLayerPreference(
            bounds.maxSpatialLayer,
            bounds.maxTemporalLayer,
            bounds,
          )
        : buildLayerPreference(
            isVisible ? 1 : 0,
            isVisible ? bounds.maxTemporalLayer : 0,
            bounds,
          )
      : undefined,
    priority: keepFull ? 175 : isVisible ? 95 : 45,
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
  availableIncomingBitrateBps = null,
  activeSpeakerId,
  debugStateRef,
  onVideoAdaptivePauseStateChange,
}: UseAdaptiveConsumerPreferencesOptions) {
  const lastAppliedRef = useRef<Map<string, string>>(new Map());
  const lastLayersRef = useRef<Map<string, ConsumerLayerPreference>>(new Map());
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
  const lastPublishedAdaptiveVideoPauseRef = useRef<Map<string, string>>(
    new Map(),
  );
  const lastDebugContextRef = useRef<ConsumerPreferenceDebugContext>({
    socketConnected: false,
    layoutHintsAvailable: false,
    webcamVideoCount: 0,
  });

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
      publishAdaptiveVideoPauseChanges,
      refs.adaptivelyPausedConsumerProducerIdsRef,
    ],
  );

  const applyPreferences = useCallback(() => {
    const socket = refs.socketRef.current;
    if (!enabled || !socket?.connected) {
      clearScheduledPreferenceWork();
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

          const layout = getLayoutRole(layoutHints, info.userId);
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
    ]);
    for (const producerId of trackedProducerIds) {
      if (liveProducerIds.has(producerId)) continue;
      lastAppliedRef.current.delete(producerId);
      lastLayersRef.current.delete(producerId);
      lastPausedRef.current.delete(producerId);
      unsupportedLayerPreferencesRef.current.delete(producerId);
      inFlightProducerIdsRef.current.delete(producerId);
      preferenceDebugRef.current.delete(producerId);
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
        refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(producerId);
        return;
      }

      const bounds = inferLayerBounds(consumer, info);
      const layout = getLayoutRole(layoutHints, info.userId);
      const emergencyKeepVideo =
        emergencyMode &&
        info.kind === "video" &&
        info.type === "webcam" &&
        emergencyVideoKeepProducerIds.has(producerId);
      const consumerTelemetry =
        refs.consumerTelemetryRef.current.get(producerId);
      const consumerScore =
        consumerTelemetry &&
        now - consumerTelemetry.receivedAt <= CONSUMER_SCORE_STALE_AFTER_MS
          ? parseConsumerScore(consumerTelemetry.score)
          : null;
      const consumerScoreQuality =
        classifyConsumerScoreQuality(consumerScore);
      const desired = getDesiredPreferences(info, bounds, {
        quality: connectionQuality,
        activeSpeakerId,
        webcamVideoCount,
        fallbackRank: fallbackWebcamRanks.get(producerId) ?? null,
        layout,
        emergencyMode,
        emergencyKeepVideo,
        screenShareVideoActive,
        availableIncomingBitrateBps,
        consumerScoreQuality,
      });
      if (!desired) return;

      const previousLayers = lastLayersRef.current.get(producerId);
      const wasPaused = lastPausedRef.current.get(producerId) === true;
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
      const requestKeyFrame =
        preferences.paused === false &&
        Boolean(preferredLayers) &&
        (wasPaused ||
          (isScreenShareVideo
            ? !sameConsumerLayers(previousLayers, preferredLayers!)
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
        emergencyKeepVideo:
          emergencyMode && info.kind === "video" && info.type === "webcam"
            ? emergencyKeepVideo
            : null,
        consumerScore,
        consumerScoreQuality,
        bounds,
        layout,
        requestKeyFrame,
        unsupportedLayers: shouldSuppressPreferredLayers,
      };
      const signature = getPreferenceSignature(consumer.id, preferences);
      if (lastAppliedRef.current.get(producerId) === signature) {
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

    const updatesToSend = pendingUpdates.slice(
      0,
      MAX_CONSUMER_PREFERENCE_UPDATES_PER_CYCLE,
    );
    const deferredUpdates = pendingUpdates.slice(
      MAX_CONSUMER_PREFERENCE_UPDATES_PER_CYCLE,
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

    updatesToSend.forEach((update, index) => {
      const {
        producerId,
        consumer,
        preferences,
        preferredLayers,
        signature,
        debugEntryBase,
      } = update;

      const markDeferredForRetry = (error: string) => {
        preferenceDebugRef.current.set(producerId, {
          ...debugEntryBase,
          status: "deferred",
          paused: preferences.paused ?? null,
          producerPaused: null,
          error,
          appliedAt: Date.now(),
        });
        if (preferences.paused === true) {
          refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(
            producerId,
          );
        }
        writeDebugSnapshot(debugContext);
        scheduleRateLimitRetry();
      };

      if (preferences.paused === true) {
        refs.adaptivelyPausedConsumerProducerIdsRef.current.add(producerId);
      } else if (preferences.paused === false) {
        refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(producerId);
      }

      const emitPreferenceUpdate = () => {
        scheduledPreferenceTimeoutsRef.current.delete(timeoutId);

        const liveConsumer = refs.consumersRef.current.get(producerId);
        if (
          !enabled ||
          !socket.connected ||
          consumer.closed ||
          !liveConsumer ||
          liveConsumer.id !== consumer.id
        ) {
          inFlightProducerIdsRef.current.delete(producerId);
          return;
        }

        let settled = false;
        const ackTimeoutId = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          scheduledPreferenceTimeoutsRef.current.delete(ackTimeoutId);
          inFlightProducerIdsRef.current.delete(producerId);
          markDeferredForRetry("setConsumerPreferences ack timeout");
        }, CONSUMER_PREFERENCE_ACK_TIMEOUT_MS);
        scheduledPreferenceTimeoutsRef.current.add(ackTimeoutId);

        socket.emit(
          "setConsumerPreferences",
          {
            consumerId: consumer.id,
            priority: preferences.priority,
            ...(preferredLayers ? { preferredLayers } : {}),
            ...(typeof preferences.paused === "boolean"
              ? { paused: preferences.paused }
              : {}),
            requestKeyFrame: debugEntryBase.requestKeyFrame,
          },
          (response: SetConsumerPreferencesResponse) => {
            if (settled) return;
            settled = true;
            scheduledPreferenceTimeoutsRef.current.delete(ackTimeoutId);
            window.clearTimeout(ackTimeoutId);
            if ("error" in response) {
              if (isConsumerControlRateLimitError(response.error)) {
                inFlightProducerIdsRef.current.delete(producerId);
                markDeferredForRetry(response.error);
                return;
              }

              preferenceDebugRef.current.set(producerId, {
                ...debugEntryBase,
                status: "error",
                paused: preferences.paused ?? null,
                producerPaused: null,
                error: response.error,
                appliedAt: Date.now(),
              });
              if (preferences.paused === true) {
                refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(
                  producerId,
                );
              }
              writeDebugSnapshot(debugContext);
              if (preferredLayers && isUnsupportedLayerError(response.error)) {
                unsupportedLayerPreferencesRef.current.set(producerId, {
                  consumerId: consumer.id,
                  signature: getLayerPreferenceSignature(preferredLayers),
                  retryAt: Date.now() + UNSUPPORTED_LAYER_RETRY_AFTER_MS,
                });
                if (preferences.paused === true) {
                  refs.adaptivelyPausedConsumerProducerIdsRef.current.add(
                    producerId,
                  );
                }
                let fallbackSettled = false;
                const fallbackAckTimeoutId = window.setTimeout(() => {
                  if (fallbackSettled) return;
                  fallbackSettled = true;
                  scheduledPreferenceTimeoutsRef.current.delete(
                    fallbackAckTimeoutId,
                  );
                  inFlightProducerIdsRef.current.delete(producerId);
                  markDeferredForRetry(
                    "setConsumerPreferences priority-only ack timeout",
                  );
                }, CONSUMER_PREFERENCE_ACK_TIMEOUT_MS);
                scheduledPreferenceTimeoutsRef.current.add(fallbackAckTimeoutId);
                socket.emit(
                  "setConsumerPreferences",
                  {
                    consumerId: consumer.id,
                    priority: preferences.priority,
                    ...(typeof preferences.paused === "boolean"
                      ? { paused: preferences.paused }
                      : {}),
                  },
                  (priorityOnlyResponse: SetConsumerPreferencesResponse) => {
                    if (fallbackSettled) return;
                    fallbackSettled = true;
                    scheduledPreferenceTimeoutsRef.current.delete(
                      fallbackAckTimeoutId,
                    );
                    window.clearTimeout(fallbackAckTimeoutId);
                    if ("error" in priorityOnlyResponse) {
                      inFlightProducerIdsRef.current.delete(producerId);
                      if (
                        isConsumerControlRateLimitError(
                          priorityOnlyResponse.error,
                        )
                      ) {
                        markDeferredForRetry(priorityOnlyResponse.error);
                        return;
                      }

                      if (preferences.paused === true) {
                        refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(
                          producerId,
                        );
                      }
                      preferenceDebugRef.current.set(producerId, {
                        ...debugEntryBase,
                        status: "error",
                        paused: preferences.paused ?? null,
                        producerPaused: null,
                        error: priorityOnlyResponse.error,
                        appliedAt: Date.now(),
                        unsupportedLayers: true,
                      });
                      writeDebugSnapshot(debugContext);
                      return;
                    }
                    inFlightProducerIdsRef.current.delete(producerId);
                    lastAppliedRef.current.set(
                      producerId,
                      getPreferenceSignature(consumer.id, {
                        priority: preferences.priority,
                        paused: preferences.paused,
                      }),
                    );
                    lastPausedRef.current.set(
                      producerId,
                      priorityOnlyResponse.paused,
                    );
                    if (
                      preferences.paused === true &&
                      priorityOnlyResponse.paused
                    ) {
                      refs.adaptivelyPausedConsumerProducerIdsRef.current.add(
                        producerId,
                      );
                    } else {
                      refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(
                        producerId,
                      );
                    }
                    preferenceDebugRef.current.set(producerId, {
                      ...debugEntryBase,
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
                return;
              }
              inFlightProducerIdsRef.current.delete(producerId);
              return;
            }

            inFlightProducerIdsRef.current.delete(producerId);
            lastAppliedRef.current.set(producerId, signature);
            if (preferredLayers) {
              lastLayersRef.current.set(producerId, preferredLayers);
            }
            lastPausedRef.current.set(producerId, response.paused);
            if (preferences.paused === true && response.paused) {
              refs.adaptivelyPausedConsumerProducerIdsRef.current.add(
                producerId,
              );
            } else {
              refs.adaptivelyPausedConsumerProducerIdsRef.current.delete(
                producerId,
              );
            }
            preferenceDebugRef.current.set(producerId, {
              ...debugEntryBase,
              status: "applied",
              paused: response.paused,
              producerPaused: response.producerPaused,
              preferredLayers: response.preferredLayers,
              currentLayers: response.currentLayers,
              error: null,
              appliedAt: Date.now(),
            });
            writeDebugSnapshot(debugContext);
          },
        );
      };

      const timeoutId = window.setTimeout(
        emitPreferenceUpdate,
        index * CONSUMER_PREFERENCE_EMIT_SPACING_MS,
      );
      scheduledPreferenceTimeoutsRef.current.add(timeoutId);
    });
    writeDebugSnapshot(debugContext);
  }, [
    activeSpeakerId,
    availableIncomingBitrateBps,
    clearScheduledPreferenceWork,
    connectionQuality,
    emergencyMode,
    enabled,
    refs.adaptivelyPausedConsumerProducerIdsRef,
    refs.consumerTelemetryRef,
    refs.consumersRef,
    refs.producerMapRef,
    refs.socketRef,
    writeDebugSnapshot,
  ]);

  useEffect(() => {
    if (!enabled) {
      clearScheduledPreferenceWork();
      lastAppliedRef.current.clear();
      lastLayersRef.current.clear();
      lastPausedRef.current.clear();
      unsupportedLayerPreferencesRef.current.clear();
      preferenceDebugRef.current.clear();
      refs.adaptivelyPausedConsumerProducerIdsRef.current.clear();
      writeDebugSnapshot({
        socketConnected: false,
        layoutHintsAvailable: false,
        webcamVideoCount: 0,
      });
      return;
    }

    applyPreferences();
    window.addEventListener("conclave:meet-room-tiling", applyPreferences);
    const interval = window.setInterval(applyPreferences, APPLY_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("conclave:meet-room-tiling", applyPreferences);
      clearScheduledPreferenceWork();
    };
  }, [
    applyPreferences,
    clearScheduledPreferenceWork,
    enabled,
    refs.adaptivelyPausedConsumerProducerIdsRef,
    writeDebugSnapshot,
  ]);
}
