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

export interface ChatMessage {
  id: string;
  userId: string;
  displayName: string;
  content: string;
  timestamp: number;
}

export interface ReactionNotification {
  userId: string;
  emoji?: string;
  kind?: ReactionKind;
  value?: string;
  label?: string;
  timestamp: number;
}

export interface HandRaisedNotification {
  userId: string;
  raised: boolean;
  timestamp: number;
}

export interface HandRaisedSnapshot {
  users: { userId: string; raised: boolean }[];
  roomId?: string;
}

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
  audioProducerId: string | null;
  videoProducerId: string | null;
  screenShareProducerId: string | null;
  isMuted: boolean;
  isCameraOff: boolean;
  isHandRaised: boolean;
  isGhost: boolean;
  isLeaving?: boolean;
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
}

export type VideoQuality = "low" | "standard";

export interface JoinRoomResponse {
  roomId?: string;
  rtpCapabilities: RtpCapabilities;
  existingProducers: ProducerInfo[];
  status?: "waiting" | "joined";
  hostUserId?: string | null;
  isLocked?: boolean;
  isTtsDisabled?: boolean;
  meetingRequiresInviteCode?: boolean;
  webinarRole?: "attendee" | "participant" | "host";
  isWebinarEnabled?: boolean;
  webinarLocked?: boolean;
  webinarRequiresInviteCode?: boolean;
  webinarAttendeeCount?: number;
  webinarMaxAttendees?: number;
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
  signedToken?: string;
  publicAccess: boolean;
  linkVersion: number;
}

export interface WebinarFeedChangedNotification {
  roomId: string;
  speakerUserId: string | null;
  producers: ProducerInfo[];
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
