import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Logger } from "../utilities/loggers.js";

type Entry = Record<string, unknown>;
type Source = { path: string; data: unknown };

type Collection = {
  key: (entry: Entry) => string | null;
  stamp: (entry: Entry, source: unknown) => number;
  unique?: Array<(entry: Entry) => string | null>;
};

export type JsonStoreShape = {
  collections: Record<string, Collection>;
  read: (data: unknown) => Record<string, Entry[]>;
  build: (base: unknown, collections: Record<string, Entry[]>) => unknown;
};

const entries = (value: unknown): Entry[] =>
  Array.isArray(value) ? value.filter((entry): entry is Entry => Boolean(entry) && typeof entry === "object") : [];

const text = (value: unknown): string | null => (value === undefined || value === null || value === "" ? null : String(value));

const stampOf = (value: unknown): number => {
  const stamp = Number(value);
  return Number.isFinite(stamp) ? stamp : 0;
};

const profileStamp = (source: unknown, profileId: unknown): number => {
  const profile = entries((source as { profiles?: unknown } | null)?.profiles).find((entry) => entry.id === profileId);
  return stampOf(profile?.updatedAt);
};

const listOfRecords = (unique: Collection["unique"] = []): JsonStoreShape => ({
  collections: { records: { key: (entry) => text(entry.id), stamp: (entry) => stampOf(entry.updatedAt), unique } },
  read: (data) => ({ records: entries(data) }),
  build: (_base, collections) => collections.records,
});

export const meetingStoreShape = listOfRecords();

export const webinarStoreShape = listOfRecords([(entry) => text(entry.linkSlug)?.toLowerCase() ?? null]);

export const schedulingStoreShape: JsonStoreShape = {
  collections: {
    profiles: {
      key: (entry) => text(entry.id),
      stamp: (entry) => stampOf(entry.updatedAt),
      unique: [
        (entry) => (text(entry.userId) ? `user ${text(entry.clientId)}:${text(entry.userId)}` : null),
        (entry) => (text(entry.username) ? `username ${text(entry.clientId)}:${text(entry.username)?.toLowerCase()}` : null),
      ],
    },
    availability: {
      key: (entry) => text(entry.profileId),
      stamp: (entry, source) =>
        stampOf((entry.availability as Entry | undefined)?.updatedAt) || profileStamp(source, entry.profileId),
    },
    eventTypes: {
      key: (entry) => text(entry.id),
      stamp: (entry) => stampOf(entry.updatedAt),
      unique: [(entry) => (text(entry.slug) ? `${text(entry.profileId)}:${text(entry.slug)?.toLowerCase()}` : null)],
    },
    calendars: { key: (entry) => text(entry.profileId), stamp: (entry) => stampOf(entry.updatedAt) },
  },
  read: (data) => {
    const snapshot = (data ?? {}) as Record<string, unknown>;
    return {
      profiles: entries(snapshot.profiles),
      availability: entries(snapshot.availability),
      eventTypes: entries(snapshot.eventTypes),
      calendars: entries(snapshot.calendars),
    };
  },
  build: (base, collections) => ({ ...((base ?? {}) as Record<string, unknown>), ...collections }),
};

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Entry).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );

const recoveredCopies = (fileName: string): string[] => {
  const importDir = process.env.CONCLAVE_FALLBACK_IMPORT_DIR?.trim();
  if (!importDir || !existsSync(importDir)) return [];
  return readdirSync(importDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(importDir, entry.name, fileName))
    .filter((path) => existsSync(path))
    .sort();
};

const readSource = (path: string, role: string): Source => {
  try {
    return { path, data: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    throw new Error(`${path}, ${role}, is not readable JSON (${(error as Error).message}). Repair it before the SFU starts.`);
  }
};

const mergeSources = (shape: JsonStoreShape, sources: Source[]): { merged: Record<string, Entry[]>; problems: string[] } => {
  const problems: string[] = [];
  const merged: Record<string, Entry[]> = {};
  for (const [name, collection] of Object.entries(shape.collections)) {
    const winners = new Map<string, { entry: Entry; stamp: number; json: string; from: string }>();
    const keyless = new Map<string, Entry>();
    for (const source of sources) {
      for (const entry of shape.read(source.data)[name] ?? []) {
        const key = collection.key(entry);
        const json = stableJson(entry);
        if (key === null) {
          keyless.set(json, entry);
          continue;
        }
        const stamp = collection.stamp(entry, source.data);
        const held = winners.get(key);
        if (!held || stamp > held.stamp) {
          winners.set(key, { entry, stamp, json, from: source.path });
        } else if (stamp === held.stamp && json !== held.json) {
          problems.push(`${name} ${key} differs between ${held.from} and ${source.path}, and both were last changed at ${stamp}.`);
        }
      }
    }
    const kept = [...winners.values()].map((winner) => winner.entry);
    for (const unique of collection.unique ?? []) {
      const owners = new Map<string, string>();
      for (const entry of kept) {
        const value = unique(entry);
        if (value === null) continue;
        const key = String(collection.key(entry));
        const other = owners.get(value);
        if (other !== undefined && other !== key) problems.push(`${name} ${other} and ${key} both claim ${value}.`);
        owners.set(value, key);
      }
    }
    merged[name] = [...kept, ...keyless.values()];
  }
  return { merged, problems };
};

export const adoptRecoveredJsonStore = (activePath: string, fileName: string, shape: JsonStoreShape): void => {
  const copies = recoveredCopies(fileName);
  if (copies.length === 0) return;
  const active = existsSync(activePath) ? readSource(activePath, "this SFU's store") : null;
  const sources = [...(active ? [active] : []), ...copies.map((path) => readSource(path, "a store an older SFU kept in its container"))];
  const { merged, problems } = mergeSources(shape, sources);
  if (problems.length > 0) {
    throw new Error(
      `Could not combine ${sources.map((source) => source.path).join(", ")} without losing a change:\n- ${problems.join("\n- ")}\nResolve these records by hand, then rename each copy under ${dirname(copies[0])}/.. with a .adopted suffix.`,
    );
  }
  const result = shape.build(active?.data ?? sources[0].data, merged);
  if (!active || stableJson(result) !== stableJson(active.data)) {
    mkdirSync(dirname(activePath), { recursive: true });
    if (active) copyFileSync(activePath, `${activePath}.premerge-${Date.now()}`);
    const staged = `${activePath}.${process.pid}.merging`;
    writeFileSync(staged, JSON.stringify(result, null, 2), { mode: 0o600 });
    renameSync(staged, activePath);
  }
  for (const path of copies) renameSync(path, `${path}.adopted`);
  Logger.warn(`Combined ${copies.join(", ")} into ${activePath}, the store an older SFU kept in its container`);
};
