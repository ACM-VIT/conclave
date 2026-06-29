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
  isDirect?: boolean;
  dmTargetUserId?: string;
  dmTargetDisplayName?: string;
  replyTo?: ChatReplyPreview;
}

export interface ChatReplyPreview {
  id: string;
  userId: string;
  displayName: string;
  content: string;
  hasGif?: boolean;
  isDirect?: boolean;
  dmTargetUserId?: string;
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

export type {
  TranscriptAudioSource,
  TranscriptController,
  TranscriptMinutesEntry,
  TranscriptMinutesSnapshot,
  TranscriptOpenAiKeySource,
  TranscriptQuestionRequest,
  TranscriptQuestionResponse,
  TranscriptSegment,
  TranscriptSegmentDelta,
  TranscriptServiceVersion,
  TranscriptSessionState,
  TranscriptSessionStatus,
  TranscriptSpeaker,
  TranscriptTokenCapabilities,
  TranscriptTokenResponse,
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
  TranscriptReasoningEffort,
  TranscriptResponseModelConfig,
  TranscriptTextVerbosity,
  TranscriptTranscriptionModelConfig,
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
  isGhost: boolean;
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

export interface JoinRoomResponse {
  roomId?: string;
  rtpCapabilities: RtpCapabilities;
  existingProducers: ProducerInfo[];
  displayNameSnapshot?: DisplayNameSnapshotEntry[];
  status?: "waiting" | "joined";
  hostUserId?: string | null;
  hostUserIds?: string[];
  isLocked?: boolean;
  isTtsDisabled?: boolean;
  isChatLocked?: boolean;
  isDmEnabled?: boolean;
  isReactionsDisabled?: boolean;
  meetingRequiresInviteCode?: boolean;
  webinarRole?: "attendee" | "participant" | "host";
  isWebinarEnabled?: boolean;
  webinarLocked?: boolean;
  webinarRequiresInviteCode?: boolean;
  webinarAttendeeCount?: number;
  webinarMaxAttendees?: number;
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

export interface ConsumeResponse {
  id: string;
  producerId: string;
  kind: "audio" | "video";
  rtpParameters: RtpParameters;
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
