import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Logger } from "../../utilities/loggers.js";
import { asArray, asRecord } from "../../utilities/untrusted.js";
import type { RedisPersistenceClient } from "../redisPersistence.js";
import {
  normalizeStoredCalendar,
  normalizeStoredEventType,
  normalizeStoredHours,
  normalizeStoredProfile,
} from "../scheduling.js";
import { normalizeStoredMeeting } from "../scheduledMeetings.js";
import { normalizeStoredWebinar } from "../scheduledWebinars.js";
import type { StoreMode } from "./backends/backend.js";
import { openSqliteDatabase, type SqliteDatabase } from "./backends/sqlite.js";
import { specOf } from "./entities.js";
import { done, type EntityMap, type Kind } from "./model.js";
import type { ControlPlaneStore } from "./store.js";
import type { Command } from "./tx.js";

export type LegacyRecord = { [K in Kind]: { kind: K; value: EntityMap[K]; stamp: number } }[Kind];

export type LegacyPaths = {
  schedulingSqlite: string;
  meetingsSqlite: string;
  webinarsSqlite: string;
  schedulingJson: string;
  meetingsJson: string;
  webinarsJson: string;
};

type RawScheduling = {
  profiles: unknown[];
  availability: unknown[];
  eventTypes: unknown[];
  calendars: unknown[];
  tombstones: Map<string, number>;
};

type Domain<T> = { source: string; data: T } | null;

const sqlitePathFor = (specific: string | undefined, env: NodeJS.ProcessEnv): string => {
  const configured = specific?.trim() || env.CONCLAVE_SQLITE_PATH?.trim();
  if (configured) return resolve(configured);
  const recordings = env.RECORDING_STORAGE_PATH?.trim();
  if (recordings) return resolve(recordings, "conclave.sqlite");
  return resolve(process.cwd(), "data", "conclave.sqlite");
};

const jsonPathFor = (configured: string | undefined, fallback: string): string =>
  configured?.trim() ? resolve(configured.trim()) : resolve(process.cwd(), "data", fallback);

export const resolveLegacyPaths = (env: NodeJS.ProcessEnv = process.env): LegacyPaths => ({
  schedulingSqlite: sqlitePathFor(env.SCHEDULING_SQLITE_PATH, env),
  meetingsSqlite: sqlitePathFor(env.SCHEDULED_MEETINGS_SQLITE_PATH, env),
  webinarsSqlite: sqlitePathFor(env.SCHEDULED_WEBINARS_SQLITE_PATH, env),
  schedulingJson: jsonPathFor(env.SCHEDULING_PATH, "scheduling.json"),
  meetingsJson: jsonPathFor(env.SCHEDULED_MEETINGS_PATH, "scheduled-meetings.json"),
  webinarsJson: jsonPathFor(env.SCHEDULED_WEBINARS_PATH, "scheduled-webinars.json"),
});

const parseJson = (text: string, where: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    throw new Error(`Legacy control-plane data in ${where} is not valid JSON.`, { cause: error });
  }
};

const unwrapRedisRecord = (value: string, where: string): unknown => {
  const parsed = asRecord(parseJson(value, where));
  return "payload" in parsed ? parsed.payload : parsed;
};

const emptyScheduling = (): RawScheduling => ({
  profiles: [],
  availability: [],
  eventTypes: [],
  calendars: [],
  tombstones: new Map(),
});

const schedulingSize = (raw: RawScheduling): number =>
  raw.profiles.length + raw.availability.length + raw.eventTypes.length + raw.calendars.length;

const snapshotScheduling = (value: unknown): RawScheduling => {
  const snapshot = asRecord(value);
  return {
    profiles: [...(asArray(snapshot.profiles) ?? [])],
    availability: [...(asArray(snapshot.availability) ?? [])],
    eventTypes: [...(asArray(snapshot.eventTypes) ?? [])],
    calendars: [...(asArray(snapshot.calendars) ?? [])],
    tombstones: new Map(),
  };
};

const withLegacySqlite = <T>(path: string, read: (db: SqliteDatabase) => T): T | null => {
  if (!existsSync(path)) return null;
  const db = openSqliteDatabase(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return read(db);
  } finally {
    db.close();
  }
};

const hasTable = (db: SqliteDatabase, table: string): boolean =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

const payloads = (db: SqliteDatabase, sql: string, where: string): unknown[] =>
  db
    .prepare(sql)
    .all()
    .map((row) => asRecord(row).payload_json)
    .filter((payload): payload is string => typeof payload === "string" && payload.length > 0)
    .map((payload) => parseJson(payload, where));

const sqliteRows = (path: string, table: string): unknown[] | null =>
  withLegacySqlite(path, (db) =>
    hasTable(db, table) ? payloads(db, `SELECT payload_json FROM ${table}`, `${path} ${table}`) : null,
  );

const sqliteScheduling = (path: string): RawScheduling | null =>
  withLegacySqlite(path, (db) => {
    if (!hasTable(db, "scheduling_records")) return null;
    const raw = emptyScheduling();
    for (const row of db
      .prepare("SELECT kind, payload_json FROM scheduling_records ORDER BY kind ASC, updated_at ASC")
      .all()) {
      const fields = asRecord(row);
      if (typeof fields.payload_json !== "string" || !fields.payload_json) continue;
      const payload = parseJson(fields.payload_json, `${path} scheduling_records`);
      if (fields.kind === "profile") raw.profiles.push(payload);
      if (fields.kind === "availability") raw.availability.push(payload);
      if (fields.kind === "event_type") raw.eventTypes.push(payload);
      if (fields.kind === "calendar") raw.calendars.push(payload);
    }
    return raw;
  });

const jsonArray = (path: string): unknown[] | null => {
  if (!existsSync(path)) return null;
  const parsed = parseJson(readFileSync(path, "utf8"), path);
  const entries = asArray(parsed);
  if (!entries) throw new Error(`Legacy control-plane data in ${path} is not a list.`);
  return [...entries];
};

const jsonScheduling = (path: string): RawScheduling | null =>
  existsSync(path) ? snapshotScheduling(parseJson(readFileSync(path, "utf8"), path)) : null;

const firstFilled = <T>(
  candidates: Array<{ source: string; read: () => T | null | Promise<T | null> }>,
  size: (data: T) => number,
): Promise<Domain<T>> =>
  candidates.reduce<Promise<Domain<T>>>(async (found, candidate) => {
    const earlier = await found;
    if (earlier) return earlier;
    const data = await candidate.read();
    return data && size(data) > 0 ? { source: candidate.source, data } : null;
  }, Promise.resolve(null));

const redisMeetings = async (client: RedisPersistenceClient, prefix: string): Promise<unknown[]> =>
  (await client.hVals(`${prefix}:scheduled-meetings`)).map((value) =>
    parseJson(value, `${prefix}:scheduled-meetings`),
  );

const redisScheduling = async (
  client: RedisPersistenceClient,
  prefix: string,
): Promise<RawScheduling> => {
  const key = (suffix: string) => `${prefix}:scheduling:${suffix}`;
  const [profiles, availability, eventTypes, calendars, tombstones] = await Promise.all([
    client.hVals(key("profiles")),
    client.hVals(key("availability")),
    client.hVals(key("event-types")),
    client.hVals(key("calendars")),
    client.hGetAll(key("tombstones")),
  ]);
  const raw: RawScheduling = {
    profiles: profiles.map((value) => unwrapRedisRecord(value, key("profiles"))),
    availability: availability.map((value) => unwrapRedisRecord(value, key("availability"))),
    eventTypes: eventTypes.map((value) => unwrapRedisRecord(value, key("event-types"))),
    calendars: calendars.map((value) => unwrapRedisRecord(value, key("calendars"))),
    tombstones: new Map(Object.entries(tombstones).map(([field, at]) => [field, Number(at) || 0])),
  };
  if (schedulingSize(raw) > 0) return raw;
  const snapshot = await client.get(key("snapshot"));
  return snapshot ? snapshotScheduling(parseJson(snapshot, key("snapshot"))) : raw;
};

const dropped = (kind: string, raw: unknown): void => {
  Logger.warn(`[ControlPlane] skipped an unreadable legacy ${kind}: ${JSON.stringify(raw).slice(0, 200)}`);
};

const schedulingRecords = (raw: RawScheduling): LegacyRecord[] => {
  const records: LegacyRecord[] = [];
  const tombstoned = (kind: string, id: string, stamp: number): boolean =>
    (raw.tombstones.get(`${kind}:${id}`) ?? 0) > stamp;
  const profiles = new Map<string, EntityMap["profile"]>();
  for (const entry of raw.profiles) {
    const value = normalizeStoredProfile(entry);
    if (!value) {
      dropped("profile", entry);
      continue;
    }
    if (tombstoned("profile", value.id, value.updatedAt)) continue;
    profiles.set(value.id, value);
    records.push({ kind: "profile", value, stamp: value.updatedAt });
  }
  for (const entry of raw.availability) {
    const profileId = asRecord(entry).profileId;
    const profile = typeof profileId === "string" ? profiles.get(profileId) : undefined;
    if (!profile) continue;
    const value = normalizeStoredHours(entry, {
      timeZone: profile.timeZone,
      updatedAt: profile.updatedAt,
    });
    if (!value) {
      dropped("availability", entry);
      continue;
    }
    const stamp = value.availability.updatedAt ?? profile.updatedAt;
    if (tombstoned("availability", value.profileId, stamp)) continue;
    records.push({ kind: "hours", value, stamp });
  }
  for (const entry of raw.eventTypes) {
    const value = normalizeStoredEventType(entry);
    if (!value) {
      dropped("event type", entry);
      continue;
    }
    if (tombstoned("event_type", value.id, value.updatedAt)) continue;
    records.push({ kind: "eventType", value, stamp: value.updatedAt });
  }
  for (const entry of raw.calendars) {
    const value = normalizeStoredCalendar(entry);
    if (!value) {
      dropped("calendar", entry);
      continue;
    }
    if (tombstoned("calendar", value.profileId, value.updatedAt)) continue;
    records.push({ kind: "calendar", value, stamp: value.updatedAt });
  }
  return records;
};

const listRecords = <K extends "meeting" | "webinar">(
  kind: K,
  entries: unknown[],
  normalize: (raw: unknown) => EntityMap[K] | null,
): LegacyRecord[] =>
  entries.flatMap((entry) => {
    const value = normalize(entry);
    if (!value) {
      dropped(kind, entry);
      return [];
    }
    return [{ kind, value, stamp: value.updatedAt } as LegacyRecord];
  });

export type LegacyReadOptions = {
  mode: StoreMode;
  paths: LegacyPaths;
  redis?: { client: RedisPersistenceClient; prefix: string };
};

export const readLegacyRecords = async (
  options: LegacyReadOptions,
): Promise<{ records: LegacyRecord[]; sources: string[] }> => {
  if (options.mode === "memory") return { records: [], sources: [] };
  const { paths, redis } = options;
  const useSqlite = options.mode !== "json";
  const meetings = await firstFilled<unknown[]>(
    [
      ...(redis
        ? [{ source: "redis meetings", read: () => redisMeetings(redis.client, redis.prefix) }]
        : []),
      ...(useSqlite
        ? [{ source: `sqlite ${paths.meetingsSqlite}`, read: () => sqliteRows(paths.meetingsSqlite, "scheduled_meetings") }]
        : []),
      { source: paths.meetingsJson, read: () => jsonArray(paths.meetingsJson) },
    ],
    (entries) => entries.length,
  );
  const scheduling = await firstFilled<RawScheduling>(
    [
      ...(redis
        ? [{ source: "redis scheduling", read: () => redisScheduling(redis.client, redis.prefix) }]
        : []),
      ...(useSqlite
        ? [{ source: `sqlite ${paths.schedulingSqlite}`, read: () => sqliteScheduling(paths.schedulingSqlite) }]
        : []),
      { source: paths.schedulingJson, read: () => jsonScheduling(paths.schedulingJson) },
    ],
    schedulingSize,
  );
  const webinars = await firstFilled<unknown[]>(
    [
      ...(useSqlite
        ? [{ source: `sqlite ${paths.webinarsSqlite}`, read: () => sqliteRows(paths.webinarsSqlite, "scheduled_webinars") }]
        : []),
      { source: paths.webinarsJson, read: () => jsonArray(paths.webinarsJson) },
    ],
    (entries) => entries.length,
  );
  return {
    records: [
      ...(scheduling ? schedulingRecords(scheduling.data) : []),
      ...(meetings ? listRecords("meeting", meetings.data, normalizeStoredMeeting) : []),
      ...(webinars ? listRecords("webinar", webinars.data, normalizeStoredWebinar) : []),
    ],
    sources: [scheduling?.source, meetings?.source, webinars?.source].filter(
      (source): source is string => Boolean(source),
    ),
  };
};

export type ImportCounts = { inserted: number; refreshed: number; kept: number; unindexed: number };

export const importLegacy =
  (batch: readonly LegacyRecord[]): Command<ImportCounts> =>
  (tx) => {
    const counts: ImportCounts = { inserted: 0, refreshed: 0, kept: 0, unindexed: 0 };
    for (const record of batch) {
      const id = specOf(record.kind).id(record.value);
      const existing = tx.get(record.kind, id);
      if (existing) {
        if (existing.legacy === null || existing.legacy >= record.stamp) {
          counts.kept += 1;
          continue;
        }
        counts.refreshed += 1;
      } else if (tx.tombstone(record.kind, id) !== null) {
        counts.kept += 1;
        continue;
      } else {
        counts.inserted += 1;
      }
      const skipped = tx.importLegacy(record.kind, record.value, record.stamp);
      if (skipped.length > 0) {
        counts.unindexed += 1;
        Logger.warn(
          `[ControlPlane] legacy ${record.kind} ${id} kept without ${skipped.join(", ")}: another record already holds it`,
        );
      }
    }
    return done(counts);
  };

const IMPORT_BATCH = 50;

export const importLegacyRecords = async (
  store: ControlPlaneStore,
  records: readonly LegacyRecord[],
): Promise<ImportCounts> => {
  const ordered = [...records].sort((a, b) => b.stamp - a.stamp);
  const total: ImportCounts = { inserted: 0, refreshed: 0, kept: 0, unindexed: 0 };
  for (let start = 0; start < ordered.length; start += IMPORT_BATCH) {
    const result = await store.commit(importLegacy(ordered.slice(start, start + IMPORT_BATCH)));
    if (!result.ok) {
      throw new Error(`Legacy control-plane import failed: ${result.reason} ${result.message ?? ""}`);
    }
    total.inserted += result.value.inserted;
    total.refreshed += result.value.refreshed;
    total.kept += result.value.kept;
    total.unindexed += result.value.unindexed;
  }
  return total;
};
