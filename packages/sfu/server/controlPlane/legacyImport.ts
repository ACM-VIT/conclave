import { existsSync, renameSync } from "node:fs";
import { Logger } from "../../utilities/loggers.js";
import type { RedisPersistenceClient } from "../redisPersistence.js";
import type { StoreMode } from "./backends/backend.js";
import {
  readLegacyDomains,
  readRecoveredCopies,
  type HashedLegacyRecord,
  type LegacyPaths,
  type RecoveredRecord,
} from "./legacy.js";
import { hashLegacyValue } from "./legacyHash.js";
import {
  LEGACY_IMPORT_ID,
  done,
  domainOf,
  fail,
  legacyCopyKey,
  type DataKind,
  type LegacyDomain,
  type LegacyImportState,
} from "./model.js";
import type { ControlPlaneStore } from "./store.js";
import type { Command, Query, Tx } from "./tx.js";

export type LegacyItem = { kind: DataKind; id: string; copy: HashedLegacyRecord | null };

export type ImportCounts = {
  inserted: number;
  refreshed: number;
  deleted: number;
  kept: number;
  conflicts: number;
  unindexed: number;
  notes: string[];
};

const COUNTED = ["inserted", "refreshed", "deleted", "kept", "conflicts", "unindexed"] as const;

const STALE = "A newer legacy import has started.";

const emptyCounts = (): ImportCounts => ({
  inserted: 0,
  refreshed: 0,
  deleted: 0,
  kept: 0,
  conflicts: 0,
  unindexed: 0,
  notes: [],
});

const add = (total: ImportCounts, part: ImportCounts): void => {
  for (const field of COUNTED) total[field] += part[field];
  for (const note of part.notes) Logger.warn(note);
};

const currentState = (tx: Tx): LegacyImportState | null => tx.get("legacyImport", LEGACY_IMPORT_ID)?.value ?? null;

export const beginLegacyImport = (): Command<LegacyImportState> => (tx) => {
  const current = currentState(tx);
  const next: LegacyImportState = {
    id: LEGACY_IMPORT_ID,
    ticket: (current?.ticket ?? 0) + 1,
    sources: current?.sources ?? {},
  };
  tx.put("legacyImport", next);
  return done(next);
};

const conflict = (kind: DataKind, id: string, what: string, counts: ImportCounts): void => {
  counts.conflicts += 1;
  counts.notes.push(`[ControlPlane] legacy ${kind} ${id} ${what}; kept this store's version`);
};

const write = (tx: Tx, record: HashedLegacyRecord, counts: ImportCounts): void => {
  const skipped = tx.importLegacy(record.kind, record.value, record.stamp);
  if (skipped.length === 0) return;
  counts.unindexed += 1;
  counts.notes.push(`[ControlPlane] legacy ${record.key} kept without ${skipped.join(", ")}: another record already holds it`);
};

const reconcileOne = (tx: Tx, item: LegacyItem, counts: ImportCounts): void => {
  const { kind, id, copy } = item;
  const key = legacyCopyKey(kind, id);
  const shadow = tx.get("legacyCopy", key)?.value ?? null;
  const live = tx.get(kind, id);
  if (!copy) {
    if (!shadow) return;
    tx.remove("legacyCopy", key);
    if (!live) return;
    if (live.legacy !== null) {
      tx.remove(kind, id);
      counts.deleted += 1;
      return;
    }
    conflict(kind, id, "was deleted in the old store and changed here since it was imported", counts);
    return;
  }
  if (shadow && shadow.hash === copy.hash) return;
  tx.put("legacyCopy", { key, kind, id, hash: copy.hash, stamp: copy.stamp });
  if (!live) {
    if (tx.tombstone(kind, id) !== null) {
      conflict(kind, id, "was changed in the old store and deleted here", counts);
      return;
    }
    write(tx, copy, counts);
    counts.inserted += 1;
    return;
  }
  if (hashLegacyValue(live.value) === copy.hash) {
    counts.kept += 1;
    return;
  }
  if (live.legacy === null) {
    conflict(kind, id, "was changed in the old store and here since it was imported", counts);
    return;
  }
  if (!shadow && copy.stamp <= live.legacy) {
    counts.kept += 1;
    return;
  }
  write(tx, copy, counts);
  counts.refreshed += 1;
};

export const reconcileLegacy =
  (ticket: number, domain: LegacyDomain, source: string, items: readonly LegacyItem[]): Command<ImportCounts> =>
  (tx) => {
    const state = currentState(tx);
    if (!state || state.ticket !== ticket) return fail("conflict", STALE);
    if (state.sources[domain] !== source) {
      tx.put("legacyImport", { ...state, sources: { ...state.sources, [domain]: source } });
    }
    const counts = emptyCounts();
    for (const item of items) reconcileOne(tx, item, counts);
    return done(counts);
  };

const adoptOne = (tx: Tx, record: RecoveredRecord, counts: ImportCounts): void => {
  const { kind, id } = record;
  const live = tx.get(kind, id);
  if (live && hashLegacyValue(live.value) === record.hash) {
    counts.kept += 1;
    return;
  }
  const shadow = tx.get("legacyCopy", record.key)?.value ?? null;
  const superseded = shadow !== null && (record.hash === shadow.hash || record.stamp < shadow.stamp);
  if (!live) {
    if (tx.tombstone(kind, id) === null) {
      write(tx, record, counts);
      counts.inserted += 1;
    } else if (superseded) {
      counts.kept += 1;
    } else {
      conflict(kind, id, `is in ${record.from} but was deleted here`, counts);
    }
    return;
  }
  if (live.legacy !== null && record.stamp !== live.legacy) {
    if (record.stamp > live.legacy) {
      write(tx, record, counts);
      counts.refreshed += 1;
    } else {
      counts.kept += 1;
    }
    return;
  }
  if (superseded) {
    counts.kept += 1;
    return;
  }
  conflict(kind, id, `differs between ${record.from} and this store`, counts);
};

export const adoptRecovered =
  (ticket: number, records: readonly RecoveredRecord[]): Command<ImportCounts> =>
  (tx) => {
    const state = currentState(tx);
    if (!state || state.ticket !== ticket) return fail("conflict", STALE);
    const counts = emptyCounts();
    for (const record of records) adoptOne(tx, record, counts);
    return done(counts);
  };

const shadowsOf =
  (domain: LegacyDomain): Query<Array<{ kind: DataKind; id: string }>> =>
  (view) =>
    view
      .all("legacyCopy")
      .map((stored) => stored.value)
      .filter((copy) => domainOf(copy.kind) === domain)
      .map((copy) => ({ kind: copy.kind, id: copy.id }));

const IMPORT_BATCH = 50;

const batches = <T>(items: readonly T[]): T[][] => {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += IMPORT_BATCH) result.push(items.slice(start, start + IMPORT_BATCH));
  return result;
};

const newestFirst = (a: { stamp: number }, b: { stamp: number }): number => b.stamp - a.stamp;

const itemsFor = (records: readonly HashedLegacyRecord[], shadows: Array<{ kind: DataKind; id: string }>): LegacyItem[] => {
  const present = new Set(records.map((record) => record.key));
  const gone: LegacyItem[] = shadows
    .filter((shadow) => !present.has(legacyCopyKey(shadow.kind, shadow.id)))
    .map((shadow) => ({ kind: shadow.kind, id: shadow.id, copy: null }));
  const current: LegacyItem[] = [...records]
    .sort(newestFirst)
    .map((record) => ({ kind: record.kind, id: record.id, copy: record }));
  return [...gone, ...current];
};

export type LegacyImportOptions = {
  mode: StoreMode;
  paths: LegacyPaths;
  redis?: { client: RedisPersistenceClient; prefix: string };
  read?: <T>(read: () => Promise<T>) => Promise<T>;
};

export type LegacyImportResult = Omit<ImportCounts, "notes"> & { sources: string[]; adopted: string[]; superseded: boolean };

const committed = async (store: ControlPlaneStore, command: Command<ImportCounts>): Promise<ImportCounts | null> => {
  const result = await store.commit(command);
  if (result.ok) return result.value;
  if (result.reason === "conflict" && result.message === STALE) return null;
  throw new Error(`Legacy control-plane import failed: ${result.reason} ${result.message ?? ""}`);
};

export const runLegacyImport = async (
  store: ControlPlaneStore,
  options: LegacyImportOptions,
): Promise<LegacyImportResult> => {
  const counted = emptyCounts();
  const sources: string[] = [];
  const adopted: string[] = [];
  let superseded = false;
  const total = (): LegacyImportResult => ({
    inserted: counted.inserted,
    refreshed: counted.refreshed,
    deleted: counted.deleted,
    kept: counted.kept,
    conflicts: counted.conflicts,
    unindexed: counted.unindexed,
    sources,
    adopted,
    superseded,
  });
  if (options.mode === "memory") return total();
  const read = options.read ?? (<T>(run: () => Promise<T>) => run());
  const begun = await store.commit(beginLegacyImport());
  if (!begun.ok) throw new Error(`Legacy control-plane import could not start: ${begun.reason} ${begun.message ?? ""}`);
  const { ticket, sources: sticky } = begun.value;
  const domains = await read(() => readLegacyDomains({ mode: options.mode, paths: options.paths, redis: options.redis, sticky }));
  const recovered = readRecoveredCopies(options.paths.fallbackDir);
  for (const domain of domains) {
    if (!domain.source || !domain.records) continue;
    sources.push(`${domain.source} ${domain.domain}`);
    const shadows = await store.read(shadowsOf(domain.domain));
    for (const batch of batches(itemsFor(domain.records, shadows))) {
      const counts = await committed(store, reconcileLegacy(ticket, domain.domain, domain.source, batch));
      if (!counts) {
        superseded = true;
        return total();
      }
      add(counted, counts);
    }
  }
  for (const batch of batches([...recovered.records].sort(newestFirst))) {
    const counts = await committed(store, adoptRecovered(ticket, batch));
    if (!counts) {
      superseded = true;
      return total();
    }
    add(counted, counts);
  }
  for (const path of recovered.files) {
    if (!existsSync(path)) continue;
    try {
      renameSync(path, `${path}.adopted`);
      adopted.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return total();
};
