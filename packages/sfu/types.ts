import type {
  Router,
  Producer,
  Consumer,
  ConsumerLayers,
  ConsumerScore,
  WebRtcTransport,
  RtpCapabilities,
  RtpParameters,
  MediaKind,
  DtlsParameters,
} from "mediasoup/types";
import type { Socket } from "socket.io";

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

export interface RedirectNotification {
  roomId?: string;
  userId?: string;
  newRoomId: string;
}

export interface JoinDecisionNotification {
  roomId?: string;
}

export interface ClientOptions {
  id: string;
  socket: Socket;
}

export interface RoomOptions {
  id: string;
  router: Router;
}

export interface JoinRoomData {
  roomId: string;
  sessionId?: string;
  displayName?: string;
  ghost?: boolean;
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
  isChatLocked?: boolean;
  isDmEnabled?: boolean;
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
  rtpParameters: RtpParameters;
  appData: { type: "webcam" | "screen"; paused?: boolean };
}

export interface ProduceResponse {
  producerId: string;
}

export interface ConsumeData {
  transportId?: string;
  producerId: string;
  rtpCapabilities: RtpCapabilities;
  preferredLayers?: ConsumerLayerPreference;
  priority?: number;
}

export interface ConsumeResponse {
  id: string;
  producerId: string;
  kind: MediaKind;
  rtpParameters: RtpParameters;
  producerPaused?: boolean;
  score?: ConsumerScore;
  preferredLayers?: ConsumerLayerPreference;
  currentLayers?: ConsumerLayerPreference;
  priority?: number;
}

export type ConsumerLayerPreference = ConsumerLayers;

export interface SetConsumerPreferencesData {
  consumerId: string;
  preferredLayers?: ConsumerLayerPreference;
  priority?: number | null;
  paused?: boolean;
  requestKeyFrame?: boolean;
}

export interface SetConsumerPreferencesResponse {
  success: boolean;
  consumerId: string;
  producerId: string;
  paused: boolean;
  producerPaused: boolean;
  priority: number;
  preferredLayers?: ConsumerLayerPreference;
  currentLayers?: ConsumerLayerPreference;
}

export interface ProducerInfo {
  producerId: string;
  producerUserId: string;
  kind: MediaKind;
  type: "webcam" | "screen";
  paused?: boolean;
  roomId?: string;
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
  notes?: string;
  status?: ScheduledWebinarStatus;
}

export type ScheduledMeetingStatus =
  | "scheduled"
  | "live"
  | "ended"
  | "cancelled";

export interface ScheduledMeeting {
  id: string;
  clientId: string;
  roomCode: string;
  title: string;
  hostEmail: string;
  hostName: string;
  hostUserId: string | null;
  scheduledStartAt: number;
  scheduledEndAt: number;
  status: ScheduledMeetingStatus;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
}

export interface CreateScheduledMeetingRequest {
  title: string;
  scheduledStartAt: number;
  scheduledEndAt?: number;
  roomCode?: string;
  hostEmail?: string;
  hostName?: string;
}

export interface UpdateScheduledMeetingRequest {
  title?: string;
  scheduledStartAt?: number;
  scheduledEndAt?: number;
  roomCode?: string;
  status?: ScheduledMeetingStatus;
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
  roomId?: string;
}

export interface ConsumerTelemetryNotification {
  event:
    | "created"
    | "score"
    | "layerschange"
    | "preferences"
    | "pause"
    | "resume"
    | "producerpause"
    | "producerresume"
    | "closed";
  roomId: string;
  userId: string;
  consumerId: string;
  producerId: string;
  kind: MediaKind;
  score: ConsumerScore;
  paused: boolean;
  producerPaused: boolean;
  priority: number;
  preferredLayers?: ConsumerLayerPreference;
  currentLayers?: ConsumerLayerPreference;
  timestamp: number;
}

export interface NewProducerNotification {
  producerId: string;
  producerUserId: string;
  kind: MediaKind;
  type: "webcam" | "screen";
  paused?: boolean;
  roomId?: string;
}

export interface ProducerClosedNotification {
  producerId: string;
  producerUserId?: string;
  roomId?: string;
}

export interface UserJoinedNotification {
  userId: string;
  displayName?: string;
  isGhost?: boolean;
  roomId?: string;
}

export interface UserLeftNotification {
  userId: string;
  roomId?: string;
}

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

export interface ChatGifAttachment {
  id: string;
  title: string;
  url: string;
  previewUrl?: string;
  pageUrl?: string;
  width?: number;
  height?: number;
  source: "klipy";
}

export interface SendChatData {
  content?: string;
  gif?: ChatGifAttachment;
  replyTo?: ChatReplyPreview;
}

export interface ChatMessageNotification extends ChatMessage {}

export interface ChatHistorySnapshot {
  messages: ChatMessage[];
  roomId: string;
}

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
  roomId?: string;
}

export interface SetHandRaisedData {
  raised: boolean;
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
  roomId?: string;
}

export interface BrowserClosedNotification {
  closedBy?: string;
  roomId?: string;
}

export interface AppsState {
  activeAppId: string | null;
  locked: boolean;
  roomId?: string;
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

export type {
  Router,
  Producer,
  Consumer,
  ConsumerLayers,
  ConsumerScore,
  WebRtcTransport,
  RtpCapabilities,
  RtpParameters,
  MediaKind,
  DtlsParameters,
};
