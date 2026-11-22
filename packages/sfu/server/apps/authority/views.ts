import type {
  Json,
  ProjectedRow,
  RowRef,
} from "@conclave/apps-sdk/authority";
import type {
  Role,
  RoomPolicy,
  RuntimeDefinition,
  RuntimeView,
  Subject,
  TableKey,
} from "@conclave/apps-sdk/authority/server";
import { Logger } from "../../../utilities/loggers.js";
import type { AuthorityStore } from "./store.js";

export type ViewOps = { put: ProjectedRow[]; remove: RowRef[]; bytes: number };

export type ViewFlush = {
  shared: Map<Role, ViewOps>;
  personal: Map<Subject, ViewOps>;
};

type Delivered = { encoded: string; value: Json; bytes: number };

/** What one audience (a role, or one subject) holds of one bucket. */
type Bucket = {
  rows: Map<string, Delivered>;
  /** Source row to the projected key it currently feeds. */
  bySource: Map<TableKey, string>;
  /** Projected key to the source row that owns it. */
  owner: Map<string, TableKey>;
  /**
   * Keys of rows a `clear` took that this audience's viewers still hold.
   * The rows are out of `rows` already, so a snapshot never carries them and
   * a new row is free to take such a key. Viewers are owed their removal,
   * unless a new row lands on the key first.
   */
  owed: Set<string>;
};

type Audience = Map<string, Bucket>;

/** Whose audience it is, to address what it is told. */
type AudienceOf = { role: Role } | { subject: Subject };

const emptyOps = (): ViewOps => ({ put: [], remove: [], bytes: 0 });
const isEmpty = (ops: ViewOps): boolean =>
  ops.put.length === 0 && ops.remove.length === 0;

const bucketOf = (audience: Audience, name: string): Bucket => {
  let bucket = audience.get(name);
  if (!bucket) {
    bucket = {
      rows: new Map(),
      bySource: new Map(),
      owner: new Map(),
      owed: new Set(),
    };
    audience.set(name, bucket);
  }
  return bucket;
};

/** A projected row and its size on the wire, for splitting a snapshot. */
export type SizedRow = { row: ProjectedRow; bytes: number };

/** Framing around one row on the wire: its field names and punctuation. */
const ROW_OVERHEAD_BYTES = 32;

const rowsOf = (audience: Audience): SizedRow[] => {
  const rows: SizedRow[] = [];
  for (const [bucket, state] of audience) {
    for (const [key, delivered] of state.rows) {
      rows.push({
        row: { bucket, key, value: delivered.value },
        bytes: delivered.bytes,
      });
    }
  }
  return rows;
};

const opsFor = <K>(map: Map<K, ViewOps>, id: K): ViewOps => {
  let ops = map.get(id);
  if (!ops) {
    ops = emptyOps();
    map.set(id, ops);
  }
  return ops;
};

/**
 * Turns private rows into what each audience may see, and remembers what
 * each audience already holds. A change is sent only when the projected row
 * differs from the held one, so a write nobody in an audience can see sends
 * that audience nothing, not even an empty frame they could time.
 *
 * Shared buckets are kept once per role and reused by everyone in it. A
 * personal bucket is kept per subject and only while that subject is here.
 */
export class ViewTracker {
  private policy: RoomPolicy;
  private readonly roles = new Map<Role, Audience>();
  private readonly subjects = new Map<Subject, Audience>();
  /** Per personal view: who owns which source rows, as of the last flush. */
  private readonly owned = new Map<string, Map<Subject, Set<TableKey>>>();
  private readonly ownerOf = new Map<string, Map<TableKey, Subject>>();
  private readonly viewsByTable = new Map<string, [string, RuntimeView][]>();
  /** Audiences whose viewers are owed removals, the longest waiting first. */
  private readonly owing = new Map<Audience, AudienceOf>();

  constructor(
    private readonly definition: RuntimeDefinition,
    private readonly store: AuthorityStore,
    policy: RoomPolicy,
    private readonly options: { verify: boolean; clearedRowsPerFlush: number },
  ) {
    this.policy = policy;
    for (const [name, view] of Object.entries(definition.views)) {
      const views = this.viewsByTable.get(view.source);
      if (views) views.push([name, view]);
      else this.viewsByTable.set(view.source, [[name, view]]);
      if (view.kind === "personal") {
        this.owned.set(name, new Map());
        this.ownerOf.set(name, new Map());
      }
    }
  }

  get currentPolicy(): RoomPolicy {
    return this.policy;
  }

  /**
   * The room's mode or flags changed, so every projection may differ. Held
   * views are dropped; the host sends each subscriber a fresh replacement.
   */
  setPolicy(policy: RoomPolicy): void {
    this.policy = policy;
    this.roles.clear();
    this.subjects.clear();
    this.owing.clear();
  }

  /** Whether some viewer still holds a row that a `clear` took. */
  get owesRemovals(): boolean {
    return this.owing.size > 0;
  }

  /**
   * What a role holds. Rows written since the last flush may be missing; the
   * next flush sends them as a patch on top of this.
   */
  sharedRows(role: Role): SizedRow[] {
    this.absorbCleared();
    return rowsOf(this.roleAudience(role));
  }

  personalRows(subject: Subject): SizedRow[] {
    this.absorbCleared();
    return rowsOf(this.subjectAudience(subject));
  }

  /**
   * Takes every row a `clear` removed out of every audience's rows. It runs
   * before anything is read from them, a snapshot as much as a flush, so a
   * committed clear is never seen half done: no snapshot carries a cleared
   * row, and a cleared row's key is free for a new row. What is left for
   * later flushes is only telling the viewers who already held such a row.
   *
   * A cleared row that was written again since is taken out all the same.
   * The flush then places it as the new row it is and sends it to everyone,
   * those who subscribed in between included.
   */
  private absorbCleared(): void {
    if (!this.store.hasCleared) return;
    for (const [tableName, keys] of this.store.takeCleared()) {
      const views = this.viewsByTable.get(tableName);
      if (!views) continue;
      for (const key of keys) {
        for (const [name, view] of views) {
          if (view.kind === "shared") {
            for (const [role, audience] of this.roles) {
              this.owe(audience, { role }, name, key);
            }
            continue;
          }
          const owner = this.ownerOf.get(name)!.get(key);
          if (owner === undefined) continue;
          this.disown(name, owner, key);
          const audience = this.subjects.get(owner);
          if (audience) this.owe(audience, { subject: owner }, name, key);
        }
      }
    }
  }

  /**
   * Projects every row written since the last flush and returns what each
   * live audience must be told. Audiences that left are forgotten.
   */
  flush(live: { roles: ReadonlySet<Role>; subjects: ReadonlySet<Subject> }): ViewFlush {
    for (const role of [...this.roles.keys()]) {
      if (!live.roles.has(role)) this.roles.delete(role);
    }
    for (const subject of [...this.subjects.keys()]) {
      if (!live.subjects.has(subject)) this.subjects.delete(subject);
    }

    const shared = new Map<Role, ViewOps>();
    const personal = new Map<Subject, ViewOps>();
    this.absorbCleared();

    // Every key a changed row gives up is released before any changed row
    // takes a key, so one row can take over a key another just left.
    const placements: (() => void)[] = [];
    const change = (
      bucket: Bucket,
      name: string,
      source: TableKey,
      projected: { key: string; value: Json } | null,
      ops: ViewOps,
    ): void => {
      this.release(bucket, name, source, projected, ops);
      if (projected) {
        placements.push(() => this.place(bucket, name, source, projected, ops));
      }
    };

    for (const [tableName, keys] of this.store.takeDirty()) {
      const views = this.viewsByTable.get(tableName);
      if (!views) continue;
      for (const key of keys) {
        const row = this.store.get(tableName, key);
        for (const [name, view] of views) {
          if (view.kind === "shared") {
            for (const [role, audience] of this.roles) {
              change(
                bucketOf(audience, name),
                name,
                key,
                row ? this.project(name, () => view.project(row, role, this.policy)) : null,
                opsFor(shared, role),
              );
            }
            continue;
          }
          const previousOwner = this.ownerOf.get(name)!.get(key);
          const nextOwner = row ? view.owner(row) : undefined;
          if (previousOwner !== undefined && previousOwner !== nextOwner) {
            this.disown(name, previousOwner, key);
            const audience = this.subjects.get(previousOwner);
            if (audience) {
              change(bucketOf(audience, name), name, key, null, opsFor(personal, previousOwner));
            }
          }
          if (nextOwner === undefined || !row) continue;
          this.own(name, nextOwner, key);
          const audience = this.subjects.get(nextOwner);
          if (audience) {
            change(
              bucketOf(audience, name),
              name,
              key,
              this.project(name, () => view.project(row, this.policy)),
              opsFor(personal, nextOwner),
            );
          }
        }
      }
    }
    for (const place of placements) place();
    this.tellOwed(shared, personal);

    for (const [role, ops] of shared) if (isEmpty(ops)) shared.delete(role);
    for (const [subject, ops] of personal) {
      if (isEmpty(ops)) personal.delete(subject);
    }
    if (this.options.verify) this.verify();
    return { shared, personal };
  }

  private roleAudience(role: Role): Audience {
    let audience = this.roles.get(role);
    if (audience) return audience;
    audience = this.buildRole(role);
    this.roles.set(role, audience);
    return audience;
  }

  private subjectAudience(subject: Subject): Audience {
    let audience = this.subjects.get(subject);
    if (audience) return audience;
    audience = this.buildSubject(subject);
    this.subjects.set(subject, audience);
    return audience;
  }

  private buildRole(role: Role): Audience {
    const audience: Audience = new Map();
    const ignored = emptyOps();
    for (const [name, view] of Object.entries(this.definition.views)) {
      if (view.kind !== "shared") continue;
      const bucket = bucketOf(audience, name);
      for (const [key, row] of this.store.rows(view.source)) {
        this.apply(
          bucket,
          name,
          key,
          this.project(name, () => view.project(row, role, this.policy)),
          ignored,
        );
      }
    }
    return audience;
  }

  private buildSubject(subject: Subject): Audience {
    const audience: Audience = new Map();
    const ignored = emptyOps();
    for (const [name, view] of Object.entries(this.definition.views)) {
      if (view.kind !== "personal") continue;
      const bucket = bucketOf(audience, name);
      for (const key of this.owned.get(name)!.get(subject) ?? []) {
        const row = this.store.get(view.source, key);
        // The index is as of the last flush. A row written since may have
        // changed hands, and must not be shown to its previous owner.
        if (!row || view.owner(row) !== subject) continue;
        this.apply(
          bucket,
          name,
          key,
          this.project(name, () => view.project(row, this.policy)),
          ignored,
        );
      }
    }
    return audience;
  }

  private own(view: string, subject: Subject, key: TableKey): void {
    this.ownerOf.get(view)!.set(key, subject);
    const owned = this.owned.get(view)!;
    const keys = owned.get(subject);
    if (keys) keys.add(key);
    else owned.set(subject, new Set([key]));
  }

  private disown(view: string, subject: Subject, key: TableKey): void {
    this.ownerOf.get(view)!.delete(key);
    const owned = this.owned.get(view)!;
    const keys = owned.get(subject);
    keys?.delete(key);
    if (keys?.size === 0) owned.delete(subject);
  }

  /**
   * Runs a projector and checks its output against the contract with unknown
   * fields refused. A projection the contract does not describe is a bug or a
   * leak, so the row is withheld, never sent as it is.
   */
  private project(
    view: string,
    run: () => { key: string; value: unknown } | null,
  ): { key: string; value: Json } | null {
    try {
      const projected = run();
      if (projected === null) return null;
      if (typeof projected.key !== "string" || projected.key.length === 0) {
        throw new Error("A projected row needs a key");
      }
      const value = this.definition.contract.views[view].parse(
        projected.value,
        "strict",
        view,
      ) as Json;
      return { key: projected.key, value };
    } catch (error) {
      if (this.options.verify) throw error;
      Logger.error(
        `[Authority] ${this.definition.contract.id}: view ${view} withheld a row`,
        error,
      );
      return null;
    }
  }

  /** One row's change to one audience's bucket, all at once. */
  private apply(
    bucket: Bucket,
    name: string,
    source: TableKey,
    projected: { key: string; value: Json } | null,
    ops: ViewOps,
  ): void {
    this.release(bucket, name, source, projected, ops);
    if (projected) this.place(bucket, name, source, projected, ops);
  }

  /**
   * Takes a cleared row out of an audience's bucket and notes that the
   * audience's viewers still hold it.
   */
  private owe(
    audience: Audience,
    who: AudienceOf,
    name: string,
    source: TableKey,
  ): void {
    const bucket = audience.get(name);
    const key = bucket?.bySource.get(source);
    if (!bucket || key === undefined) return;
    bucket.bySource.delete(source);
    if (bucket.owner.get(key) !== source) return;
    bucket.owner.delete(key);
    bucket.rows.delete(key);
    bucket.owed.add(key);
    this.owing.set(audience, who);
  }

  /**
   * Tells viewers of rows a `clear` took, a bounded number in one flush.
   * Each role's audience is told up to `clearedRowsPerFlush` of its rows,
   * which bounds the patch. People's own rows share one such allowance
   * between them, because each person told is a frame of their own. A
   * person is told all they are owed in one frame where the allowance
   * lasts, so 5,000 people who each held five such rows get one frame each
   * and not five.
   */
  private tellOwed(
    shared: Map<Role, ViewOps>,
    personal: Map<Subject, ViewOps>,
  ): void {
    // At least one, or the telling would never finish.
    const allowance = Math.max(1, this.options.clearedRowsPerFlush);
    let leftForPeople = allowance;
    for (const [audience, who] of this.owing) {
      const forRole = "role" in who;
      const held = forRole
        ? this.roles.get(who.role)
        : this.subjects.get(who.subject);
      // The audience left, and its viewers with it.
      if (held !== audience) {
        this.owing.delete(audience);
        continue;
      }
      const room = forRole ? allowance : leftForPeople;
      if (room === 0) continue;
      const ops = forRole
        ? opsFor(shared, who.role)
        : opsFor(personal, who.subject);
      let told = 0;
      let settled = true;
      for (const [name, bucket] of audience) {
        for (const key of bucket.owed) {
          if (told === room) {
            settled = false;
            break;
          }
          bucket.owed.delete(key);
          ops.remove.push({ bucket: name, key });
          ops.bytes += name.length + key.length + ROW_OVERHEAD_BYTES;
          told += 1;
        }
        if (!settled) break;
      }
      if (!forRole) leftForPeople -= told;
      if (settled) this.owing.delete(audience);
    }
  }

  /** Gives up the key a source row held when it no longer projects to it. */
  private release(
    bucket: Bucket,
    name: string,
    source: TableKey,
    projected: { key: string; value: Json } | null,
    ops: ViewOps,
  ): void {
    const previousKey = bucket.bySource.get(source);
    if (
      previousKey === undefined ||
      (projected !== null && projected.key === previousKey)
    ) {
      return;
    }
    bucket.bySource.delete(source);
    if (bucket.owner.get(previousKey) !== source) return;
    bucket.owner.delete(previousKey);
    bucket.rows.delete(previousKey);
    ops.remove.push({ bucket: name, key: previousKey });
    ops.bytes += name.length + previousKey.length + ROW_OVERHEAD_BYTES;
  }

  private place(
    bucket: Bucket,
    name: string,
    source: TableKey,
    projected: { key: string; value: Json },
    ops: ViewOps,
  ): void {
    // Each projected row needs its own key. When two source rows claim one,
    // the first keeps it and the second is withheld, so removing either can
    // never take the other's row away from a viewer.
    const owner = bucket.owner.get(projected.key);
    if (owner !== undefined && owner !== source) {
      const message = `${this.definition.contract.id}: view ${name} projected two rows to the key "${projected.key}"`;
      if (this.options.verify) throw new Error(message);
      Logger.error(`[Authority] ${message}. The later row is withheld.`);
      return;
    }

    const encoded = JSON.stringify(projected.value);
    bucket.bySource.set(source, projected.key);
    bucket.owner.set(projected.key, source);
    // A viewer who still held a cleared row under this key gets this row in
    // its place, so the removal it was owed is off.
    bucket.owed.delete(projected.key);
    if (bucket.rows.get(projected.key)?.encoded === encoded) return;
    const bytes =
      Buffer.byteLength(encoded) +
      name.length +
      projected.key.length +
      ROW_OVERHEAD_BYTES;
    bucket.rows.set(projected.key, { encoded, value: projected.value, bytes });
    ops.put.push({ bucket: name, key: projected.key, value: projected.value });
    ops.bytes += bytes;
  }

  /**
   * Test and development check: every held view must equal one rebuilt from
   * the committed rows. A projector that reads anything but its own row, or a
   * personal view whose owner depends on the room, fails here.
   */
  private verify(): void {
    const same = (held: Audience, fresh: Audience, label: string): void => {
      const encode = (audience: Audience): string =>
        JSON.stringify(
          [...audience]
            .flatMap(([name, bucket]) =>
              [...bucket.rows].map(([key, row]) => [name, key, row.encoded]),
            )
            .sort(),
        );
      if (encode(held) !== encode(fresh)) {
        throw new Error(
          `${this.definition.contract.id}: the incremental view for ${label} drifted from the committed rows`,
        );
      }
    };
    for (const [role, held] of this.roles) {
      same(held, this.buildRole(role), `role ${role}`);
    }
    for (const [subject, held] of this.subjects) {
      same(held, this.scanSubject(subject), "a subject");
    }
  }

  /** A subject's personal view from a full scan, ignoring the owner index. */
  private scanSubject(subject: Subject): Audience {
    const audience: Audience = new Map();
    const ignored = emptyOps();
    for (const [name, view] of Object.entries(this.definition.views)) {
      if (view.kind !== "personal") continue;
      const bucket = bucketOf(audience, name);
      for (const [key, row] of this.store.rows(view.source)) {
        if (view.owner(row) !== subject) continue;
        this.apply(
          bucket,
          name,
          key,
          this.project(name, () => view.project(row, this.policy)),
          ignored,
        );
      }
    }
    return audience;
  }
}
