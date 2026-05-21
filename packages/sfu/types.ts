import type {
  Router,
  Producer,
  Consumer,
  WebRtcTransport,
  RtpCapabilities,
  RtpParameters,
  MediaKind,
  DtlsParameters,
} from "mediasoup/types";
import type { Socket } from "socket.io";

// ============================================
// Client & Room Types
// ============================================

export interface RoomInfo {
  id: string;
  userCount: number;
}

export interface GetRoomsResponse {
  rooms: RoomInfo[];
}

export interface RedirectData {
  userId: string;
  newRoomId: string;
}

export interface ClientOptions {
  id: string;
  socket: Socket;
}

export interface RoomOptions {
  id: string;
  router: Router;
}

// ============================================
// Socket Event Payloads
// ============================================

export interface JoinRoomData {
  roomId: string;
  sessionId?: string;
  displayName?: string;
  ghost?: boolean;
  recorder?: boolean;
  webinarInviteCode?: string;
  meetingInviteCode?: string;
}

export interface JoinRoomResponse {
  roomId?: string;
  rtpCapabilities: RtpCapabilities;
  existingProducers: ProducerInfo[];
  status?: "waiting" | "joined";
  hostUserId?: string | null;
  hostUserIds?: string[];
  isLocked?: boolean;
  isTtsDisabled?: boolean;
  isDmEnabled?: boolean;
  meetingRequiresInviteCode?: boolean;
  webinarRole?: "attendee" | "participant" | "host";
  isWebinarEnabled?: boolean;
  webinarLocked?: boolean;
  webinarRequiresInviteCode?: boolean;
  webinarAttendeeCount?: number;
  webinarMaxAttendees?: number;
  recording?: {
    active: boolean;
    paused: boolean;
    startedAt: number | null;
  };
}

export interface CreateTransportResponse {
  id: string;
  iceParameters: object;
  iceCandidates: object[];
  dtlsParameters: DtlsParameters;
}

export interface ConnectTransportData {
  transportId: string;
  dtlsParameters: DtlsParameters;
}

export interface RestartIceData {
  transport: "producer" | "consumer";
  transportId?: string;
}

export interface RestartIceResponse {
  iceParameters: object;
}

export interface ProduceData {
  transportId: string;
  kind: MediaKind;
  rtpParameters: RtpParameters; // Using RtpParameters from mediasoup/types
  appData: { type: "webcam" | "screen"; paused?: boolean };
}

export interface ProduceResponse {
  producerId: string;
}

export interface ConsumeData {
  transportId?: string;
  producerId: string;
  rtpCapabilities: RtpCapabilities;
}

export interface ConsumeResponse {
  id: string;
  producerId: string;
  kind: MediaKind;
  rtpParameters: RtpParameters;
}

export interface ProducerInfo {
  producerId: string;
  producerUserId: string;
  kind: MediaKind;
  type: "webcam" | "screen";
  paused?: boolean;
}

export type WebinarFeedMode = "active-speaker";

export interface WebinarConfigSnapshot {
  enabled: boolean;
  publicAccess: boolean;
  locked: boolean;
  maxAttendees: number;
  attendeeCount: number;
  requiresInviteCode: boolean;
  linkSlug: string | null;
  feedMode: WebinarFeedMode;
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

export type RecordingTrackKind = "audio" | "video" | "screen";
export type RecordingTrackStatus = "active" | "ended" | "failed";

export interface RecordingTrackArtifact {
  id: string;
  trackKind: RecordingTrackKind;
  producerId: string;
  producerUserId: string;
  displayName: string | null;
  codec: string;
  container: "webm" | "mp4" | "m4a";
  filename: string;
  relativePath: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  byteSize: number;
  status: RecordingTrackStatus;
  errorMessage: string | null;
}

export type RecordingSessionStatus =
  | "idle"
  | "starting"
  | "active"
  | "paused"
  | "finalizing"
  | "completed"
  | "failed";

export interface RecordingCompositeArtifact {
  status: "pending" | "running" | "completed" | "failed";
  filename: string | null;
  relativePath: string | null;
  startedAt: number | null;
  completedAt: number | null;
  byteSize: number;
  errorMessage: string | null;
}

export interface RecordingSessionMetadata {
  id: string;
  roomId: string;
  clientId: string;
  scheduledWebinarId: string | null;
  status: RecordingSessionStatus;
  startedAt: number;
  endedAt: number | null;
  pausedDurationMs: number;
  startedBy: string;
  endedBy: string | null;
  totalBytes: number;
  resolution: { width: number; height: number } | null;
  audioBitrateKbps: number;
  videoBitrateKbps: number;
  tracks: RecordingTrackArtifact[];
  composite: RecordingCompositeArtifact | null;
  manifestPath: string;
  manifestRelativePath: string;
  storagePath: string;
  storageRelativePath: string;
  errorMessage: string | null;
  speakerTimeline: { at: number; userId: string | null }[];
}

export interface RecordingPublicState {
  active: boolean;
  paused: boolean;
  sessionId: string | null;
  startedAt: number | null;
  startedBy: string | null;
  trackCount: number;
}

export interface StartRecordingRequest {
  startedBy?: string;
  audioBitrateKbps?: number;
  videoBitrateKbps?: number;
  preferredVideoCodec?: "h264" | "vp8";
  composite?: boolean;
}

export type ScheduledWebinarStatus =
  | "scheduled"
  | "live"
  | "ended"
  | "cancelled";

export interface ScheduledWebinarCoHost {
  email: string;
  name?: string;
}

export interface ScheduledWebinar {
  id: string;
  clientId: string;
  roomId: string;
  linkSlug: string;
  title: string;
  description: string;
  hostEmail: string;
  hostName: string;
  hostUserId: string | null;
  coHosts: ScheduledWebinarCoHost[];
  scheduledStartAt: number;
  scheduledEndAt: number;
  status: ScheduledWebinarStatus;
  publicAccess: boolean;
  maxAttendees: number;
  requiresInviteCode: boolean;
  waitingRoomEnabled: boolean;
  earlyEntryMinutes: number;
  qaEnabled: boolean;
  recordingRequested: boolean;
  notes: string;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  liveStartedAt: number | null;
  endedAt: number | null;
  totalJoinCount: number;
  peakAttendeeCount: number;
  webinarLink: string;
  coHostInviteTokenHash: string | null;
  coHostInviteTokenCreatedAt: number | null;
}

export interface CreateScheduledWebinarRequest {
  title: string;
  description?: string;
  scheduledStartAt: number;
  scheduledEndAt?: number;
  hostEmail?: string;
  hostName?: string;
  coHosts?: ScheduledWebinarCoHost[];
  linkSlug?: string;
  publicAccess?: boolean;
  maxAttendees?: number;
  inviteCode?: string | null;
  waitingRoomEnabled?: boolean;
  earlyEntryMinutes?: number;
  qaEnabled?: boolean;
  recordingRequested?: boolean;
  notes?: string;
}

export interface UpdateScheduledWebinarRequest {
  title?: string;
  description?: string;
  scheduledStartAt?: number;
  scheduledEndAt?: number;
  hostEmail?: string;
  hostName?: string;
  coHosts?: ScheduledWebinarCoHost[];
  linkSlug?: string;
  publicAccess?: boolean;
  maxAttendees?: number;
  inviteCode?: string | null;
  waitingRoomEnabled?: boolean;
  earlyEntryMinutes?: number;
  qaEnabled?: boolean;
  recordingRequested?: boolean;
  notes?: string;
  status?: ScheduledWebinarStatus;
}

export interface WebinarLinkResponse {
  slug: string;
  link: string;
  publicAccess: boolean;
  linkVersion: number;
}

export interface WebinarFeedChangedNotification {
  roomId: string;
  speakerUserId: string | null;
  producers: ProducerInfo[];
}

export interface WebinarAttendeeCountChangedNotification {
  roomId: string;
  attendeeCount: number;
  maxAttendees: number;
}

export interface ToggleMediaData {
  producerId: string;
  paused: boolean;
}

export type VideoQuality = "low" | "standard";

export interface SetVideoQualityNotification {
  quality: VideoQuality;
}

export interface NewProducerNotification {
  producerId: string;
  producerUserId: string;
  kind: MediaKind;
  type: "webcam" | "screen";
}

export interface ProducerClosedNotification {
  producerId: string;
  producerUserId: string;
}

export interface UserJoinedNotification {
  userId: string;
}

export interface UserLeftNotification {
  userId: string;
}

// ============================================
// Chat Types
// ============================================

export interface ChatMessage {
  id: string;
  userId: string;
  displayName: string;
  content: string;
  timestamp: number;
  isDirect?: boolean;
  dmTargetUserId?: string;
  dmTargetDisplayName?: string;
}

export interface SendChatData {
  content: string;
}

export interface ChatMessageNotification extends ChatMessage {}

// ============================================
// Reactions
// ============================================

export interface SendReactionData {
  emoji?: string;
  kind?: "emoji" | "asset";
  value?: string;
  label?: string;
}

export interface ReactionNotification {
  userId: string;
  kind: "emoji" | "asset";
  value: string;
  label?: string;
  timestamp: number;
}

// ============================================
// Raise Hand
// ============================================

export interface SetHandRaisedData {
  raised: boolean;
}

export interface HandRaisedNotification {
  userId: string;
  raised: boolean;
  timestamp: number;
}

export interface HandRaisedSnapshot {
  users: { userId: string; raised: boolean }[];
}

// shared browser types

export interface LaunchBrowserData {
  url: string;
}

export interface LaunchBrowserResponse {
  success: boolean;
  noVncUrl?: string;
  error?: string;
}

export interface BrowserNavigateData {
  url: string;
}

export interface BrowserStateNotification {
  active: boolean;
  url?: string;
  noVncUrl?: string;
  controllerUserId?: string;
}

export interface BrowserClosedNotification {
  closedBy?: string;
}

// ============================================
// Apps (SDK) Types
// ============================================

export interface AppsState {
  activeAppId: string | null;
  locked: boolean;
}

export interface AppsOpenData {
  appId: string;
  options?: Record<string, unknown>;
}

export interface AppsOpenResponse {
  success: boolean;
  activeAppId?: string;
  error?: string;
}

export interface AppsCloseResponse {
  success: boolean;
  error?: string;
}

export interface AppsLockData {
  locked: boolean;
}

export interface AppsLockResponse {
  success: boolean;
  locked?: boolean;
  error?: string;
}

export interface AppsSyncData {
  appId: string;
  syncMessage: Uint8Array;
}

export interface AppsSyncResponse {
  syncMessage: Uint8Array;
  stateVector?: Uint8Array;
  awarenessUpdate?: Uint8Array;
}

export interface AppsUpdateData {
  appId: string;
  update: Uint8Array;
}

export interface AppsAwarenessData {
  appId: string;
  awarenessUpdate: Uint8Array;
  clientId?: number;
}

// ============================================
// Media Constraints
// ============================================

export const VIDEO_CONSTRAINTS = {
  maxWidth: 1920,
  maxHeight: 1080,
  maxFrameRate: 30,
  maxBitrate: 5000000,
} as const;

export const AUDIO_CONSTRAINTS = {
  maxBitrate: 192000,
} as const;

// ============================================
// Re-exports for convenience
// ============================================

export type {
  Router,
  Producer,
  Consumer,
  WebRtcTransport,
  RtpCapabilities,
  RtpParameters,
  MediaKind,
  DtlsParameters,
};
