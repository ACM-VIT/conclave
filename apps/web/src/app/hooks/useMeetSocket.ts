"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createCoalescedRunner } from "../lib/coalesced-run";
import { createProducerSlotOrder } from "../lib/producer-slot-order";
import { toError } from "../lib/utils";
import type { Socket } from "socket.io-client";
import type { Device } from "mediasoup-client";
import {
  BACKGROUND_TRANSPORT_DISCONNECT_GRACE_MS,
  MAX_RECONNECT_ATTEMPTS,
  MEETS_ICE_SERVERS,
  RECONNECT_DELAY_MS,
  SOCKET_TIMEOUT_MS,
  SOCKET_CONNECT_TIMEOUT_MS,
  TRANSPORT_DISCONNECT_GRACE_MS,
  PRODUCER_SYNC_INTERVAL_MS,
  buildMicrophoneOpusCodecOptions,
  buildScreenShareAudioOpusCodecOptions,
} from "../lib/constants";
import { emitWithAckTimeout } from "../lib/socket-ack";
import {
  resolveInFlightReconnectRequest,
  resolveReconnectStartAttempts,
  type ReconnectRequest,
} from "../lib/reconnect-request-policy";
import type {
  ActiveSpeakerChangedNotification,
  AdminNoticeNotification,
  ChatHistorySnapshot,
  ChatMessage,
  ChatReactionChangedNotification,
  ConnectionState,
  Consumer,
  ConsumeResponse,
  DisplayNameSnapshotEntry,
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
  TranscriptSfuRelayStartResponse,
  TranscriptSfuRelayStartRequest,
  TranscriptSfuRelayStatusResponse,
  TranscriptSfuRelayStopResponse,
  TranscriptTokenResponse,
  RestartIceResponse,
  Transport,
  VideoQuality,
  WebcamCodecPolicy,
  WebinarConfigSnapshot,
  WebinarDemotedNotification,
  WebinarFeedChangedNotification,
  WebinarHandQueueChangedNotification,
  WebinarHandQueueEntry,
  WebinarLinkResponse,
  WebinarParticipantJoinedNotification,
  WebinarPromotedNotification,
  WebinarQaChangedNotification,
  WebinarQaEntry,
  WebinarQaModerateRequest,
  WebinarQaSnapshot,
  ServerRestartNotification,
  WebinarUpdateRequest,
} from "../lib/types";
import type { ParticipantAction } from "../lib/participant-reducer";
import { createMeetError, isSystemUserId, normalizeDisplayName } from "../lib/utils";
import { normalizeChatMessage } from "../lib/chat-commands";
import {
  type AssistantChatMessage,
  type AssistantTask,
  type ConclaveAssistantStatus,
  CONCLAVE_ASSISTANT_NAME,
  CONCLAVE_ASSISTANT_USER_ID,
  completeAssistantTasks,
  mergeAssistantTask,
} from "../lib/conclave-assistant";
import { telemetry } from "../lib/telemetry";
import {
  applyAudioProducerNetworkProfile,
  applyScreenShareProducerNetworkProfile,
  applyScreenShareTrackNetworkProfile,
  getPreferredScreenShareCodec,
  getPreferredWebcamCodec,
  produceScreenShareTrack,
  produceWebcamTrack,
  type WebcamProducerNetworkProfile,
} from "../lib/webcam-codec";
import { getCapturedDisplaySurface } from "../lib/captured-surface-control";
import {
  BASELINE_WEBCAM_CODEC_POLICY,
  classifyVp9CodecFailure,
  detectBrowserWebcamCodecCapabilities,
  detectLoadedDeviceWebcamCodecCapabilities,
  isNewerWebcamCodecPolicy,
  normalizeWebcamCodecPolicy,
  rememberProvenVp9EncoderIncompatibility,
} from "../lib/webcam-codec-policy";
import {
  setNoiseCancellationTrackEnabled,
  stopNoiseCancellationForTrack,
} from "../lib/noise-cancellation";
import {
  getMostConstrainedWebcamProducerNetworkProfile,
  getScreenShareReceiveNetworkProfileForAvailableIncomingBitrate,
  selectScreenSharePublishNetworkProfile,
} from "../lib/screen-share-network-profile";
import { getBrowserNetworkSnapshot } from "../lib/network-information";
import {
  resolveEffectiveCameraPublishSettings,
  resolveScreenSharePublishSettings,
  type MediaQualitySettings,
} from "../lib/media-quality-settings";
import {
  getBrowserMediaAdaptationQuality,
  hasBrowserMediaEmergencyEvidence,
} from "../lib/connection-quality-policy";
import { WEBCAM_RECEIVE_TEMPORAL_LAYER } from "../lib/adaptive-video-receive";
import {
  getConsumerResumeEffectiveAttempt,
  isConsumerResumeSettlementCurrent,
  type ConsumerResumeRetryState,
} from "../lib/consumer-resume-retry";
import {
  advanceVideoFreezeRecovery,
  isProducerGoneConsumeError,
  shouldRecreateProducerTransport,
  type VideoFreezeRecoveryState,
} from "../lib/media-recovery-policy";
import { waitForRemoteVideoPresentation } from "../lib/remote-video-presentation";
import {
  decideWebcamStartupResetAttempt,
  decideWebcamStartupResetPoll,
  decideWebcamStartupResetVerification,
  enqueueWebcamStartupResetProducer,
  getConsumerMaximumSpatialLayer,
  getHighestActiveSpatialLayer,
  getWebcamStartupResetQueueDelayMs,
  isCurrentConsumerGeneration,
  isProducerPauseSnapshotCurrent,
  isVp8SimulcastConsumerEligibleForStartupReset,
  WEBCAM_STARTUP_RESET_MAX_ATTEMPTS,
  WEBCAM_STARTUP_RESET_MAX_WAIT_MS,
  WEBCAM_STARTUP_RESET_MIN_SPACING_MS,
  WEBCAM_STARTUP_RESET_POLL_MS,
  WEBCAM_STARTUP_RESET_PRESENTATION_TIMEOUT_MS,
  WEBCAM_STARTUP_RESET_REASON,
  WEBCAM_STARTUP_RESET_RESUME_ACK_TIMEOUT_MS,
  WEBCAM_STARTUP_RESET_RESUME_MAX_ATTEMPTS,
  WEBCAM_STARTUP_RESET_RETRY_MS,
  WEBCAM_STARTUP_RESET_STABLE_MS,
  WEBCAM_STARTUP_RESET_VERIFY_POLL_MS,
  WEBCAM_STARTUP_RESET_VERIFY_TIMEOUT_MS,
} from "../lib/webcam-consumer-generation-reset";
import type {
  ConsumerGenerationResetDebugRecord,
  ConsumerTelemetrySnapshot,
  MeetRefs,
} from "./useMeetRefs";
import type {
  ConnectionQuality,
  ConnectionQualityStats,
} from "./useConnectionQuality";
import type {
  ProducerTransportEnsureOptions,
  RequestMediaPermissionsOptions,
  ScreenShareRepublishOptions,
} from "./useMeetMedia";
import { captureGeneration, releaseAllCaptures } from "../lib/media-captures";
import { installProducer } from "../lib/producer-slot";
import { publishIntent } from "../lib/device-intent";
import { endedNotice, joinRejectedUpdate, type SetupNotice } from "../lib/setup-notice";

type ConsumerTelemetryPayload = Omit<
  ConsumerTelemetrySnapshot,
  "receivedAt"
>;

type ConsumeProducerOptions = {
  replaceExisting?: boolean;
  retryOnFailure?: boolean;
  knownScreenShareVideoActive?: boolean;
  webcamVideoStartupRank?: number;
  makeBeforeBreak?: {
    expectedPreviousConsumerId: string;
    deadlineAt: number;
    resetEpoch: number;
    rollbackOutcome: { confirmed: boolean };
  };
};

type ServerConsumerCloseOperation = {
  promise: Promise<boolean>;
  settle: (success: boolean) => void;
};

type WebcamStartupLatencyResetRuntime = {
  producerInfo: ProducerInfo;
  previousConsumerId: string;
  replacementConsumerId: string | null;
  maximumSpatialLayer: number;
  observedSpatialLayer: number | null;
  startedAt: number;
  deadlineAt: number;
  highLayerSince: number | null;
  replacementStartedAt: number | null;
  verificationStartedAt: number | null;
  completedAt: number | null;
  attempt: number;
  epoch: number;
  status: ConsumerGenerationResetDebugRecord["status"];
  failureReason: string | null;
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
const SCREEN_SHARE_VIDEO_STALL_KEYFRAME_REQUEST_DELAY_MS = 900;
const STALE_CONSUMER_RECOVERY_DELAY_MS = 9000;
const SCREEN_SHARE_STALE_CONSUMER_RECOVERY_DELAY_MS = 4500;
const CRITICAL_SIGNALING_ACK_TIMEOUT_MS = 12000;
const RESUME_CONSUMER_ACK_TIMEOUT_MS = 8000;
const RESUME_CONSUMER_MAX_ATTEMPTS = 6;

const getResumeConsumerRetryDelayMs = (attempt: number): number =>
  Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250);
const JOIN_ROOM_ACK_TIMEOUT_MS = 15000;
const HELD_JOIN_INFO_TTL_MS = 30000;
const RESTART_ICE_ACK_TIMEOUT_MS = 5000;
const PARTICIPANT_RECONNECTING_STATUS_FALLBACK_MS = 30000;
const PARTICIPANT_RECONNECTING_STATUS_BUFFER_MS = 5000;
const PARTICIPANT_RECONNECTED_STATUS_MS = 4500;
const PRODUCER_CLOSE_REPLACEMENT_GRACE_MS = 1500;
const STALE_REPLACEMENT_CLEANUP_DELAY_MS = 5000;
const SCREEN_SHARE_STALE_REPLACEMENT_CLEANUP_DELAY_MS = 1500;
const CLOSE_CONSUMER_RETRY_DELAY_MS = 500;
const CLOSE_CONSUMER_MAX_ATTEMPTS = 4;
const CLOSE_CONSUMER_ACK_TIMEOUT_MS = 2_500;
const SCREEN_SHARE_FREEZE_KEYFRAME_REQUEST_COOLDOWN_MS = 2000;
const SCREEN_SHARE_FOREGROUND_KEYFRAME_REQUEST_COOLDOWN_MS = 1200;
const FOREGROUND_RECOVERY_DELAY_MS = 150;
const SUSPENDED_EVENT_LOOP_CHECK_MS = 5000;
const SUSPENDED_EVENT_LOOP_GAP_MS = 30000;
const isScreenShareVideoProducer = (
  producerInfo: Pick<ProducerInfo, "kind" | "type">,
): boolean => producerInfo.kind === "video" && producerInfo.type === "screen";

const isWebcamVideoProducer = (
  producerInfo: Pick<ProducerInfo, "kind" | "type">,
): boolean => producerInfo.kind === "video" && producerInfo.type === "webcam";

const HIGH_LAYER_STARTUP_WEBCAM_LIMIT = 4;

const countWebcamVideoProducerEntries = (
  producerMap: Map<
    string,
    { userId: string; kind: "audio" | "video"; type: ProducerType }
  >,
): number =>
  Array.from(producerMap.values()).filter(isWebcamVideoProducer).length;

const buildWebcamVideoStartupRanks = (
  producers: ProducerInfo[],
  existingWebcamVideoCount = 0,
): Map<string, number> => {
  const ranks = new Map<string, number>();
  let rank = existingWebcamVideoCount;

  for (const producer of producers) {
    if (!isWebcamVideoProducer(producer)) continue;
    ranks.set(producer.producerId, rank);
    rank += 1;
  }

  return ranks;
};

const getVideoStallKeyFrameRequestDelayMs = (
  producerInfo: Pick<ProducerInfo, "kind" | "type">,
): number =>
  isScreenShareVideoProducer(producerInfo)
    ? SCREEN_SHARE_VIDEO_STALL_KEYFRAME_REQUEST_DELAY_MS
    : VIDEO_STALL_KEYFRAME_REQUEST_DELAY_MS;

const getStaleConsumerRecoveryDelayMs = (
  producerInfo: Pick<ProducerInfo, "type">,
): number =>
  producerInfo.type === "screen"
    ? SCREEN_SHARE_STALE_CONSUMER_RECOVERY_DELAY_MS
    : STALE_CONSUMER_RECOVERY_DELAY_MS;

const ACK_REQUEST_TIMEOUT_MS = SOCKET_TIMEOUT_MS;
const LONG_ACK_REQUEST_TIMEOUT_MS = 30_000;

const startSocketAckTimeout = (
  eventName: string,
  onTimeout: (error: Error) => void,
  timeoutMs = CRITICAL_SIGNALING_ACK_TIMEOUT_MS,
) => {
  let settled = false;
  const timeoutId = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    onTimeout(new Error(`${eventName} acknowledgement timeout`));
  }, timeoutMs);

  return () => {
    if (settled) return false;
    settled = true;
    window.clearTimeout(timeoutId);
    return true;
  };
};

type ConsumerVideoFlowSnapshot = {
  framesDecoded: number | null;
  bytesReceived: number | null;
};

const readConsumerVideoFlowSnapshot = async (
  consumer: Consumer,
): Promise<ConsumerVideoFlowSnapshot> => {
  try {
    const report = await consumer.getStats();
    let foundInboundVideo = false;
    let framesDecoded = 0;
    let bytesReceived = 0;
    report.forEach((entry) => {
      const stat = entry as RTCInboundRtpStreamStats & {
        kind?: string;
        mediaType?: string;
        isRemote?: boolean;
      };
      if (
        stat.type !== "inbound-rtp" ||
        stat.isRemote === true ||
        (stat.kind && stat.kind !== "video") ||
        (stat.mediaType && stat.mediaType !== "video")
      ) {
        return;
      }
      foundInboundVideo = true;
      const decodedFrameCount = Number(stat.framesDecoded);
      if (Number.isFinite(decodedFrameCount)) {
        framesDecoded += decodedFrameCount;
      }
      const receivedByteCount = Number(stat.bytesReceived);
      if (Number.isFinite(receivedByteCount)) {
        bytesReceived += receivedByteCount;
      }
    });
    return foundInboundVideo
      ? { framesDecoded, bytesReceived }
      : { framesDecoded: null, bytesReceived: null };
  } catch {
    return { framesDecoded: null, bytesReceived: null };
  }
};

const readConsumerVideoFlowSnapshotWithin = (
  consumer: Consumer,
  timeoutMs: number,
): Promise<ConsumerVideoFlowSnapshot> =>
  new Promise((resolve) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ framesDecoded: null, bytesReceived: null });
    }, Math.max(1, timeoutMs));
    void readConsumerVideoFlowSnapshot(consumer).then((snapshot) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      resolve(snapshot);
    });
  });

const CLOSE_CONSUMER_RETRY_WINDOW_MS = 30000;
const TURN_URL_PATTERN = /^turns?:/i;
const TRANSPORT_CC_FEEDBACK_TYPE = "transport-cc";

const getConnectionStatsNetworkProfile = (
  stats: ConnectionQualityStats | null | undefined,
  direction: "publish" | "receive",
): WebcamProducerNetworkProfile => {
  const snapshot = stats?.browserNetwork ?? getBrowserNetworkSnapshot();
  const statsQuality =
    direction === "publish"
      ? stats?.publishAdaptationQuality
      : stats?.receiveAdaptationQuality;
  const statsEmergency =
    direction === "publish"
      ? stats?.publishEmergencyMode
      : stats?.receiveEmergencyMode;
  const quality: ConnectionQuality =
    statsQuality && statsQuality !== "unknown"
      ? statsQuality
      : getBrowserMediaAdaptationQuality(snapshot);

  if (
    hasBrowserMediaEmergencyEvidence(snapshot) ||
    (statsEmergency === true && quality !== "good")
  ) {
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

const isMeetingDocumentHidden = (): boolean =>
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

type ScreenAudioProducerAppData = {
  type: ProducerType;
  networkProfile?: WebcamProducerNetworkProfile;
};

export const getInitialConsumerPreferences = (
  producerInfo: ProducerInfo,
  options: {
    preferHighWebcamLayer?: boolean;
    networkProfile?: WebcamProducerNetworkProfile;
    screenShareVideoActive?: boolean;
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
          networkProfile === "emergency"
            ? 1
            : 2,
      },
      priority: 240,
    };
  }

  if (producerInfo.type !== "webcam") {
    return {};
  }

  if (options.screenShareVideoActive) {
    return {
      preferredLayers: {
        spatialLayer: 0,
        temporalLayer: WEBCAM_RECEIVE_TEMPORAL_LAYER,
      },
      priority:
        networkProfile === "good" ? 70 : networkProfile === "fair" ? 55 : 40,
    };
  }

  if (options.preferHighWebcamLayer) {
    if (networkProfile === "good") {
      return {
        preferredLayers: {
          spatialLayer: 2,
          temporalLayer: WEBCAM_RECEIVE_TEMPORAL_LAYER,
        },
        priority: 180,
      };
    }

    if (networkProfile === "fair") {
      return {
        preferredLayers: {
          spatialLayer: 1,
          temporalLayer: WEBCAM_RECEIVE_TEMPORAL_LAYER,
        },
        priority: 150,
      };
    }

    return {
      preferredLayers: {
        spatialLayer: 0,
        temporalLayer: WEBCAM_RECEIVE_TEMPORAL_LAYER,
      },
      priority: networkProfile === "emergency" ? 145 : 120,
    };
  }

  if (networkProfile === "good") {
    return {
      preferredLayers: {
        spatialLayer: 0,
        temporalLayer: WEBCAM_RECEIVE_TEMPORAL_LAYER,
      },
      priority: 100,
    };
  }

  return {
    preferredLayers: {
      spatialLayer: 0,
      temporalLayer: WEBCAM_RECEIVE_TEMPORAL_LAYER,
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

/**
 * The join token names another identity than the one this join was started
 * as. The caller has been told (`adoptJoinIdentity`) and joins again from the
 * render that knows the new identity, so this attempt stops without an error.
 */
class JoinIdentityChangedError extends Error {
  constructor() {
    super("The join token names another identity.");
    this.name = "JoinIdentityChangedError";
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
  options: JoinMediaNeeds,
) => {
  if (!stream) return options.needsAudio || options.needsVideo;
  if (options.needsAudio && !hasLiveTrackOfKind(stream, "audio")) return true;
  if (options.needsVideo && !hasLiveTrackOfKind(stream, "video")) return true;
  return false;
};

type JoinMediaNeeds = {
  needsAudio: boolean;
  needsVideo: boolean;
  requiredAudio: boolean;
  requiredVideo: boolean;
};

const hasRequiredJoinMediaNeed = (mediaNeeds: JoinMediaNeeds): boolean =>
  mediaNeeds.requiredAudio || mediaNeeds.requiredVideo;

const buildRequestMediaPermissionsOptions = (
  mediaNeeds: JoinMediaNeeds,
): RequestMediaPermissionsOptions => ({
  audio: mediaNeeds.needsAudio,
  video: mediaNeeds.needsVideo,
  audioRequired: mediaNeeds.requiredAudio,
  videoRequired: mediaNeeds.requiredVideo,
});

const isRoomEndedByLocalUser = (
  endedBy: string | null | undefined,
  localUserId: string,
): boolean => {
  const normalizedEndedBy = endedBy?.trim() ?? "";
  if (!normalizedEndedBy) return false;

  const normalizedLocalUserId = localUserId.trim();
  if (normalizedEndedBy === normalizedLocalUserId) return true;

  const localUserKey = normalizedLocalUserId.split("#")[0] ?? "";
  return localUserKey.length > 0 && normalizedEndedBy === localUserKey;
};

const DEFAULT_ROOM_ENDED_MESSAGE = "This meeting has been ended by the host.";
const DEFAULT_KICK_REASON = "Removed by host";

const customServerText = (
  text: string | undefined,
  fallback: string,
): string | null => {
  const trimmed = text?.trim() ?? "";
  return trimmed && trimmed !== fallback ? trimmed : null;
};

const resolveRoomEndedNoticeMessage = (message?: string): string =>
  customServerText(message, DEFAULT_ROOM_ENDED_MESSAGE) ??
  "The host ended this meeting. You are no longer connected.";

export interface RemoteCallEnding {
  kind: "endedByHost" | "removed";
  detail: string | null;
}

interface UseMeetSocketOptions {
  refs: MeetRefs;
  roomId: string;
  setRoomId: (roomId: string) => void;
  isAdmin: boolean;
  setIsAdmin: (value: boolean) => void;
  user?: { id?: string; email?: string | null; name?: string | null };
  userId: string;
  /**
   * Takes this client's identity from the join token it is about to connect
   * with. Returns true when that changes `userId`. The connection is then
   * not made, and the caller joins `roomId` again from the render that knows
   * the new identity. A socket is only ever opened as the identity its token
   * names.
   */
  adoptJoinIdentity?: (token: string, roomId: string) => boolean;
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
  displayNameInput: string;
  localStream: MediaStream | null;
  setLocalStream: React.Dispatch<React.SetStateAction<MediaStream | null>>;
  selectedVideoInputDeviceId?: string;
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
  setSetupNotice?: (notice: SetupNotice | null) => void;
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
  setWebinarQaEntries: React.Dispatch<React.SetStateAction<WebinarQaEntry[]>>;
  setWebinarHandQueue: React.Dispatch<
    React.SetStateAction<WebinarHandQueueEntry[]>
  >;
  setIsWebinarHandRaised: (raised: boolean) => void;
  setWebinarStageInvite: (
    invite: { promotedByName?: string; rejoinRoomId: string } | null,
  ) => void;
  onWebinarDemoted?: (notification: WebinarDemotedNotification) => void;
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
  setAreImageAttachmentsEnabled: (value: boolean) => void;
  setIsReactionsDisabled: (value: boolean) => void;
  setIsParticipantUnmuteAllowed: (value: boolean) => void;
  setIsParticipantVideoAllowed: (value: boolean) => void;
  setActiveScreenShareId: (value: string | null) => void;
  setActiveSpeakerId: React.Dispatch<React.SetStateAction<string | null>>;
  setServerActiveSpeakerAvailable: (value: boolean) => void;
  setNetworkManagedVideoQuality: (value: VideoQuality) => void;
  videoQualityRef: React.MutableRefObject<VideoQuality>;
  mediaQualitySettingsRef: React.MutableRefObject<MediaQualitySettings>;
  activeVideoEffectsCount?: number;
  connectionQualityRef?: React.MutableRefObject<ConnectionQualityStats | null>;
  dataSaverMode?: boolean;
  audioOnlyMode?: boolean;
  updateVideoQualityRef: React.MutableRefObject<
    (
      quality: VideoQuality,
      networkProfileOverride?: WebcamProducerNetworkProfile,
      forceCaptureRefresh?: boolean,
    ) => Promise<void>
  >;
  requestMediaPermissions: (
    options?: RequestMediaPermissionsOptions,
  ) => Promise<MediaStream | null>;
  requestAudioProducerRecovery: () => void;
  requestCameraProducerRecovery: () => void;
  runCameraTrackOperation?: <T>(operation: () => Promise<T>) => Promise<T>;
  prepareAudioPublishTrack?: (
    track: MediaStreamTrack,
    requestedIn: number,
  ) => Promise<MediaStreamTrack>;
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
    ttsVoiceToken?: string;
    messageId?: string;
  }) => void;
  prewarm?: {
    Device: typeof import("mediasoup-client").Device | null;
    io: typeof import("socket.io-client").io | null;
    isReady: boolean;
    getCachedToken?: (roomId: string) => JoinInfo | null;
  };
  onSocketReady?: (socket: Socket | null) => void;
  onLocalRoomEnded?: () => void;
  onCallEnded?: (ending: RemoteCallEnding) => boolean;
  bypassMediaPermissions?: boolean;
}

const runDirectly = <T,>(operation: () => Promise<T>): Promise<T> => operation();

export function useMeetSocket({
  refs,
  roomId,
  setRoomId,
  isAdmin,
  setIsAdmin,
  user,
  userId,
  adoptJoinIdentity,
  getJoinInfo,
  joinMode = "meeting",
  requestWebinarInviteCode,
  requestMeetingInviteCode,
  displayNameInput,
  localStream,
  setLocalStream,
  selectedVideoInputDeviceId,
  getVideoPublishTrack,
  onPreferredVideoPublishTrackRejected,
  dispatchParticipants,
  setDisplayNames,
  setPendingUsers,
  setConnectionState,
  setMeetError,
  setSetupNotice,
  setWaitingMessage,
  setHostUserId,
  setHostUserIds,
  setServerRestartNotice,
  setAdminNotice,
  setWebinarConfig,
  setWebinarRole,
  setWebinarSpeakerUserId,
  setWebinarQaEntries,
  setWebinarHandQueue,
  setIsWebinarHandRaised,
  setWebinarStageInvite,
  onWebinarDemoted,
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
  setAreImageAttachmentsEnabled,
  setIsReactionsDisabled,
  setIsParticipantUnmuteAllowed,
  setIsParticipantVideoAllowed,
  setActiveScreenShareId,
  setActiveSpeakerId,
  setServerActiveSpeakerAvailable,
  setNetworkManagedVideoQuality,
  videoQualityRef,
  mediaQualitySettingsRef,
  activeVideoEffectsCount = 0,
  connectionQualityRef,
  dataSaverMode = false,
  audioOnlyMode = false,
  updateVideoQualityRef,
  requestMediaPermissions,
  requestAudioProducerRecovery,
  requestCameraProducerRecovery,
  runCameraTrackOperation = runDirectly,
  prepareAudioPublishTrack,
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
  onLocalRoomEnded,
  onCallEnded,
  bypassMediaPermissions = false,
}: UseMeetSocketOptions) {
  const participantIdsRef = useRef<Set<string>>(new Set([userId]));
  const departedParticipantIdsRef = useRef<Set<string>>(new Set());
  const webinarJoinedParticipantIdsRef = useRef<Set<string>>(new Set());
  const webinarVisibleParticipantIdsRef = useRef<Set<string>>(new Set());
  const serverRoomIdRef = useRef<string | null>(null);
  const socketRoomIdRef = useRef<string | null>(null);
  const identityRestartRoomIdRef = useRef<string | null>(null);
  const identityRestartMediaRef = useRef<{
    roomId: string;
    request: Promise<MediaStream | null>;
  } | null>(null);
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
  const consumerConsumeInFlightRef = useRef<Map<string, symbol>>(new Map());
  const consumerResumeRetryStateRef = useRef<
    Map<string, ConsumerResumeRetryState>
  >(new Map());
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
  const webcamStartupLatencyResetTimeoutsRef = useRef<Map<string, number>>(
    new Map(),
  );
  const webcamStartupLatencyResetStateRef = useRef<
    Map<string, WebcamStartupLatencyResetRuntime>
  >(new Map());
  const webcamStartupLatencyResetQueueRef = useRef<string[]>([]);
  const webcamStartupLatencyResetActiveRef = useRef<string | null>(null);
  const webcamStartupLatencyResetLastFinishedAtRef = useRef(0);
  const webcamStartupLatencyResetDrainTimeoutRef = useRef<number | null>(null);
  const webcamStartupLatencyResetEpochRef = useRef(0);
  const pendingConsumerTelemetryByIdRef = useRef<
    Map<string, ConsumerTelemetrySnapshot>
  >(new Map());
  const scheduleWebcamStartupLatencyResetRef = useRef<
    (
      producerInfo: ProducerInfo,
      consumer: Consumer,
      maximumSpatialLayer: number,
    ) => void
  >(() => {});
  const evaluateWebcamStartupLatencyResetRef = useRef<
    (producerId: string) => void
  >(() => {});
  const drainWebcamStartupLatencyResetQueueRef = useRef<() => void>(() => {});
  const runWebcamStartupLatencyResetRef = useRef<
    (producerId: string) => Promise<void>
  >(async () => {});
  const staleReplacementCleanupTimeoutsRef = useRef<Map<string, number>>(
    new Map(),
  );
  const closeConsumerRetryTimeoutsRef = useRef<Map<string, number>>(new Map());
  const closeConsumerOperationsRef = useRef<
    Map<string, ServerConsumerCloseOperation>
  >(new Map());
  const localRoomEndedHandledRef = useRef(false);
  const mutedConsumerSinceRef = useRef<Map<string, number>>(new Map());
  const producerPausedStateRef = useRef<Map<string, boolean>>(new Map());
  const producerPausedStateRevisionRef = useRef<Map<string, number>>(new Map());
  const videoFreezeStatsRef = useRef<
    Map<string, VideoFreezeRecoveryState & { consumerId: string }>
  >(new Map());
  const foregroundScreenShareKeyFrameAtRef = useRef(0);
  const consumerRecoveryInFlightRef = useRef<Map<string, symbol>>(new Map());
  const announcedRemoteProducersRef = useRef<Map<string, ProducerInfo>>(
    new Map(),
  );
  const suppressedVideoProducersRef = useRef<Map<string, ProducerInfo>>(
    new Map(),
  );
  const audioOnlyModeRef = useRef(audioOnlyMode);
  audioOnlyModeRef.current = audioOnlyMode;
  const pendingScreenProducerCloseIdsRef = useRef<Set<string>>(new Set());
  const screenShareRepublishPromiseRef = useRef<Promise<boolean> | null>(null);
  const [producerSlotOrder] = useState(createProducerSlotOrder);
  const [coalesceProducerSync] = useState(createCoalescedRunner);
  const consumeProducerRef = useRef<
    (producerInfo: ProducerInfo, options?: ConsumeProducerOptions) => Promise<void>
  >(async () => {});
  const recoverStaleConsumerRef = useRef<
    (producerInfo: ProducerInfo, reason: string) => Promise<void>
  >(async () => {});
  const syncProducersRef = useRef<() => Promise<void>>(async () => {});
  const resumeConsumerReliablyRef = useRef<
    (
      producerId: string,
      options?: { requestKeyFrame?: boolean },
      attempt?: number,
    ) => void
  >(() => {});
  const producerTransportCreatePromiseRef = useRef<Promise<boolean> | null>(
    null,
  );
  const pendingCameraCodecTransportResetEpochRef = useRef<number | null>(null);
  const iceRestartPromiseRef = useRef<
    Record<"producer" | "consumer", Promise<boolean> | null>
  >({
    producer: null,
    consumer: null,
  });
  const intentionallyClosedTransportsRef = useRef<WeakSet<Transport>>(
    new WeakSet<Transport>(),
  );

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
    lastActiveSpeakerRef,
    intentionalLocalProducerCloseIdsRef,
    consumersRef,
    adaptivelyPausedConsumerProducerIdsRef,
    consumerTelemetryRef,
    consumerGenerationResetDebugRef,
    adaptiveVideoReceiverLifecycleRef,
    producerMapRef,
    pendingProducersRef,
    leaveTimeoutsRef,
    reconnectAttemptsRef,
    reconnectInFlightRef,
    intentionalDisconnectRef,
    webcamCodecPolicyRef,
    currentRoomIdRef,
    handleRedirectRef,
    handleReconnectRef,
    shouldAutoJoinRef,
    joinOptionsRef,
    localStreamRef,
    deviceIntents,
    skipMutedMicWarmupRef,
    sessionIdRef,
    producerTransportDisconnectTimeoutRef,
    consumerTransportDisconnectTimeoutRef,
    pendingProducerRetryTimeoutRef,
    iceRestartInFlightRef,
    producerSyncIntervalRef,
  } = refs;

  const writeWebcamStartupLatencyResetDebug = useCallback(
    (state: WebcamStartupLatencyResetRuntime) => {
      const entry: ConsumerGenerationResetDebugRecord = {
        producerId: state.producerInfo.producerId,
        previousConsumerId: state.previousConsumerId,
        replacementConsumerId: state.replacementConsumerId,
        reason: WEBCAM_STARTUP_RESET_REASON,
        status: state.status,
        startedAt: state.startedAt,
        replacementStartedAt: state.replacementStartedAt,
        completedAt: state.completedAt,
        attempt: state.attempt,
        maximumSpatialLayer: state.maximumSpatialLayer,
        observedSpatialLayer: state.observedSpatialLayer,
        failureReason: state.failureReason,
      };
      const records = consumerGenerationResetDebugRef.current;
      const existingIndex = records.findIndex(
        (record) =>
          record.producerId === entry.producerId &&
          record.previousConsumerId === entry.previousConsumerId,
      );
      if (existingIndex >= 0) {
        records[existingIndex] = entry;
      } else {
        records.push(entry);
        if (records.length > 64) records.splice(0, records.length - 64);
      }
    },
    [consumerGenerationResetDebugRef],
  );

  const settleWebcamStartupLatencyReset = useCallback(
    (
      state: WebcamStartupLatencyResetRuntime,
      status: "completed" | "failed" | "cancelled",
      failureReason: string | null,
    ) => {
      if (
        state.status === "completed" ||
        state.status === "failed" ||
        state.status === "cancelled"
      ) {
        return;
      }
      const settledAt = Date.now();
      state.status = status;
      state.failureReason = failureReason;
      state.completedAt = status === "completed" ? settledAt : null;
      writeWebcamStartupLatencyResetDebug(state);
      telemetry.capture(`meet_webcam_consumer_generation_reset_${status}`, {
        reason: WEBCAM_STARTUP_RESET_REASON,
        failureReason,
        attempts: state.attempt,
        durationMs: settledAt - state.startedAt,
        maximumSpatialLayer: state.maximumSpatialLayer,
        observedSpatialLayer: state.observedSpatialLayer,
      });
    },
    [writeWebcamStartupLatencyResetDebug],
  );

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

  const getPublishNetworkProfile = useCallback(() => {
    const profile = getConnectionStatsNetworkProfile(
      connectionQualityRef?.current,
      "publish",
    );
    if (dataSaverMode && profile !== "emergency") {
      return "poor";
    }
    return profile;
  }, [connectionQualityRef, dataSaverMode]);

  const getScreenSharePublishNetworkProfile =
    useCallback((): WebcamProducerNetworkProfile => {
      const baseProfile = getPublishNetworkProfile();
      const stats = connectionQualityRef?.current;
      const browserNetwork = stats?.browserNetwork ?? getBrowserNetworkSnapshot();
      return selectScreenSharePublishNetworkProfile({
        baseProfile,
        availableOutgoingBitrateBps: stats?.availableOutgoingBitrate,
        emergencyMode:
          hasBrowserMediaEmergencyEvidence(browserNetwork) ||
          (stats?.publishEmergencyMode === true &&
            stats.publishAdaptationQuality !== "good"),
        browserNetwork,
        observedPublishQuality: stats?.publishAdaptationQuality,
      });
    }, [connectionQualityRef, getPublishNetworkProfile]);

  const getReceiveNetworkProfile = useCallback(
    () =>
      getConnectionStatsNetworkProfile(connectionQualityRef?.current, "receive"),
    [connectionQualityRef],
  );

  const getInitialConsumerNetworkProfile = useCallback(
    (producerInfo: ProducerInfo): WebcamProducerNetworkProfile => {
      const baseProfile = getReceiveNetworkProfile();
      if (producerInfo.kind !== "video" || producerInfo.type !== "screen") {
        return baseProfile;
      }

      const stats = connectionQualityRef?.current;
      const screenShareProfile =
        getScreenShareReceiveNetworkProfileForAvailableIncomingBitrate(
          stats?.availableIncomingBitrate,
        );
      return (
        getMostConstrainedWebcamProducerNetworkProfile([
          baseProfile,
          screenShareProfile,
        ]) ?? baseProfile
      );
    },
    [connectionQualityRef, getReceiveNetworkProfile],
  );

  useEffect(() => {
    participantIdsRef.current = new Set([userId]);
    departedParticipantIdsRef.current.clear();
    webinarJoinedParticipantIdsRef.current.clear();
    webinarVisibleParticipantIdsRef.current.clear();
  }, [userId]);

  const markRemoteParticipantPresent = useCallback((targetUserId: string) => {
    return departedParticipantIdsRef.current.delete(targetUserId);
  }, []);

  const markRemoteParticipantDeparted = useCallback(
    (targetUserId: string) => {
      if (targetUserId === userId) return;
      departedParticipantIdsRef.current.add(targetUserId);
      webinarJoinedParticipantIdsRef.current.delete(targetUserId);
      webinarVisibleParticipantIdsRef.current.delete(targetUserId);
    },
    [userId],
  );

  const shouldIgnoreDepartedParticipant = useCallback(
    (targetUserId: string): boolean =>
      targetUserId !== userId && departedParticipantIdsRef.current.has(targetUserId),
    [userId],
  );

  const isSupersededProducer = producerSlotOrder.isSuperseded;

  const noteRemoteProducerList = useCallback(
    (producers: readonly ProducerInfo[], requestedAt: number) => {
      producerSlotOrder.noteServerList(
        producers.filter((producer) => producer.producerUserId !== userId),
        requestedAt,
      );
    },
    [producerSlotOrder, userId],
  );

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

    const turnIceServers = runtimeTurnIceServersRef.current ?? [];
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
      ? runtimeTurnIceServersRef.current
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

  const republishScreenShareOnce = useCallback(
    async (
      reason: string,
      options: ScreenShareRepublishOptions = {},
    ): Promise<boolean> => {
      const screenStream = screenShareStreamRef.current;
      const videoTrack = getFirstLiveTrack(screenStream?.getVideoTracks() ?? []);
      if (!screenStream || !videoTrack) {
        return false;
      }

      const transport = producerTransportRef.current;
      if (!transport || transport.closed) {
        throw new Error("Screen share transport unavailable");
      }

      if (options.replaceCurrent) {
        const currentVideoProducer = screenProducerRef.current;
        const currentAudioProducer = screenAudioProducerRef.current;
        if (currentVideoProducer) {
          pendingScreenProducerCloseIdsRef.current.add(currentVideoProducer.id);
          intentionalLocalProducerCloseIdsRef.current.add(
            currentVideoProducer.id,
          );
          try {
            currentVideoProducer.close();
          } catch {}
          if (screenProducerRef.current?.id === currentVideoProducer.id) {
            screenProducerRef.current = null;
          }
        }
        if (currentAudioProducer) {
          pendingScreenProducerCloseIdsRef.current.add(currentAudioProducer.id);
          intentionalLocalProducerCloseIdsRef.current.add(
            currentAudioProducer.id,
          );
          try {
            currentAudioProducer.close();
          } catch {}
          if (screenAudioProducerRef.current?.id === currentAudioProducer.id) {
            screenAudioProducerRef.current = null;
          }
        }
      }

      await flushPendingScreenProducerCloses();

      const screenPublishSettings = resolveScreenSharePublishSettings(
        mediaQualitySettingsRef.current.screenShare,
      );
      if ("contentHint" in videoTrack) {
        videoTrack.contentHint = screenPublishSettings.contentHint;
      }

      const screenNetworkProfile = getScreenSharePublishNetworkProfile();
      await applyScreenShareTrackNetworkProfile(
        videoTrack,
        "good",
        screenPublishSettings,
      );
      const preferredScreenShareCodec = getPreferredScreenShareCodec(
        deviceRef.current,
        getCapturedDisplaySurface(videoTrack),
      );
      const producer = await produceScreenShareTrack({
        transport,
        track: videoTrack,
        networkProfile: screenNetworkProfile,
        preferredCodec: preferredScreenShareCodec,
        publishSettings: screenPublishSettings,
      });

      if (
        videoTrack.readyState !== "live" ||
        screenShareStreamRef.current !== screenStream
      ) {
        emitCloseProducer(producer.id);
        try {
          producer.close();
        } catch {}
        return false;
      }

      screenProducerRef.current = producer;
      setIsScreenSharing(true);
      setActiveScreenShareId(producer.id);
      console.info(`[Meets] Republished screen share after ${reason}`);

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

      try {
        await applyScreenShareProducerNetworkProfile(
          producer,
          screenNetworkProfile,
          screenPublishSettings,
        );
      } catch (profileErr) {
        console.warn(
          "[Meets] Failed to restore screen video network profile:",
          profileErr,
        );
      }

      const audioTrack = getFirstLiveTrack(screenStream.getAudioTracks());
      if (audioTrack) {
        try {
          if ("contentHint" in audioTrack) {
            audioTrack.contentHint = "music";
          }
          const audioProducer = await transport.produce({
            track: audioTrack,
            codecOptions: buildScreenShareAudioOpusCodecOptions(
              screenNetworkProfile,
            ),
            stopTracks: false,
            appData: {
              type: "screen" as ProducerType,
              networkProfile: screenNetworkProfile,
            } satisfies ScreenAudioProducerAppData,
          });
          try {
            await applyAudioProducerNetworkProfile(
              audioProducer,
              "screen",
              screenNetworkProfile,
            );
          } catch (profileErr) {
            console.warn(
              "[Meets] Failed to restore screen audio network profile:",
              profileErr,
            );
          }
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
      getScreenSharePublishNetworkProfile,
      intentionalLocalProducerCloseIdsRef,
      mediaQualitySettingsRef,
      pendingScreenProducerCloseIdsRef,
      producerTransportRef,
      screenAudioProducerRef,
      screenProducerRef,
      screenShareStreamRef,
      setActiveScreenShareId,
      setIsScreenSharing,
      stopScreenShareCapture,
    ],
  );

  const republishScreenShare = useCallback(
    (
      reason: string,
      options: ScreenShareRepublishOptions = {},
    ): Promise<boolean> => {
      const existing = screenShareRepublishPromiseRef.current;
      if (existing) return existing;

      const owner: { promise: Promise<boolean> | null } = { promise: null };
      const promise = (async () => {
        try {
          return await republishScreenShareOnce(reason, options);
        } finally {
          if (screenShareRepublishPromiseRef.current === owner.promise) {
            screenShareRepublishPromiseRef.current = null;
          }
        }
      })();
      owner.promise = promise;
      screenShareRepublishPromiseRef.current = promise;
      return promise;
    },
    [republishScreenShareOnce],
  );

  const cleanupRoomResources = useCallback(
    (options?: { resetRoomId?: boolean; preserveMeetingState?: boolean }) => {
      const resetRoomId = options?.resetRoomId !== false;
      const preserveMeetingState = options?.preserveMeetingState === true;
      console.info("[Meets] Cleaning up room resources...");
      if (producerSyncIntervalRef.current) {
        window.clearInterval(producerSyncIntervalRef.current);
        producerSyncIntervalRef.current = null;
      }
      if (pendingProducerRetryTimeoutRef.current) {
        window.clearTimeout(pendingProducerRetryTimeoutRef.current);
        pendingProducerRetryTimeoutRef.current = null;
      }

      consumersRef.current.forEach((consumer, producerId) => {
        if (consumer.kind === "video") {
          adaptiveVideoReceiverLifecycleRef.current({
            type: "removing",
            producerId,
            consumer,
          });
        }
        try {
          consumer.close();
        } catch {}
      });
      consumersRef.current.clear();
      for (const timeoutId of videoStallRecoveryTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      videoStallRecoveryTimeoutsRef.current.clear();
      for (const entry of consumerResumeRetryStateRef.current.values()) {
        if (entry.timeoutId != null) {
          window.clearTimeout(entry.timeoutId);
        }
      }
      consumerResumeRetryStateRef.current.clear();
      producerSlotOrder.reset();
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
      for (const timeoutId of webcamStartupLatencyResetTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      webcamStartupLatencyResetTimeoutsRef.current.clear();
      webcamStartupLatencyResetStateRef.current.clear();
      webcamStartupLatencyResetQueueRef.current = [];
      webcamStartupLatencyResetActiveRef.current = null;
      webcamStartupLatencyResetLastFinishedAtRef.current = 0;
      webcamStartupLatencyResetEpochRef.current += 1;
      if (webcamStartupLatencyResetDrainTimeoutRef.current != null) {
        window.clearTimeout(webcamStartupLatencyResetDrainTimeoutRef.current);
        webcamStartupLatencyResetDrainTimeoutRef.current = null;
      }
      consumerGenerationResetDebugRef.current = [];
      for (const timeoutId of staleReplacementCleanupTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      staleReplacementCleanupTimeoutsRef.current.clear();
      if (!preserveMeetingState) {
        for (const timeoutId of closeConsumerRetryTimeoutsRef.current.values()) {
          window.clearTimeout(timeoutId);
        }
        closeConsumerRetryTimeoutsRef.current.clear();
        for (const operation of closeConsumerOperationsRef.current.values()) {
          operation.settle(false);
        }
        closeConsumerOperationsRef.current.clear();
      }
      mutedConsumerSinceRef.current.clear();
      producerPausedStateRef.current.clear();
      producerPausedStateRevisionRef.current.clear();
      videoFreezeStatsRef.current.clear();
      consumerRecoveryInFlightRef.current.clear();
      consumerConsumeInFlightRef.current.clear();
      announcedRemoteProducersRef.current.clear();
      suppressedVideoProducersRef.current.clear();
      consumerTelemetryRef.current.clear();
      pendingConsumerTelemetryByIdRef.current.clear();
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
        setWebinarQaEntries([]);
        setWebinarHandQueue([]);
        setIsWebinarHandRaised(false);
        setWebinarStageInvite(null);
        participantIdsRef.current = new Set([userId]);
        departedParticipantIdsRef.current.clear();
        webinarJoinedParticipantIdsRef.current.clear();
        webinarVisibleParticipantIdsRef.current.clear();
        serverRoomIdRef.current = null;
      }
      webinarJoinedParticipantIdsRef.current.clear();
      webinarVisibleParticipantIdsRef.current.clear();

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
        if (producerTransportRef.current) {
          intentionallyClosedTransportsRef.current.add(
            producerTransportRef.current,
          );
        }
        producerTransportRef.current?.close();
      } catch {}
      try {
        if (consumerTransportRef.current) {
          intentionallyClosedTransportsRef.current.add(
            consumerTransportRef.current,
          );
        }
        consumerTransportRef.current?.close();
      } catch {}
      producerTransportRef.current = null;
      consumerTransportRef.current = null;
      producerTransportCreatePromiseRef.current = null;
      pendingCameraCodecTransportResetEpochRef.current = null;
      skipMutedMicWarmupRef.current = false;
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
        lastActiveSpeakerRef.current = null;
        setActiveSpeakerId(null);
        setServerActiveSpeakerAvailable(false);
        setIsHandRaised(false);
        setIsTtsDisabled(false);
        setIsDmEnabled(true);
        setAreImageAttachmentsEnabled(true);
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
      adaptiveVideoReceiverLifecycleRef,
      consumerTransportRef,
      consumersRef,
      currentRoomIdRef,
      dispatchParticipants,
      leaveTimeoutsRef,
      pendingProducersRef,
      consumerTelemetryRef,
      consumerGenerationResetDebugRef,
      producerMapRef,
      producerTransportRef,
      serverRoomIdRef,
      screenAudioProducerRef,
      screenProducerRef,
      screenShareStreamRef,
      intentionalLocalProducerCloseIdsRef,
      lastActiveSpeakerRef,
      setActiveScreenShareId,
      setActiveSpeakerId,
      setDisplayNames,
      setIsHandRaised,
      setIsScreenSharing,
      setPendingUsers,
      setHostUserId,
      setHostUserIds,
      setWebinarRole,
      setWebinarSpeakerUserId,
      setWebinarQaEntries,
      setWebinarHandQueue,
      setIsWebinarHandRaised,
      setWebinarStageInvite,
      setIsTtsDisabled,
      setIsDmEnabled,
      setAreImageAttachmentsEnabled,
      setMeetingRequiresInviteCode,
      setServerActiveSpeakerAvailable,
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
      producerSyncIntervalRef,
      consumeRetryAttemptsRef,
      videoStallRecoveryTimeoutsRef,
      staleConsumerRecoveryTimeoutsRef,
      closeConsumerRetryTimeoutsRef,
      closeConsumerOperationsRef,
      mutedConsumerSinceRef,
      producerPausedStateRef,
      consumerRecoveryInFlightRef,
      skipMutedMicWarmupRef,
      stopScreenShareCapture,
    ],
  );

  const closeConnection = useCallback(() => {
    console.info("[Meets] Running full cleanup...");

    intentionalDisconnectRef.current = true;
    reconnectGenerationRef.current += 1;
    reconnectInFlightRef.current = false;
    cleanupRoomResources();
    if (producerSyncIntervalRef.current) {
      window.clearInterval(producerSyncIntervalRef.current);
      producerSyncIntervalRef.current = null;
    }

    const localTracks = new Set([
      ...(localStreamRef.current?.getTracks() ?? []),
      ...(localStream?.getTracks() ?? []),
    ]);
    localStreamRef.current = null;
    localTracks.forEach((track) => stopLocalTrack(track));

    socketRef.current?.disconnect();
    socketRef.current = null;
    onSocketReady?.(null);
    deviceRef.current = null;
    webcamCodecPolicyRef.current = { ...BASELINE_WEBCAM_CODEC_POLICY };

    setConnectionState("disconnected");
    setLocalStream(null);
    deviceIntents.dispatch({ type: "release" });
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
    deviceIntents,
    intentionalDisconnectRef,
    reconnectInFlightRef,
    localStream,
    localStreamRef,
    reconnectAttemptsRef,
    setConnectionState,
    setLocalStream,
    setAdminNotice,
    setServerRestartNotice,
    setWaitingMessage,
    socketRef,
    deviceRef,
    webcamCodecPolicyRef,
    stopLocalTrack,
    producerSyncIntervalRef,
    updateReconnectRecoveryStatus,
    onSocketReady,
  ]);

  const cleanup = useCallback(() => {
    closeConnection();
    releaseAllCaptures();
  }, [closeConnection]);

  const releaseLocalMedia = useCallback(() => {
    const localTracks = new Set([
      ...(localStreamRef.current?.getTracks() ?? []),
      ...(localStream?.getTracks() ?? []),
    ]);
    localStreamRef.current = null;
    localTracks.forEach((track) => stopLocalTrack(track));
    setLocalStream(null);
    deviceIntents.dispatch({ type: "release" });
    stopScreenShareCapture();
    releaseAllCaptures();
  }, [
    deviceIntents,
    localStream,
    localStreamRef,
    setLocalStream,
    stopLocalTrack,
    stopScreenShareCapture,
  ]);

  const refuseEntry = useCallback(
    (error: MeetError | null, status?: ReconnectRecoveryStatus) => {
      releaseLocalMedia();
      if (status) updateReconnectRecoveryStatus(status);
      if (error) setMeetError(error);
      setConnectionState("error");
    },
    [releaseLocalMedia, setConnectionState, setMeetError, updateReconnectRecoveryStatus],
  );

  const finishLocalRoomEnded = useCallback(() => {
    if (localRoomEndedHandledRef.current) return;
    localRoomEndedHandledRef.current = true;
    setMeetError(null);
    setSetupNotice?.(null);
    setWaitingMessage(null);
    cleanup();
    onLocalRoomEnded?.();
  }, [
    cleanup,
    onLocalRoomEnded,
    setMeetError,
    setSetupNotice,
    setWaitingMessage,
  ]);

  const resolveMediaPublishIntent = useCallback(
    () => publishIntent(deviceIntents.get()),
    [deviceIntents],
  );

  const getJoinMediaNeeds = useCallback(
    () => {
      const mediaIntent = resolveMediaPublishIntent();
      return {
        needsAudio:
          mediaIntent.isMicOn || !skipMutedMicWarmupRef.current,
        needsVideo: mediaIntent.isCameraOn,
        requiredAudio: mediaIntent.isMicOn,
        requiredVideo: mediaIntent.isCameraOn,
      };
    },
    [resolveMediaPublishIntent, skipMutedMicWarmupRef],
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
      joinOptions: { isRecorder?: boolean; joinMode: JoinMode },
      reason: string,
    ) => {
      const mediaNeeds = getJoinMediaNeeds();
      const shouldRequestMedia =
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

      const mediaGeneration = reconnectGenerationRef.current;
      const refreshedStream = await requestMediaPermissions(
        buildRequestMediaPermissionsOptions(mediaNeeds),
      );
      if (
        mediaGeneration !== reconnectGenerationRef.current ||
        intentionalDisconnectRef.current
      ) {
        const currentTracks = new Set(localStreamRef.current?.getTracks() ?? []);
        refreshedStream?.getTracks().forEach((track) => {
          if (!currentTracks.has(track)) stopLocalTrack(track);
        });
        return null;
      }
      if (!refreshedStream) {
        console.warn("[Meets] Local media refresh failed before join:", {
          reason,
          previousStream: summarizeStreamForLog(candidateStream),
          mediaNeeds,
        });
        return candidateStream?.getTracks().some(
          (track) => track.readyState === "live",
        )
          ? candidateStream
          : null;
      }

      const previousTracks = candidateStream?.getTracks() ?? [];
      const committedMeanwhile = (localStreamRef.current?.getTracks() ?? []).filter(
        (track) => track.readyState === "live" && !previousTracks.includes(track),
      );
      const joinTracks = refreshedStream.getTracks().filter((track) => {
        if (committedMeanwhile.some((committed) => committed.kind === track.kind)) {
          stopLocalTrack(track);
          return false;
        }
        return true;
      });
      const joinStream =
        committedMeanwhile.length === 0
          ? refreshedStream
          : new MediaStream([...committedMeanwhile, ...joinTracks]);
      const joinTrackIds = new Set(joinStream.getTracks().map((track) => track.id));
      localStreamRef.current = joinStream;
      setLocalStream(joinStream);
      previousTracks.forEach((track) => {
        if (!joinTrackIds.has(track.id)) {
          stopLocalTrack(track);
        }
      });

      console.info("[Meets] Refreshed local media before join:", {
        reason,
        previousStream: summarizeStreamForLog(candidateStream),
        refreshedStream: summarizeStreamForLog(joinStream),
      });

      return joinStream;
    },
    [
      isCameraOff,
      isMuted,
      getJoinMediaNeeds,
      intentionalDisconnectRef,
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

  const restoreWebinarFeedParticipant = useCallback(
    (targetUserId: string, displayName?: string) => {
      const clearedDepartedParticipant =
        markRemoteParticipantPresent(targetUserId);
      if (displayName) {
        setDisplayNames((prev) => {
          const next = new Map(prev);
          next.set(targetUserId, displayName);
          return next;
        });
      }
      const leaveTimeout = leaveTimeoutsRef.current.get(targetUserId);
      if (leaveTimeout) {
        window.clearTimeout(leaveTimeout);
        leaveTimeoutsRef.current.delete(targetUserId);
      }
      clearParticipantConnectionStatus(targetUserId);
      dispatchParticipants({
        type: "ADD_PARTICIPANT",
        userId: targetUserId,
        addIfMissing: false,
        reviveIfPresent: true,
      });
      return clearedDepartedParticipant;
    },
    [
      clearParticipantConnectionStatus,
      dispatchParticipants,
      leaveTimeoutsRef,
      markRemoteParticipantPresent,
      setDisplayNames,
    ],
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
      if (shouldIgnoreDepartedParticipant(targetUserId)) return;

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
      shouldIgnoreDepartedParticipant,
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

  const applyWebcamCodecPolicyNotification = useCallback(
    (value: WebcamCodecPolicy & { roomId?: string }) => {
      if (!isRoomEvent(value?.roomId)) return;
      const next = normalizeWebcamCodecPolicy(value);
      if (!next) {
        console.warn("[Meets] Ignoring invalid webcam codec policy:", value);
        return;
      }

      const current = webcamCodecPolicyRef.current;
      if (!isNewerWebcamCodecPolicy(current, next)) return;
      webcamCodecPolicyRef.current = next;
      if (next.codec === current.codec) return;

      telemetry.capture("meet_webcam_codec_policy_changed", {
        from: current.codec,
        to: next.codec,
        epoch: next.epoch,
      });

      const resetProducerTransportForCodecChange = () => {
        const transport = producerTransportRef.current;
        if (transport && !transport.closed) {
          try {
            intentionallyClosedTransportsRef.current.add(transport);
            transport.close();
          } catch {}
        }
        if (producerTransportRef.current === transport) {
          producerTransportRef.current = null;
        }
        if (deviceIntents.get().audio.chosen) requestAudioProducerRecovery();
      };

      const producer = videoProducerRef.current;
      if (!producer || producer.closed) {
        pendingCameraCodecTransportResetEpochRef.current = next.epoch;
        if (deviceIntents.get().video.chosen) {
          requestCameraProducerRecovery();
        }
        return;
      }

      if (!deviceIntents.get().video.chosen) {
        pendingCameraCodecTransportResetEpochRef.current = next.epoch;
        if (producer && !producer.closed) {
          intentionalLocalProducerCloseIdsRef.current.add(producer.id);
          emitCloseProducer(producer.id);
          try {
            producer.close();
          } catch {}
          if (videoProducerRef.current?.id === producer.id) {
            videoProducerRef.current = null;
          }
        }
        return;
      }

      const producerId = producer.id;
      intentionalLocalProducerCloseIdsRef.current.add(producerId);
      emitCloseProducer(producerId);
      try {
        producer.close();
      } catch {}
      if (videoProducerRef.current?.id === producerId) {
        videoProducerRef.current = null;
      }
      resetProducerTransportForCodecChange();
      requestCameraProducerRecovery();
    },
    [
      emitCloseProducer,
      intentionalLocalProducerCloseIdsRef,
      isRoomEvent,
      requestCameraProducerRecovery,
      requestAudioProducerRecovery,
      producerTransportRef,
      intentionallyClosedTransportsRef,
      videoProducerRef,
      webcamCodecPolicyRef,
    ],
  );

  const reportCurrentWebcamCodecFailure = useCallback(
    (error: unknown): boolean => {
      const policy = webcamCodecPolicyRef.current;
      if (
        policy.codec !== "vp9" ||
        classifyVp9CodecFailure(error) !==
          "proven-encoder-incompatibility"
      ) {
        return false;
      }

      rememberProvenVp9EncoderIncompatibility({
        handlerName: deviceRef.current?.handlerName ?? "unknown-handler",
        videoInputDeviceId: selectedVideoInputDeviceId,
      });

      const socket = socketRef.current;
      if (!socket?.connected) return false;

      console.warn(
        "[Meets] Reporting failed VP9 SVC webcam production; requesting room fallback:",
        error,
      );
      socket.emit(
        "reportWebcamCodecFailure",
        { codec: "vp9", epoch: policy.epoch },
        (
          response:
            | { success: true; webcamCodecPolicy: WebcamCodecPolicy }
            | { error: string },
        ) => {
          if ("error" in response) {
            console.warn(
              "[Meets] Webcam codec fallback report was not applied:",
              response.error,
            );
            return;
          }
          applyWebcamCodecPolicyNotification({
            ...response.webcamCodecPolicy,
            roomId: serverRoomIdRef.current ?? currentRoomIdRef.current ?? undefined,
          });
        },
      );
      return true;
    },
    [
      applyWebcamCodecPolicyNotification,
      currentRoomIdRef,
      serverRoomIdRef,
      deviceRef,
      selectedVideoInputDeviceId,
      socketRef,
      webcamCodecPolicyRef,
    ],
  );

  const applyServerActiveSpeaker = useCallback(
    (userId: string | null | undefined) => {
      const nextSpeakerId =
        typeof userId === "string" && userId.length > 0 ? userId : null;

      setServerActiveSpeakerAvailable(true);
      lastActiveSpeakerRef.current = nextSpeakerId
        ? { id: nextSpeakerId, ts: Date.now() }
        : null;
      setActiveSpeakerId((current) =>
        current === nextSpeakerId ? current : nextSpeakerId,
      );
    },
    [lastActiveSpeakerRef, setActiveSpeakerId, setServerActiveSpeakerAvailable],
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

  const clearConsumerResumeRetry = useCallback(
    (producerId: string, expectedConsumerId?: string) => {
      const entry = consumerResumeRetryStateRef.current.get(producerId);
      if (!entry) return;
      if (
        expectedConsumerId !== undefined &&
        entry.consumerId !== expectedConsumerId
      ) {
        return;
      }
      if (entry.timeoutId != null) {
        window.clearTimeout(entry.timeoutId);
      }
      consumerResumeRetryStateRef.current.delete(producerId);
    },
    [],
  );

  const resumeConsumerReliably = useCallback(
    (
      producerId: string,
      options: { requestKeyFrame?: boolean } = {},
      attempt = 0,
    ) => {
      const socket = socketRef.current;
      const consumer = consumersRef.current.get(producerId);
      if (!socket?.connected || !consumer || consumer.closed) {
        clearConsumerResumeRetry(producerId);
        return;
      }
      const consumerId = consumer.id;

      const existingRetryState =
        consumerResumeRetryStateRef.current.get(producerId);
      if (existingRetryState?.timeoutId != null) {
        window.clearTimeout(existingRetryState.timeoutId);
      }
      const effectiveAttempt = getConsumerResumeEffectiveAttempt(
        existingRetryState,
        consumerId,
        attempt,
      );
      consumerResumeRetryStateRef.current.set(producerId, {
        consumerId,
        timeoutId: null,
        attempt: effectiveAttempt,
      });

      const ownsCurrentResumeState = () =>
        isConsumerResumeSettlementCurrent(
          consumersRef.current.get(producerId)?.id,
          consumerResumeRetryStateRef.current.get(producerId),
          consumerId,
        );

      const buildProducerInfoForRecovery = (): ProducerInfo | null => {
        const entry = producerMapRef.current.get(producerId);
        if (!entry) return null;
        return {
          producerId,
          producerUserId: entry.userId,
          kind: entry.kind,
          type: entry.type,
        };
      };

      const scheduleRetry = (reason: string) => {
        if (!ownsCurrentResumeState()) return;
        const nextAttempt = effectiveAttempt + 1;
        if (nextAttempt >= RESUME_CONSUMER_MAX_ATTEMPTS) {
          clearConsumerResumeRetry(producerId, consumerId);
          console.warn(
            `[Meets] resumeConsumer retries exhausted for producer ${producerId}: ${reason}`,
          );
          telemetry.capture("meet_consumer_resume_exhausted", {
            kind: consumer.kind,
            attempts: nextAttempt,
            reason,
          });
          const producerInfo = buildProducerInfoForRecovery();
          if (producerInfo) {
            void recoverStaleConsumerRef.current(
              producerInfo,
              `resume retries exhausted (${reason})`,
            );
          }
          return;
        }
        clearConsumerResumeRetry(producerId, consumerId);
        const timeoutId = window.setTimeout(() => {
          const entry = consumerResumeRetryStateRef.current.get(producerId);
          if (
            !entry ||
            !isConsumerResumeSettlementCurrent(
              consumersRef.current.get(producerId)?.id,
              entry,
              consumerId,
            )
          ) {
            return;
          }
          entry.timeoutId = null;
          resumeConsumerReliablyRef.current(producerId, options, nextAttempt);
        }, getResumeConsumerRetryDelayMs(effectiveAttempt));
        consumerResumeRetryStateRef.current.set(producerId, {
          consumerId,
          timeoutId,
          attempt: nextAttempt,
        });
      };

      const settleResume = startSocketAckTimeout(
        "resumeConsumer",
        () => scheduleRetry("ack timeout"),
        RESUME_CONSUMER_ACK_TIMEOUT_MS,
      );
      socket.emit(
        "resumeConsumer",
        {
          consumerId,
          requestKeyFrame: options.requestKeyFrame === true,
        },
        (response?: { success?: boolean; error?: string; code?: string }) => {
          if (!settleResume()) return;
          if (!ownsCurrentResumeState()) return;
          const error =
            response && typeof response.error === "string"
              ? response.error
              : null;
          if (error) {
            const code =
              response?.code ??
              (/consumer not found/i.test(error)
                ? "not_found"
                : /too many consumer control/i.test(error)
                  ? "rate_limited"
                  : undefined);
            if (code === "not_found") {
              clearConsumerResumeRetry(producerId, consumerId);
              const producerInfo = buildProducerInfoForRecovery();
              if (producerInfo) {
                void recoverStaleConsumerRef.current(
                  producerInfo,
                  "server lost consumer on resume",
                );
              }
              return;
            }
            scheduleRetry(code ?? error);
            return;
          }
          clearConsumerResumeRetry(producerId, consumerId);
          if (effectiveAttempt > 0) {
            telemetry.capture("meet_consumer_resume_recovered", {
              kind: consumer.kind,
              attempts: effectiveAttempt + 1,
            });
          }
        },
      );
    },
    [clearConsumerResumeRetry, consumersRef, producerMapRef, socketRef],
  );
  resumeConsumerReliablyRef.current = resumeConsumerReliably;

  const setProducerPausedState = useCallback(
    (producerId: string, paused: boolean) => {
      const wasPaused = producerPausedStateRef.current.get(producerId);
      producerPausedStateRef.current.set(producerId, paused);
      producerPausedStateRevisionRef.current.set(
        producerId,
        (producerPausedStateRevisionRef.current.get(producerId) ?? 0) + 1,
      );

      mutedConsumerSinceRef.current.delete(producerId);
      clearStaleConsumerRecoveryTimeout(producerId);

      if (paused) {
        return;
      }

      if (wasPaused !== true) {
        return;
      }

      if (adaptivelyPausedConsumerProducerIdsRef.current.has(producerId)) {
        return;
      }

      const consumer = consumersRef.current.get(producerId);
      if (consumer) {
        resumeConsumerReliably(producerId, {
          requestKeyFrame: consumer.kind === "video",
        });
      }
    },
    [
      adaptivelyPausedConsumerProducerIdsRef,
      clearStaleConsumerRecoveryTimeout,
      consumersRef,
      resumeConsumerReliably,
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
      const currentConsumer = consumersRef.current.get(producerId) ?? null;
      const consumer = consumerToClose ?? currentConsumer;
      const consumerIdToClose = consumer?.id ?? null;
      const closesCurrentGeneration =
        consumerIdToClose !== null &&
        isCurrentConsumerGeneration({
          currentConsumerId: currentConsumer?.id ?? null,
          closingConsumerId: consumerIdToClose,
        });

      if (closesCurrentGeneration) {
        pendingProducersRef.current.delete(producerId);
        consumeRetryAttemptsRef.current.delete(producerId);
        const scheduledRecoveryTimeout =
          videoStallRecoveryTimeoutsRef.current.get(producerId);
        if (scheduledRecoveryTimeout != null) {
          window.clearTimeout(scheduledRecoveryTimeout);
          videoStallRecoveryTimeoutsRef.current.delete(producerId);
        }
        clearConsumerResumeRetry(producerId);
        clearStaleConsumerRecoveryTimeout(producerId);
        clearStaleReplacementCleanupTimeout(producerId);
        mutedConsumerSinceRef.current.delete(producerId);
        adaptivelyPausedConsumerProducerIdsRef.current.delete(producerId);
        videoFreezeStatsRef.current.delete(producerId);
      }
      if (
        consumerIdToClose !== null &&
        consumerTelemetryRef.current.get(producerId)?.consumerId ===
          consumerIdToClose
      ) {
        consumerTelemetryRef.current.delete(producerId);
      }
      if (consumerIdToClose !== null) {
        pendingConsumerTelemetryByIdRef.current.delete(consumerIdToClose);
      }

      if (!consumer) return;
      if (consumer.kind === "video") {
        adaptiveVideoReceiverLifecycleRef.current({
          type: "removing",
          producerId,
          consumer,
        });
      }
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
      adaptiveVideoReceiverLifecycleRef,
      adaptivelyPausedConsumerProducerIdsRef,
      clearConsumerResumeRetry,
      clearStaleConsumerRecoveryTimeout,
      clearStaleReplacementCleanupTimeout,
      consumeRetryAttemptsRef,
      consumerTelemetryRef,
      consumersRef,
      mutedConsumerSinceRef,
      pendingProducersRef,
      videoFreezeStatsRef,
      videoStallRecoveryTimeoutsRef,
      pendingConsumerTelemetryByIdRef,
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
      clearConsumerResumeRetry(producerId);
      clearStaleConsumerRecoveryTimeout(producerId);
      const startupLatencyResetTimeout =
        webcamStartupLatencyResetTimeoutsRef.current.get(producerId);
      if (startupLatencyResetTimeout != null) {
        window.clearTimeout(startupLatencyResetTimeout);
        webcamStartupLatencyResetTimeoutsRef.current.delete(producerId);
      }
      const startupLatencyResetState =
        webcamStartupLatencyResetStateRef.current.get(producerId);
      if (startupLatencyResetState) {
        settleWebcamStartupLatencyReset(
          startupLatencyResetState,
          "cancelled",
          "producer-closed",
        );
        webcamStartupLatencyResetStateRef.current.delete(producerId);
      }
      webcamStartupLatencyResetQueueRef.current =
        webcamStartupLatencyResetQueueRef.current.filter(
          (queuedProducerId) => queuedProducerId !== producerId,
        );
      producerSlotOrder.forget(producerId);
      mutedConsumerSinceRef.current.delete(producerId);
      producerPausedStateRef.current.delete(producerId);
      suppressedVideoProducersRef.current.delete(producerId);
      producerPausedStateRevisionRef.current.delete(producerId);
      adaptivelyPausedConsumerProducerIdsRef.current.delete(producerId);
      consumerTelemetryRef.current.delete(producerId);
      for (const [
        pendingConsumerId,
        pendingTelemetry,
      ] of pendingConsumerTelemetryByIdRef.current.entries()) {
        if (pendingTelemetry.producerId === producerId) {
          pendingConsumerTelemetryByIdRef.current.delete(pendingConsumerId);
        }
      }
      videoFreezeStatsRef.current.delete(producerId);
      consumerRecoveryInFlightRef.current.delete(producerId);
      const consumer = consumersRef.current.get(producerId);
      if (consumer) {
        if (consumer.kind === "video") {
          adaptiveVideoReceiverLifecycleRef.current({
            type: "removing",
            producerId,
            consumer,
          });
        }
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
      adaptiveVideoReceiverLifecycleRef,
      consumersRef,
      dispatchParticipants,
      pendingProducersRef,
      consumeRetryAttemptsRef,
      videoStallRecoveryTimeoutsRef,
      adaptivelyPausedConsumerProducerIdsRef,
      consumerTelemetryRef,
      clearConsumerResumeRetry,
      clearStaleConsumerRecoveryTimeout,
      producerSlotOrder,
      mutedConsumerSinceRef,
      producerPausedStateRef,
      consumerRecoveryInFlightRef,
      producerMapRef,
      announcedRemoteProducersRef,
      suppressedVideoProducersRef,
      clearStaleReplacementCleanupTimeout,
      setActiveScreenShareId,
      settleWebcamStartupLatencyReset,
      pendingConsumerTelemetryByIdRef,
    ],
  );

  const closeServerConsumer = useCallback(
    (consumerId?: string | null): Promise<boolean> => {
      if (!consumerId) return Promise.resolve(false);

      const existingOperation = closeConsumerOperationsRef.current.get(consumerId);
      if (existingOperation) return existingOperation.promise;

      const retryDeadlineAt = Date.now() + CLOSE_CONSUMER_RETRY_WINDOW_MS;
      let settled = false;
      let resolveOperation: (success: boolean) => void = () => {};
      const promise = new Promise<boolean>((resolve) => {
        resolveOperation = resolve;
      });
      const operation: ServerConsumerCloseOperation = {
        promise,
        settle: (success) => {
          if (settled) return;
          settled = true;
          const timeoutId =
            closeConsumerRetryTimeoutsRef.current.get(consumerId);
          if (timeoutId != null) window.clearTimeout(timeoutId);
          closeConsumerRetryTimeoutsRef.current.delete(consumerId);
          closeConsumerOperationsRef.current.delete(consumerId);
          resolveOperation(success);
        },
      };
      closeConsumerOperationsRef.current.set(consumerId, operation);

      const retryWindowRemainingMs = () => retryDeadlineAt - Date.now();
      const giveUp = (reason: string) => {
        console.warn("[Meets] Gave up closing server consumer:", {
          consumerId,
          reason,
        });
        operation.settle(false);
      };
      const scheduleCloseRetry = (attempt: number) => {
        const remainingMs = retryWindowRemainingMs();
        if (remainingMs <= 0) {
          giveUp("retry window exhausted");
          return;
        }

        const timeoutId = window.setTimeout(
          () => {
            if (
              closeConsumerRetryTimeoutsRef.current.get(consumerId) !==
              timeoutId
            ) {
              return;
            }
            closeConsumerRetryTimeoutsRef.current.delete(consumerId);
            closeWithRetry(attempt);
          },
          Math.min(CLOSE_CONSUMER_RETRY_DELAY_MS, remainingMs),
        );
        closeConsumerRetryTimeoutsRef.current.set(consumerId, timeoutId);
      };

      const closeWithRetry = (attempt: number) => {
        const remainingMs = retryWindowRemainingMs();
        if (remainingMs <= 0) {
          giveUp("retry window exhausted");
          return;
        }
        const socket = socketRef.current;
        if (!socket?.connected) {
          scheduleCloseRetry(attempt);
          return;
        }

        const ackTimeoutId = window.setTimeout(() => {
          if (
            closeConsumerRetryTimeoutsRef.current.get(consumerId) !==
            ackTimeoutId
          ) {
            return;
          }
          closeConsumerRetryTimeoutsRef.current.delete(consumerId);
          if (attempt + 1 >= CLOSE_CONSUMER_MAX_ATTEMPTS) {
            giveUp("acknowledgement timeout");
            return;
          }
          scheduleCloseRetry(attempt + 1);
        }, Math.max(
          1,
          Math.min(CLOSE_CONSUMER_ACK_TIMEOUT_MS, remainingMs),
        ));
        closeConsumerRetryTimeoutsRef.current.set(consumerId, ackTimeoutId);

        socket.emit(
          "closeConsumer",
          { consumerId },
          (response: { success: boolean } | { error: string }) => {
            if (
              closeConsumerRetryTimeoutsRef.current.get(consumerId) !==
              ackTimeoutId
            ) {
              return;
            }
            window.clearTimeout(ackTimeoutId);
            closeConsumerRetryTimeoutsRef.current.delete(consumerId);
            if (!("error" in response) && response.success === true) {
              operation.settle(true);
              return;
            }

            if (!("error" in response)) {
              giveUp("negative acknowledgement");
              return;
            }

            if (
              attempt + 1 >= CLOSE_CONSUMER_MAX_ATTEMPTS ||
              !/too many consumer control requests|retry shortly/i.test(
                response.error,
              )
            ) {
              giveUp(response.error);
              return;
            }

            scheduleCloseRetry(attempt + 1);
          },
        );
      };

      closeWithRetry(0);
      return promise;
    },
    [closeConsumerOperationsRef, closeConsumerRetryTimeoutsRef, socketRef],
  );

  const closeServerConsumerBeforeDeadline = useCallback(
    (consumerId: string, deadlineAt: number): Promise<boolean> => {
      const closePromise = closeServerConsumer(consumerId);
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) return Promise.resolve(false);

      return new Promise((resolve) => {
        let settled = false;
        const timeoutId = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(false);
        }, remainingMs);
        void closePromise.then((closed) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeoutId);
          resolve(closed);
        });
      });
    },
    [closeServerConsumer],
  );

  const resumeConsumerForMakeBeforeBreak = useCallback(
    async ({
      consumerId,
      deadlineAt,
      isOwned,
    }: {
      consumerId: string;
      deadlineAt: number;
      isOwned: () => boolean;
    }): Promise<boolean> => {
      for (
        let attempt = 0;
        attempt < WEBCAM_STARTUP_RESET_RESUME_MAX_ATTEMPTS;
        attempt += 1
      ) {
        if (!isOwned()) return false;
        const socket = socketRef.current;
        const remainingMs = deadlineAt - Date.now();
        if (!socket?.connected || remainingMs <= 0) return false;

        const result = await new Promise<"success" | "retry" | "fatal">(
          (resolve) => {
            let settled = false;
            const timeoutId = window.setTimeout(() => {
              if (settled) return;
              settled = true;
              resolve("retry");
            }, Math.max(1, Math.min(
              WEBCAM_STARTUP_RESET_RESUME_ACK_TIMEOUT_MS,
              remainingMs,
            )));
            socket.emit(
              "resumeConsumer",
              { consumerId, requestKeyFrame: true },
              (response?: {
                success?: boolean;
                error?: string;
                code?: string;
              }) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timeoutId);
                if (response?.success === true && !response.error) {
                  resolve("success");
                  return;
                }
                const error = response?.error ?? "missing resume acknowledgement";
                const retryable =
                  response?.code === "rate_limited" ||
                  /too many consumer control requests|retry shortly|timeout/i.test(
                    error,
                  );
                resolve(retryable ? "retry" : "fatal");
              },
            );
          },
        );
        if (result === "success") return isOwned();
        if (result === "fatal") return false;

        const retryDelayMs = Math.min(250, deadlineAt - Date.now());
        if (retryDelayMs <= 0) return false;
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, retryDelayMs);
        });
      }
      return false;
    },
    [socketRef],
  );

  const prepareConsumerMakeBeforeBreak = useCallback(
    async ({
      producerId,
      consumer,
      expectedPreviousConsumerId,
      deadlineAt,
      resetEpoch,
    }: {
      producerId: string;
      consumer: Consumer;
      expectedPreviousConsumerId: string;
      deadlineAt: number;
      resetEpoch: number;
    }): Promise<boolean> => {
      const verificationStartedAt = Date.now();
      const verificationDeadlineAt = Math.min(
        deadlineAt,
        verificationStartedAt + WEBCAM_STARTUP_RESET_VERIFY_TIMEOUT_MS,
      );
      const isOwned = () =>
        (() => {
          const previousConsumer = consumersRef.current.get(producerId);
          return (
            resetEpoch === webcamStartupLatencyResetEpochRef.current &&
            !consumer.closed &&
            previousConsumer?.id === expectedPreviousConsumerId &&
            !previousConsumer.closed &&
            previousConsumer.track.readyState === "live" &&
            !previousConsumer.paused &&
            producerPausedStateRef.current.get(producerId) !== true &&
            !adaptivelyPausedConsumerProducerIdsRef.current.has(producerId)
          );
        })();

      const resumed = await resumeConsumerForMakeBeforeBreak({
        consumerId: consumer.id,
        deadlineAt: verificationDeadlineAt,
        isOwned,
      });
      if (!resumed) return false;

      while (isOwned()) {
        const now = Date.now();
        const remainingMs = verificationDeadlineAt - now;
        const flow = await readConsumerVideoFlowSnapshotWithin(
          consumer,
          Math.min(500, Math.max(1, remainingMs)),
        );
        if (!isOwned()) return false;
        const decision = decideWebcamStartupResetVerification({
          now: Date.now(),
          verificationStartedAt,
          verificationTimeoutMs:
            verificationDeadlineAt - verificationStartedAt,
          replacementConsumerId: consumer.id,
          currentConsumerId: consumer.id,
          consumerClosed: consumer.closed,
          trackReadyState: consumer.track.readyState,
          trackMuted: consumer.track.muted,
          framesDecoded: flow.framesDecoded,
          bytesReceived: flow.bytesReceived,
        });
        if (decision.action === "complete") return true;
        if (decision.action !== "wait") return false;

        const pollDelayMs = Math.min(
          WEBCAM_STARTUP_RESET_VERIFY_POLL_MS,
          verificationDeadlineAt - Date.now(),
        );
        if (pollDelayMs <= 0) return false;
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, pollDelayMs);
        });
      }
      return false;
    },
    [
      adaptivelyPausedConsumerProducerIdsRef,
      consumersRef,
      producerPausedStateRef,
      resumeConsumerForMakeBeforeBreak,
    ],
  );

  const dropDepartedProducer = useCallback(
    (producerInfo: ProducerInfo) => {
      const producerId = producerInfo.producerId;
      const existingConsumer = consumersRef.current.get(producerId);
      if (
        existingConsumer ||
        producerMapRef.current.has(producerId)
      ) {
        void closeServerConsumer(existingConsumer?.id);
        handleProducerClosed(producerId);
        return;
      }

      announcedRemoteProducersRef.current.delete(producerId);
      suppressedVideoProducersRef.current.delete(producerId);
      pendingProducersRef.current.delete(producerId);
      consumeRetryAttemptsRef.current.delete(producerId);
      producerPausedStateRef.current.delete(producerId);
      producerPausedStateRevisionRef.current.delete(producerId);
    },
    [
      announcedRemoteProducersRef,
      consumeRetryAttemptsRef,
      closeServerConsumer,
      consumersRef,
      handleProducerClosed,
      pendingProducersRef,
      producerMapRef,
      producerPausedStateRef,
      suppressedVideoProducersRef,
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
        const snapshotHasScreenShareVideo = pending.some(
          (pendingProducer) =>
            pendingProducer.kind === "video" &&
            pendingProducer.type === "screen",
        );
        for (const pendingProducer of pending) {
          void consumeProducerRef.current(pendingProducer, {
            knownScreenShareVideoActive: snapshotHasScreenShareVideo,
          });
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

      const restartPromise: Promise<boolean> = (async () => {
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
          console.info(
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
        const settleCreateTransport = startSocketAckTimeout(
          "createProducerTransport",
          reject,
        );
        socket.emit(
          "createProducerTransport",
          (response: TransportResponse | { error: string }) => {
            if (!settleCreateTransport()) return;
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
                const settleConnectTransport = startSocketAckTimeout(
                  "connectProducerTransport",
                  errback,
                );
                socket.emit(
                  "connectProducerTransport",
                  { transportId: transport.id, dtlsParameters },
                  (res: { success: boolean } | { error: string }) => {
                    if (!settleConnectTransport()) return;
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
                const settleProduce = startSocketAckTimeout(
                  "produce",
                  errback,
                );
                socket.emit(
                  "produce",
                  { transportId: transport.id, kind, rtpParameters, appData },
                  (res: { producerId: string } | { error: string }) => {
                    if (!settleProduce()) return;
                    if ("error" in res) errback(new Error(res.error));
                    else callback({ id: res.producerId });
                  },
                );
              },
            );

            transport.on("connectionstatechange", (state: string) => {
              console.info("[Meets] Producer transport state:", state);
              if (
                state === "closed" &&
                intentionallyClosedTransportsRef.current.delete(transport)
              ) {
                return;
              }
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
                        void attemptIceRestart("producer").then((restarted) => {
                          if (!restarted) {
                            const enabledTurnFallback = enableTurnFallback(
                              "Producer transport could not recover with STUN-only ICE",
                            );
                            if (enabledTurnFallback) {
                              void handleReconnectRef.current?.();
                              return;
                            }
                            setMeetError({
                              code: "TRANSPORT_ERROR",
                              message: "Producer transport interrupted",
                              recoverable: true,
                            });
                            void handleReconnectRef.current?.();
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
                  void attemptIceRestart("producer").then((restarted) => {
                    if (!restarted) {
                      const enabledTurnFallback = enableTurnFallback(
                        "Producer transport failed with STUN-only ICE",
                      );
                      if (enabledTurnFallback) {
                        void handleReconnectRef.current?.();
                        return;
                      }
                      setMeetError({
                        code: "TRANSPORT_ERROR",
                        message: "Producer transport failed",
                        recoverable: true,
                      });
                      void handleReconnectRef.current?.();
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
                  void handleReconnectRef.current?.();
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

  const ensureProducerTransport = useCallback(
    async (
      options: ProducerTransportEnsureOptions = {},
    ): Promise<boolean> => {
      let pendingResetEpoch = options.forCameraPublish
        ? pendingCameraCodecTransportResetEpochRef.current
        : null;

      if (
        pendingResetEpoch !== null &&
        producerTransportCreatePromiseRef.current
      ) {
        await producerTransportCreatePromiseRef.current;
        pendingResetEpoch = pendingCameraCodecTransportResetEpochRef.current;
      }

      const existingTransport = producerTransportRef.current;
      const hasUsableTransport = Boolean(
        getUsableProducerTransport(existingTransport),
      );
      if (
        !shouldRecreateProducerTransport({
          hasUsableTransport,
          pendingCameraCodecResetEpoch: pendingResetEpoch,
          forCameraPublish: options.forCameraPublish === true,
        })
      ) {
        return true;
      }
      if (existingTransport) {
        try {
          intentionallyClosedTransportsRef.current.add(existingTransport);
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

      const codecResetEpochSatisfiedByCreation =
        pendingCameraCodecTransportResetEpochRef.current;
      producerTransportCreatePromiseRef.current = (async () => {
        try {
          await createProducerTransport(socket, device);
          const transport = producerTransportRef.current;
          const ready = Boolean(transport && !transport.closed);
          if (
            ready &&
            screenShareStreamRef.current &&
            (!screenProducerRef.current || screenProducerRef.current.closed)
          ) {
            try {
              await republishScreenShare("producer transport recreation");
            } catch (error) {
              console.warn(
                "[Meets] Screen share recovery after producer transport recreation failed:",
                error,
              );
            }
          }
          if (
            ready &&
            codecResetEpochSatisfiedByCreation !== null &&
            pendingCameraCodecTransportResetEpochRef.current ===
              codecResetEpochSatisfiedByCreation
          ) {
            pendingCameraCodecTransportResetEpochRef.current = null;
          }
          return ready;
        } catch (err) {
          console.error("[Meets] Failed to create producer transport:", err);
          return false;
        } finally {
          producerTransportCreatePromiseRef.current = null;
        }
      })();

      return producerTransportCreatePromiseRef.current;
    },
    [
      createProducerTransport,
      deviceRef,
      producerTransportRef,
      republishScreenShare,
      screenProducerRef,
      screenShareStreamRef,
      socketRef,
    ],
  );

  const createConsumerTransport = useCallback(
    async (socket: Socket, device: Device): Promise<void> => {
      return new Promise((resolve, reject) => {
        const settleCreateTransport = startSocketAckTimeout(
          "createConsumerTransport",
          reject,
        );
        socket.emit(
          "createConsumerTransport",
          (response: TransportResponse | { error: string }) => {
            if (!settleCreateTransport()) return;
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
                const settleConnectTransport = startSocketAckTimeout(
                  "connectConsumerTransport",
                  errback,
                );
                socket.emit(
                  "connectConsumerTransport",
                  { transportId: transport.id, dtlsParameters },
                  (res: { success: boolean } | { error: string }) => {
                    if (!settleConnectTransport()) return;
                    if ("error" in res) errback(new Error(res.error));
                    else callback();
                  },
                );
              },
            );

            transport.on("connectionstatechange", (state: string) => {
              console.info("[Meets] Consumer transport state:", state);
              if (
                state === "closed" &&
                intentionallyClosedTransportsRef.current.delete(transport)
              ) {
                return;
              }
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
                        void attemptIceRestart("consumer").then((restarted) => {
                          if (!restarted) {
                            const enabledTurnFallback = enableTurnFallback(
                              "Consumer transport could not recover with STUN-only ICE",
                            );
                            if (enabledTurnFallback) {
                              void handleReconnectRef.current?.();
                              return;
                            }
                            void handleReconnectRef.current?.();
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
                  void attemptIceRestart("consumer").then((restarted) => {
                    if (!restarted) {
                      const enabledTurnFallback = enableTurnFallback(
                        "Consumer transport failed with STUN-only ICE",
                      );
                      if (enabledTurnFallback) {
                        void handleReconnectRef.current?.();
                        return;
                      }
                      void handleReconnectRef.current?.();
                    }
                  });
                }
              }
              if (state === "closed") {
                if (!intentionalDisconnectRef.current) {
                  void handleReconnectRef.current?.();
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
    async (
      stream: MediaStream,
      participantMediaPermissions: {
        unmuteAllowed: boolean;
        videoAllowed: boolean;
      } = { unmuteAllowed: true, videoAllowed: true },
    ): Promise<void> => {
      const transport = producerTransportRef.current;
      if (!transport) return;
      const generation = captureGeneration();
      const committedStream = () => localStreamRef.current ?? stream;
      const committedMic = () => getFirstLiveTrack(committedStream().getAudioTracks());
      const publicationWarnings: string[] = [];
      const mediaIntent = resolveMediaPublishIntent();
      const pauseAudioNow = () =>
        !deviceIntents.get().audio.chosen || !participantMediaPermissions.unmuteAllowed;
      const intentsAtStart = deviceIntents.get();
      const requestAtStart = (device: "audio" | "video") =>
        intentsAtStart[device].capturing ? -1 : intentsAtStart[device].request;
      const micRequest = requestAtStart("audio");
      const cameraRequest = requestAtStart("video");
      const ownsMic = () =>
        deviceIntents.get().audio.request === micRequest && generation === captureGeneration();
      const ownsCamera = () =>
        deviceIntents.get().video.request === cameraRequest && generation === captureGeneration();
      const cameraWantedNow = () =>
        ownsCamera() && deviceIntents.get().video.chosen && participantMediaPermissions.videoAllowed;
      const discardJoinProducer = (producer: Producer) => {
        socketRef.current?.emit("closeProducer", { producerId: producer.id }, () => {});
        try {
          producer.close();
        } catch {}
      };
      const closeJoinVideoProducer = (producer: Producer, joinStream: MediaStream) => {
        discardJoinProducer(producer);
        dropVideoTracksForCameraOff(joinStream, "camera turned off while joining");
      };
      const shouldPauseAudio =
        !mediaIntent.isMicOn || !participantMediaPermissions.unmuteAllowed;
      const shouldPauseVideo =
        !mediaIntent.isCameraOn || !participantMediaPermissions.videoAllowed;

      if (mediaIntent.isMicOn && shouldPauseAudio) {
        setIsMuted(true);
      }

      let audioTrack = committedMic();
      if (audioTrack) {
        try {
          const rawAudioTrack = audioTrack;
          const preparedTrack =
            (await prepareAudioPublishTrack?.(audioTrack, generation)) ?? audioTrack;
          if (preparedTrack.id !== rawAudioTrack.id) {
            if (committedMic() === rawAudioTrack) {
              const nextStream = new MediaStream([
                ...committedStream().getTracks().filter((track) => track.kind !== "audio"),
                preparedTrack,
              ]);
              localStreamRef.current = nextStream;
              setLocalStream(nextStream);
            } else {
              stopNoiseCancellationForTrack(preparedTrack, { stopOutput: true, stopSource: false });
            }
          }
          audioTrack = committedMic();
          if (!audioTrack) throw new Error("The microphone was replaced while joining");
          if ("contentHint" in audioTrack) {
            audioTrack.contentHint = "speech";
          }
          setNoiseCancellationTrackEnabled(audioTrack, !shouldPauseAudio);
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

          const pausedNow = pauseAudioNow();
          setNoiseCancellationTrackEnabled(audioTrack, !pausedNow);
          if (pausedNow) {
            audioProducer.pause();
          }
          if (pausedNow !== shouldPauseAudio) {
            socketRef.current?.emit(
              "toggleMute",
              { producerId: audioProducer.id, paused: pausedNow },
              () => {},
            );
          }

          if (generation !== captureGeneration()) {
            discardJoinProducer(audioProducer);
          } else if (installProducer(audioProducerRef, null, audioProducer, discardJoinProducer)) {
            const audioProducerId = audioProducer.id;
            audioProducer.on("transportclose", () => {
              if (audioProducerRef.current?.id === audioProducerId) {
                audioProducerRef.current = null;
                if (deviceIntents.get().audio.chosen) {
                  requestAudioProducerRecovery();
                }
              }
            });
          }
        } catch (err) {
          console.error("[Meets] Failed to produce audio:", err);
          const liveMic = committedMic();
          if (mediaIntent.isMicOn && ownsMic() && !pauseAudioNow()) {
            if (liveMic) {
              publicationWarnings.push("microphone publish retry scheduled");
              setNoiseCancellationTrackEnabled(liveMic, true);
              setIsMuted(false);
              requestAudioProducerRecovery();
            } else {
              publicationWarnings.push("microphone publish failed");
              setIsMuted(true);
            }
          }
        }
      } else if (mediaIntent.isMicOn && ownsMic()) {
        const endedAudioTracks = committedStream()
          .getAudioTracks()
          .filter((track) => track.readyState !== "live");
        if (endedAudioTracks.length > 0) {
          console.warn("[Meets] Skipping ended microphone track(s):", {
            stream: summarizeStreamForLog(committedStream()),
            endedAudioTracks: endedAudioTracks.map(summarizeTrackForLog),
          });
          publicationWarnings.push("microphone track ended");
        } else {
          publicationWarnings.push("microphone track missing");
        }
        setIsMuted(true);
      }

      await runCameraTrackOperation(async () => {
        if (!ownsCamera()) {
          if (publicationWarnings.length > 0) {
            console.warn(
              `[Meets] Continuing join without some local media: ${publicationWarnings.join(", ")}`
            );
          }
          return;
        }

        if (shouldPauseVideo) {
          dropVideoTracksForCameraOff(
            committedStream(),
            mediaIntent.isCameraOn
              ? "host-disabled camera publish intent"
              : "camera-off publish intent",
          );
          if (mediaIntent.isCameraOn) {
            setIsCameraOff(true);
          }
          if (publicationWarnings.length > 0) {
            console.warn(
              `[Meets] Continuing join without some local media: ${publicationWarnings.join(", ")}`
            );
          }
          return;
        }

        const requestedVideoTrack = getVideoPublishTrack?.(committedStream()) ?? null;
        let videoTrack =
          requestedVideoTrack?.readyState === "live" ? requestedVideoTrack : null;
        if (requestedVideoTrack && requestedVideoTrack.readyState !== "live") {
          console.warn("[Meets] Ignoring ended requested video publish track:", {
            requestedVideoTrack: summarizeTrackForLog(requestedVideoTrack),
            stream: summarizeStreamForLog(committedStream()),
          });
          if (refs.processedVideoTrackRef.current?.id === requestedVideoTrack.id) {
            refs.processedVideoTrackRef.current = null;
          }
        }
        if (!videoTrack) {
          videoTrack = getFirstLiveTrack(committedStream().getVideoTracks());
        }
        if (videoTrack) {
          const quality = videoQualityRef.current;
          const cameraPublishSettings = resolveEffectiveCameraPublishSettings(
            mediaQualitySettingsRef.current.camera,
            activeVideoEffectsCount > 0,
          );
          if ("contentHint" in videoTrack) {
            videoTrack.contentHint = cameraPublishSettings.contentHint;
          }
          const preferredWebcamCodec = getPreferredWebcamCodec(
            deviceRef.current,
            webcamCodecPolicyRef.current,
          );
          try {
            const videoProducer = await produceWebcamTrack({
              transport,
              track: videoTrack,
              quality,
              networkProfile: getPublishNetworkProfile(),
              paused: shouldPauseVideo,
              preferredCodec: preferredWebcamCodec,
              codecPolicy: webcamCodecPolicyRef.current,
              publishSettings: cameraPublishSettings,
            });

            if (!cameraWantedNow()) {
              closeJoinVideoProducer(videoProducer, committedStream());
              return;
            }

            if (!installProducer(videoProducerRef, null, videoProducer, discardJoinProducer)) return;
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
                    committedStream()
                      .getVideoTracks()
                      .filter((track) => track.id !== requestedVideoTrack.id),
                  )
                : null;

            if (rawFallbackTrack) {
              if ("contentHint" in rawFallbackTrack) {
                rawFallbackTrack.contentHint = cameraPublishSettings.contentHint;
              }
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
                  codecPolicy: webcamCodecPolicyRef.current,
                  publishSettings: cameraPublishSettings,
                });

                if (!cameraWantedNow()) {
                  closeJoinVideoProducer(fallbackVideoProducer, committedStream());
                  return;
                }

                if (!installProducer(videoProducerRef, null, fallbackVideoProducer, discardJoinProducer)) return;
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
                reportCurrentWebcamCodecFailure(fallbackErr);
              }
            } else {
              console.error("[Meets] Failed to produce video:", err);
              reportCurrentWebcamCodecFailure(err);
            }

            if (mediaIntent.isCameraOn && ownsCamera()) {
              const liveVideoTrack = getFirstLiveTrack(committedStream().getVideoTracks());
              if (liveVideoTrack && cameraWantedNow()) {
                publicationWarnings.push("camera publish retry scheduled");
                requestCameraProducerRecovery();
              } else {
                publicationWarnings.push("camera publish failed");
                setIsCameraOff(true);
              }
            }
          }
        } else if (mediaIntent.isCameraOn) {
          const endedVideoTracks = committedStream()
            .getVideoTracks()
            .filter((track) => track.readyState !== "live");
          if (endedVideoTracks.length > 0) {
            console.warn("[Meets] Skipping ended camera track(s):", {
              stream: summarizeStreamForLog(committedStream()),
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
      });
    },
    [
      producerTransportRef,
      audioProducerRef,
      videoProducerRef,
      localStreamRef,
      setLocalStream,
      isMuted,
      isCameraOff,
      setIsMuted,
      setIsCameraOff,
      videoQualityRef,
      mediaQualitySettingsRef,
      activeVideoEffectsCount,
      deviceRef,
      getVideoPublishTrack,
      prepareAudioPublishTrack,
      getPublishNetworkProfile,
      onPreferredVideoPublishTrackRejected,
      dropVideoTracksForCameraOff,
      refs.processedVideoTrackRef,
      resolveMediaPublishIntent,
      requestAudioProducerRecovery,
      requestCameraProducerRecovery,
      reportCurrentWebcamCodecFailure,
      runCameraTrackOperation,
      webcamCodecPolicyRef,
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
      if (audioOnlyModeRef.current && producerInfo.kind === "video") {
        suppressedVideoProducersRef.current.set(
          producerInfo.producerId,
          producerInfo,
        );
        pendingProducersRef.current.delete(producerInfo.producerId);
        return;
      }
      if (shouldIgnoreDepartedParticipant(producerInfo.producerUserId)) {
        dropDepartedProducer(producerInfo);
        return;
      }
      if (isSupersededProducer(producerInfo)) {
        pendingProducersRef.current.delete(producerInfo.producerId);
        consumeRetryAttemptsRef.current.delete(producerInfo.producerId);
        return;
      }
      const existingConsumer = consumersRef.current.get(producerInfo.producerId);
      if (existingConsumer && !options.replaceExisting) {
        consumeRetryAttemptsRef.current.delete(producerInfo.producerId);
        return;
      }
      const ownsInitialConsumeSlot = !options.replaceExisting;
      if (
        ownsInitialConsumeSlot &&
        consumerConsumeInFlightRef.current.has(producerInfo.producerId)
      ) {
        return;
      }

      const socket = socketRef.current;
      const device = deviceRef.current;
      const transport = consumerTransportRef.current;
      const queueFailureRetry = (delayMs: number) => {
        if (
          options.retryOnFailure !== false &&
          socketRef.current === socket &&
          consumerTransportRef.current === transport &&
          !transport?.closed &&
          socket?.connected
        ) {
          queueProducerConsumeRetry(producerInfo, delayMs);
        }
      };

      if (!socket || !device || !transport) {
        if (options.retryOnFailure !== false) {
          queueProducerConsumeRetry(producerInfo, 300);
        }
        return;
      }

      const consumeSlotOwner = Symbol(producerInfo.producerId);
      if (ownsInitialConsumeSlot) {
        consumerConsumeInFlightRef.current.set(
          producerInfo.producerId,
          consumeSlotOwner,
        );
      }
      const isCapturedConsumeContextCurrent = (consumer?: Consumer) =>
        socketRef.current === socket &&
        consumerTransportRef.current === transport &&
        socket.connected &&
        !transport.closed &&
        (!ownsInitialConsumeSlot ||
          consumerConsumeInFlightRef.current.get(producerInfo.producerId) ===
            consumeSlotOwner) &&
        (!consumer ||
          (!consumer.closed && consumer.track.readyState === "live"));
      return new Promise<void>((resolve) => {
        const settleConsume = startSocketAckTimeout("consume", (error) => {
          console.warn("[Meets] Consume acknowledgement timed out:", {
            producerId: producerInfo.producerId,
            kind: producerInfo.kind,
            type: producerInfo.type,
            error: error.message,
          });
          queueFailureRetry(450);
          resolve();
        });
        const existingWebcamVideoConsumerCount =
          countWebcamVideoProducerEntries(producerMapRef.current);
        const webcamVideoStartupRank =
          options.webcamVideoStartupRank ?? existingWebcamVideoConsumerCount;
        const knownScreenShareVideoActive =
          options.knownScreenShareVideoActive === true ||
          (producerInfo.kind === "video" && producerInfo.type === "screen") ||
          Array.from(producerMapRef.current.values()).some(
            (info) => info.kind === "video" && info.type === "screen",
          ) ||
          Array.from(pendingProducersRef.current.values()).some(
            (info) => info.kind === "video" && info.type === "screen",
          );
        const shouldStartWebcamConsumerPausedForReceiveBudget =
          dataSaverMode &&
          producerInfo.kind === "video" &&
          producerInfo.type === "webcam";
        const producerPauseRevisionAtRequest =
          producerPausedStateRevisionRef.current.get(
            producerInfo.producerId,
          ) ?? 0;
        socket.emit(
          "consume",
          {
            transportId: transport.id,
            producerId: producerInfo.producerId,
            rtpCapabilities: device.recvRtpCapabilities,
            ...getInitialConsumerPreferences(producerInfo, {
              preferHighWebcamLayer:
                !knownScreenShareVideoActive &&
                (joinMode === "webinar_attendee" ||
                  webcamVideoStartupRank < HIGH_LAYER_STARTUP_WEBCAM_LIMIT),
              networkProfile: getInitialConsumerNetworkProfile(producerInfo),
              screenShareVideoActive: knownScreenShareVideoActive,
            }),
          },
          async (
            response: ConsumeResponse | { error: string; code?: string },
          ) => {
            if (!settleConsume()) {
              if (!("error" in response)) {
                pendingConsumerTelemetryByIdRef.current.delete(response.id);
                void closeServerConsumer(response.id);
              }
              return;
            }
            if (shouldIgnoreDepartedParticipant(producerInfo.producerUserId)) {
              if (!("error" in response)) {
                void closeServerConsumer(response.id);
              }
              dropDepartedProducer(producerInfo);
              resolve();
              return;
            }

            if ("error" in response) {
              console.error("[Meets] Consume error:", response.error);
              if (isProducerGoneConsumeError(response)) {
                producerSlotOrder.noteClosed(producerInfo.producerId);
                handleProducerClosed(producerInfo.producerId);
                void syncProducersRef.current();
              } else {
                queueFailureRetry(300);
              }
              resolve();
              return;
            }

            if (!isCapturedConsumeContextCurrent()) {
              pendingConsumerTelemetryByIdRef.current.delete(response.id);
              void closeServerConsumer(response.id);
              resolve();
              return;
            }
            const acknowledgedProducerPaused = Boolean(
              response.producerPaused ?? producerInfo.paused,
            );
            if (
              isProducerPauseSnapshotCurrent({
                requestRevision: producerPauseRevisionAtRequest,
                currentRevision:
                  producerPausedStateRevisionRef.current.get(
                    producerInfo.producerId,
                  ) ?? 0,
              })
            ) {
              setProducerPausedState(
                producerInfo.producerId,
                acknowledgedProducerPaused,
              );
            }
            if (audioOnlyModeRef.current && producerInfo.kind === "video") {
              suppressedVideoProducersRef.current.set(
                producerInfo.producerId,
                producerInfo,
              );
              pendingConsumerTelemetryByIdRef.current.delete(response.id);
              void closeServerConsumer(response.id);
              pendingProducersRef.current.delete(producerInfo.producerId);
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
              const discardUncommittedConsumer = async ({
                confirmRollback,
              }: {
                confirmRollback: boolean;
              }) => {
                pendingConsumerTelemetryByIdRef.current.delete(consumer.id);
                try {
                  consumer.track.onmute = null;
                  consumer.track.onunmute = null;
                  consumer.track.stop();
                  consumer.close();
                } catch {}
                if (confirmRollback && options.makeBeforeBreak) {
                  options.makeBeforeBreak.rollbackOutcome.confirmed =
                    await closeServerConsumerBeforeDeadline(
                      consumer.id,
                      options.makeBeforeBreak.deadlineAt,
                    );
                  return;
                }
                void closeServerConsumer(consumer.id);
              };
              if (audioOnlyModeRef.current && response.kind === "video") {
                suppressedVideoProducersRef.current.set(
                  producerInfo.producerId,
                  producerInfo,
                );
                await discardUncommittedConsumer({
                  confirmRollback: Boolean(options.makeBeforeBreak),
                });
                resolve();
                return;
              }
              if (!isCapturedConsumeContextCurrent(consumer)) {
                await discardUncommittedConsumer({
                  confirmRollback: Boolean(options.makeBeforeBreak),
                });
                resolve();
                return;
              }
              if (shouldIgnoreDepartedParticipant(producerInfo.producerUserId)) {
                await discardUncommittedConsumer({ confirmRollback: false });
                dropDepartedProducer(producerInfo);
                resolve();
                return;
              }

              if (
                isSupersededProducer({
                  producerId: producerInfo.producerId,
                  producerUserId: producerInfo.producerUserId,
                  kind: response.kind,
                  type: producerInfo.type,
                })
              ) {
                await discardUncommittedConsumer({ confirmRollback: false });
                resolve();
                return;
              }

              let preparedMakeBeforeBreak = false;
              if (options.makeBeforeBreak) {
                const expectedPreviousConsumerId =
                  options.makeBeforeBreak.expectedPreviousConsumerId;
                const stillOwnsPreviousGeneration =
                  existingConsumer?.id === expectedPreviousConsumerId &&
                  consumersRef.current.get(producerInfo.producerId)?.id ===
                    expectedPreviousConsumerId;
                if (
                  response.kind !== "video" ||
                  !stillOwnsPreviousGeneration ||
                  consumer.closed ||
                  Date.now() >= options.makeBeforeBreak.deadlineAt
                ) {
                  await discardUncommittedConsumer({ confirmRollback: true });
                  resolve();
                  return;
                }

                preparedMakeBeforeBreak =
                  await prepareConsumerMakeBeforeBreak({
                    producerId: producerInfo.producerId,
                    consumer,
                    expectedPreviousConsumerId,
                    deadlineAt: options.makeBeforeBreak.deadlineAt,
                    resetEpoch: options.makeBeforeBreak.resetEpoch,
                  });
                if (
                  !preparedMakeBeforeBreak ||
                  consumer.closed ||
                  consumersRef.current.get(producerInfo.producerId)?.id !==
                    expectedPreviousConsumerId ||
                  producerPausedStateRef.current.get(
                    producerInfo.producerId,
                  ) === true ||
                  adaptivelyPausedConsumerProducerIdsRef.current.has(
                    producerInfo.producerId,
                  ) ||
                  isSupersededProducer(producerInfo)
                ) {
                  await discardUncommittedConsumer({ confirmRollback: true });
                  resolve();
                  return;
                }
              }

              if (!isCapturedConsumeContextCurrent(consumer)) {
                await discardUncommittedConsumer({
                  confirmRollback: Boolean(options.makeBeforeBreak),
                });
                resolve();
                return;
              }

              const consumerBeingReplaced =
                consumersRef.current.get(producerInfo.producerId) ?? null;
              const replacedConsumerTelemetry =
                consumerTelemetryRef.current.get(producerInfo.producerId) ??
                null;
              if (
                !options.replaceExisting &&
                consumerBeingReplaced &&
                consumerBeingReplaced.id !== consumer.id
              ) {
                await discardUncommittedConsumer({ confirmRollback: false });
                resolve();
                return;
              }

              consumersRef.current.set(producerInfo.producerId, consumer);
              const stagedTelemetry =
                pendingConsumerTelemetryByIdRef.current.get(consumer.id);
              pendingConsumerTelemetryByIdRef.current.delete(consumer.id);
              if (stagedTelemetry) {
                consumerTelemetryRef.current.set(
                  producerInfo.producerId,
                  stagedTelemetry,
                );
              } else if (
                consumerTelemetryRef.current.get(producerInfo.producerId)
                  ?.consumerId !== consumer.id
              ) {
                consumerTelemetryRef.current.delete(producerInfo.producerId);
              }
              announcedRemoteProducersRef.current.delete(
                producerInfo.producerId,
              );
              consumeRetryAttemptsRef.current.delete(producerInfo.producerId);
              const producerEntry = {
                userId: producerInfo.producerUserId,
                kind: response.kind,
                type: producerInfo.type,
              };
              producerMapRef.current.set(
                producerInfo.producerId,
                producerEntry,
              );
              if (consumer.kind === "video") {
                adaptiveVideoReceiverLifecycleRef.current({
                  type: "added",
                  producerId: producerInfo.producerId,
                  consumer,
                  info: producerEntry,
                });
              }
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
              const startsPausedForAdaptiveReceive =
                shouldStartWebcamConsumerPausedForReceiveBudget && isWebcamVideo;
              if (startsPausedForAdaptiveReceive) {
                adaptivelyPausedConsumerProducerIdsRef.current.add(
                  producerInfo.producerId,
                );
              }

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
                }, getStaleConsumerRecoveryDelayMs(producerInfo));
                staleConsumerRecoveryTimeoutsRef.current.set(
                  producerInfo.producerId,
                  timeoutId,
                );
              };

              const handleTrackMuted = () => {
                if (
                  consumersRef.current.get(producerInfo.producerId)?.id !==
                  consumer.id
                ) {
                  return;
                }
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
                    resumeConsumerReliably(producerInfo.producerId, {
                      requestKeyFrame: true,
                    });
                  }, getVideoStallKeyFrameRequestDelayMs(producerInfo));
                  videoStallRecoveryTimeoutsRef.current.set(
                    producerInfo.producerId,
                    timeoutId,
                  );
                }
              };

              const handleTrackUnmuted = () => {
                if (
                  consumersRef.current.get(producerInfo.producerId)?.id !==
                  consumer.id
                ) {
                  return;
                }
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
                if (
                  consumersRef.current.get(producerInfo.producerId)?.id !==
                  consumer.id
                ) {
                  return;
                }
                if (
                  preparedMakeBeforeBreak &&
                  consumerBeingReplaced &&
                  !consumerBeingReplaced.closed &&
                  consumerBeingReplaced.track.readyState === "live"
                ) {
                  return;
                }
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
              if (
                consumer.track.muted &&
                !producerPausedStateRef.current.get(producerInfo.producerId)
              ) {
                handleTrackMuted();
              }
              const stream = new MediaStream([consumer.track]);
              const presentationPromise =
                preparedMakeBeforeBreak &&
                response.kind === "video" &&
                options.makeBeforeBreak
                  ? waitForRemoteVideoPresentation({
                      stream,
                      timeoutMs: Math.max(
                        1,
                        Math.min(
                          WEBCAM_STARTUP_RESET_PRESENTATION_TIMEOUT_MS,
                          options.makeBeforeBreak.deadlineAt - Date.now(),
                        ),
                      ),
                    })
                  : null;
              dispatchParticipants({
                type: "UPDATE_STREAM",
                userId: producerInfo.producerUserId,
                kind: response.kind,
                streamType: producerInfo.type,
                stream,
                producerId: producerInfo.producerId,
              });
              if (startsPausedForAdaptiveReceive) {
                dispatchParticipants({
                  type: "UPDATE_VIDEO_ADAPTIVE_PAUSED",
                  userId: producerInfo.producerUserId,
                  producerId: producerInfo.producerId,
                  adaptivelyPaused: true,
                });
              }

              if (producerInfo.type === "screen" && response.kind === "video") {
                setActiveScreenShareId(producerInfo.producerId);
              }

              if (
                consumerBeingReplaced &&
                consumerBeingReplaced.id !== consumer.id
              ) {
                const presentationResult = presentationPromise
                  ? await presentationPromise
                  : "unobserved";
                if (isSupersededProducer(producerInfo)) {
                  handleProducerClosed(producerInfo.producerId);
                  closeConsumerForSameProducerReconsume(
                    producerInfo.producerId,
                    consumerBeingReplaced,
                  );
                  void closeServerConsumer(consumer.id);
                  void closeServerConsumer(consumerBeingReplaced.id);
                  resolve();
                  return;
                }
                if (!isCapturedConsumeContextCurrent()) {
                  if (
                    consumersRef.current.get(producerInfo.producerId)?.id ===
                    consumer.id
                  ) {
                    handleProducerClosed(producerInfo.producerId);
                  } else {
                    closeConsumerForSameProducerReconsume(
                      producerInfo.producerId,
                      consumer,
                    );
                  }
                  closeConsumerForSameProducerReconsume(
                    producerInfo.producerId,
                    consumerBeingReplaced,
                  );
                  void closeServerConsumer(consumer.id);
                  void closeServerConsumer(consumerBeingReplaced.id);
                  resolve();
                  return;
                }
                const candidateStillCurrent =
                  consumersRef.current.get(producerInfo.producerId)?.id ===
                  consumer.id;
                const candidateRemainsPlayable =
                  candidateStillCurrent &&
                  isCapturedConsumeContextCurrent(consumer) &&
                  !consumer.paused &&
                  !consumer.track.muted &&
                  producerPausedStateRef.current.get(
                    producerInfo.producerId,
                  ) !== true &&
                  !adaptivelyPausedConsumerProducerIdsRef.current.has(
                    producerInfo.producerId,
                  );
                const shouldRestorePredecessor =
                  candidateStillCurrent &&
                  (!candidateRemainsPlayable ||
                    presentationResult === "observed-timeout") &&
                  !consumerBeingReplaced.closed &&
                  consumerBeingReplaced.track.readyState === "live";

                if (shouldRestorePredecessor) {
                  const candidateStallTimeout =
                    videoStallRecoveryTimeoutsRef.current.get(
                      producerInfo.producerId,
                    );
                  if (candidateStallTimeout != null) {
                    window.clearTimeout(candidateStallTimeout);
                    videoStallRecoveryTimeoutsRef.current.delete(
                      producerInfo.producerId,
                    );
                  }
                  clearConsumerResumeRetry(
                    producerInfo.producerId,
                    consumer.id,
                  );
                  clearStaleConsumerRecoveryTimeout(
                    producerInfo.producerId,
                  );
                  mutedConsumerSinceRef.current.delete(
                    producerInfo.producerId,
                  );
                  videoFreezeStatsRef.current.delete(
                    producerInfo.producerId,
                  );
                  consumersRef.current.set(
                    producerInfo.producerId,
                    consumerBeingReplaced,
                  );
                  if (
                    replacedConsumerTelemetry?.consumerId ===
                    consumerBeingReplaced.id
                  ) {
                    consumerTelemetryRef.current.set(
                      producerInfo.producerId,
                      replacedConsumerTelemetry,
                    );
                  } else {
                    consumerTelemetryRef.current.delete(
                      producerInfo.producerId,
                    );
                  }
                  if (consumerBeingReplaced.kind === "video") {
                    adaptiveVideoReceiverLifecycleRef.current({
                      type: "added",
                      producerId: producerInfo.producerId,
                      consumer: consumerBeingReplaced,
                      info: producerEntry,
                    });
                  }
                  dispatchParticipants({
                    type: "UPDATE_STREAM",
                    userId: producerInfo.producerUserId,
                    kind: response.kind,
                    streamType: producerInfo.type,
                    stream: new MediaStream([consumerBeingReplaced.track]),
                    producerId: producerInfo.producerId,
                  });
                  const restoredProducerPaused =
                    producerPausedStateRef.current.get(
                      producerInfo.producerId,
                    ) ?? acknowledgedProducerPaused;
                  if (isWebcamAudio) {
                    updateMutedState(restoredProducerPaused);
                  } else if (isWebcamVideo) {
                    updateCameraState(restoredProducerPaused);
                  }
                  if (
                    adaptivelyPausedConsumerProducerIdsRef.current.has(
                      producerInfo.producerId,
                    )
                  ) {
                    dispatchParticipants({
                      type: "UPDATE_VIDEO_ADAPTIVE_PAUSED",
                      userId: producerInfo.producerUserId,
                      producerId: producerInfo.producerId,
                      adaptivelyPaused: true,
                    });
                  }
                  closeConsumerForSameProducerReconsume(
                    producerInfo.producerId,
                    consumer,
                  );
                  if (options.makeBeforeBreak) {
                    options.makeBeforeBreak.rollbackOutcome.confirmed =
                      await closeServerConsumerBeforeDeadline(
                        consumer.id,
                        options.makeBeforeBreak.deadlineAt,
                      );
                  } else {
                    void closeServerConsumer(consumer.id);
                  }
                  resolve();
                  return;
                }

                if (
                  consumersRef.current.get(producerInfo.producerId)?.id ===
                  consumerBeingReplaced.id
                ) {
                  resolve();
                  return;
                }
                closeConsumerForSameProducerReconsume(
                  producerInfo.producerId,
                  consumerBeingReplaced,
                );
                void closeServerConsumer(consumerBeingReplaced.id);
              }

              if (
                consumersRef.current.get(producerInfo.producerId)?.id !==
                  consumer.id ||
                !isCapturedConsumeContextCurrent(consumer)
              ) {
                resolve();
                return;
              }

              const currentProducerPaused =
                producerPausedStateRef.current.get(producerInfo.producerId) ??
                acknowledgedProducerPaused;
              const currentAdaptiveReceivePaused =
                adaptivelyPausedConsumerProducerIdsRef.current.has(
                  producerInfo.producerId,
                );
              if (currentProducerPaused) {
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

              if (
                !preparedMakeBeforeBreak &&
                !startsPausedForAdaptiveReceive &&
                !currentProducerPaused &&
                !currentAdaptiveReceivePaused &&
                response.paused !== false
              ) {
                resumeConsumerReliably(producerInfo.producerId, {
                  requestKeyFrame: response.kind === "video",
                });
              }

              const maximumSpatialLayer = isWebcamVideo
                ? getConsumerMaximumSpatialLayer(
                    consumer.rtpParameters.encodings ?? [],
                  )
                : null;
              if (
                isWebcamVideo &&
                !options.replaceExisting &&
                !currentProducerPaused &&
                !startsPausedForAdaptiveReceive &&
                !currentAdaptiveReceivePaused &&
                maximumSpatialLayer !== null &&
                isVp8SimulcastConsumerEligibleForStartupReset({
                  consumerType: response.consumerType,
                  codecs: consumer.rtpParameters.codecs ?? [],
                  maximumSpatialLayer,
                })
              ) {
                scheduleWebcamStartupLatencyResetRef.current(
                  producerInfo,
                  consumer,
                  maximumSpatialLayer,
                );
              }
              resolve();
            } catch (err) {
              pendingConsumerTelemetryByIdRef.current.delete(response.id);
              if (options.makeBeforeBreak) {
                options.makeBeforeBreak.rollbackOutcome.confirmed =
                  await closeServerConsumerBeforeDeadline(
                    response.id,
                    options.makeBeforeBreak.deadlineAt,
                  );
              } else {
                void closeServerConsumer(response.id);
              }
              console.error("[Meets] Failed to create consumer:", err);
              queueFailureRetry(350);
              resolve();
            }
          },
        );
      }).finally(() => {
        if (
          ownsInitialConsumeSlot &&
          consumerConsumeInFlightRef.current.get(producerInfo.producerId) ===
            consumeSlotOwner
        ) {
          consumerConsumeInFlightRef.current.delete(producerInfo.producerId);
        }
      });
    },
    [
      adaptiveVideoReceiverLifecycleRef,
      consumersRef,
      consumeRetryAttemptsRef,
      consumerConsumeInFlightRef,
      pendingProducersRef,
      prepareConsumerMakeBeforeBreak,
      socketRef,
      deviceRef,
      consumerTransportRef,
      producerMapRef,
      dispatchParticipants,
      handleProducerClosed,
      closeConsumerForSameProducerReconsume,
      closeServerConsumer,
      closeServerConsumerBeforeDeadline,
      dropDepartedProducer,
      getInitialConsumerNetworkProfile,
      isSupersededProducer,
      joinMode,
      queueProducerConsumeRetry,
      resumeConsumerReliably,
      setActiveScreenShareId,
      shouldIgnoreDepartedParticipant,
      videoStallRecoveryTimeoutsRef,
      staleConsumerRecoveryTimeoutsRef,
      audioOnlyModeRef,
      adaptivelyPausedConsumerProducerIdsRef,
      clearStaleConsumerRecoveryTimeout,
      mutedConsumerSinceRef,
      producerPausedStateRef,
      setProducerPausedState,
      announcedRemoteProducersRef,
      suppressedVideoProducersRef,
      dataSaverMode,
      userId,
    ],
  );
  consumeProducerRef.current = consumeProducer;

  useEffect(() => {
    if (audioOnlyMode) {
      consumersRef.current.forEach((consumer, producerId) => {
        if (consumer.kind !== "video") return;
        const producer = producerMapRef.current.get(producerId);
        if (producer) {
          suppressedVideoProducersRef.current.set(producerId, {
            producerId,
            producerUserId: producer.userId,
            kind: producer.kind,
            type: producer.type,
            paused: producerPausedStateRef.current.get(producerId),
          });
          dispatchParticipants({
            type: "UPDATE_STREAM",
            userId: producer.userId,
            kind: "video",
            streamType: producer.type,
            stream: null,
            producerId,
          });
          if (producer.type === "screen") setActiveScreenShareId(null);
        }
        void closeServerConsumer(consumer.id);
        closeConsumerForSameProducerReconsume(producerId, consumer);
      });
      return;
    }

    const suppressedProducers = Array.from(
      suppressedVideoProducersRef.current.values(),
    );
    suppressedVideoProducersRef.current.clear();
    suppressedProducers.forEach((producer) => void consumeProducer(producer));
  }, [
    audioOnlyMode,
    closeConsumerForSameProducerReconsume,
    closeServerConsumer,
    consumeProducer,
    consumersRef,
    dispatchParticipants,
    producerMapRef,
    producerPausedStateRef,
    setActiveScreenShareId,
    suppressedVideoProducersRef,
  ]);

  const scheduleWebcamStartupLatencyResetTimeout = useCallback(
    (producerId: string, callback: () => void, delayMs: number) => {
      const existingTimeout =
        webcamStartupLatencyResetTimeoutsRef.current.get(producerId);
      if (existingTimeout != null) window.clearTimeout(existingTimeout);
      const timeoutId = window.setTimeout(() => {
        if (
          webcamStartupLatencyResetTimeoutsRef.current.get(producerId) ===
          timeoutId
        ) {
          webcamStartupLatencyResetTimeoutsRef.current.delete(producerId);
        }
        callback();
      }, delayMs);
      webcamStartupLatencyResetTimeoutsRef.current.set(producerId, timeoutId);
    },
    [],
  );

  const evaluateWebcamStartupLatencyReset = useCallback(
    (producerId: string) => {
      const state = webcamStartupLatencyResetStateRef.current.get(producerId);
      if (
        !state ||
        state.epoch !== webcamStartupLatencyResetEpochRef.current ||
        state.status === "completed" ||
        state.status === "failed" ||
        state.status === "cancelled" ||
        state.status === "queued" ||
        state.status === "replacing" ||
        state.status === "verifying"
      ) {
        return;
      }

      const consumer = consumersRef.current.get(producerId);
      const consumerTelemetry = consumerTelemetryRef.current.get(producerId);
      const observedSpatialLayer =
        consumerTelemetry?.currentLayers?.spatialLayer ?? null;
      state.observedSpatialLayer = observedSpatialLayer;
      const decision = decideWebcamStartupResetPoll({
        now: Date.now(),
        deadlineAt: state.deadlineAt,
        stableForMs: WEBCAM_STARTUP_RESET_STABLE_MS,
        highLayerSince: state.highLayerSince,
        previousConsumerId: state.previousConsumerId,
        currentConsumerId: consumer?.id ?? null,
        consumerClosed: consumer?.closed ?? true,
        trackReadyState: consumer?.track.readyState ?? null,
        trackMuted: consumer?.track.muted ?? true,
        producerPaused:
          producerPausedStateRef.current.get(producerId) === true,
        adaptivelyPaused:
          adaptivelyPausedConsumerProducerIdsRef.current.has(producerId),
        observedSpatialLayer,
        maximumSpatialLayer: state.maximumSpatialLayer,
        highestActiveSpatialLayer: getHighestActiveSpatialLayer(
          consumerTelemetry?.score,
          state.maximumSpatialLayer,
        ),
      });

      if (decision.action === "queue") {
        state.highLayerSince = decision.highLayerSince;
        state.status = "queued";
        state.failureReason = null;
        writeWebcamStartupLatencyResetDebug(state);
        webcamStartupLatencyResetQueueRef.current =
          enqueueWebcamStartupResetProducer(
            webcamStartupLatencyResetQueueRef.current,
            producerId,
          );
        drainWebcamStartupLatencyResetQueueRef.current();
        scheduleWebcamStartupLatencyResetTimeout(
          producerId,
          () => {
            const queuedState =
              webcamStartupLatencyResetStateRef.current.get(producerId);
            if (
              queuedState !== state ||
              state.epoch !== webcamStartupLatencyResetEpochRef.current ||
              state.status !== "queued"
            ) {
              return;
            }
            webcamStartupLatencyResetQueueRef.current =
              webcamStartupLatencyResetQueueRef.current.filter(
                (queuedProducerId) => queuedProducerId !== producerId,
              );
            settleWebcamStartupLatencyReset(
              state,
              "failed",
              "replacement-deadline-exhausted",
            );
            drainWebcamStartupLatencyResetQueueRef.current();
          },
          Math.max(1, state.deadlineAt - Date.now()),
        );
        return;
      }
      if (decision.action === "cancel") {
        settleWebcamStartupLatencyReset(
          state,
          "cancelled",
          decision.reason,
        );
        return;
      }
      if (decision.action === "fail") {
        settleWebcamStartupLatencyReset(state, "failed", decision.reason);
        return;
      }

      state.highLayerSince = decision.highLayerSince;
      state.status = "waiting-for-high-layer";
      writeWebcamStartupLatencyResetDebug(state);
      scheduleWebcamStartupLatencyResetTimeout(
        producerId,
        () => evaluateWebcamStartupLatencyResetRef.current(producerId),
        WEBCAM_STARTUP_RESET_POLL_MS,
      );
    },
    [
      adaptivelyPausedConsumerProducerIdsRef,
      consumerTelemetryRef,
      consumersRef,
      scheduleWebcamStartupLatencyResetTimeout,
      settleWebcamStartupLatencyReset,
      writeWebcamStartupLatencyResetDebug,
    ],
  );
  evaluateWebcamStartupLatencyResetRef.current =
    evaluateWebcamStartupLatencyReset;

  const drainWebcamStartupLatencyResetQueue = useCallback(() => {
    if (
      webcamStartupLatencyResetActiveRef.current !== null ||
      webcamStartupLatencyResetDrainTimeoutRef.current !== null
    ) {
      return;
    }

    let producerId: string | undefined;
    while ((producerId = webcamStartupLatencyResetQueueRef.current.shift())) {
      const state = webcamStartupLatencyResetStateRef.current.get(producerId);
      if (
        state?.status === "queued" &&
        state.epoch === webcamStartupLatencyResetEpochRef.current
      ) {
        break;
      }
      producerId = undefined;
    }
    if (!producerId) return;

    const delayMs = getWebcamStartupResetQueueDelayMs({
      now: Date.now(),
      lastFinishedAt: webcamStartupLatencyResetLastFinishedAtRef.current,
      minimumSpacingMs: WEBCAM_STARTUP_RESET_MIN_SPACING_MS,
    });
    if (delayMs > 0) {
      webcamStartupLatencyResetQueueRef.current.unshift(producerId);
      webcamStartupLatencyResetDrainTimeoutRef.current = window.setTimeout(
        () => {
          webcamStartupLatencyResetDrainTimeoutRef.current = null;
          drainWebcamStartupLatencyResetQueueRef.current();
        },
        delayMs,
      );
      return;
    }

    webcamStartupLatencyResetActiveRef.current = producerId;
    void runWebcamStartupLatencyResetRef.current(producerId);
  }, []);
  drainWebcamStartupLatencyResetQueueRef.current =
    drainWebcamStartupLatencyResetQueue;

  const runWebcamStartupLatencyReset = useCallback(
    async (producerId: string) => {
      const state = webcamStartupLatencyResetStateRef.current.get(producerId);
      const epoch = state?.epoch ?? -1;
      let recoverySlotOwner: symbol | null = null;

      const finishQueueSlot = () => {
        if (epoch !== webcamStartupLatencyResetEpochRef.current) return;
        if (webcamStartupLatencyResetActiveRef.current === producerId) {
          webcamStartupLatencyResetActiveRef.current = null;
          webcamStartupLatencyResetLastFinishedAtRef.current = Date.now();
        }
        drainWebcamStartupLatencyResetQueueRef.current();
      };

      try {
        if (
          !state ||
          state.status !== "queued" ||
          epoch !== webcamStartupLatencyResetEpochRef.current
        ) {
          return;
        }

        const preflightConsumer = consumersRef.current.get(producerId);
        const consumerTelemetry = consumerTelemetryRef.current.get(producerId);
        const observedSpatialLayer =
          consumerTelemetry?.currentLayers?.spatialLayer ?? null;
        state.observedSpatialLayer = observedSpatialLayer;
        const preflight = decideWebcamStartupResetPoll({
          now: Date.now(),
          deadlineAt: state.deadlineAt,
          stableForMs: WEBCAM_STARTUP_RESET_STABLE_MS,
          highLayerSince: state.highLayerSince,
          previousConsumerId: state.previousConsumerId,
          currentConsumerId: preflightConsumer?.id ?? null,
          consumerClosed: preflightConsumer?.closed ?? true,
          trackReadyState: preflightConsumer?.track.readyState ?? null,
          trackMuted: preflightConsumer?.track.muted ?? true,
          producerPaused:
            producerPausedStateRef.current.get(producerId) === true,
          adaptivelyPaused:
            adaptivelyPausedConsumerProducerIdsRef.current.has(producerId),
          observedSpatialLayer,
          maximumSpatialLayer: state.maximumSpatialLayer,
          highestActiveSpatialLayer: getHighestActiveSpatialLayer(
            consumerTelemetry?.score,
            state.maximumSpatialLayer,
          ),
        });
        if (
          preflight.action === "queue" ||
          preflight.action === "wait"
        ) {
          state.highLayerSince = preflight.highLayerSince;
        }
        if (preflight.action !== "queue") {
          if (preflight.action === "cancel") {
            settleWebcamStartupLatencyReset(
              state,
              "cancelled",
              preflight.reason,
            );
          } else if (preflight.action === "fail") {
            settleWebcamStartupLatencyReset(
              state,
              "failed",
              preflight.reason,
            );
          } else {
            state.status = "waiting-for-high-layer";
            writeWebcamStartupLatencyResetDebug(state);
            scheduleWebcamStartupLatencyResetTimeout(
              producerId,
              () => evaluateWebcamStartupLatencyResetRef.current(producerId),
              WEBCAM_STARTUP_RESET_POLL_MS,
            );
          }
          return;
        }

        if (consumerRecoveryInFlightRef.current.has(producerId)) {
          state.status = "retry-wait";
          state.failureReason = "another-consumer-replacement-in-flight";
          writeWebcamStartupLatencyResetDebug(state);
          scheduleWebcamStartupLatencyResetTimeout(
            producerId,
            () => evaluateWebcamStartupLatencyResetRef.current(producerId),
            WEBCAM_STARTUP_RESET_RETRY_MS,
          );
          return;
        }

        state.attempt += 1;
        state.status = "replacing";
        state.replacementStartedAt ??= Date.now();
        state.failureReason = null;
        writeWebcamStartupLatencyResetDebug(state);
        telemetry.capture("meet_webcam_consumer_generation_reset_attempt", {
          reason: WEBCAM_STARTUP_RESET_REASON,
          attempt: state.attempt,
          maximumSpatialLayer: state.maximumSpatialLayer,
          observedSpatialLayer: state.observedSpatialLayer,
        });

        const socket = socketRef.current;
        const transport = consumerTransportRef.current;
        const rollbackOutcome = { confirmed: true };
        recoverySlotOwner = Symbol(producerId);
        consumerRecoveryInFlightRef.current.set(
          producerId,
          recoverySlotOwner,
        );
        if (socket?.connected && transport && !transport.closed) {
          await consumeProducer(state.producerInfo, {
            replaceExisting: true,
            retryOnFailure: false,
            makeBeforeBreak: {
              expectedPreviousConsumerId: state.previousConsumerId,
              deadlineAt: state.deadlineAt,
              resetEpoch: state.epoch,
              rollbackOutcome,
            },
          });
        }

        if (
          state.epoch !== webcamStartupLatencyResetEpochRef.current ||
          webcamStartupLatencyResetStateRef.current.get(producerId) !== state
        ) {
          return;
        }

        const currentConsumer = consumersRef.current.get(producerId);
        if (
          currentConsumer?.id === state.previousConsumerId &&
          !rollbackOutcome.confirmed
        ) {
          settleWebcamStartupLatencyReset(
            state,
            "failed",
            "replacement-rollback-unconfirmed",
          );
          return;
        }
        if (Date.now() >= state.deadlineAt) {
          settleWebcamStartupLatencyReset(
            state,
            "failed",
            "replacement-deadline-exhausted",
          );
          return;
        }
        const attemptDecision = decideWebcamStartupResetAttempt({
          previousConsumerId: state.previousConsumerId,
          currentConsumerId: currentConsumer?.id ?? null,
          attempt: state.attempt,
          maximumAttempts: WEBCAM_STARTUP_RESET_MAX_ATTEMPTS,
        });

        if (attemptDecision.action === "verify") {
          state.replacementConsumerId =
            attemptDecision.replacementConsumerId;
          state.verificationStartedAt = Date.now();
          const verificationTimeoutMs = Math.max(
            0,
            Math.min(
              WEBCAM_STARTUP_RESET_VERIFY_TIMEOUT_MS,
              state.deadlineAt - state.verificationStartedAt,
            ),
          );
          state.status = "verifying";
          writeWebcamStartupLatencyResetDebug(state);

          while (
            state.epoch === webcamStartupLatencyResetEpochRef.current &&
            webcamStartupLatencyResetStateRef.current.get(producerId) === state
          ) {
            const replacement = consumersRef.current.get(producerId);
            const verificationRemainingMs = Math.max(
              1,
              state.verificationStartedAt + verificationTimeoutMs - Date.now(),
            );
            const flow = replacement
              ? await readConsumerVideoFlowSnapshotWithin(
                  replacement,
                  Math.min(500, verificationRemainingMs),
                )
              : { framesDecoded: null, bytesReceived: null };
            const verification = decideWebcamStartupResetVerification({
              now: Date.now(),
              verificationStartedAt: state.verificationStartedAt,
              verificationTimeoutMs,
              replacementConsumerId: attemptDecision.replacementConsumerId,
              currentConsumerId: replacement?.id ?? null,
              consumerClosed: replacement?.closed ?? true,
              trackReadyState: replacement?.track.readyState ?? null,
              trackMuted: replacement?.track.muted ?? true,
              framesDecoded: flow.framesDecoded,
              bytesReceived: flow.bytesReceived,
            });
            if (verification.action === "complete") {
              settleWebcamStartupLatencyReset(state, "completed", null);
              break;
            }
            if (verification.action === "cancel") {
              settleWebcamStartupLatencyReset(
                state,
                "cancelled",
                verification.reason,
              );
              break;
            }
            if (verification.action === "fail") {
              settleWebcamStartupLatencyReset(
                state,
                "failed",
                verification.reason,
              );
              break;
            }
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, WEBCAM_STARTUP_RESET_VERIFY_POLL_MS);
            });
          }
          return;
        }

        if (attemptDecision.action === "retry") {
          state.status = "retry-wait";
          state.failureReason = attemptDecision.reason;
          writeWebcamStartupLatencyResetDebug(state);
          scheduleWebcamStartupLatencyResetTimeout(
            producerId,
            () => evaluateWebcamStartupLatencyResetRef.current(producerId),
            WEBCAM_STARTUP_RESET_RETRY_MS,
          );
          return;
        }
        settleWebcamStartupLatencyReset(
          state,
          attemptDecision.action === "cancel" ? "cancelled" : "failed",
          attemptDecision.reason,
        );
      } catch (error) {
        if (
          state &&
          state.epoch === webcamStartupLatencyResetEpochRef.current &&
          webcamStartupLatencyResetStateRef.current.get(producerId) === state
        ) {
          console.error(
            `[Meets] Planned webcam consumer generation reset failed for ${producerId}:`,
            error,
          );
          if (state.attempt < WEBCAM_STARTUP_RESET_MAX_ATTEMPTS) {
            state.status = "retry-wait";
            state.failureReason = "replacement-threw";
            writeWebcamStartupLatencyResetDebug(state);
            scheduleWebcamStartupLatencyResetTimeout(
              producerId,
              () => evaluateWebcamStartupLatencyResetRef.current(producerId),
              WEBCAM_STARTUP_RESET_RETRY_MS,
            );
          } else {
            settleWebcamStartupLatencyReset(
              state,
              "failed",
              "replacement-threw",
            );
          }
        }
      } finally {
        if (
          recoverySlotOwner &&
          consumerRecoveryInFlightRef.current.get(producerId) ===
            recoverySlotOwner
        ) {
          consumerRecoveryInFlightRef.current.delete(producerId);
        }
        finishQueueSlot();
      }
    },
    [
      adaptivelyPausedConsumerProducerIdsRef,
      consumerTelemetryRef,
      consumerTransportRef,
      consumersRef,
      consumeProducer,
      scheduleWebcamStartupLatencyResetTimeout,
      settleWebcamStartupLatencyReset,
      socketRef,
      writeWebcamStartupLatencyResetDebug,
    ],
  );
  runWebcamStartupLatencyResetRef.current = runWebcamStartupLatencyReset;

  const scheduleWebcamStartupLatencyReset = useCallback(
    (
      producerInfo: ProducerInfo,
      consumer: Consumer,
      maximumSpatialLayer: number,
    ) => {
      if (
        maximumSpatialLayer <= 0 ||
        webcamStartupLatencyResetStateRef.current.has(producerInfo.producerId)
      ) {
        return;
      }

      const startedAt = Date.now();
      const state: WebcamStartupLatencyResetRuntime = {
        producerInfo,
        previousConsumerId: consumer.id,
        replacementConsumerId: null,
        maximumSpatialLayer,
        observedSpatialLayer:
          consumerTelemetryRef.current.get(producerInfo.producerId)
            ?.currentLayers?.spatialLayer ?? null,
        startedAt,
        deadlineAt: startedAt + WEBCAM_STARTUP_RESET_MAX_WAIT_MS,
        highLayerSince: null,
        replacementStartedAt: null,
        verificationStartedAt: null,
        completedAt: null,
        attempt: 0,
        epoch: webcamStartupLatencyResetEpochRef.current,
        status: "waiting-for-high-layer",
        failureReason: null,
      };
      webcamStartupLatencyResetStateRef.current.set(
        producerInfo.producerId,
        state,
      );
      writeWebcamStartupLatencyResetDebug(state);
      telemetry.capture("meet_webcam_consumer_generation_reset_scheduled", {
        reason: WEBCAM_STARTUP_RESET_REASON,
        maximumSpatialLayer,
      });
      scheduleWebcamStartupLatencyResetTimeout(
        producerInfo.producerId,
        () =>
          evaluateWebcamStartupLatencyResetRef.current(
            producerInfo.producerId,
          ),
        WEBCAM_STARTUP_RESET_POLL_MS,
      );
    },
    [
      consumerTelemetryRef,
      scheduleWebcamStartupLatencyResetTimeout,
      writeWebcamStartupLatencyResetDebug,
    ],
  );
  scheduleWebcamStartupLatencyResetRef.current =
    scheduleWebcamStartupLatencyReset;

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

      const recoverySlotOwner = Symbol(producerInfo.producerId);
      consumerRecoveryInFlightRef.current.set(
        producerInfo.producerId,
        recoverySlotOwner,
      );
      const previousConsumerId =
        consumersRef.current.get(producerInfo.producerId)?.id ?? null;

      try {
        console.warn(
          `[Meets] Recovering stale ${producerInfo.kind} consumer ${producerInfo.producerId}: ${reason}`,
        );
        telemetry.capture("meet_stale_consumer_recovery_started", {
          kind: producerInfo.kind,
          type: producerInfo.type,
          reason,
        });
        await consumeProducer(producerInfo, { replaceExisting: true });
        const replacement = consumersRef.current.get(producerInfo.producerId);
        if (
          replacement &&
          !replacement.closed &&
          replacement.id !== previousConsumerId
        ) {
          telemetry.capture("meet_stale_consumer_recovered", {
            kind: producerInfo.kind,
            type: producerInfo.type,
            reason,
          });
        } else {
          telemetry.capture("meet_stale_consumer_recovery_failed", {
            kind: producerInfo.kind,
            type: producerInfo.type,
            reason,
            failureReason: "replacement-not-attached",
          });
        }
      } catch (error) {
        console.error(
          `[Meets] Failed to recover stale consumer ${producerInfo.producerId}:`,
          error,
        );
        telemetry.capture("meet_stale_consumer_recovery_failed", {
          kind: producerInfo.kind,
          type: producerInfo.type,
          reason,
          failureReason: "replacement-threw",
        });
        queueProducerConsumeRetry(producerInfo, 1200);
      } finally {
        if (
          consumerRecoveryInFlightRef.current.get(producerInfo.producerId) ===
          recoverySlotOwner
        ) {
          consumerRecoveryInFlightRef.current.delete(producerInfo.producerId);
        }
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

  useEffect(() => {
    const FREEZE_CHECK_MS = 2000;
    const STALL_SAMPLES_BEFORE_PLI = 1;
    const KEYFRAME_REQUEST_COOLDOWN_MS = 3500;
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

            const sampleNow = Date.now();
            const previous = stats.get(producerId);
            const transition = advanceVideoFreezeRecovery({
              previous:
                previous?.consumerId === consumerId ? previous : null,
              frames: decodedNow,
              bytes: bytesNow,
              now: sampleNow,
              keyFrameRequestCooldownMs:
                info.type === "screen"
                  ? SCREEN_SHARE_FREEZE_KEYFRAME_REQUEST_COOLDOWN_MS
                  : KEYFRAME_REQUEST_COOLDOWN_MS,
              minimumStallByteDelta: MIN_STALL_BYTE_DELTA,
              stallSamplesBeforeKeyFrame: STALL_SAMPLES_BEFORE_PLI,
            });

            if (transition.action === "request-key-frame") {
              const socket2 = socketRef.current;
              if (socket2?.connected) {
                socket2.emit(
                  "resumeConsumer",
                  { consumerId: live.id, requestKeyFrame: true },
                  () => {},
                );
              }
            } else if (transition.action === "reconsume") {
              stats.delete(producerId);
              void recoverStaleConsumerRef.current(
                {
                  producerId,
                  producerUserId: info.userId,
                  kind: info.kind,
                  type: info.type,
                  paused: false,
                },
                "decoder remained frozen after bounded keyframe requests",
              );
              return;
            }

            stats.set(producerId, {
              ...transition.state,
              consumerId,
            });
          })
          .catch(() => {});
      });

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

  const runProducerSync = useCallback(async () => {
    const socket = socketRef.current;
    const device = deviceRef.current;
    if (!socket || !socket.connected || !device) return;
    if (!currentRoomIdRef.current) return;

    try {
      const listRequestedAt = producerSlotOrder.markListRequested();
      const producers = await new Promise<ProducerInfo[] | null>(
        (resolve, reject) => {
          emitWithAckTimeout(
            socket,
            ACK_REQUEST_TIMEOUT_MS,
            () => resolve(null),
            "getProducers",
            (response: { producers: ProducerInfo[] } | { error: string }) => {
              if ("error" in response) {
                reject(new Error(response.error));
              } else {
                const listedProducers = response.producers || [];
                noteRemoteProducerList(listedProducers, listRequestedAt);
                resolve(listedProducers);
              }
            },
          );
        },
      );
      if (!producers) return;

      const serverProducerIds = new Set(
        producers.map((producer) => producer.producerId),
      );
      // The list may predate a producer announced while it was in flight, so
      // leaving that producer out says nothing about it.
      const isGoneFromServer = (producerId: string): boolean =>
        !serverProducerIds.has(producerId) &&
        !producerSlotOrder.wasAnnouncedAfter(producerId, listRequestedAt);
      for (const producerId of announcedRemoteProducersRef.current.keys()) {
        if (isGoneFromServer(producerId)) {
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
        if (shouldIgnoreDepartedParticipant(producerInfo.producerUserId)) {
          if (
            joinMode === "webinar_attendee" &&
            webinarJoinedParticipantIdsRef.current.has(
              producerInfo.producerUserId,
            )
          ) {
            restoreWebinarFeedParticipant(producerInfo.producerUserId);
          } else {
            dropDepartedProducer(producerInfo);
            continue;
          }
        }
        setProducerPausedState(
          producerInfo.producerId,
          Boolean(producerInfo.paused),
        );
        // Only the producer that owns the slot speaks for the participant: a
        // stale list can still carry the paused producer it replaced.
        if (producerInfo.type !== "webcam" || isSupersededProducer(producerInfo)) {
          continue;
        }
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
        if (isGoneFromServer(producerId)) {
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
            resumeConsumerReliably(producerInfo.producerId, {
              requestKeyFrame: consumer.kind === "video",
            });
            if (
              Date.now() - mutedSince >=
                getStaleConsumerRecoveryDelayMs(producerInfo)
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
              resumeConsumerReliably(producerInfo.producerId, {
                requestKeyFrame: shouldRequestKeyFrame,
              });
            }
          }
          continue;
        }
        if (pendingProducersRef.current.has(producerInfo.producerId)) continue;
      }

      const snapshotHasScreenShareVideo = producers.some(
        (producerInfo) =>
          producerInfo.kind === "video" && producerInfo.type === "screen",
      );
      const producersToConsume = producers.filter((producerInfo) => {
        if (consumersRef.current.has(producerInfo.producerId)) return false;
        if (pendingProducersRef.current.has(producerInfo.producerId)) {
          return false;
        }
        return true;
      });
      if (producersToConsume.length > 0) {
        const webcamVideoStartupRanks = buildWebcamVideoStartupRanks(
          producersToConsume,
          countWebcamVideoProducerEntries(producerMapRef.current),
        );
        // Syncs are serialized, so they must not wait on negotiation: a
        // consume cut off by its transport closing never settles.
        for (const producerInfo of producersToConsume) {
          consumeProducer(producerInfo, {
            knownScreenShareVideoActive: snapshotHasScreenShareVideo,
            webcamVideoStartupRank: webcamVideoStartupRanks.get(
              producerInfo.producerId,
            ),
          }).catch((err) => {
            console.error("[Meets] Failed to sync producers:", err);
          });
        }
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
    dropDepartedProducer,
    handleProducerClosed,
    joinMode,
    noteRemoteProducerList,
    producerSlotOrder,
    restoreWebinarFeedParticipant,
    resumeConsumerReliably,
    setProducerPausedState,
    shouldIgnoreDepartedParticipant,
    userId,
    adaptivelyPausedConsumerProducerIdsRef,
    mutedConsumerSinceRef,
    clearStaleConsumerRecoveryTimeout,
    videoFreezeStatsRef,
    announcedRemoteProducersRef,
  ]);
  const syncProducers = useCallback(
    () => coalesceProducerSync(runProducerSync),
    [coalesceProducerSync, runProducerSync],
  );
  syncProducersRef.current = syncProducers;

  const applyDisplayNameSnapshot = useCallback(
    (users: DisplayNameSnapshotEntry[] = []) => {
      const snapshot = new Map<string, string>();
      const nextParticipantIds = new Set<string>([userId]);
      const previousParticipantIds = participantIdsRef.current;
      let clearedDepartedParticipant = false;

      for (const { userId: snapshotUserId, displayName } of users) {
        if (displayName) {
          snapshot.set(snapshotUserId, displayName);
        }
        if (snapshotUserId === userId) {
          continue;
        }

        clearedDepartedParticipant =
          markRemoteParticipantPresent(snapshotUserId) ||
          clearedDepartedParticipant;
        if (!isSystemUserId(snapshotUserId)) {
          nextParticipantIds.add(snapshotUserId);
        }
        const leaveTimeout = leaveTimeoutsRef.current.get(snapshotUserId);
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

      for (const previousUserId of previousParticipantIds) {
        if (
          previousUserId === userId ||
          nextParticipantIds.has(previousUserId)
        ) {
          continue;
        }

        const leaveTimeout = leaveTimeoutsRef.current.get(previousUserId);
        markRemoteParticipantDeparted(previousUserId);
        if (leaveTimeout) {
          window.clearTimeout(leaveTimeout);
          leaveTimeoutsRef.current.delete(previousUserId);
        }
        clearParticipantConnectionStatus(previousUserId);

        const producersToClose = Array.from(producerMapRef.current.entries())
          .filter(([, info]) => info.userId === previousUserId)
          .map(
            ([producerId, info]): ProducerInfo => ({
              producerId,
              producerUserId: previousUserId,
              kind: info.kind,
              type: info.type,
            }),
          );
        for (const info of Array.from(pendingProducersRef.current.values())) {
          if (info.producerUserId === previousUserId) {
            dropDepartedProducer(info);
          }
        }
        for (const producerInfo of producersToClose) {
          dropDepartedProducer(producerInfo);
        }
        dispatchParticipants({
          type: "REMOVE_PARTICIPANT",
          userId: previousUserId,
        });
      }

      participantIdsRef.current = nextParticipantIds;
      setDisplayNames(snapshot);
      if (clearedDepartedParticipant) {
        void syncProducers();
      }
    },
    [
      clearParticipantConnectionStatus,
      dispatchParticipants,
      dropDepartedProducer,
      leaveTimeoutsRef,
      markRemoteParticipantDeparted,
      markRemoteParticipantPresent,
      pendingProducersRef,
      producerMapRef,
      setDisplayNames,
      syncProducers,
      userId,
    ],
  );

  const applyWebinarFeedProducers = useCallback(
    async (producers: ProducerInfo[]) => {
      const departedProducerIds = new Set<string>();
      const activeProducers = producers.filter((producer) => {
        const isDeparted = shouldIgnoreDepartedParticipant(
          producer.producerUserId,
        );
        if (isDeparted) {
          departedProducerIds.add(producer.producerId);
          if (
            webinarJoinedParticipantIdsRef.current.has(producer.producerUserId)
          ) {
            restoreWebinarFeedParticipant(producer.producerUserId);
            return true;
          }
          dropDepartedProducer(producer);
        }
        return !isDeparted;
      });
      for (const producer of activeProducers) {
        producerSlotOrder.noteAnnounced(producer);
      }
      const serverProducerIds = new Set(
        activeProducers.map((producer) => producer.producerId),
      );
      for (const producerId of producerMapRef.current.keys()) {
        if (departedProducerIds.has(producerId)) continue;
        if (!serverProducerIds.has(producerId)) {
          handleProducerClosed(producerId);
        }
      }
      const snapshotHasScreenShareVideo = activeProducers.some(
        (producer) => producer.kind === "video" && producer.type === "screen",
      );
      const producersToConsume = activeProducers.filter(
        (producer) =>
          !consumersRef.current.has(producer.producerId) &&
          !pendingProducersRef.current.has(producer.producerId),
      );
      const webcamVideoStartupRanks = buildWebcamVideoStartupRanks(
        producersToConsume,
        countWebcamVideoProducerEntries(producerMapRef.current),
      );
      await Promise.all(
        producersToConsume.map((producer) =>
          consumeProducer(producer, {
            knownScreenShareVideoActive: snapshotHasScreenShareVideo,
            webcamVideoStartupRank: webcamVideoStartupRanks.get(
              producer.producerId,
            ),
          }),
        ),
      );
    },
    [
      consumeProducer,
      consumersRef,
      dropDepartedProducer,
      handleProducerClosed,
      pendingProducersRef,
      producerMapRef,
      producerSlotOrder,
      restoreWebinarFeedParticipant,
      shouldIgnoreDepartedParticipant,
    ],
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
    const snapshotHasScreenShareVideo = pending.some(
      (producerInfo) =>
        producerInfo.kind === "video" && producerInfo.type === "screen",
    );
    const webcamVideoStartupRanks = buildWebcamVideoStartupRanks(
      pending,
      countWebcamVideoProducerEntries(producerMapRef.current),
    );
    await Promise.all(
      pending.map((producerInfo) =>
        consumeProducer(producerInfo, {
          knownScreenShareVideoActive: snapshotHasScreenShareVideo,
          webcamVideoStartupRank: webcamVideoStartupRanks.get(
            producerInfo.producerId,
          ),
        }),
      ),
    );
  }, [pendingProducersRef, consumeProducer, producerMapRef]);

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
        console.info(`[Meets] ${reason} recovery triggered reconnect.`);
        void handleReconnectRef.current?.();
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
        console.info(`[Meets] ${reason} recovery restarting ICE.`, {
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
          void handleReconnectRef.current?.();
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

  const requestForegroundScreenShareKeyFrames = useCallback(() => {
    const socket = socketRef.current;
    if (!socket?.connected) return;

    const now = Date.now();
    if (
      now - foregroundScreenShareKeyFrameAtRef.current <
      SCREEN_SHARE_FOREGROUND_KEYFRAME_REQUEST_COOLDOWN_MS
    ) {
      return;
    }

    let requested = false;
    consumersRef.current.forEach((consumer, producerId) => {
      const info = producerMapRef.current.get(producerId);
      if (!info || !isScreenShareVideoProducer(info)) return;
      if (producerPausedStateRef.current.get(producerId)) return;
      if (adaptivelyPausedConsumerProducerIdsRef.current.has(producerId)) return;
      if (consumer.closed || consumer.paused) return;

      const track = consumer.track;
      if (!track || track.readyState !== "live") return;

      socket.emit(
        "resumeConsumer",
        { consumerId: consumer.id, requestKeyFrame: true },
        () => {},
      );

      const freezeStats = videoFreezeStatsRef.current.get(producerId);
      if (freezeStats) {
        videoFreezeStatsRef.current.set(producerId, {
          ...freezeStats,
          stalls: 0,
          lastKeyFrameRequestAt: now,
        });
      }
      requested = true;
    });

    if (requested) {
      foregroundScreenShareKeyFrameAtRef.current = now;
    }
  }, [
    adaptivelyPausedConsumerProducerIdsRef,
    consumersRef,
    producerMapRef,
    producerPausedStateRef,
    socketRef,
    videoFreezeStatsRef,
  ]);

  const joinRoomInternal = useCallback(
    async (
      targetRoomId: string,
      stream: MediaStream | null,
      joinOptions: {
        displayName?: string;
        isRecorder?: boolean;
        joinMode: JoinMode;
        webinarInviteCode?: string;
        meetingInviteCode?: string;
      },
    ): Promise<"joined" | "waiting"> => {
      const socket = socketRef.current;
      if (!socket) throw new Error("Socket not connected");
      const assertJoinCurrent = () => {
        if (
          intentionalDisconnectRef.current ||
          socketRef.current !== socket ||
          !socket.connected
        ) {
          throw new Error("Meeting join was cancelled");
        }
      };
      assertJoinCurrent();

      const DeviceClass = prewarm?.Device
        ? prewarm.Device
        : (await import("mediasoup-client")).Device;
      const pendingDevice = new DeviceClass();
      const mediaCapabilities = detectBrowserWebcamCodecCapabilities(
        pendingDevice.handlerName,
        {
          videoInputDeviceId: selectedVideoInputDeviceId,
          allowVp9SvcSend: true,
        },
      );

      assertJoinCurrent();
      setWaitingMessage(null);
      setConnectionState("joining");

      const joinRequestedAt = producerSlotOrder.markListRequested();
      return new Promise<"joined" | "waiting">((resolve, reject) => {
        const settleJoinRoom = startSocketAckTimeout(
          "joinRoom",
          reject,
          JOIN_ROOM_ACK_TIMEOUT_MS,
        );
        socket.emit(
          "joinRoom",
          {
            roomId: targetRoomId,
            sessionId: sessionIdRef.current,
            displayName: joinOptions.displayName,
            webinarInviteCode: joinOptions.webinarInviteCode,
            meetingInviteCode: joinOptions.meetingInviteCode,
            mediaCapabilities,
          },
          async (response: JoinRoomResponse | JoinRoomErrorResponse) => {
            if (!settleJoinRoom()) return;
            try {
              assertJoinCurrent();
            } catch (error) {
              reject(toError(error));
              return;
            }
            if ("error" in response) {
              reject(getJoinRoomRedirectError(response) ?? new Error(response.error));
              return;
            }

            departedParticipantIdsRef.current.clear();

            webcamCodecPolicyRef.current =
              normalizeWebcamCodecPolicy(response.webcamCodecPolicy) ?? {
                ...BASELINE_WEBCAM_CODEC_POLICY,
              };

            if (response.status === "waiting") {
              setConnectionState("waiting");
              setServerActiveSpeakerAvailable(false);
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
                response.webinarSpeakerUserId ??
                  response.existingProducers?.[0]?.producerUserId ??
                  null,
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
                qaEnabled:
                  response.webinarQaEnabled ?? previous?.qaEnabled ?? true,
              }));
              currentRoomIdRef.current = targetRoomId;
              serverRoomIdRef.current = response.roomId ?? targetRoomId;
              setIsTtsDisabled(response.isTtsDisabled ?? false);
              setIsChatLocked(response.isChatLocked ?? false);
              setIsDmEnabled(response.isDmEnabled ?? true);
              setAreImageAttachmentsEnabled(
                response.areImageAttachmentsEnabled ?? true,
              );
              setIsReactionsDisabled(response.isReactionsDisabled ?? false);
              setIsParticipantUnmuteAllowed(
                response.isParticipantUnmuteAllowed ?? true,
              );
              setIsParticipantVideoAllowed(
                response.isParticipantVideoAllowed ?? true,
              );
              resolve("waiting");
              return;
            }

            try {
              const joinedTime = performance.now();
              console.info(
                "[Meets] Joined room, existing producers:",
                response.existingProducers,
              );
              // The snapshot is ordered against live producer events by when
              // it arrived, so note it before anything here awaits.
              noteRemoteProducerList(
                response.existingProducers,
                joinRequestedAt,
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
              setAreImageAttachmentsEnabled(
                response.areImageAttachmentsEnabled ?? true,
              );
              setIsReactionsDisabled(response.isReactionsDisabled ?? false);
              setIsParticipantUnmuteAllowed(
                response.isParticipantUnmuteAllowed ?? true,
              );
              setIsParticipantVideoAllowed(
                response.isParticipantVideoAllowed ?? true,
              );
              if (
                Object.prototype.hasOwnProperty.call(response, "activeSpeakerId")
              ) {
                applyServerActiveSpeaker(response.activeSpeakerId);
              } else {
                setServerActiveSpeakerAvailable(false);
              }
              setWebinarRole(response.webinarRole ?? null);
              setIsWebinarHandRaised(false);
              setWebinarSpeakerUserId(
                response.webinarSpeakerUserId ??
                  response.existingProducers?.[0]?.producerUserId ??
                  null,
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
                qaEnabled:
                  response.webinarQaEnabled ?? previous?.qaEnabled ?? true,
              }));
              if (Array.isArray(response.displayNameSnapshot)) {
                applyDisplayNameSnapshot(response.displayNameSnapshot);
              }

              const device = pendingDevice;
              await device.load({
                routerRtpCapabilities: response.rtpCapabilities,
              });
              assertJoinCurrent();
              deviceRef.current = device;
              const loadedMediaCapabilities =
                detectLoadedDeviceWebcamCodecCapabilities(device, {
                  videoInputDeviceId: selectedVideoInputDeviceId,
                });
              await new Promise<void>((resolveCapabilities) => {
                let settled = false;
                const timeoutId = window.setTimeout(() => {
                  if (settled) return;
                  settled = true;
                  console.warn(
                    "[Meets] Loaded media capability refinement timed out; keeping the conservative room codec.",
                  );
                  resolveCapabilities();
                }, 2500);
                socket.emit(
                  "updateMediaCapabilities",
                  { mediaCapabilities: loadedMediaCapabilities },
                  (
                    capabilityResponse:
                      | {
                          success: true;
                          webcamCodecPolicy: WebcamCodecPolicy;
                        }
                      | { error: string },
                  ) => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timeoutId);
                    if ("error" in capabilityResponse) {
                      console.warn(
                        "[Meets] Loaded media capability refinement was not applied; keeping the conservative room codec:",
                        capabilityResponse.error,
                      );
                      resolveCapabilities();
                      return;
                    }
                    applyWebcamCodecPolicyNotification({
                      ...capabilityResponse.webcamCodecPolicy,
                      roomId:
                        serverRoomIdRef.current ??
                        currentRoomIdRef.current ??
                        undefined,
                    });
                    resolveCapabilities();
                  },
                );
              });
              assertJoinCurrent();
              console.info(
                `[Meets] Device loaded in ${(performance.now() - joinedTime).toFixed(0)}ms`,
              );

              const shouldProduce =
                !!stream &&
                !joinOptions.isRecorder &&
                !bypassMediaPermissions &&
                joinOptions.joinMode !== "webinar_attendee";

              await Promise.all([
                shouldProduce
                  ? createProducerTransport(socket, device)
                  : Promise.resolve(),
                createConsumerTransport(socket, device),
              ]);

              assertJoinCurrent();
              const joiningUserIsHost =
                response.webinarRole === "host" ||
                response.hostUserId === userId ||
                response.hostUserIds?.includes(userId) === true;
              const producePromise =
                shouldProduce && stream
                  ? produce(stream, {
                      unmuteAllowed:
                        joiningUserIsHost ||
                        (response.isParticipantUnmuteAllowed ?? true),
                      videoAllowed:
                        joiningUserIsHost ||
                        (response.isParticipantVideoAllowed ?? true),
                    })
                  : Promise.resolve();

              const snapshotHasScreenShareVideo =
                response.existingProducers.some(
                  (producer) =>
                    producer.kind === "video" && producer.type === "screen",
                );
              const webcamVideoStartupRanks = buildWebcamVideoStartupRanks(
                response.existingProducers,
              );
              const consumePromises = response.existingProducers.map(
                (producer) =>
                  consumeProducer(producer, {
                    knownScreenShareVideoActive: snapshotHasScreenShareVideo,
                    webcamVideoStartupRank: webcamVideoStartupRanks.get(
                      producer.producerId,
                    ),
                  }),
              );

              await Promise.all([producePromise, ...consumePromises]);
              assertJoinCurrent();
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
              assertJoinCurrent();

              setConnectionState("joined");
              skipMutedMicWarmupRef.current = false;
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
              reject(toError(err));
            }
          },
        );
      });
    },
    [
      socketRef,
      intentionalDisconnectRef,
      sessionIdRef,
      skipMutedMicWarmupRef,
      applyWebcamCodecPolicyNotification,
      setWaitingMessage,
      setConnectionState,
      setHostUserId,
      setHostUserIds,
      setMeetingRequiresInviteCode,
      setWebinarConfig,
      setWebinarRole,
      setWebinarSpeakerUserId,
      setIsWebinarHandRaised,
      currentRoomIdRef,
      applyDisplayNameSnapshot,
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
      prewarm,
      selectedVideoInputDeviceId,
      webcamCodecPolicyRef,
    ],
  );

  const heldJoinInfoRef = useRef<{
    roomId: string;
    joinInfo: JoinInfo;
    fetchedAt: number;
  } | null>(null);
  const connectSocket = useCallback(
    (
      targetRoomId: string,
      options?: { sfuUrlOverride?: string },
    ): Promise<Socket> => {
      const connectionGeneration = reconnectGenerationRef.current;
      return new Promise((resolve, reject) => {
        void (async () => {
          try {
            const sfuUrlOverride = normalizeJoinRedirectUrl(
              options?.sfuUrlOverride,
            );
            const roomIdForJoin =
              targetRoomId || currentRoomIdRef.current || "";
            // A live socket is reused only for the room its token was issued
            // for. Another room needs another token, and with it the identity
            // that token names.
            if (
              socketRef.current?.connected &&
              !sfuUrlOverride &&
              (!roomIdForJoin || socketRoomIdRef.current === roomIdForJoin)
            ) {
              resolve(socketRef.current);
              return;
            }
            if (socketRef.current) {
              socketRef.current.disconnect();
              socketRef.current = null;
              onSocketReady?.(null);
            }

            setConnectionState("connecting");

            if (!roomIdForJoin) {
              throw new Error("Missing room ID");
            }

            const joinStartTime = performance.now();

            const socketIoPromise = prewarm?.io
              ? Promise.resolve({ io: prewarm.io })
              : import("socket.io-client");

            const heldJoinInfo = heldJoinInfoRef.current;
            heldJoinInfoRef.current = null;
            const cachedToken =
              heldJoinInfo?.roomId === roomIdForJoin &&
              Date.now() - heldJoinInfo.fetchedAt < HELD_JOIN_INFO_TTL_MS
                ? heldJoinInfo.joinInfo
                : prewarm?.getCachedToken?.(roomIdForJoin);
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
            if (
              connectionGeneration !== reconnectGenerationRef.current ||
              intentionalDisconnectRef.current
            ) {
              throw new Error("Meeting connection was cancelled");
            }
            const socketUrl = sfuUrlOverride ?? sfuUrl;

            if (Array.isArray(iceServers)) {
              const { stunIceServers, turnIceServers } =
                splitIceServersByType(iceServers);
              runtimeStunIceServersRef.current =
                stunIceServers.length > 0 ? stunIceServers : null;
              runtimeTurnIceServersRef.current =
                turnIceServers.length > 0 ? turnIceServers : null;
            }

            if (adoptJoinIdentity?.(token, roomIdForJoin)) {
              heldJoinInfoRef.current = {
                roomId: roomIdForJoin,
                joinInfo: { token, sfuUrl, iceServers },
                fetchedAt: Date.now(),
              };
              identityRestartRoomIdRef.current = roomIdForJoin;
              throw new JoinIdentityChangedError();
            }

            socketRoomIdRef.current = roomIdForJoin;
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
            type SocketListener = Parameters<typeof socket.on>[1];
            const onLive = ((event: Parameters<typeof socket.on>[0], handler: SocketListener) =>
              socket.on(event, (...args: unknown[]) => {
                if (socketRef.current !== socket || intentionalDisconnectRef.current) return;
                handler.apply(socket, args);
              })) as typeof socket.on;

            socket.on("connect", () => {
              clearTimeout(connectionTimeout);
              if (
                socketRef.current !== socket ||
                connectionGeneration !== reconnectGenerationRef.current
              ) {
                socket.disconnect();
                reject(new Error("Meeting connection was cancelled"));
                return;
              }
              console.info(
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
              console.info("[Meets] Disconnected:", reason);
              if (socketRef.current !== socket) return;
              if (intentionalDisconnectRef.current) {
                setConnectionState("disconnected");
                return;
              }

              if (reason === "io server disconnect") {
                if (serverRestartNoticeRef.current) {
                  if (currentRoomIdRef.current) {
                    void handleReconnectRef.current();
                  } else {
                    setConnectionState("disconnected");
                  }
                  return;
                }
                setConnectionState("disconnected");
                return;
              }

              if (currentRoomIdRef.current) {
                void handleReconnectRef.current();
              } else {
                setConnectionState("disconnected");
              }
            });

            onLive("roomClosed", ({ reason }: { reason: string }) => {
              console.info("[Meets] Room closed:", reason);
              setMeetError({
                code: "UNKNOWN",
                message: `Room closed: ${reason}`,
                recoverable: false,
              });
              setWaitingMessage(null);
              cleanup();
            });

            onLive(
              "roomEnded",
              ({
                message,
                endedBy,
              }: {
                message?: string;
                endedBy?: string;
              }) => {
                console.info("[Meets] Room ended", { endedBy });
                if (isRoomEndedByLocalUser(endedBy, userId)) {
                  finishLocalRoomEnded();
                  return;
                }

                setMeetError(null);
                setWaitingMessage(null);
                cleanup();
                const shownAsEndScreen = onCallEnded?.({
                  kind: "endedByHost",
                  detail: customServerText(message, DEFAULT_ROOM_ENDED_MESSAGE),
                });
                if (!shownAsEndScreen) {
                  setSetupNotice?.(endedNotice(resolveRoomEndedNoticeMessage(message)));
                }
              },
            );

            socket.on("connect_error", (err) => {
              clearTimeout(connectionTimeout);
              if (
                socketRef.current !== socket ||
                intentionalDisconnectRef.current
              ) {
                reject(err);
                return;
              }
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

            onLive(
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

            onLive(
              "serverRestarting",
              (notification: ServerRestartNotification) => {
                if (!isRoomEvent(notification?.roomId)) return;
                const message = notification?.message?.trim();
                const notice = message || DEFAULT_SERVER_RESTART_NOTICE;
                serverRestartNoticeRef.current = notice;
                setServerRestartNotice(notice);
              },
            );

            onLive("adminNotice", (notification: AdminNoticeNotification) => {
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

            onLive(
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

                const snapshot: ConsumerTelemetrySnapshot = {
                  ...notification,
                  receivedAt: Date.now(),
                };
                const currentConsumer = consumersRef.current.get(
                  notification.producerId,
                );

                if (notification.event === "closed") {
                  pendingConsumerTelemetryByIdRef.current.delete(
                    notification.consumerId,
                  );
                  if (
                    consumerTelemetryRef.current.get(notification.producerId)
                      ?.consumerId === notification.consumerId &&
                    (!currentConsumer ||
                      currentConsumer.id === notification.consumerId)
                  ) {
                    consumerTelemetryRef.current.delete(notification.producerId);
                  }
                  return;
                }

                if (
                  currentConsumer &&
                  currentConsumer.id !== notification.consumerId
                ) {
                  pendingConsumerTelemetryByIdRef.current.set(
                    notification.consumerId,
                    snapshot,
                  );
                  if (pendingConsumerTelemetryByIdRef.current.size > 64) {
                    const oldestConsumerId =
                      pendingConsumerTelemetryByIdRef.current.keys().next()
                        .value;
                    if (typeof oldestConsumerId === "string") {
                      pendingConsumerTelemetryByIdRef.current.delete(
                        oldestConsumerId,
                      );
                    }
                  }
                  return;
                }

                consumerTelemetryRef.current.set(
                  notification.producerId,
                  snapshot,
                );
              },
            );

            onLive(
              "consumerAutoResumed",
              (notification: {
                roomId?: string;
                consumerId?: string;
                producerId?: string;
                pausedForMs?: number;
              }) => {
                if (!isRoomEvent(notification?.roomId)) return;
                const producerId = notification?.producerId;
                if (typeof producerId !== "string" || !producerId) return;
                console.warn(
                  "[Meets] Server auto-resumed a stuck audio consumer:",
                  notification,
                );
                mutedConsumerSinceRef.current.delete(producerId);
                telemetry.capture("meet_audio_consumer_auto_resumed", {
                  pausedForMs:
                    typeof notification.pausedForMs === "number"
                      ? Math.round(notification.pausedForMs)
                      : null,
                });
              },
            );

            onLive(
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

            onLive(
              "adminUsersChanged",
              ({
                roomId: eventRoomId,
                hostUserIds,
              }: {
                roomId?: string;
                hostUserIds?: string[];
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                const nextHostUserIds = Array.isArray(hostUserIds) ? hostUserIds : [];
                setHostUserIds(nextHostUserIds);
                if (!nextHostUserIds.includes(userId)) setIsAdmin(false);
              },
            );

            onLive(
              "activeSpeakerChanged",
              (notification: ActiveSpeakerChangedNotification) => {
                if (!isRoomEvent(notification?.roomId)) return;
                const nextSpeakerId =
                  typeof notification?.userId === "string" &&
                  notification.userId.length > 0
                    ? notification.userId
                    : null;
                if (
                  nextSpeakerId &&
                  shouldIgnoreDepartedParticipant(nextSpeakerId)
                ) {
                  applyServerActiveSpeaker(null);
                  return;
                }
                applyServerActiveSpeaker(nextSpeakerId);
              },
            );

            onLive(
              "webcamCodecPolicyChanged",
              (
                policy: WebcamCodecPolicy & { roomId?: string },
              ) => {
                applyWebcamCodecPolicyNotification(policy);
              },
            );

            onLive("newProducer", async (data: ProducerInfo) => {
              console.info("[Meets] New producer:", data);
              if (shouldIgnoreDepartedParticipant(data.producerUserId)) {
                dropDepartedProducer(data);
                return;
              }
              setProducerPausedState(data.producerId, Boolean(data.paused));
              if (data.producerUserId === userId) {
                return;
              }
              producerSlotOrder.noteAnnounced(data);
              if (joinMode === "webinar_attendee") {
                void syncProducers();
                return;
              }
              announcedRemoteProducersRef.current.set(data.producerId, data);
              await consumeProducer(data);
            });

            onLive(
              "producerClosed",
              ({
                producerId,
                producerUserId,
              }: {
                producerId: string;
                producerUserId?: string;
              }) => {
                console.info("[Meets] Producer closed:", producerId);
                const localAudioProducer = audioProducerRef.current;
                const localVideoProducer = videoProducerRef.current;
                const localScreenProducer = screenProducerRef.current;
                const localScreenAudioProducer = screenAudioProducerRef.current;
                const matchesLocalProducer =
                  localAudioProducer?.id === producerId ||
                  localVideoProducer?.id === producerId ||
                  localScreenProducer?.id === producerId ||
                  localScreenAudioProducer?.id === producerId;
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
                  if (localScreenAudioProducer?.id === producerId) {
                    try {
                      localScreenAudioProducer.close();
                    } catch {}
                    if (localScreenAudioProducer.track) {
                      localScreenAudioProducer.track.onended = null;
                    }
                    if (screenAudioProducerRef.current?.id === producerId) {
                      screenAudioProducerRef.current = null;
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
                    const shouldRecoverAudio = deviceIntents.get().audio.chosen;
                    if (shouldRecoverAudio) {
                      if (liveAudioTrack) {
                        setNoiseCancellationTrackEnabled(liveAudioTrack, true);
                      }
                      setIsMuted(false);
                      requestAudioProducerRecovery();
                      return;
                    }
                    localStreamRef.current?.getAudioTracks().forEach((track) => {
                      setNoiseCancellationTrackEnabled(track, false);
                    });
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
                      deviceIntents.get().video.chosen;
                    if (shouldRecoverCamera) {
                      if (liveVideoTrack) {
                        liveVideoTrack.enabled = true;
                      }
                      setIsCameraOff(false);
                      requestCameraProducerRecovery();
                      return;
                    }
                    setIsCameraOff(true);
                    return;
                  }

                  if (localScreenProducer?.id === producerId) {
                    try {
                      localScreenProducer.close();
                    } catch {}
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

                  if (localScreenAudioProducer?.id === producerId) {
                    try {
                      localScreenAudioProducer.close();
                    } catch {}
                    if (localScreenAudioProducer.track) {
                      localScreenAudioProducer.track.onended = null;
                    }
                    if (screenAudioProducerRef.current?.id === producerId) {
                      screenAudioProducerRef.current = null;
                    }
                    return;
                  }
                }

                producerSlotOrder.noteClosed(producerId);
                handleProducerClosed(producerId);
              },
            );

            onLive(
              "userJoined",
              ({
                userId: joinedUserId,
                displayName,
              }: {
                userId: string;
                displayName?: string;
              }) => {
                console.info("[Meets] User joined:", joinedUserId);
                if (joinedUserId === userId) {
                  return;
                }
                const clearedDepartedParticipant =
                  markRemoteParticipantPresent(joinedUserId);
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
                });
                if (clearedDepartedParticipant) {
                  void syncProducers();
                }
              },
            );

            onLive(
              "userLeft",
              ({ userId: leftUserId }: { userId: string }) => {
                console.info("[Meets] User left:", leftUserId);
                markRemoteParticipantDeparted(leftUserId);
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
                  .map(
                    ([producerId, info]): ProducerInfo => ({
                      producerId,
                      producerUserId: leftUserId,
                      kind: info.kind,
                      type: info.type,
                    }),
                  );

                for (const info of Array.from(
                  pendingProducersRef.current.values(),
                )) {
                  if (info.producerUserId === leftUserId) {
                    dropDepartedProducer(info);
                  }
                }

                for (const producerInfo of producersToClose) {
                  dropDepartedProducer(producerInfo);
                }

                dispatchParticipants({
                  type: "MARK_LEAVING",
                  userId: leftUserId,
                });

                scheduleParticipantRemoval(leftUserId);
              },
            );

            onLive(
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

            onLive(
              "displayNameSnapshot",
              ({
                users,
                roomId: eventRoomId,
              }: {
                users: DisplayNameSnapshotEntry[];
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                applyDisplayNameSnapshot(users || []);
              },
            );

            onLive(
              "handRaisedSnapshot",
              ({ users, roomId: eventRoomId }: HandRaisedSnapshot) => {
                if (!isRoomEvent(eventRoomId)) return;
                (users || []).forEach(({ userId: raisedUserId, raised }) => {
                  if (raisedUserId === userId) {
                    setIsHandRaised(raised);
                    return;
                  }
                  if (shouldIgnoreDepartedParticipant(raisedUserId)) return;
                  dispatchParticipants({
                    type: "UPDATE_HAND_RAISED",
                    userId: raisedUserId,
                    raised,
                  });
                });
              },
            );

            onLive(
              "chatHistorySnapshot",
              ({ messages, roomId: eventRoomId }: ChatHistorySnapshot) => {
                if (!isRoomEvent(eventRoomId)) return;
                if (!Array.isArray(messages) || messages.length === 0) return;
                const visible = messages.filter(
                  (message) =>
                    !message.isDirect ||
                    message.userId === userId ||
                    message.dmTargetUserId === userId,
                );
                if (visible.length === 0) return;
                chat.setChatMessages((prev) => {
                  const bySnapshotId = new Map(
                    visible.map((message) => [message.id, message]),
                  );
                  const reconciled = prev.map((message) => {
                    const snapshot = bySnapshotId.get(message.id);
                    if (!snapshot) return message;
                    const nextReactions = snapshot.reactions?.length
                      ? snapshot.reactions
                      : undefined;
                    if (message.reactions === nextReactions) return message;
                    return { ...message, reactions: nextReactions };
                  });

                  const seen = new Set(
                    reconciled.map((message) => message.id),
                  );
                  const seeded = [...reconciled];
                  for (const message of visible) {
                    if (seen.has(message.id)) continue;
                    seen.add(message.id);
                    seeded.push({
                      ...normalizeChatMessage(message).message,
                      isHistory: true,
                    });
                  }
                  seeded.sort((a, b) => a.timestamp - b.timestamp);
                  return seeded;
                });
              },
            );

            onLive(
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

            onLive(
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
                if (shouldIgnoreDepartedParticipant(mutedUserId)) return;
                dispatchParticipants({
                  type: "UPDATE_MUTED",
                  userId: mutedUserId,
                  muted,
                });
                setProducerPausedByUser(mutedUserId, "audio", muted);
              },
            );

            onLive(
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
                if (shouldIgnoreDepartedParticipant(camUserId)) return;
                dispatchParticipants({
                  type: "UPDATE_CAMERA_OFF",
                  userId: camUserId,
                  cameraOff,
                });
                setProducerPausedByUser(camUserId, "video", cameraOff);
              },
            );

            onLive(
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
                      setNoiseCancellationTrackEnabled(track, false);
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

            onLive(
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

            onLive(
              "setVideoQuality",
              async ({ quality }: { quality: VideoQuality }) => {
                console.info(`[Meets] Setting video quality to: ${quality}`);
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

            onLive("chatMessage", (message: ChatMessage) => {
              console.info("[Meets] Chat message received:", message);
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
                  ttsVoiceToken: normalized.ttsVoiceToken,
                  messageId: normalized.id,
                });
              }
              if (!chat.isChatOpenRef.current) {
                chat.setUnreadCount((prev) => prev + 1);
              }
            });

            onLive(
              "conclaveMessage",
              (payload: {
                id?: string;
                content?: string;
                done?: boolean;
                timestamp?: number;
                reasoning?: string;
                reasoningDone?: boolean;
                tasks?: AssistantTask[];
                errored?: boolean;
              }) => {
                if (!payload?.id) return;
                const status: ConclaveAssistantStatus = payload.errored
                  ? "error"
                  : payload.done
                    ? "done"
                    : "streaming";
                let isNew = false;
                chat.setChatMessages((prev) => {
                  const index = prev.findIndex((m) => m.id === payload.id);
                  const previous =
                    index >= 0
                      ? (prev[index] as AssistantChatMessage)
                      : undefined;
                  if (
                    (previous?.assistantStatus === "done" ||
                      previous?.assistantStatus === "error") &&
                    payload.done !== true
                  ) {
                    return prev;
                  }
                  const incomingContent = payload.content ?? "";
                  const content =
                    payload.done === true
                      ? incomingContent || previous?.content || ""
                      : previous && previous.content.length > incomingContent.length
                        ? previous.content
                        : incomingContent || previous?.content || "";
                  const incomingReasoning = payload.reasoning ?? "";
                  const previousReasoning = previous?.reasoning ?? "";
                  const reasoningStale =
                    previousReasoning.length > incomingReasoning.length;
                  const reasoning = reasoningStale
                    ? previousReasoning
                    : incomingReasoning;
                  const reasoningDone =
                    payload.done === true ||
                    (reasoningStale
                      ? previous?.reasoningStatus === "done"
                      : payload.reasoningDone === true);
                  const mergedTasks = (payload.tasks ?? []).reduce<
                    AssistantTask[] | undefined
                  >((list, task) => mergeAssistantTask(list, task), previous?.tasks);
                  const base: AssistantChatMessage = {
                    id: payload.id as string,
                    userId: CONCLAVE_ASSISTANT_USER_ID,
                    displayName: CONCLAVE_ASSISTANT_NAME,
                    content,
                    timestamp:
                      index >= 0
                        ? prev[index].timestamp
                        : (payload.timestamp ?? Date.now()),
                    isAssistant: true,
                    assistantStatus: status,
                    reasoning: reasoning || undefined,
                    reasoningStatus: reasoning
                      ? reasoningDone
                        ? "done"
                        : "streaming"
                      : undefined,
                    tasks:
                      payload.done === true
                        ? completeAssistantTasks(mergedTasks)
                        : mergedTasks,
                  };
                  if (index === -1) {
                    isNew = true;
                    return [...prev, base];
                  }
                  const next = [...prev];
                  next[index] = base;
                  return next;
                });
                if (isNew && !chat.isChatOpenRef.current) {
                  chat.setUnreadCount((prev) => prev + 1);
                }
              },
            );

            onLive("reaction", (reaction: ReactionNotification) => {
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

            onLive(
              "chat:reactionChanged",
              ({
                messageId,
                reactions,
                roomId: eventRoomId,
              }: ChatReactionChangedNotification) => {
                if (!isRoomEvent(eventRoomId)) return;
                if (!messageId || !Array.isArray(reactions)) return;

                chat.setChatMessages((prev) =>
                  prev.map((message) =>
                    message.id === messageId
                      ? {
                          ...message,
                          reactions: reactions.length ? reactions : undefined,
                        }
                      : message,
                  ),
                );
              },
            );

            onLive(
              "handRaised",
              ({ userId: raisedUserId, raised }: HandRaisedNotification) => {
                if (raisedUserId === userId) {
                  setIsHandRaised(raised);
                  return;
                }
                if (shouldIgnoreDepartedParticipant(raisedUserId)) return;
                dispatchParticipants({
                  type: "UPDATE_HAND_RAISED",
                  userId: raisedUserId,
                  raised,
                });
              },
            );

            onLive("kicked", (payload?: { reason?: string }) => {
              cleanup();
              setMeetError({
                code: "UNKNOWN",
                message: "You have been kicked from the meeting.",
                recoverable: false,
              });
              onCallEnded?.({
                kind: "removed",
                detail: customServerText(payload?.reason, DEFAULT_KICK_REASON),
              });
            });

            onLive(
              "redirect",
              async ({ newRoomId }: { newRoomId: string }) => {
                console.info(
                  `[Meets] Redirect received. Initiating full switch to ${newRoomId}`,
                );
                void handleRedirectRef.current(newRoomId);
              },
            );

            onLive(
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
                console.info("[Meets] User requesting to join:", userId);
                playNotificationSound("waiting");
                setPendingUsers((prev) => {
                  const newMap = new Map(prev);
                  newMap.set(userId, displayName);
                  return newMap;
                });
              },
            );

            onLive(
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

            onLive(
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

            onLive(
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

            onLive(
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

            let approvedJoin: Promise<void> | null = null;
            onLive("joinApproved", () => {
              if (approvedJoin) {
                console.info("[Meets] Join already approved; ignoring a repeated approval.");
                return;
              }
              approvedJoin = joinAfterApproval().finally(() => {
                approvedJoin = null;
              });
            });
            const joinAfterApproval = async (): Promise<void> => {
              const approvalGeneration = reconnectGenerationRef.current;
              console.info("[Meets] Join approved! Re-attempting join...");
              const joinOptions = joinOptionsRef.current;
              let stream = localStreamRef.current;
              const mediaNeeds = getJoinMediaNeeds();
              const shouldRequestMedia =
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
                approvalGeneration !== reconnectGenerationRef.current ||
                intentionalDisconnectRef.current ||
                socketRef.current !== socket
              ) return;
              if (
                currentRoomIdRef.current &&
                (stream ||
                  !hasRequiredJoinMediaNeed(mediaNeeds) ||
                  !shouldRequestMedia ||
                  joinOptions.isRecorder ||
                  bypassMediaPermissions ||
                  joinOptions.joinMode === "webinar_attendee")
              ) {
                await joinRoomInternal(
                  currentRoomIdRef.current,
                  stream,
                  joinOptions,
                ).catch((joinError: unknown) => {
                    if (
                      approvalGeneration !== reconnectGenerationRef.current ||
                      intentionalDisconnectRef.current ||
                      socketRef.current !== socket
                    ) return;
                    console.error("[Meets] Join after approval failed:", joinError);
                    refuseEntry(createMeetError(joinError));
                  });
              } else {
                console.error(
                  "[Meets] Cannot re-join: missing room ID or local stream",
                  {
                    roomId: currentRoomIdRef.current,
                    stream: summarizeStreamForLog(localStreamRef.current),
                    bypassMediaPermissions,
                  },
                );
                refuseEntry(null);
              }
            };

            onLive("joinRejected", () => {
              console.info("[Meets] Join rejected.");
              const rejected = joinRejectedUpdate();
              setMeetError(rejected.meetError);
              setSetupNotice?.(rejected.setupNotice);
              setConnectionState(rejected.connectionState);
              setWaitingMessage(rejected.waitingMessage);
              cleanup();
            });

            onLive(
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

            onLive(
              "roomLockChanged",
              ({
                locked,
                roomId: eventRoomId,
              }: {
                locked: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.info("[Meets] Room lock changed:", locked);
                setIsRoomLocked(locked);
              },
            );

            onLive(
              "ttsDisabledChanged",
              ({
                disabled,
                roomId: eventRoomId,
              }: {
                disabled: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.info("[Meets] Room TTS disabled changed:", disabled);
                setIsTtsDisabled(disabled);
              },
            );

            onLive(
              "dmStateChanged",
              ({
                enabled,
                roomId: eventRoomId,
              }: {
                enabled: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.info("[Meets] Room DM state changed:", enabled);
                setIsDmEnabled(enabled);
              },
            );

            onLive(
              "imageAttachmentsStateChanged",
              ({
                enabled,
                roomId: eventRoomId,
              }: {
                enabled: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setAreImageAttachmentsEnabled(enabled);
              },
            );

            onLive(
              "reactionsDisabledChanged",
              ({
                disabled,
                roomId: eventRoomId,
              }: {
                disabled: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.info("[Meets] Room reactions disabled changed:", disabled);
                setIsReactionsDisabled(disabled);
              },
            );

            onLive(
              "participantMediaPermissionsChanged",
              ({
                unmuteAllowed,
                videoAllowed,
                roomId: eventRoomId,
              }: {
                unmuteAllowed: boolean;
                videoAllowed: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                setIsParticipantUnmuteAllowed(unmuteAllowed);
                setIsParticipantVideoAllowed(videoAllowed);
              },
            );

            onLive(
              "noGuestsChanged",
              ({
                noGuests,
                roomId: eventRoomId,
              }: {
                noGuests: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.info("[Meets] No-guests changed:", noGuests);
                setIsNoGuests(noGuests);
              }
            );

            onLive(
              "chatLockChanged",
              ({
                locked,
                roomId: eventRoomId,
              }: {
                locked: boolean;
                roomId?: string;
              }) => {
                if (!isRoomEvent(eventRoomId)) return;
                console.info("[Meets] Chat lock changed:", locked);
                setIsChatLocked(locked);
              }
            );

            onLive(
              "meeting:configChanged",
              (nextConfig: MeetingConfigSnapshot) => {
                setMeetingRequiresInviteCode(
                  Boolean(nextConfig.requiresInviteCode),
                );
              },
            );

            onLive(
              "webinar:configChanged",
              (nextConfig: WebinarConfigSnapshot) => {
                setWebinarConfig(nextConfig);
              },
            );

            onLive(
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
                  qaEnabled: previous?.qaEnabled ?? true,
                }));
              },
            );

            onLive(
              "webinar:participantJoined",
              (notification: WebinarParticipantJoinedNotification) => {
                if (joinMode !== "webinar_attendee") return;
                if (!isRoomEvent(notification.roomId)) return;
                if (notification.userId === userId) return;

                const displayName = notification.displayName;
                if (displayName) {
                  setDisplayNames((prev) => {
                    if (prev.get(notification.userId) === displayName) {
                      return prev;
                    }
                    const next = new Map(prev);
                    next.set(notification.userId, displayName);
                    return next;
                  });
                }
                webinarJoinedParticipantIdsRef.current.add(notification.userId);
                if (
                  shouldIgnoreDepartedParticipant(notification.userId) ||
                  webinarVisibleParticipantIdsRef.current.has(notification.userId)
                ) {
                  void syncProducers();
                }
              },
            );

            onLive(
              "webinar:qaSnapshot",
              (snapshot: WebinarQaSnapshot) => {
                if (!isRoomEvent(snapshot.roomId)) return;
                setWebinarQaEntries(
                  [...(snapshot.entries ?? [])].sort(
                    (a, b) => a.askedAt - b.askedAt,
                  ),
                );
              },
            );

            onLive(
              "webinar:qaChanged",
              (notification: WebinarQaChangedNotification) => {
                if (!isRoomEvent(notification.roomId)) return;
                setWebinarQaEntries((previous) => {
                  if (notification.removedId) {
                    return previous.filter(
                      (entry) => entry.id !== notification.removedId,
                    );
                  }
                  const entry = notification.entry;
                  if (!entry) return previous;
                  const existingIndex = previous.findIndex(
                    (candidate) => candidate.id === entry.id,
                  );
                  if (existingIndex === -1) {
                    return [...previous, entry].sort(
                      (a, b) => a.askedAt - b.askedAt,
                    );
                  }
                  const next = previous.slice();
                  next[existingIndex] = {
                    ...entry,
                    hasUpvoted:
                      entry.hasUpvoted ?? previous[existingIndex].hasUpvoted,
                  };
                  return next;
                });
              },
            );

            onLive(
              "webinar:handQueueChanged",
              (notification: WebinarHandQueueChangedNotification) => {
                if (!isRoomEvent(notification.roomId)) return;
                setWebinarHandQueue(notification.queue ?? []);
              },
            );

            onLive(
              "webinar:promoted",
              (notification: WebinarPromotedNotification) => {
                if (joinMode !== "webinar_attendee") return;
                if (!isRoomEvent(notification.roomId)) return;
                setWebinarStageInvite({
                  promotedByName: notification.promotedByName,
                  rejoinRoomId: notification.rejoinRoomId,
                });
              },
            );

            onLive(
              "webinar:demoted",
              (notification: WebinarDemotedNotification) => {
                if (joinMode === "webinar_attendee") return;
                if (!isRoomEvent(notification.roomId)) return;
                onWebinarDemoted?.(notification);
              },
            );

            onLive(
              "webinar:feedChanged",
              (notification: WebinarFeedChangedNotification) => {
                if (joinMode !== "webinar_attendee") return;
                if (!isRoomEvent(notification.roomId)) return;
                const nextVisibleParticipantIds = new Set<string>();
                for (const producer of notification.producers) {
                  nextVisibleParticipantIds.add(producer.producerUserId);
                }
                webinarVisibleParticipantIdsRef.current =
                  nextVisibleParticipantIds;
                const activeFeedProducers = notification.producers.filter(
                  (producer) => {
                    const producerUserId = producer.producerUserId;
                    return (
                      nextVisibleParticipantIds.has(producerUserId) &&
                      (!shouldIgnoreDepartedParticipant(producerUserId) ||
                        webinarJoinedParticipantIdsRef.current.has(producerUserId))
                    );
                  },
                );
                setWebinarSpeakerUserId(
                  notification.speakerUserId &&
                    nextVisibleParticipantIds.has(notification.speakerUserId) &&
                    (!shouldIgnoreDepartedParticipant(notification.speakerUserId) ||
                      webinarJoinedParticipantIdsRef.current.has(
                        notification.speakerUserId,
                      ))
                    ? notification.speakerUserId
                    : activeFeedProducers[0]?.producerUserId ??
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
            if (
              connectionGeneration !== reconnectGenerationRef.current ||
              intentionalDisconnectRef.current
            ) {
              reject(toError(err));
              return;
            }
            // Adopting the identity the token names is the expected way in:
            // the join starts over from the render that knows it, and only a
            // failure of that join is an error.
            if (err instanceof JoinIdentityChangedError) {
              reject(err);
              return;
            }
            console.error("Failed to get join info:", err);
            const reconnectFailure = describeReconnectFailure(err);
            const isRecoverable = isRecoverableReconnectFailure(err);
            setMeetError({
              code: "CONNECTION_FAILED",
              message: reconnectFailure,
              recoverable: isRecoverable,
            });
            setConnectionState("error");
            reject(toError(err));
          }
        })();
      });
    },
    [
      addReaction,
      audioProducerRef,
      cleanup,
      refuseEntry,
      consumeProducer,
      currentRoomIdRef,
      deviceRef,
      dispatchParticipants,
      emitCloseProducer,
      handleLocalTrackEnded,
      handleProducerClosed,
      handleRedirectRef,
      handleReconnectRef,
      applyWebcamCodecPolicyNotification,
      applyServerActiveSpeaker,
      applyDisplayNameSnapshot,
      applyParticipantConnectionStatus,
      ensureLiveLocalMediaForJoin,
      getVideoPublishTrack,
      getJoinInfo,
      getJoinMediaNeeds,
      joinMode,
      isCameraOff,
      isMuted,
      isAdmin,
      finishLocalRoomEnded,
      setIsAdmin,
      isRoomEvent,
      joinOptionsRef,
      joinRoomInternal,
      leaveTimeoutsRef,
      markRemoteParticipantDeparted,
      markRemoteParticipantPresent,
      clearParticipantConnectionStatus,
      localStream,
      localStreamRef,
      pendingProducersRef,
      playNotificationSound,
      shouldPlayJoinLeaveSound,
      shouldIgnoreDepartedParticipant,
      applyWebinarFeedProducers,
      producerMapRef,
      requestAudioProducerRecovery,
      requestCameraProducerRecovery,
      reconnectAttemptsRef,
      restoreWebinarFeedParticipant,
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
      setIsReactionsDisabled,
      setHostUserId,
      setWebinarRole,
      setWebinarSpeakerUserId,
      setWebinarConfig,
      setWebinarQaEntries,
      setWebinarHandQueue,
      setWebinarStageInvite,
      onWebinarDemoted,
      onCallEnded,
      setServerRestartNotice,
      setAdminNotice,
      setServerActiveSpeakerAvailable,
      setLocalStream,
      setMeetError,
      setSetupNotice,
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

  const handleReconnect = useCallback(async (options?: ReconnectRequest) => {
    if (reconnectInFlightRef.current) {
      const cancelBackoff = reconnectBackoffCancelRef.current;
      const decision = resolveInFlightReconnectRequest(options, {
        isWaitingForBackoff: reconnectPhaseRef.current === "waiting",
        canCancelBackoff: Boolean(cancelBackoff),
      });
      if (decision.markUserRetry) {
        manualReconnectRetryRequestedRef.current = true;
      }
      if (decision.cancelBackoff && cancelBackoff) {
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
      if (!decision.announceQueuedRetry) return;

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
    reconnectAttemptsRef.current = resolveReconnectStartAttempts(
      reconnectAttemptsRef.current,
      MAX_RECONNECT_ATTEMPTS,
    );
    setMeetError(null);

    try {
      while (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        if (reconnectGeneration !== reconnectGenerationRef.current) return;
        if (intentionalDisconnectRef.current) return;
        const shouldSurfaceReconnectState =
          !isMeetingDocumentHidden();
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

        console.info(
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
          if (intentionalDisconnectRef.current) return;

          const joinOptions = joinOptionsRef.current;
          const mediaNeeds = getJoinMediaNeeds();
          const stream = await ensureLiveLocalMediaForJoin(
            localStreamRef.current || localStream,
            joinOptions,
            "reconnect",
          );
          if (
            reconnectGeneration !== reconnectGenerationRef.current ||
            intentionalDisconnectRef.current
          ) return;
          const shouldRetryLocalMediaAfterJoin =
            !stream &&
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
          if (err instanceof JoinIdentityChangedError) {
            cleanupRoomResources({
              resetRoomId: false,
              preserveMeetingState: true,
            });
            updateReconnectRecoveryStatus(null);
            return;
          }
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
            refuseEntry(
              { code: "CONNECTION_FAILED", message: reconnectFailure, recoverable: false },
              buildReconnectRecoveryStatus(
                "failed",
                attempt,
                "Could not reconnect to the meeting.",
                reconnectFailure,
              ),
            );
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
    refuseEntry,
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

    let lastEventLoopHeartbeatAt = Date.now();

    const scheduleForegroundRecovery = () => {
      if (foregroundRecoveryTimeoutRef.current) {
        window.clearTimeout(foregroundRecoveryTimeoutRef.current);
      }

      foregroundRecoveryTimeoutRef.current = window.setTimeout(() => {
        foregroundRecoveryTimeoutRef.current = null;
        clearExpiredParticipantConnectionStatuses();
        requestForegroundScreenShareKeyFrames();
        recoverActiveMeeting("foreground");
      }, FOREGROUND_RECOVERY_DELAY_MS);
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

    const handleEventLoopHeartbeat = () => {
      const now = Date.now();
      const gapMs = now - lastEventLoopHeartbeatAt;
      lastEventLoopHeartbeatAt = now;

      if (gapMs < SUSPENDED_EVENT_LOOP_GAP_MS) return;
      if (document.visibilityState !== "visible") return;

      console.warn(
        "[Meets] Browser event loop was suspended; recovering meeting media.",
        { gapMs },
      );
      scheduleForegroundRecovery();
    };

    const eventLoopHeartbeatInterval = window.setInterval(
      handleEventLoopHeartbeat,
      SUSPENDED_EVENT_LOOP_CHECK_MS,
    );

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("focus", handleFocus);

    return () => {
      window.clearInterval(eventLoopHeartbeatInterval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handleFocus);
      if (foregroundRecoveryTimeoutRef.current) {
        window.clearTimeout(foregroundRecoveryTimeoutRef.current);
        foregroundRecoveryTimeoutRef.current = null;
      }
    };
  }, [
    clearExpiredParticipantConnectionStatuses,
    recoverActiveMeeting,
    requestForegroundScreenShareKeyFrames,
  ]);

  const handleRedirectCallback = useCallback(
    async (newRoomId: string) => {
      console.info(`[Meets] Executing hard redirect to ${newRoomId}`);

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
      const joinGeneration = reconnectGenerationRef.current;

      // A join that starts over under the identity its token named is still
      // the attempt that was already counted.
      const continuesAttempt = identityRestartRoomIdRef.current === targetRoomId;
      identityRestartRoomIdRef.current = null;
      if (!continuesAttempt) {
        telemetry.capture("meet_join_attempt", {
          roomId: targetRoomId,
          joinMode,
          isAdmin,
        });
      }

      localRoomEndedHandledRef.current = false;
      setMeetError(null);
      setSetupNotice?.(null);
      updateReconnectRecoveryStatus(null);
      setConnectionState("connecting");
      if (!bypassMediaPermissions) {
        primeAudioOutput();
      }
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
      // An attempt that starts over keeps what the meeting was joined with:
      // the codes asked for along the way, and the name.
      const carried = continuesAttempt ? joinOptionsRef.current : null;
      const joinOptions: {
        displayName?: string;
        isRecorder?: boolean;
        joinMode: JoinMode;
        webinarInviteCode?: string;
        meetingInviteCode?: string;
      } = {
        displayName:
          (isAdmin ? normalizedDisplayName || undefined : undefined) ??
          carried?.displayName,
        isRecorder: bypassMediaPermissions,
        joinMode,
        ...(carried?.webinarInviteCode
          ? { webinarInviteCode: carried.webinarInviteCode }
          : {}),
        ...(carried?.meetingInviteCode
          ? { meetingInviteCode: carried.meetingInviteCode }
          : {}),
      };
      joinOptionsRef.current = joinOptions;
      const candidateStream = localStreamRef.current ?? localStream;
      const mediaNeeds = getJoinMediaNeeds();
      const shouldRequestMedia =
        !joinOptions.isRecorder &&
        joinOptions.joinMode !== "webinar_attendee" &&
        !bypassMediaPermissions &&
        (mediaNeeds.needsAudio || mediaNeeds.needsVideo);

      // The attempt that starts over waits for the media request the first
      // one made. A second request would capture the microphone and camera
      // again, and nothing would ever stop the first capture.
      const heldMedia = identityRestartMediaRef.current;
      identityRestartMediaRef.current = null;
      const mediaRequest =
        continuesAttempt && heldMedia?.roomId === targetRoomId
          ? heldMedia.request
          : shouldRequestMedia
            ? ensureLiveLocalMediaForJoin(
                candidateStream,
                joinOptions,
                "initial join",
              )
            : Promise.resolve(candidateStream);

      try {
        const [, stream] = await Promise.all([
          connectSocket(targetRoomId),
          mediaRequest,
        ]);
        if (
          joinGeneration !== reconnectGenerationRef.current ||
          intentionalDisconnectRef.current
        ) return;

        if (
          shouldRequestMedia &&
          !stream &&
          hasRequiredJoinMediaNeed(mediaNeeds)
        ) {
          refuseEntry(null);
          return;
        }

        const joinMediaIntent = resolveMediaPublishIntent();
        const committedForJoin = localStreamRef.current ?? stream;
        const streamForJoin = joinMediaIntent.isCameraOn
          ? committedForJoin
          : dropVideoTracksForCameraOff(committedForJoin, "camera-off initial join");

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
            break;
          } catch (joinError) {
            if (
              joinError instanceof JoinRoomRedirectError &&
              joinRedirectCount < MAX_JOIN_ROOM_REDIRECTS
            ) {
              joinRedirectCount += 1;
              console.info(
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
              ? await requestMeetingInviteCode()
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
        if (
          joinGeneration !== reconnectGenerationRef.current ||
          intentionalDisconnectRef.current
        ) return;
        if (err instanceof JoinIdentityChangedError) {
          identityRestartMediaRef.current = {
            roomId: targetRoomId,
            request: mediaRequest,
          };
          void mediaRequest.catch(() => undefined);
          return;
        }
        console.error("[Meets] Error joining room:", err);
        telemetry.capture("meet_join_failure", {
          roomId: targetRoomId,
          joinMode,
          error: err instanceof Error ? err.message : String(err ?? ""),
        });
        refuseEntry(createMeetError(err));
      }
    },
    [
      connectSocket,
      cleanupRoomResources,
      refuseEntry,
      displayNameInput,
      dropVideoTracksForCameraOff,
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
      primeAudioOutput,
      requestMeetingInviteCode,
      requestWebinarInviteCode,
      resolveMediaPublishIntent,
      bypassMediaPermissions,
      refs.abortControllerRef,
      refs.intentionalDisconnectRef,
      intentionalDisconnectRef,
      setConnectionState,
      setLocalStream,
      setMeetError,
      setSetupNotice,
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
      await handleReconnect({ immediate: true, userInitiated: true });
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
      await handleReconnect({ immediate: true, userInitiated: true });
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
      console.info("[Meets] Auto-joining new room...");
      shouldAutoJoinRef.current = false;
      void joinRoom();
    }
  }, [joinRoom, shouldAutoJoinRef]);

  const toggleRoomLock = useCallback(
    (locked: boolean): Promise<boolean> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(false);

      return new Promise((resolve) => {
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve(false),
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
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve(false),
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
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve(false),
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

  const setParticipantMediaPermissions = useCallback(
    (permissions: {
      unmuteAllowed?: boolean;
      videoAllowed?: boolean;
    }): Promise<boolean> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(false);

      return new Promise((resolve) => {
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve(false),
          "setParticipantMediaPermissions",
          permissions,
          (response: { success: boolean } | { error: string }) => {
            if ("error" in response) {
              console.error(
                "[Meets] Failed to update participant media permissions:",
                response.error,
              );
              resolve(false);
              return;
            }
            resolve(response.success);
          },
        );
      });
    },
    [socketRef],
  );

  const endRoomForEveryone = useCallback(
    (
      options: { message?: string; delayMs?: number } = {},
    ): Promise<boolean> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(false);

      return new Promise((resolve) => {
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve(false),
          "admin:endRoom",
          {
            message:
              options.message || "This meeting has been ended by the host.",
            delayMs: options.delayMs ?? 0,
          },
          (
            response:
              | { success: boolean; roomId?: string; delayMs?: number }
              | { error: string },
          ) => {
            if ("error" in response) {
              console.error("[Meets] Failed to end room:", response.error);
              resolve(false);
              return;
            }
            if (response.success) {
              finishLocalRoomEnded();
            }
            resolve(response.success);
          },
        );
      });
    },
    [finishLocalRoomEnded, socketRef],
  );

  const getTranscriptToken =
    useCallback((): Promise<TranscriptTokenResponse | null> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(null);

      return new Promise((resolve) => {
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve(null),
          "transcript:getToken",
          (response: TranscriptTokenResponse | { error: string }) => {
            if ("error" in response) {
              console.error(
                "[Meets] Failed to fetch transcript token:",
                response.error,
              );
              resolve(null);
              return;
            }
            resolve(response);
          },
        );
      });
    }, [socketRef]);

  const getTranscriptSfuRelayStatus =
    useCallback((): Promise<TranscriptSfuRelayStatusResponse | null> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(null);

      return new Promise((resolve) => {
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve(null),
          "transcript:sfuRelayStatus",
          (response: TranscriptSfuRelayStatusResponse | { error: string }) => {
            if ("error" in response) {
              console.error(
                "[Meets] Failed to fetch transcript SFU relay status:",
                response.error,
              );
              resolve(null);
              return;
            }
            resolve(response);
          },
        );
      });
    }, [socketRef]);

  const startTranscriptSfuRelay =
    useCallback((
      request: TranscriptSfuRelayStartRequest,
    ): Promise<TranscriptSfuRelayStartResponse | null> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(null);

      return new Promise((resolve) => {
        emitWithAckTimeout(
          socket,
          LONG_ACK_REQUEST_TIMEOUT_MS,
          () => resolve({
              mode: "sfu",
              success: false,
              status: "error",
              reason: "The server did not respond. Try again.",
              updatedAt: Date.now(),
            }),
          "transcript:sfuRelayStart",
          request,
          (response: TranscriptSfuRelayStartResponse | { error: string }) => {
            if ("error" in response) {
              console.error(
                "[Meets] Failed to start transcript SFU relay:",
                response.error,
              );
              resolve({
                mode: "sfu",
                success: false,
                status: "error",
                reason: response.error,
                updatedAt: Date.now(),
              });
              return;
            }
            resolve(response);
          },
        );
      });
    }, [socketRef]);

  const stopTranscriptSfuRelay =
    useCallback((): Promise<TranscriptSfuRelayStopResponse | null> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(null);

      return new Promise((resolve) => {
        emitWithAckTimeout(
          socket,
          LONG_ACK_REQUEST_TIMEOUT_MS,
          () => resolve(null),
          "transcript:sfuRelayStop",
          (response: TranscriptSfuRelayStopResponse | { error: string }) => {
            if ("error" in response) {
              console.error(
                "[Meets] Failed to stop transcript SFU relay:",
                response.error,
              );
              resolve(null);
              return;
            }
            resolve(response);
          },
        );
      });
    }, [socketRef]);

  const getMeetingConfig = useCallback(
    (): Promise<MeetingConfigSnapshot | null> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve(null);

      return new Promise((resolve) => {
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve(null),
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
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve(null),
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
      emitWithAckTimeout(
        socket,
        ACK_REQUEST_TIMEOUT_MS,
        () => resolve(null),
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
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve(null),
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
      emitWithAckTimeout(
        socket,
        ACK_REQUEST_TIMEOUT_MS,
        () => resolve(null),
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
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve(null),
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

  const submitWebinarQuestion = useCallback(
    (question: string): Promise<{ ok: boolean; error?: string }> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve({ ok: false, error: "Not connected" });

      return new Promise((resolve) => {
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve({ ok: false, error: "The server did not respond. Try again." }),
          "webinar:qa:submit",
          { question },
          (response: { success: boolean } | { error: string }) => {
            if ("error" in response) {
              resolve({ ok: false, error: response.error });
              return;
            }
            resolve({ ok: true });
          },
        );
      });
    },
    [socketRef],
  );

  const upvoteWebinarQuestion = useCallback(
    (id: string): void => {
      const socket = socketRef.current;
      if (!socket) return;
      setWebinarQaEntries((previous) =>
        previous.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                hasUpvoted: !entry.hasUpvoted,
                upvotes: Math.max(0, entry.upvotes + (entry.hasUpvoted ? -1 : 1)),
              }
            : entry,
        ),
      );
      socket.emit(
        "webinar:qa:upvote",
        { id },
        (
          response:
            | { success: boolean; upvotes: number; hasUpvoted: boolean }
            | { error: string },
        ) => {
          if ("error" in response) {
            setWebinarQaEntries((previous) =>
              previous.map((entry) =>
                entry.id === id
                  ? {
                      ...entry,
                      hasUpvoted: !entry.hasUpvoted,
                      upvotes: Math.max(
                        0,
                        entry.upvotes + (entry.hasUpvoted ? -1 : 1),
                      ),
                    }
                  : entry,
              ),
            );
            return;
          }
          setWebinarQaEntries((previous) =>
            previous.map((entry) =>
              entry.id === id
                ? {
                    ...entry,
                    upvotes: response.upvotes,
                    hasUpvoted: response.hasUpvoted,
                  }
                : entry,
            ),
          );
        },
      );
    },
    [socketRef, setWebinarQaEntries],
  );

  const moderateWebinarQuestion = useCallback(
    (request: WebinarQaModerateRequest): Promise<{ ok: boolean; error?: string }> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve({ ok: false, error: "Not connected" });

      return new Promise((resolve) => {
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve({ ok: false, error: "The server did not respond. Try again." }),
          "webinar:qa:moderate",
          request,
          (response: { success: boolean } | { error: string }) => {
            if ("error" in response) {
              resolve({ ok: false, error: response.error });
              return;
            }
            resolve({ ok: true });
          },
        );
      });
    },
    [socketRef],
  );

  const setWebinarHandRaisedRemote = useCallback(
    (raised: boolean): void => {
      const socket = socketRef.current;
      if (!socket) return;
      setIsWebinarHandRaised(raised);
      emitWithAckTimeout(
        socket,
        ACK_REQUEST_TIMEOUT_MS,
        () => setIsWebinarHandRaised(!raised),
        "webinar:setHandRaised",
        { raised },
        (response: { success: boolean; raised: boolean } | { error: string }) => {
          if ("error" in response) {
            setIsWebinarHandRaised(!raised);
            return;
          }
          setIsWebinarHandRaised(response.raised);
        },
      );
    },
    [socketRef, setIsWebinarHandRaised],
  );

  const declineWebinarStageInvite = useCallback((): void => {
    socketRef.current?.emit("webinar:declineStage", () => {});
  }, [socketRef]);

  const promoteWebinarAttendee = useCallback(
    (userId: string): Promise<{ ok: boolean; error?: string; code?: string }> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve({ ok: false, error: "Not connected" });

      return new Promise((resolve) => {
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve({ ok: false, error: "The server did not respond. Try again." }),
          "webinar:promoteAttendee",
          { userId },
          (
            response:
              | { success: boolean }
              | { error: string; code?: string },
          ) => {
            if ("error" in response) {
              resolve({ ok: false, error: response.error, code: response.code });
              return;
            }
            resolve({ ok: true });
          },
        );
      });
    },
    [socketRef],
  );

  const demoteWebinarParticipant = useCallback(
    (userId: string): Promise<{ ok: boolean; error?: string }> => {
      const socket = socketRef.current;
      if (!socket) return Promise.resolve({ ok: false, error: "Not connected" });

      return new Promise((resolve) => {
        emitWithAckTimeout(
          socket,
          ACK_REQUEST_TIMEOUT_MS,
          () => resolve({ ok: false, error: "The server did not respond. Try again." }),
          "webinar:demoteParticipant",
          { userId },
          (response: { success: boolean } | { error: string }) => {
            if ("error" in response) {
              resolve({ ok: false, error: response.error });
              return;
            }
            resolve({ ok: true });
          },
        );
      });
    },
    [socketRef],
  );

  return {
    cleanup,
    closeConnection,
    cleanupRoomResources,
    connectSocket,
    ensureProducerTransport,
    republishScreenShare,
    joinRoom,
    joinRoomById,
    retryReconnect,
    reconnectRecoveryStatus,
    toggleRoomLock,
    toggleNoGuests,
    toggleChatLock,
    setParticipantMediaPermissions,
    endRoomForEveryone,
    getTranscriptToken,
    getTranscriptSfuRelayStatus,
    startTranscriptSfuRelay,
    stopTranscriptSfuRelay,
    getMeetingConfig,
    updateMeetingConfig,
    getWebinarConfig,
    updateWebinarConfig,
    rotateWebinarLink,
    generateWebinarLink,
    submitWebinarQuestion,
    upvoteWebinarQuestion,
    moderateWebinarQuestion,
    setWebinarHandRaisedRemote,
    declineWebinarStageInvite,
    promoteWebinarAttendee,
    demoteWebinarParticipant,
  };
}
