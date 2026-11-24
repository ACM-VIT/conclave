import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { identityOf, specOf } from "./entities.js";
import { LEGACY_DOMAINS, legacyCopyKey, type DataKind, type DataMap, type Kind, type LegacyDomain } from "./model.js";
import { hashLegacyValue } from "./legacyHash.js";

export type LegacyRecord = { [K in DataKind]: { kind: K; value: DataMap[K]; stamp: number } }[DataKind];

export type HashedLegacyRecord = LegacyRecord & { id: string; key: string; identity: string; hash: string };

export type LegacyPaths = {
  schedulingSqlite: string;
  meetingsSqlite: string;
  webinarsSqlite: string;
  schedulingJson: string;
  meetingsJson: string;
  webinarsJson: string;
  fallbackDir: string | null;
};

type RawScheduling = {
  profiles: unknown[];
  availability: unknown[];
  eventTypes: unknown[];
  calendars: unknown[];
  tombstones: Map<string, number>;
};


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
  fallbackDir: env.CONCLAVE_FALLBACK_IMPORT_DIR?.trim() ? resolve(env.CONCLAVE_FALLBACK_IMPORT_DIR.trim()) : null,
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

const listOf = (text: string, where: string): unknown[] => {
  const entries = asArray(parseJson(text, where));
  if (!entries) throw new Error(`Legacy control-plane data in ${where} is not a list.`);
  return [...entries];
};

const jsonArray = (path: string): unknown[] | null =>
  existsSync(path) ? listOf(readFileSync(path, "utf8"), path) : null;

const jsonScheduling = (path: string): RawScheduling | null =>
  existsSync(path) ? snapshotScheduling(parseJson(readFileSync(path, "utf8"), path)) : null;

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

const TOKEN_FIELDS = ["accessToken", "refreshToken"] as const;

const unreadableTokens = (raw: unknown, value: DataMap["calendar"]): string[] => {
  const stored = asRecord(raw);
  return TOKEN_FIELDS.filter((field) => typeof stored[field] === "string" && stored[field] !== "" && !value[field]).map(
    (field) => `the ${field} of profile ${value.profileId}'s calendar`,
  );
};

const schedulingRecords = (raw: RawScheduling, where: string): LegacyRecord[] => {
  const records: LegacyRecord[] = [];
  const unreadable: string[] = [];
  const tombstoned = (kind: string, id: string, stamp: number): boolean =>
    (raw.tombstones.get(`${kind}:${id}`) ?? 0) > stamp;
  const profiles = new Map<string, DataMap["profile"]>();
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
    unreadable.push(...unreadableTokens(entry, value));
    if (tombstoned("calendar", value.profileId, value.updatedAt)) continue;
    records.push({ kind: "calendar", value, stamp: value.updatedAt });
  }
  if (unreadable.length > 0) {
    throw new Error(
      `In ${where}, ${unreadable.join(", ")} cannot be decrypted with this SFU's secret. Set SCHEDULING_TOKEN_SECRET to the secret the older SFU used.`,
    );
  }
  return records;
};

const listRecords = <K extends "meeting" | "webinar">(
  kind: K,
  entries: unknown[],
  normalize: (raw: unknown) => DataMap[K] | null,
): LegacyRecord[] =>
  entries.flatMap((entry) => {
    const value = normalize(entry);
    if (!value) {
      dropped(kind, entry);
      return [];
    }
    return [{ kind, value, stamp: value.updatedAt } as LegacyRecord];
  });

export const hashed = (record: LegacyRecord): HashedLegacyRecord => {
  const id = specOf(record.kind).id(record.value);
  return {
    ...record,
    id,
    key: legacyCopyKey(record.kind, id),
    identity: identityOf<Kind>(record.kind, record.value),
    hash: hashLegacyValue(record.value),
  };
};

type Candidate = { source: string; read: () => Promise<LegacyRecord[] | null> };

export type LegacyDomainRead = {
  domain: LegacyDomain;
  source: string | null;
  records: HashedLegacyRecord[] | null;
};

export type LegacyReadOptions = {
  mode: StoreMode;
  paths: LegacyPaths;
  redis?: { client: RedisPersistenceClient; prefix: string };
  sticky?: Partial<Record<LegacyDomain, string>>;
};

const candidatesFor = (domain: LegacyDomain, options: LegacyReadOptions): Candidate[] => {
  const { paths, redis } = options;
  const useSqlite = options.mode !== "json";
  const scheduling = (data: RawScheduling | null, where: string) => (data ? schedulingRecords(data, where) : null);
  const meetings = (data: unknown[] | null) => (data ? listRecords("meeting", data, normalizeStoredMeeting) : null);
  const webinars = (data: unknown[] | null) => (data ? listRecords("webinar", data, normalizeStoredWebinar) : null);
  const candidates: Record<LegacyDomain, Candidate[]> = {
    scheduling: [
      ...(redis
        ? [{ source: "redis", read: async () => scheduling(await redisScheduling(redis.client, redis.prefix), "the old Redis scheduling records") }]
        : []),
      ...(useSqlite
        ? [{ source: "sqlite", read: async () => scheduling(sqliteScheduling(paths.schedulingSqlite), paths.schedulingSqlite) }]
        : []),
      { source: "json", read: async () => scheduling(jsonScheduling(paths.schedulingJson), paths.schedulingJson) },
    ],
    meetings: [
      ...(redis ? [{ source: "redis", read: async () => meetings(await redisMeetings(redis.client, redis.prefix)) }] : []),
      ...(useSqlite
        ? [{ source: "sqlite", read: async () => meetings(sqliteRows(paths.meetingsSqlite, "scheduled_meetings")) }]
        : []),
      { source: "json", read: async () => meetings(jsonArray(paths.meetingsJson)) },
    ],
    webinars: [
      ...(useSqlite
        ? [{ source: "sqlite", read: async () => webinars(sqliteRows(paths.webinarsSqlite, "scheduled_webinars")) }]
        : []),
      { source: "json", read: async () => webinars(jsonArray(paths.webinarsJson)) },
    ],
  };
  return candidates[domain];
};

const readDomain = async (domain: LegacyDomain, options: LegacyReadOptions): Promise<LegacyDomainRead> => {
  const candidates = candidatesFor(domain, options);
  const sticky = options.sticky?.[domain];
  if (sticky) {
    const candidate = candidates.find((entry) => entry.source === sticky);
    const records = candidate ? await candidate.read() : null;
    if (!records) {
      Logger.warn(`[ControlPlane] the old ${sticky} ${domain} store this store imported from is gone; its changes are not followed`);
    }
    return { domain, source: sticky, records: records ? records.map(hashed) : null };
  }
  for (const candidate of candidates) {
    const records = await candidate.read();
    if (records && records.length > 0) return { domain, source: candidate.source, records: records.map(hashed) };
  }
  return { domain, source: null, records: [] };
};

export const readLegacyDomains = async (options: LegacyReadOptions): Promise<LegacyDomainRead[]> => {
  if (options.mode === "memory") return [];
  const reads: LegacyDomainRead[] = [];
  for (const domain of LEGACY_DOMAINS) reads.push(await readDomain(domain, options));
  return reads;
};

const RECOVERED_FILES: Record<LegacyDomain, string> = {
  scheduling: "scheduling.json",
  meetings: "scheduled-meetings.json",
  webinars: "scheduled-webinars.json",
};

export type RecoveredRecord = HashedLegacyRecord & { from: string };

export type ClaimedCopy = { domain: LegacyDomain; base: string; path: string; hash: string };

export type RecoveredCopies = { files: ClaimedCopy[]; records: RecoveredRecord[] };

const CLAIM = /^(.+)\.claimed-(\d+)-\d+$/;

const claimable = (dir: string | null, ticket: number): Array<{ domain: LegacyDomain; base: string; path: string }> => {
  if (!dir || !existsSync(dir)) return [];
  const found: Array<{ domain: LegacyDomain; base: string; path: string }> = [];
  for (const service of readdirSync(dir, { withFileTypes: true })) {
    if (!service.isDirectory() || service.name.startsWith(".")) continue;
    const folder = join(dir, service.name);
    for (const name of readdirSync(folder).sort()) {
      const claimed = CLAIM.exec(name);
      const fileName = claimed ? claimed[1] : name;
      const domain = LEGACY_DOMAINS.find((entry) => RECOVERED_FILES[entry] === fileName);
      if (!domain) continue;
      if (claimed && Number(claimed[2]) >= ticket) continue;
      found.push({ domain, base: join(folder, fileName), path: join(folder, name) });
    }
  }
  return found;
};

const claim = (dir: string | null, ticket: number): Array<{ domain: LegacyDomain; base: string; path: string }> => {
  const mine: Array<{ domain: LegacyDomain; base: string; path: string }> = [];
  for (let pass = 0; pass < 5; pass += 1) {
    const candidates = claimable(dir, ticket);
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      const path = `${candidate.base}.claimed-${ticket}-${mine.length}`;
      try {
        renameSync(candidate.path, path);
        mine.push({ domain: candidate.domain, base: candidate.base, path });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return mine;
};

const recoveredRecords = (domain: LegacyDomain, text: string, path: string): LegacyRecord[] => {
  try {
    return domain === "scheduling"
      ? schedulingRecords(snapshotScheduling(parseJson(text, path)), path)
      : domain === "meetings"
        ? listRecords("meeting", listOf(text, path), normalizeStoredMeeting)
        : listRecords("webinar", listOf(text, path), normalizeStoredWebinar);
  } catch (error) {
    throw new Error(
      `${path}, a store an older SFU kept in its container, cannot be read: ${(error as Error).message} Repair it before the SFU starts.`,
      { cause: error },
    );
  }
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const release = (files: ReadonlyArray<{ base: string; path: string }>): void => {
  for (const file of files) {
    if (existsSync(file.path) && !existsSync(file.base)) renameSync(file.path, file.base);
  }
};

const combine = (files: ClaimedCopy[], texts: string[]): RecoveredRecord[] => {
  const winners = new Map<string, RecoveredRecord>();
  const problems: string[] = [];
  files.forEach((file, index) => {
    for (const record of recoveredRecords(file.domain, texts[index], file.base).map(hashed)) {
      const held = winners.get(record.key);
      if (!held || record.stamp > held.stamp) {
        winners.set(record.key, { ...record, from: file.base });
      } else if (record.stamp === held.stamp && record.hash !== held.hash) {
        problems.push(`${record.key} differs between ${held.from} and ${file.base}, and both were last changed at ${record.stamp}.`);
      }
    }
  });
  if (problems.length > 0) {
    throw new Error(
      `Could not combine the stores older SFUs kept in their containers without losing a change:\n- ${problems.join("\n- ")}\nResolve these records by hand, then rename each copy with a .adopted suffix.`,
    );
  }
  return [...winners.values()];
};

export const claimRecoveredCopies = (dir: string | null, ticket: number): RecoveredCopies => {
  const claimed = claim(dir, ticket);
  try {
    const texts = claimed.map((file) => readFileSync(file.path, "utf8"));
    const files = claimed.map((file, index) => ({ ...file, hash: sha256(texts[index]) }));
    return { files, records: combine(files, texts) };
  } catch (error) {
    release(claimed);
    throw error;
  }
};

export const stillClaimed = (file: ClaimedCopy): boolean =>
  existsSync(file.path) && sha256(readFileSync(file.path, "utf8")) === file.hash;

export const markAdopted = (file: ClaimedCopy): string | null => {
  if (!stillClaimed(file)) {
    if (existsSync(file.path)) Logger.warn(`[ControlPlane] ${file.path} changed after it was imported; left it for the next start`);
    return null;
  }
  const plain = `${file.base}.adopted`;
  const target = existsSync(plain) ? `${plain}-${file.hash.slice(0, 12)}` : plain;
  renameSync(file.path, target);
  return target;
};
