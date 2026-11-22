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

/**
 * How many rows the store handles in bulk for the cost of one row a handler
 * touches itself. A bulk row is cheap, but not free.
 */
const BULK_ROWS_PER_OP = 64;

const DELETED = Symbol("deleted");
type Staged = Row | typeof DELETED;

/**
 * What a transaction cleared in one table: whole groups, and prefixes longer
 * than a group. None is inside another. Groups are the common case, a
 * parent's rows, and are looked up in one step.
 */
type Cleared = { groups: Set<string>; longer: TableKey[] };

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

  countUnder(prefix: TableKey | undefined): number {
    if (prefix === undefined) return this.rows.size;
    const group = this.groups.get(keyGroup(prefix));
    if (!group) return 0;
    if (keyGroup(prefix) === prefix) return group.size;
    let count = 0;
    for (const key of group) if (keyHasPrefix(key, prefix)) count += 1;
    return count;
  }

  /** Removes every row under `prefix` and returns the keys it removed. */
  deleteUnder(prefix: TableKey): TableKey[] {
    const groupId = keyGroup(prefix);
    const group = this.groups.get(groupId);
    if (!group) return [];
    const keys =
      groupId === prefix
        ? [...group]
        : [...group].filter((key) => keyHasPrefix(key, prefix));
    for (const key of keys) this.rows.delete(key);
    if (keys.length === group.size) this.groups.delete(groupId);
    else for (const key of keys) group.delete(key);
    return keys;
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
  /**
   * Rows a `clear` removed that the views have not been told of yet, oldest
   * clear first. They are gone from the tables already. `next` is how far
   * into `keys` the views have been told.
   */
  private readonly cleared: { table: string; keys: TableKey[]; next: number }[] = [];

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

  /**
   * Hands over the rows written since the last call and forgets them, along
   * with the next batch of rows a `clear` removed.
   */
  takeDirty(): Map<string, Set<TableKey>> {
    // At least one row, or a clear would never finish being told.
    let room = Math.max(1, this.limits.clearedRowsPerFlush);
    while (room > 0 && this.cleared.length > 0) {
      const batch = this.cleared[0];
      const keys = batch.keys.slice(batch.next, batch.next + room);
      for (const key of keys) this.markDirty(batch.table, key);
      batch.next += keys.length;
      room -= keys.length;
      if (batch.next >= batch.keys.length) this.cleared.shift();
    }
    const taken = new Map(this.dirty);
    this.dirty.clear();
    return taken;
  }

  get hasDirty(): boolean {
    return this.dirty.size > 0 || this.cleared.length > 0;
  }

  /** Whether a `clear` removed rows the views still hold. */
  get hasUntoldClears(): boolean {
    return this.cleared.length > 0;
  }

  private markDirty(table: string, key: TableKey): void {
    const dirty = this.dirty.get(table);
    if (dirty) dirty.add(key);
    else this.dirty.set(table, new Set([key]));
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
    // Clears first: what a handler wrote under a prefix after clearing it stays.
    for (const [tableName, cleared] of draft.clears) {
      const table = this.table(tableName);
      for (const prefix of [...cleared.groups, ...cleared.longer] as TableKey[]) {
        const keys = table.deleteUnder(prefix);
        if (keys.length === 0) continue;
        changed = true;
        this.cleared.push({ table: tableName, keys, next: 0 });
      }
    }
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
        this.markDirty(tableName, key);
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
  /**
   * What was cleared so far, by table. A staged write is always newer than
   * the clear that covers its key: clearing drops the staged writes under it.
   */
  readonly clears = new Map<string, Cleared>();
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

  /** Whether a committed row with this key was cleared in this transaction. */
  private isCleared(table: string, key: TableKey): boolean {
    const cleared = this.clears.get(table);
    if (!cleared) return false;
    return (
      cleared.groups.has(keyGroup(key)) ||
      cleared.longer.some((prefix) => keyHasPrefix(key, prefix))
    );
  }

  get(table: string, key: TableKey): Row | undefined {
    this.spend();
    const staged = this.staged(table, key);
    if (staged !== undefined) return staged === DELETED ? undefined : staged;
    return this.isCleared(table, key) ? undefined : this.store.get(table, key);
  }

  count(table: string, prefix?: TableKey): number {
    this.spend();
    return this.liveCount(table, prefix);
  }

  /** Rows a read sees under `prefix`: committed and not cleared, or staged. */
  private liveCount(table: string, prefix?: TableKey): number {
    const committed = this.store.table(table);
    let total = committed.countUnder(prefix);
    const cleared = this.clears.get(table);
    for (const gone of [...(cleared?.groups ?? []), ...(cleared?.longer ?? [])] as TableKey[]) {
      if (prefix === undefined || keyHasPrefix(gone, prefix)) {
        total -= committed.countUnder(gone);
      } else if (keyHasPrefix(prefix, gone)) {
        total = 0;
      }
    }
    for (const [key, staged] of this.writes.get(table) ?? []) {
      if (prefix !== undefined && !keyHasPrefix(key, prefix)) continue;
      const exists = committed.rows.has(key) && !this.isCleared(table, key);
      if (staged === DELETED && exists) total -= 1;
      if (staged !== DELETED && !exists) total += 1;
    }
    return total;
  }

  scan(table: string, prefix?: TableKey): readonly (readonly [TableKey, Row])[] {
    const committed = this.store.table(table);
    const writes = this.writes.get(table);
    const result: (readonly [TableKey, Row])[] = [];
    let passedOver = 0;
    for (const key of committed.keysUnder(prefix)) {
      // A cleared row written again is a new row, and comes last.
      if (this.isCleared(table, key)) {
        passedOver += 1;
        continue;
      }
      const staged = writes?.get(key);
      if (staged === DELETED) continue;
      const row = staged ?? committed.rows.get(key);
      if (row) result.push([key, row]);
    }
    for (const [key, staged] of writes ?? []) {
      if (staged === DELETED) continue;
      if (committed.rows.has(key) && !this.isCleared(table, key)) continue;
      if (prefix !== undefined && !keyHasPrefix(key, prefix)) continue;
      result.push([key, staged]);
    }
    this.spend(result.length + 1 + Math.floor(passedOver / BULK_ROWS_PER_OP));
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

  clear(table: string, prefix: TableKey): number {
    const removed = this.liveCount(table, prefix);
    const writes = this.writes.get(table);
    for (const key of [...(writes?.keys() ?? [])]) {
      if (keyHasPrefix(key, prefix)) writes?.delete(key);
    }
    const cleared = this.clears.get(table) ?? { groups: new Set(), longer: [] };
    this.clears.set(table, cleared);
    if (!this.isCleared(table, prefix)) {
      // The new prefix takes the place of any cleared before that lie inside it.
      cleared.longer = cleared.longer.filter((held) => !keyHasPrefix(held, prefix));
      if (keyGroup(prefix) === prefix) cleared.groups.add(prefix);
      else cleared.longer.push(prefix);
    }
    this.spend(1 + Math.floor(removed / BULK_ROWS_PER_OP));
    return removed;
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
