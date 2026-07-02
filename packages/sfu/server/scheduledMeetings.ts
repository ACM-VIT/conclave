import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
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
} from "./redisPersistence.js";
import { canonicalizeClientId } from "./clientIds.js";

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
};

export const createScheduledMeetingStore = (): ScheduledMeetingStore => ({
  byId: new Map(),
  byRoomCode: new Map(),
});

const roomCodeKey = (clientId: string, roomCode: string): string =>
  `${clientId}:${roomCode}`;

const registerStore = (
  store: ScheduledMeetingStore,
  meeting: ScheduledMeeting,
): void => {
  store.byId.set(meeting.id, meeting);
  store.byRoomCode.set(roomCodeKey(meeting.clientId, meeting.roomCode), meeting.id);
};

const unregisterStore = (
  store: ScheduledMeetingStore,
  meeting: ScheduledMeeting,
): void => {
  store.byId.delete(meeting.id);
  store.byRoomCode.delete(roomCodeKey(meeting.clientId, meeting.roomCode));
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
      const previousKey = roomCodeKey(meeting.clientId, meeting.roomCode);
      store.byRoomCode.delete(previousKey);
      meeting.roomCode = nextCode;
      store.byRoomCode.set(roomCodeKey(meeting.clientId, nextCode), meeting.id);
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
  store.byRoomCode.delete(roomCodeKey(meeting.clientId, meeting.roomCode));
  meeting.clientId = nextClientId;
  meeting.updatedAt = Date.now();
  store.byRoomCode.set(roomCodeKey(meeting.clientId, meeting.roomCode), meeting.id);
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

export type ScheduledMeetingPersistence = {
  save: (snapshot: ScheduledMeeting[]) => MaybePromise<void>;
  saveChanged?: (meetings: ScheduledMeeting[]) => MaybePromise<void>;
  deleteIds?: (ids: string[]) => MaybePromise<void>;
  reserveBookingSlot?: (
    reservation: BookingSlotReservation,
  ) => MaybePromise<BookingSlotLease | null>;
  claimEmailReminder?: (
    claim: EmailReminderClaim,
  ) => MaybePromise<ScheduledMeeting | null>;
  load: () => MaybePromise<ScheduledMeeting[]>;
  close?: () => MaybePromise<void>;
  flush?: () => Promise<void>;
};

export type BookingSlotReservation = {
  clientId: string;
  hostEmail: string;
  startAt: number;
  endAt: number;
};

export type BookingSlotLease = {
  release: () => MaybePromise<void>;
};

export type EmailReminderClaim = {
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

const writeJsonAtomic = (path: string, data: string): void => {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
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

export const createSqliteScheduledMeetingPersistence = (
  path: string = scheduledMeetingsSqlitePath(),
): ScheduledMeetingPersistence => {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
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
    CREATE UNIQUE INDEX IF NOT EXISTS scheduled_meetings_code_idx
      ON scheduled_meetings(client_id, room_code);
    CREATE INDEX IF NOT EXISTS scheduled_meetings_status_start_idx
      ON scheduled_meetings(status, scheduled_start_at);
  `);

  const insert = db.prepare(`
    INSERT INTO scheduled_meetings (
      id, client_id, room_code, status, scheduled_start_at,
      scheduled_end_at, updated_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      client_id = excluded.client_id,
      room_code = excluded.room_code,
      status = excluded.status,
      scheduled_start_at = excluded.scheduled_start_at,
      scheduled_end_at = excluded.scheduled_end_at,
      updated_at = excluded.updated_at,
      payload_json = excluded.payload_json
    WHERE excluded.updated_at >= scheduled_meetings.updated_at
  `);
  const loadRows = db.prepare(`
    SELECT payload_json
    FROM scheduled_meetings
    ORDER BY scheduled_start_at ASC, id ASC
  `);
  const deleteById = db.prepare("DELETE FROM scheduled_meetings WHERE id = ?");
  let knownIds = new Set<string>();

  const upsertMeeting = (meeting: ScheduledMeeting): void => {
    insert.run(
      meeting.id,
      meeting.clientId,
      meeting.roomCode,
      meeting.status,
      meeting.scheduledStartAt,
      meeting.scheduledEndAt,
      meeting.updatedAt,
      JSON.stringify(meeting),
    );
  };

  return {
    save: (snapshot) => {
      try {
        const snapshotIds = new Set(snapshot.map((meeting) => meeting.id));
        db.exec("BEGIN IMMEDIATE");
        for (const meeting of snapshot) {
          upsertMeeting(meeting);
        }
        for (const id of knownIds) {
          if (!snapshotIds.has(id)) {
            deleteById.run(id);
          }
        }
        db.exec("COMMIT");
        knownIds = snapshotIds;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        Logger.error("Failed to persist scheduled meetings", error);
      }
    },
    saveChanged: (meetings) => {
      if (meetings.length === 0) return;
      try {
        db.exec("BEGIN IMMEDIATE");
        for (const meeting of meetings) {
          upsertMeeting(meeting);
          knownIds.add(meeting.id);
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        Logger.error("Failed to persist changed scheduled meetings", error);
      }
    },
    deleteIds: (ids) => {
      if (ids.length === 0) return;
      try {
        db.exec("BEGIN IMMEDIATE");
        for (const id of ids) {
          deleteById.run(id);
          knownIds.delete(id);
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        Logger.error("Failed to delete scheduled meetings", error);
      }
    },
    load: () => {
      try {
        const meetings = loadRows
          .all()
          .map((row) => {
            const payload =
              row && typeof row === "object" && "payload_json" in row
                ? String((row).payload_json)
                : "";
            if (!payload) return null;
            return normalizeStoredMeeting(JSON.parse(payload));
          })
          .filter((entry): entry is ScheduledMeeting => Boolean(entry));
        knownIds = new Set(meetings.map((meeting) => meeting.id));
        return meetings;
      } catch (error) {
        Logger.error("Failed to load scheduled meetings", error);
        return [];
      }
    },
    close: () => db.close(),
  };
};

export const createFileScheduledMeetingPersistence = (
  path: string = scheduledMeetingsPath(),
): ScheduledMeetingPersistence => ({
  save: (snapshot) => {
    try {
      writeJsonAtomic(path, JSON.stringify(snapshot, null, 2));
    } catch (error) {
      Logger.error("Failed to persist scheduled meetings to JSON", error);
    }
  },
  load: () => {
    try {
      if (!existsSync(path)) return [];
      const raw = readFileSync(path, "utf8");
      const data: unknown = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data
        .map((entry) => normalizeStoredMeeting(entry))
        .filter((entry): entry is ScheduledMeeting => Boolean(entry));
    } catch (error) {
      Logger.error("Failed to load scheduled meetings from JSON", error);
      return [];
    }
  },
});

const RELEASE_BOOKING_SLOT_LOCK_SCRIPT = `
local key = KEYS[1]
local token = ARGV[1]
if redis.call("GET", key) == token then
  return redis.call("DEL", key)
end
return 0
`;

const CLAIM_EMAIL_REMINDER_SCRIPT = `
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
meeting["updatedAt"] = now

local nextPayload = cjson.encode(meeting)
redis.call("HSET", key, meetingId, nextPayload)
return nextPayload
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
  private fallback: ScheduledMeetingPersistence;
  private key: string;
  private keyPrefix: string;
  private startPromise: Promise<void> | null = null;
  private started = false;
  private pendingWrite: Promise<void> = Promise.resolve();
  private knownMeetings = new Map<string, ScheduledMeeting>();

  constructor(options: {
    redisUrl: string;
    keyPrefix: string;
    fallback: ScheduledMeetingPersistence;
  }) {
    this.client = createRedisPersistenceClient(
      "ScheduledMeetings",
      options.redisUrl,
    );
    this.fallback = options.fallback;
    this.keyPrefix = options.keyPrefix;
    this.key = `${options.keyPrefix}:scheduled-meetings`;
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

  save(snapshot: ScheduledMeeting[]): void {
    this.knownMeetings = new Map(snapshot.map((meeting) => [meeting.id, meeting]));
    void this.fallback.save(snapshot);
    const payload = snapshot.map((meeting) => [
      meeting.id,
      JSON.stringify(meeting),
    ] as const);
    this.queueWrite("save snapshot", async () => {
      const transaction = this.client.multi();
      transaction.del(this.key);
      if (payload.length > 0) {
        transaction.hSet(this.key, Object.fromEntries(payload));
      }
      await transaction.exec();
    });
  }

  saveChanged(meetings: ScheduledMeeting[]): void {
    if (meetings.length === 0) return;
    for (const meeting of meetings) {
      this.knownMeetings.set(meeting.id, meeting);
    }
    void this.fallback.save(Array.from(this.knownMeetings.values()));
    const payload = Object.fromEntries(
      meetings.map((meeting) => [meeting.id, JSON.stringify(meeting)]),
    );
    this.queueWrite("save changed meetings", async () => {
      await this.client.hSet(this.key, payload);
    });
  }

  deleteIds(ids: string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) {
      this.knownMeetings.delete(id);
    }
    void this.fallback.save(Array.from(this.knownMeetings.values()));
    this.queueWrite("delete meetings", async () => {
      await this.client.hDel(this.key, ids);
    });
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

  async claimEmailReminder(
    claim: EmailReminderClaim,
  ): Promise<ScheduledMeeting | null> {
    await this.start();
    const result = await this.client.sendCommand([
      "EVAL",
      CLAIM_EMAIL_REMINDER_SCRIPT,
      "1",
      this.key,
      claim.meetingId,
      String(claim.now),
      String(claim.leadMs),
    ]);
    if (typeof result !== "string" || !result) return null;
    const meeting = normalizeStoredMeeting(JSON.parse(result));
    if (!meeting) return null;
    this.knownMeetings.set(meeting.id, meeting);
    if (this.fallback.saveChanged) {
      await Promise.resolve(this.fallback.saveChanged([meeting]));
    } else {
      await Promise.resolve(
        this.fallback.save(Array.from(this.knownMeetings.values())),
      );
    }
    return meeting;
  }

  async load(): Promise<ScheduledMeeting[]> {
    try {
      await this.start();
      const values = await this.client.hVals(this.key);
      if (values.length > 0) {
        const meetings = values
          .map((value) => normalizeStoredMeeting(JSON.parse(value)))
          .filter((entry): entry is ScheduledMeeting => Boolean(entry));
        this.knownMeetings = new Map(
          meetings.map((meeting) => [meeting.id, meeting]),
        );
        return meetings;
      }

      const fallbackMeetings = await this.fallback.load();
      this.knownMeetings = new Map(
        fallbackMeetings.map((meeting) => [meeting.id, meeting]),
      );
      if (fallbackMeetings.length > 0) {
        this.save(fallbackMeetings);
        await this.flush();
        Logger.info(
          `Migrated ${fallbackMeetings.length} scheduled meeting(s) into Redis persistence`,
        );
      }
      return fallbackMeetings;
    } catch (error) {
      Logger.error(
        "Failed to load scheduled meetings from Redis; falling back to local persistence",
        error,
      );
      const fallbackMeetings = await this.fallback.load();
      this.knownMeetings = new Map(
        fallbackMeetings.map((meeting) => [meeting.id, meeting]),
      );
      return fallbackMeetings;
    }
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.fallback.close?.();
    if (!this.started) return;
    this.started = false;
    await this.client.quit();
  }

  private queueWrite(label: string, write: () => Promise<void>): void {
    const writePromise = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        await this.start();
        await write();
      });
    this.pendingWrite = writePromise.catch((error) => {
      Logger.error(`Failed to persist scheduled meetings to Redis (${label})`, error);
      throw error;
    });
  }
}

export const createRedisScheduledMeetingPersistence = (
  redisUrl: string = resolveRedisPersistenceUrl(),
  keyPrefix: string = resolveRedisPersistenceKeyPrefix(),
  fallback: ScheduledMeetingPersistence = createSqliteScheduledMeetingPersistence(),
): ScheduledMeetingPersistence =>
  new RedisScheduledMeetingPersistence({ redisUrl, keyPrefix, fallback });

const migrateJsonScheduledMeetingsToSqlite = (
  sqlite: ScheduledMeetingPersistence,
  json: ScheduledMeetingPersistence,
): number => {
  const existing = sqlite.load() as ScheduledMeeting[];
  if (existing.length > 0) return 0;

  const legacy = json.load() as ScheduledMeeting[];
  if (legacy.length === 0) return 0;

  void sqlite.save(legacy);
  return (sqlite.load() as ScheduledMeeting[]).length;
};

export const createScheduledMeetingPersistence = (): ScheduledMeetingPersistence => {
  const mode = process.env.SCHEDULED_MEETINGS_PERSISTENCE?.trim().toLowerCase();
  if (mode === "json" || mode === "file") {
    return createFileScheduledMeetingPersistence();
  }

  const jsonPersistence = createFileScheduledMeetingPersistence();
  const redisUrl = resolveRedisPersistenceUrl();

  try {
    const sqlitePersistence = createSqliteScheduledMeetingPersistence();
    const migrated = migrateJsonScheduledMeetingsToSqlite(
      sqlitePersistence,
      jsonPersistence,
    );
    if (migrated > 0) {
      Logger.info(
        `Migrated ${migrated} scheduled meeting(s) from JSON into SQLite`,
      );
    }
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
  } catch (error) {
    if (mode === "sqlite") {
      throw error;
    }
    Logger.warn(
      `SQLite scheduled-meeting persistence unavailable; falling back to JSON: ${(error as Error).message}`,
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
        jsonPersistence,
      );
    }
    return jsonPersistence;
  }
};

export const loadPersistedMeetings = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence,
): Promise<number> => Promise.resolve(persistence.load()).then((meetings) => {
  for (const meeting of meetings) {
    registerStore(store, meeting);
  }
  return meetings.length;
});

export const persistScheduledMeetings = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence,
): Promise<void> =>
  Promise.resolve(persistence.save(Array.from(store.byId.values()))).then(() =>
    persistence.flush?.(),
  );

export const persistScheduledMeetingChanges = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence,
  meetings: ScheduledMeeting[],
): Promise<void> => {
  if (meetings.length === 0) return Promise.resolve();
  if (persistence.saveChanged) {
    return Promise.resolve(persistence.saveChanged(meetings)).then(() =>
      persistence.flush?.(),
    );
  }
  return persistScheduledMeetings(store, persistence);
};

export const persistScheduledMeetingDeletes = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence,
  ids: string[],
): Promise<void> => {
  if (ids.length === 0) return Promise.resolve();
  if (persistence.deleteIds) {
    return Promise.resolve(persistence.deleteIds(ids)).then(() =>
      persistence.flush?.(),
    );
  }
  return persistScheduledMeetings(store, persistence);
};

export const advanceScheduledMeetings = (
  store: ScheduledMeetingStore,
  now = Date.now(),
): ScheduledMeeting[] => {
  const changed: ScheduledMeeting[] = [];
  for (const meeting of store.byId.values()) {
    if (meeting.status === "scheduled" && now >= meeting.scheduledStartAt) {
      meeting.status = "live";
      if (!meeting.startedAt) meeting.startedAt = now;
      meeting.updatedAt = now;
      changed.push(meeting);
    } else if (meeting.status === "live" && now >= meeting.scheduledEndAt) {
      meeting.status = "ended";
      if (!meeting.endedAt) meeting.endedAt = now;
      meeting.updatedAt = now;
      changed.push(meeting);
    }
  }
  return changed;
};
