import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type {
  CreateScheduledMeetingRequest,
  ScheduledMeeting,
  ScheduledMeetingStatus,
  UpdateScheduledMeetingRequest,
} from "../types.js";
import { Logger } from "../utilities/loggers.js";

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
    } while (isCodeTaken(store, options.clientId, roomCode));
  } else {
    if (roomCode.length < ROOM_CODE_MIN_LENGTH) {
      throw new Error("Custom code must be at least 3 characters.");
    }
    if (isCodeTaken(store, options.clientId, roomCode)) {
      throw new Error(
        "That meeting code is already booked for another scheduled meeting.",
      );
    }
  }

  const now = Date.now();
  const meeting: ScheduledMeeting = {
    id: randomUUID(),
    clientId: options.clientId,
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
  save: (snapshot: ScheduledMeeting[]) => void;
  load: () => ScheduledMeeting[];
  close?: () => void;
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

const normalizeStoredMeeting = (raw: any): ScheduledMeeting | null => {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.clientId !== "string" || !raw.clientId) return null;
  if (typeof raw.roomCode !== "string" || !raw.roomCode) return null;
  if (typeof raw.hostEmail !== "string" || !raw.hostEmail) return null;
  const scheduledStartAt = Number(raw.scheduledStartAt);
  if (!Number.isFinite(scheduledStartAt)) return null;
  const scheduledEndAt = Number.isFinite(Number(raw.scheduledEndAt))
    ? Number(raw.scheduledEndAt)
    : scheduledStartAt + DEFAULT_DURATION_MS;
  const status: ScheduledMeetingStatus =
    raw.status === "live" ||
    raw.status === "ended" ||
    raw.status === "cancelled"
      ? raw.status
      : "scheduled";
  const now = Date.now();
  return {
    id: raw.id,
    clientId: raw.clientId,
    roomCode: raw.roomCode,
    title: typeof raw.title === "string" ? raw.title : "Scheduled meeting",
    hostEmail: raw.hostEmail,
    hostName: typeof raw.hostName === "string" ? raw.hostName : "",
    hostUserId: typeof raw.hostUserId === "string" ? raw.hostUserId : null,
    scheduledStartAt,
    scheduledEndAt,
    status,
    startedAt: Number.isFinite(Number(raw.startedAt))
      ? Number(raw.startedAt)
      : null,
    endedAt: Number.isFinite(Number(raw.endedAt)) ? Number(raw.endedAt) : null,
    createdAt: Number.isFinite(Number(raw.createdAt))
      ? Number(raw.createdAt)
      : now,
    createdBy: typeof raw.createdBy === "string" ? raw.createdBy : raw.hostEmail,
    updatedAt: Number.isFinite(Number(raw.updatedAt))
      ? Number(raw.updatedAt)
      : now,
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

  return {
    save: (snapshot) => {
      try {
        const snapshotIds = new Set(snapshot.map((meeting) => meeting.id));
        db.exec("BEGIN IMMEDIATE");
        for (const meeting of snapshot) {
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
        } catch {
          // ignore rollback failures
        }
        Logger.error("Failed to persist scheduled meetings", error);
      }
    },
    load: () => {
      try {
        const meetings = loadRows
          .all()
          .map((row) => {
            const payload =
              row && typeof row === "object" && "payload_json" in row
                ? String((row as { payload_json: unknown }).payload_json)
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

export const loadPersistedMeetings = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence,
): number => {
  const meetings = persistence.load();
  for (const meeting of meetings) {
    registerStore(store, meeting);
  }
  return meetings.length;
};

export const persistScheduledMeetings = (
  store: ScheduledMeetingStore,
  persistence: ScheduledMeetingPersistence,
): void => {
  persistence.save(Array.from(store.byId.values()));
};

export const advanceScheduledMeetings = (
  store: ScheduledMeetingStore,
  now = Date.now(),
): number => {
  let changed = 0;
  for (const meeting of store.byId.values()) {
    if (meeting.status === "scheduled" && now >= meeting.scheduledStartAt) {
      meeting.status = "live";
      if (!meeting.startedAt) meeting.startedAt = now;
      meeting.updatedAt = now;
      changed += 1;
    } else if (meeting.status === "live" && now >= meeting.scheduledEndAt) {
      meeting.status = "ended";
      if (!meeting.endedAt) meeting.endedAt = now;
      meeting.updatedAt = now;
      changed += 1;
    }
  }
  return changed;
};
