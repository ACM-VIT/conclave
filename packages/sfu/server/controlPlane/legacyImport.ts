import { Logger } from "../../utilities/loggers.js";
import type { RedisPersistenceClient } from "../redisPersistence.js";
import type { StoreMode } from "./backends/backend.js";
import {
  claimCopies,
  markAdopted,
  readClaimedCopies,
  readLegacyDomains,
  stillClaimed,
  type HashedLegacyRecord,
  type LegacyPaths,
} from "./legacy.js";
import { hashLegacyValue } from "./legacyHash.js";
import {
  LEGACY_IMPORT_ID,
  PRIMARY_SOURCE,
  appliedKey,
  done,
  domainOf,
  fail,
  legacyCopyKey,
  shadowKey,
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
    completed: current?.completed ?? 0,
    sources: current?.sources ?? {},
    applied: current?.applied ?? {},
  };
  tx.put("legacyImport", next);
  return done(next);
};

export const finishLegacyImport =
  (ticket: number): Command<ImportCounts> =>
  (tx) => {
    const state = currentState(tx);
    if (!state || state.ticket !== ticket) return fail("conflict", STALE);
    tx.put("legacyImport", { ...state, completed: ticket });
    return done(emptyCounts());
  };

const legacyImportState: Query<LegacyImportState | null> = (view) =>
  view.get("legacyImport", LEGACY_IMPORT_ID)?.value ?? null;

type Removed = "new" | "same" | "changed";

const removedHere = (tx: Tx, kind: DataKind, id: string, copy: HashedLegacyRecord): Removed => {
  const removal = tx.get("removal", legacyCopyKey(kind, id))?.value ?? null;
  const matching = removal?.deleted.filter((entry) => entry.identity === copy.identity) ?? [];
  if (matching.length === 0) return "new";
  return matching.some((entry) => entry.hash === copy.hash) ? "same" : "changed";
};

const deletedHere = (tx: Tx, kind: DataKind, id: string, copy: HashedLegacyRecord): Removed => {
  if (tx.tombstone(kind, id) === null) return "new";
  return tx.get("removal", legacyCopyKey(kind, id)) ? removedHere(tx, kind, id, copy) : "changed";
};

const where = (source: string): string => (source === PRIMARY_SOURCE ? "the old store" : `the container copy ${source}`);

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

const reconcileOne = (tx: Tx, source: string, item: LegacyItem, counts: ImportCounts): void => {
  const { kind, id, copy } = item;
  const key = shadowKey(source, kind, id);
  const shadow = tx.get("legacyCopy", key)?.value ?? null;
  const live = tx.get(kind, id);
  const origin = where(source);
  const liveHash = live ? hashLegacyValue(live.value) : null;
  const fromHere = shadow !== null && live !== null && live.legacy !== null && liveHash === shadow.hash;
  if (!copy) {
    if (!shadow) return;
    tx.remove("legacyCopy", key);
    if (!live) return;
    if (fromHere) {
      tx.remove(kind, id);
      counts.deleted += 1;
    } else if (live.legacy === null) {
      conflict(kind, id, `was deleted in ${origin} and changed here since it was imported`, counts);
    }
    return;
  }
  if (shadow && shadow.hash === copy.hash) return;
  tx.put("legacyCopy", { key, source, kind, id, hash: copy.hash, stamp: copy.stamp });
  if (!live) {
    const deleted = deletedHere(tx, kind, id, copy);
    if (deleted === "new") {
      write(tx, copy, counts);
      counts.inserted += 1;
    } else if (deleted === "same") {
      counts.kept += 1;
    } else {
      conflict(kind, id, `was changed in ${origin} and deleted here`, counts);
    }
    return;
  }
  if (liveHash === copy.hash) {
    counts.kept += 1;
    return;
  }
  const removed = removedHere(tx, kind, id, copy);
  if (removed !== "new") {
    if (removed === "same") counts.kept += 1;
    else conflict(kind, id, `was changed in ${origin} and deleted here`, counts);
    return;
  }
  if (!fromHere && live.legacy === null) {
    conflict(kind, id, `was changed in ${origin} and here since it was imported`, counts);
    return;
  }
  if (!fromHere && live.legacy !== null && copy.stamp <= live.legacy) {
    if (copy.stamp === live.legacy) conflict(kind, id, `was changed in ${origin} and in another old store at the same time`, counts);
    else counts.kept += 1;
    return;
  }
  write(tx, copy, counts);
  counts.refreshed += 1;
};

export type SnapshotMark = { key: string; order: string };

export const reconcileLegacy =
  (
    ticket: number,
    domain: LegacyDomain,
    source: string,
    sticky: string | null,
    items: readonly LegacyItem[],
    mark: SnapshotMark | null = null,
  ): Command<ImportCounts> =>
  (tx) => {
    const state = currentState(tx);
    if (!state || state.ticket !== ticket) return fail("conflict", STALE);
    const sources = sticky !== null && state.sources[domain] !== sticky ? { ...state.sources, [domain]: sticky } : state.sources;
    const applied =
      mark && (!(mark.key in state.applied) || state.applied[mark.key] < mark.order)
        ? { ...state.applied, [mark.key]: mark.order }
        : state.applied;
    if (sources !== state.sources || applied !== state.applied) tx.put("legacyImport", { ...state, sources, applied });
    const counts = emptyCounts();
    for (const item of items) reconcileOne(tx, source, item, counts);
    return done(counts);
  };

const shadowsOf =
  (domain: LegacyDomain, source: string): Query<Array<{ kind: DataKind; id: string }>> =>
  (view) =>
    view
      .all("legacyCopy")
      .map((stored) => stored.value)
      .filter((copy) => copy.source === source && domainOf(copy.kind) === domain)
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
  afterClaim?: () => Promise<void>;
  waitMs?: number;
  pollMs?: number;
};

export type LegacyImportResult = Omit<ImportCounts, "notes"> & { sources: string[]; adopted: string[]; superseded: boolean };

const committed = async (store: ControlPlaneStore, command: Command<ImportCounts>): Promise<ImportCounts | null> => {
  const result = await store.commit(command);
  if (result.ok) return result.value;
  if (result.reason === "conflict" && result.message === STALE) return null;
  throw new Error(`Legacy control-plane import failed: ${result.reason} ${result.message ?? ""}`);
};

const DEFAULT_WAIT_MS = 120_000;
const ROUNDS = 3;

const waitForNewerImport = async (store: ControlPlaneStore, ticket: number, waitMs: number, pollMs: number): Promise<void> => {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const state = await store.read(legacyImportState);
    if (state && state.completed > ticket) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Another SFU started a newer legacy import (ticket ${state?.ticket ?? "unknown"}) that did not finish within ${waitMs} ms; this SFU will not serve until one does.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

type RoundResult = {
  ticket: number;
  superseded: boolean;
  counted: ImportCounts;
  sources: string[];
  adopted: string[];
  claimedLeft: boolean;
};

const importRound = async (
  store: ControlPlaneStore,
  options: LegacyImportOptions,
  read: <T>(run: () => Promise<T>) => Promise<T>,
): Promise<RoundResult> => {
  const begun = await store.commit(beginLegacyImport());
  if (!begun.ok) throw new Error(`Legacy control-plane import could not start: ${begun.reason} ${begun.message ?? ""}`);
  const { ticket, sources: sticky } = begun.value;
  const counted = emptyCounts();
  const sources: string[] = [];
  const adopted: string[] = [];
  const claimed = claimCopies(options.paths.fallbackDir, ticket);
  await options.afterClaim?.();
  const recovered = readClaimedCopies(claimed);
  const stopped = (): RoundResult => ({
    ticket,
    superseded: true,
    counted,
    sources,
    adopted,
    claimedLeft: recovered.files.some(stillClaimed),
  });
  const apply = async (
    domain: LegacyDomain,
    source: string,
    label: string | null,
    records: readonly HashedLegacyRecord[],
    mark: SnapshotMark | null,
  ) => {
    const shadows = await store.read(shadowsOf(domain, source));
    const parts = batches(itemsFor(records, shadows));
    if (parts.length === 0 && mark) parts.push([]);
    for (const [index, batch] of parts.entries()) {
      const last = index === parts.length - 1;
      const counts = await committed(store, reconcileLegacy(ticket, domain, source, label, batch, last ? mark : null));
      if (!counts) return false;
      add(counted, counts);
    }
    return true;
  };
  const domains = await read(() => readLegacyDomains({ mode: options.mode, paths: options.paths, redis: options.redis, sticky }));
  for (const domain of domains) {
    if (!domain.source || !domain.records) continue;
    sources.push(`${domain.source} ${domain.domain}`);
    if (!(await apply(domain.domain, PRIMARY_SOURCE, domain.source, domain.records, null))) return stopped();
  }
  for (const snapshot of recovered.snapshots) {
    const key = appliedKey(snapshot.source, snapshot.domain);
    const state = await store.read(legacyImportState);
    if (state && key in state.applied && snapshot.order <= state.applied[key]) continue;
    if (!(await apply(snapshot.domain, snapshot.source, null, snapshot.records, { key, order: snapshot.order }))) return stopped();
  }
  if (!(await committed(store, finishLegacyImport(ticket)))) return stopped();
  for (const file of recovered.files) {
    const target = markAdopted(file);
    if (target) adopted.push(target);
  }
  return { ticket, superseded: false, counted, sources, adopted, claimedLeft: false };
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
  const waitMs = options.waitMs ?? (Number(process.env.CONTROL_PLANE_LEGACY_IMPORT_WAIT_MS) || DEFAULT_WAIT_MS);
  for (let round = 0; round < ROUNDS; round += 1) {
    const result = await importRound(store, options, read);
    add(counted, { ...result.counted, notes: [] });
    sources.push(...result.sources.filter((source) => !sources.includes(source)));
    adopted.push(...result.adopted);
    if (!result.superseded) return total();
    superseded = true;
    await waitForNewerImport(store, result.ticket, waitMs, options.pollMs ?? 200);
    if (!result.claimedLeft) return total();
  }
  throw new Error(`The legacy import was superseded ${ROUNDS} times while it still held copies older SFUs kept; restart the SFU.`);
};
