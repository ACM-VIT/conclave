import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type {
  CreateScheduledMeetingRequest,
  ScheduledMeeting,
  ScheduledMeetingEmailNotificationStatus,
  ScheduledMeetingStatus,
  UpdateScheduledMeetingRequest,
} from "../types.js";
import { Logger } from "../utilities/loggers.js";
import {
  createRedisPersistenceClient,
  resolveRedisPersistenceKeyPrefix,
  resolveRedisPersistenceUrl,
  shouldUseRedisPersistence,
  type RedisPersistenceClient,
  isNotSeededError,
} from "./redisPersistence.js";
import { canonicalizeClientId } from "./clientIds.js";
import { assertSqliteWritable } from "./sqliteWriteCheck.js";
import { addMirrorVersionColumn } from "./sqliteMirrorVersion.js";
import { NEXT_VERSION_LUA } from "./redisCommitVersion.js";
import { describeEntry, importFallbackFiles, requireArray, requireRecord } from "./fallbackImport.js";
import { commitStampedJson, readStampedJson } from "./stampedJsonFile.js";
import { mergeNewestStamp } from "./stampedMerge.js";
import { assignInPlace, ChangedElsewhereError, commitStamp, committed, committedRecords, persistThenApply, sameStoredValue, serialized, targetIds, type ChangeTargets, type Committed } from "./persistThenApply.js";

type MaybePromise<T> = T | Promise<T>;

const MAX_TITLE_LENGTH = 140;
const MIN_TITLE_LENGTH = 1;
const ROOM_CODE_MIN_LENGTH = 3;
const ROOM_CODE_MAX_LENGTH = 64;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

const sanitizeTitle = (value: string | undefined): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.slice(0, MAX_TITLE_LENGTH);
};

const sanitizeRoomCode = (value: string | undefined): string => {
  if (typeof value !== "string") return "";
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.slice(0, ROOM_CODE_MAX_LENGTH);
};

const normalizeHostEmail = (value: string | undefined): string =>
  (value || "").trim().toLowerCase();

const sanitizeOptionalText = (
  value: string | undefined,
  maxLength: number,
): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  return normalized || null;
};

const sanitizeOptionalEmail = (value: string | undefined): string | null => {
  const normalized = normalizeHostEmail(value);
  if (!normalized || !normalized.includes("@")) return null;
  return normalized.slice(0, 320);
};

const normalizeEmailNotificationStatus = (
  value: unknown,
): ScheduledMeetingEmailNotificationStatus =>
  value === "pending" || value === "sent" || value === "failed"
    ? value
    : "not_configured";

const generateRoomCode = (): string => {
  const adjectives = [
    "swift",
    "lucid",
    "amber",
    "calm",
    "still",
    "bright",
    "quiet",
    "vivid",
  ];
  const nouns = [
    "river",
    "harbor",
    "ember",
    "thicket",
    "atrium",
    "summit",
    "meadow",
    "comet",
  ];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `${a}-${n}-${suffix}`;
};

export type ScheduledMeetingStore = {
  byId: Map<string, ScheduledMeeting>;
  byRoomCode: Map<string, string>;
  deletedAt: Map<string, number>;
};

export const createScheduledMeetingStore = (): ScheduledMeetingStore => ({
  byId: new Map(),
  byRoomCode: new Map(),
  deletedAt: new Map(),
});

const roomCodeKey = (clientId: string, roomCode: string): string =>
  `${clientId}:${roomCode}`;

const isActiveMeeting = (meeting: ScheduledMeeting): boolean =>
  meeting.status === "scheduled" || meeting.status === "live";

/**
 * Point the room-code index at `meeting`. A code can be reused once its
 * earlier meeting has ended or been cancelled, so several meetings can share
 * a code; the index keeps pointing at the active one.
 */
const claimRoomCode = (
  store: ScheduledMeetingStore,
  meeting: ScheduledMeeting,
): void => {
  const key = roomCodeKey(meeting.clientId, meeting.roomCode);
  const ownerId = store.byRoomCode.get(key);
  const owner = ownerId ? store.byId.get(ownerId) : undefined;
  if (
    owner &&
    owner.id !== meeting.id &&
    isActiveMeeting(owner) &&
    !isActiveMeeting(meeting)
  ) {
    return;
  }
  store.byRoomCode.set(key, meeting.id);
};

/** Drop `meeting`'s room-code entry, but never another meeting's. */
const releaseRoomCode = (
  store: ScheduledMeetingStore,
  meeting: ScheduledMeeting,
): void => {
  const key = roomCodeKey(meeting.clientId, meeting.roomCode);
  if (store.byRoomCode.get(key) === meeting.id) {
    store.byRoomCode.delete(key);
  }
};

const registerStore = (
  store: ScheduledMeetingStore,
  meeting: ScheduledMeeting,
): void => {
  store.byId.set(meeting.id, meeting);
  claimRoomCode(store, meeting);
};

const unregisterStore = (
  store: ScheduledMeetingStore,
  meeting: ScheduledMeeting,
): void => {
  store.byId.delete(meeting.id);
  releaseRoomCode(store, meeting);
};

const isCodeTaken = (
  store: ScheduledMeetingStore,
  clientId: string,
  roomCode: string,
  excludeId?: string,
): boolean => {
  const owner = store.byRoomCode.get(roomCodeKey(clientId, roomCode));
  if (!owner) return false;
  if (excludeId && owner === excludeId) return false;
  const existing = store.byId.get(owner);
  if (!existing) return false;
  return existing.status === "scheduled" || existing.status === "live";
};

type CreateScheduledMeetingOptions = {
  clientId: string;
  createdBy: string;
  defaultHostEmail: string;
  defaultHostName?: string;
  defaultHostUserId: string | null;
};

export const createScheduledMeeting = (
  store: ScheduledMeetingStore,
  request: CreateScheduledMeetingRequest,
  options: CreateScheduledMeetingOptions,
): ScheduledMeeting => {
  const clientId = canonicalizeClientId(options.clientId);
  const title = sanitizeTitle(request.title);
  if (!title || title.length < MIN_TITLE_LENGTH) {
    throw new Error("Title is required.");
  }

  const scheduledStartAt = Number(request.scheduledStartAt);
  if (!Number.isFinite(scheduledStartAt) || scheduledStartAt <= 0) {
    throw new Error("Invalid scheduled start time.");
  }
  const scheduledEndAt =
    Number.isFinite(Number(request.scheduledEndAt)) &&
    Number(request.scheduledEndAt) > scheduledStartAt
      ? Number(request.scheduledEndAt)
      : scheduledStartAt + DEFAULT_DURATION_MS;

  const requestedHostEmail = normalizeHostEmail(request.hostEmail);
  const requestHostEmailIsValid =
    requestedHostEmail.length > 0 && requestedHostEmail.includes("@");
  const fallbackHostEmail = normalizeHostEmail(options.defaultHostEmail);
  const hostEmail = requestHostEmailIsValid
    ? requestedHostEmail
    : fallbackHostEmail;
  if (!hostEmail || !hostEmail.includes("@")) {
    throw new Error("Host email is required.");
  }

  const hostName =
    sanitizeTitle(request.hostName) ||
    sanitizeTitle(options.defaultHostName) ||
    "";

  const requestedRoomCode = sanitizeRoomCode(request.roomCode);
  let roomCode = requestedRoomCode;
  if (!roomCode) {
    do {
      roomCode = generateRoomCode();
    } while (isCodeTaken(store, clientId, roomCode));
  } else {
    if (roomCode.length < ROOM_CODE_MIN_LENGTH) {
      throw new Error("Custom code must be at least 3 characters.");
    }
    if (isCodeTaken(store, clientId, roomCode)) {
      throw new Error(
        "That meeting code is already booked for another scheduled meeting.",
      );
    }
  }

  const now = Date.now();
  const meeting: ScheduledMeeting = {
    id: randomUUID(),
    clientId,
    roomCode,
    title,
    hostEmail,
    hostName,
    hostUserId: options.defaultHostUserId,
    scheduledStartAt,
    scheduledEndAt,
    status: "scheduled",
    startedAt: null,
    endedAt: null,
    createdAt: now,
    createdBy: options.createdBy,
    updatedAt: now,
    source: request.source === "booking_link" ? "booking_link" : "manual",
    eventTypeId: sanitizeOptionalText(request.eventTypeId, 128),
    attendeeName: sanitizeOptionalText(request.attendeeName, 120),
    attendeeEmail: sanitizeOptionalEmail(request.attendeeEmail),
    attendeeNote: sanitizeOptionalText(request.attendeeNote, 2000),
    attendeeTimeZone: sanitizeOptionalText(request.attendeeTimeZone, 80),
    googleCalendarEventId: sanitizeOptionalText(
      request.googleCalendarEventId,
      512,
    ),
    calendarSyncStatus: request.calendarSyncStatus ?? "not_required",
    calendarSyncError: sanitizeOptionalText(
      request.calendarSyncError ?? undefined,
      512,
    ),
    emailNotificationStatus: normalizeEmailNotificationStatus(
      request.emailNotificationStatus,
    ),
    emailNotificationError: sanitizeOptionalText(
      request.emailNotificationError ?? undefined,
      512,
    ),
    emailNotificationSentAt:
      Number.isFinite(Number(request.emailNotificationSentAt)) &&
      Number(request.emailNotificationSentAt) > 0
        ? Number(request.emailNotificationSentAt)
        : null,
    emailReminderStatus: normalizeEmailNotificationStatus(
      request.emailReminderStatus,
    ),
    emailReminderError: sanitizeOptionalText(
      request.emailReminderError ?? undefined,
      512,
    ),
    emailReminderSentAt:
      Number.isFinite(Number(request.emailReminderSentAt)) &&
      Number(request.emailReminderSentAt) > 0
        ? Number(request.emailReminderSentAt)
        : null,
  };

  registerStore(store, meeting);
  return meeting;
};

export const updateScheduledMeeting = (
  store: ScheduledMeetingStore,
  id: string,
  request: UpdateScheduledMeetingRequest,
): ScheduledMeeting => {
  const meeting = store.byId.get(id);
  if (!meeting) {
    throw new Error("Scheduled meeting not found.");
  }
  const now = Date.now();

  // Reactivating a meeting (scheduled or live) must not give a code two
  // active meetings. Checked before anything changes, against the code the
  // meeting will have after this update.
  if (request.status === "scheduled" || request.status === "live") {
    const requestedCode =
      typeof request.roomCode === "string"
        ? sanitizeRoomCode(request.roomCode)
        : "";
    const targetCode = requestedCode || meeting.roomCode;
    if (isCodeTaken(store, meeting.clientId, targetCode, meeting.id)) {
      throw new Error("That meeting code is already booked.");
    }
  }

  if (typeof request.title === "string") {
    const next = sanitizeTitle(request.title);
    if (!next) throw new Error("Title is required.");
    meeting.title = next;
  }
  if (
    typeof request.scheduledStartAt === "number" &&
    Number.isFinite(request.scheduledStartAt) &&
    request.scheduledStartAt > 0
  ) {
    meeting.scheduledStartAt = request.scheduledStartAt;
    if (meeting.scheduledEndAt <= meeting.scheduledStartAt) {
      meeting.scheduledEndAt = meeting.scheduledStartAt + DEFAULT_DURATION_MS;
    }
  }
  if (
    typeof request.scheduledEndAt === "number" &&
    Number.isFinite(request.scheduledEndAt) &&
    request.scheduledEndAt > meeting.scheduledStartAt
  ) {
    meeting.scheduledEndAt = request.scheduledEndAt;
  }
  if (typeof request.roomCode === "string") {
    const nextCode = sanitizeRoomCode(request.roomCode);
    if (nextCode && nextCode !== meeting.roomCode) {
      if (nextCode.length < ROOM_CODE_MIN_LENGTH) {
        throw new Error("Custom code must be at least 3 characters.");
      }
      if (isCodeTaken(store, meeting.clientId, nextCode, meeting.id)) {
        throw new Error("That meeting code is already booked.");
      }
      releaseRoomCode(store, meeting);
      meeting.roomCode = nextCode;
      claimRoomCode(store, meeting);
    }
  }
  if (request.status) {
    meeting.status = request.status;
    if (request.status === "live" && !meeting.startedAt) {
      meeting.startedAt = now;
    }
    if (request.status === "ended" && !meeting.endedAt) {
      meeting.endedAt = now;
    }
    // A reactivated meeting takes its code back from an inactive one.
    claimRoomCode(store, meeting);
  }
  if (request.googleCalendarEventId !== undefined) {
    meeting.googleCalendarEventId =
      request.googleCalendarEventId === null
        ? null
        : sanitizeOptionalText(request.googleCalendarEventId, 512);
  }
  if (request.calendarSyncStatus) {
    meeting.calendarSyncStatus = request.calendarSyncStatus;
  }
  if (request.calendarSyncError !== undefined) {
    meeting.calendarSyncError =
      request.calendarSyncError === null
        ? null
        : sanitizeOptionalText(request.calendarSyncError, 512);
  }
  if (request.emailNotificationStatus) {
    meeting.emailNotificationStatus = normalizeEmailNotificationStatus(
      request.emailNotificationStatus,
    );
  }
  if (request.emailNotificationError !== undefined) {
    meeting.emailNotificationError =
      request.emailNotificationError === null
        ? null
        : sanitizeOptionalText(request.emailNotificationError, 512);
  }
  if (request.emailNotificationSentAt !== undefined) {
    meeting.emailNotificationSentAt =
      request.emailNotificationSentAt === null
        ? null
        : Number.isFinite(Number(request.emailNotificationSentAt)) &&
            Number(request.emailNotificationSentAt) > 0
          ? Number(request.emailNotificationSentAt)
          : null;
  }
  if (request.emailReminderStatus) {
    meeting.emailReminderStatus = normalizeEmailNotificationStatus(
      request.emailReminderStatus,
    );
  }
  if (request.emailReminderError !== undefined) {
    meeting.emailReminderError =
      request.emailReminderError === null
        ? null
        : sanitizeOptionalText(request.emailReminderError, 512);
  }
  if (request.emailReminderSentAt !== undefined) {
    meeting.emailReminderSentAt =
      request.emailReminderSentAt === null
        ? null
        : Number.isFinite(Number(request.emailReminderSentAt)) &&
            Number(request.emailReminderSentAt) > 0
          ? Number(request.emailReminderSentAt)
          : null;
  }

  meeting.updatedAt = now;
  return meeting;
};

export const deleteScheduledMeeting = (
  store: ScheduledMeetingStore,
  id: string,
): ScheduledMeeting | null => {
  const meeting = store.byId.get(id);
  if (!meeting) return null;
  unregisterStore(store, meeting);
  store.deletedAt.set(id, Math.max(Date.now(), meeting.updatedAt + 1));
  return meeting;
};

export const getScheduledMeetingById = (
  store: ScheduledMeetingStore,
  id: string,
): ScheduledMeeting | null => store.byId.get(id) ?? null;

export const getScheduledMeetingByRoomCode = (
  store: ScheduledMeetingStore,
  clientId: string,
  roomCode: string,
): ScheduledMeeting | null => {
  const owner = store.byRoomCode.get(roomCodeKey(clientId, roomCode));
  return owner ? store.byId.get(owner) ?? null : null;
};

export const moveScheduledMeetingToClient = (
  store: ScheduledMeetingStore,
  meetingId: string,
  clientId: string,
): ScheduledMeeting | null => {
  const meeting = store.byId.get(meetingId);
  const nextClientId = canonicalizeClientId(clientId);
  if (!meeting || !nextClientId || meeting.clientId === nextClientId) {
    return meeting ?? null;
  }
  if (isCodeTaken(store, nextClientId, meeting.roomCode, meeting.id)) {
    throw new Error("That meeting code already exists in the target client.");
  }
  releaseRoomCode(store, meeting);
  meeting.clientId = nextClientId;
  meeting.updatedAt = Date.now();
  claimRoomCode(store, meeting);
  return meeting;
};

export const listScheduledMeetings = (
  store: ScheduledMeetingStore,
  filter: {
    clientId?: string;
    ownerEmail?: string;
    includeAll?: boolean;
    status?: ScheduledMeetingStatus[];
  },
): ScheduledMeeting[] => {
  const ownerEmail = filter.ownerEmail
    ? filter.ownerEmail.trim().toLowerCase()
    : undefined;
  const result: ScheduledMeeting[] = [];
  for (const meeting of store.byId.values()) {
    if (filter.clientId && meeting.clientId !== filter.clientId) continue;
    if (!filter.includeAll && ownerEmail && meeting.hostEmail !== ownerEmail) {
      continue;
    }
    if (filter.status && !filter.status.includes(meeting.status)) continue;
    result.push(meeting);
  }
  return result.sort((a, b) => a.scheduledStartAt - b.scheduledStartAt);
};

export type StoredMeetings = { records: ScheduledMeeting[]; deletedAt: Map<string, number> };
export type MeetingDeletion = { id: string; deletedAt: number };

/**
 * One store is the authority in each mode, with one commit point per change:
 * SQLite, the JSON file, or Redis. In Redis mode SQLite is only a mirror,
 * written after Redis commits and rebuilt from Redis whenever it may have
 * missed a change; memory is never loaded from it.
 */
export type MeetingCommit = { id: string; record: ScheduledMeeting | null; deletedAt: number | null };

export type CommittedMeetings = Committed<MeetingCommit[]>;

export type ScheduledMeetingPersistence = {
  saveChanged: (meetings: ScheduledMeeting[], deletions?: MeetingDeletion[]) => MaybePromise<CommittedMeetings>;
  importIfNewer: (meeting: ScheduledMeeting) => MaybePromise<boolean>;
  loadState: (options?: { strict?: boolean }) => MaybePromise<StoredMeetings>;
  reserveBookingSlot?: (
    reservation: BookingSlotReservation,
  ) => MaybePromise<BookingSlotLease | null>;
  claimEmailReminder?: (
    claim: EmailReminderClaim,
  ) => MaybePromise<ScheduledMeeting | null>;
  load: (options?: { strict?: boolean }) => MaybePromise<ScheduledMeeting[]>;
  close?: () => MaybePromise<void>;
  flush?: () => Promise<void>;
};

type BookingSlotReservation = {
  clientId: string;
  hostEmail: string;
  startAt: number;
  endAt: number;
};

export type BookingSlotLease = {
  release: () => MaybePromise<void>;
};

type EmailReminderClaim = {
  meetingId: string;
  now: number;
  leadMs: number;
};

const scheduledMeetingsSqlitePath = (): string => {
  const configured =
    process.env.SCHEDULED_MEETINGS_SQLITE_PATH?.trim() ||
    process.env.CONCLAVE_SQLITE_PATH?.trim();
  if (configured) return resolve(configured);
  const recordingStoragePath = process.env.RECORDING_STORAGE_PATH?.trim();
  if (recordingStoragePath) {
    return resolve(recordingStoragePath, "conclave.sqlite");
  }
  return resolve(process.cwd(), "data", "conclave.sqlite");
};

const scheduledMeetingsPath = (): string => {
  const configured = process.env.SCHEDULED_MEETINGS_PATH?.trim();
  if (configured) return resolve(configured);
  return resolve(process.cwd(), "data", "scheduled-meetings.json");
};

type SqliteStatement = {
  run: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

type SqliteDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

const loadNodeSqlite = (): {
  DatabaseSync: new (path: string) => SqliteDatabase;
} => {
  const require = createRequire(import.meta.url);
  return require("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
};

const normalizeStoredMeeting = (raw: unknown): ScheduledMeeting | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.clientId !== "string" || !record.clientId) return null;
  if (typeof record.roomCode !== "string" || !record.roomCode) return null;
  if (typeof record.hostEmail !== "string" || !record.hostEmail) return null;
  const scheduledStartAt = Number(record.scheduledStartAt);
  if (!Number.isFinite(scheduledStartAt)) return null;
  const scheduledEndAt = Number.isFinite(Number(record.scheduledEndAt))
    ? Number(record.scheduledEndAt)
    : scheduledStartAt + DEFAULT_DURATION_MS;
  const rawStatus = record.status;
  const status: ScheduledMeetingStatus =
    rawStatus === "live" ||
    rawStatus === "ended" ||
    rawStatus === "cancelled"
      ? rawStatus
      : "scheduled";
  const now = Date.now();
  return {
    id: record.id,
    clientId: canonicalizeClientId(record.clientId),
    roomCode: record.roomCode,
    title: typeof record.title === "string" ? record.title : "Scheduled meeting",
    hostEmail: record.hostEmail,
    hostName: typeof record.hostName === "string" ? record.hostName : "",
    hostUserId: typeof record.hostUserId === "string" ? record.hostUserId : null,
    scheduledStartAt,
    scheduledEndAt,
    status,
    startedAt: Number.isFinite(Number(record.startedAt))
      ? Number(record.startedAt)
      : null,
    endedAt: Number.isFinite(Number(record.endedAt)) ? Number(record.endedAt) : null,
    createdAt: Number.isFinite(Number(record.createdAt))
      ? Number(record.createdAt)
      : now,
    createdBy: typeof record.createdBy === "string" ? record.createdBy : record.hostEmail,
    updatedAt: Number.isFinite(Number(record.updatedAt))
      ? Number(record.updatedAt)
      : now,
    source: record.source === "booking_link" ? "booking_link" : "manual",
    eventTypeId:
      typeof record.eventTypeId === "string" ? record.eventTypeId : null,
    attendeeName:
      typeof record.attendeeName === "string" ? record.attendeeName : null,
    attendeeEmail:
      typeof record.attendeeEmail === "string" ? record.attendeeEmail : null,
    attendeeNote:
      typeof record.attendeeNote === "string" ? record.attendeeNote : null,
    attendeeTimeZone:
      typeof record.attendeeTimeZone === "string"
        ? record.attendeeTimeZone
        : null,
    googleCalendarEventId:
      typeof record.googleCalendarEventId === "string"
        ? record.googleCalendarEventId
        : null,
    calendarSyncStatus:
      record.calendarSyncStatus === "pending" ||
      record.calendarSyncStatus === "synced" ||
      record.calendarSyncStatus === "failed"
        ? record.calendarSyncStatus
        : "not_required",
    calendarSyncError:
      typeof record.calendarSyncError === "string"
        ? record.calendarSyncError
        : null,
    emailNotificationStatus: normalizeEmailNotificationStatus(
      record.emailNotificationStatus,
    ),
    emailNotificationError:
      typeof record.emailNotificationError === "string"
        ? record.emailNotificationError
        : null,
    emailNotificationSentAt: Number.isFinite(
      Number(record.emailNotificationSentAt),
    )
      ? Number(record.emailNotificationSentAt)
      : null,
    emailReminderStatus: normalizeEmailNotificationStatus(
      record.emailReminderStatus,
    ),
    emailReminderError:
      typeof record.emailReminderError === "string"
        ? record.emailReminderError
        : null,
    emailReminderSentAt: Number.isFinite(Number(record.emailReminderSentAt))
      ? Number(record.emailReminderSentAt)
      : null,
  };
};

type VersionedMeetings = { version: number; state: StoredMeetings };

export type MirroredMeeting = { id: string; payload: string | null; deletedAt: number | null };

export type MirroredMeetingChange = { version: number; meetings: MirroredMeeting[] };

type SqliteMeetingStore = ScheduledMeetingPersistence & {
  mirror: (change: MirroredMeetingChange) => Promise<void>;
  syncFrom: (authority: StoredMeetings, version: number) => Promise<void>;
};

export const createSqliteScheduledMeetingPersistence = (
  path: string = scheduledMeetingsSqlitePath(),
  legacyJsonPath?: string,
): SqliteMeetingStore => {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  assertSqliteWritable(db, path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_meetings (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      room_code TEXT NOT NULL,
      status TEXT NOT NULL,
      scheduled_start_at INTEGER NOT NULL,
      scheduled_end_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    -- Not unique: a code is reused once its earlier meeting has ended or
    -- been cancelled, and the store keeps both. The unique index made every
    -- save that held both fail, silently, for good.
    DROP INDEX IF EXISTS scheduled_meetings_code_idx;
    CREATE INDEX IF NOT EXISTS scheduled_meetings_client_code_idx
      ON scheduled_meetings(client_id, room_code);
    CREATE INDEX IF NOT EXISTS scheduled_meetings_status_start_idx
      ON scheduled_meetings(status, scheduled_start_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_meeting_tombstones (
      id TEXT PRIMARY KEY,
      deleted_at INTEGER NOT NULL
    );
  `);
  addMirrorVersionColumn(db, "scheduled_meetings");
  addMirrorVersionColumn(db, "scheduled_meeting_tombstones");

  const upsertSql = (guard: ">=" | ">") => `
    INSERT INTO scheduled_meetings (
      id, client_id, room_code, status, scheduled_start_at,
      scheduled_end_at, updated_at, payload_json
    )
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
    WHERE NOT EXISTS (
      SELECT 1 FROM scheduled_meeting_tombstones WHERE id = ?1 AND NOT (?7 ${guard} deleted_at)
    )
    ON CONFLICT(id) DO UPDATE SET
      client_id = excluded.client_id,
      room_code = excluded.room_code,
      status = excluded.status,
      scheduled_start_at = excluded.scheduled_start_at,
      scheduled_end_at = excluded.scheduled_end_at,
      updated_at = excluded.updated_at,
      payload_json = excluded.payload_json
    WHERE excluded.updated_at ${guard} scheduled_meetings.updated_at
  `;
  const insert = db.prepare(upsertSql(">="));
  const insertIfNewer = db.prepare(upsertSql(">"));
  const loadRows = db.prepare(`
    SELECT payload_json
    FROM scheduled_meetings
    ORDER BY scheduled_start_at ASC, id ASC
  `);
  const loadTombstones = db.prepare("SELECT id, deleted_at FROM scheduled_meeting_tombstones");
  const deleteOlder = db.prepare("DELETE FROM scheduled_meetings WHERE id = ? AND updated_at < ?");
  const markDeleted = db.prepare(`
    INSERT INTO scheduled_meeting_tombstones (id, deleted_at) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET
      deleted_at = MAX(scheduled_meeting_tombstones.deleted_at, excluded.deleted_at)
  `);

  const upsertMeeting = (meeting: ScheduledMeeting, statement = insert): boolean => {
    const result = statement.run(
      meeting.id,
      meeting.clientId,
      meeting.roomCode,
      meeting.status,
      meeting.scheduledStartAt,
      meeting.scheduledEndAt,
      meeting.updatedAt,
      JSON.stringify(meeting),
    ) as { changes: number | bigint };
    return Number(result.changes) > 0;
  };

  const inTransaction = (write: () => void): void => {
    try {
      db.exec("BEGIN IMMEDIATE");
      write();
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  };

  const loadStateSync = (options?: { strict?: boolean }): StoredMeetings => {
    try {
      db.exec("BEGIN");
      const rows = loadRows.all();
      const tombstones = loadTombstones.all() as Array<{ id: unknown; deleted_at: unknown }>;
      db.exec("COMMIT");
      const records = rows
        .map((row) => {
          const payload =
            row && typeof row === "object" && "payload_json" in row
              ? String((row).payload_json)
              : "";
          if (!payload) return null;
          return normalizeStoredMeeting(JSON.parse(payload));
        })
        .filter((entry): entry is ScheduledMeeting => Boolean(entry));
      return {
        records,
        deletedAt: new Map(tombstones.map((row) => [String(row.id), Number(row.deleted_at)])),
      };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      if (options?.strict) throw error;
      Logger.error("Failed to load scheduled meetings", error);
      return { records: [], deletedAt: new Map() };
    }
  };

  const current = loadStateSync();
  if (legacyJsonPath && current.records.length === 0 && current.deletedAt.size === 0) {
    const legacy = readMeetingsState(legacyJsonPath);
    if (legacy.records.length > 0 || legacy.deletedAt.size > 0) {
      inTransaction(() => {
        for (const meeting of legacy.records) upsertMeeting(meeting);
        for (const [id, deletedAt] of legacy.deletedAt) {
          deleteOlder.run(id, deletedAt);
          markDeleted.run(id, deletedAt);
        }
      });
      Logger.info(`Migrated ${legacy.records.length} scheduled meeting(s) and ${legacy.deletedAt.size} deletion(s) from JSON into SQLite`);
    }
  }

  const markDeletions = (deletions: MeetingDeletion[]): void => {
    for (const { id, deletedAt } of deletions) {
      deleteOlder.run(id, deletedAt);
      markDeleted.run(id, deletedAt);
    }
  };
  const mirrorUpsert = db.prepare(`
    INSERT INTO scheduled_meetings (
      id, client_id, room_code, status, scheduled_start_at,
      scheduled_end_at, updated_at, payload_json, mirror_version
    )
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
    WHERE NOT EXISTS (
      SELECT 1 FROM scheduled_meeting_tombstones WHERE id = ?1 AND mirror_version > ?9
    )
    ON CONFLICT(id) DO UPDATE SET
      client_id = excluded.client_id,
      room_code = excluded.room_code,
      status = excluded.status,
      scheduled_start_at = excluded.scheduled_start_at,
      scheduled_end_at = excluded.scheduled_end_at,
      updated_at = excluded.updated_at,
      payload_json = excluded.payload_json,
      mirror_version = excluded.mirror_version
    WHERE scheduled_meetings.mirror_version <= excluded.mirror_version
  `);
  const mirrorMark = db.prepare(`
    INSERT INTO scheduled_meeting_tombstones (id, deleted_at, mirror_version) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      deleted_at = excluded.deleted_at,
      mirror_version = excluded.mirror_version
    WHERE scheduled_meeting_tombstones.mirror_version <= excluded.mirror_version
  `);
  const mirrorRemove = db.prepare("DELETE FROM scheduled_meetings WHERE id = ? AND mirror_version <= ?");
  const mirrorRows = db.prepare("SELECT id, mirror_version FROM scheduled_meetings");
  const mirrorStamps = db.prepare("SELECT id, mirror_version FROM scheduled_meeting_tombstones");
  const dropRow = db.prepare("DELETE FROM scheduled_meetings WHERE id = ?");
  const dropStamp = db.prepare("DELETE FROM scheduled_meeting_tombstones WHERE id = ?");
  const mirrorMeetingPayload = (meeting: ScheduledMeeting, payload: string, version: number): void => {
    mirrorUpsert.run(
      meeting.id,
      meeting.clientId,
      meeting.roomCode,
      meeting.status,
      meeting.scheduledStartAt,
      meeting.scheduledEndAt,
      meeting.updatedAt,
      payload,
      version,
    );
  };
  const mirrorMeeting = (meeting: ScheduledMeeting, version: number): void =>
    mirrorMeetingPayload(meeting, JSON.stringify(meeting), version);

  const readRow = db.prepare("SELECT payload_json FROM scheduled_meetings WHERE id = ?");
  const readStamp = db.prepare("SELECT deleted_at FROM scheduled_meeting_tombstones WHERE id = ?");
  const mirrorDropStamp = db.prepare("DELETE FROM scheduled_meeting_tombstones WHERE id = ? AND mirror_version <= ?");
  const readCommitted = (id: string): MeetingCommit => {
    const row = readRow.all(id)[0] as { payload_json?: unknown } | undefined;
    const stamp = readStamp.all(id)[0] as { deleted_at?: unknown } | undefined;
    return {
      id,
      record: row ? normalizeStoredMeeting(JSON.parse(String(row.payload_json))) : null,
      deletedAt: stamp ? Number(stamp.deleted_at) : null,
    };
  };

  return {
    saveChanged: async (meetings, deletions = []) => {
      if (meetings.length === 0 && deletions.length === 0) return committed([]);
      let commits: MeetingCommit[] = [];
      inTransaction(() => {
        for (const meeting of meetings) upsertMeeting(meeting);
        markDeletions(deletions);
        commits = touchedIds(meetings, deletions).map(readCommitted);
      });
      return committed(commits);
    },
    importIfNewer: async (meeting) => upsertMeeting(meeting, insertIfNewer),
    mirror: async ({ version, meetings }) => {
      inTransaction(() => {
        for (const { id, payload, deletedAt } of meetings) {
          const record = payload === null ? null : normalizeStoredMeeting(JSON.parse(payload));
          if (record && payload !== null) mirrorMeetingPayload(record, payload, version);
          else mirrorRemove.run(id, version);
          if (deletedAt === null) mirrorDropStamp.run(id, version);
          else mirrorMark.run(id, deletedAt, version);
        }
      });
    },
    syncFrom: async (authority, version) => {
      inTransaction(() => {
        for (const meeting of authority.records) mirrorMeeting(meeting, version);
        for (const [id, deletedAt] of authority.deletedAt) mirrorMark.run(id, deletedAt, version);
        const live = new Set(authority.records.map((meeting) => meeting.id));
        for (const row of mirrorRows.all() as Array<{ id: unknown; mirror_version: unknown }>) {
          if (!live.has(String(row.id)) && Number(row.mirror_version) <= version) dropRow.run(String(row.id));
        }
        for (const row of mirrorStamps.all() as Array<{ id: unknown; mirror_version: unknown }>) {
          if (!authority.deletedAt.has(String(row.id)) && Number(row.mirror_version) <= version) dropStamp.run(String(row.id));
        }
      });
    },
    loadState: async (options) => loadStateSync(options),
    load: async (options) => loadStateSync(options).records,
    close: () => db.close(),
  };
};


const mirroredMeetingsFrom = (state: unknown[]): MirroredMeeting[] => {
  const meetings: MirroredMeeting[] = [];
  for (let index = 0; index < state.length; index += 3) {
    const [id, payload, deletedAt] = state.slice(index, index + 3);
    meetings.push({
      id: String(id),
      payload: typeof payload === "string" ? payload : null,
      deletedAt: deletedAt === null || deletedAt === undefined ? null : Number(deletedAt),
    });
  }
  return meetings;
};

const commitsOfMirrored = (meetings: MirroredMeeting[]): MeetingCommit[] =>
  meetings.map(({ id, payload, deletedAt }) => ({
    id,
    record: payload === null ? null : normalizeStoredMeeting(JSON.parse(payload)),
    deletedAt,
  }));

const touchedIds = (meetings: ScheduledMeeting[], deletions: MeetingDeletion[]): string[] => [
  ...new Set([...meetings.map((meeting) => meeting.id), ...deletions.map((deletion) => deletion.id)]),
];

const readMeetingsState = (path: string, options?: { strict?: boolean }): StoredMeetings => {
  try {
    return readStampedJson(path, normalizeStoredMeeting);
  } catch (error) {
    if (options?.strict) throw error;
    Logger.error("Failed to load scheduled meetings from JSON", error);
    return { records: [], deletedAt: new Map() };
  }
};

const createFileScheduledMeetingPersistence = (
  path: string = scheduledMeetingsPath(),
): ScheduledMeetingPersistence => ({
  saveChanged: async (meetings, deletions = []) =>
    committed(commitStampedJson(path, normalizeStoredMeeting, { upserts: meetings, deletions }).touched),
  importIfNewer: async (meeting) =>
    commitStampedJson(path, normalizeStoredMeeting, { upserts: [meeting], deletions: [] }, "newer").written > 0,
  loadState: async (options) => readMeetingsState(path, options),
  load: async (options) => readMeetingsState(path, options).records,
});

const RELEASE_BOOKING_SLOT_LOCK_SCRIPT = `
local key = KEYS[1]
local token = ARGV[1]
if redis.call("GET", key) == token then
  return redis.call("DEL", key)
end
return 0
`;

const CLAIM_EMAIL_REMINDER_SCRIPT = `${NEXT_VERSION_LUA}
local key = KEYS[1]
local meetingId = ARGV[1]
local now = tonumber(ARGV[2]) or 0
local leadMs = tonumber(ARGV[3]) or 0

if leadMs <= 0 then
  return nil
end

local payload = redis.call("HGET", key, meetingId)
if not payload then
  return nil
end

local ok, meeting = pcall(cjson.decode, payload)
if not ok or type(meeting) ~= "table" then
  return nil
end

if meeting["source"] ~= "booking_link" then
  return nil
end
if meeting["status"] ~= "scheduled" then
  return nil
end
if type(meeting["attendeeEmail"]) ~= "string" or meeting["attendeeEmail"] == "" then
  return nil
end

local reminderStatus = meeting["emailReminderStatus"]
if reminderStatus == "pending" or reminderStatus == "sent" or reminderStatus == "failed" then
  return nil
end

local scheduledStartAt = tonumber(meeting["scheduledStartAt"]) or 0
local createdAt = tonumber(meeting["createdAt"]) or 0
local reminderDueAt = scheduledStartAt - leadMs
if createdAt > reminderDueAt then
  return nil
end
if now < reminderDueAt or now >= scheduledStartAt then
  return nil
end

meeting["emailReminderStatus"] = "pending"
meeting["emailReminderError"] = cjson.null
meeting["emailReminderSentAt"] = cjson.null
meeting["updatedAt"] = math.max(tonumber(ARGV[4]) or now, (tonumber(meeting["updatedAt"]) or 0) + 1)

local nextPayload = cjson.encode(meeting)
redis.call("HSET", key, meetingId, nextPayload)
return { nextVersion(KEYS[2]), meetingId, nextPayload, redis.call("HGET", KEYS[3], meetingId) }
`;

const STORED_AT_LUA = `${NEXT_VERSION_LUA}
local function storedAt(hash, id)
  local current = redis.call("HGET", hash, id)
  if not current then return nil end
  local ok, stored = pcall(cjson.decode, current)
  if ok and type(stored) == "table" then return tonumber(stored["updatedAt"]) or 0 end
  return 0
end

local function markDeleted(hash, tombstones, id, deletedAt)
  local currentAt = storedAt(hash, id)
  local removed = 0
  if currentAt and currentAt < deletedAt then
    redis.call("HDEL", hash, id)
    removed = 1
  end
  local previous = tonumber(redis.call("HGET", tombstones, id) or "")
  if not previous or previous < deletedAt then redis.call("HSET", tombstones, id, deletedAt) end
  return removed
end


local function setIfNewer(hash, tombstones, id, updatedAt, payload, strict)
  local deletedAt = tonumber(redis.call("HGET", tombstones, id) or "")
  if deletedAt and (deletedAt > updatedAt or (strict and deletedAt == updatedAt)) then return 0 end
  local currentAt = storedAt(hash, id)
  if currentAt and (currentAt > updatedAt or (strict and currentAt == updatedAt)) then return 0 end
  redis.call("HSET", hash, id, payload)
  return 1
end
`;

const COMMITTED_LUA = `
local function committedState(hash, tombstones, ids)
  local state = {}
  for _, id in ipairs(ids) do
    state[#state + 1] = id
    state[#state + 1] = redis.call("HGET", hash, id)
    state[#state + 1] = redis.call("HGET", tombstones, id)
  end
  return state
end
`;

const SET_MEETING_IF_NEWER_SCRIPT = `${STORED_AT_LUA}${COMMITTED_LUA}
if redis.call("EXISTS", KEYS[3]) == 0 then return redis.error_reply("NOSEED the scheduled meetings store is not seeded") end
local applied = setIfNewer(KEYS[1], KEYS[2], ARGV[1], tonumber(ARGV[2]) or 0, ARGV[3], ARGV[4] == "newer")
local reply = committedState(KEYS[1], KEYS[2], { ARGV[1] })
table.insert(reply, 1, applied)
table.insert(reply, 1, nextVersion(KEYS[4]))
return reply
`;

const SAVE_MEETINGS_SCRIPT = `${STORED_AT_LUA}${COMMITTED_LUA}
if redis.call("EXISTS", KEYS[3]) == 0 then return redis.error_reply("NOSEED the scheduled meetings store is not seeded") end
local ids = {}
local seen = {}
local function touch(id)
  if not seen[id] then
    seen[id] = true
    ids[#ids + 1] = id
  end
end
local count = tonumber(ARGV[1]) or 0
local index = 2
for _ = 1, count do
  setIfNewer(KEYS[1], KEYS[2], ARGV[index], tonumber(ARGV[index + 1]) or 0, ARGV[index + 2], false)
  touch(ARGV[index])
  index = index + 3
end
while index <= #ARGV do
  markDeleted(KEYS[1], KEYS[2], ARGV[index], tonumber(ARGV[index + 1]) or 0)
  touch(ARGV[index])
  index = index + 2
end
local reply = committedState(KEYS[1], KEYS[2], ids)
table.insert(reply, 1, nextVersion(KEYS[4]))
return reply
`;

/**
 * Seeds an empty Redis from SQLite and marks it seeded, in one step. A Redis
 * that already holds meetings is the authority: it is only marked, never
 * topped up from SQLite, whose rows an older SFU may have left stale.
 */
const SEED_MEETINGS_SCRIPT = `${STORED_AT_LUA}
if redis.call("EXISTS", KEYS[3]) == 1 then return 0 end
if redis.call("HLEN", KEYS[1]) > 0 or redis.call("HLEN", KEYS[2]) > 0 then
  redis.call("SET", KEYS[3], "1")
  return 0
end
local count = tonumber(ARGV[1]) or 0
local index = 2
for _ = 1, count do
  setIfNewer(KEYS[1], KEYS[2], ARGV[index], tonumber(ARGV[index + 1]) or 0, ARGV[index + 2], false)
  index = index + 3
end
while index <= #ARGV do
  markDeleted(KEYS[1], KEYS[2], ARGV[index], tonumber(ARGV[index + 1]) or 0)
  index = index + 2
end
nextVersion(KEYS[4])
redis.call("SET", KEYS[3], "1")
return 1
`;

const bookingSlotLockTtlMs = (): number => {
  const parsed = Number(process.env.SFU_BOOKING_SLOT_LOCK_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 30000;
};

const bookingSlotLockKey = (
  keyPrefix: string,
  reservation: BookingSlotReservation,
): string => {
  const raw = [reservation.clientId, reservation.hostEmail.toLowerCase()].join("|");
  return `${keyPrefix}:booking-slot-lock:${Buffer.from(raw).toString("base64url")}`;
};

class RedisScheduledMeetingPersistence implements ScheduledMeetingPersistence {
  private client: RedisPersistenceClient;
  private mirror: SqliteMeetingStore;
  private mirrorStale = true;
  private key: string;
  private tombstonesKey: string;
  private seededKey: string;
  private versionKey: string;
  private keyPrefix: string;
  private startPromise: Promise<void> | null = null;
  private started = false;
  private pendingWrite: Promise<void> = Promise.resolve();
  private seeded: Promise<void> | null = null;

  constructor(options: {
    redisUrl: string;
    keyPrefix: string;
    mirror: SqliteMeetingStore;
  }) {
    this.client = createRedisPersistenceClient(
      "ScheduledMeetings",
      options.redisUrl,
    );
    this.mirror = options.mirror;
    this.keyPrefix = options.keyPrefix;
    this.key = `${options.keyPrefix}:scheduled-meetings`;
    this.tombstonesKey = `${options.keyPrefix}:scheduled-meetings:tombstones`;
    this.seededKey = `${options.keyPrefix}:scheduled-meetings:seeded`;
    this.versionKey = `${options.keyPrefix}:scheduled-meetings:version`;
    this.client.on("ready", () => {
      this.seeded = null;
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = (async () => {
      await this.client.connect();
      this.started = true;
      Logger.success("[ScheduledMeetings] Redis persistence connected");
    })();

    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  async saveChanged(meetings: ScheduledMeeting[], deletions: MeetingDeletion[] = []): Promise<CommittedMeetings> {
    if (meetings.length === 0 && deletions.length === 0) return committed([]);
    let commits: MeetingCommit[] = [];
    await this.queueWrite(async () => {
      const [version, ...state] = (await this.evalSeeded([
        "EVAL",
        SAVE_MEETINGS_SCRIPT,
        "4",
        this.key,
        this.tombstonesKey,
        this.seededKey,
        this.versionKey,
        String(meetings.length),
        ...meetings.flatMap((meeting) => [meeting.id, String(meeting.updatedAt), JSON.stringify(meeting)]),
        ...deletions.flatMap(({ id, deletedAt }) => [id, String(deletedAt)]),
      ])) as unknown[];
      const mirrored = mirroredMeetingsFrom(state);
      commits = commitsOfMirrored(mirrored);
      await this.updateMirror({ version: Number(version), meetings: mirrored });
    });
    return committed(commits);
  }

  async importIfNewer(meeting: ScheduledMeeting): Promise<boolean> {
    let applied = false;
    await this.queueWrite(async () => {
      const [version, outcome, ...state] = (await this.evalSeeded([
        "EVAL",
        SET_MEETING_IF_NEWER_SCRIPT,
        "4",
        this.key,
        this.tombstonesKey,
        this.seededKey,
        this.versionKey,
        meeting.id,
        String(meeting.updatedAt),
        JSON.stringify(meeting),
        "newer",
      ])) as unknown[];
      applied = Number(outcome) === 1;
      await this.updateMirror({ version: Number(version), meetings: mirroredMeetingsFrom(state) });
    });
    return applied;
  }

  async reserveBookingSlot(
    reservation: BookingSlotReservation,
  ): Promise<BookingSlotLease | null> {
    await this.start();
    const key = bookingSlotLockKey(this.keyPrefix, reservation);
    const token = randomUUID();
    const result = await this.client.sendCommand([
      "SET",
      key,
      token,
      "PX",
      String(bookingSlotLockTtlMs()),
      "NX",
    ]);
    if (String(result) !== "OK") return null;
    return {
      release: async () => {
        await this.client.sendCommand([
          "EVAL",
          RELEASE_BOOKING_SLOT_LOCK_SCRIPT,
          "1",
          key,
          token,
        ]);
      },
    };
  }

  /** Claims a due reminder in Redis, where the claim commits; the mirror follows. */
  async claimEmailReminder(
    claim: EmailReminderClaim,
  ): Promise<ScheduledMeeting | null> {
    let claimed: ScheduledMeeting | null = null;
    await this.queueWrite(async () => {
      const result = await this.client.sendCommand([
        "EVAL",
        CLAIM_EMAIL_REMINDER_SCRIPT,
        "3",
        this.key,
        this.versionKey,
        this.tombstonesKey,
        claim.meetingId,
        String(claim.now),
        String(claim.leadMs),
        String(Date.now()),
      ]);
      if (!Array.isArray(result)) return;
      const [version, ...state] = result as unknown[];
      const mirrored = mirroredMeetingsFrom(state);
      claimed = commitsOfMirrored(mirrored)[0]?.record ?? null;
      await this.updateMirror({ version: Number(version), meetings: mirrored });
    });
    return claimed;
  }

  /**
   * Reads the meetings from Redis, which holds them. A failed read fails: an
   * SFU never loads memory from the mirror, which can lag Redis.
   */
  async loadState(): Promise<StoredMeetings> {
    let authority: VersionedMeetings;
    try {
      await this.start();
      authority = await this.readAuthority();
    } catch (error) {
      throw new Error("Could not read scheduled meetings from Redis, which holds them; not loading the local mirror instead", { cause: error });
    }
    if (this.mirrorStale) await this.rebuildMirror(authority);
    return authority.state;
  }

  async load(): Promise<ScheduledMeeting[]> {
    return (await this.loadState()).records;
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.mirror.close?.();
    if (!this.started) return;
    this.started = false;
    await this.client.quit();
  }

  private async readAuthority(): Promise<VersionedMeetings> {
    let read = await this.readSeeded();
    if (!read) {
      this.seeded = null;
      read = await this.readSeeded();
    }
    if (!read) throw new Error("Redis lost its scheduled meetings while reseeding");
    const [values, tombstones, version] = read;
    return {
      version: Number(version ?? 0),
      state: {
        records: values
          .map((value) => normalizeStoredMeeting(JSON.parse(value)))
          .filter((entry): entry is ScheduledMeeting => Boolean(entry)),
        deletedAt: new Map(Object.entries(tombstones).map(([id, deletedAt]) => [id, Number(deletedAt)])),
      },
    };
  }

  private async updateMirror(change: MirroredMeetingChange): Promise<void> {
    if (this.mirrorStale) {
      await this.rebuildMirror();
      return;
    }
    try {
      await this.mirror.mirror(change);
    } catch (error) {
      this.mirrorStale = true;
      Logger.warn("[ScheduledMeetings] The SQLite mirror missed a change; it is rebuilt from Redis on the next write", error);
    }
  }

  private async rebuildMirror(read?: VersionedMeetings): Promise<void> {
    try {
      const authority = read ?? (await this.readAuthority());
      await this.mirror.syncFrom(authority.state, authority.version);
      this.mirrorStale = false;
    } catch (error) {
      this.mirrorStale = true;
      Logger.warn("[ScheduledMeetings] Could not rebuild the SQLite mirror from Redis; it is tried again on the next write", error);
    }
  }

  /** Runs before the first read or write, so nothing this SFU writes can make an empty Redis look established. */
  private async readSeeded(): Promise<[string[], Record<string, string>, string | null] | null> {
    await this.ensureSeeded();
    const [seeded, values, tombstones, version] = (await this.client
      .multi()
      .exists(this.seededKey)
      .hVals(this.key)
      .hGetAll(this.tombstonesKey)
      .get(this.versionKey)
      .exec()) as unknown as [number, string[], Record<string, string>, string | null];
    return Number(seeded) === 1 ? [values, tombstones, version] : null;
  }

  /** Runs a write script; if Redis lost its data since the seed, reseeds and retries once. */
  private async evalSeeded(command: string[]): Promise<unknown> {
    try {
      return await this.client.sendCommand(command);
    } catch (error) {
      if (!isNotSeededError(error)) throw error;
      this.seeded = null;
      await this.ensureSeeded();
      return this.client.sendCommand(command);
    }
  }

  private ensureSeeded(): Promise<void> {
    this.seeded ??= this.seed().catch((error: unknown) => {
      this.seeded = null;
      throw error;
    });
    return this.seeded;
  }

  private async seed(): Promise<void> {
    if (await this.client.exists(this.seededKey)) return;
    const local = await this.mirror.loadState({ strict: true });
    const seeded = await this.client.sendCommand([
      "EVAL",
      SEED_MEETINGS_SCRIPT,
      "4",
      this.key,
      this.tombstonesKey,
      this.seededKey,
      this.versionKey,
      String(local.records.length),
      ...local.records.flatMap((meeting) => [meeting.id, String(meeting.updatedAt), JSON.stringify(meeting)]),
      ...[...local.deletedAt].flatMap(([id, deletedAt]) => [id, String(deletedAt)]),
    ]);
    if (Number(seeded) === 1 && local.records.length > 0) {
      Logger.info(`Seeded Redis with ${local.records.length} scheduled meeting(s) from local persistence`);
    }
  }

  /** Writes in order; each caller gets its own write's result. */
  private queueWrite(write: () => Promise<void>): Promise<void> {
    const writePromise = this.pendingWrite.then(async () => {
      await this.start();
      await this.ensureSeeded();
      await write();
    });
    this.pendingWrite = writePromise.catch(() => undefined);
    return writePromise;
  }
}

export const createRedisScheduledMeetingPersistence = (
  redisUrl: string = resolveRedisPersistenceUrl(),
  keyPrefix: string = resolveRedisPersistenceKeyPrefix(),
  mirror: SqliteMeetingStore = createSqliteScheduledMeetingPersistence(),
): ScheduledMeetingPersistence =>
  new RedisScheduledMeetingPersistence({ redisUrl, keyPrefix, mirror });

export const createScheduledMeetingPersistence = (): ScheduledMeetingPersistence => {
  const mode = process.env.SCHEDULED_MEETINGS_PERSISTENCE?.trim().toLowerCase();
  if (mode === "json" || mode === "file") {
    return createFileScheduledMeetingPersistence();
  }

  const redisUrl = resolveRedisPersistenceUrl();
  const sqlitePersistence = createSqliteScheduledMeetingPersistence(
    scheduledMeetingsSqlitePath(),
    scheduledMeetingsPath(),
  );
  if (shouldUseRedisPersistence(mode, redisUrl)) {
    if (!redisUrl) {
      throw new Error(
        "SCHEDULED_MEETINGS_PERSISTENCE=redis requires SFU_PERSISTENCE_REDIS_URL, SFU_REDIS_URL, or REDIS_URL.",
      );
    }
    return createRedisScheduledMeetingPersistence(
      redisUrl,
      resolveRedisPersistenceKeyPrefix(),
      sqlitePersistence,
    );
  }
  return sqlitePersistence;
};

export const importFallbackMeetings = async (
  persistence: ScheduledMeetingPersistence,
): Promise<number> => {
  return importFallbackFiles({
    fileName: "scheduled-meetings.json",
    noun: "scheduled meeting",
    records: (data) => requireArray(data, "scheduled meetings"),
    describe: describeEntry("meeting"),
    importIfNewer: (entry) => persistence.importIfNewer(requireRecord(normalizeStoredMeeting(entry), "meeting")),
  });
};

/** Loads stored meetings into memory at startup, after any JSON fallback import, in the store's queue. */
export const loadPersistedMeetings = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence,
  options: { importFallback?: boolean } = {},
): Promise<number> =>
  serialized(store, async () => {
    if (options.importFallback) await importFallbackMeetings(persistence);
    const { records, deletedAt } = await persistence.loadState();
    for (const meeting of records) {
      registerStore(store, meeting);
    }
    for (const [id, at] of deletedAt) store.deletedAt.set(id, at);
    return records.length;
  });

/** Merges what storage holds into memory, newest stamp wins, in the store's queue. */
export const mergePersistedMeetings = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence,
): Promise<number> =>
  serialized(store, async () => {
    const stored = await persistence.loadState({ strict: true });
    return mergeNewestStamp(
      { values: store.byId, deletedAt: store.deletedAt },
      { values: new Map(stored.records.map((meeting) => [meeting.id, meeting])), deletedAt: stored.deletedAt },
      (meeting) => meeting.updatedAt,
      {
        set: (id, meeting) => {
          const held = store.byId.get(id);
          if (held) {
            unregisterStore(store, held);
            Object.assign(held, meeting);
          }
          registerStore(store, held ?? meeting);
          store.deletedAt.delete(id);
        },
        remove: (id, deletedAt) => {
          const held = store.byId.get(id);
          if (held) unregisterStore(store, held);
          store.deletedAt.set(id, deletedAt);
        },
      },
    );
  });

type MeetingPlan<R> = {
  result: R;
  upserts: ScheduledMeeting[];
  deletions: MeetingDeletion[];
};

const planMeetingChange = <R>(
  store: ScheduledMeetingStore,
  targets: ChangeTargets<ScheduledMeetingStore>,
  mutate: (draft: ScheduledMeetingStore, at: number) => R,
  at: number,
): MeetingPlan<R> => {
  const ids = targetIds(targets, store, at);
  const draft: ScheduledMeetingStore = {
    byId: new Map(store.byId),
    byRoomCode: new Map(store.byRoomCode),
    deletedAt: new Map(store.deletedAt),
  };
  for (const id of ids) {
    const held = store.byId.get(id);
    if (held) draft.byId.set(id, structuredClone(held));
  }
  const result = mutate(draft, at);
  const upserts = [...draft.byId].flatMap(([id, meeting]) => {
    const held = store.byId.get(id);
    if (held && sameStoredValue(held, meeting)) return [];
    meeting.updatedAt = commitStamp(at, held?.updatedAt);
    return [meeting];
  });
  const deletions = ids
    .filter((id) => store.byId.has(id) && !draft.byId.has(id))
    .map((id) => ({ id, deletedAt: commitStamp(at, store.byId.get(id)?.updatedAt) }));
  return { result, upserts, deletions };
};

const uncommittedMeetings = (plan: MeetingPlan<unknown>): CommittedMeetings =>
  committed([
    ...plan.upserts.map((meeting) => ({ id: meeting.id, record: meeting, deletedAt: null })),
    ...plan.deletions.map(({ id, deletedAt }) => ({ id, record: null, deletedAt })),
  ]);

const saveMeetingPlan = async (
  persistence: ScheduledMeetingPersistence | null,
  plan: MeetingPlan<unknown>,
): Promise<CommittedMeetings> => {
  if (plan.upserts.length === 0 && plan.deletions.length === 0) return committed([]);
  if (!persistence) return uncommittedMeetings(plan);
  const result = await persistence.saveChanged(plan.upserts, plan.deletions);
  await persistence.flush?.();
  return result;
};

export const adoptStoredMeeting = (store: ScheduledMeetingStore, meeting: ScheduledMeeting): ScheduledMeeting => {
  const held = store.byId.get(meeting.id);
  if (held) unregisterStore(store, held);
  const adopted = held ? assignInPlace(held, meeting) : meeting;
  registerStore(store, adopted);
  return adopted;
};

export const applyCommittedMeetings = (store: ScheduledMeetingStore, commits: CommittedMeetings): void => {
  for (const { id, record, deletedAt } of commits) {
    if (record) {
      adoptStoredMeeting(store, record);
    } else {
      const held = store.byId.get(id);
      if (held) unregisterStore(store, held);
    }
    if (deletedAt === null) store.deletedAt.delete(id);
    else store.deletedAt.set(id, deletedAt);
  }
};

export const changeMeetings = async <R>(
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence | null,
  ids: ChangeTargets<ScheduledMeetingStore>,
  mutate: (draft: ScheduledMeetingStore, at: number) => R,
): Promise<R> => {
  const plan = await persistThenApply(store, "scheduled meetings", {
    plan: (at) => planMeetingChange(store, ids, mutate, at),
    save: (planned) => saveMeetingPlan(persistence, planned),
    apply: (_planned, commits) => applyCommittedMeetings(store, commits),
  });
  if (plan.upserts.some((meeting) => !store.byId.has(meeting.id))) throw new ChangedElsewhereError("scheduled meeting");
  return committedRecords(store.byId, plan.result);
};

export const dueScheduledMeetingIds = (store: ScheduledMeetingStore, now = Date.now()): string[] =>
  [...store.byId.values()]
    .filter(
      (meeting) =>
        (meeting.status === "scheduled" && now >= meeting.scheduledStartAt) ||
        (meeting.status === "live" && now >= meeting.scheduledEndAt),
    )
    .map((meeting) => meeting.id);

export const advanceScheduledMeetings = (
  store: ScheduledMeetingStore,
  dueAt = Date.now(),
  at = dueAt,
): ScheduledMeeting[] => {
  const changed: ScheduledMeeting[] = [];
  for (const meeting of store.byId.values()) {
    if (meeting.status === "scheduled" && dueAt >= meeting.scheduledStartAt) {
      meeting.status = "live";
      if (!meeting.startedAt) meeting.startedAt = at;
      meeting.updatedAt = at;
      changed.push(meeting);
    } else if (meeting.status === "live" && dueAt >= meeting.scheduledEndAt) {
      meeting.status = "ended";
      if (!meeting.endedAt) meeting.endedAt = at;
      meeting.updatedAt = at;
      changed.push(meeting);
    }
  }
  return changed;
};
