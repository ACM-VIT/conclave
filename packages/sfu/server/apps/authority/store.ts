import { boundedJsonBytes } from "@conclave/apps-sdk/authority";
import {
  AuthorityRejection,
  keyHasPrefix,
  keyPrefixes,
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
  /**
   * Every prefix with rows under it, to those rows' keys in the order they
   * were written. A row whose own key is such a prefix is in its set too.
   * Reading, counting or clearing under any prefix therefore costs the rows
   * it holds and nothing more, whatever else shares the first part of the
   * key. A prefix with no set holds at most the row of its own key.
   */
  private readonly under = new Map<TableKey, Set<TableKey>>();

  keysUnder(prefix: TableKey | undefined): Iterable<TableKey> {
    if (prefix === undefined) return this.rows.keys();
    return this.under.get(prefix) ?? (this.rows.has(prefix) ? [prefix] : []);
  }

  countUnder(prefix: TableKey | undefined): number {
    if (prefix === undefined) return this.rows.size;
    return this.under.get(prefix)?.size ?? (this.rows.has(prefix) ? 1 : 0);
  }

  set(key: TableKey, row: Row): void {
    if (!this.rows.has(key)) {
      for (const prefix of keyPrefixes(key)) {
        let keys = this.under.get(prefix);
        if (!keys) {
          // A row already written under the prefix's own key came first.
          keys = new Set(this.rows.has(prefix) ? [prefix] : []);
          this.under.set(prefix, keys);
        }
        keys.add(key);
      }
      // The key is itself the prefix of rows written before it.
      this.under.get(key)?.add(key);
    }
    this.rows.set(key, row);
  }

  delete(key: TableKey): void {
    if (!this.rows.delete(key)) return;
    this.under.get(key)?.delete(key);
    for (const prefix of keyPrefixes(key)) {
      const keys = this.under.get(prefix);
      if (!keys) continue;
      keys.delete(key);
      // Nothing is left under it but, at most, the row of its own key.
      if (keys.size === 0 || (keys.size === 1 && keys.has(prefix))) {
        this.under.delete(prefix);
      }
    }
  }

  /** Removes every row under `prefix` and returns the keys it removed. */
  deleteUnder(prefix: TableKey): TableKey[] {
    const keys = [...this.keysUnder(prefix)];
    for (const key of keys) this.delete(key);
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
   * Rows a `clear` removed that the views have not taken in yet, by table.
   * They are kept apart from `dirty` because the views treat them
   * differently: a cleared row leaves the views before anything is read
   * from them again, and its viewers are told later.
   */
  private readonly cleared = new Map<string, TableKey[]>();

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

  /** The rows written since the views last took them in, left in place. */
  get dirtyRows(): ReadonlyMap<string, ReadonlySet<TableKey>> {
    return this.dirty;
  }

  /** The rows cleared since the views last took them in, left in place. */
  get clearedRows(): ReadonlyMap<string, readonly TableKey[]> {
    return this.cleared;
  }

  /** Hands over the rows written since the last call and forgets them. */
  takeDirty(): Map<string, Set<TableKey>> {
    const taken = new Map(this.dirty);
    this.dirty.clear();
    return taken;
  }

  /** Hands over the rows cleared since the last call and forgets them. */
  takeCleared(): Map<string, TableKey[]> {
    const taken = new Map(this.cleared);
    this.cleared.clear();
    return taken;
  }

  get hasCleared(): boolean {
    return this.cleared.size > 0;
  }

  get hasDirty(): boolean {
    return this.dirty.size > 0 || this.cleared.size > 0;
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
      // Out of budget is a fault whatever the handler threw on its way out.
      if (draft.overBudget) return { ok: false, kind: "fault", error: draft.overBudget };
      if (error instanceof AuthorityRejection) {
        return { ok: false, kind: "rejected", reason: error.reason };
      }
      if (error instanceof AuthorityCapacityError) {
        return { ok: false, kind: "capacity", message: error.message };
      }
      return { ok: false, kind: "fault", error };
    }
    // A handler that caught the budget error and returned all the same did
    // not get the work it asked for. Nothing it staged is kept.
    if (draft.overBudget) return { ok: false, kind: "fault", error: draft.overBudget };
    return { ok: true, value, changed: commit ? this.commit(draft) : false };
  }

  private commit(draft: Draft): boolean {
    let changed = false;
    // Clears first: what a handler wrote under a prefix after clearing it stays.
    for (const [tableName, prefixes] of draft.clears) {
      const table = this.table(tableName);
      for (const prefix of prefixes) {
        const keys = table.deleteUnder(prefix);
        if (keys.length === 0) continue;
        changed = true;
        const cleared = this.cleared.get(tableName);
        // One at a time: a clear can be too large to spread into one call.
        if (cleared) for (const key of keys) cleared.push(key);
        else this.cleared.set(tableName, keys);
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

/**
 * Staged writes with read-your-writes. Dropped whole on any throw, and
 * dropped whole once the budget is spent, whatever the handler does next.
 */
class Draft implements RuntimeTransaction {
  readonly writes = new Map<string, Map<TableKey, Staged>>();
  /**
   * Prefixes cleared so far, by table, none of them inside another. A staged
   * write is always newer than the clear that covers its key: clearing drops
   * the staged writes under it.
   */
  readonly clears = new Map<string, Set<TableKey>>();
  readonly timerWrites = new Map<TableKey, TimerEntry | typeof DELETED>();
  /** Set once the budget is spent. The transaction can no longer commit. */
  overBudget: Error | null = null;
  private ops = 0;
  /** Rows each touched table holds as this transaction sees it. */
  private readonly rowCounts = new Map<string, number>();

  constructor(
    private readonly store: AuthorityStore,
    private readonly definition: RuntimeDefinition,
    private readonly limits: AuthorityLimits,
  ) {}

  /**
   * Charges work to the transaction. Every call is made before the work it
   * pays for takes effect, so a transaction that runs out has staged nothing
   * it could not afford.
   */
  private spend(cost = 1): void {
    this.ops += cost;
    if (this.overBudget || this.ops > this.limits.transactionOps) {
      this.overBudget ??= new Error("Transaction exceeded its operation budget");
      throw this.overBudget;
    }
  }

  /** The cost of passing over rows without handing them to the handler. */
  private spendOnWalk(rows: number): void {
    const cost = Math.floor(rows / BULK_ROWS_PER_OP);
    if (cost > 0) this.spend(cost);
  }

  private staged(table: string, key: TableKey): Staged | undefined {
    return this.writes.get(table)?.get(key);
  }

  /** The row a read sees, at no charge. */
  private peek(table: string, key: TableKey): Row | undefined {
    const staged = this.staged(table, key);
    if (staged !== undefined) return staged === DELETED ? undefined : staged;
    return this.isCleared(table, key) ? undefined : this.store.get(table, key);
  }

  private rowCount(table: string): number {
    return this.rowCounts.get(table) ?? this.store.table(table).rows.size;
  }

  private stage(table: string, key: TableKey, value: Staged): void {
    const existed = this.peek(table, key) !== undefined;
    const writes = this.writes.get(table);
    if (writes) writes.set(key, value);
    else this.writes.set(table, new Map([[key, value]]));
    const exists = value !== DELETED;
    if (existed !== exists) {
      this.rowCounts.set(table, this.rowCount(table) + (exists ? 1 : -1));
    }
  }

  /** Whether a committed row with this key was cleared in this transaction. */
  private isCleared(table: string, key: TableKey): boolean {
    const cleared = this.clears.get(table);
    if (!cleared) return false;
    return cleared.has(key) || keyPrefixes(key).some((prefix) => cleared.has(prefix));
  }

  get(table: string, key: TableKey): Row | undefined {
    this.spend();
    return this.peek(table, key);
  }

  count(table: string, prefix?: TableKey): number {
    this.spend();
    return prefix === undefined ? this.rowCount(table) : this.countUnder(table, prefix);
  }

  /**
   * Rows a read sees under `prefix`: committed and not cleared, or staged.
   * The committed part comes off the index. The staged writes and the
   * clears have to be walked, and that walk is charged.
   */
  private countUnder(table: string, prefix: TableKey): number {
    const committed = this.store.table(table);
    const cleared = this.clears.get(table);
    const writes = this.writes.get(table);
    this.spendOnWalk((cleared?.size ?? 0) + (writes?.size ?? 0));

    let total = 0;
    if (!this.isCleared(table, prefix)) {
      total = committed.countUnder(prefix);
      for (const gone of cleared ?? []) {
        if (keyHasPrefix(gone, prefix)) total -= committed.countUnder(gone);
      }
    }
    for (const [key, staged] of writes ?? []) {
      if (!keyHasPrefix(key, prefix)) continue;
      const exists = committed.rows.has(key) && !this.isCleared(table, key);
      if (staged === DELETED && exists) total -= 1;
      if (staged !== DELETED && !exists) total += 1;
    }
    return total;
  }

  scan(table: string, prefix?: TableKey): readonly (readonly [TableKey, Row])[] {
    const committed = this.store.table(table);
    const writes = this.writes.get(table);
    const cleared = this.clears.get(table);
    // Paid before the rows are read: the staged writes are all walked, and
    // the committed rows under the prefix are each read or passed over.
    this.spend(1);
    this.spendOnWalk(writes?.size ?? 0);
    const result: (readonly [TableKey, Row])[] = [];
    let passedOver = 0;
    for (const key of committed.keysUnder(prefix)) {
      // A cleared row written again is a new row, and comes last.
      if (cleared && this.isCleared(table, key)) {
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
    this.spend(result.length);
    this.spendOnWalk(passedOver);
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
    // Counted and paid for first. Nothing is staged until it is afforded.
    this.spend();
    const removed = this.countUnder(table, prefix);
    this.spendOnWalk(removed);

    const total = this.rowCount(table);
    const writes = this.writes.get(table);
    for (const key of [...(writes?.keys() ?? [])]) {
      if (keyHasPrefix(key, prefix)) writes?.delete(key);
    }
    // Only a prefix with committed rows left under it has anything to
    // remove at commit. Clearing an empty one is done already.
    if (
      !this.isCleared(table, prefix) &&
      this.store.table(table).countUnder(prefix) > 0
    ) {
      const cleared = this.clears.get(table) ?? new Set<TableKey>();
      this.clears.set(table, cleared);
      // The new prefix takes the place of any cleared before that lie inside it.
      for (const held of [...cleared]) {
        if (keyHasPrefix(held, prefix)) cleared.delete(held);
      }
      cleared.add(prefix);
    }
    this.rowCounts.set(table, total - removed);
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
