import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { emptyInviteeState, legacyInviteeState, mergeInviteeState, storedNumber, type InviteeState } from "./inviteeState.js";
import { hashLegacyValue } from "./legacyHash.js";

export type LegacyRecord = { [K in DataKind]: { kind: K; value: DataMap[K]; stamp: number; inviteeState?: InviteeState } }[DataKind];

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

type LegacyInvitees = {
  states: Map<string, InviteeState>;
  moved: Set<string>;
};

const legacyInvitees = (): LegacyInvitees => ({ states: new Map(), moved: new Set() });

const stateFor = ({ states }: LegacyInvitees, id: string): InviteeState => {
  const current = states.get(id) ?? emptyInviteeState(id);
  states.set(id, current);
  return current;
};

const sqliteMeetings = (path: string): LegacyRecord[] | null =>
  withLegacySqlite(path, (db) => {
    if (!hasTable(db, "scheduled_meetings")) return null;
    const sidecar = legacyInvitees();
    db.exec("BEGIN");
    try {
      const rows = (table: string) => hasTable(db, table) ? db.prepare(`SELECT * FROM ${table}`).all().map(asRecord) : [];
      for (const row of rows("scheduled_meeting_removed_invitees")) {
        if (typeof row.meeting_id !== "string" || typeof row.email !== "string") continue;
        const state = stateFor(sidecar, row.meeting_id);
        state.decisions = { ...state.decisions, [row.email]: { removed: row.readmitted !== 1, at: storedNumber(row.removed_at) ?? 0 } };
        sidecar.moved.add(row.meeting_id);
      }
      for (const row of rows("scheduled_meeting_removals_ended")) {
        if (typeof row.meeting_id === "string") stateFor(sidecar, row.meeting_id).endedAt = storedNumber(row.ended_at);
      }
      for (const row of rows("scheduled_meeting_write_generations")) {
        if (typeof row.meeting_id === "string") stateFor(sidecar, row.meeting_id).generation = storedNumber(row.generation);
      }
      for (const row of rows("scheduled_meeting_removals_moved")) {
        if (typeof row.meeting_id === "string") sidecar.moved.add(row.meeting_id);
      }
      return meetingRecords(payloads(db, "SELECT payload_json FROM scheduled_meetings", path), sidecar);
    } finally {
      db.exec("ROLLBACK");
    }
  });

const redisMeetings = async (client: RedisPersistenceClient, prefix: string): Promise<LegacyRecord[]> => {
  const key = `${prefix}:scheduled-meetings`;
  const [records, decisions, ended, generations, moved] = await client.multi()
    .hVals(key)
    .hGetAll(`${key}:removed-invitees`)
    .hGetAll(`${key}:removed-invitees-ended`)
    .hGetAll(`${key}:write-generations`)
    .sMembers(`${key}:removed-invitees-moved`)
    .execTyped();
  const sidecar: LegacyInvitees = { states: new Map(), moved: new Set(moved) };
  for (const [member, value] of Object.entries(decisions)) {
    const split = member.indexOf(" ");
    if (split <= 0) continue;
    const id = member.slice(0, split);
    const email = member.slice(split + 1);
    const [at, status] = value.split(":");
    const state = stateFor(sidecar, id);
    state.decisions = { ...state.decisions, [email]: { removed: status !== "readmitted", at: storedNumber(Number(at)) ?? 0 } };
    sidecar.moved.add(id);
  }
  for (const [id, at] of Object.entries(ended)) stateFor(sidecar, id).endedAt = storedNumber(Number(at));
  for (const [id, generation] of Object.entries(generations)) stateFor(sidecar, id).generation = storedNumber(Number(generation));
  return meetingRecords(records.map((record) => parseJson(record, key)), sidecar);
};

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
    if (tombstoned("calendar", value.profileId, value.updatedAt)) continue;
    unreadable.push(...unreadableTokens(entry, value));
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

const meetingRecords = (entries: unknown[], sidecar = legacyInvitees()): LegacyRecord[] => entries.flatMap((entry) => {
  const meeting = normalizeStoredMeeting(entry);
  if (!meeting) {
    dropped("meeting", entry);
    return [];
  }
  const carried = sidecar.moved.has(meeting.id) ? emptyInviteeState(meeting.id) : legacyInviteeState(meeting, entry);
  const stored = sidecar.states.get(meeting.id);
  const inviteeState = stored ? mergeInviteeState(carried, stored) : carried;
  return [{ kind: "meeting", value: meeting, stamp: meeting.updatedAt, inviteeState }];
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
      ...(redis ? [{ source: "redis", read: async () => redisMeetings(redis.client, redis.prefix) }] : []),
      ...(useSqlite
        ? [{ source: "sqlite", read: async () => sqliteMeetings(paths.meetingsSqlite) }]
        : []),
      { source: "json", read: async () => {
        const entries = jsonArray(paths.meetingsJson);
        return entries && meetingRecords(entries);
      } },
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
    if (records && (records.length > 0 || options.mode === "json")) {
      return { domain, source: candidate.source, records: records.map(hashed) };
    }
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

export type ClaimedCopy = {
  domain: LegacyDomain;
  base: string;
  path: string;
  source: string;
  order: string;
  hash: string;
};

export type CopySnapshot = { source: string; order: string; domain: LegacyDomain; from: string; records: HashedLegacyRecord[] };

export type RecoveredCopies = { files: ClaimedCopy[]; snapshots: CopySnapshot[] };

type CopyFile = { domain: LegacyDomain; base: string; path: string; service: string; archive: string | null };

const CLAIM = /^(.+)\.claimed-(\d+)-\d+$/;
const ARCHIVE = /^(\d{8}T\d+Z)-(.+)$/;

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const denied = (error: unknown): boolean => ["EACCES", "EPERM"].includes(String((error as NodeJS.ErrnoException).code));

const unreadableCopies = (path: string, error: unknown): Error =>
  new Error(
    `${path} holds store copies a deploy saved from an older SFU, and this SFU cannot open it (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}). Nothing was changed. Give it to the user the SFU runs as, for example: chown -R node:node ${path} && chmod -R u+rwX ${path}. Then start the SFU again.`,
    { cause: error },
  );

const listFolder = <T,>(path: string, list: () => T): T | null => {
  try {
    return list();
  } catch (error) {
    if (missing(error)) return null;
    if (denied(error)) throw unreadableCopies(path, error);
    throw error;
  }
};

const folders = (path: string): string[] =>
  (listFolder(path, () => readdirSync(path, { withFileTypes: true })) ?? [])
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();

const copyFolders = (dir: string): Array<{ path: string; service: string; archive: string | null }> =>
  folders(dir).flatMap((service) => [
    { path: join(dir, service), service, archive: null },
    ...folders(join(dir, service)).map((archive) => ({ path: join(dir, service, archive), service, archive })),
  ]);

const claimable = (dir: string | null, ticket: number): CopyFile[] => {
  if (!dir || !existsSync(dir)) return [];
  const found: CopyFile[] = [];
  for (const folder of copyFolders(dir)) {
    const names = listFolder(folder.path, () => readdirSync(folder.path).sort());
    if (!names) continue;
    for (const name of names) {
      const claimed = CLAIM.exec(name);
      const fileName = claimed ? claimed[1] : name;
      const domain = LEGACY_DOMAINS.find((entry) => RECOVERED_FILES[entry] === fileName);
      if (!domain) continue;
      if (claimed && Number(claimed[2]) >= ticket) continue;
      found.push({ domain, base: join(folder.path, fileName), path: join(folder.path, name), service: folder.service, archive: folder.archive });
    }
  }
  return found;
};

const claim = (dir: string | null, ticket: number): CopyFile[] => {
  const mine: CopyFile[] = [];
  try {
    for (let pass = 0; pass < 5; pass += 1) {
      const candidates = claimable(dir, ticket);
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        const path = `${candidate.base}.claimed-${ticket}-${mine.length}`;
        try {
          renameSync(candidate.path, path);
          mine.push({ ...candidate, path });
        } catch (error) {
          if (missing(error)) continue;
          throw denied(error) ? unreadableCopies(dirname(candidate.path), error) : error;
        }
      }
    }
  } catch (error) {
    releaseClaimedCopies(mine);
    throw error;
  }
  return mine;
};

const recoveredRecords = (domain: LegacyDomain, text: string, path: string): LegacyRecord[] => {
  try {
    return domain === "scheduling"
      ? schedulingRecords(snapshotScheduling(parseJson(text, path)), path)
      : domain === "meetings"
        ? meetingRecords(listOf(text, path))
        : listRecords("webinar", listOf(text, path), normalizeStoredWebinar);
  } catch (error) {
    throw new Error(
      `${path}, a store an older SFU kept in its container, cannot be read: ${(error as Error).message} Repair it before the SFU starts.`,
      { cause: error },
    );
  }
};

export const readLegacyFile = (domain: LegacyDomain, text: string, where: string): HashedLegacyRecord[] =>
  recoveredRecords(domain, text, where).map(hashed);

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const readClaimed = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (missing(error)) return null;
    if (denied(error)) throw unreadableCopies(dirname(path), error);
    throw error;
  }
};

export const releaseClaimedCopies = (files: ReadonlyArray<{ base: string; path: string }>): void => {
  for (const file of files) {
    try {
      if (existsSync(file.path) && !existsSync(file.base)) renameSync(file.path, file.base);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
};

const sourceOf = (candidate: CopyFile, hash: string): { source: string; order: string } => {
  if (candidate.archive === null) return { source: `${candidate.service}/flat-${hash.slice(0, 16)}`, order: "" };
  const metadataPath = join(dirname(candidate.base), ".source");
  const metadata = readClaimed(metadataPath);
  if (metadata !== null) {
    const container = /^([a-f0-9]+)\s+\S+$/.exec(metadata.trim())?.[1];
    if (!container) throw new Error(`${metadataPath} does not name the container that wrote this archive.`);
    return { source: `${candidate.service}/container/${container}`, order: candidate.archive };
  }
  const parsed = ARCHIVE.exec(candidate.archive);
  return parsed
    ? { source: `${candidate.service}/${parsed[2]}`, order: candidate.archive }
    : { source: `${candidate.service}/${candidate.archive}`, order: candidate.archive };
};

const DOMAIN_ORDER = (domain: LegacyDomain): number => LEGACY_DOMAINS.indexOf(domain);

export type ClaimedFiles = readonly CopyFile[];

export const claimCopies = (dir: string | null, ticket: number): ClaimedFiles => claim(dir, ticket);

export const readClaimedCopies = (claimed: ClaimedFiles): RecoveredCopies => {
  try {
    const files: ClaimedCopy[] = [];
    const snapshots: CopySnapshot[] = [];
    for (const candidate of claimed) {
      const text = readClaimed(candidate.path);
      if (text === null) continue;
      const hash = sha256(text);
      const { source, order } = sourceOf(candidate, hash);
      files.push({ domain: candidate.domain, base: candidate.base, path: candidate.path, source, order, hash });
      snapshots.push({
        source,
        order,
        domain: candidate.domain,
        from: candidate.base,
        records: recoveredRecords(candidate.domain, text, candidate.base).map(hashed),
      });
    }
    snapshots.sort((a, b) =>
      a.order !== b.order
        ? a.order < b.order ? -1 : 1
        : a.source !== b.source
          ? a.source < b.source ? -1 : 1
          : DOMAIN_ORDER(a.domain) - DOMAIN_ORDER(b.domain),
    );
    return { files, snapshots };
  } catch (error) {
    releaseClaimedCopies(claimed);
    throw error;
  }
};

export const stillClaimed = (file: ClaimedCopy): boolean => {
  const text = readClaimed(file.path);
  return text !== null && sha256(text) === file.hash;
};

export const markAdopted = (file: ClaimedCopy): string | null => {
  if (!stillClaimed(file)) {
    if (existsSync(file.path)) Logger.warn(`[ControlPlane] ${file.path} changed after it was imported; left it for the next start`);
    return null;
  }
  const plain = `${file.base}.adopted`;
  const target = existsSync(plain) ? `${plain}-${file.hash.slice(0, 12)}` : plain;
  try {
    renameSync(file.path, target);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  return target;
};
