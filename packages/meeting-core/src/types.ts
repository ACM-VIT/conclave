import type {
  Consumer,
  DtlsParameters,
  IceCandidate,
  IceParameters,
  Producer,
  RtpCapabilities,
  RtpParameters,
  Transport,
} from "mediasoup-client/types";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "joining"
  | "joined"
  | "reconnecting"
  | "waiting"
  | "error";

export type ProducerType = "webcam" | "screen";
export type JoinMode = "meeting" | "webinar_attendee";

export type ReactionKind = "emoji" | "asset";

export type ParticipantConnectionStatus =
  | {
      state: "reconnecting";
      reason?: string;
      graceMs?: number;
      updatedAt?: number;
    }
  | {
      state: "reconnected";
      reason?: string;
      downtimeMs?: number;
      updatedAt?: number;
    };

export interface ChatMessage {
  id: string;
  userId: string;
  displayName: string;
  content: string;
  timestamp: number;
  gif?: ChatGifAttachment;
  image?: ChatImageAttachment;
  isDirect?: boolean;
  dmTargetUserId?: string;
  dmTargetDisplayName?: string;
  replyTo?: ChatReplyPreview;
  /**
   * Set client-side by normalizeChatMessage on /tts messages so UIs can
   * render them as spoken voice messages. Never sent over the wire.
   */
  isTts?: boolean;
  /** Encrypted capability for the sender's consented cloned TTS voice. */
  ttsVoiceToken?: string;
  /** Sender dismissed the link preview; clients must not render embeds. */
  suppressEmbeds?: boolean;
  /**
   * Emoji reactions on this message. Server-authoritative and always sent as
   * the complete set, so clients replace rather than merge. Absent means none.
   */
  reactions?: ChatMessageReaction[];
}

/**
 * One emoji and everyone who reacted with it. User IDs (not a bare count) are
 * on the wire so a client can render "you reacted" without extra bookkeeping,
 * and so toggling stays idempotent across reconnects.
 */
export interface ChatMessageReaction {
  emoji: string;
  userIds: string[];
}

/**
 * Caps the distinct emoji per message. Chat history is in-memory on the SFU,
 * so this bounds how much a room can accumulate.
 */
export const MAX_REACTIONS_PER_CHAT_MESSAGE = 12;

/**
 * The canonical emoji set for both floating meeting reactions and chat message
 * reactions. Mirrored by `allowedEmojiReactions` in the SFU (which stays
 * dependency-free of this package) — keep the two in sync.
 */
export const CHAT_REACTION_EMOJIS = [
  "👍",
  "👏",
  "😂",
  "❤️",
  "🎉",
  "😮",
  "😢",
  "🤔",
] as const;

export interface SendChatMessageOptions {
  suppressEmbeds?: boolean;
}

export interface ChatReplyPreview {
  id: string;
  userId: string;
  displayName: string;
  content: string;
  hasGif?: boolean;
  hasImage?: boolean;
  isDirect?: boolean;
  dmTargetUserId?: string;
}

export interface ChatImageAttachment {
  id: string;
  url: string;
  fileName: string;
  mimeType:
    | "image/jpeg"
    | "image/png"
    | "image/gif"
    | "image/webp"
    | "image/avif";
  size: number;
}

export type ChatGifAttachmentKind = "gif" | "sticker" | "clip";

export interface ChatGifAttachment {
  id: string;
  title: string;
  url: string;
  previewUrl?: string;
  pageUrl?: string;
  width?: number;
  height?: number;
  // Which Klipy media catalog this came from. Absent on legacy messages,
  // which should be treated as "gif". Clips additionally carry `videoUrl`.
  kind?: ChatGifAttachmentKind;
  // Direct MP4 URL for clips. `url` remains a renderable image (the clip's
  // animated GIF) so clients that don't understand clips still show something.
  videoUrl?: string;
  source: "klipy";
}

export interface ReactionNotification {
  userId: string;
  emoji?: string;
  kind?: ReactionKind;
  value?: string;
  label?: string;
  timestamp: number;
  roomId?: string;
}

export interface HandRaisedNotification {
  userId: string;
  raised: boolean;
  timestamp: number;
  roomId?: string;
}

export interface HandRaisedSnapshot {
  users: { userId: string; raised: boolean }[];
  roomId?: string;
}

export interface AdminNoticeNotification {
  roomId?: string;
  message: string;
  level?: "info" | "warning" | "error";
  timestamp?: number;
  senderUserId?: string;
}

export interface ChatHistorySnapshot {
  messages: ChatMessage[];
  roomId?: string;
}

/** Complete post-toggle reaction set for one chat message. Replace, don't merge. */
export interface ChatReactionChangedNotification {
  messageId: string;
  reactions: ChatMessageReaction[];
  // Always set by the server (mirrors the sfu type); clients still guard with
  // isRoomEvent before applying, but the contract is that it is present.
  roomId: string;
}

export type {
  TranscriptAudioSource,
  TranscriptController,
  TranscriptMinutesEntry,
  TranscriptMinutesSnapshot,
  TranscriptMinutesStatus,
  TranscriptOpenAiKeySource,
  TranscriptQuestionRequest,
  TranscriptQuestionResponse,
  TranscriptSegment,
  TranscriptSegmentDelta,
  TranscriptServiceVersion,
  TranscriptSessionState,
  TranscriptSessionStatus,
  TranscriptSfuRelayStartRequest,
  TranscriptSfuRelayStartResponse,
  TranscriptSfuRelayStartToken,
  TranscriptSfuRelayStatus,
  TranscriptSfuRelayStatusResponse,
  TranscriptSfuRelayStopResponse,
  TranscriptSpeaker,
  TranscriptTokenCapabilities,
  TranscriptTokenResponse,
  TranscriptTransportMode,
} from "./transcript-types";

export {
  DEFAULT_TRANSCRIPT_QA_MODEL,
  DEFAULT_TRANSCRIPT_TRANSCRIPTION_MODEL,
  LIVE_TRANSCRIPT_TRANSCRIPTION_MODELS,
  normalizeRealtimeTranscriptModel,
  TRANSCRIPT_QA_MODELS,
  TRANSCRIPT_TRANSCRIPTION_MODELS,
} from "./transcript-models";
export type {
  TranscriptProviderKeyAvailability,
  TranscriptReasoningEffort,
  TranscriptResponseModelConfig,
  TranscriptTextVerbosity,
  TranscriptTranscriptionModelConfig,
  TranscriptTranscriptionProvider,
} from "./transcript-models";

export interface ReactionPayload {
  userId: string;
  kind: ReactionKind;
  value: string;
  label?: string;
  timestamp?: number;
}

export interface ReactionEvent extends ReactionPayload {
  id: string;
  timestamp: number;
  lane: number;
}

export interface ReactionOption {
  id: string;
  kind: ReactionKind;
  value: string;
  label: string;
}

export interface Participant {
  userId: string;
  videoStream: MediaStream | null;
  audioStream: MediaStream | null;
  screenShareStream: MediaStream | null;
  screenShareAudioStream: MediaStream | null;
  audioProducerId: string | null;
  videoProducerId: string | null;
  screenShareProducerId: string | null;
  screenShareAudioProducerId: string | null;
  isMuted: boolean;
  isCameraOff: boolean;
  isVideoAdaptivelyPaused: boolean;
  isHandRaised: boolean;
  isLeaving?: boolean;
  connectionStatus?: ParticipantConnectionStatus;
}

export interface AudioAnalyserEntry {
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
  source: MediaStreamAudioSourceNode;
  streamId: string;
}

export interface ProducerInfo {
  producerId: string;
  producerUserId: string;
  kind: "audio" | "video";
  type: ProducerType;
  paused?: boolean;
  roomId?: string;
}

export interface DisplayNameSnapshotEntry {
  userId: string;
  displayName: string;
}

export type VideoQuality = "low" | "standard";

export type WebcamReceiverCapacityProofBasis =
  | "simulcast-full-layer"
  | "single-layer-transition"
  | "single-layer";

export type WebcamReceiverCapacityProofReason =
  | "qualified"
  | "transition_grace"
  | "transition_timeout"
  | "transition_invalid"
  | "producer_missing"
  | "producer_not_current"
  | "producer_not_vp8_simulcast"
  | "producer_not_vp8_single_layer"
  | "producer_paused"
  | "producer_score_low"
  | "producer_replaced"
  | "owner_missing"
  | "owner_disconnected"
  | "receiver_count"
  | "receiver_observer"
  | "receiver_disconnected"
  | "consumer_count"
  | "consumer_missing"
  | "consumer_not_simulcast"
  | "consumer_not_simple"
  | "consumer_paused"
  | "consumer_not_full_layer"
  | "consumer_prefers_lower_layer"
  | "consumer_score_low"
  | "screen_share_active"
  | "room_quality_low"
  | "transport_disconnected"
  | "evaluation_error"
  | "producer_removed"
  | "room_closed";

export interface WebcamReceiverCapacityProofNotification {
  roomId: string;
  producerId: string;
  revision: number;
  eligible: boolean;
  validForMs: number;
  reason: WebcamReceiverCapacityProofReason;
  basis: WebcamReceiverCapacityProofBasis;
  replacementOffer?: {
    nonce: string;
    validForMs: number;
    target: "vp8-single-layer";
  };
  replacesProducerId?: string;
  transitionNonce?: string;
  maxSpatialLayer?: number;
  maxTemporalLayer?: number;
  currentSpatialLayer?: number;
  currentTemporalLayer?: number;
  score?: number;
}

export type WebcamCodecCapability =
  | "vp8"
  | "h264-cb"
  | "vp9-p0"
  | "vp9-p0-l2t1";

export interface ClientMediaCapabilities {
  webcam: {
    negotiationVersion: 3;
    receive: WebcamCodecCapability[];
    send: WebcamCodecCapability[];
    preferredBaseline?: "vp8" | "h264";
  };
}

export interface WebcamCodecPolicy {
  codec: "vp8" | "h264" | "vp9";
  mimeType: "video/VP8" | "video/H264" | "video/VP9";
  profileId?: 0;
  scalabilityMode?: "L2T1";
  epoch: number;
}

export interface JoinRoomResponse {
  roomId?: string;
  rtpCapabilities: RtpCapabilities;
  existingProducers: ProducerInfo[];
  activeSpeakerId?: string | null;
  displayNameSnapshot?: DisplayNameSnapshotEntry[];
  status?: "waiting" | "joined";
  hostUserId?: string | null;
  hostUserIds?: string[];
  isLocked?: boolean;
  isTtsDisabled?: boolean;
  isChatLocked?: boolean;
  isDmEnabled?: boolean;
  areImageAttachmentsEnabled?: boolean;
  isReactionsDisabled?: boolean;
  meetingRequiresInviteCode?: boolean;
  webinarRole?: "attendee" | "participant" | "host";
  isWebinarEnabled?: boolean;
  webinarLocked?: boolean;
  webinarRequiresInviteCode?: boolean;
  webinarAttendeeCount?: number;
  webinarMaxAttendees?: number;
  webcamCodecPolicy?: WebcamCodecPolicy;
}

export interface JoinRoomErrorResponse {
  error: string;
  roomId?: string;
  redirectInstanceId?: string;
  redirectUrl?: string;
}

export interface WebinarConfigSnapshot {
  enabled: boolean;
  publicAccess: boolean;
  locked: boolean;
  maxAttendees: number;
  attendeeCount: number;
  requiresInviteCode: boolean;
  linkSlug?: string | null;
  feedMode: "active-speaker";
}

export interface WebinarUpdateRequest {
  enabled?: boolean;
  publicAccess?: boolean;
  locked?: boolean;
  maxAttendees?: number;
  inviteCode?: string | null;
  linkSlug?: string | null;
}

export interface MeetingConfigSnapshot {
  requiresInviteCode: boolean;
}

export interface MeetingUpdateRequest {
  inviteCode?: string | null;
}

export interface WebinarLinkResponse {
  slug?: string;
  link: string;
  publicAccess: boolean;
  linkVersion: number;
}

export interface WebinarFeedChangedNotification {
  roomId: string;
  speakerUserId: string | null;
  producers: ProducerInfo[];
}

export interface ActiveSpeakerChangedNotification {
  roomId: string;
  userId: string | null;
}

export interface WebinarParticipantJoinedNotification {
  roomId: string;
  userId: string;
  displayName?: string;
}

export interface ServerRestartNotification {
  roomId?: string;
  message?: string;
  reconnecting?: boolean;
}

export interface TransportResponse {
  id: string;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
}

export interface RestartIceResponse {
  iceParameters: IceParameters;
}

export type ProducerTransportNetworkProfile =
  | "good"
  | "fair"
  | "poor"
  | "emergency";

export interface SetProducerTransportNetworkProfileRequest {
  transportId?: string;
  profile: ProducerTransportNetworkProfile;
}

export interface SetProducerTransportNetworkProfileResponse {
  success: true;
  transportId: string;
  profile: ProducerTransportNetworkProfile;
  maxIncomingBitrate: number;
}

export interface PlannedConsumerHandoffRequest {
  requestId: string;
  predecessorConsumerId: string;
}

export interface AbortConsumerHandoffRequest
  extends PlannedConsumerHandoffRequest {
  producerId: string;
}

export interface AbortConsumerHandoffResponse {
  success: true;
  requestId: string;
  status: "aborted" | "already_aborted" | "absent";
  successorConsumerId?: string;
  predecessorRestored: boolean;
}

export interface ConsumeResponse {
  id: string;
  producerId: string;
  kind: "audio" | "video";
  rtpParameters: RtpParameters;
  /**
   * Authoritative mediasoup consumer topology. Optional for compatibility with
   * older SFUs; clients must not infer simulcast-only behavior when absent.
   */
  consumerType?: "simple" | "simulcast" | "svc" | "pipe";
  /**
   * Server-side consumer paused state at creation. Audio consumers are
   * created unpaused (#177), so `paused: false` means no resumeConsumer
   * round-trip is needed. Absent on older servers.
  */
  paused?: boolean;
  /** Producer pause state from the same ordered consume acknowledgement. */
  producerPaused?: boolean;
  /** Echoed only for request-scoped native planned consumer handoffs. */
  plannedConsumerHandoffRequestId?: string;
}

export interface ProducerMapEntry {
  userId: string;
  kind: "audio" | "video";
  type: ProducerType;
}

export interface MediaState {
  hasAudioPermission: boolean;
  hasVideoPermission: boolean;
  permissionsReady?: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
}

export interface MeetError {
  code:
    | "PERMISSION_DENIED"
    | "CONNECTION_FAILED"
    | "MEDIA_ERROR"
    | "TRANSPORT_ERROR"
    | "UNKNOWN";
  message: string;
  recoverable: boolean;
}

export type {
  Consumer,
  DtlsParameters,
  IceCandidate,
  IceParameters,
  Producer,
  RtpCapabilities,
  RtpParameters,
  Transport,
};
