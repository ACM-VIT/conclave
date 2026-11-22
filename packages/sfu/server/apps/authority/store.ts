import { boundedJsonBytes } from "@conclave/apps-sdk/authority";
import {
  AuthorityRejection,
  keyGroup,
  keyHasPrefix,
  type RuntimeDefinition,
  type RuntimeRead,
  type RuntimeTransaction,
  type TableKey,
} from "@conclave/apps-sdk/authority/server";
import type { AuthorityLimits } from "./limits.js";

type Row = object;

export type TimerEntry = {
  kind: string;
  key: TableKey;
  atMs: number;
  payload: unknown;
};

/** A bound the host enforces was hit: a full table, an oversized row. */
export class AuthorityCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityCapacityError";
  }
}

export type TransactionOutcome<R> =
  | { ok: true; value: R; changed: boolean }
  | { ok: false; kind: "rejected"; reason: string }
  | { ok: false; kind: "capacity"; message: string }
  | { ok: false; kind: "fault"; error: unknown };

const DELETED = Symbol("deleted");
type Staged = Row | typeof DELETED;

const deepFreeze = (value: unknown): void => {
  if (value === null || typeof value !== "object") return;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
};

/**
 * The row as the store keeps it: a private copy, frozen at once. A handler
 * that keeps its own reference cannot grow the row past the size it was
 * checked at, or change it after it is staged.
 */
const sealed = (row: Row): Row => {
  const copy = JSON.parse(JSON.stringify(row)) as Row;
  deepFreeze(copy);
  return copy;
};

class TableStore {
  /** Insertion order is scan order. */
  readonly rows = new Map<TableKey, Row>();
  /** First key part to the keys under it, so a prefix scan skips the rest. */
  private readonly groups = new Map<string, Set<TableKey>>();

  keysUnder(prefix: TableKey | undefined): Iterable<TableKey> {
    if (prefix === undefined) return this.rows.keys();
    const group = this.groups.get(keyGroup(prefix));
    if (!group) return [];
    if (keyGroup(prefix) === prefix) return group;
    return [...group].filter((key) => keyHasPrefix(key, prefix));
  }

  set(key: TableKey, row: Row): void {
    if (!this.rows.has(key)) {
      const groupId = keyGroup(key);
      const group = this.groups.get(groupId);
      if (group) group.add(key);
      else this.groups.set(groupId, new Set([key]));
    }
    this.rows.set(key, row);
  }

  delete(key: TableKey): void {
    if (!this.rows.delete(key)) return;
    const groupId = keyGroup(key);
    const group = this.groups.get(groupId);
    group?.delete(key);
    if (group?.size === 0) this.groups.delete(groupId);
  }
}

/**
 * One app's private rows and timers in one room. The single writer: every
 * change goes through `transact`, which runs to completion before the next
 * starts, so a check and the write that depends on it never interleave with
 * anyone else's.
 */
export class AuthorityStore {
  private readonly tables = new Map<string, TableStore>();
  private readonly timers = new Map<TableKey, TimerEntry>();
  /** Rows written since the views last caught up, by table. */
  private readonly dirty = new Map<string, Set<TableKey>>();

  constructor(
    private readonly definition: RuntimeDefinition,
    private readonly limits: AuthorityLimits,
  ) {
    for (const name of Object.keys(definition.tables)) {
      this.tables.set(name, new TableStore());
    }
  }

  table(name: string): TableStore {
    const table = this.tables.get(name);
    if (!table) throw new Error(`Unknown table "${name}"`);
    return table;
  }

  get(table: string, key: TableKey): Row | undefined {
    return this.table(table).rows.get(key);
  }

  rows(table: string): ReadonlyMap<TableKey, Row> {
    return this.table(table).rows;
  }

  /** Hands over the rows written since the last call and forgets them. */
  takeDirty(): Map<string, Set<TableKey>> {
    const taken = new Map(this.dirty);
    this.dirty.clear();
    return taken;
  }

  get hasDirty(): boolean {
    return this.dirty.size > 0;
  }

  nextTimerAt(): number | null {
    let earliest: number | null = null;
    for (const timer of this.timers.values()) {
      if (earliest === null || timer.atMs < earliest) earliest = timer.atMs;
    }
    return earliest;
  }

  /** Due timers, earliest first, at most `limit`. */
  dueTimers(now: number, limit: number): TimerEntry[] {
    const due = [...this.timers.values()].filter((timer) => timer.atMs <= now);
    due.sort((a, b) => a.atMs - b.atMs);
    return due.slice(0, limit);
  }

  hasTimer(key: TableKey): boolean {
    return this.timers.has(key);
  }

  transact<R>(run: (tx: RuntimeTransaction) => R): TransactionOutcome<R> {
    return this.execute(run, true);
  }

  /** Runs a read against the committed rows. Nothing it stages is kept. */
  read<R>(run: (db: RuntimeRead) => R): TransactionOutcome<R> {
    return this.execute(run, false);
  }

  private execute<R>(
    run: (tx: RuntimeTransaction) => R,
    commit: boolean,
  ): TransactionOutcome<R> {
    const draft = new Draft(this, this.definition, this.limits);
    let value: R;
    try {
      value = run(draft);
    } catch (error) {
      if (error instanceof AuthorityRejection) {
        return { ok: false, kind: "rejected", reason: error.reason };
      }
      if (error instanceof AuthorityCapacityError) {
        return { ok: false, kind: "capacity", message: error.message };
      }
      return { ok: false, kind: "fault", error };
    }
    return { ok: true, value, changed: commit ? this.commit(draft) : false };
  }

  private commit(draft: Draft): boolean {
    let changed = false;
    for (const [tableName, writes] of draft.writes) {
      const table = this.table(tableName);
      for (const [key, staged] of writes) {
        if (staged === DELETED) {
          if (!table.rows.has(key)) continue;
          table.delete(key);
        } else {
          table.set(key, staged);
        }
        changed = true;
        const dirty = this.dirty.get(tableName);
        if (dirty) dirty.add(key);
        else this.dirty.set(tableName, new Set([key]));
      }
    }
    for (const [key, staged] of draft.timerWrites) {
      if (staged === DELETED) this.timers.delete(key);
      else this.timers.set(key, staged);
      changed = true;
    }
    return changed;
  }

  committedTimer(key: TableKey): TimerEntry | undefined {
    return this.timers.get(key);
  }

  get timerCount(): number {
    return this.timers.size;
  }
}

/** Staged writes with read-your-writes. Dropped whole on any throw. */
class Draft implements RuntimeTransaction {
  readonly writes = new Map<string, Map<TableKey, Staged>>();
  readonly timerWrites = new Map<TableKey, TimerEntry | typeof DELETED>();
  private ops = 0;

  constructor(
    private readonly store: AuthorityStore,
    private readonly definition: RuntimeDefinition,
    private readonly limits: AuthorityLimits,
  ) {}

  private spend(cost = 1): void {
    this.ops += cost;
    if (this.ops > this.limits.transactionOps) {
      throw new Error("Transaction exceeded its operation budget");
    }
  }

  private staged(table: string, key: TableKey): Staged | undefined {
    return this.writes.get(table)?.get(key);
  }

  private stage(table: string, key: TableKey, value: Staged): void {
    const writes = this.writes.get(table);
    if (writes) writes.set(key, value);
    else this.writes.set(table, new Map([[key, value]]));
  }

  get(table: string, key: TableKey): Row | undefined {
    this.spend();
    const staged = this.staged(table, key);
    if (staged !== undefined) return staged === DELETED ? undefined : staged;
    return this.store.get(table, key);
  }

  count(table: string, prefix?: TableKey): number {
    this.spend();
    const committed = this.store.table(table);
    let total = 0;
    if (prefix === undefined) total = committed.rows.size;
    else for (const _key of committed.keysUnder(prefix)) total += 1;
    for (const [key, staged] of this.writes.get(table) ?? []) {
      if (prefix !== undefined && !keyHasPrefix(key, prefix)) continue;
      const exists = committed.rows.has(key);
      if (staged === DELETED && exists) total -= 1;
      if (staged !== DELETED && !exists) total += 1;
    }
    return total;
  }

  scan(table: string, prefix?: TableKey): readonly (readonly [TableKey, Row])[] {
    const committed = this.store.table(table);
    const writes = this.writes.get(table);
    const result: (readonly [TableKey, Row])[] = [];
    for (const key of committed.keysUnder(prefix)) {
      const staged = writes?.get(key);
      if (staged === DELETED) continue;
      const row = staged ?? committed.rows.get(key);
      if (row) result.push([key, row]);
    }
    for (const [key, staged] of writes ?? []) {
      if (staged === DELETED || committed.rows.has(key)) continue;
      if (prefix !== undefined && !keyHasPrefix(key, prefix)) continue;
      result.push([key, staged]);
    }
    this.spend(result.length + 1);
    return result;
  }

  private write(table: string, key: TableKey, row: Row): void {
    const spec = this.definition.tables[table];
    if (!spec) throw new Error(`Unknown table "${table}"`);
    if (boundedJsonBytes(row, spec.maxRowBytes) > spec.maxRowBytes) {
      throw new AuthorityCapacityError(`A row in ${table} is too large`);
    }
    const isNew = this.get(table, key) === undefined;
    if (isNew && this.count(table) >= spec.maxRows) {
      throw new AuthorityCapacityError(`Table ${table} is full`);
    }
    this.stage(table, key, sealed(row));
  }

  insertIfAbsent(table: string, key: TableKey, row: Row): "inserted" | "exists" {
    if (this.get(table, key) !== undefined) return "exists";
    this.write(table, key, row);
    return "inserted";
  }

  put(table: string, key: TableKey, row: Row): void {
    this.write(table, key, row);
  }

  delete(table: string, key: TableKey): boolean {
    if (this.get(table, key) === undefined) return false;
    this.stage(table, key, DELETED);
    return true;
  }

  private timerExists(key: TableKey): boolean {
    const staged = this.timerWrites.get(key);
    if (staged !== undefined) return staged !== DELETED;
    return this.store.hasTimer(key);
  }

  schedule(kind: string, key: TableKey, atMs: number, payload: unknown): void {
    this.spend();
    const schema = this.definition.timers[kind];
    if (!schema) throw new Error(`Unknown timer "${kind}"`);
    if (!Number.isFinite(atMs)) throw new Error("A timer needs a due time");
    if (!this.timerExists(key)) {
      let pending = this.store.timerCount;
      for (const [stagedKey, staged] of this.timerWrites) {
        const exists = this.store.hasTimer(stagedKey);
        if (staged === DELETED && exists) pending -= 1;
        if (staged !== DELETED && !exists) pending += 1;
      }
      if (pending >= this.limits.timersPerInstance) {
        throw new AuthorityCapacityError("Too many timers");
      }
    }
    this.timerWrites.set(key, {
      kind,
      key,
      atMs,
      payload: schema.parse(payload, "strict", `timer ${kind}`),
    });
  }

  cancelTimer(key: TableKey): boolean {
    this.spend();
    if (!this.timerExists(key)) return false;
    this.timerWrites.set(key, DELETED);
    return true;
  }
}
