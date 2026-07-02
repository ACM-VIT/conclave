import { createHash, randomUUID, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type {
  CreateScheduledWebinarRequest,
  ScheduledWebinar,
  ScheduledWebinarCoHost,
  ScheduledWebinarStatus,
  UpdateScheduledWebinarRequest,
} from "../types.js";
import { Logger } from "../utilities/loggers.js";
import {
  DEFAULT_WEBINAR_MAX_ATTENDEES,
  MAX_WEBINAR_MAX_ATTENDEES,
  MIN_WEBINAR_MAX_ATTENDEES,
  getWebinarBaseUrl,
  hashWebinarInviteCode,
  normalizeWebinarLinkSlug,
  normalizeHostEmail,
} from "./webinar.js";
import { canonicalizeClientId } from "./clientIds.js";

const DEFAULT_EARLY_ENTRY_MINUTES = 10;
const MAX_EARLY_ENTRY_MINUTES = 240;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;
const MIN_TITLE_LENGTH = 1;
const MAX_TITLE_LENGTH = 140;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_NOTES_LENGTH = 4_000;
const MAX_CO_HOSTS = 25;

const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const RANDOM_SLUG_LENGTH = 8;
const CO_HOST_INVITE_TOKEN_BYTES = 32;

const sanitizeString = (
  value: unknown,
  options: { max: number; allowEmpty?: boolean } = { max: 0 },
): string => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!options.allowEmpty && !normalized) {
    return "";
  }
  return normalized.length > options.max
    ? normalized.slice(0, options.max)
    : normalized;
};

const sanitizeBoolean = (
  value: unknown,
  fallback: boolean,
): boolean => (typeof value === "boolean" ? value : fallback);

const sanitizeMaxAttendees = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return Math.max(
    MIN_WEBINAR_MAX_ATTENDEES,
    Math.min(MAX_WEBINAR_MAX_ATTENDEES, normalized),
  );
};

const sanitizeEarlyEntry = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(MAX_EARLY_ENTRY_MINUTES, Math.floor(value)));
};

const sanitizeCoHosts = (
  value: unknown,
): ScheduledWebinarCoHost[] => {
  if (!Array.isArray(value)) return [];
  const entries: readonly unknown[] = value;
  const seen = new Set<string>();
  const result: ScheduledWebinarCoHost[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const email = normalizeHostEmail(String(record.email ?? ""));
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    const name = sanitizeString(record.name, { max: 120, allowEmpty: true });
    result.push({ email, name: name || undefined });
    if (result.length >= MAX_CO_HOSTS) break;
  }
  return result;
};

const generateRandomSlug = (): string => {
  const bytes = randomBytes(RANDOM_SLUG_LENGTH);
  let out = "";
  for (let i = 0; i < RANDOM_SLUG_LENGTH; i += 1) {
    out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return out;
};

const generateCoHostInviteToken = (): string =>
  randomBytes(CO_HOST_INVITE_TOKEN_BYTES).toString("base64url");

const hashCoHostInviteToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const generateRoomId = (): string => {
  const bytes = randomBytes(4).toString("hex");
  return `sched-${bytes}`;
};

export type ScheduledWebinarStore = {
  byId: Map<string, ScheduledWebinar>;
  bySlug: Map<string, string>;
  byRoomChannel: Map<string, string>;
};

export const createScheduledWebinarStore = (): ScheduledWebinarStore => ({
  byId: new Map(),
  bySlug: new Map(),
  byRoomChannel: new Map(),
});

const roomChannelKey = (clientId: string, roomId: string): string =>
  `${clientId}:${roomId}`;

const isSlugTaken = (
  store: ScheduledWebinarStore,
  slug: string,
  excludeId?: string,
): boolean => {
  const owner = store.bySlug.get(slug);
  return Boolean(owner && owner !== excludeId);
};

const resolveLinkSlug = (
  store: ScheduledWebinarStore,
  requested: string | undefined,
  excludeId?: string,
): string => {
  if (requested) {
    const normalized = normalizeWebinarLinkSlug(requested);
    if (isSlugTaken(store, normalized, excludeId)) {
      throw new Error("That webinar link code is already in use.");
    }
    return normalized;
  }
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = generateRandomSlug();
    if (!isSlugTaken(store, candidate, excludeId)) {
      return candidate;
    }
  }
  throw new Error("Could not generate a unique webinar link.");
};

export const buildWebinarLink = (slug: string): string => {
  const base = getWebinarBaseUrl().replace(/\/$/, "");
  return `${base}/w/${encodeURIComponent(slug)}`;
};

const indexScheduledWebinar = (
  store: ScheduledWebinarStore,
  webinar: ScheduledWebinar,
): void => {
  store.byId.set(webinar.id, webinar);
  store.bySlug.set(webinar.linkSlug, webinar.id);
  store.byRoomChannel.set(
    roomChannelKey(webinar.clientId, webinar.roomId),
    webinar.id,
  );
};

const removeFromIndexes = (
  store: ScheduledWebinarStore,
  webinar: ScheduledWebinar,
): void => {
  store.byId.delete(webinar.id);
  if (store.bySlug.get(webinar.linkSlug) === webinar.id) {
    store.bySlug.delete(webinar.linkSlug);
  }
  const channel = roomChannelKey(webinar.clientId, webinar.roomId);
  if (store.byRoomChannel.get(channel) === webinar.id) {
    store.byRoomChannel.delete(channel);
  }
};

export const getScheduledWebinarById = (
  store: ScheduledWebinarStore,
  id: string,
): ScheduledWebinar | null => store.byId.get(id) ?? null;

export const getScheduledWebinarBySlug = (
  store: ScheduledWebinarStore,
  slug: string,
): ScheduledWebinar | null => {
  const id = store.bySlug.get(slug.trim().toLowerCase());
  return id ? store.byId.get(id) ?? null : null;
};

export const getScheduledWebinarForRoom = (
  store: ScheduledWebinarStore,
  clientId: string,
  roomId: string,
): ScheduledWebinar | null => {
  const id = store.byRoomChannel.get(roomChannelKey(clientId, roomId));
  return id ? store.byId.get(id) ?? null : null;
};

export const moveScheduledWebinarToClient = (
  store: ScheduledWebinarStore,
  webinarId: string,
  clientId: string,
): ScheduledWebinar | null => {
  const webinar = store.byId.get(webinarId);
  const nextClientId = canonicalizeClientId(clientId);
  if (!webinar || !nextClientId || webinar.clientId === nextClientId) {
    return webinar ?? null;
  }
  const nextRoomChannel = roomChannelKey(nextClientId, webinar.roomId);
  const owner = store.byRoomChannel.get(nextRoomChannel);
  if (owner && owner !== webinar.id) {
    throw new Error("That webinar room already exists in the target client.");
  }
  store.byRoomChannel.delete(roomChannelKey(webinar.clientId, webinar.roomId));
  webinar.clientId = nextClientId;
  webinar.updatedAt = Date.now();
  store.byRoomChannel.set(nextRoomChannel, webinar.id);
  return webinar;
};

export const listScheduledWebinars = (
  store: ScheduledWebinarStore,
  filter: {
    clientId?: string;
    ownerEmail?: string;
    includeAll?: boolean;
    status?: ScheduledWebinarStatus[];
  } = {},
): ScheduledWebinar[] => {
  const ownerEmail = filter.ownerEmail
    ? normalizeHostEmail(filter.ownerEmail)
    : null;
  const result: ScheduledWebinar[] = [];
  for (const webinar of store.byId.values()) {
    if (filter.clientId && webinar.clientId !== filter.clientId) continue;
    if (
      !filter.includeAll &&
      ownerEmail &&
      webinar.hostEmail !== ownerEmail &&
      !webinar.coHosts.some((entry) => entry.email === ownerEmail)
    ) {
      continue;
    }
    if (filter.status && !filter.status.includes(webinar.status)) {
      continue;
    }
    result.push(webinar);
  }
  return result.sort((a, b) => a.scheduledStartAt - b.scheduledStartAt);
};

export type ScheduledWebinarPersistence = {
  save: (snapshot: ScheduledWebinar[]) => void;
  saveChanged?: (webinars: ScheduledWebinar[]) => void;
  deleteIds?: (ids: string[]) => void;
  load: () => ScheduledWebinar[];
  close?: () => void;
};

const scheduledWebinarsPath = (): string => {
  const configured = process.env.SCHEDULED_WEBINARS_PATH?.trim();
  if (configured) return resolve(configured);
  return resolve(process.cwd(), "data", "scheduled-webinars.json");
};

const scheduledWebinarsSqlitePath = (): string => {
  const configured =
    process.env.SCHEDULED_WEBINARS_SQLITE_PATH?.trim() ||
    process.env.CONCLAVE_SQLITE_PATH?.trim();
  if (configured) return resolve(configured);

  const recordingStoragePath = process.env.RECORDING_STORAGE_PATH?.trim();
  if (recordingStoragePath) {
    return resolve(recordingStoragePath, "conclave.sqlite");
  }

  return resolve(process.cwd(), "data", "conclave.sqlite");
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

export const createFileScheduledWebinarPersistence = (
  path: string = scheduledWebinarsPath(),
): ScheduledWebinarPersistence => ({
  save: (snapshot) => {
    try {
      writeJsonAtomic(path, JSON.stringify(snapshot, null, 2));
    } catch (error) {
      Logger.error("Failed to persist scheduled webinars", error);
    }
  },
  load: () => {
    try {
      if (!existsSync(path)) return [];
      const raw = readFileSync(path, "utf8");
      const data: unknown = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data
        .map((entry) => normalizeStoredWebinar(entry))
        .filter((entry): entry is ScheduledWebinar => Boolean(entry));
    } catch (error) {
      Logger.error("Failed to load scheduled webinars", error);
      return [];
    }
  },
});

type SqliteStatement = {
  run: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

type SqliteDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

const loadNodeSqlite = (): { DatabaseSync: new (path: string) => SqliteDatabase } => {
  const require = createRequire(import.meta.url);
  return require("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
};

export const createSqliteScheduledWebinarPersistence = (
  path: string = scheduledWebinarsSqlitePath(),
): ScheduledWebinarPersistence => {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_webinars (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      link_slug TEXT NOT NULL,
      status TEXT NOT NULL,
      scheduled_start_at INTEGER NOT NULL,
      scheduled_end_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS scheduled_webinars_link_slug_idx
      ON scheduled_webinars(link_slug);
    CREATE INDEX IF NOT EXISTS scheduled_webinars_room_idx
      ON scheduled_webinars(client_id, room_id);
    CREATE INDEX IF NOT EXISTS scheduled_webinars_status_start_idx
      ON scheduled_webinars(status, scheduled_start_at);
  `);

  const insert = db.prepare(`
    INSERT INTO scheduled_webinars (
      id,
      client_id,
      room_id,
      link_slug,
      status,
      scheduled_start_at,
      scheduled_end_at,
      updated_at,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      client_id = excluded.client_id,
      room_id = excluded.room_id,
      link_slug = excluded.link_slug,
      status = excluded.status,
      scheduled_start_at = excluded.scheduled_start_at,
      scheduled_end_at = excluded.scheduled_end_at,
      updated_at = excluded.updated_at,
      payload_json = excluded.payload_json
    WHERE excluded.updated_at >= scheduled_webinars.updated_at
  `);
  const loadRows = db.prepare(`
    SELECT payload_json
    FROM scheduled_webinars
    ORDER BY scheduled_start_at ASC, id ASC
  `);
  const deleteById = db.prepare("DELETE FROM scheduled_webinars WHERE id = ?");
  let knownIds = new Set<string>();

  const upsertWebinar = (webinar: ScheduledWebinar): void => {
    insert.run(
      webinar.id,
      webinar.clientId,
      webinar.roomId,
      webinar.linkSlug,
      webinar.status,
      webinar.scheduledStartAt,
      webinar.scheduledEndAt,
      webinar.updatedAt,
      JSON.stringify(webinar),
    );
  };

  return {
    save: (snapshot) => {
      try {
        const snapshotIds = new Set(snapshot.map((webinar) => webinar.id));
        db.exec("BEGIN IMMEDIATE");
        for (const webinar of snapshot) {
          upsertWebinar(webinar);
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
        Logger.error("Failed to persist scheduled webinars to SQLite", error);
      }
    },
    saveChanged: (webinars) => {
      if (webinars.length === 0) return;
      try {
        db.exec("BEGIN IMMEDIATE");
        for (const webinar of webinars) {
          upsertWebinar(webinar);
          knownIds.add(webinar.id);
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        Logger.error("Failed to persist changed scheduled webinars", error);
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
        Logger.error("Failed to delete scheduled webinars", error);
      }
    },
    load: () => {
      try {
        const webinars = loadRows
          .all()
          .map((row) => {
            const payload =
              row && typeof row === "object" && "payload_json" in row
                ? String((row).payload_json)
                : "";
            if (!payload) return null;
            return normalizeStoredWebinar(JSON.parse(payload));
          })
          .filter((entry): entry is ScheduledWebinar => Boolean(entry));
        knownIds = new Set(webinars.map((webinar) => webinar.id));
        return webinars;
      } catch (error) {
        Logger.error("Failed to load scheduled webinars from SQLite", error);
        return [];
      }
    },
    close: () => db.close(),
  };
};

const migrateJsonScheduledWebinarsToSqlite = (
  sqlite: ScheduledWebinarPersistence,
  json: ScheduledWebinarPersistence,
): number => {
  const existing = sqlite.load();
  if (existing.length > 0) return 0;

  const legacy = json.load();
  if (legacy.length === 0) return 0;

  sqlite.save(legacy);
  return sqlite.load().length;
};

export const createScheduledWebinarPersistence = (): ScheduledWebinarPersistence => {
  const mode = process.env.SCHEDULED_WEBINARS_PERSISTENCE?.trim().toLowerCase();
  if (mode === "json" || mode === "file") {
    return createFileScheduledWebinarPersistence();
  }

  const jsonPersistence = createFileScheduledWebinarPersistence();

  try {
    const sqlitePersistence = createSqliteScheduledWebinarPersistence();
    const migrated = migrateJsonScheduledWebinarsToSqlite(
      sqlitePersistence,
      jsonPersistence,
    );
    if (migrated > 0) {
      Logger.info(
        `Migrated ${migrated} scheduled webinar(s) from JSON into SQLite`,
      );
    }
    return sqlitePersistence;
  } catch (error) {
    if (mode === "sqlite") {
      throw error;
    }
    Logger.warn(
      `SQLite scheduled-webinar persistence unavailable; falling back to JSON: ${(error as Error).message}`,
    );
    return jsonPersistence;
  }
};

const normalizeStoredWebinar = (raw: unknown): ScheduledWebinar | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.linkSlug !== "string" || !record.linkSlug) return null;
  if (typeof record.roomId !== "string" || !record.roomId) return null;
  if (typeof record.clientId !== "string" || !record.clientId) return null;
  const rawStatus = record.status;
  const status: ScheduledWebinarStatus =
    rawStatus === "live" || rawStatus === "ended" || rawStatus === "cancelled"
      ? rawStatus
      : "scheduled";
  const linkSlug = String(record.linkSlug);
  return {
    id: record.id,
    clientId: canonicalizeClientId(record.clientId),
    roomId: record.roomId,
    linkSlug,
    title: sanitizeString(record.title, { max: MAX_TITLE_LENGTH }) || "Untitled webinar",
    description: sanitizeString(record.description, {
      max: MAX_DESCRIPTION_LENGTH,
      allowEmpty: true,
    }),
    hostEmail: normalizeHostEmail(String(record.hostEmail ?? "")),
    hostName: sanitizeString(record.hostName, { max: 120, allowEmpty: true }),
    hostUserId: record.hostUserId ? String(record.hostUserId) : null,
    coHosts: sanitizeCoHosts(record.coHosts),
    scheduledStartAt: Number(record.scheduledStartAt) || Date.now(),
    scheduledEndAt:
      Number(record.scheduledEndAt) ||
      (Number(record.scheduledStartAt) || Date.now()) + DEFAULT_DURATION_MS,
    status,
    publicAccess: sanitizeBoolean(record.publicAccess, true),
    maxAttendees: sanitizeMaxAttendees(record.maxAttendees, DEFAULT_WEBINAR_MAX_ATTENDEES),
    requiresInviteCode: Boolean(record.requiresInviteCode),
    waitingRoomEnabled: sanitizeBoolean(record.waitingRoomEnabled, true),
    earlyEntryMinutes: sanitizeEarlyEntry(record.earlyEntryMinutes, DEFAULT_EARLY_ENTRY_MINUTES),
    qaEnabled: sanitizeBoolean(record.qaEnabled, true),
    notes: sanitizeString(record.notes, { max: MAX_NOTES_LENGTH, allowEmpty: true }),
    createdAt: Number(record.createdAt) || Date.now(),
    createdBy: String(record.createdBy ?? ""),
    updatedAt: Number(record.updatedAt) || Date.now(),
    liveStartedAt: record.liveStartedAt ? Number(record.liveStartedAt) : null,
    endedAt: record.endedAt ? Number(record.endedAt) : null,
    totalJoinCount: Number(record.totalJoinCount) || 0,
    peakAttendeeCount: Number(record.peakAttendeeCount) || 0,
    webinarLink: buildWebinarLink(linkSlug),
    coHostInviteTokenHash:
      typeof record.coHostInviteTokenHash === "string"
        ? record.coHostInviteTokenHash
        : null,
    coHostInviteTokenCreatedAt: record.coHostInviteTokenCreatedAt
      ? Number(record.coHostInviteTokenCreatedAt)
      : null,
  };
};

export const loadPersistedSchedules = (
  store: ScheduledWebinarStore,
  persistence: ScheduledWebinarPersistence,
): number => {
  const snapshot = persistence.load();
  for (const webinar of snapshot) {
    indexScheduledWebinar(store, webinar);
  }
  return snapshot.length;
};

export const persistScheduledWebinars = (
  store: ScheduledWebinarStore,
  persistence: ScheduledWebinarPersistence,
): void => {
  persistence.save(Array.from(store.byId.values()));
};

export const persistScheduledWebinarChanges = (
  store: ScheduledWebinarStore,
  persistence: ScheduledWebinarPersistence,
  webinars: ScheduledWebinar[],
): void => {
  if (webinars.length === 0) return;
  if (persistence.saveChanged) {
    persistence.saveChanged(webinars);
    return;
  }
  persistScheduledWebinars(store, persistence);
};

export const persistScheduledWebinarDeletes = (
  store: ScheduledWebinarStore,
  persistence: ScheduledWebinarPersistence,
  ids: string[],
): void => {
  if (ids.length === 0) return;
  if (persistence.deleteIds) {
    persistence.deleteIds(ids);
    return;
  }
  persistScheduledWebinars(store, persistence);
};

export type CreateScheduledWebinarOptions = {
  clientId: string;
  createdBy: string;
  defaultHostEmail?: string;
  defaultHostName?: string;
  defaultHostUserId?: string | null;
};

export const createScheduledWebinar = (
  store: ScheduledWebinarStore,
  request: CreateScheduledWebinarRequest,
  options: CreateScheduledWebinarOptions,
): { webinar: ScheduledWebinar; inviteCodeHash: string | null } => {
  const clientId = canonicalizeClientId(options.clientId);
  const title = sanitizeString(request.title, { max: MAX_TITLE_LENGTH });
  if (!title || title.length < MIN_TITLE_LENGTH) {
    throw new Error("Title is required.");
  }
  const description = sanitizeString(request.description, {
    max: MAX_DESCRIPTION_LENGTH,
    allowEmpty: true,
  });
  const notes = sanitizeString(request.notes, {
    max: MAX_NOTES_LENGTH,
    allowEmpty: true,
  });

  const scheduledStartAt = Number(request.scheduledStartAt);
  if (!Number.isFinite(scheduledStartAt) || scheduledStartAt <= 0) {
    throw new Error("Invalid scheduled start time.");
  }
  const scheduledEndAt =
    Number.isFinite(Number(request.scheduledEndAt)) &&
    Number(request.scheduledEndAt) > scheduledStartAt
      ? Number(request.scheduledEndAt)
      : scheduledStartAt + DEFAULT_DURATION_MS;

  const requestedHostEmail = normalizeHostEmail(request.hostEmail || "");
  const requestHostEmailIsValid =
    requestedHostEmail.length > 0 && requestedHostEmail.includes("@");
  const fallbackHostEmail = normalizeHostEmail(
    options.defaultHostEmail || "",
  );
  const hostEmail = requestHostEmailIsValid
    ? requestedHostEmail
    : fallbackHostEmail;
  if (!hostEmail || !hostEmail.includes("@")) {
    throw new Error("Host email is required.");
  }
  const hostName = sanitizeString(
    request.hostName || options.defaultHostName,
    { max: 120, allowEmpty: true },
  );

  const coHosts = sanitizeCoHosts(request.coHosts).filter(
    (entry) => entry.email !== hostEmail,
  );

  const linkSlug = resolveLinkSlug(store, request.linkSlug);

  const publicAccess = sanitizeBoolean(request.publicAccess, true);
  const maxAttendees = sanitizeMaxAttendees(
    request.maxAttendees,
    DEFAULT_WEBINAR_MAX_ATTENDEES,
  );
  const inviteCodeRaw =
    typeof request.inviteCode === "string" ? request.inviteCode.trim() : "";
  const inviteCodeHash = inviteCodeRaw
    ? hashWebinarInviteCode(inviteCodeRaw)
    : null;
  const waitingRoomEnabled = sanitizeBoolean(request.waitingRoomEnabled, true);
  const earlyEntryMinutes = sanitizeEarlyEntry(
    request.earlyEntryMinutes,
    DEFAULT_EARLY_ENTRY_MINUTES,
  );
  const qaEnabled = sanitizeBoolean(request.qaEnabled, true);

  const now = Date.now();
  const webinar: ScheduledWebinar = {
    id: randomUUID(),
    clientId,
    roomId: generateRoomId(),
    linkSlug,
    title,
    description,
    hostEmail,
    hostName,
    hostUserId: options.defaultHostUserId ?? null,
    coHosts,
    scheduledStartAt,
    scheduledEndAt,
    status: "scheduled",
    publicAccess,
    maxAttendees,
    requiresInviteCode: Boolean(inviteCodeHash),
    waitingRoomEnabled,
    earlyEntryMinutes,
    qaEnabled,
    notes,
    createdAt: now,
    createdBy: options.createdBy,
    updatedAt: now,
    liveStartedAt: null,
    endedAt: null,
    totalJoinCount: 0,
    peakAttendeeCount: 0,
    webinarLink: buildWebinarLink(linkSlug),
    coHostInviteTokenHash: null,
    coHostInviteTokenCreatedAt: null,
  };

  indexScheduledWebinar(store, webinar);
  return { webinar, inviteCodeHash };
};

export const updateScheduledWebinar = (
  store: ScheduledWebinarStore,
  id: string,
  patch: UpdateScheduledWebinarRequest,
): { webinar: ScheduledWebinar; inviteCodeHashChange: { value: string | null } | null } => {
  const existing = store.byId.get(id);
  if (!existing) {
    throw new Error("Scheduled webinar not found.");
  }
  if (existing.status === "ended" || existing.status === "cancelled") {
    throw new Error("This webinar has already concluded.");
  }

  let inviteCodeHashChange: { value: string | null } | null = null;
  let titleChanged = false;
  let linkSlugChanged = false;

  if (patch.title !== undefined) {
    const next = sanitizeString(patch.title, { max: MAX_TITLE_LENGTH });
    if (next) {
      existing.title = next;
      titleChanged = true;
    }
  }
  if (patch.description !== undefined) {
    existing.description = sanitizeString(patch.description, {
      max: MAX_DESCRIPTION_LENGTH,
      allowEmpty: true,
    });
  }
  if (patch.notes !== undefined) {
    existing.notes = sanitizeString(patch.notes, {
      max: MAX_NOTES_LENGTH,
      allowEmpty: true,
    });
  }
  if (typeof patch.scheduledStartAt === "number") {
    if (Number.isFinite(patch.scheduledStartAt) && patch.scheduledStartAt > 0) {
      existing.scheduledStartAt = patch.scheduledStartAt;
    }
  }
  if (typeof patch.scheduledEndAt === "number") {
    if (
      Number.isFinite(patch.scheduledEndAt) &&
      patch.scheduledEndAt > existing.scheduledStartAt
    ) {
      existing.scheduledEndAt = patch.scheduledEndAt;
    }
  }
  if (patch.hostEmail !== undefined) {
    const next = normalizeHostEmail(patch.hostEmail);
    if (next && next.includes("@")) {
      existing.hostEmail = next;
    }
  }
  if (patch.hostName !== undefined) {
    existing.hostName = sanitizeString(patch.hostName, {
      max: 120,
      allowEmpty: true,
    });
  }
  if (patch.coHosts !== undefined) {
    existing.coHosts = sanitizeCoHosts(patch.coHosts).filter(
      (entry) => entry.email !== existing.hostEmail,
    );
  }
  if (patch.linkSlug !== undefined) {
    const nextSlug = resolveLinkSlug(store, patch.linkSlug, existing.id);
    if (nextSlug !== existing.linkSlug) {
      store.bySlug.delete(existing.linkSlug);
      existing.linkSlug = nextSlug;
      existing.webinarLink = buildWebinarLink(nextSlug);
      store.bySlug.set(nextSlug, existing.id);
      linkSlugChanged = true;
    }
  }
  if (patch.publicAccess !== undefined) {
    existing.publicAccess = Boolean(patch.publicAccess);
  }
  if (patch.maxAttendees !== undefined) {
    existing.maxAttendees = sanitizeMaxAttendees(
      patch.maxAttendees,
      existing.maxAttendees,
    );
  }
  if (patch.inviteCode !== undefined) {
    if (patch.inviteCode === null || patch.inviteCode === "") {
      existing.requiresInviteCode = false;
      inviteCodeHashChange = { value: null };
    } else if (typeof patch.inviteCode === "string") {
      const trimmed = patch.inviteCode.trim();
      if (trimmed) {
        existing.requiresInviteCode = true;
        inviteCodeHashChange = { value: hashWebinarInviteCode(trimmed) };
      }
    }
  }
  if (patch.waitingRoomEnabled !== undefined) {
    existing.waitingRoomEnabled = Boolean(patch.waitingRoomEnabled);
  }
  if (patch.earlyEntryMinutes !== undefined) {
    existing.earlyEntryMinutes = sanitizeEarlyEntry(
      patch.earlyEntryMinutes,
      existing.earlyEntryMinutes,
    );
  }
  if (patch.qaEnabled !== undefined) {
    existing.qaEnabled = Boolean(patch.qaEnabled);
  }
  if (patch.status !== undefined) {
    const valid: ScheduledWebinarStatus[] = [
      "scheduled",
      "live",
      "ended",
      "cancelled",
    ];
    if (valid.includes(patch.status)) {
      existing.status = patch.status;
      if (patch.status === "live" && !existing.liveStartedAt) {
        existing.liveStartedAt = Date.now();
      }
      if (
        (patch.status === "ended" || patch.status === "cancelled") &&
        !existing.endedAt
      ) {
        existing.endedAt = Date.now();
      }
    }
  }

  existing.updatedAt = Date.now();
  void titleChanged;
  void linkSlugChanged;

  return { webinar: existing, inviteCodeHashChange };
};

export const deleteScheduledWebinar = (
  store: ScheduledWebinarStore,
  id: string,
): ScheduledWebinar | null => {
  const existing = store.byId.get(id);
  if (!existing) return null;
  removeFromIndexes(store, existing);
  return existing;
};

export const recordWebinarJoin = (
  store: ScheduledWebinarStore,
  id: string,
  currentAttendeeCount: number,
): ScheduledWebinar | null => {
  const webinar = store.byId.get(id);
  if (!webinar) return null;
  webinar.totalJoinCount += 1;
  if (currentAttendeeCount > webinar.peakAttendeeCount) {
    webinar.peakAttendeeCount = currentAttendeeCount;
  }
  webinar.updatedAt = Date.now();
  return webinar;
};

export const createScheduledWebinarCoHostInvite = (
  store: ScheduledWebinarStore,
  id: string,
): { webinar: ScheduledWebinar; token: string } => {
  const webinar = store.byId.get(id);
  if (!webinar) {
    throw new Error("Scheduled webinar not found.");
  }
  if (webinar.status === "ended" || webinar.status === "cancelled") {
    throw new Error("Cannot create a co-host link for a concluded webinar.");
  }

  const token = generateCoHostInviteToken();
  const now = Date.now();
  webinar.coHostInviteTokenHash = hashCoHostInviteToken(token);
  webinar.coHostInviteTokenCreatedAt = now;
  webinar.updatedAt = now;
  return { webinar, token };
};

export const acceptScheduledWebinarCoHostInvite = (
  store: ScheduledWebinarStore,
  token: string,
  user: { email: string; name?: string | null },
): ScheduledWebinar => {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    throw new Error("Co-host invite token is required.");
  }
  const tokenHash = hashCoHostInviteToken(normalizedToken);
  const email = normalizeHostEmail(user.email);
  if (!email || !email.includes("@")) {
    throw new Error("A signed-in account with an email is required.");
  }

  for (const webinar of store.byId.values()) {
    if (webinar.coHostInviteTokenHash !== tokenHash) continue;
    if (webinar.status === "ended" || webinar.status === "cancelled") {
      throw new Error("This co-host invite is no longer active.");
    }
    if (webinar.hostEmail === email) {
      webinar.updatedAt = Date.now();
      return webinar;
    }

    const existing = webinar.coHosts.find((entry) => entry.email === email);
    if (existing) {
      if (!existing.name && user.name) {
        existing.name = sanitizeString(user.name, {
          max: 120,
          allowEmpty: true,
        }) || undefined;
      }
      webinar.updatedAt = Date.now();
      return webinar;
    }

    if (webinar.coHosts.length >= MAX_CO_HOSTS) {
      throw new Error(`A webinar can have at most ${MAX_CO_HOSTS} co-hosts.`);
    }

    const name = sanitizeString(user.name || undefined, {
      max: 120,
      allowEmpty: true,
    });
    webinar.coHosts.push({ email, name: name || undefined });
    webinar.updatedAt = Date.now();
    return webinar;
  }

  throw new Error("Invalid or expired co-host invite.");
};

export const buildCoHostInviteLink = (token: string): string => {
  const base = getWebinarBaseUrl().replace(/\/$/, "");
  return `${base}/webinars/cohost/${encodeURIComponent(token)}`;
};

export const isWithinEarlyEntryWindow = (
  webinar: ScheduledWebinar,
  now = Date.now(),
): boolean => {
  const earlyMs = webinar.earlyEntryMinutes * 60 * 1000;
  return now >= webinar.scheduledStartAt - earlyMs;
};

export const hasWebinarEnded = (
  webinar: ScheduledWebinar,
  now = Date.now(),
): boolean => {
  if (webinar.status === "ended" || webinar.status === "cancelled") return true;
  return now > webinar.scheduledEndAt + 30 * 60 * 1000;
};

export const isUserScheduledHost = (
  webinar: ScheduledWebinar,
  email: string | null | undefined,
): boolean => {
  if (!email) return false;
  const normalized = normalizeHostEmail(email);
  if (!normalized) return false;
  if (webinar.hostEmail === normalized) return true;
  return webinar.coHosts.some((entry) => entry.email === normalized);
};
