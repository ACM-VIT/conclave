"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Device } from "mediasoup-client";
import {
  BACKGROUND_TRANSPORT_DISCONNECT_GRACE_MS,
  MAX_RECONNECT_ATTEMPTS,
  MEETS_ICE_SERVERS,
  MEETS_TURN_ICE_SERVERS,
  RECONNECT_DELAY_MS,
  SOCKET_TIMEOUT_MS,
  SOCKET_CONNECT_TIMEOUT_MS,
  TRANSPORT_DISCONNECT_GRACE_MS,
  PRODUCER_SYNC_INTERVAL_MS,
  buildMicrophoneOpusCodecOptions,
  buildScreenShareAudioOpusCodecOptions,
} from "../lib/constants";
import type {
  AdminNoticeNotification,
  ChatHistorySnapshot,
  ChatMessage,
  ConnectionState,
  Consumer,
  ConsumeResponse,
  HandRaisedNotification,
  HandRaisedSnapshot,
  JoinMode,
  JoinRoomErrorResponse,
  JoinRoomResponse,
  MeetError,
  Producer,
  MeetingConfigSnapshot,
  MeetingUpdateRequest,
  ParticipantConnectionStatus,
  ProducerInfo,
  ProducerType,
  ReconnectRecoveryStatus,
  ReactionNotification,
  ReactionPayload,
  DtlsParameters,
  RtpParameters,
  TransportResponse,
  RestartIceResponse,
  Transport,
  VideoQuality,
  WebinarConfigSnapshot,
  WebinarFeedChangedNotification,
  WebinarLinkResponse,
  ServerRestartNotification,
  WebinarUpdateRequest,
} from "../lib/types";
import type { ParticipantAction } from "../lib/participant-reducer";
import { createMeetError, isSystemUserId, normalizeDisplayName } from "../lib/utils";
import { normalizeChatMessage } from "../lib/chat-commands";
import { telemetry } from "../lib/telemetry";
import {
  applyScreenShareTrackNetworkProfile,
  buildScreenShareEncodingForNetworkProfile,
  getPreferredScreenShareCodec,
  getPreferredWebcamCodec,
  produceWebcamTrack,
  type WebcamProducerNetworkProfile,
} from "../lib/webcam-codec";
import { getBrowserNetworkSnapshot } from "../lib/network-information";
import type {
  ConsumerTelemetrySnapshot,
  MeetRefs,
} from "./useMeetRefs";
import type {
  ConnectionQuality,
  ConnectionQualityStats,
} from "./useConnectionQuality";

type ConsumerTelemetryPayload = Omit<
  ConsumerTelemetrySnapshot,
  "receivedAt"
>;

type ConsumeProducerOptions = {
  replaceExisting?: boolean;
};

type JoinInfo = {
  token: string;
  sfuUrl: string;
  iceServers?: RTCIceServer[];
};

const MAX_JOIN_ROOM_REDIRECTS = 1;
const DEFAULT_SERVER_RESTART_NOTICE =
  "Meeting server is restarting. You will be reconnected automatically.";
const ADMIN_NOTICE_DURATION_MS = 60000;
const VIDEO_STALL_KEYFRAME_REQUEST_DELAY_MS = 2500;
const STALE_CONSUMER_RECOVERY_DELAY_MS = 9000;
const RESTART_ICE_ACK_TIMEOUT_MS = 5000;
const PARTICIPANT_RECONNECTING_STATUS_FALLBACK_MS = 30000;
const PARTICIPANT_RECONNECTING_STATUS_BUFFER_MS = 5000;
const PARTICIPANT_RECONNECTED_STATUS_MS = 4500;
const PRODUCER_CLOSE_REPLACEMENT_GRACE_MS = 1500;
const STALE_REPLACEMENT_CLEANUP_DELAY_MS = 5000;
const SCREEN_SHARE_STALE_REPLACEMENT_CLEANUP_DELAY_MS = 1500;
const TURN_URL_PATTERN = /^turns?:/i;
const TRANSPORT_CC_FEEDBACK_TYPE = "transport-cc";

const getConnectionStatsNetworkProfile = (
  stats: ConnectionQualityStats | null | undefined,
  direction: "publish" | "receive",
): WebcamProducerNetworkProfile => {
  const snapshot = stats?.browserNetwork ?? getBrowserNetworkSnapshot();
  const statsQuality =
    direction === "publish" ? stats?.publishQuality : stats?.receiveQuality;
  const statsEmergency =
    direction === "publish"
      ? stats?.publishEmergencyMode
      : stats?.receiveEmergencyMode;
  const quality: ConnectionQuality =
    statsQuality && statsQuality !== "unknown"
      ? statsQuality
      : ((snapshot.quality === "unknown"
          ? snapshot.startupQuality
          : snapshot.quality) as ConnectionQuality);

  if (snapshot.emergency || (statsEmergency === true && quality !== "good")) {
    return "emergency";
  }
  if (quality === "poor") return "poor";
  if (quality === "fair") return "fair";
  return "good";
};

const getTransportDisconnectGraceMs = (): number => {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") {
    return BACKGROUND_TRANSPORT_DISCONNECT_GRACE_MS;
  }
  return TRANSPORT_DISCONNECT_GRACE_MS;
};

const shouldDeferTransportRecoveryUntilVisible = (): boolean =>
  typeof document !== "undefined" && document.visibilityState !== "visible";

const getRawReconnectErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
};

const describeReconnectFailure = (error: unknown): string => {
  const message = getRawReconnectErrorMessage(error).trim();
  if (!message) {
    return "The meeting server did not return an error reason.";
  }
  if (/timeout/i.test(message)) {
    return "The meeting server did not respond before the timeout.";
  }
  if (/permission|notallowed/i.test(message)) {
    return "Browser permission is blocking camera or microphone access.";
  }
  if (/missing live local media/i.test(message)) {
    return "Local media was not ready yet. We will rejoin the room first and retry your devices.";
  }
  if (/missing room id/i.test(message)) {
    return "The meeting room could not be found for reconnect.";
  }
  if (/xhr poll|websocket|transport|socket|network|fetch/i.test(message)) {
    return "The browser could not reach the meeting server.";
  }
  return message;
};

const getResponseStatusFromError = (error: unknown): number | null => {
  if (!error || typeof error !== "object") return null;
  const status = (error as { responseStatus?: unknown; status?: unknown })
    .responseStatus;
  if (typeof status === "number") return status;
  const fallbackStatus = (error as { status?: unknown }).status;
  return typeof fallbackStatus === "number" ? fallbackStatus : null;
};

const isRecoverableJoinInfoStatus = (status: number): boolean =>
  status >= 500 && status < 600;

const isRecoverableReconnectFailure = (error: unknown): boolean => {
  const responseStatus = getResponseStatusFromError(error);
  if (responseStatus !== null) {
    return isRecoverableJoinInfoStatus(responseStatus);
  }
  const message = getRawReconnectErrorMessage(error).trim();
  if (!message) return true;
  return /timeout|xhr poll|websocket|transport|socket|network|fetch|load failed|connection/i.test(
    message,
  );
};

const buildReconnectRecoveryStatus = (
  phase: ReconnectRecoveryStatus["phase"],
  attempt: number,
  message: string,
  lastError: string | null = null,
  retryAt: number | null = null,
): ReconnectRecoveryStatus => ({
  phase,
  attempt,
  maxAttempts: MAX_RECONNECT_ATTEMPTS,
  message,
  lastError,
  retryAt,
  updatedAt: Date.now(),
});

type InitialConsumerPreferences = {
  preferredLayers?: {
    spatialLayer: number;
    temporalLayer?: number;
  };
  priority?: number;
};

const getInitialConsumerPreferences = (
  producerInfo: ProducerInfo,
  options: {
    preferHighWebcamLayer?: boolean;
    networkProfile?: WebcamProducerNetworkProfile;
  } = {},
): InitialConsumerPreferences => {
  if (producerInfo.kind === "audio") {
    return { priority: 255 };
  }

  if (producerInfo.kind !== "video") {
    return {};
  }

  const networkProfile = options.networkProfile ?? "good";

  if (producerInfo.type === "screen") {
    return {
      preferredLayers: {
        spatialLayer: 0,
        temporalLayer:
          networkProfile === "emergency" ? 0 : networkProfile === "poor" ? 1 : 2,
      },
      priority: 240,
    };
  }

  if (producerInfo.type !== "webcam") {
    return {};
  }

  if (options.preferHighWebcamLayer) {
    if (networkProfile === "good") {
      return {
        preferredLayers: {
          spatialLayer: 2,
          temporalLayer: 2,
        },
        priority: 180,
      };
    }

    if (networkProfile === "fair") {
      return {
        preferredLayers: {
          spatialLayer: 1,
          temporalLayer: 2,
        },
        priority: 150,
      };
    }

    return {
      preferredLayers: {
        spatialLayer: 0,
        temporalLayer: networkProfile === "emergency" ? 0 : 1,
      },
      priority: networkProfile === "emergency" ? 145 : 120,
    };
  }

  if (networkProfile === "good") {
    return { priority: 100 };
  }

  return {
    preferredLayers: {
      spatialLayer: 0,
      temporalLayer:
        networkProfile === "emergency" || networkProfile === "poor" ? 0 : 1,
    },
    priority: networkProfile === "fair" ? 90 : 70,
  };
};

const normalizeReceiveRtpParametersForCongestionFeedback = (
  rtpParameters: RtpParameters,
): RtpParameters => {
  let changed = false;
  const codecs = rtpParameters.codecs.map((codec) => {
    if (codec.mimeType.toLowerCase() !== "audio/opus") return codec;

    const rtcpFeedback = codec.rtcpFeedback ?? [];
    if (
      rtcpFeedback.some(
        (feedback) => feedback.type === TRANSPORT_CC_FEEDBACK_TYPE,
      )
    ) {
      return codec;
    }

    changed = true;
    return {
      ...codec,
      rtcpFeedback: [
        ...rtcpFeedback,
        { type: TRANSPORT_CC_FEEDBACK_TYPE },
      ],
    };
  });

  if (!changed) return rtpParameters;

  // Chrome applies one congestion-control feedback mode to a bundled RTP
  // transport. Mediasoup's audio consumer params can omit Opus transport-cc
  // while video consumers include it, which makes Chrome ignore video TWCC.
  return {
    ...rtpParameters,
    codecs,
  };
};

const getUsableProducerTransport = (
  transport: Transport | null | undefined,
): Transport | null => {
  if (!transport || transport.closed) return null;
  if (
    transport.connectionState === "closed" ||
    transport.connectionState === "failed"
  ) {
    return null;
  }
  return transport;
};

class JoinRoomRedirectError extends Error {
  readonly redirectUrl: string;
  readonly response: JoinRoomErrorResponse;

  constructor(response: JoinRoomErrorResponse, redirectUrl: string) {
    super(response.error || "Room is hosted by another SFU instance.");
    this.name = "JoinRoomRedirectError";
    this.redirectUrl = redirectUrl;
    this.response = response;
  }
}

const normalizeJoinRedirectUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
};

const getJoinRoomRedirectError = (
  response: JoinRoomErrorResponse,
): JoinRoomRedirectError | null => {
  const redirectUrl = normalizeJoinRedirectUrl(response.redirectUrl);
  return redirectUrl ? new JoinRoomRedirectError(response, redirectUrl) : null;
};

const buildIceServerWithUrls = (
  iceServer: RTCIceServer,
  urls: string[],
): RTCIceServer => ({
  ...iceServer,
  urls: urls.length === 1 ? urls[0] : urls,
});

const splitIceServersByType = (
  iceServers: RTCIceServer[] | null | undefined,
): { stunIceServers: RTCIceServer[]; turnIceServers: RTCIceServer[] } => {
  const stunIceServers: RTCIceServer[] = [];
  const turnIceServers: RTCIceServer[] = [];

  for (const iceServer of iceServers ?? []) {
    const urls = normalizeIceServerUrls(iceServer.urls);
    if (urls.length === 0) continue;

    const turnUrls = urls.filter((url) => TURN_URL_PATTERN.test(url));
    const stunUrls = urls.filter((url) => !TURN_URL_PATTERN.test(url));

    if (stunUrls.length > 0) {
      stunIceServers.push(buildIceServerWithUrls(iceServer, stunUrls));
    }
    if (turnUrls.length > 0) {
      turnIceServers.push(buildIceServerWithUrls(iceServer, turnUrls));
    }
  }

  return { stunIceServers, turnIceServers };
};

const normalizeIceServerUrls = (
  urls: RTCIceServer["urls"] | undefined,
): string[] => {
  if (!urls) return [];
  const normalizedUrls = (Array.isArray(urls) ? urls : [urls])
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set(normalizedUrls));
};

const mergeIceServers = (
  ...lists: Array<RTCIceServer[] | null | undefined>
): RTCIceServer[] | undefined => {
  const merged: RTCIceServer[] = [];
  const seen = new Set<string>();

  for (const list of lists) {
    if (!Array.isArray(list)) continue;

    for (const server of list) {
      const urls = normalizeIceServerUrls(server.urls);
      if (!urls.length) continue;

      const key = JSON.stringify({
        urls: [...urls].sort(),
        username: server.username?.trim() ?? "",
        credential:
          typeof server.credential === "string" ? server.credential : "",
      });

      if (seen.has(key)) continue;
      seen.add(key);

      merged.push({
        ...server,
        urls: urls.length === 1 ? urls[0] : urls,
      });
    }
  }

  return merged.length > 0 ? merged : undefined;
};

const getFirstLiveTrack = <T extends MediaStreamTrack>(
  tracks: T[],
): T | null => tracks.find((track) => track.readyState === "live") ?? null;

const summarizeTrackForLog = (track: MediaStreamTrack | null | undefined) => {
  if (!track) return null;
  let settings: MediaTrackSettings = {};
  try {
    settings = track.getSettings();
  } catch {
    settings = {};
  }
  return {
    id: track.id,
    kind: track.kind,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    settings,
  };
};

const summarizeStreamForLog = (stream: MediaStream | null | undefined) => {
  if (!stream) return null;
  return {
    id: stream.id,
    active: stream.active,
    audioTracks: stream.getAudioTracks().map(summarizeTrackForLog),
    videoTracks: stream.getVideoTracks().map(summarizeTrackForLog),
  };
};

const hasLiveTrackOfKind = (
  stream: MediaStream | null | undefined,
  kind: MediaStreamTrack["kind"],
) =>
  Boolean(
    stream?.getTracks().some((track) => {
      return track.kind === kind && track.readyState === "live";
    }),
  );

const streamNeedsMediaRefresh = (
  stream: MediaStream | null | undefined,
  options: { needsAudio: boolean; needsVideo: boolean },
) => {
  if (!stream) return options.needsAudio || options.needsVideo;
  if (options.needsAudio && !hasLiveTrackOfKind(stream, "audio")) return true;
  if (options.needsVideo && !hasLiveTrackOfKind(stream, "video")) return true;
  return false;
};

interface UseMeetSocketOptions {
  refs: MeetRefs;
  roomId: string;
  setRoomId: (roomId: string) => void;
  isAdmin: boolean;
  setIsAdmin: (value: boolean) => void;
  user?: { id?: string; email?: string | null; name?: string | null };
  userId: string;
  getJoinInfo: (
    roomId: string,
    sessionId: string,
    options?: {
      user?: { id?: string; email?: string | null; name?: string | null };
      isHost?: boolean;
      joinMode?: JoinMode;
    },
  ) => Promise<JoinInfo>;
  joinMode?: JoinMode;
  requestWebinarInviteCode?: () => Promise<string | null>;
  requestMeetingInviteCode?: () => Promise<string | null>;
  ghostEnabled: boolean;
  displayNameInput: string;
  localStream: MediaStream | null;
  setLocalStream: React.Dispatch<React.SetStateAction<MediaStream | null>>;
  getVideoPublishTrack?: (stream?: MediaStream | null) => MediaStreamTrack | null;
  onPreferredVideoPublishTrackRejected?: (
    track: MediaStreamTrack,
    reason: string,
  ) => void;
  dispatchParticipants: (action: ParticipantAction) => void;
  setDisplayNames: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  setPendingUsers: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  setConnectionState: (state: ConnectionState) => void;
  setMeetError: (error: MeetError | null) => void;
  setWaitingMessage: (message: string | null) => void;
  setHostUserId: (userId: string | null) => void;
  setHostUserIds: React.Dispatch<React.SetStateAction<string[]>>;
  setServerRestartNotice: (notice: string | null) => void;
  setAdminNotice: (notice: AdminNoticeNotification | null) => void;
  setWebinarConfig: React.Dispatch<
    React.SetStateAction<WebinarConfigSnapshot | null>
  >;
  setWebinarRole: (role: "attendee" | "participant" | "host" | null) => void;
  setWebinarSpeakerUserId: (userId: string | null) => void;
  isMuted: boolean;
  setIsMuted: (value: boolean) => void;
  isCameraOff: boolean;
  setIsCameraOff: (value: boolean) => void;
  setIsScreenSharing: (value: boolean) => void;
  setIsHandRaised: (value: boolean) => void;
  setIsRoomLocked: (value: boolean) => void;
  setIsNoGuests: (value: boolean) => void;
  setIsChatLocked: (value: boolean) => void;
  setMeetingRequiresInviteCode: (value: boolean) => void;
  isTtsDisabled: boolean;
  setIsTtsDisabled: (value: boolean) => void;
  setIsDmEnabled: (value: boolean) => void;
  setActiveScreenShareId: (value: string | null) => void;
  setNetworkManagedVideoQuality: (value: VideoQuality) => void;
  videoQualityRef: React.MutableRefObject<VideoQuality>;
  connectionQualityRef?: React.MutableRefObject<ConnectionQualityStats | null>;
  updateVideoQualityRef: React.MutableRefObject<
    (
      quality: VideoQuality,
      networkProfileOverride?: WebcamProducerNetworkProfile,
    ) => Promise<void>
  >;
  requestMediaPermissions: () => Promise<MediaStream | null>;
  requestAudioProducerRecovery: () => void;
  requestCameraProducerRecovery: () => void;
  stopLocalTrack: (track?: MediaStreamTrack | null) => void;
  handleLocalTrackEnded: (
    kind: "audio" | "video",
    track: MediaStreamTrack,
  ) => void;
  playNotificationSound: (
    type: "join" | "leave" | "waiting" | "handRaise"
  ) => void;
  primeAudioOutput: () => void;
  addReaction: (reaction: ReactionPayload) => void;
  clearReactions: () => void;
  chat: {
    setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    setChatOverlayMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    setUnreadCount: React.Dispatch<React.SetStateAction<number>>;
    isChatOpenRef: React.MutableRefObject<boolean>;
  };
  onTtsMessage?: (payload: {
    userId: string;
    displayName: string;
    text: string;
  }) => void;
  prewarm?: {
    Device: typeof import("mediasoup-client").Device | null;
    io: typeof import("socket.io-client").io | null;
    isReady: boolean;
    getCachedToken?: (roomId: string) => JoinInfo | null;
  };
  onSocketReady?: (socket: Socket | null) => void;
  bypassMediaPermissions?: boolean;
}

export function useMeetSocket({
  refs,
  roomId,
  setRoomId,
  isAdmin,
  setIsAdmin,
  user,
  userId,
  getJoinInfo,
  joinMode = "meeting",
  requestWebinarInviteCode,
  requestMeetingInviteCode,
  ghostEnabled,
  displayNameInput,
  localStream,
  setLocalStream,
  getVideoPublishTrack,
  onPreferredVideoPublishTrackRejected,
  dispatchParticipants,
  setDisplayNames,
  setPendingUsers,
  setConnectionState,
  setMeetError,
  setWaitingMessage,
  setHostUserId,
  setHostUserIds,
  setServerRestartNotice,
  setAdminNotice,
  setWebinarConfig,
  setWebinarRole,
  setWebinarSpeakerUserId,
  isMuted,
  setIsMuted,
  isCameraOff,
  setIsCameraOff,
  setIsScreenSharing,
  setIsHandRaised,
  setIsRoomLocked,
  setIsNoGuests,
  setIsChatLocked,
  setMeetingRequiresInviteCode,
  isTtsDisabled,
  setIsTtsDisabled,
  setIsDmEnabled,
  setActiveScreenShareId,
  setNetworkManagedVideoQuality,
  videoQualityRef,
  connectionQualityRef,
  updateVideoQualityRef,
  requestMediaPermissions,
  requestAudioProducerRecovery,
  requestCameraProducerRecovery,
  stopLocalTrack,
  handleLocalTrackEnded,
  playNotificationSound,
  primeAudioOutput,
  addReaction,
  clearReactions,
  chat,
  onTtsMessage,
  prewarm,
  onSocketReady,
  bypassMediaPermissions = false,
}: UseMeetSocketOptions) {
  const participantIdsRef = useRef<Set<string>>(new Set([userId]));
  const isMutedRef = useRef(isMuted);
  const isCameraOffRef = useRef(isCameraOff);
  const serverRoomIdRef = useRef<string | null>(null);
  const foregroundRecoveryTimeoutRef = useRef<number | null>(null);
  const runtimeStunIceServersRef = useRef<RTCIceServer[] | null>(null);
  const runtimeTurnIceServersRef = useRef<RTCIceServer[] | null>(null);
  const useTurnFallbackRef = useRef(false);
  const reconnectGenerationRef = useRef(0);
  const reconnectBackoffCancelRef = useRef<(() => void) | null>(null);
  const manualReconnectRetryRequestedRef = useRef(false);
  const reconnectPhaseRef =
    useRef<ReconnectRecoveryStatus["phase"] | "idle">("idle");
  const serverRestartNoticeRef = useRef<string | null>(null);
  const adminNoticeTimeoutRef = useRef<number | null>(null);
  const consumeRetryAttemptsRef = useRef<Map<string, number>>(new Map());
  const videoStallRecoveryTimeoutsRef = useRef<Map<string, number>>(new Map());
  const participantConnectionStatusTimeoutsRef = useRef<Map<string, number>>(
    new Map(),
  );
  const participantConnectionStatusExpiresAtRef = useRef<Map<string, number>>(
    new Map(),
  );
  const visibleParticipantReconnectingIdsRef = useRef<Set<string>>(new Set());
  const staleConsumerRecoveryTimeoutsRef = useRef<Map<string, number>>(
    new Map(),
  );
  const staleReplacementCleanupTimeoutsRef = useRef<Map<string, number>>(
    new Map(),
  );
  const mutedConsumerSinceRef = useRef<Map<string, number>>(new Map());
  const producerPausedStateRef = useRef<Map<string, boolean>>(new Map());
  // Per-video-consumer decode progress for the freeze watchdog: last
  // framesDecoded/bytesReceived sample + how many consecutive checks the decoder
  // has been stuck (frames flat while bytes still climb). See the freeze-watchdog
  // effect below — this catches a frozen decoder that `track.muted` never fires
  // for (RTP keeps flowing, the decoder is stuck on a stale reference frame).
  const videoFreezeStatsRef = useRef<
    Map<
      string,
      {
        frames: number;
        bytes: number;
        stalls: number;
        lastKeyFrameRequestAt: number;
      }
    >
  >(new Map());
  const consumerRecoveryInFlightRef = useRef<Set<string>>(new Set());
  const announcedRemoteProducersRef = useRef<Map<string, ProducerInfo>>(
    new Map(),
  );
  const pendingScreenProducerCloseIdsRef = useRef<Set<string>>(new Set());
  const consumeProducerRef = useRef<
    (producerInfo: ProducerInfo, options?: ConsumeProducerOptions) => Promise<void>
  >(async () => {});
  const recoverStaleConsumerRef = useRef<
    (producerInfo: ProducerInfo, reason: string) => Promise<void>
  >(async () => {});
  const producerTransportCreatePromiseRef = useRef<Promise<boolean> | null>(
    null,
  );
  const iceRestartPromiseRef = useRef<
    Record<"producer" | "consumer", Promise<boolean> | null>
  >({
    producer: null,
    consumer: null,
  });

  const {
    socketRef,
    deviceRef,
    producerTransportRef,
    consumerTransportRef,
    audioProducerRef,
    videoProducerRef,
    screenProducerRef,
    screenAudioProducerRef,
    screenShareStreamRef,
    intentionalLocalProducerCloseIdsRef,
    consumersRef,
    adaptivelyPausedConsumerProducerIdsRef,
    consumerTelemetryRef,
    producerMapRef,
    pendingProducersRef,
    leaveTimeoutsRef,
    reconnectAttemptsRef,
    reconnectInFlightRef,
    intentionalDisconnectRef,
    currentRoomIdRef,
    handleRedirectRef,
    handleReconnectRef,
    shouldAutoJoinRef,
    joinOptionsRef,
    localStreamRef,
    prejoinMediaIntentRef,
    sessionIdRef,
    producerTransportDisconnectTimeoutRef,
    consumerTransportDisconnectTimeoutRef,
    pendingProducerRetryTimeoutRef,
    iceRestartInFlightRef,
    producerSyncIntervalRef,
  } = refs;
  const [reconnectRecoveryStatus, setReconnectRecoveryStatus] =
    useState<ReconnectRecoveryStatus | null>(null);
  const updateReconnectRecoveryStatus = useCallback(
    (
      next:
        | ReconnectRecoveryStatus
        | null
        | ((
            current: ReconnectRecoveryStatus | null,
          ) => ReconnectRecoveryStatus | null),
    ) => {
      setReconnectRecoveryStatus((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        reconnectPhaseRef.current = resolved?.phase ?? "idle";
        return resolved;
      });
    },
    [],
  );
  const waitForReconnectBackoff = useCallback((delay: number) => {
    if (delay <= 0) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      let timeoutId: number | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        if (reconnectBackoffCancelRef.current === finish) {
          reconnectBackoffCancelRef.current = null;
        }
        resolve();
      };

      timeoutId = window.setTimeout(finish, delay);
      reconnectBackoffCancelRef.current = finish;
    });
  }, []);

  const getPublishNetworkProfile = useCallback(
    () =>
      getConnectionStatsNetworkProfile(connectionQualityRef?.current, "publish"),
    [connectionQualityRef],
  );

  const getReceiveNetworkProfile = useCallback(
    () =>
      getConnectionStatsNetworkProfile(connectionQualityRef?.current, "receive"),
    [connectionQualityRef],
  );

  useEffect(() => {
    participantIdsRef.current = new Set([userId]);
  }, [userId]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    isCameraOffRef.current = isCameraOff;
  }, [isCameraOff]);

  const shouldPlayJoinLeaveSound = useCallback(
    (type: "join" | "leave", targetUserId: string) => {
      if (isSystemUserId(targetUserId)) return false;
      const participantIds = participantIdsRef.current;
      if (type === "join") {
        if (participantIds.has(targetUserId)) return false;
        participantIds.add(targetUserId);
        return true;
      }
      if (!participantIds.has(targetUserId)) return false;
      participantIds.delete(targetUserId);
      return true;
    },
    [],
  );
  const isTtsDisabledRef = useRef(isTtsDisabled);
  useEffect(() => {
    isTtsDisabledRef.current = isTtsDisabled;
  }, [isTtsDisabled]);

  const enableTurnFallback = useCallback((reason: string): boolean => {
    if (useTurnFallbackRef.current) return false;

    const turnIceServers =
      runtimeTurnIceServersRef.current && runtimeTurnIceServersRef.current.length > 0
        ? runtimeTurnIceServersRef.current
        : MEETS_TURN_ICE_SERVERS;
    if (turnIceServers.length === 0) return false;

    useTurnFallbackRef.current = true;
    console.warn(`[Meets] ${reason}. Retrying with TURN fallback.`);
    telemetry.capture("meet_turn_relay_activated", {
      reason,
      roomId: currentRoomIdRef.current ?? undefined,
    });
    return true;
  }, [currentRoomIdRef]);

  const resolveIceServers = useCallback((): RTCIceServer[] | undefined => {
    const stunIceServers =
      runtimeStunIceServersRef.current && runtimeStunIceServersRef.current.length > 0
        ? runtimeStunIceServersRef.current
        : MEETS_ICE_SERVERS;

    const turnIceServers = useTurnFallbackRef.current
      ? runtimeTurnIceServersRef.current && runtimeTurnIceServersRef.current.length > 0
        ? runtimeTurnIceServersRef.current
        : MEETS_TURN_ICE_SERVERS
      : undefined;

    return mergeIceServers(stunIceServers, turnIceServers);
  }, []);

  const stopScreenShareCapture = useCallback(() => {
    const screenStream = screenShareStreamRef.current;
    if (!screenStream) return;
    for (const track of screenStream.getTracks()) {
      track.onended = null;
      stopLocalTrack(track);
    }
    screenShareStreamRef.current = null;
  }, [screenShareStreamRef, stopLocalTrack]);

  const emitCloseProducer = useCallback(
    (producerId: string) => {
      socketRef.current?.emit("closeProducer", { producerId }, () => {});
    },
    [socketRef],
  );

  const closeProducerOnServer = useCallback(
    async (producerId: string) => {
      const socket = socketRef.current;
      if (!socket?.connected) return;

      await new Promise<void>((resolve) => {
        let settled = false;
        const timeoutId = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve();
        }, 1500);

        socket.emit("closeProducer", { producerId }, () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeoutId);
          resolve();
        });
      });
    },
    [socketRef],
  );

  const flushPendingScreenProducerCloses = useCallback(async () => {
    const producerIds = Array.from(pendingScreenProducerCloseIdsRef.current);
    pendingScreenProducerCloseIdsRef.current.clear();
    if (producerIds.length === 0) return;
    await Promise.all(
      producerIds.map((producerId) => closeProducerOnServer(producerId)),
    );
  }, [closeProducerOnServer]);

  const republishScreenShare = useCallback(
    async (reason: string): Promise<boolean> => {
      const screenStream = screenShareStreamRef.current;
      const videoTrack = getFirstLiveTrack(screenStream?.getVideoTracks() ?? []);
      if (!screenStream || !videoTrack) {
        return false;
      }

      const transport = producerTransportRef.current;
      if (!transport || transport.closed) {
        throw new Error("Screen share transport unavailable");
      }

      await flushPendingScreenProducerCloses();

      if ("contentHint" in videoTrack) {
        videoTrack.contentHint = "detail";
      }

      const screenNetworkProfile = getPublishNetworkProfile();
      await applyScreenShareTrackNetworkProfile(videoTrack, screenNetworkProfile);
      const preferredScreenShareCodec = getPreferredScreenShareCodec(
        deviceRef.current,
      );
      const producer = await transport.produce({
        track: videoTrack,
        encodings: [
          buildScreenShareEncodingForNetworkProfile(screenNetworkProfile),
        ],
        stopTracks: false,
        ...(preferredScreenShareCodec ? { codec: preferredScreenShareCodec } : {}),
        appData: { type: "screen" as ProducerType },
      });

      screenProducerRef.current = producer;
      setIsScreenSharing(true);
      setActiveScreenShareId(producer.id);
      console.log(`[Meets] Republished screen share after ${reason}`);

      producer.on("transportclose", () => {
        if (screenProducerRef.current?.id === producer.id) {
          screenProducerRef.current = null;
        }
      });

      let screenVideoEnded = false;
      const closeScreenAudioProducer = (audioProducer: Producer) => {
        emitCloseProducer(audioProducer.id);
        try {
          audioProducer.close();
        } catch {}
        if (audioProducer.track) {
          audioProducer.track.onended = null;
        }
        if (screenAudioProducerRef.current?.id === audioProducer.id) {
          screenAudioProducerRef.current = null;
        }
      };
      const finishScreenShare = () => {
        if (screenVideoEnded) return;
        screenVideoEnded = true;
        emitCloseProducer(producer.id);
        try {
          producer.close();
        } catch {}
        if (screenProducerRef.current?.id === producer.id) {
          screenProducerRef.current = null;
        }
        const audioProducer = screenAudioProducerRef.current;
        if (audioProducer) {
          closeScreenAudioProducer(audioProducer);
        }
        stopScreenShareCapture();
        setIsScreenSharing(false);
        setActiveScreenShareId(null);
      };
      videoTrack.onended = finishScreenShare;

      const audioTrack = getFirstLiveTrack(screenStream.getAudioTracks());
      if (audioTrack) {
        try {
          const audioProducer = await transport.produce({
            track: audioTrack,
            codecOptions: buildScreenShareAudioOpusCodecOptions(
              screenNetworkProfile,
            ),
            stopTracks: false,
            appData: { type: "screen" as ProducerType },
          });
          if (
            screenVideoEnded ||
            videoTrack.readyState !== "live" ||
            screenShareStreamRef.current !== screenStream
          ) {
            if (!screenVideoEnded) {
              finishScreenShare();
            }
            closeScreenAudioProducer(audioProducer);
            return true;
          }
          screenAudioProducerRef.current = audioProducer;
          audioProducer.on("transportclose", () => {
            if (screenAudioProducerRef.current?.id === audioProducer.id) {
              screenAudioProducerRef.current = null;
            }
          });
          audioTrack.onended = () => {
            closeScreenAudioProducer(audioProducer);
          };
        } catch (audioErr) {
          console.warn("[Meets] Failed to restore screen share audio:", audioErr);
        }
      }

      return true;
    },
    [
      deviceRef,
      emitCloseProducer,
      flushPendingScreenProducerCloses,
      getPublishNetworkProfile,
      producerTransportRef,
      screenAudioProducerRef,
      screenProducerRef,
      screenShareStreamRef,
      setActiveScreenShareId,
      setIsScreenSharing,
      stopScreenShareCapture,
    ],
  );

  const cleanupRoomResources = useCallback(
    (options?: { resetRoomId?: boolean; preserveMeetingState?: boolean }) => {
      const resetRoomId = options?.resetRoomId !== false;
      const preserveMeetingState = options?.preserveMeetingState === true;
      console.log("[Meets] Cleaning up room resources...");
      if (producerSyncIntervalRef.current) {
        window.clearInterval(producerSyncIntervalRef.current);
        producerSyncIntervalRef.current = null;
      }
      if (pendingProducerRetryTimeoutRef.current) {
        window.clearTimeout(pendingProducerRetryTimeoutRef.current);
        pendingProducerRetryTimeoutRef.current = null;
      }

      consumersRef.current.forEach((consumer) => {
        try {
          consumer.close();
        } catch {}
      });
      consumersRef.current.clear();
      for (const timeoutId of videoStallRecoveryTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      videoStallRecoveryTimeoutsRef.current.clear();
      if (!preserveMeetingState) {
        const statusTimeouts =
          participantConnectionStatusTimeoutsRef.current.values();
        for (const timeoutId of statusTimeouts) {
          window.clearTimeout(timeoutId);
        }
        participantConnectionStatusTimeoutsRef.current.clear();
        participantConnectionStatusExpiresAtRef.current.clear();
        visibleParticipantReconnectingIdsRef.current.clear();
      }
      for (const timeoutId of staleConsumerRecoveryTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      staleConsumerRecoveryTimeoutsRef.current.clear();
      for (const timeoutId of staleReplacementCleanupTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      staleReplacementCleanupTimeoutsRef.current.clear();
      mutedConsumerSinceRef.current.clear();
      producerPausedStateRef.current.clear();
      videoFreezeStatsRef.current.clear();
      consumerRecoveryInFlightRef.current.clear();
      announcedRemoteProducersRef.current.clear();
      consumerTelemetryRef.current.clear();
      producerMapRef.current.clear();
      pendingProducersRef.current.clear();
      intentionalLocalProducerCloseIdsRef.current.clear();
      consumeRetryAttemptsRef.current.clear();
      leaveTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      leaveTimeoutsRef.current.clear();
      if (!preserveMeetingState) {
        clearReactions();
        setPendingUsers(new Map());
        setDisplayNames(new Map());
        setHostUserId(null);
        setHostUserIds([]);
        setWebinarRole(null);
        setWebinarSpeakerUserId(null);
        participantIdsRef.current = new Set([userId]);
        serverRoomIdRef.current = null;
      }

      const shouldPreserveScreenShare =
        preserveMeetingState &&
        Boolean(
          getFirstLiveTrack(
            screenShareStreamRef.current?.getVideoTracks() ?? [],
          ),
        );

      if (shouldPreserveScreenShare) {
        const screenProducerId = screenProducerRef.current?.id;
        const screenAudioProducerId = screenAudioProducerRef.current?.id;
        if (screenProducerId) {
          pendingScreenProducerCloseIdsRef.current.add(screenProducerId);
        }
        if (screenAudioProducerId) {
          pendingScreenProducerCloseIdsRef.current.add(screenAudioProducerId);
        }
      }

      try {
        audioProducerRef.current?.close();
      } catch {}
      try {
        videoProducerRef.current?.close();
      } catch {}
      try {
        screenProducerRef.current?.close();
      } catch {}
      try {
        screenAudioProducerRef.current?.close();
      } catch {}
      audioProducerRef.current = null;
      videoProducerRef.current = null;
      screenProducerRef.current = null;
      screenAudioProducerRef.current = null;

      try {
        producerTransportRef.current?.close();
      } catch {}
      try {
        consumerTransportRef.current?.close();
      } catch {}
      producerTransportRef.current = null;
      consumerTransportRef.current = null;
      producerTransportCreatePromiseRef.current = null;
      prejoinMediaIntentRef.current = null;
      if (producerTransportDisconnectTimeoutRef.current) {
        window.clearTimeout(producerTransportDisconnectTimeoutRef.current);
        producerTransportDisconnectTimeoutRef.current = null;
      }
      if (consumerTransportDisconnectTimeoutRef.current) {
        window.clearTimeout(consumerTransportDisconnectTimeoutRef.current);
        consumerTransportDisconnectTimeoutRef.current = null;
      }

      if (!preserveMeetingState) {
        dispatchParticipants({ type: "CLEAR_ALL" });
      }
      if (shouldPreserveScreenShare) {
        setIsScreenSharing(true);
      } else {
        stopScreenShareCapture();
        setIsScreenSharing(false);
      }
      if (!preserveMeetingState) {
        setActiveScreenShareId(null);
        setIsHandRaised(false);
        setIsTtsDisabled(false);
        setIsDmEnabled(true);
        setMeetingRequiresInviteCode(false);
        setWebinarConfig(null);
      }
      if (resetRoomId) {
        currentRoomIdRef.current = null;
        runtimeStunIceServersRef.current = null;
        runtimeTurnIceServersRef.current = null;
        useTurnFallbackRef.current = false;
      }
    },
    [
      audioProducerRef,
      consumerTransportRef,
      consumersRef,
      currentRoomIdRef,
      dispatchParticipants,
      leaveTimeoutsRef,
      pendingProducersRef,
      consumerTelemetryRef,
      producerMapRef,
      producerTransportRef,
      serverRoomIdRef,
      screenAudioProducerRef,
      screenProducerRef,
      screenShareStreamRef,
      intentionalLocalProducerCloseIdsRef,
      setActiveScreenShareId,
      setDisplayNames,
      setIsHandRaised,
      setIsScreenSharing,
      setPendingUsers,
      setHostUserId,
      setHostUserIds,
      setWebinarRole,
      setWebinarSpeakerUserId,
      setIsTtsDisabled,
      setIsDmEnabled,
      setMeetingRequiresInviteCode,
      setWebinarConfig,
      clearReactions,
      videoProducerRef,
      userId,
      runtimeStunIceServersRef,
      runtimeTurnIceServersRef,
      useTurnFallbackRef,
      producerTransportDisconnectTimeoutRef,
      consumerTransportDisconnectTimeoutRef,
      pendingProducerRetryTimeoutRef,
      prejoinMediaIntentRef,
      producerSyncIntervalRef,
      consumeRetryAttemptsRef,
      videoStallRecoveryTimeoutsRef,
      staleConsumerRecoveryTimeoutsRef,
      mutedConsumerSinceRef,
      producerPausedStateRef,
      consumerRecoveryInFlightRef,
      stopScreenShareCapture,
    ],
  );

  const cleanup = useCallback(() => {
    console.log("[Meets] Running full cleanup...");

    intentionalDisconnectRef.current = true;
    cleanupRoomResources();
    if (producerSyncIntervalRef.current) {
      window.clearInterval(producerSyncIntervalRef.current);
      producerSyncIntervalRef.current = null;
    }

    localStream?.getTracks().forEach((track) => {
      stopLocalTrack(track);
    });

    socketRef.current?.disconnect();
    socketRef.current = null;
    onSocketReady?.(null);
    deviceRef.current = null;

    setConnectionState("disconnected");
    setLocalStream(null);
    setIsMuted(true);
    setIsCameraOff(true);
    setWaitingMessage(null);
    serverRestartNoticeRef.current = null;
    setServerRestartNotice(null);
    reconnectBackoffCancelRef.current?.();
    reconnectBackoffCancelRef.current = null;
    manualReconnectRetryRequestedRef.current = false;
    updateReconnectRecoveryStatus(null);
    if (adminNoticeTimeoutRef.current) {
      window.clearTimeout(adminNoticeTimeoutRef.current);
      adminNoticeTimeoutRef.current = null;
    }
    setAdminNotice(null);
    reconnectAttemptsRef.current = 0;
  }, [
    cleanupRoomResources,
    intentionalDisconnectRef,
    localStream,
    reconnectAttemptsRef,
    setConnectionState,
    setIsCameraOff,
    setIsMuted,
    setLocalStream,
    setAdminNotice,
    setServerRestartNotice,
    setWaitingMessage,
    socketRef,
    deviceRef,
    stopLocalTrack,
    producerSyncIntervalRef,
    updateReconnectRecoveryStatus,
    onSocketReady,
  ]);

  const resolveMediaPublishIntent = useCallback(
    (stream: MediaStream | null | undefined) => {
      const prejoinIntent = prejoinMediaIntentRef.current;
      const streamTrackIds = new Set(
        stream?.getTracks().map((track) => track.id) ?? [],
      );
      const matchesPrejoinIntent = Boolean(
        prejoinIntent &&
          ((prejoinIntent.streamId === null && streamTrackIds.size === 0) ||
            prejoinIntent.streamId === stream?.id ||
            Array.from(streamTrackIds).some((trackId) =>
              prejoinIntent.trackIds.has(trackId),
            )),
      );

      // The latest prejoin click is authoritative for the pending join. A stale
      // local stream from an earlier call can still be present for one tick.
      return {
        isMicOn: prejoinIntent ? prejoinIntent.isMicOn : !isMuted,
        isCameraOn: prejoinIntent ? prejoinIntent.isCameraOn : !isCameraOff,
        matchesPrejoinIntent,
      };
    },
    [isCameraOff, isMuted, prejoinMediaIntentRef],
  );

  const getJoinMediaNeeds = useCallback(
    (stream: MediaStream | null | undefined) => {
      const mediaIntent = resolveMediaPublishIntent(stream);
      return {
        needsAudio: mediaIntent.isMicOn,
        needsVideo: mediaIntent.isCameraOn,
      };
    },
    [resolveMediaPublishIntent],
  );

  const dropVideoTracksForCameraOff = useCallback(
    (stream: MediaStream | null, reason: string): MediaStream | null => {
      const videoTracks = stream?.getVideoTracks() ?? [];
      if (!stream || videoTracks.length === 0) return stream;

      console.warn("[Meets] Dropping local video tracks while camera is off:", {
        reason,
        stream: summarizeStreamForLog(stream),
        videoTracks: videoTracks.map(summarizeTrackForLog),
      });

      videoTracks.forEach((track) => stopLocalTrack(track));
      const remainingTracks = stream
        .getTracks()
        .filter(
          (track) => track.kind !== "video" && track.readyState === "live",
        );
      const nextStream =
        remainingTracks.length > 0 ? new MediaStream(remainingTracks) : null;

      if (
        localStreamRef.current === stream ||
        localStreamRef.current?.id === stream.id
      ) {
        localStreamRef.current = nextStream;
      }
      setLocalStream((current) =>
        current === stream || current?.id === stream.id ? nextStream : current,
      );
      setIsCameraOff(true);
      return nextStream;
    },
    [localStreamRef, setIsCameraOff, setLocalStream, stopLocalTrack],
  );

  const ensureLiveLocalMediaForJoin = useCallback(
    async (
      candidateStream: MediaStream | null,
      joinOptions: { isGhost: boolean; isRecorder?: boolean; joinMode: JoinMode },
      reason: string,
    ) => {
      const mediaNeeds = getJoinMediaNeeds(candidateStream);
      const shouldRequestMedia =
        !joinOptions.isGhost &&
        !joinOptions.isRecorder &&
        joinOptions.joinMode !== "webinar_attendee" &&
        !bypassMediaPermissions &&
        (mediaNeeds.needsAudio || mediaNeeds.needsVideo);
      if (!shouldRequestMedia) return candidateStream;

      const needsRefresh = streamNeedsMediaRefresh(candidateStream, mediaNeeds);
      if (!needsRefresh) return candidateStream;

      console.warn("[Meets] Refreshing stale local media before join:", {
        reason,
        isMuted,
        isCameraOff,
        mediaNeeds,
        stream: summarizeStreamForLog(candidateStream),
      });

      const refreshedStream = await requestMediaPermissions();
      if (!refreshedStream) {
        console.warn("[Meets] Local media refresh failed before join:", {
          reason,
          previousStream: summarizeStreamForLog(candidateStream),
        });
        return candidateStream?.getTracks().some(
          (track) => track.readyState === "live",
        )
          ? candidateStream
          : null;
      }

      const previousTracks = candidateStream?.getTracks() ?? [];
      const refreshedTrackIds = new Set(
        refreshedStream.getTracks().map((track) => track.id),
      );
      localStreamRef.current = refreshedStream;
      setLocalStream(refreshedStream);
      previousTracks.forEach((track) => {
        if (!refreshedTrackIds.has(track.id)) {
          stopLocalTrack(track);
        }
      });

      console.log("[Meets] Refreshed local media before join:", {
        reason,
        previousStream: summarizeStreamForLog(candidateStream),
        refreshedStream: summarizeStreamForLog(refreshedStream),
      });

      return refreshedStream;
    },
    [
      isCameraOff,
      isMuted,
      getJoinMediaNeeds,
      localStreamRef,
      requestMediaPermissions,
      setLocalStream,
      stopLocalTrack,
      bypassMediaPermissions,
    ],
  );

  const scheduleParticipantRemoval = useCallback(
    (leftUserId: string) => {
      const existingTimeout = leaveTimeoutsRef.current.get(leftUserId);
      if (existingTimeout) {
        window.clearTimeout(existingTimeout);
      }
      const timeoutId = window.setTimeout(() => {
        leaveTimeoutsRef.current.delete(leftUserId);
        dispatchParticipants({
          type: "REMOVE_PARTICIPANT",
          userId: leftUserId,
        });
      }, 200);
      leaveTimeoutsRef.current.set(leftUserId, timeoutId);
    },
    [dispatchParticipants, leaveTimeoutsRef],
  );

  const clearParticipantConnectionStatusTimer = useCallback(
    (targetUserId: string) => {
      const timeoutId =
        participantConnectionStatusTimeoutsRef.current.get(targetUserId);
      participantConnectionStatusExpiresAtRef.current.delete(targetUserId);
      if (!timeoutId) return;
      window.clearTimeout(timeoutId);
      participantConnectionStatusTimeoutsRef.current.delete(targetUserId);
    },
    [],
  );

  const clearParticipantConnectionStatus = useCallback(
    (targetUserId: string) => {
      clearParticipantConnectionStatusTimer(targetUserId);
      participantConnectionStatusExpiresAtRef.current.delete(targetUserId);
      visibleParticipantReconnectingIdsRef.current.delete(targetUserId);
      dispatchParticipants({
        type: "UPDATE_CONNECTION_STATUS",
        userId: targetUserId,
        status: null,
      });
    },
    [clearParticipantConnectionStatusTimer, dispatchParticipants],
  );

  const clearExpiredParticipantConnectionStatuses = useCallback(() => {
    const now = Date.now();
    for (const [
      targetUserId,
      expiresAt,
    ] of participantConnectionStatusExpiresAtRef.current) {
      if (expiresAt > now) continue;
      clearParticipantConnectionStatus(targetUserId);
    }
  }, [clearParticipantConnectionStatus]);

  const applyParticipantConnectionStatus = useCallback(
    (targetUserId: string, status: ParticipantConnectionStatus) => {
      if (
        status.state === "reconnected" &&
        !visibleParticipantReconnectingIdsRef.current.has(targetUserId)
      ) {
        clearParticipantConnectionStatus(targetUserId);
        return;
      }

      clearParticipantConnectionStatusTimer(targetUserId);
      if (status.state === "reconnecting") {
        visibleParticipantReconnectingIdsRef.current.add(targetUserId);
      } else {
        visibleParticipantReconnectingIdsRef.current.delete(targetUserId);
      }
      dispatchParticipants({
        type: "UPDATE_CONNECTION_STATUS",
        userId: targetUserId,
        status,
      });

      const clearStatus = () => {
        participantConnectionStatusTimeoutsRef.current.delete(targetUserId);
        participantConnectionStatusExpiresAtRef.current.delete(targetUserId);
        visibleParticipantReconnectingIdsRef.current.delete(targetUserId);
        dispatchParticipants({
          type: "UPDATE_CONNECTION_STATUS",
          userId: targetUserId,
          status: null,
        });
      };
      const timeoutMs =
        status.state === "reconnected"
          ? PARTICIPANT_RECONNECTED_STATUS_MS
          : Math.max(
              1000,
              (typeof status.graceMs === "number"
                ? status.graceMs
                : PARTICIPANT_RECONNECTING_STATUS_FALLBACK_MS) +
                PARTICIPANT_RECONNECTING_STATUS_BUFFER_MS -
                Math.max(0, Date.now() - (status.updatedAt ?? Date.now())),
            );

      participantConnectionStatusExpiresAtRef.current.set(
        targetUserId,
        Date.now() + timeoutMs,
      );
      const timeoutId = window.setTimeout(clearStatus, timeoutMs);
      participantConnectionStatusTimeoutsRef.current.set(targetUserId, timeoutId);
    },
    [
      clearParticipantConnectionStatus,
      clearParticipantConnectionStatusTimer,
      dispatchParticipants,
    ],
  );

  const isRoomEvent = useCallback(
    (eventRoomId?: string) => {
      if (!eventRoomId) return true;
      if (!currentRoomIdRef.current && !serverRoomIdRef.current) return true;
      return (
        eventRoomId === currentRoomIdRef.current ||
        eventRoomId === serverRoomIdRef.current
      );
    },
    [currentRoomIdRef, serverRoomIdRef],
  );

  const clearStaleConsumerRecoveryTimeout = useCallback((producerId: string) => {
    const timeoutId = staleConsumerRecoveryTimeoutsRef.current.get(producerId);
    if (timeoutId == null) return;
    window.clearTimeout(timeoutId);
    staleConsumerRecoveryTimeoutsRef.current.delete(producerId);
  }, []);

  const clearStaleReplacementCleanupTimeout = useCallback(
    (producerId: string) => {
      const timeoutId =
        staleReplacementCleanupTimeoutsRef.current.get(producerId);
      if (timeoutId == null) return;
      window.clearTimeout(timeoutId);
      staleReplacementCleanupTimeoutsRef.current.delete(producerId);
    },
    [],
  );

  const setProducerPausedState = useCallback(
    (producerId: string, paused: boolean) => {
      const wasPaused = producerPausedStateRef.current.get(producerId);
      producerPausedStateRef.current.set(producerId, paused);

      mutedConsumerSinceRef.current.delete(producerId);
      clearStaleConsumerRecoveryTimeout(producerId);

      if (paused) {
        // Muting / camera-off: the producer sends no RTP; nothing to resume.
        return;
      }

      // Only act on a REAL paused -> unpaused TRANSITION. syncProducers calls
      // this with paused=false for every live producer every 15s; without this
      // guard we'd re-emit a keyframe (PLI) for every remote video on every sync
      // tick (periodic bandwidth/quality spikes). On the first call (consume
      // time) wasPaused is undefined, and the consume path does its own resume.
      if (wasPaused !== true) {
        return;
      }

      // The consume path leaves paused producers paused server-side, so resume
      // immediately when the producer unmutes instead of waiting for sync.
      if (adaptivelyPausedConsumerProducerIdsRef.current.has(producerId)) {
        return;
      }

      const consumer = consumersRef.current.get(producerId);
      const socket = socketRef.current;
      if (consumer && socket) {
        socket.emit(
          "resumeConsumer",
          {
            consumerId: consumer.id,
            requestKeyFrame: consumer.kind === "video",
          },
          () => {},
        );
      }
    },
    [
      adaptivelyPausedConsumerProducerIdsRef,
      clearStaleConsumerRecoveryTimeout,
      consumersRef,
      socketRef,
    ],
  );

  const setProducerPausedByUser = useCallback(
    (
      targetUserId: string,
      kind: "audio" | "video",
      paused: boolean,
      type: ProducerType = "webcam",
    ) => {
      for (const [producerId, info] of producerMapRef.current.entries()) {
        if (
          info.userId === targetUserId &&
          info.kind === kind &&
          info.type === type
        ) {
          setProducerPausedState(producerId, paused);
        }
      }
    },
    [producerMapRef, setProducerPausedState],
  );

  const closeConsumerForSameProducerReconsume = useCallback(
    (producerId: string, consumerToClose?: Consumer | null) => {
      pendingProducersRef.current.delete(producerId);
      consumeRetryAttemptsRef.current.delete(producerId);
      const scheduledRecoveryTimeout =
        videoStallRecoveryTimeoutsRef.current.get(producerId);
      if (scheduledRecoveryTimeout != null) {
        window.clearTimeout(scheduledRecoveryTimeout);
        videoStallRecoveryTimeoutsRef.current.delete(producerId);
      }
      clearStaleConsumerRecoveryTimeout(producerId);
      clearStaleReplacementCleanupTimeout(producerId);
      mutedConsumerSinceRef.current.delete(producerId);
      adaptivelyPausedConsumerProducerIdsRef.current.delete(producerId);
      consumerTelemetryRef.current.delete(producerId);
      videoFreezeStatsRef.current.delete(producerId);

      const consumer = consumerToClose ?? consumersRef.current.get(producerId);
      if (!consumer) return;
      try {
        consumer.track.onmute = null;
        consumer.track.onunmute = null;
        consumer.track.stop();
        consumer.close();
      } catch {}
      if (consumersRef.current.get(producerId)?.id === consumer.id) {
        consumersRef.current.delete(producerId);
      }
    },
    [
      adaptivelyPausedConsumerProducerIdsRef,
      clearStaleConsumerRecoveryTimeout,
      clearStaleReplacementCleanupTimeout,
      consumeRetryAttemptsRef,
      consumerTelemetryRef,
      consumersRef,
      mutedConsumerSinceRef,
      pendingProducersRef,
      videoFreezeStatsRef,
      videoStallRecoveryTimeoutsRef,
    ],
  );

  const handleProducerClosed = useCallback(
    (producerId: string) => {
      pendingProducersRef.current.delete(producerId);
      consumeRetryAttemptsRef.current.delete(producerId);
      const scheduledRecoveryTimeout =
        videoStallRecoveryTimeoutsRef.current.get(producerId);
      if (scheduledRecoveryTimeout != null) {
        window.clearTimeout(scheduledRecoveryTimeout);
        videoStallRecoveryTimeoutsRef.current.delete(producerId);
      }
      clearStaleConsumerRecoveryTimeout(producerId);
      mutedConsumerSinceRef.current.delete(producerId);
      producerPausedStateRef.current.delete(producerId);
      adaptivelyPausedConsumerProducerIdsRef.current.delete(producerId);
      consumerTelemetryRef.current.delete(producerId);
      videoFreezeStatsRef.current.delete(producerId);
      consumerRecoveryInFlightRef.current.delete(producerId);
      const consumer = consumersRef.current.get(producerId);
      if (consumer) {
        try {
          consumer.track.onmute = null;
          consumer.track.onunmute = null;
          if (consumer.track) {
            consumer.track.stop();
          }
          consumer.close();
        } catch {}
        consumersRef.current.delete(producerId);
      }

      const info = producerMapRef.current.get(producerId);
      if (info) {
        clearStaleReplacementCleanupTimeout(producerId);
        const getMatchingReplacementState = () => {
          const consumedReplacement = Array.from(
            producerMapRef.current.entries(),
          ).find(
            ([otherProducerId, otherInfo]) =>
              otherProducerId !== producerId &&
              otherInfo.userId === info.userId &&
              otherInfo.kind === info.kind &&
              otherInfo.type === info.type,
          );
          const pendingReplacement = Array.from(
            announcedRemoteProducersRef.current.entries(),
          ).find(
            ([otherProducerId, otherInfo]) =>
              otherProducerId !== producerId &&
              otherInfo.producerUserId === info.userId &&
              otherInfo.kind === info.kind &&
              otherInfo.type === info.type,
          );
          const hasConsumedReplacement = Boolean(consumedReplacement);
          const hasPendingReplacement = Boolean(pendingReplacement);
          return {
            hasConsumedReplacement,
            hasPendingReplacement,
            hasReplacementProducer:
              hasConsumedReplacement || hasPendingReplacement,
            pendingReplacementProducerId: pendingReplacement?.[0] ?? null,
          };
        };

        const clearClosedProducerState = ({
          hasPendingReplacement,
          pendingReplacementProducerId,
          preservePendingScreenShare,
        }: {
          hasPendingReplacement: boolean;
          pendingReplacementProducerId: string | null;
          preservePendingScreenShare: boolean;
        }) => {
          dispatchParticipants({
            type: "UPDATE_STREAM",
            userId: info.userId,
            kind: info.kind,
            streamType: info.type,
            stream: null,
            producerId: producerId,
          });

          if (info.kind === "video" && info.type === "screen") {
            setActiveScreenShareId(
              preservePendingScreenShare && pendingReplacementProducerId
                ? pendingReplacementProducerId
                : null,
            );
          }

          if (!hasPendingReplacement) {
            if (info.kind === "video" && info.type === "webcam") {
              dispatchParticipants({
                type: "UPDATE_CAMERA_OFF",
                userId: info.userId,
                cameraOff: true,
                addIfMissing: false,
              });
            } else if (info.kind === "audio" && info.type === "webcam") {
              dispatchParticipants({
                type: "UPDATE_MUTED",
                userId: info.userId,
                muted: true,
                addIfMissing: false,
              });
            }
          }
        };

        const scheduleStaleReplacementCleanup = () => {
          const cleanupDelayMs =
            info.kind === "video" && info.type === "screen"
              ? SCREEN_SHARE_STALE_REPLACEMENT_CLEANUP_DELAY_MS
              : STALE_REPLACEMENT_CLEANUP_DELAY_MS;
          const timeoutId = window.setTimeout(() => {
            staleReplacementCleanupTimeoutsRef.current.delete(producerId);
            const latestReplacementState = getMatchingReplacementState();
            if (latestReplacementState.hasConsumedReplacement) return;

            clearClosedProducerState({
              hasPendingReplacement: latestReplacementState.hasPendingReplacement,
              pendingReplacementProducerId:
                latestReplacementState.pendingReplacementProducerId,
              preservePendingScreenShare: false,
            });
          }, cleanupDelayMs);
          staleReplacementCleanupTimeoutsRef.current.set(producerId, timeoutId);
        };

        const replacementState = getMatchingReplacementState();
        if (!replacementState.hasReplacementProducer) {
          const timeoutId = window.setTimeout(() => {
            staleReplacementCleanupTimeoutsRef.current.delete(producerId);
            const latestReplacementState = getMatchingReplacementState();
            if (latestReplacementState.hasConsumedReplacement) return;
            clearClosedProducerState({
              hasPendingReplacement: latestReplacementState.hasPendingReplacement,
              pendingReplacementProducerId:
                latestReplacementState.pendingReplacementProducerId,
              preservePendingScreenShare: true,
            });
            if (latestReplacementState.hasPendingReplacement) {
              scheduleStaleReplacementCleanup();
            }
          }, PRODUCER_CLOSE_REPLACEMENT_GRACE_MS);
          staleReplacementCleanupTimeoutsRef.current.set(producerId, timeoutId);
        } else if (!replacementState.hasConsumedReplacement) {
          if (
            info.kind === "video" &&
            info.type === "screen" &&
            replacementState.pendingReplacementProducerId
          ) {
            setActiveScreenShareId(replacementState.pendingReplacementProducerId);
          }
          scheduleStaleReplacementCleanup();
        }

        producerMapRef.current.delete(producerId);
      }
      announcedRemoteProducersRef.current.delete(producerId);
    },
    [
      consumersRef,
      dispatchParticipants,
      pendingProducersRef,
      consumeRetryAttemptsRef,
      videoStallRecoveryTimeoutsRef,
      adaptivelyPausedConsumerProducerIdsRef,
      consumerTelemetryRef,
      clearStaleConsumerRecoveryTimeout,
      mutedConsumerSinceRef,
      producerPausedStateRef,
      consumerRecoveryInFlightRef,
      producerMapRef,
      announcedRemoteProducersRef,
      clearStaleReplacementCleanupTimeout,
      setActiveScreenShareId,
    ],
  );

  const queueProducerConsumeRetry = useCallback(
    (producerInfo: ProducerInfo, delayMs = 300) => {
      const attemptCount =
        (consumeRetryAttemptsRef.current.get(producerInfo.producerId) ?? 0) + 1;
      if (attemptCount > 4) {
        pendingProducersRef.current.delete(producerInfo.producerId);
        consumeRetryAttemptsRef.current.delete(producerInfo.producerId);
        return;
      }

      consumeRetryAttemptsRef.current.set(producerInfo.producerId, attemptCount);
      pendingProducersRef.current.set(producerInfo.producerId, producerInfo);

      if (pendingProducerRetryTimeoutRef.current) return;

      pendingProducerRetryTimeoutRef.current = window.setTimeout(() => {
        pendingProducerRetryTimeoutRef.current = null;
        const pending = Array.from(pendingProducersRef.current.values());
        pendingProducersRef.current.clear();
        for (const pendingProducer of pending) {
          void consumeProducerRef.current(pendingProducer);
        }
      }, delayMs);
    },
    [
      consumeRetryAttemptsRef,
      pendingProducersRef,
      pendingProducerRetryTimeoutRef,
    ],
  );

  const attemptIceRestart = useCallback(
    async (transportKind: "producer" | "consumer"): Promise<boolean> => {
      const existingRestart = iceRestartPromiseRef.current[transportKind];
      if (existingRestart) return existingRestart;

      const socket = socketRef.current;
      if (!socket || !socket.connected) return false;

      const transport =
        transportKind === "producer"
          ? producerTransportRef.current
          : consumerTransportRef.current;

      if (!transport) return false;

      const inFlight = iceRestartInFlightRef.current;
      if (inFlight[transportKind]) return false;
      inFlight[transportKind] = true;

      let restartPromise: Promise<boolean>;
      restartPromise = (async () => {
        try {
          const response = await new Promise<RestartIceResponse>(
            (resolve, reject) => {
              let settled = false;
              const timeoutId = window.setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error("restartIce acknowledgement timeout"));
              }, RESTART_ICE_ACK_TIMEOUT_MS);
              socket.emit(
                "restartIce",
                { transport: transportKind, transportId: transport.id },
                (res: RestartIceResponse | { error: string }) => {
                  if (settled) return;
                  settled = true;
                  window.clearTimeout(timeoutId);
                  if ("error" in res) {
                    reject(new Error(res.error));
                  } else {
                    resolve(res);
                  }
                },
              );
            },
          );

          await transport.restartIce({ iceParameters: response.iceParameters });
          console.log(
            `[Meets] ${transportKind} transport ICE restart succeeded.`,
          );
          return true;
        } catch (err) {
          console.error(
            `[Meets] ${transportKind} transport ICE restart failed:`,
            err,
          );
          return false;
        } finally {
          inFlight[transportKind] = false;
          iceRestartPromiseRef.current[transportKind] = null;
        }
      })();

      iceRestartPromiseRef.current[transportKind] = restartPromise;
      return restartPromise;
    },
    [
      socketRef,
      producerTransportRef,
      consumerTransportRef,
      iceRestartInFlightRef,
    ],
  );

  const createProducerTransport = useCallback(
    async (socket: Socket, device: Device): Promise<void> => {
      return new Promise((resolve, reject) => {
        socket.emit(
          "createProducerTransport",
          (response: TransportResponse | { error: string }) => {
            if ("error" in response) {
              reject(new Error(response.error));
              return;
            }

            const transport = device.createSendTransport({
              ...response,
              iceServers: resolveIceServers(),
            });

            transport.on(
              "connect",
              (
                { dtlsParameters }: { dtlsParameters: DtlsParameters },
                callback: () => void,
                errback: (error: Error) => void,
              ) => {
                socket.emit(
                  "connectProducerTransport",
                  { transportId: transport.id, dtlsParameters },
                  (res: { success: boolean } | { error: string }) => {
                    if ("error" in res) errback(new Error(res.error));
                    else callback();
                  },
                );
              },
            );

            transport.on(
              "produce",
              (
                {
                  kind,
                  rtpParameters,
                  appData,
                }: {
                  kind: "audio" | "video";
                  rtpParameters: RtpParameters;
                  appData: unknown;
                },
                callback: (data: { id: string }) => void,
                errback: (error: Error) => void,
              ) => {
                socket.emit(
                  "produce",
                  { transportId: transport.id, kind, rtpParameters, appData },
                  (res: { producerId: string } | { error: string }) => {
                    if ("error" in res) errback(new Error(res.error));
                    else callback({ id: res.producerId });
                  },
                );
              },
            );

            transport.on("connectionstatechange", (state: string) => {
              console.log("[Meets] Producer transport state:", state);
              if (state === "connected") {
                if (producerTransportDisconnectTimeoutRef.current) {
                  window.clearTimeout(
                    producerTransportDisconnectTimeoutRef.current,
                  );
                  producerTransportDisconnectTimeoutRef.current = null;
                }
                return;
              }

              if (state === "disconnected") {
                if (
                  !intentionalDisconnectRef.current &&
                  !producerTransportDisconnectTimeoutRef.current
                ) {
                  producerTransportDisconnectTimeoutRef.current =
                    window.setTimeout(() => {
                      producerTransportDisconnectTimeoutRef.current = null;
                      if (
                        !intentionalDisconnectRef.current &&
                        transport.connectionState === "disconnected"
                      ) {
                        if (shouldDeferTransportRecoveryUntilVisible()) {
                          console.info(
                            "[Meets] Producer transport recovery deferred until foreground.",
                          );
                          return;
                        }
                        attemptIceRestart("producer").then((restarted) => {
                          if (!restarted) {
                            const enabledTurnFallback = enableTurnFallback(
                              "Producer transport could not recover with STUN-only ICE",
                            );
                            if (enabledTurnFallback) {
                              handleReconnectRef.current?.();
                              return;
                            }
                            setMeetError({
                              code: "TRANSPORT_ERROR",
                              message: "Producer transport interrupted",
                              recoverable: true,
                            });
                            handleReconnectRef.current?.();
                          }
                        });
                      }
                    }, getTransportDisconnectGraceMs());
                }
                return;
              }

              if (producerTransportDisconnectTimeoutRef.current) {
                window.clearTimeout(
                  producerTransportDisconnectTimeoutRef.current,
                );
                producerTransportDisconnectTimeoutRef.current = null;
              }

              if (state === "failed") {
                if (!intentionalDisconnectRef.current) {
                  if (shouldDeferTransportRecoveryUntilVisible()) {
                    console.info(
                      "[Meets] Producer transport failure recovery deferred until foreground.",
                    );
                    return;
                  }
                  attemptIceRestart("producer").then((restarted) => {
                    if (!restarted) {
                      const enabledTurnFallback = enableTurnFallback(
                        "Producer transport failed with STUN-only ICE",
                      );
                      if (enabledTurnFallback) {
                        handleReconnectRef.current?.();
                        return;
                      }
                      setMeetError({
                        code: "TRANSPORT_ERROR",
                        message: "Producer transport failed",
                        recoverable: true,
                      });
                      handleReconnectRef.current?.();
                    }
                  });
                }
              } else if (state === "closed") {
                if (!intentionalDisconnectRef.current) {
                  setMeetError({
                    code: "TRANSPORT_ERROR",
                    message: "Producer transport closed",
                    recoverable: true,
                  });
                }
              }
            });

            producerTransportRef.current = transport;
            resolve();
          },
        );
      });
    },
    [
      producerTransportRef,
      setMeetError,
      handleReconnectRef,
      intentionalDisconnectRef,
      producerTransportDisconnectTimeoutRef,
      attemptIceRestart,
      enableTurnFallback,
      resolveIceServers,
    ],
  );

  const ensureProducerTransport = useCallback(async (): Promise<boolean> => {
    const existingTransport = producerTransportRef.current;
    if (getUsableProducerTransport(existingTransport)) return true;
    if (existingTransport) {
      try {
        existingTransport.close();
      } catch {}
      producerTransportRef.current = null;
    }

    const socket = socketRef.current;
    const device = deviceRef.current;
    if (!socket?.connected || !device) {
      console.warn("[Meets] Cannot create producer transport yet:", {
        hasSocket: Boolean(socket),
        socketConnected: Boolean(socket?.connected),
        hasDevice: Boolean(device),
      });
      return false;
    }

    if (producerTransportCreatePromiseRef.current) {
      return producerTransportCreatePromiseRef.current;
    }

    producerTransportCreatePromiseRef.current = (async () => {
      try {
        await createProducerTransport(socket, device);
        const transport = producerTransportRef.current;
        return Boolean(transport && !transport.closed);
      } catch (err) {
        console.error("[Meets] Failed to create producer transport:", err);
        return false;
      } finally {
        producerTransportCreatePromiseRef.current = null;
      }
    })();

    return producerTransportCreatePromiseRef.current;
  }, [
    createProducerTransport,
    deviceRef,
    producerTransportRef,
    socketRef,
  ]);

  const createConsumerTransport = useCallback(
    async (socket: Socket, device: Device): Promise<void> => {
      return new Promise((resolve, reject) => {
        socket.emit(
          "createConsumerTransport",
          (response: TransportResponse | { error: string }) => {
            if ("error" in response) {
              reject(new Error(response.error));
              return;
            }

            const transport = device.createRecvTransport({
              ...response,
              iceServers: resolveIceServers(),
            });

            transport.on(
              "connect",
              (
                { dtlsParameters }: { dtlsParameters: DtlsParameters },
                callback: () => void,
                errback: (error: Error) => void,
              ) => {
                socket.emit(
                  "connectConsumerTransport",
                  { transportId: transport.id, dtlsParameters },
                  (res: { success: boolean } | { error: string }) => {
                    if ("error" in res) errback(new Error(res.error));
                    else callback();
                  },
                );
              },
            );

            transport.on("connectionstatechange", (state: string) => {
              console.log("[Meets] Consumer transport state:", state);
              if (state === "connected") {
                if (consumerTransportDisconnectTimeoutRef.current) {
                  window.clearTimeout(
                    consumerTransportDisconnectTimeoutRef.current,
                  );
                  consumerTransportDisconnectTimeoutRef.current = null;
                }
                return;
              }

              if (state === "disconnected") {
                if (
                  !intentionalDisconnectRef.current &&
                  !consumerTransportDisconnectTimeoutRef.current
                ) {
                  consumerTransportDisconnectTimeoutRef.current =
                    window.setTimeout(() => {
                      consumerTransportDisconnectTimeoutRef.current = null;
                      if (
                        !intentionalDisconnectRef.current &&
                        transport.connectionState === "disconnected"
                      ) {
                        if (shouldDeferTransportRecoveryUntilVisible()) {
                          console.info(
                            "[Meets] Consumer transport recovery deferred until foreground.",
                          );
                          return;
                        }
                        attemptIceRestart("consumer").then((restarted) => {
                          if (!restarted) {
                            const enabledTurnFallback = enableTurnFallback(
                              "Consumer transport could not recover with STUN-only ICE",
                            );
                            if (enabledTurnFallback) {
                              handleReconnectRef.current?.();
                              return;
                            }
                            handleReconnectRef.current?.();
                          }
                        });
                      }
                    }, getTransportDisconnectGraceMs());
                }
                return;
              }

              if (consumerTransportDisconnectTimeoutRef.current) {
                window.clearTimeout(
                  consumerTransportDisconnectTimeoutRef.current,
                );
                consumerTransportDisconnectTimeoutRef.current = null;
              }

              if (state === "failed") {
                if (!intentionalDisconnectRef.current) {
                  if (shouldDeferTransportRecoveryUntilVisible()) {
                    console.info(
                      "[Meets] Consumer transport failure recovery deferred until foreground.",
                    );
                    return;
                  }
                  attemptIceRestart("consumer").then((restarted) => {
                    if (!restarted) {
                      const enabledTurnFallback = enableTurnFallback(
                        "Consumer transport failed with STUN-only ICE",
                      );
                      if (enabledTurnFallback) {
                        handleReconnectRef.current?.();
                        return;
                      }
                      handleReconnectRef.current?.();
                    }
                  });
                }
              }
            });

            consumerTransportRef.current = transport;
            resolve();
          },
        );
      });
    },
    [
      consumerTransportRef,
      handleReconnectRef,
      intentionalDisconnectRef,
      consumerTransportDisconnectTimeoutRef,
      attemptIceRestart,
      enableTurnFallback,
      resolveIceServers,
    ],
  );

  const produce = useCallback(
    async (stream: MediaStream): Promise<void> => {
      const transport = producerTransportRef.current;
      if (!transport) return;
      const publicationWarnings: string[] = [];
      const mediaIntent = resolveMediaPublishIntent(stream);
      const shouldPauseAudio = !mediaIntent.isMicOn;
      const shouldPauseVideo = !mediaIntent.isCameraOn;

      const audioTrack = getFirstLiveTrack(stream.getAudioTracks());
      if (audioTrack) {
        try {
          if ("contentHint" in audioTrack) {
            audioTrack.contentHint = "speech";
          }
          const audioProducer = await transport.produce({
            track: audioTrack,
            codecOptions: buildMicrophoneOpusCodecOptions(
              getPublishNetworkProfile(),
            ),
            stopTracks: false,
            appData: {
              type: "webcam" as ProducerType,
              paused: shouldPauseAudio,
            },
          });

          if (shouldPauseAudio) {
            audioProducer.pause();
          }

          audioProducerRef.current = audioProducer;
          const audioProducerId = audioProducer.id;

          audioProducer.on("transportclose", () => {
            if (audioProducerRef.current?.id === audioProducerId) {
              audioProducerRef.current = null;
              if (!shouldPauseAudio) {
                requestAudioProducerRecovery();
              }
            }
          });
        } catch (err) {
          console.error("[Meets] Failed to produce audio:", err);
          if (mediaIntent.isMicOn) {
            if (audioTrack.readyState === "live") {
              publicationWarnings.push("microphone publish retry scheduled");
              audioTrack.enabled = true;
              isMutedRef.current = false;
              setIsMuted(false);
              requestAudioProducerRecovery();
            } else {
              publicationWarnings.push("microphone publish failed");
              isMutedRef.current = true;
              setIsMuted(true);
            }
          }
        }
      } else if (mediaIntent.isMicOn) {
        const endedAudioTracks = stream
          .getAudioTracks()
          .filter((track) => track.readyState !== "live");
        if (endedAudioTracks.length > 0) {
          console.warn("[Meets] Skipping ended microphone track(s):", {
            stream: summarizeStreamForLog(stream),
            endedAudioTracks: endedAudioTracks.map(summarizeTrackForLog),
          });
          publicationWarnings.push("microphone track ended");
        } else {
          publicationWarnings.push("microphone track missing");
        }
        isMutedRef.current = true;
        setIsMuted(true);
      }

      if (!mediaIntent.isCameraOn) {
        dropVideoTracksForCameraOff(stream, "camera-off publish intent");
        if (publicationWarnings.length > 0) {
          console.warn(
            `[Meets] Continuing join without some local media: ${publicationWarnings.join(", ")}`
          );
        }
        return;
      }

      const requestedVideoTrack = getVideoPublishTrack?.(stream) ?? null;
      let videoTrack =
        requestedVideoTrack?.readyState === "live" ? requestedVideoTrack : null;
      if (requestedVideoTrack && requestedVideoTrack.readyState !== "live") {
        console.warn("[Meets] Ignoring ended requested video publish track:", {
          requestedVideoTrack: summarizeTrackForLog(requestedVideoTrack),
          stream: summarizeStreamForLog(stream),
        });
        if (refs.processedVideoTrackRef.current?.id === requestedVideoTrack.id) {
          refs.processedVideoTrackRef.current = null;
        }
      }
      if (!videoTrack) {
        videoTrack = getFirstLiveTrack(stream.getVideoTracks());
      }
      if (videoTrack) {
        const quality = videoQualityRef.current;
        const preferredWebcamCodec = getPreferredWebcamCodec(deviceRef.current);
        try {
          const videoProducer = await produceWebcamTrack({
            transport,
            track: videoTrack,
            quality,
            networkProfile: getPublishNetworkProfile(),
            paused: shouldPauseVideo,
            preferredCodec: preferredWebcamCodec,
          });

          if (shouldPauseVideo) {
            videoProducer.pause();
          }

          videoProducerRef.current = videoProducer;
          const videoProducerId = videoProducer.id;

          videoProducer.on("transportclose", () => {
            if (videoProducerRef.current?.id === videoProducerId) {
              videoProducerRef.current = null;
              if (!shouldPauseVideo) {
                requestCameraProducerRecovery();
              }
            }
          });
        } catch (err) {
          const rawFallbackTrack =
            requestedVideoTrack && videoTrack.id === requestedVideoTrack.id
              ? getFirstLiveTrack(
                  stream
                    .getVideoTracks()
                    .filter((track) => track.id !== requestedVideoTrack.id),
                )
              : null;

          if (rawFallbackTrack) {
            console.warn(
              "[Meets] Processed camera publish failed; retrying raw camera:",
              {
                error:
                  err instanceof Error
                    ? {
                        name: err.name,
                        message: err.message,
                        stack: err.stack,
                      }
                    : err,
                processedTrack: summarizeTrackForLog(videoTrack),
                rawFallbackTrack: summarizeTrackForLog(rawFallbackTrack),
              },
            );
            onPreferredVideoPublishTrackRejected?.(
              videoTrack,
              "join-raw-produce-fallback",
            );
            try {
              const fallbackVideoProducer = await produceWebcamTrack({
                transport,
                track: rawFallbackTrack,
                quality,
                networkProfile: getPublishNetworkProfile(),
                paused: shouldPauseVideo,
                preferredCodec: preferredWebcamCodec,
              });

              if (shouldPauseVideo) {
                fallbackVideoProducer.pause();
              }

              videoProducerRef.current = fallbackVideoProducer;
              const fallbackVideoProducerId = fallbackVideoProducer.id;

              fallbackVideoProducer.on("transportclose", () => {
                if (videoProducerRef.current?.id === fallbackVideoProducerId) {
                  videoProducerRef.current = null;
                  if (!shouldPauseVideo) {
                    requestCameraProducerRecovery();
                  }
                }
              });
              return;
            } catch (fallbackErr) {
              console.error(
                "[Meets] Failed to produce raw fallback video:",
                fallbackErr,
              );
            }
          } else {
            console.error("[Meets] Failed to produce video:", err);
          }

          if (mediaIntent.isCameraOn) {
            const liveVideoTrack = getFirstLiveTrack(stream.getVideoTracks());
            if (liveVideoTrack) {
              publicationWarnings.push("camera publish retry scheduled");
              setIsCameraOff(false);
              requestCameraProducerRecovery();
            } else {
              publicationWarnings.push("camera publish failed");
              setIsCameraOff(true);
            }
          }
        }
      } else if (mediaIntent.isCameraOn) {
        const endedVideoTracks = stream
          .getVideoTracks()
          .filter((track) => track.readyState !== "live");
        if (endedVideoTracks.length > 0) {
          console.warn("[Meets] Skipping ended camera track(s):", {
            stream: summarizeStreamForLog(stream),
            endedVideoTracks: endedVideoTracks.map(summarizeTrackForLog),
          });
          publicationWarnings.push("camera track ended");
        } else {
          publicationWarnings.push("camera track missing");
        }
        setIsCameraOff(true);
      }

      if (publicationWarnings.length > 0) {
        console.warn(
          `[Meets] Continuing join without some local media: ${publicationWarnings.join(", ")}`
        );
      }
    },
    [
      producerTransportRef,
      audioProducerRef,
      videoProducerRef,
      isMuted,
      isCameraOff,
      setIsMuted,
      setIsCameraOff,
      videoQualityRef,
      deviceRef,
      getVideoPublishTrack,
      getPublishNetworkProfile,
      onPreferredVideoPublishTrackRejected,
      dropVideoTracksForCameraOff,
      refs.processedVideoTrackRef,
      resolveMediaPublishIntent,
      requestAudioProducerRecovery,
      requestCameraProducerRecovery,
    ],
  );

  const consumeProducer = useCallback(
    async (
      producerInfo: ProducerInfo,
      options: ConsumeProducerOptions = {},
    ): Promise<void> => {
      if (producerInfo.producerUserId === userId) {
        return;
      }
      const existingConsumer = consumersRef.current.get(producerInfo.producerId);
      if (existingConsumer && !options.replaceExisting) {
        consumeRetryAttemptsRef.current.delete(producerInfo.producerId);
        return;
      }

      const socket = socketRef.current;
      const device = deviceRef.current;
      const transport = consumerTransportRef.current;

      if (!socket || !device || !transport) {
        queueProducerConsumeRetry(producerInfo, 300);
        return;
      }

      return new Promise((resolve) => {
        const existingWebcamVideoConsumerCount = Array.from(
          producerMapRef.current.values(),
        ).filter((info) => info.kind === "video" && info.type === "webcam")
          .length;
        socket.emit(
          "consume",
          {
            transportId: transport.id,
            producerId: producerInfo.producerId,
            rtpCapabilities: device.rtpCapabilities,
            ...getInitialConsumerPreferences(producerInfo, {
              preferHighWebcamLayer:
                joinMode === "webinar_attendee" ||
                existingWebcamVideoConsumerCount < 4,
              networkProfile: getReceiveNetworkProfile(),
            }),
          },
          async (response: ConsumeResponse | { error: string }) => {
            if ("error" in response) {
              console.error("[Meets] Consume error:", response.error);
              queueProducerConsumeRetry(producerInfo, 300);
              resolve();
              return;
            }

            try {
              const consumer = await transport.consume({
                id: response.id,
                producerId: response.producerId,
                kind: response.kind,
                rtpParameters:
                  normalizeReceiveRtpParametersForCongestionFeedback(
                    response.rtpParameters,
                  ),
              });

              consumersRef.current.set(producerInfo.producerId, consumer);
              announcedRemoteProducersRef.current.delete(
                producerInfo.producerId,
              );
              consumeRetryAttemptsRef.current.delete(producerInfo.producerId);
              producerMapRef.current.set(producerInfo.producerId, {
                userId: producerInfo.producerUserId,
                kind: response.kind,
                type: producerInfo.type,
              });
              setProducerPausedState(
                producerInfo.producerId,
                Boolean(producerInfo.paused),
              );

              const updateMutedState = (muted: boolean) => {
                dispatchParticipants({
                  type: "UPDATE_MUTED",
                  userId: producerInfo.producerUserId,
                  muted,
                });
              };

              const updateCameraState = (cameraOff: boolean) => {
                if (producerInfo.type !== "webcam") return;
                dispatchParticipants({
                  type: "UPDATE_CAMERA_OFF",
                  userId: producerInfo.producerUserId,
                  cameraOff,
                });
              };

              const isWebcamAudio =
                response.kind === "audio" && producerInfo.type === "webcam";
              const isWebcamVideo =
                response.kind === "video" && producerInfo.type === "webcam";

              const scheduleStaleConsumerRecovery = () => {
                clearStaleConsumerRecoveryTimeout(producerInfo.producerId);
                const timeoutId = window.setTimeout(() => {
                  staleConsumerRecoveryTimeoutsRef.current.delete(
                    producerInfo.producerId,
                  );
                  const activeConsumer = consumersRef.current.get(
                    producerInfo.producerId,
                  );
                  if (
                    !activeConsumer ||
                    activeConsumer.closed ||
                    activeConsumer.id !== consumer.id
                  ) {
                    return;
                  }
                  const track = activeConsumer.track;
                  if (!track || track.readyState !== "live" || !track.muted) {
                    return;
                  }
                  if (producerPausedStateRef.current.get(producerInfo.producerId)) {
                    return;
                  }
                  if (
                    adaptivelyPausedConsumerProducerIdsRef.current.has(
                      producerInfo.producerId,
                    )
                  ) {
                    return;
                  }
                  void recoverStaleConsumerRef.current(
                    producerInfo,
                    `${response.kind} consumer stayed muted`,
                  );
                }, STALE_CONSUMER_RECOVERY_DELAY_MS);
                staleConsumerRecoveryTimeoutsRef.current.set(
                  producerInfo.producerId,
                  timeoutId,
                );
              };

              const handleTrackMuted = () => {
                if (
                  response.kind === "video" &&
                  adaptivelyPausedConsumerProducerIdsRef.current.has(
                    producerInfo.producerId,
                  )
                ) {
                  mutedConsumerSinceRef.current.delete(producerInfo.producerId);
                  clearStaleConsumerRecoveryTimeout(producerInfo.producerId);
                  const existingTimeout = videoStallRecoveryTimeoutsRef.current.get(
                    producerInfo.producerId,
                  );
                  if (existingTimeout != null) {
                    window.clearTimeout(existingTimeout);
                    videoStallRecoveryTimeoutsRef.current.delete(
                      producerInfo.producerId,
                    );
                  }
                  return;
                }

                if (!mutedConsumerSinceRef.current.has(producerInfo.producerId)) {
                  mutedConsumerSinceRef.current.set(
                    producerInfo.producerId,
                    Date.now(),
                  );
                }
                if (!producerPausedStateRef.current.get(producerInfo.producerId)) {
                  scheduleStaleConsumerRecovery();
                }
                if (response.kind === "video") {
                  const existingTimeout = videoStallRecoveryTimeoutsRef.current.get(
                    producerInfo.producerId,
                  );
                  if (existingTimeout != null) {
                    window.clearTimeout(existingTimeout);
                  }
                  const timeoutId = window.setTimeout(() => {
                    const activeConsumer = consumersRef.current.get(
                      producerInfo.producerId,
                    );
                    if (
                      !activeConsumer ||
                      activeConsumer.closed ||
                      activeConsumer.id !== consumer.id
                    ) {
                      return;
                    }
                    const track = activeConsumer.track;
                    if (!track || track.readyState !== "live" || !track.muted) {
                      return;
                    }
                    if (
                      adaptivelyPausedConsumerProducerIdsRef.current.has(
                        producerInfo.producerId,
                      )
                    ) {
                      return;
                    }
                    socket.emit(
                      "resumeConsumer",
                      {
                        consumerId: activeConsumer.id,
                        requestKeyFrame: true,
                      },
                      () => {},
                    );
                  }, VIDEO_STALL_KEYFRAME_REQUEST_DELAY_MS);
                  videoStallRecoveryTimeoutsRef.current.set(
                    producerInfo.producerId,
                    timeoutId,
                  );
                }
              };

              const handleTrackUnmuted = () => {
                mutedConsumerSinceRef.current.delete(producerInfo.producerId);
                setProducerPausedState(producerInfo.producerId, false);
                clearStaleConsumerRecoveryTimeout(producerInfo.producerId);
                const existingTimeout = videoStallRecoveryTimeoutsRef.current.get(
                  producerInfo.producerId,
                );
                if (existingTimeout != null) {
                  window.clearTimeout(existingTimeout);
                  videoStallRecoveryTimeoutsRef.current.delete(
                    producerInfo.producerId,
                  );
                }
              };

              consumer.on("trackended", () => {
                clearStaleConsumerRecoveryTimeout(producerInfo.producerId);
                mutedConsumerSinceRef.current.delete(producerInfo.producerId);
                const existingTimeout = videoStallRecoveryTimeoutsRef.current.get(
                  producerInfo.producerId,
                );
                if (existingTimeout != null) {
                  window.clearTimeout(existingTimeout);
                  videoStallRecoveryTimeoutsRef.current.delete(
                    producerInfo.producerId,
                  );
                }
                handleProducerClosed(producerInfo.producerId);
              });
              consumer.track.onmute = handleTrackMuted;
              consumer.track.onunmute = handleTrackUnmuted;
              const stream = new MediaStream([consumer.track]);
              dispatchParticipants({
                type: "UPDATE_STREAM",
                userId: producerInfo.producerUserId,
                kind: response.kind,
                streamType: producerInfo.type,
                stream,
                producerId: producerInfo.producerId,
              });

              if (producerInfo.type === "screen" && response.kind === "video") {
                setActiveScreenShareId(producerInfo.producerId);
              }

              if (existingConsumer && existingConsumer.id !== consumer.id) {
                closeConsumerForSameProducerReconsume(
                  producerInfo.producerId,
                  existingConsumer,
                );
              }

              if (producerInfo.paused) {
                if (isWebcamAudio) {
                  updateMutedState(true);
                } else if (isWebcamVideo) {
                  updateCameraState(true);
                }
              } else if (isWebcamAudio) {
                updateMutedState(false);
              } else if (isWebcamVideo) {
                updateCameraState(false);
              }

              socket.emit(
                "resumeConsumer",
                {
                  consumerId: consumer.id,
                  requestKeyFrame: response.kind === "video",
                },
                () => {},
              );
              resolve();
            } catch (err) {
              console.error("[Meets] Failed to create consumer:", err);
              queueProducerConsumeRetry(producerInfo, 350);
              resolve();
            }
          },
        );
      });
    },
    [
      consumersRef,
      consumeRetryAttemptsRef,
      pendingProducersRef,
      socketRef,
      deviceRef,
      consumerTransportRef,
      producerMapRef,
      dispatchParticipants,
      handleProducerClosed,
      closeConsumerForSameProducerReconsume,
      getReceiveNetworkProfile,
      joinMode,
      queueProducerConsumeRetry,
      setActiveScreenShareId,
      videoStallRecoveryTimeoutsRef,
      staleConsumerRecoveryTimeoutsRef,
      adaptivelyPausedConsumerProducerIdsRef,
      clearStaleConsumerRecoveryTimeout,
      mutedConsumerSinceRef,
      producerPausedStateRef,
      setProducerPausedState,
      announcedRemoteProducersRef,
      userId,
    ],
  );
  consumeProducerRef.current = consumeProducer;

  const recoverStaleConsumer = useCallback(
    async (producerInfo: ProducerInfo, reason: string) => {
      if (consumerRecoveryInFlightRef.current.has(producerInfo.producerId)) {
        return;
      }

      const socket = socketRef.current;
      const transport = consumerTransportRef.current;
      if (!socket?.connected || !transport || transport.closed) {
        console.warn(
          `[Meets] Could not recover stale consumer ${producerInfo.producerId}; retrying consumer later.`,
        );
        queueProducerConsumeRetry(producerInfo, 1200);
        return;
      }

      consumerRecoveryInFlightRef.current.add(producerInfo.producerId);

      try {
        console.warn(
          `[Meets] Recovering stale ${producerInfo.kind} consumer ${producerInfo.producerId}: ${reason}`,
        );
        await consumeProducer(producerInfo, { replaceExisting: true });
      } catch (error) {
        console.error(
          `[Meets] Failed to recover stale consumer ${producerInfo.producerId}:`,
          error,
        );
        queueProducerConsumeRetry(producerInfo, 1200);
      } finally {
        consumerRecoveryInFlightRef.current.delete(producerInfo.producerId);
      }
    },
    [
      consumerRecoveryInFlightRef,
      socketRef,
      consumerTransportRef,
      consumeProducer,
      queueProducerConsumeRetry,
    ],
  );
  recoverStaleConsumerRef.current = recoverStaleConsumer;

  // ----- Video freeze watchdog -----
  // A frozen remote decoder (stuck on a stale reference frame while RTP keeps
  // flowing) is invisible to `track.muted`, so the existing mute-based recovery
  // never fires. Poll each remote VIDEO consumer's getStats every ~2s: if
  // framesDecoded stops advancing while bytesReceived keeps climbing and the
  // producer isn't paused, the decoder is stuck — request a fresh keyframe (PLI)
  // so it un-freezes. One confirmed stalled sample is enough (~2s) because the
  // byte-delta gate proves media is still arriving; a per-consumer cooldown
  // avoids keyframe storms in lossy rooms. Persistent failures still fall
  // through to the existing stale-consumer / producer-sync recovery.
  useEffect(() => {
    const FREEZE_CHECK_MS = 2000;
    const STALL_SAMPLES_BEFORE_PLI = 1;
    const KEYFRAME_REQUEST_COOLDOWN_MS = 3500;
    // Only treat a flat frame count as a freeze when REAL media is still
    // arriving (>~32kbps over the 2s window). A truly frozen decoder still
    // receives full-bitrate RTP from the sender, so a real freeze easily clears
    // this; an idle/static source with only padding/RTX trickle does not — this
    // avoids needless keyframe (PLI) storms on low-activity tiles.
    const MIN_STALL_BYTE_DELTA = 8000;

    const interval = window.setInterval(() => {
      const socket = socketRef.current;
      if (!socket?.connected) return;
      const stats = videoFreezeStatsRef.current;

      consumersRef.current.forEach((consumer, producerId) => {
        const info = producerMapRef.current.get(producerId);
        if (!info || info.kind !== "video") return;
        if (producerPausedStateRef.current.get(producerId)) {
          stats.delete(producerId);
          return;
        }
        const track = consumer.track;
        if (!track || track.readyState !== "live") return;
        const consumerId = consumer.id;

        void consumer
          .getStats()
          .then((report: RTCStatsReport) => {
            // Read framesDecoded + bytesReceived from ONE inbound-rtp video entry
            // (don't mix fields across simulcast layers / entries).
            let framesDecoded: number | null = null;
            let bytesReceived: number | null = null;
            report.forEach((entry) => {
              if (framesDecoded !== null) return;
              const stat = entry as unknown as Record<string, unknown>;
              if (
                stat.type === "inbound-rtp" &&
                (stat.kind === "video" || stat.mediaType === "video") &&
                typeof stat.framesDecoded === "number" &&
                typeof stat.bytesReceived === "number"
              ) {
                framesDecoded = stat.framesDecoded;
                bytesReceived = stat.bytesReceived;
              }
            });
            const decodedNow = framesDecoded;
            const bytesNow = bytesReceived;
            if (decodedNow == null || bytesNow == null) return;

            // getStats was async — the consumer may have been closed/replaced or
            // the producer paused meanwhile. Revalidate before acting.
            const live = consumersRef.current.get(producerId);
            if (!live || live.id !== consumerId) {
              stats.delete(producerId);
              return;
            }
            if (producerPausedStateRef.current.get(producerId)) {
              stats.delete(producerId);
              return;
            }
            if (adaptivelyPausedConsumerProducerIdsRef.current.has(producerId)) {
              stats.delete(producerId);
              return;
            }

            const prev = stats.get(producerId);
            let stalls = 0;
            let lastKeyFrameRequestAt = prev?.lastKeyFrameRequestAt ?? 0;
            if (prev) {
              const decoderStuck =
                decodedNow === prev.frames &&
                bytesNow - prev.bytes >= MIN_STALL_BYTE_DELTA;
              stalls = decoderStuck ? prev.stalls + 1 : 0;
            }

            const sampleNow = Date.now();
            if (
              stalls >= STALL_SAMPLES_BEFORE_PLI &&
              sampleNow - lastKeyFrameRequestAt >= KEYFRAME_REQUEST_COOLDOWN_MS
            ) {
              // Decoder is frozen but real media is flowing → force a keyframe.
              const socket2 = socketRef.current;
              if (socket2?.connected) {
                socket2.emit(
                  "resumeConsumer",
                  { consumerId: live.id, requestKeyFrame: true },
                  () => {},
                );
              }
              lastKeyFrameRequestAt = sampleNow;
              stalls = 0; // give the PLI time to land before re-requesting
            }

            stats.set(producerId, {
              frames: decodedNow,
              bytes: bytesNow,
              stalls,
              lastKeyFrameRequestAt,
            });
          })
          .catch(() => {});
      });

      // Drop tracking for consumers that no longer exist.
      stats.forEach((_value, producerId) => {
        if (!consumersRef.current.has(producerId)) stats.delete(producerId);
      });
    }, FREEZE_CHECK_MS);

    return () => window.clearInterval(interval);
  }, [
    socketRef,
    consumersRef,
    producerMapRef,
    adaptivelyPausedConsumerProducerIdsRef,
    producerPausedStateRef,
    videoFreezeStatsRef,
  ]);

  const syncProducers = useCallback(async () => {
    const socket = socketRef.current;
    const device = deviceRef.current;
    if (!socket || !socket.connected || !device) return;
    if (!currentRoomIdRef.current) return;

    try {
      const producers = await new Promise<ProducerInfo[]>((resolve, reject) => {
        socket.emit(
          "getProducers",
          (response: { producers: ProducerInfo[] } | { error: string }) => {
            if ("error" in response) {
              reject(new Error(response.error));
            } else {
              resolve(response.producers || []);
            }
          },
        );
      });

      const serverProducerIds = new Set(
        producers.map((producer) => producer.producerId),
      );
      for (const producerId of announcedRemoteProducersRef.current.keys()) {
        if (!serverProducerIds.has(producerId)) {
          announcedRemoteProducersRef.current.delete(producerId);
        }
      }

      const staleConsumerIds: string[] = [];
      for (const [producerId, consumer] of consumersRef.current.entries()) {
        if (consumer.closed || consumer.track?.readyState === "ended") {
          staleConsumerIds.push(producerId);
        }
      }

      for (const producerId of staleConsumerIds) {
        handleProducerClosed(producerId);
      }

      for (const producerInfo of producers) {
        setProducerPausedState(
          producerInfo.producerId,
          Boolean(producerInfo.paused),
        );
        if (producerInfo.type !== "webcam") continue;
        if (producerInfo.kind === "audio") {
          dispatchParticipants({
            type: "UPDATE_MUTED",
            userId: producerInfo.producerUserId,
            muted: Boolean(producerInfo.paused),
          });
        } else if (producerInfo.kind === "video") {
          dispatchParticipants({
            type: "UPDATE_CAMERA_OFF",
            userId: producerInfo.producerUserId,
            cameraOff: Boolean(producerInfo.paused),
          });
        }
      }

      for (const producerId of producerMapRef.current.keys()) {
        if (!serverProducerIds.has(producerId)) {
          handleProducerClosed(producerId);
        }
      }

      for (const producerInfo of producers) {
        const consumer = consumersRef.current.get(producerInfo.producerId);
        if (consumer) {
          if (
            adaptivelyPausedConsumerProducerIdsRef.current.has(
              producerInfo.producerId,
            )
          ) {
            mutedConsumerSinceRef.current.delete(producerInfo.producerId);
            clearStaleConsumerRecoveryTimeout(producerInfo.producerId);
            videoFreezeStatsRef.current.delete(producerInfo.producerId);
            continue;
          }

          const track = consumer.track;
          const trackIsStuckMuted =
            track?.readyState === "live" &&
            track.muted &&
            !producerInfo.paused;

          if (trackIsStuckMuted) {
            const mutedSince =
              mutedConsumerSinceRef.current.get(producerInfo.producerId) ??
              Date.now();
            mutedConsumerSinceRef.current.set(producerInfo.producerId, mutedSince);
            socket.emit(
              "resumeConsumer",
              {
                consumerId: consumer.id,
                requestKeyFrame: consumer.kind === "video",
              },
              () => {},
            );
            if (
              Date.now() - mutedSince >= STALE_CONSUMER_RECOVERY_DELAY_MS
            ) {
              void recoverStaleConsumerRef.current(
                producerInfo,
                "producer sync observed muted live track",
              );
            }
            continue;
          }

          mutedConsumerSinceRef.current.delete(producerInfo.producerId);
          clearStaleConsumerRecoveryTimeout(producerInfo.producerId);
          if (!producerInfo.paused) {
            const shouldRequestKeyFrame =
              consumer.kind === "video" &&
              consumer.track?.readyState === "live" &&
              consumer.track.muted;
            if (consumer.paused || shouldRequestKeyFrame) {
              socket.emit(
                "resumeConsumer",
                {
                  consumerId: consumer.id,
                  requestKeyFrame: shouldRequestKeyFrame,
                },
                () => {},
              );
            }
          }
          continue;
        }
        if (pendingProducersRef.current.has(producerInfo.producerId)) continue;
      }

      const consumeTasks: Promise<void>[] = [];
      for (const producerInfo of producers) {
        if (consumersRef.current.has(producerInfo.producerId)) continue;
        if (pendingProducersRef.current.has(producerInfo.producerId)) continue;
        consumeTasks.push(consumeProducer(producerInfo));
      }
      if (consumeTasks.length > 0) {
        await Promise.all(consumeTasks);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "");
      if (/not in a room/i.test(message)) {
        console.warn("[Meets] Producer sync skipped before room join:", {
          roomId: currentRoomIdRef.current,
          socketConnected: socketRef.current?.connected ?? false,
          error: message,
        });
        return;
      }
      console.error("[Meets] Failed to sync producers:", err);
    }
  }, [
    socketRef,
    deviceRef,
    currentRoomIdRef,
    producerMapRef,
    consumersRef,
    pendingProducersRef,
    dispatchParticipants,
    consumeProducer,
    handleProducerClosed,
    setProducerPausedState,
    adaptivelyPausedConsumerProducerIdsRef,
    mutedConsumerSinceRef,
    clearStaleConsumerRecoveryTimeout,
    videoFreezeStatsRef,
    announcedRemoteProducersRef,
  ]);

  const applyWebinarFeedProducers = useCallback(
    async (producers: ProducerInfo[]) => {
      const serverProducerIds = new Set(
        producers.map((producer) => producer.producerId),
      );
      for (const producerId of producerMapRef.current.keys()) {
        if (!serverProducerIds.has(producerId)) {
          handleProducerClosed(producerId);
        }
      }
      await Promise.all(producers.map((producer) => consumeProducer(producer)));
    },
    [consumeProducer, handleProducerClosed, producerMapRef],
  );

  const startProducerSync = useCallback(() => {
    if (producerSyncIntervalRef.current) {
      window.clearInterval(producerSyncIntervalRef.current);
    }
    producerSyncIntervalRef.current = window.setInterval(() => {
      void syncProducers();
    }, PRODUCER_SYNC_INTERVAL_MS);
  }, [producerSyncIntervalRef, syncProducers]);

  const flushPendingProducers = useCallback(async () => {
    if (!pendingProducersRef.current.size) return;
    const pending = Array.from(pendingProducersRef.current.values());
    pendingProducersRef.current.clear();
    await Promise.all(
      pending.map((producerInfo) => consumeProducer(producerInfo)),
    );
  }, [pendingProducersRef, consumeProducer]);

  const recoverActiveMeeting = useCallback(
    (reason: "online" | "foreground") => {
      if (intentionalDisconnectRef.current) return;
      if (!currentRoomIdRef.current) return;

      const socket = socketRef.current;
      const producerState = producerTransportRef.current?.connectionState;
      const consumerState = consumerTransportRef.current?.connectionState;
      const hasTerminalTransportFailure = [producerState, consumerState].some(
        (state) => state === "closed" || state === "failed",
      );

      if (!socket?.connected || hasTerminalTransportFailure) {
        console.log(`[Meets] ${reason} recovery triggered reconnect.`);
        handleReconnectRef.current?.();
        return;
      }

      const disconnectedTransportKinds: Array<"producer" | "consumer"> = [];
      if (producerState === "disconnected") {
        disconnectedTransportKinds.push("producer");
      }
      if (consumerState === "disconnected") {
        disconnectedTransportKinds.push("consumer");
      }

      if (disconnectedTransportKinds.length > 0) {
        console.log(`[Meets] ${reason} recovery restarting ICE.`, {
          transports: disconnectedTransportKinds,
        });
        void Promise.all(
          disconnectedTransportKinds.map((kind) => attemptIceRestart(kind)),
        ).then((results) => {
          if (intentionalDisconnectRef.current) return;
          if (results.every(Boolean)) {
            void syncProducers()
              .then(() => flushPendingProducers())
              .catch((error) => {
                console.warn(
                  `[Meets] ${reason} producer sync failed after ICE restart:`,
                  error,
                );
              });
            return;
          }
          handleReconnectRef.current?.();
        });
        return;
      }

      void syncProducers()
        .then(() => flushPendingProducers())
        .catch((error) => {
          console.warn(`[Meets] ${reason} producer sync failed:`, error);
        });
    },
    [
      consumerTransportRef,
      currentRoomIdRef,
      flushPendingProducers,
      handleReconnectRef,
      attemptIceRestart,
      iceRestartInFlightRef,
      intentionalDisconnectRef,
      producerTransportRef,
      socketRef,
      syncProducers,
    ],
  );

  const joinRoomInternal = useCallback(
    async (
      targetRoomId: string,
      stream: MediaStream | null,
      joinOptions: {
        displayName?: string;
        isGhost: boolean;
        isRecorder?: boolean;
        joinMode: JoinMode;
        webinarInviteCode?: string;
        meetingInviteCode?: string;
      },
    ): Promise<"joined" | "waiting"> => {
      const socket = socketRef.current;
      if (!socket) throw new Error("Socket not connected");

      setWaitingMessage(null);
      setConnectionState("joining");

      return new Promise<"joined" | "waiting">((resolve, reject) => {
        socket.emit(
          "joinRoom",
          {
            roomId: targetRoomId,
            sessionId: sessionIdRef.current,
            displayName: joinOptions.displayName,
            ghost: joinOptions.isGhost,
            webinarInviteCode: joinOptions.webinarInviteCode,
            meetingInviteCode: joinOptions.meetingInviteCode,
          },
          async (response: JoinRoomResponse | JoinRoomErrorResponse) => {
            if ("error" in response) {
              reject(getJoinRoomRedirectError(response) ?? new Error(response.error));
              return;
            }

            if (response.status === "waiting") {
              setConnectionState("waiting");
              setHostUserId(response.hostUserId ?? null);
              setHostUserIds(
                response.hostUserIds ??
                  (response.hostUserId ? [response.hostUserId] : []),
              );
              setMeetingRequiresInviteCode(
                response.meetingRequiresInviteCode ?? false,
              );
              setWebinarRole(response.webinarRole ?? null);
              setWebinarSpeakerUserId(
                response.existingProducers?.[0]?.producerUserId ?? null,
              );
              setWebinarConfig((previous) => ({
                enabled: response.isWebinarEnabled ?? previous?.enabled ?? false,
                publicAccess: previous?.publicAccess ?? false,
                locked: response.webinarLocked ?? previous?.locked ?? false,
                maxAttendees:
                  response.webinarMaxAttendees ??
                  previous?.maxAttendees ??
                  500,
                attendeeCount:
                  response.webinarAttendeeCount ??
                  previous?.attendeeCount ??
                  0,
                requiresInviteCode:
                  response.webinarRequiresInviteCode ??
                  previous?.requiresInviteCode ??
                  false,
                linkSlug: previous?.linkSlug ?? null,
                feedMode: previous?.feedMode ?? "active-speaker",
              }));
              currentRoomIdRef.current = targetRoomId;
              serverRoomIdRef.current = response.roomId ?? targetRoomId;
              setIsTtsDisabled(response.isTtsDisabled ?? false);
              setIsChatLocked(response.isChatLocked ?? false);
              setIsDmEnabled(response.isDmEnabled ?? true);
              resolve("waiting");
              return;
            }

            try {
              const joinedTime = performance.now();
              console.log(
                "[Meets] Joined room, existing producers:",
                response.existingProducers,
              );
              currentRoomIdRef.current = targetRoomId;
              serverRoomIdRef.current = response.roomId ?? targetRoomId;
              setIsRoomLocked(response.isLocked ?? false);
              setMeetingRequiresInviteCode(
                response.meetingRequiresInviteCode ?? false,
              );
              setIsTtsDisabled(response.isTtsDisabled ?? false);
              setIsChatLocked(response.isChatLocked ?? false);
              setIsDmEnabled(response.isDmEnabled ?? true);
              setWebinarRole(response.webinarRole ?? null);
              setWebinarSpeakerUserId(
                response.existingProducers?.[0]?.producerUserId ?? null,
              );
              setWebinarConfig((previous) => ({
                enabled: response.isWebinarEnabled ?? previous?.enabled ?? false,
                publicAccess: previous?.publicAccess ?? false,
                locked: response.webinarLocked ?? previous?.locked ?? false,
                maxAttendees:
                  response.webinarMaxAttendees ??
                  previous?.maxAttendees ??
                  500,
                attendeeCount:
                  response.webinarAttendeeCount ??
                  previous?.attendeeCount ??
                  0,
                requiresInviteCode:
                  response.webinarRequiresInviteCode ??
                  previous?.requiresInviteCode ??
                  false,
                linkSlug: previous?.linkSlug ?? null,
                feedMode: previous?.feedMode ?? "active-speaker",
              }));

              // Use pre-warmed Device if available, otherwise dynamic import
              const DeviceClass = prewarm?.Device
                ? prewarm.Device
                : (await import("mediasoup-client")).Device;

              const device = new DeviceClass();
              await device.load({
                routerRtpCapabilities: response.rtpCapabilities,
              });
              deviceRef.current = device;
              console.log(
                `[Meets] Device loaded in ${(performance.now() - joinedTime).toFixed(0)}ms`,
              );

              const shouldProduce =
                !!stream &&
                !joinOptions.isGhost &&
                !joinOptions.isRecorder &&
                !bypassMediaPermissions &&
                joinOptions.joinMode !== "webinar_attendee";

              await Promise.all([
                shouldProduce
                  ? createProducerTransport(socket, device)
                  : Promise.resolve(),
                createConsumerTransport(socket, device),
              ]);

              const producePromise =
                shouldProduce && stream ? produce(stream) : Promise.resolve();

              const consumePromises = response.existingProducers.map(
                (producer) => consumeProducer(producer),
              );

              await Promise.all([producePromise, ...consumePromises]);
              try {
                await republishScreenShare("reconnect");
              } catch (screenErr) {
                console.warn(
                  "[Meets] Failed to restore screen share after reconnect:",
                  screenErr,
                );
                stopScreenShareCapture();
                setIsScreenSharing(false);
                setActiveScreenShareId(null);
                setMeetError({
                  code: "TRANSPORT_ERROR",
                  message:
                    "Reconnected, but screen sharing could not be restored. Please share again.",
                  recoverable: true,
                });
              }
              await flushPendingProducers();

              setConnectionState("joined");
              setHostUserId(response.hostUserId ?? null);
              setHostUserIds(
                response.hostUserIds ??
                  (response.hostUserId ? [response.hostUserId] : []),
              );
              startProducerSync();
              void syncProducers();
              playNotificationSound("join");
              resolve("joined");
            } catch (err) {
              reject(err);
            }
          },
        );
      });
    },
    [
      socketRef,
      sessionIdRef,
      setWaitingMessage,
      setConnectionState,
      setHostUserId,
      setHostUserIds,
      setMeetingRequiresInviteCode,
      setWebinarConfig,
      setWebinarRole,
      setWebinarSpeakerUserId,
      currentRoomIdRef,
      deviceRef,
      createProducerTransport,
      createConsumerTransport,
      produce,
      consumeProducer,
      flushPendingProducers,
      republishScreenShare,
      stopScreenShareCapture,
      playNotificationSound,
      startProducerSync,
      syncProducers,
      setActiveScreenShareId,
      setIsRoomLocked,
      setIsScreenSharing,
      setMeetError,
      setIsTtsDisabled,
      setIsChatLocked,
      setIsDmEnabled,
    ],
  );

  const connectSocket = useCallback(
    (
      targetRoomId: string,
      options?: { sfuUrlOverride?: string },
    ): Promise<Socket> => {
      return new Promise((resolve, reject) => {
        (async () => {
          try {
            const sfuUrlOverride = normalizeJoinRedirectUrl(
              options?.sfuUrlOverride,
            );
            if (socketRef.current?.connected && !sfuUrlOverride) {
              resolve(socketRef.current);
              return;
            }
            if (socketRef.current) {
              socketRef.current.disconnect();
              socketRef.current = null;
              onSocketReady?.(null);
            }

            setConnectionState("connecting");

            const roomIdForJoin =
              targetRoomId || currentRoomIdRef.current || "";
            if (!roomIdForJoin) {
              throw new Error("Missing room ID");
            }

            const joinStartTime = performance.now();

            const socketIoPromise = prewarm?.io
              ? Promise.resolve({ io: prewarm.io })
              : import("socket.io-client");

            const cachedToken = prewarm?.getCachedToken?.(roomIdForJoin);
            const tokenPromise = cachedToken
              ? Promise.resolve(cachedToken)
                : getJoinInfo(roomIdForJoin, sessionIdRef.current, {
                    user,
                    isHost: isAdmin,
                    joinMode,
                  });

            const [{ token, sfuUrl, iceServers }, { io }] = await Promise.all([
              tokenPromise,
              socketIoPromise,
            ]);
            const socketUrl = sfuUrlOverride ?? sfuUrl;

            if (Array.isArray(iceServers)) {
              const { stunIceServers, turnIceServers } =
                splitIceServersByType(iceServers);
              runtimeStunIceServersRef.current =
                stunIceServers.length > 0 ? stunIceServers : null;
              runtimeTurnIceServersRef.current =
                turnIceServers.length > 0 ? turnIceServers : null;
            }

            const socket = io(socketUrl, {
              transports: ["websocket", "polling"],
              tryAllTransports: true,
              timeout: SOCKET_TIMEOUT_MS,
              reconnection: false,
              auth: { token },
            });

            const connectionTimeout = setTimeout(() => {
              socket.disconnect();
              reject(new Error("Connection timeout"));
            }, SOCKET_CONNECT_TIMEOUT_MS);

            socket.on("connect", () => {
              clearTimeout(connectionTimeout);
              console.log(
                `[Meets] Connected to SFU in ${(performance.now() - joinStartTime).toFixed(0)}ms`,
              );
              setConnectionState("connected");
              setMeetError(null);
              serverRestartNoticeRef.current = null;
              setServerRestartNotice(null);
              reconnectAttemptsRef.current = 0;
              intentionalDisconnectRef.current = false;
              resolve(socket);
            });

            socket.on("disconnect", (reason) => {
              console.log("[Meets] Disconnected:", reason);
              if (intentionalDisconnectRef.current) {
                setConnectionState("disconnected");
                return;
              }

              // A deliberate server-side disconnect (kick / ban / room ended /
              // shutdown) is terminal — don't fight it with reconnect attempts
              // that race the kicked/roomEnded/roomClosed messages. Only
              // transient drops (ping timeout, transport close/error) reconnect.
              if (reason === "io server disconnect") {
                if (serverRestartNoticeRef.current) {
                  if (currentRoomIdRef.current) {
                    handleReconnectRef.current();
                  } else {
                    setConnectionState("disconnected");
                  }
                  return;
                }
                setConnectionState("disconnected");
                return;
              }

              if (currentRoomIdRef.current) {
                handleReconnectRef.current();
              } else {
                setConnectionState("disconnected");
              }
            });

            socket.on("roomClosed", ({ reason }: { reason: string }) => {
              console.log("[Meets] Room closed:", reason);
              setMeetError({
                code: "UNKNOWN",
                message: `Room closed: ${reason}`,
                recoverable: false,
              });
              setWaitingMessage(null);
              cleanup();
            });

            // Host ended the meeting (admin:endRoom). The SFU emits roomEnded to
            // everyone (incl. pending) then disconnects them; without this the
            // client just went silently dark. Tear down + show a terminal notice.
            socket.on(
              "roomEnded",
              ({ message }: { message?: string }) => {
                console.log("[Meets] Room ended by host");
                setMeetError({
                  code: "UNKNOWN",
                  message: message || "The host ended the meeting.",
                  recoverable: false,
                });
                setWaitingMessage(null);
                cleanup();
              },
            );

            socket.on("connect_error", (err) => {
              clearTimeout(connectionTimeout);
              console.error("[Meets] Connection error:", err);
              const reconnectFailure = describeReconnectFailure(err);
              setMeetError({
                code: "CONNECTION_FAILED",
                message: reconnectFailure,
                recoverable: true,
              });
              setConnectionState("error");
              reject(err);
            });

            socket.on(
              "hostAssigned",
              ({
                roomId: eventRoomId,
                hostUserId,
              }: {
                roomId?: string;
                hostUserId?: string | null;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setIsAdmin(true);
                setHostUserId(hostUserId ?? userId);
                setHostUserIds((prev) => {
                  const next = new Set(prev);
                  next.add(userId);
                  return Array.from(next);
                });
                setWaitingMessage(null);
              },
            );

            socket.on(
              "serverRestarting",
              (notification: ServerRestartNotification) => {
                if (!isRoomEvent(notification?.roomId)) return;
                const message = notification?.message?.trim();
                const notice = message || DEFAULT_SERVER_RESTART_NOTICE;
                serverRestartNoticeRef.current = notice;
                setServerRestartNotice(notice);
              },
            );

            socket.on("adminNotice", (notification: AdminNoticeNotification) => {
              if (!isRoomEvent(notification?.roomId)) return;
              const message = notification?.message?.trim();
              if (!message) return;

              const level =
                notification.level === "warning" || notification.level === "error"
                  ? notification.level
                  : "info";

              if (adminNoticeTimeoutRef.current) {
                window.clearTimeout(adminNoticeTimeoutRef.current);
              }
              setAdminNotice({
                ...notification,
                message,
                level,
                timestamp: notification.timestamp ?? Date.now(),
              });
              adminNoticeTimeoutRef.current = window.setTimeout(() => {
                adminNoticeTimeoutRef.current = null;
                setAdminNotice(null);
              }, ADMIN_NOTICE_DURATION_MS);

              telemetry.capture("meet_admin_notice_received", {
                roomId: notification.roomId,
                level,
              });
            });

            socket.on(
              "consumerTelemetry",
              (notification: ConsumerTelemetryPayload) => {
                if (!isRoomEvent(notification?.roomId)) return;
                if (
                  !notification?.producerId ||
                  !notification.consumerId ||
                  (notification.kind !== "audio" &&
                    notification.kind !== "video")
                ) {
                  return;
                }

                if (notification.event === "closed") {
                  consumerTelemetryRef.current.delete(notification.producerId);
                  return;
                }

                consumerTelemetryRef.current.set(notification.producerId, {
                  ...notification,
                  receivedAt: Date.now(),
                });
              },
            );

            socket.on(
              "hostChanged",
              ({
                roomId: eventRoomId,
                hostUserId,
              }: {
                roomId?: string;
                hostUserId?: string | null;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setHostUserId(hostUserId ?? null);
              },
            );

            socket.on(
              "adminUsersChanged",
              ({
                roomId: eventRoomId,
                hostUserIds,
              }: {
                roomId?: string;
                hostUserIds?: string[];
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setHostUserIds(Array.isArray(hostUserIds) ? hostUserIds : []);
              },
            );

            socket.on("newProducer", async (data: ProducerInfo) => {
              console.log("[Meets] New producer:", data);
              setProducerPausedState(data.producerId, Boolean(data.paused));
              if (data.producerUserId === userId) {
                return;
              }
              if (joinMode === "webinar_attendee") {
                void syncProducers();
                return;
              }
              announcedRemoteProducersRef.current.set(data.producerId, data);
              await consumeProducer(data);
            });

            socket.on(
              "producerClosed",
              ({
                producerId,
                producerUserId,
              }: {
                producerId: string;
                producerUserId?: string;
              }) => {
                console.log("[Meets] Producer closed:", producerId);
                const localAudioProducer = audioProducerRef.current;
                const localVideoProducer = videoProducerRef.current;
                const localScreenProducer = screenProducerRef.current;
                const matchesLocalProducer =
                  localAudioProducer?.id === producerId ||
                  localVideoProducer?.id === producerId ||
                  localScreenProducer?.id === producerId;
                const wasIntentionalLocalClose =
                  intentionalLocalProducerCloseIdsRef.current.delete(producerId);

                if (
                  wasIntentionalLocalClose &&
                  (producerUserId === userId ||
                    producerUserId == null ||
                    matchesLocalProducer)
                ) {
                  console.debug(
                    "[Meets] Ignoring intentional local producer close:",
                    producerId,
                  );
                  if (localAudioProducer?.id === producerId) {
                    try {
                      localAudioProducer.close();
                    } catch {}
                    if (audioProducerRef.current?.id === producerId) {
                      audioProducerRef.current = null;
                    }
                  }
                  if (localVideoProducer?.id === producerId) {
                    try {
                      localVideoProducer.close();
                    } catch {}
                    if (videoProducerRef.current?.id === producerId) {
                      videoProducerRef.current = null;
                    }
                  }
                  if (localScreenProducer?.id === producerId) {
                    try {
                      localScreenProducer.close();
                    } catch {}
                    if (screenProducerRef.current?.id === producerId) {
                      screenProducerRef.current = null;
                    }
                  }
                  return;
                }

                if (
                  producerUserId === userId ||
                  (producerUserId == null && matchesLocalProducer)
                ) {
                  if (localAudioProducer?.id === producerId) {
                    try {
                      localAudioProducer.close();
                    } catch {}
                    if (audioProducerRef.current?.id === producerId) {
                      audioProducerRef.current = null;
                    }
                    const liveAudioTrack = getFirstLiveTrack(
                      localStreamRef.current?.getAudioTracks() ?? [],
                    );
                    const shouldRecoverAudio = !isMutedRef.current;
                    if (shouldRecoverAudio) {
                      if (liveAudioTrack) {
                        liveAudioTrack.enabled = true;
                      }
                      isMutedRef.current = false;
                      setIsMuted(false);
                      requestAudioProducerRecovery();
                      return;
                    }
                    localStreamRef.current?.getAudioTracks().forEach((track) => {
                      track.enabled = false;
                    });
                    isMutedRef.current = true;
                    setIsMuted(true);
                    return;
                  }

                  if (localVideoProducer?.id === producerId) {
                    try {
                      localVideoProducer.close();
                    } catch {}
                    if (videoProducerRef.current?.id === producerId) {
                      videoProducerRef.current = null;
                    }
                    const currentStream = localStreamRef.current;
                    const requestedTrack =
                      getVideoPublishTrack?.(currentStream) ?? null;
                    const liveVideoTrack =
                      requestedTrack?.readyState === "live"
                        ? requestedTrack
                        : getFirstLiveTrack(
                            currentStream?.getVideoTracks() ?? [],
                          );
                    const shouldRecoverCamera =
                      !isCameraOffRef.current;
                    if (shouldRecoverCamera) {
                      if (liveVideoTrack) {
                        liveVideoTrack.enabled = true;
                      }
                      isCameraOffRef.current = false;
                      setIsCameraOff(false);
                      requestCameraProducerRecovery();
                      return;
                    }
                    isCameraOffRef.current = true;
                    setIsCameraOff(true);
                    return;
                  }

                  if (localScreenProducer?.id === producerId) {
                    try {
                      localScreenProducer.close();
                    } catch {}
                    const localScreenAudioProducer = screenAudioProducerRef.current;
                    if (localScreenAudioProducer) {
                      emitCloseProducer(localScreenAudioProducer.id);
                      try {
                        localScreenAudioProducer.close();
                      } catch {}
                      if (localScreenAudioProducer.track) {
                        localScreenAudioProducer.track.onended = null;
                      }
                      screenAudioProducerRef.current = null;
                    }
                    if (screenProducerRef.current?.id === producerId) {
                      screenProducerRef.current = null;
                    }
                    stopScreenShareCapture();
                    setIsScreenSharing(false);
                    setActiveScreenShareId(null);
                    return;
                  }
                }

                handleProducerClosed(producerId);
              },
            );

            socket.on(
              "userJoined",
              ({
                userId: joinedUserId,
                displayName,
                isGhost,
              }: {
                userId: string;
                displayName?: string;
                isGhost?: boolean;
              }) => {
                console.log("[Meets] User joined:", joinedUserId);
                if (joinedUserId === userId) {
                  return;
                }
                if (shouldPlayJoinLeaveSound("join", joinedUserId)) {
                  playNotificationSound("join");
                }
                if (displayName) {
                  setDisplayNames((prev) => {
                    const next = new Map(prev);
                    next.set(joinedUserId, displayName);
                    return next;
                  });
                }
                const leaveTimeout = leaveTimeoutsRef.current.get(joinedUserId);
                if (leaveTimeout) {
                  window.clearTimeout(leaveTimeout);
                  leaveTimeoutsRef.current.delete(joinedUserId);
                }
                clearParticipantConnectionStatus(joinedUserId);
                dispatchParticipants({
                  type: "ADD_PARTICIPANT",
                  userId: joinedUserId,
                  isGhost,
                });
              },
            );

            socket.on(
              "userLeft",
              ({ userId: leftUserId }: { userId: string }) => {
                console.log("[Meets] User left:", leftUserId);
                if (
                  leftUserId !== userId &&
                  shouldPlayJoinLeaveSound("leave", leftUserId)
                ) {
                  playNotificationSound("leave");
                }
                setDisplayNames((prev) => {
                  if (!prev.has(leftUserId)) return prev;
                  const next = new Map(prev);
                  next.delete(leftUserId);
                  return next;
                });
                clearParticipantConnectionStatus(leftUserId);

                const producersToClose = Array.from(
                  producerMapRef.current.entries(),
                )
                  .filter(([, info]) => info.userId === leftUserId)
                  .map(([producerId]) => producerId);

                for (const [producerId, info] of pendingProducersRef.current) {
                  if (info.producerUserId === leftUserId) {
                    pendingProducersRef.current.delete(producerId);
                  }
                }

                for (const producerId of producersToClose) {
                  handleProducerClosed(producerId);
                }

                dispatchParticipants({
                  type: "MARK_LEAVING",
                  userId: leftUserId,
                });

                scheduleParticipantRemoval(leftUserId);
              },
            );

            socket.on(
              "participantConnectionState",
              (payload: {
                userId?: string;
                roomId?: string;
                state?: ParticipantConnectionStatus["state"];
                reason?: string;
                graceMs?: number;
                downtimeMs?: number;
                updatedAt?: number;
              }) => {
                if (!isRoomEvent(payload?.roomId)) return;
                const targetUserId = payload?.userId;
                if (!targetUserId || targetUserId === userId) return;

                const state = payload?.state;
                if (state !== "reconnecting" && state !== "reconnected") {
                  return;
                }

                applyParticipantConnectionStatus(targetUserId, {
                  state,
                  reason:
                    typeof payload.reason === "string"
                      ? payload.reason
                      : undefined,
                  graceMs:
                    typeof payload.graceMs === "number"
                      ? payload.graceMs
                      : undefined,
                  downtimeMs:
                    typeof payload.downtimeMs === "number"
                      ? payload.downtimeMs
                      : undefined,
                  updatedAt:
                    typeof payload.updatedAt === "number"
                      ? payload.updatedAt
                      : Date.now(),
                });

                telemetry.capture("meet_participant_connection_state", {
                  roomId: payload.roomId,
                  userId: targetUserId,
                  state,
                  reason: payload.reason,
                  downtimeMs: payload.downtimeMs,
                });
              },
            );

            socket.on(
              "displayNameSnapshot",
              ({
                users,
                roomId: eventRoomId,
              }: {
                users: { userId: string; displayName?: string }[];
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                const snapshot = new Map<string, string>();
                const nextParticipantIds = new Set<string>([userId]);
                const previousParticipantIds = participantIdsRef.current;
                (users || []).forEach(
                  ({ userId: snapshotUserId, displayName }) => {
                    if (displayName) {
                      snapshot.set(snapshotUserId, displayName);
                    }
                    if (snapshotUserId !== userId) {
                      if (!isSystemUserId(snapshotUserId)) {
                        nextParticipantIds.add(snapshotUserId);
                      }
                      const leaveTimeout =
                        leaveTimeoutsRef.current.get(snapshotUserId);
                      if (leaveTimeout) {
                        window.clearTimeout(leaveTimeout);
                        leaveTimeoutsRef.current.delete(snapshotUserId);
                      }
                      clearParticipantConnectionStatus(snapshotUserId);
                      dispatchParticipants({
                        type: "ADD_PARTICIPANT",
                        userId: snapshotUserId,
                      });
                    }
                  },
                );
                for (const previousUserId of previousParticipantIds) {
                  if (
                    previousUserId === userId ||
                    nextParticipantIds.has(previousUserId)
                  ) {
                    continue;
                  }
                  const leaveTimeout = leaveTimeoutsRef.current.get(previousUserId);
                  if (leaveTimeout) {
                    window.clearTimeout(leaveTimeout);
                    leaveTimeoutsRef.current.delete(previousUserId);
                  }
                  clearParticipantConnectionStatus(previousUserId);
                  const producersToClose = Array.from(
                    producerMapRef.current.entries(),
                  )
                    .filter(([, info]) => info.userId === previousUserId)
                    .map(([producerId]) => producerId);
                  for (const [producerId, info] of pendingProducersRef.current) {
                    if (info.producerUserId === previousUserId) {
                      pendingProducersRef.current.delete(producerId);
                    }
                  }
                  for (const producerId of producersToClose) {
                    handleProducerClosed(producerId);
                  }
                  dispatchParticipants({
                    type: "REMOVE_PARTICIPANT",
                    userId: previousUserId,
                  });
                }
                participantIdsRef.current = nextParticipantIds;
                setDisplayNames(snapshot);
              },
            );

            socket.on(
              "handRaisedSnapshot",
              ({ users, roomId: eventRoomId }: HandRaisedSnapshot) => {
                if (!isRoomEvent(eventRoomId)) return;
                (users || []).forEach(({ userId: raisedUserId, raised }) => {
                  if (raisedUserId === userId) {
                    setIsHandRaised(raised);
                    return;
                  }
                  dispatchParticipants({
                    type: "UPDATE_HAND_RAISED",
                    userId: raisedUserId,
                    raised,
                  });
                });
              },
            );

            socket.on(
              "chatHistorySnapshot",
              ({ messages, roomId: eventRoomId }: ChatHistorySnapshot) => {
                if (!isRoomEvent(eventRoomId)) return;
                if (!Array.isArray(messages) || messages.length === 0) return;
                // Only seed messages this client is allowed to see. The server
                // already excludes DMs from history, but mirror the live-path
                // visibility rule defensively in case that ever changes.
                const visible = messages.filter(
                  (message) =>
                    !message.isDirect ||
                    message.userId === userId ||
                    message.dmTargetUserId === userId,
                );
                if (visible.length === 0) return;
                chat.setChatMessages((prev) => {
                  const seen = new Set(prev.map((message) => message.id));
                  const seeded = [...prev];
                  for (const message of visible) {
                    if (seen.has(message.id)) continue;
                    seen.add(message.id);
                    seeded.push(normalizeChatMessage(message).message);
                  }
                  seeded.sort((a, b) => a.timestamp - b.timestamp);
                  return seeded;
                });
              },
            );

            socket.on(
              "displayNameUpdated",
              ({
                userId: updatedUserId,
                displayName,
                roomId: eventRoomId,
              }: {
                userId: string;
                displayName: string;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setDisplayNames((prev) => {
                  const next = new Map(prev);
                  next.set(updatedUserId, displayName);
                  return next;
                });
              },
            );

            socket.on(
              "participantMuted",
              ({
                userId: mutedUserId,
                muted,
                roomId: eventRoomId,
              }: {
                userId: string;
                muted: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                if (mutedUserId === userId) {
                  setIsMuted(muted);
                  return;
                }
                dispatchParticipants({
                  type: "UPDATE_MUTED",
                  userId: mutedUserId,
                  muted,
                });
                setProducerPausedByUser(mutedUserId, "audio", muted);
              },
            );

            socket.on(
              "participantCameraOff",
              ({
                userId: camUserId,
                cameraOff,
                roomId: eventRoomId,
              }: {
                userId: string;
                cameraOff: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                if (camUserId === userId) {
                  setIsCameraOff(cameraOff);
                  return;
                }
                dispatchParticipants({
                  type: "UPDATE_CAMERA_OFF",
                  userId: camUserId,
                  cameraOff,
                });
                setProducerPausedByUser(camUserId, "video", cameraOff);
              },
            );

            socket.on(
              "admin:mediaEnforced",
              (payload: {
                roomId?: string;
                userId?: string;
                reason?: string;
                kind?: "audio" | "video";
                type?: ProducerType;
                producerId?: string;
                producers?: Array<{
                  producerId: string;
                  kind: "audio" | "video";
                  type: ProducerType;
                }>;
              }) => {
                if (!isRoomEvent(payload?.roomId)) return;
                if (payload?.userId !== userId) return;

                const enforced =
                  payload?.producers && payload.producers.length > 0
                    ? payload.producers
                    : payload?.producerId && payload.kind && payload.type
                      ? [
                          {
                            producerId: payload.producerId,
                            kind: payload.kind,
                            type: payload.type,
                          },
                        ]
                      : [];

                for (const entry of enforced) {
                  if (entry.kind === "audio" && entry.type === "webcam") {
                    const producer = audioProducerRef.current;
                    if (producer?.id === entry.producerId) {
                      try {
                        producer.close();
                      } catch {}
                      if (audioProducerRef.current?.id === entry.producerId) {
                        audioProducerRef.current = null;
                      }
                    }
                    localStreamRef.current?.getAudioTracks().forEach((track) => {
                      track.enabled = false;
                    });
                    setIsMuted(true);
                  } else if (entry.kind === "video" && entry.type === "webcam") {
                    const producer = videoProducerRef.current;
                    if (producer?.id === entry.producerId) {
                      try {
                        producer.close();
                      } catch {}
                      if (videoProducerRef.current?.id === entry.producerId) {
                        videoProducerRef.current = null;
                      }
                    }
                    localStreamRef.current?.getVideoTracks().forEach((track) => {
                      stopLocalTrack(track);
                    });
                    setLocalStream((prev) => {
                      if (!prev) return prev;
                      const remaining = prev
                        .getTracks()
                        .filter((track) => track.kind !== "video");
                      return new MediaStream(remaining);
                    });
                    setIsCameraOff(true);
                  } else if (entry.type === "screen" && entry.kind === "video") {
                    const producer = screenProducerRef.current;
                    if (producer?.id === entry.producerId) {
                      try {
                        producer.close();
                      } catch {}
                      if (screenProducerRef.current?.id === entry.producerId) {
                        screenProducerRef.current = null;
                      }
                    }
                    const audioProducer = screenAudioProducerRef.current;
                    if (audioProducer) {
                      emitCloseProducer(audioProducer.id);
                      try {
                        audioProducer.close();
                      } catch {}
                      if (audioProducer.track) {
                        audioProducer.track.onended = null;
                      }
                      if (screenAudioProducerRef.current?.id === audioProducer.id) {
                        screenAudioProducerRef.current = null;
                      }
                    }
                    stopScreenShareCapture();
                    setIsScreenSharing(false);
                    setActiveScreenShareId(null);
                  }
                }

                if (enforced.length > 0) {
                  setMeetError({
                    code: "TRANSPORT_ERROR",
                    message:
                      payload.reason?.trim() ||
                      "Your media was changed by host moderation.",
                    recoverable: true,
                  });
                }
              },
            );

            socket.on(
              "admin:bulkMediaEnforced",
              (payload: {
                roomId?: string;
                reason?: string;
                users?: string[];
              }) => {
                if (!isRoomEvent(payload?.roomId)) return;
                if (!payload?.users?.includes(userId)) return;
                setMeetError({
                  code: "TRANSPORT_ERROR",
                  message:
                    payload.reason?.trim() ||
                    "Your media was changed by host moderation.",
                  recoverable: true,
                });
              },
            );

            socket.on(
              "setVideoQuality",
              async ({ quality }: { quality: VideoQuality }) => {
                console.log(`[Meets] Setting video quality to: ${quality}`);
                const previousQuality = videoQualityRef.current;
                videoQualityRef.current = quality;
                setNetworkManagedVideoQuality(quality);
                try {
                  await updateVideoQualityRef.current(quality);
                } catch (error) {
                  videoQualityRef.current = previousQuality;
                  setNetworkManagedVideoQuality(previousQuality);
                  console.warn("[Meets] Failed to apply SFU video quality:", error);
                }
              },
            );

            socket.on("chatMessage", (message: ChatMessage) => {
              console.log("[Meets] Chat message received:", message);
              const { message: normalized, ttsText } =
                normalizeChatMessage(message);
              chat.setChatMessages((prev) => [...prev, normalized]);
              if (normalized.userId !== userId) {
                chat.setChatOverlayMessages((prev) => [...prev, normalized]);
                setTimeout(() => {
                  chat.setChatOverlayMessages((prev) =>
                    prev.filter((m) => m.id !== normalized.id),
                  );
                }, 5000);
              }
              if (ttsText && !isTtsDisabledRef.current) {
                onTtsMessage?.({
                  userId: normalized.userId,
                  displayName: normalized.displayName,
                  text: ttsText,
                });
              }
              if (!chat.isChatOpenRef.current) {
                chat.setUnreadCount((prev) => prev + 1);
              }
            });

            socket.on("reaction", (reaction: ReactionNotification) => {
              if (reaction.kind && reaction.value) {
                addReaction({
                  userId: reaction.userId,
                  kind: reaction.kind,
                  value: reaction.value,
                  label: reaction.label,
                  timestamp: reaction.timestamp,
                });
                return;
              }

              if (reaction.emoji) {
                addReaction({
                  userId: reaction.userId,
                  kind: "emoji",
                  value: reaction.emoji,
                  timestamp: reaction.timestamp,
                });
              }
            });

            socket.on(
              "handRaised",
              ({ userId: raisedUserId, raised }: HandRaisedNotification) => {
                if (raisedUserId === userId) {
                  setIsHandRaised(raised);
                  return;
                }
                dispatchParticipants({
                  type: "UPDATE_HAND_RAISED",
                  userId: raisedUserId,
                  raised,
                });
              },
            );

            socket.on("kicked", () => {
              cleanup();
              setMeetError({
                code: "UNKNOWN",
                message: "You have been kicked from the meeting.",
                recoverable: false,
              });
            });

            socket.on(
              "redirect",
              async ({ newRoomId }: { newRoomId: string }) => {
                console.log(
                  `[Meets] Redirect received. Initiating full switch to ${newRoomId}`,
                );
                handleRedirectRef.current(newRoomId);
              },
            );

            socket.on(
              "userRequestedJoin",
              ({
                userId,
                displayName,
                roomId: eventRoomId,
              }: {
                userId: string;
                displayName: string;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.log("[Meets] User requesting to join:", userId);
                playNotificationSound("waiting");
                setPendingUsers((prev) => {
                  const newMap = new Map(prev);
                  newMap.set(userId, displayName);
                  return newMap;
                });
              },
            );

            socket.on(
              "pendingUsersSnapshot",
              ({
                users,
                roomId: eventRoomId,
              }: {
                users: { userId: string; displayName?: string }[];
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                const snapshot = new Map(
                  (users || []).map(({ userId, displayName }) => [
                    userId,
                    displayName || userId,
                  ]),
                );
                setPendingUsers(snapshot);
              },
            );

            socket.on(
              "userAdmitted",
              ({
                userId,
                roomId: eventRoomId,
              }: {
                userId: string;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setPendingUsers((prev) => {
                  const newMap = new Map(prev);
                  newMap.delete(userId);
                  return newMap;
                });
              },
            );

            socket.on(
              "userRejected",
              ({
                userId,
                roomId: eventRoomId,
              }: {
                userId: string;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setPendingUsers((prev) => {
                  const newMap = new Map(prev);
                  newMap.delete(userId);
                  return newMap;
                });
              },
            );

            socket.on(
              "pendingUserLeft",
              ({
                userId,
                roomId: eventRoomId,
              }: {
                userId: string;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setPendingUsers((prev) => {
                  const newMap = new Map(prev);
                  newMap.delete(userId);
                  return newMap;
                });
              },
            );

            socket.on("joinApproved", async () => {
              console.log("[Meets] Join approved! Re-attempting join...");
              const joinOptions = joinOptionsRef.current;
              let stream = localStreamRef.current;
              const mediaNeeds = getJoinMediaNeeds(stream);
              const shouldRequestMedia =
                !joinOptions.isGhost &&
                !joinOptions.isRecorder &&
                joinOptions.joinMode !== "webinar_attendee" &&
                !bypassMediaPermissions &&
                (mediaNeeds.needsAudio || mediaNeeds.needsVideo);

              if (shouldRequestMedia) {
                stream = await ensureLiveLocalMediaForJoin(
                  stream,
                  joinOptions,
                  "join approval",
                );
              }
              if (
                currentRoomIdRef.current &&
                (stream ||
                  !shouldRequestMedia ||
                  joinOptions.isGhost ||
                  joinOptions.isRecorder ||
                  bypassMediaPermissions ||
                  joinOptions.joinMode === "webinar_attendee")
              ) {
                joinRoomInternal(
                  currentRoomIdRef.current,
                  stream,
                  joinOptions,
                )
                  .then((joinResult) => {
                    if (joinResult === "joined") {
                      prejoinMediaIntentRef.current = null;
                    }
                  })
                  .catch(console.error);
              } else {
                console.error(
                  "[Meets] Cannot re-join: missing room ID or local stream",
                  {
                    roomId: currentRoomIdRef.current,
                    stream: summarizeStreamForLog(localStreamRef.current),
                    isGhost: joinOptionsRef.current.isGhost,
                    bypassMediaPermissions,
                  },
                );
              }
            });

            socket.on("joinRejected", () => {
              console.log("[Meets] Join rejected.");
              setMeetError({
                code: "PERMISSION_DENIED",
                message: "The host has denied your request to join.",
                recoverable: false,
              });
              setConnectionState("error");
              setWaitingMessage(null);
              cleanup();
            });

            socket.on(
              "waitingRoomStatus",
              ({
                message,
                roomId: eventRoomId,
              }: {
                message: string;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setWaitingMessage(message);
              },
            );

            socket.on(
              "roomLockChanged",
              ({
                locked,
                roomId: eventRoomId,
              }: {
                locked: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.log("[Meets] Room lock changed:", locked);
                setIsRoomLocked(locked);
              },
            );

            socket.on(
              "ttsDisabledChanged",
              ({
                disabled,
                roomId: eventRoomId,
              }: {
                disabled: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.log("[Meets] Room TTS disabled changed:", disabled);
                setIsTtsDisabled(disabled);
              },
            );

            socket.on(
              "dmStateChanged",
              ({
                enabled,
                roomId: eventRoomId,
              }: {
                enabled: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.log("[Meets] Room DM state changed:", enabled);
                setIsDmEnabled(enabled);
              },
            );

            socket.on(
              "noGuestsChanged",
              ({
                noGuests,
                roomId: eventRoomId,
              }: {
                noGuests: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.log("[Meets] No-guests changed:", noGuests);
                setIsNoGuests(noGuests);
              }
            );

            socket.on(
              "chatLockChanged",
              ({
                locked,
                roomId: eventRoomId,
              }: {
                locked: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.log("[Meets] Chat lock changed:", locked);
                setIsChatLocked(locked);
              }
            );

            socket.on(
              "meeting:configChanged",
              (nextConfig: MeetingConfigSnapshot) => {
                setMeetingRequiresInviteCode(
                  Boolean(nextConfig.requiresInviteCode),
                );
              },
            );

            socket.on(
              "webinar:configChanged",
              (nextConfig: WebinarConfigSnapshot) => {
                setWebinarConfig(nextConfig);
              },
            );

            socket.on(
              "webinar:attendeeCountChanged",
              ({
                attendeeCount,
                maxAttendees,
                roomId: eventRoomId,
              }: {
                attendeeCount: number;
                maxAttendees: number;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setWebinarConfig((previous) => ({
                  enabled: previous?.enabled ?? false,
                  publicAccess: previous?.publicAccess ?? false,
                  locked: previous?.locked ?? false,
                  maxAttendees: maxAttendees ?? previous?.maxAttendees ?? 500,
                  attendeeCount:
                    attendeeCount ?? previous?.attendeeCount ?? 0,
                  requiresInviteCode: previous?.requiresInviteCode ?? false,
                  linkSlug: previous?.linkSlug ?? null,
                  feedMode: previous?.feedMode ?? "active-speaker",
                }));
              },
            );

            socket.on(
              "webinar:feedChanged",
              (notification: WebinarFeedChangedNotification) => {
                if (joinMode !== "webinar_attendee") return;
                if (!isRoomEvent(notification.roomId)) return;
                setWebinarSpeakerUserId(
                  notification.speakerUserId ??
                    notification.producers?.[0]?.producerUserId ??
                    null,
                );
                void applyWebinarFeedProducers(notification.producers).finally(() => {
                  void syncProducers();
                });
              },
            );

            socketRef.current = socket;
            onSocketReady?.(socket);
          } catch (err) {
            console.error("Failed to get join info:", err);
            const reconnectFailure = describeReconnectFailure(err);
            const isRecoverable = isRecoverableReconnectFailure(err);
            setMeetError({
              code: "CONNECTION_FAILED",
              message: reconnectFailure,
              recoverable: isRecoverable,
            });
            setConnectionState("error");
            reject(err);
          }
        })();
      });
    },
    [
      addReaction,
      audioProducerRef,
      cleanup,
      consumeProducer,
      currentRoomIdRef,
      deviceRef,
      dispatchParticipants,
      emitCloseProducer,
      handleLocalTrackEnded,
      handleProducerClosed,
      handleRedirectRef,
      handleReconnectRef,
      applyParticipantConnectionStatus,
      ensureLiveLocalMediaForJoin,
      getVideoPublishTrack,
      getJoinInfo,
      getJoinMediaNeeds,
      joinMode,
      isCameraOff,
      isMuted,
      isAdmin,
      setIsAdmin,
      isRoomEvent,
      joinOptionsRef,
      joinRoomInternal,
      leaveTimeoutsRef,
      clearParticipantConnectionStatus,
      localStream,
      localStreamRef,
      prejoinMediaIntentRef,
      pendingProducersRef,
      playNotificationSound,
      shouldPlayJoinLeaveSound,
      applyWebinarFeedProducers,
      producerMapRef,
      requestAudioProducerRecovery,
      requestCameraProducerRecovery,
      reconnectAttemptsRef,
      screenAudioProducerRef,
      screenProducerRef,
      setActiveScreenShareId,
      setConnectionState,
      setDisplayNames,
      setIsCameraOff,
      setIsMuted,
      setIsScreenSharing,
      setIsHandRaised,
      setIsRoomLocked,
      setMeetingRequiresInviteCode,
      setIsTtsDisabled,
      setIsDmEnabled,
      setHostUserId,
      setWebinarRole,
      setWebinarSpeakerUserId,
      setWebinarConfig,
      setServerRestartNotice,
      setAdminNotice,
      setLocalStream,
      setMeetError,
      setPendingUsers,
      setWaitingMessage,
      setNetworkManagedVideoQuality,
      socketRef,
      stopScreenShareCapture,
      stopLocalTrack,
      syncProducers,
      setProducerPausedState,
      setProducerPausedByUser,
      updateVideoQualityRef,
      user,
      userId,
      onTtsMessage,
      onSocketReady,
    ],
  );

  const handleReconnect = useCallback(async (options?: { immediate?: boolean }) => {
    if (reconnectInFlightRef.current) {
      const cancelBackoff = reconnectBackoffCancelRef.current;
      manualReconnectRetryRequestedRef.current = true;
      if (
        options?.immediate === true &&
        reconnectPhaseRef.current === "waiting" &&
        cancelBackoff
      ) {
        updateReconnectRecoveryStatus((current) =>
          buildReconnectRecoveryStatus(
            "connecting",
            1,
            "Retrying reconnect now.",
            current?.lastError ?? null,
          ),
        );
        cancelBackoff();
        return;
      }

      updateReconnectRecoveryStatus((current) =>
        current
          ? {
              ...current,
              message: "Finishing the current reconnect step before retrying.",
              retryAt: null,
              updatedAt: Date.now(),
            }
          : buildReconnectRecoveryStatus(
              "connecting",
              Math.max(1, reconnectAttemptsRef.current),
              "Reconnect is already in progress.",
            ),
      );
      return;
    }
    const reconnectGeneration = reconnectGenerationRef.current;
    let skipNextDelay = options?.immediate === true;
    let lastReconnectError: unknown = null;
    reconnectInFlightRef.current = true;
    setMeetError(null);

    try {
      while (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        if (reconnectGeneration !== reconnectGenerationRef.current) return;
        // A terminal event (kick / ban / roomEnded / roomClosed / explicit
        // leave) sets intentionalDisconnectRef via cleanup(). If it lands while
        // this loop is already retrying a transient drop, stop fighting it —
        // otherwise we'd briefly re-enter the call and then clobber the terminal
        // notice ("The host ended the meeting.") with "Failed to reconnect".
        if (intentionalDisconnectRef.current) return;
        const shouldSurfaceReconnectState =
          !shouldDeferTransportRecoveryUntilVisible();
        if (shouldSurfaceReconnectState) {
          setConnectionState("reconnecting");
        } else {
          console.info(
            "[Meets] Background reconnect in progress; preserving joined UI state.",
          );
        }
        const attempt = reconnectAttemptsRef.current + 1;
        const delay = skipNextDelay
          ? 0
          : RECONNECT_DELAY_MS * 2 ** (attempt - 1);
        skipNextDelay = false;
        reconnectAttemptsRef.current = attempt;

        if (shouldSurfaceReconnectState) {
          const retryAt = delay > 0 ? Date.now() + delay : null;
          updateReconnectRecoveryStatus(
            buildReconnectRecoveryStatus(
              delay > 0 ? "waiting" : "connecting",
              attempt,
              delay > 0
                ? "Retrying automatically."
                : "Retrying reconnect now.",
              lastReconnectError
                ? describeReconnectFailure(lastReconnectError)
                : null,
              retryAt,
            ),
          );
        }

        console.log(
          `[Meets] Reconnecting in ${delay}ms (attempt ${attempt})`,
        );
        telemetry.capture("meet_reconnect_attempt", {
          roomId: currentRoomIdRef.current ?? undefined,
          attempt,
          maxAttempts: MAX_RECONNECT_ATTEMPTS,
          usingTurnFallback: useTurnFallbackRef.current,
        });
        if (delay > 0) {
          await waitForReconnectBackoff(delay);
        }
        // The terminal event may have arrived during the backoff wait.
        if (intentionalDisconnectRef.current) return;
        if (reconnectGeneration !== reconnectGenerationRef.current) return;
        if (manualReconnectRetryRequestedRef.current) {
          manualReconnectRetryRequestedRef.current = false;
          reconnectAttemptsRef.current = 0;
          skipNextDelay = true;
          if (shouldSurfaceReconnectState) {
            updateReconnectRecoveryStatus(
              buildReconnectRecoveryStatus(
                "connecting",
                1,
                "Retrying reconnect now.",
                lastReconnectError
                  ? describeReconnectFailure(lastReconnectError)
                  : null,
              ),
            );
          }
          continue;
        }

        try {
          const reconnectRoomId = currentRoomIdRef.current;
          if (!reconnectRoomId) {
            throw new Error("Missing room ID for reconnect");
          }
          if (shouldSurfaceReconnectState) {
            updateReconnectRecoveryStatus(
              buildReconnectRecoveryStatus(
                "connecting",
                attempt,
                "Connecting to the meeting server.",
                lastReconnectError
                  ? describeReconnectFailure(lastReconnectError)
                  : null,
              ),
            );
          }
          const canReuseSocket = socketRef.current?.connected === true;
          cleanupRoomResources({
            resetRoomId: false,
            preserveMeetingState: true,
          });
          if (!canReuseSocket) {
            socketRef.current?.disconnect();
            socketRef.current = null;
            onSocketReady?.(null);
            await connectSocket(reconnectRoomId);
          } else {
            setMeetError(null);
          }
          if (reconnectGeneration !== reconnectGenerationRef.current) return;
          // …or while the socket was (re)connecting — bail before rejoining so
          // we don't re-enter a room we were just removed from.
          if (intentionalDisconnectRef.current) return;

          const joinOptions = joinOptionsRef.current;
          const mediaNeeds = getJoinMediaNeeds(
            localStreamRef.current || localStream,
          );
          const stream = await ensureLiveLocalMediaForJoin(
            localStreamRef.current || localStream,
            joinOptions,
            "reconnect",
          );
          const shouldRetryLocalMediaAfterJoin =
            !stream &&
            !joinOptions.isGhost &&
            !joinOptions.isRecorder &&
            !bypassMediaPermissions &&
            joinOptions.joinMode !== "webinar_attendee" &&
            (mediaNeeds.needsAudio || mediaNeeds.needsVideo);
          if (shouldSurfaceReconnectState) {
            updateReconnectRecoveryStatus(
              buildReconnectRecoveryStatus(
                "joining",
                attempt,
                shouldRetryLocalMediaAfterJoin
                  ? "Rejoining the room first. Your devices will be retried after the meeting is back."
                  : "Restoring media, participants, and room state.",
                lastReconnectError
                  ? describeReconnectFailure(lastReconnectError)
                  : null,
              ),
            );
          }
          try {
            await joinRoomInternal(reconnectRoomId, stream, joinOptions);
          } catch (joinError) {
            if (!(joinError instanceof JoinRoomRedirectError)) {
              throw joinError;
            }
            cleanupRoomResources({
              resetRoomId: false,
              preserveMeetingState: true,
            });
            socketRef.current?.disconnect();
            socketRef.current = null;
            onSocketReady?.(null);
            await connectSocket(reconnectRoomId, {
              sfuUrlOverride: joinError.redirectUrl,
            });
            if (intentionalDisconnectRef.current) return;
            await joinRoomInternal(reconnectRoomId, stream, joinOptions);
          }
          if (shouldRetryLocalMediaAfterJoin) {
            if (mediaNeeds.needsAudio) {
              requestAudioProducerRecovery();
            }
            if (mediaNeeds.needsVideo) {
              requestCameraProducerRecovery();
            }
          }
          if (reconnectGeneration !== reconnectGenerationRef.current) return;
          telemetry.capture("meet_reconnect_success", {
            roomId: reconnectRoomId ?? undefined,
            attempt,
            usingTurnFallback: useTurnFallbackRef.current,
          });
          reconnectAttemptsRef.current = 0;
          manualReconnectRetryRequestedRef.current = false;
          updateReconnectRecoveryStatus(null);
          setMeetError(null);
          return;
        } catch (err) {
          if (reconnectGeneration !== reconnectGenerationRef.current) return;
          lastReconnectError = err;
          const reconnectFailure = describeReconnectFailure(err);
          const isRecoverable = isRecoverableReconnectFailure(err);
          console.warn(
            `[Meets] Reconnect attempt ${attempt} failed:`,
            err,
          );
          telemetry.capture("meet_reconnect_attempt_failure", {
            roomId: currentRoomIdRef.current ?? undefined,
            attempt,
            maxAttempts: MAX_RECONNECT_ATTEMPTS,
            error: reconnectFailure,
            usingTurnFallback: useTurnFallbackRef.current,
          });
          if (!isRecoverable) {
            manualReconnectRetryRequestedRef.current = false;
            updateReconnectRecoveryStatus(
              buildReconnectRecoveryStatus(
                "failed",
                attempt,
                "Could not reconnect to the meeting.",
                reconnectFailure,
              ),
            );
            setMeetError({
              code: "CONNECTION_FAILED",
              message: reconnectFailure,
              recoverable: false,
            });
            setConnectionState("error");
            return;
          }
          if (manualReconnectRetryRequestedRef.current) {
            manualReconnectRetryRequestedRef.current = false;
            reconnectAttemptsRef.current = 0;
            skipNextDelay = true;
            if (shouldSurfaceReconnectState) {
              updateReconnectRecoveryStatus(
                buildReconnectRecoveryStatus(
                  "connecting",
                  1,
                  "Retrying reconnect now.",
                  reconnectFailure,
                ),
              );
            }
            continue;
          }
          if (shouldSurfaceReconnectState) {
            updateReconnectRecoveryStatus(
              buildReconnectRecoveryStatus(
                attempt >= MAX_RECONNECT_ATTEMPTS ? "failed" : "waiting",
                attempt,
                attempt >= MAX_RECONNECT_ATTEMPTS
                  ? "Could not reconnect to the meeting."
                  : "Reconnect attempt failed. Retrying automatically.",
                reconnectFailure,
              ),
            );
          }
        }
      }

      // Don't surface a reconnect-failure error if the user was kicked / the
      // room ended mid-loop — that terminal notice + state must stand.
      if (intentionalDisconnectRef.current) return;
      if (reconnectGeneration !== reconnectGenerationRef.current) return;

      const reconnectFailure = describeReconnectFailure(lastReconnectError);
      manualReconnectRetryRequestedRef.current = false;
      telemetry.capture("meet_reconnect_give_up", {
        roomId: currentRoomIdRef.current ?? undefined,
        attempts: reconnectAttemptsRef.current,
        error: reconnectFailure,
        usingTurnFallback: useTurnFallbackRef.current,
      });
      updateReconnectRecoveryStatus(
        buildReconnectRecoveryStatus(
          "failed",
          reconnectAttemptsRef.current,
          "Could not reconnect after several attempts.",
          reconnectFailure,
        ),
      );
      setMeetError({
        code: "CONNECTION_FAILED",
        message: reconnectFailure,
        recoverable: true,
      });
      setConnectionState("error");
    } finally {
      if (reconnectGeneration === reconnectGenerationRef.current) {
        reconnectInFlightRef.current = false;
      }
    }
  }, [
    cleanupRoomResources,
    connectSocket,
    currentRoomIdRef,
    ensureLiveLocalMediaForJoin,
    getJoinMediaNeeds,
    intentionalDisconnectRef,
    joinOptionsRef,
    joinRoomInternal,
    localStream,
    localStreamRef,
    reconnectAttemptsRef,
    reconnectInFlightRef,
    requestAudioProducerRecovery,
    requestCameraProducerRecovery,
    setConnectionState,
    setMeetError,
    socketRef,
    updateReconnectRecoveryStatus,
    waitForReconnectBackoff,
    onSocketReady,
    bypassMediaPermissions,
  ]);

  useEffect(() => {
    handleReconnectRef.current = handleReconnect;
  }, [handleReconnect, handleReconnectRef]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleOnline = () => {
      recoverActiveMeeting("online");
    };

    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("online", handleOnline);
    };
  }, [
    recoverActiveMeeting,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const scheduleForegroundRecovery = () => {
      if (foregroundRecoveryTimeoutRef.current) {
        window.clearTimeout(foregroundRecoveryTimeoutRef.current);
      }

      foregroundRecoveryTimeoutRef.current = window.setTimeout(() => {
        foregroundRecoveryTimeoutRef.current = null;
        clearExpiredParticipantConnectionStatuses();
        recoverActiveMeeting("foreground");
      }, 150);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      scheduleForegroundRecovery();
    };

    const handlePageShow = () => {
      scheduleForegroundRecovery();
    };

    const handleFocus = () => {
      scheduleForegroundRecovery();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("focus", handleFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handleFocus);
      if (foregroundRecoveryTimeoutRef.current) {
        window.clearTimeout(foregroundRecoveryTimeoutRef.current);
        foregroundRecoveryTimeoutRef.current = null;
      }
    };
  }, [clearExpiredParticipantConnectionStatuses, recoverActiveMeeting]);

  const handleRedirectCallback = useCallback(
    async (newRoomId: string) => {
      console.log(`[Meets] Executing hard redirect to ${newRoomId}`);

      cleanup();
      setRoomId(newRoomId);
      shouldAutoJoinRef.current = true;
    },
    [cleanup, setRoomId, shouldAutoJoinRef],
  );

  useEffect(() => {
    handleRedirectRef.current = handleRedirectCallback;
  }, [handleRedirectCallback, handleRedirectRef]);

  const startJoin = useCallback(
    async (targetRoomId: string) => {
      if (refs.abortControllerRef.current?.signal.aborted) return;

      telemetry.capture("meet_join_attempt", {
        roomId: targetRoomId,
        joinMode,
        isGhost: ghostEnabled,
        isAdmin,
      });

      setMeetError(null);
      updateReconnectRecoveryStatus(null);
      setConnectionState("connecting");
      primeAudioOutput();
      refs.intentionalDisconnectRef.current = false;
      serverRoomIdRef.current = null;
      runtimeStunIceServersRef.current = null;
      runtimeTurnIceServersRef.current = null;
      useTurnFallbackRef.current = false;
      setRoomId(targetRoomId);
      if (joinMode === "webinar_attendee") {
        setIsAdmin(false);
      }
      const normalizedDisplayName = normalizeDisplayName(displayNameInput);
      const joinOptions: {
        displayName?: string;
        isGhost: boolean;
        isRecorder?: boolean;
        joinMode: JoinMode;
        webinarInviteCode?: string;
        meetingInviteCode?: string;
      } = {
        displayName: isAdmin ? normalizedDisplayName || undefined : undefined,
        isGhost: ghostEnabled,
        isRecorder: bypassMediaPermissions,
        joinMode,
      };
      joinOptionsRef.current = joinOptions;
      const candidateStream = localStreamRef.current ?? localStream;
      const mediaNeeds = getJoinMediaNeeds(candidateStream);
      const shouldRequestMedia =
        !joinOptions.isGhost &&
        !joinOptions.isRecorder &&
        joinOptions.joinMode !== "webinar_attendee" &&
        !bypassMediaPermissions &&
        (mediaNeeds.needsAudio || mediaNeeds.needsVideo);

      try {
        const [, stream] = await Promise.all([
          connectSocket(targetRoomId),
          shouldRequestMedia
            ? ensureLiveLocalMediaForJoin(
                candidateStream,
                joinOptions,
                "initial join",
              )
            : Promise.resolve(candidateStream),
        ]);

        if (shouldRequestMedia && !stream) {
          setConnectionState("error");
          return;
        }

        const joinMediaIntent = resolveMediaPublishIntent(stream);
        const streamForJoin = joinMediaIntent.isCameraOn
          ? stream
          : dropVideoTracksForCameraOff(stream, "camera-off initial join");

        localStreamRef.current = streamForJoin;
        setLocalStream(streamForJoin);

        let nextJoinOptions = joinOptions;
        let joinRedirectCount = 0;
        while (true) {
          try {
            const joinResult = await joinRoomInternal(
              targetRoomId,
              streamForJoin,
              nextJoinOptions,
            );
            telemetry.capture("meet_join_success", {
              roomId: targetRoomId,
              joinMode: nextJoinOptions.joinMode,
              status: joinResult,
            });
            if (joinResult === "joined") {
              prejoinMediaIntentRef.current = null;
            }
            break;
          } catch (joinError) {
            if (
              joinError instanceof JoinRoomRedirectError &&
              joinRedirectCount < MAX_JOIN_ROOM_REDIRECTS
            ) {
              joinRedirectCount += 1;
              console.log(
                `[Meets] Reconnecting to routed SFU ${joinError.redirectUrl}`,
                {
                  roomId: targetRoomId,
                  redirectInstanceId: joinError.response.redirectInstanceId,
                },
              );
              cleanupRoomResources({ resetRoomId: false });
              socketRef.current?.disconnect();
              socketRef.current = null;
              onSocketReady?.(null);
              await connectSocket(targetRoomId, {
                sfuUrlOverride: joinError.redirectUrl,
              });
              continue;
            }

            const joinMessage =
              joinError instanceof Error
                ? joinError.message
                : String(joinError ?? "");
            const isMeetingInviteCodeValidationError =
              /meeting invite code required/i.test(joinMessage) ||
              /invalid meeting invite code/i.test(joinMessage);
            const shouldPromptMeetingInviteCode =
              nextJoinOptions.joinMode !== "webinar_attendee" &&
              isMeetingInviteCodeValidationError &&
              typeof requestMeetingInviteCode === "function";

            const isWebinarInviteCodeValidationError =
              /webinar invite code required/i.test(joinMessage) ||
              /invalid webinar invite code/i.test(joinMessage);
            const shouldPromptWebinarInviteCode =
              nextJoinOptions.joinMode === "webinar_attendee" &&
              isWebinarInviteCodeValidationError &&
              typeof requestWebinarInviteCode === "function";

            if (!shouldPromptMeetingInviteCode && !shouldPromptWebinarInviteCode) {
              throw joinError;
            }

            const inviteCode = shouldPromptMeetingInviteCode
              ? await requestMeetingInviteCode!()
              : await requestWebinarInviteCode!();
            if (!inviteCode || !inviteCode.trim()) {
              throw joinError;
            }

            nextJoinOptions = shouldPromptMeetingInviteCode
              ? {
                  ...nextJoinOptions,
                  meetingInviteCode: inviteCode.trim(),
                }
              : {
                  ...nextJoinOptions,
                  webinarInviteCode: inviteCode.trim(),
                };
            joinOptionsRef.current = nextJoinOptions;
          }
        }
      } catch (err) {
        console.error("[Meets] Error joining room:", err);
        telemetry.capture("meet_join_failure", {
          roomId: targetRoomId,
          joinMode,
          error: err instanceof Error ? err.message : String(err ?? ""),
        });
        const stream = localStreamRef.current;
        if (stream) {
          stream.getTracks().forEach((track) => stopLocalTrack(track));
          setLocalStream(null);
        }
        setMeetError(createMeetError(err));
        setConnectionState("error");
      }
    },
    [
      connectSocket,
      cleanupRoomResources,
      displayNameInput,
      dropVideoTracksForCameraOff,
      ghostEnabled,
      joinMode,
      isCameraOff,
      isMuted,
      isAdmin,
      ensureLiveLocalMediaForJoin,
      getJoinMediaNeeds,
      joinOptionsRef,
      joinRoomInternal,
      localStream,
      localStreamRef,
      prejoinMediaIntentRef,
      primeAudioOutput,
      requestMeetingInviteCode,
      requestWebinarInviteCode,
      resolveMediaPublishIntent,
      bypassMediaPermissions,
      refs.abortControllerRef,
      refs.intentionalDisconnectRef,
      setConnectionState,
      setLocalStream,
      setMeetError,
      setRoomId,
      socketRef,
      stopLocalTrack,
      updateReconnectRecoveryStatus,
      onSocketReady,
    ],
  );

  const joinRoom = useCallback(async () => {
    await startJoin(roomId);
  }, [roomId, startJoin]);

  const joinRoomById = useCallback(
    async (targetRoomId: string) => {
      await startJoin(targetRoomId);
    },
    [startJoin],
  );

  const retryReconnect = useCallback(async () => {
    const targetRoomId = currentRoomIdRef.current || roomId;
    if (!targetRoomId) {
      const reconnectFailure = "No meeting room is available to reconnect.";
      updateReconnectRecoveryStatus(
        buildReconnectRecoveryStatus(
          "failed",
          0,
          "Could not start reconnect.",
          reconnectFailure,
        ),
      );
      setMeetError({
        code: "CONNECTION_FAILED",
        message: reconnectFailure,
        recoverable: true,
      });
      setConnectionState("error");
      return;
    }

    if (reconnectInFlightRef.current) {
      await handleReconnect({ immediate: true });
      return;
    }

    reconnectGenerationRef.current += 1;
    reconnectAttemptsRef.current = 0;
    setMeetError(null);
    updateReconnectRecoveryStatus(
      buildReconnectRecoveryStatus(
        "connecting",
        1,
        "Retrying reconnect now.",
      ),
    );
    setConnectionState("reconnecting");

    if (currentRoomIdRef.current) {
      await handleReconnect({ immediate: true });
      return;
    }

    await startJoin(targetRoomId);
  }, [
    currentRoomIdRef,
    handleReconnect,
    reconnectAttemptsRef,
    reconnectInFlightRef,
    roomId,
    setConnectionState,
    setMeetError,
    startJoin,
    updateReconnectRecoveryStatus,
  ]);

  useEffect(() => {
    if (shouldAutoJoinRef.current) {
      console.log("[Meets] Auto-joining new room...");
      shouldAutoJoinRef.current = false;
      joinRoom();
    }
  }, [joinRoom, shouldAutoJoinRef]);

  const toggleRoomLock = useCallback(
    (locked: boolean): Promise<boolean> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(false);

      return new Promise((resolve) => {
        socket.emit(
          "lockRoom",
          { locked },
          (
            response:
              | { success: boolean; locked?: boolean }
              | { error: string },
          ) => {
            if ("error" in response) {
              console.error(
                "[Meets] Failed to toggle room lock:",
                response.error,
              );
              resolve(false);
            } else {
              resolve(response.success);
            }
          },
        );
      });
    },
    [socketRef],
  );

  const toggleNoGuests = useCallback(
    (noGuests: boolean): Promise<boolean> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(false);

      return new Promise((resolve) => {
        socket.emit(
          "setNoGuests",
          { noGuests },
          (
            response:
              | { success: boolean; noGuests?: boolean }
              | { error: string }
          ) => {
            if ("error" in response) {
              console.error("[Meets] Failed to toggle no-guests:", response.error);
              resolve(false);
            } else {
              resolve(response.success);
            }
          }
        );
      });
    },
    [socketRef]
  );

  const toggleChatLock = useCallback(
    (locked: boolean): Promise<boolean> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(false);

      return new Promise((resolve) => {
        socket.emit(
          "lockChat",
          { locked },
          (response: { success: boolean; locked?: boolean } | { error: string }) => {
            if ("error" in response) {
              console.error("[Meets] Failed to toggle chat lock:", response.error);
              resolve(false);
            } else {
              resolve(response.success);
            }
          }
        );
      });
    },
    [socketRef]
  );

  const getMeetingConfig = useCallback(
    (): Promise<MeetingConfigSnapshot | null> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(null);

      return new Promise((resolve) => {
        socket.emit(
          "meeting:getConfig",
          (response: MeetingConfigSnapshot | { error: string }) => {
            if ("error" in response) {
              console.error(
                "[Meets] Failed to fetch meeting config:",
                response.error,
              );
              resolve(null);
              return;
            }
            setMeetingRequiresInviteCode(Boolean(response.requiresInviteCode));
            resolve(response);
          },
        );
      });
    },
    [setMeetingRequiresInviteCode, socketRef],
  );

  const updateMeetingConfig = useCallback(
    (update: MeetingUpdateRequest): Promise<MeetingConfigSnapshot | null> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(null);

      return new Promise((resolve) => {
        socket.emit(
          "meeting:updateConfig",
          update,
          (
            response:
              | { success: boolean; config: MeetingConfigSnapshot }
              | { error: string },
          ) => {
            if ("error" in response) {
              console.error(
                "[Meets] Failed to update meeting config:",
                response.error,
              );
              resolve(null);
              return;
            }
            setMeetingRequiresInviteCode(
              Boolean(response.config.requiresInviteCode),
            );
            resolve(response.config);
          },
        );
      });
    },
    [setMeetingRequiresInviteCode, socketRef],
  );

  const getWebinarConfig = useCallback((): Promise<WebinarConfigSnapshot | null> => {
    const socket = socketRef.current;
    if (!socket) return Promise.resolve(null);

    return new Promise((resolve) => {
      socket.emit(
        "webinar:getConfig",
        (response: WebinarConfigSnapshot | { error: string }) => {
          if ("error" in response) {
            console.error("[Meets] Failed to fetch webinar config:", response.error);
            resolve(null);
            return;
          }
          setWebinarConfig(response);
          resolve(response);
        },
      );
    });
  }, [setWebinarConfig, socketRef]);

  const updateWebinarConfig = useCallback(
    (update: WebinarUpdateRequest): Promise<WebinarConfigSnapshot | null> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(null);

      return new Promise((resolve) => {
        socket.emit(
          "webinar:updateConfig",
          update,
          (
            response:
              | { success: boolean; config: WebinarConfigSnapshot }
              | { error: string },
          ) => {
            if ("error" in response) {
              console.error("[Meets] Failed to update webinar config:", response.error);
              resolve(null);
              return;
            }
            setWebinarConfig(response.config);
            resolve(response.config);
          },
        );
      });
    },
    [setWebinarConfig, socketRef],
  );

  const rotateWebinarLink = useCallback((): Promise<WebinarLinkResponse | null> => {
    const socket = socketRef.current;
    if (!socket) return Promise.resolve(null);

    return new Promise((resolve) => {
      socket.emit(
        "webinar:rotateLink",
        (response: WebinarLinkResponse | { error: string }) => {
          if ("error" in response) {
            console.error("[Meets] Failed to rotate webinar link:", response.error);
            resolve(null);
            return;
          }
          resolve(response);
        },
      );
    });
  }, [socketRef]);

  const generateWebinarLink = useCallback(
    (): Promise<WebinarLinkResponse | null> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(null);

      return new Promise((resolve) => {
        socket.emit(
          "webinar:generateLink",
          (response: WebinarLinkResponse | { error: string }) => {
            if ("error" in response) {
              console.error("[Meets] Failed to generate webinar link:", response.error);
              resolve(null);
              return;
            }
            resolve(response);
          },
        );
      });
    },
    [socketRef],
  );

  return {
    cleanup,
    cleanupRoomResources,
    connectSocket,
    ensureProducerTransport,
    joinRoom,
    joinRoomById,
    retryReconnect,
    reconnectRecoveryStatus,
    toggleRoomLock,
    toggleNoGuests,
    toggleChatLock,
    getMeetingConfig,
    updateMeetingConfig,
    getWebinarConfig,
    updateWebinarConfig,
    rotateWebinarLink,
    generateWebinarLink,
  };
}
