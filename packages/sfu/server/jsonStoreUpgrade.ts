import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Logger } from "../utilities/loggers.js";
import { writePrivateFileAtomic } from "./privateFile.js";

export type JsonStoreClaim<Row> = {
  key: (row: Row) => string;
  holds?: (row: Row) => boolean;
};

export type JsonStoreCollection<Snapshot, Row> = {
  index?: string;
  rows: (snapshot: Snapshot) => Row[];
  key: (row: Row) => string;
  stamp: (row: Row, snapshot: Snapshot) => number;
  claims: Record<string, JsonStoreClaim<Row>>;
  compare?: (row: Row) => unknown;
  canDelete?: boolean;
};

type ErasedCollection<Snapshot> = JsonStoreCollection<Snapshot, unknown>;

export const jsonStoreCollection = <Snapshot, Row>(collection: JsonStoreCollection<Snapshot, Row>): ErasedCollection<Snapshot> =>
  collection as unknown as ErasedCollection<Snapshot>;

export type JsonStoreAdapter<Snapshot> = {
  decode: (data: unknown) => Snapshot;
  write: (path: string, snapshot: Snapshot) => void;
  collections: Record<string, ErasedCollection<Snapshot>>;
  build: (base: Snapshot, rows: Record<string, unknown[]>) => Snapshot;
};

type Source<Snapshot> = { path: string; snapshot: Snapshot };

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const unreadableCopies = (path: string, error: unknown) =>
  new Error(
    `${path} holds store copies a deploy saved from an older SFU, and this SFU cannot open it (${errorCode(error) ?? (error as Error).message}). Nothing was changed. Give it to the user the SFU runs as, for example: chown -R node:node ${path} && chmod -R u+rwX ${path}. Then start the SFU again.`,
  );

const guarded = <T>(path: string, read: () => T): T => {
  try {
    return read();
  } catch (error) {
    if (errorCode(error) === "EACCES" || errorCode(error) === "EPERM") throw unreadableCopies(path, error);
    throw error;
  }
};

const folders = (path: string): string[] =>
  guarded(path, () => readdirSync(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);

const savedCopy = (path: string): boolean =>
  guarded(dirname(path), () => {
    try {
      statSync(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    accessSync(path, constants.R_OK);
    accessSync(dirname(path), constants.W_OK);
    return true;
  });

const recoveredCopies = (fileName: string): string[] => {
  const importDir = process.env.CONCLAVE_FALLBACK_IMPORT_DIR?.trim();
  if (!importDir || !existsSync(importDir)) return [];
  return folders(importDir)
    .flatMap((service) => folders(join(importDir, service)).map((archive) => ({ archive, path: join(importDir, service, archive, fileName) })))
    .filter(({ path }) => savedCopy(path))
    .sort((a, b) => (a.archive < b.archive ? -1 : a.archive > b.archive ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path }) => path);
};

const readSource = <Snapshot>(adapter: JsonStoreAdapter<Snapshot>, path: string, role: string): Source<Snapshot> => {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}, ${role}, is not readable JSON (${(error as Error).message}). Repair it before the SFU starts.`);
  }
  try {
    return { path, snapshot: adapter.decode(data) };
  } catch (error) {
    throw new Error(`${path}, ${role}, cannot be read: ${(error as Error).message}`);
  }
};

const mergeSources = <Snapshot>(adapter: JsonStoreAdapter<Snapshot>, sources: Source<Snapshot>[]) => {
  const problems: string[] = [];
  const merged: Record<string, unknown[]> = {};
  for (const [name, collection] of Object.entries(adapter.collections)) {
    const winners = new Map<string, { row: unknown; stamp: number; json: string; from: string }>();
    const copies = sources.map((source) => ({ ...source, rows: collection.rows(source.snapshot) }));
    for (const source of copies) {
      for (const row of source.rows) {
        const key = collection.key(row);
        const stamp = collection.stamp(row, source.snapshot);
        const json = stableJson(collection.compare ? collection.compare(row) : row);
        const held = winners.get(key);
        if (!held || stamp > held.stamp) {
          winners.set(key, { row, stamp, json, from: source.path });
        } else if (stamp === held.stamp && json !== held.json) {
          problems.push(`${name} ${key} differs between ${held.from} and ${source.path}, and both were last changed at ${stamp}.`);
        }
      }
    }
    const kept = [...winners.entries()];
    if (collection.canDelete && copies.length > 1) {
      const keysByCopy = copies.map(({ path, rows }) => ({ path, keys: new Set(rows.map(collection.key)) }));
      for (const [key, { from }] of kept) {
        const missing = keysByCopy.find(({ keys }) => !keys.has(key));
        if (missing) problems.push(`${name} ${key} is present in ${from} but missing from ${missing.path} (possible deletion).`);
      }
    }
    for (const [index, claim] of Object.entries(collection.claims)) {
      const owners = new Map<string, string>();
      for (const [key, { row }] of kept) {
        if (claim.holds && !claim.holds(row)) continue;
        const value = claim.key(row);
        const other = owners.get(value);
        if (other !== undefined && other !== key) problems.push(`${name} ${other} and ${key} both claim ${value} in ${index}.`);
        owners.set(value, key);
      }
    }
    merged[name] = kept.map(([, { row }]) => row);
  }
  return { merged, problems };
};

export const adoptRecoveredJsonStore = <Snapshot>(activePath: string, fileName: string, adapter: JsonStoreAdapter<Snapshot>): void => {
  const copies = recoveredCopies(fileName);
  if (copies.length === 0) return;
  const active = existsSync(activePath) ? readSource(adapter, activePath, "this SFU's store") : null;
  const sources = [...(active ? [active] : []), ...copies.map((path) => readSource(adapter, path, "a store an older SFU kept in its container"))];
  const { merged, problems } = mergeSources(adapter, sources);
  if (problems.length > 0) {
    throw new Error(
      `Could not combine ${sources.map((source) => source.path).join(", ")} without losing a change:\n- ${problems.join("\n- ")}\nBack up the files and write the reconciled store to ${activePath}, then rename each copy with a .adopted suffix.`,
    );
  }
  const result = adapter.build(active?.snapshot ?? sources[0].snapshot, merged);
  if (!active || stableJson(result) !== stableJson(active.snapshot)) {
    mkdirSync(dirname(activePath), { recursive: true });
    if (active) writePrivateFileAtomic(`${activePath}.premerge-${Date.now()}`, readFileSync(activePath, "utf8"));
    adapter.write(activePath, result);
    if (stableJson(readSource(adapter, activePath, "the combined store").snapshot) !== stableJson(result)) {
      throw new Error(`${activePath} did not read back as the combined store, so the copies were left in place.`);
    }
  }
  for (const path of copies) renameSync(path, `${path}.adopted`);
  Logger.warn(`Combined ${copies.join(", ")} into ${activePath}, the store an older SFU kept in its container`);
};
