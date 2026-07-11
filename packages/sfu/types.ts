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
  webinarInviteCode?: string;
  meetingInviteCode?: string;
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
}

export interface JoinRoomErrorResponse {
  error: string;
  roomId?: string;
  redirectInstanceId?: string;
  redirectUrl?: string;
}

export interface ActiveSpeakerChangedNotification {
  roomId: string;
  userId: string | null;
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

export interface CloseConsumerData {
  consumerId: string;
}

export interface ConsumeResponse {
  id: string;
  producerId: string;
  kind: MediaKind;
  rtpParameters: RtpParameters;
  /**
   * Server-side consumer paused state at creation. Audio consumers are
   * created unpaused (#177), so `paused: false` tells the client no
   * resumeConsumer round-trip is needed. Absent on older servers.
   */
  paused?: boolean;
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

export interface SetConsumerPreferencesBatchData {
  updates: SetConsumerPreferencesData[];
}

export type SetConsumerPreferencesBatchItemResponse =
  | SetConsumerPreferencesResponse
  | {
      error: string;
      consumerId?: string;
    };

export interface SetConsumerPreferencesBatchResponse {
  success: boolean;
  results: SetConsumerPreferencesBatchItemResponse[];
}

export interface ProducerInfo {
  producerId: string;
  producerUserId: string;
  kind: MediaKind;
  type: "webcam" | "screen";
  paused?: boolean;
  roomId?: string;
}

export interface DisplayNameSnapshotEntry {
  userId: string;
  displayName: string;
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

export type ScheduledMeetingEmailNotificationStatus =
  | "not_configured"
  | "pending"
  | "sent"
  | "failed";

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
  source?: "manual" | "booking_link";
  eventTypeId?: string | null;
  attendeeName?: string | null;
  attendeeEmail?: string | null;
  attendeeNote?: string | null;
  attendeeTimeZone?: string | null;
  googleCalendarEventId?: string | null;
  calendarSyncStatus?: "not_required" | "pending" | "synced" | "failed";
  calendarSyncError?: string | null;
  emailNotificationStatus?: ScheduledMeetingEmailNotificationStatus;
  emailNotificationError?: string | null;
  emailNotificationSentAt?: number | null;
  emailReminderStatus?: ScheduledMeetingEmailNotificationStatus;
  emailReminderError?: string | null;
  emailReminderSentAt?: number | null;
}

export interface CreateScheduledMeetingRequest {
  title: string;
  scheduledStartAt: number;
  scheduledEndAt?: number;
  roomCode?: string;
  hostEmail?: string;
  hostName?: string;
  source?: "manual" | "booking_link";
  eventTypeId?: string;
  attendeeName?: string;
  attendeeEmail?: string;
  attendeeNote?: string;
  attendeeTimeZone?: string;
  googleCalendarEventId?: string;
  calendarSyncStatus?: "not_required" | "pending" | "synced" | "failed";
  calendarSyncError?: string | null;
  emailNotificationStatus?: ScheduledMeetingEmailNotificationStatus;
  emailNotificationError?: string | null;
  emailNotificationSentAt?: number | null;
  emailReminderStatus?: ScheduledMeetingEmailNotificationStatus;
  emailReminderError?: string | null;
  emailReminderSentAt?: number | null;
}

export interface UpdateScheduledMeetingRequest {
  title?: string;
  scheduledStartAt?: number;
  scheduledEndAt?: number;
  roomCode?: string;
  status?: ScheduledMeetingStatus;
  googleCalendarEventId?: string | null;
  calendarSyncStatus?: "not_required" | "pending" | "synced" | "failed";
  calendarSyncError?: string | null;
  emailNotificationStatus?: ScheduledMeetingEmailNotificationStatus;
  emailNotificationError?: string | null;
  emailNotificationSentAt?: number | null;
  emailReminderStatus?: ScheduledMeetingEmailNotificationStatus;
  emailReminderError?: string | null;
  emailReminderSentAt?: number | null;
}

export type SchedulingWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type SchedulingCalendarStatus =
  | "not_connected"
  | "connected"
  | "needs_reconnect"
  | "error";

export interface AvailabilityWindow {
  day: SchedulingWeekday;
  startMinutes: number;
  endMinutes: number;
}

export interface AvailabilityOverride {
  date: string;
  windows: Array<Omit<AvailabilityWindow, "day">>;
  unavailable?: boolean;
}

export interface WeeklyAvailability {
  timeZone: string;
  windows: AvailabilityWindow[];
  overrides: AvailabilityOverride[];
  updatedAt?: number;
}

export interface SchedulingProfile {
  id: string;
  clientId: string;
  userId: string;
  email: string;
  name: string;
  username: string;
  timeZone: string;
  createdAt: number;
  updatedAt: number;
}

export interface SchedulingEventType {
  id: string;
  clientId: string;
  profileId: string;
  userId: string;
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  minimumNoticeMinutes: number;
  bookingWindowDays: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  isActive: boolean;
  requiresCalendar: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SchedulingCalendarConnection {
  id: string;
  clientId: string;
  profileId: string;
  userId: string;
  provider: "google";
  status: SchedulingCalendarStatus;
  email: string | null;
  calendarId: string;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: number | null;
  scopes: string[];
  connectedAt: number;
  updatedAt: number;
  error: string | null;
}

export interface CalendarConnectionSummary {
  provider: "google";
  status: SchedulingCalendarStatus;
  email: string | null;
  calendarId: string;
  connectedAt: number | null;
  updatedAt: number | null;
  error: string | null;
}

export interface AvailableSlot {
  startAt: number;
  endAt: number;
  label: string;
}

export interface PublicSchedulingPage {
  profile: Pick<SchedulingProfile, "name" | "username" | "timeZone">;
  eventType: Pick<
    SchedulingEventType,
    | "id"
    | "slug"
    | "title"
    | "description"
    | "durationMinutes"
    | "minimumNoticeMinutes"
    | "bookingWindowDays"
  >;
  calendar: CalendarConnectionSummary;
}

export interface CreateBookingRequest {
  startAt: number;
  attendeeName: string;
  attendeeEmail: string;
  attendeeNote?: string;
  attendeeTimeZone?: string;
}

export interface BookingConfirmation {
  id: string;
  title: string;
  roomCode: string;
  meetingLink: string;
  startsAt: number;
  endsAt: number;
  hostName: string;
  attendeeName: string;
  attendeeEmail: string;
  calendarEventId: string | null;
  syncStatus: "not_required" | "pending" | "synced" | "failed";
  emailNotificationStatus: ScheduledMeetingEmailNotificationStatus;
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

export interface WebinarParticipantJoinedNotification {
  roomId: string;
  userId: string;
  displayName?: string;
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
  image?: ChatImageAttachment;
  isDirect?: boolean;
  dmTargetUserId?: string;
  dmTargetDisplayName?: string;
  replyTo?: ChatReplyPreview;
  /** Encrypted capability for the sender's consented cloned TTS voice. */
  ttsVoiceToken?: string;
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

export interface SendChatData {
  content?: string;
  gif?: ChatGifAttachment;
  image?: Pick<ChatImageAttachment, "id">;
  replyTo?: ChatReplyPreview;
  ttsVoiceToken?: string;
}

export interface ChatMessageNotification extends ChatMessage {}

export interface ChatHistorySnapshot {
  messages: ChatMessage[];
  roomId: string;
}

export type TranscriptSessionStatus =
  | "idle"
  | "starting"
  | "live"
  | "takeover_needed"
  | "stopping"
  | "error";

export interface TranscriptController {
  userId: string;
  displayName: string;
  connectionId: string;
  startedAt: number;
  lastSeenAt: number;
}

export type TranscriptOpenAiKeySource = "controller" | "global";

export type TranscriptTransportMode = "browser" | "sfu";

export type TranscriptSfuRelayStatus =
  | "available"
  | "disabled"
  | "unsupported"
  | "error";

export interface TranscriptSfuRelayStatusResponse {
  mode: "sfu";
  status: TranscriptSfuRelayStatus;
  available: boolean;
  reason?: string;
  updatedAt: number;
}

export interface TranscriptSfuRelayStartResponse {
  mode: "sfu";
  success: boolean;
  status: TranscriptSfuRelayStatus;
  reason?: string;
  updatedAt: number;
}

export interface TranscriptSfuRelayStartToken {
  token: string;
  expiresAt: number;
  automatic?: boolean;
}

export interface TranscriptSfuRelayStartRequest {
  relayStartToken: string;
}

export interface TranscriptSfuRelayStopResponse {
  success: boolean;
}

export interface TranscriptSessionState {
  roomId: string;
  status: TranscriptSessionStatus;
  controller: TranscriptController | null;
  transcriptModel: string;
  qaModel: string;
  transportMode: TranscriptTransportMode;
  keySource?: TranscriptOpenAiKeySource | null;
  startedAt: number | null;
  updatedAt: number;
  error?: string | null;
}

export type TranscriptAudioSource =
  | "local"
  | "remote"
  | "screen"
  | "mixed"
  | "unknown";

export interface TranscriptSpeaker {
  userId: string;
  displayName: string;
  source: TranscriptAudioSource;
}

export interface TranscriptSegment {
  id: string;
  itemId: string;
  sequence: number;
  speakerUserId: string;
  speakerDisplayName: string;
  source: TranscriptAudioSource;
  text: string;
  startMs: number;
  endMs: number | null;
  isFinal: boolean;
  updatedAt: number;
}

export interface TranscriptSegmentDelta {
  id: string;
  itemId: string;
  sequence: number;
  speaker: TranscriptSpeaker;
  text: string;
  delta: string;
  startMs: number;
  updatedAt: number;
}

export interface TranscriptMinutesEntry {
  id: string;
  text: string;
  speakerUserId?: string;
  speakerDisplayName?: string;
  owner?: string;
  due?: string;
}

export interface TranscriptMinutesSnapshot {
  summary: string;
  topics: TranscriptMinutesEntry[];
  decisions: TranscriptMinutesEntry[];
  actionItems: TranscriptMinutesEntry[];
  openQuestions: TranscriptMinutesEntry[];
  followUps: TranscriptMinutesEntry[];
  updatedAt: number;
  model: string;
}

export interface TranscriptQuestionRequest {
  id: string;
  question: string;
  model?: string;
}

export interface TranscriptQuestionResponse {
  id: string;
  question: string;
  answer: string;
  status: "streaming" | "done" | "error";
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface TranscriptTokenCapabilities {
  start: boolean;
  takeover: boolean;
  stop: boolean;
  ask: boolean;
  relayAudio?: boolean;
}

export interface TranscriptTokenResponse {
  roomId: string;
  workerUrl: string;
  token: string;
  expiresAt: number;
  capabilities: TranscriptTokenCapabilities;
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
