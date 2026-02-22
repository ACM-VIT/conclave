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
  webinarInviteCode?: string;
}

export interface JoinRoomResponse {
  roomId?: string;
  rtpCapabilities: RtpCapabilities;
  existingProducers: ProducerInfo[];
  status?: "waiting" | "joined";
  hostUserId?: string | null;
  isLocked?: boolean;
  isTtsDisabled?: boolean;
  webinarRole?: "attendee" | "participant" | "host";
  isWebinarEnabled?: boolean;
  webinarLocked?: boolean;
  webinarRequiresInviteCode?: boolean;
  webinarAttendeeCount?: number;
  webinarMaxAttendees?: number;
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
  maxWidth: 640,
  maxHeight: 360,
  maxFrameRate: 30,
  maxBitrate: 500000, // 500 kbps for 360p
} as const;

export const AUDIO_CONSTRAINTS = {
  maxBitrate: 64000, // 64 kbps for audio
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
