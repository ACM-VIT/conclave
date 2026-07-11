export type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export type AdminUser = {
  id: string;
  email: string | null;
  name: string | null;
};

type ParticipantRole = "host" | "admin" | "participant" | "attendee";

type ParticipantProducer = {
  producerId: string;
  kind: "audio" | "video";
  type: "webcam" | "screen";
  paused: boolean;
};

type ConsumerTelemetry = {
  consumerId: string;
  producerId: string;
  producerUserId?: string;
  kind: "audio" | "video";
  type?: "webcam" | "screen";
  paused: boolean;
  producerPaused: boolean;
  priority: number;
  score?: { score?: number; producerScore?: number } | null;
  currentLayers?: { spatialLayer?: number; temporalLayer?: number } | null;
};

export type ParticipantSnapshot = {
  userId: string;
  userKey: string | null;
  displayName: string;
  role: ParticipantRole;
  mode: string;
  muted: boolean;
  cameraOff: boolean;
  producerTransportConnected: boolean;
  consumerTransportConnected: boolean;
  pendingDisconnect: boolean;
  producers: ParticipantProducer[];
  consumerCount: number;
  consumers?: ConsumerTelemetry[];
};

export type PendingUserSnapshot = {
  userId: string;
  participantUserId: string;
  userKey: string;
  displayName: string;
  socketId: string | null;
};

export type RoomPolicies = {
  locked: boolean;
  chatLocked: boolean;
  noGuests: boolean;
  ttsDisabled: boolean;
  dmEnabled: boolean;
  reactionsDisabled: boolean;
  requiresMeetingInviteCode: boolean;
};

export type RoomSnapshot = {
  id: string;
  channelId: string;
  clientId: string;
  hostUserId: string | null;
  adminUserIds: string[];
  screenShareProducerId: string | null;
  quality: "low" | "standard";
  appsState: {
    activeAppId: string | null;
    locked: boolean;
  };
  policies: RoomPolicies;
  access: {
    allowedUserKeys: string[];
    lockedAllowedUserKeys: string[];
    blockedUserKeys: string[];
  };
  counts: {
    participants: number;
    activeParticipants: number;
    admins: number;
    guests: number;
    webinarAttendees: number;
    pendingUsers: number;
    blockedUsers: number;
    producers: number;
    consumers: number;
  };
  participants: ParticipantSnapshot[];
  pendingUsers: PendingUserSnapshot[];
};

/** Lightweight rail entry pushed by the gateway for every active room. */
export type AdminRoomSummary = {
  channelId: string;
  roomId: string;
  clientId: string;
  participants: number;
  pending: number;
  admins: number;
  locked: boolean;
  screenShare: boolean;
  quality: "low" | "standard";
  activeAppId: string | null;
  activeGame: string | null;
};

/** Broadcast chat as stored by the room; DMs never enter this buffer. */
export type AdminChatMessage = {
  id: string;
  userId: string;
  displayName: string;
  content: string;
  timestamp: number;
  gif?: unknown;
};

export type TranscriptSpectatorToken = {
  workerUrl: string;
  token: string;
  expiresAt: number;
  roomId: string;
};

export type TranscriptSpectatorSegment = {
  id: string;
  itemId: string;
  sequence: number;
  speakerDisplayName: string;
  text: string;
  isFinal: boolean;
  updatedAt: number;
};

export type AdminScheduledItem = {
  kind: "meeting" | "webinar";
  id: string;
  title: string;
  clientId: string;
  roomId: string;
  /** Webinar link slug; meetings join by room code. */
  slug: string | null;
  status: string;
  startAt: number;
  endAt: number;
  host: string;
};

export type ClusterOverview = {
  instanceId: string;
  version: string;
  uptime: number;
  timestamp: string;
  draining: boolean;
  workers: {
    total: number;
    closed: number;
    healthy: number;
  };
  counts: {
    rooms: number;
    participants: number;
    pendingUsers: number;
    admins: number;
    webinarAttendees: number;
    producers: number;
    consumers: number;
  };
  roomsByClientId: Record<string, number>;
};

export type AdminActionInput = {
  label: string;
  path: string;
  method?: RequestMethod;
  body?: unknown;
  clientId?: string;
  /** Pool url of the SFU this command targets; validated by the proxy. */
  instanceUrl?: string;
};

export type AdminHistoryPoint = {
  at: number;
  rooms: number;
  participants: number;
  producers: number;
};

export type AdminEventType =
  | "room-opened"
  | "room-closed"
  | "user-joined"
  | "user-left"
  | "screen-started"
  | "screen-stopped"
  | "room-locked"
  | "room-unlocked"
  | "waiting";

type AdminEvent = {
  at: number;
  type: AdminEventType;
  roomId: string;
  channelId: string;
  message: string;
};

type AdminAuditEntry = {
  at: number;
  operator: string;
  method: string;
  path: string;
  ok: boolean;
};

type FindUserMatch = {
  channelId: string;
  roomId: string;
  clientId: string;
  userId: string;
  displayName: string;
  userKey: string | null;
  /** True when the person is in the waiting room, not the meeting. */
  waiting?: boolean;
};

/** One SFU in the pool, as tracked by the dashboard. */
export type InstanceStatus = {
  key: string;
  url: string;
  connection: ConnectionState;
  instanceId: string | null;
  overview: ClusterOverview | null;
};

export type TaggedRoomSummary = AdminRoomSummary & {
  instanceKey: string;
  instanceUrl: string;
};

export type TaggedAdminEvent = AdminEvent & { instanceKey: string };
export type TaggedAuditEntry = AdminAuditEntry & { instanceKey: string };
export type TaggedFindMatch = FindUserMatch & { instanceKey: string };
export type TaggedScheduledItem = AdminScheduledItem & { instanceKey: string };

export type RoomSelection = {
  instanceKey: string;
  channelId: string;
};
