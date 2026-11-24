import type {
  ScheduledMeeting,
  ScheduledWebinar,
  SchedulingCalendarConnection,
  SchedulingEventType,
  SchedulingProfile,
  WeeklyAvailability,
} from "../../types.js";

export type ProfileHours = {
  profileId: string;
  availability: WeeklyAvailability;
};

export type DataMap = {
  profile: SchedulingProfile;
  hours: ProfileHours;
  eventType: SchedulingEventType;
  calendar: SchedulingCalendarConnection;
  meeting: ScheduledMeeting;
  webinar: ScheduledWebinar;
};

export type DataKind = keyof DataMap;

export const DATA_KINDS: readonly DataKind[] = [
  "profile",
  "hours",
  "eventType",
  "calendar",
  "meeting",
  "webinar",
];

export type LegacyDomain = "scheduling" | "meetings" | "webinars";

export const LEGACY_DOMAINS: readonly LegacyDomain[] = ["scheduling", "meetings", "webinars"];

export const domainOf = (kind: DataKind): LegacyDomain =>
  kind === "meeting" ? "meetings" : kind === "webinar" ? "webinars" : "scheduling";

export type LegacyCopy = {
  key: string;
  kind: DataKind;
  id: string;
  hash: string;
  stamp: number;
};

export const LEGACY_IMPORT_ID = "legacy";

export type LegacyImportState = {
  id: typeof LEGACY_IMPORT_ID;
  ticket: number;
  sources: Partial<Record<LegacyDomain, string>>;
};

export const legacyCopyKey = (kind: DataKind, id: string): string => `${kind}:${id}`;

export type EntityMap = DataMap & {
  legacyCopy: LegacyCopy;
  legacyImport: LegacyImportState;
};

export type Kind = keyof EntityMap;

export const KINDS: readonly Kind[] = [...DATA_KINDS, "legacyCopy", "legacyImport"];

export type UniqueIndex =
  | "profileUser"
  | "profileUsername"
  | "eventSlug"
  | "meetingCode"
  | "webinarSlug"
  | "webinarRoom"
  | "cohostToken";

export type Stored<K extends Kind> = {
  rev: number;
  legacy: number | null;
  value: EntityMap[K];
};

export type RawStored = {
  rev: number;
  legacy: number | null;
  value: unknown;
};

export type FailureReason =
  | "conflict"
  | "not_found"
  | "duplicate"
  | "forbidden"
  | "invalid";

export type CommitFailure = {
  ok: false;
  reason: FailureReason;
  message?: string;
};

export type Outcome<T> = { ok: true; value: T } | CommitFailure;

export type CommitResult<T> = { ok: true; value: T; rev: number } | CommitFailure;

export const done = <T>(value: T): Outcome<T> => ({ ok: true, value });

export const fail = (reason: FailureReason, message?: string): CommitFailure =>
  message === undefined ? { ok: false, reason } : { ok: false, reason, message };

export class UniqueViolation extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Unique key ${key} is already taken.`);
    this.name = "UniqueViolation";
    this.key = key;
  }
}

export class InvalidInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInput";
  }
}

export class StoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreUnavailableError";
  }
}

export class StoreCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreCorruptionError";
  }
}

export const uniqueField = (index: UniqueIndex, key: string): string =>
  `${index}:${key}`;

export const uniqueKeys = {
  profileUser: (clientId: string, userId: string): string =>
    `${clientId}:${userId}`,
  profileUsername: (clientId: string, username: string): string =>
    `${clientId}:${username.toLowerCase()}`,
  eventSlug: (profileId: string, slug: string): string => `${profileId}:${slug}`,
  meetingCode: (clientId: string, roomCode: string): string =>
    `${clientId}:${roomCode}`,
  webinarSlug: (linkSlug: string): string => linkSlug,
  webinarRoom: (clientId: string, roomId: string): string =>
    `${clientId}:${roomId}`,
  cohostToken: (hash: string): string => hash,
};

export const tags = {
  activeMeetings: "active",
  meetingCode: (clientId: string, roomCode: string): string =>
    `code:${clientId}:${roomCode}`,
  profileEventTypes: (profileId: string): string => `profile:${profileId}`,
  openWebinars: "open",
};

export const isActiveMeeting = (meeting: ScheduledMeeting): boolean =>
  meeting.status === "scheduled" || meeting.status === "live";

export const isOpenWebinar = (webinar: ScheduledWebinar): boolean =>
  webinar.status === "scheduled" || webinar.status === "live";

export type Entropy = {
  uuid: () => string;
  bytes: (length: number) => Buffer;
  float: () => number;
};
