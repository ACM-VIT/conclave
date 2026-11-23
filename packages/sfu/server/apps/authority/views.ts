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

type Delivered = { encoded: string; value: Json; bytes: number };

/** What a projected key became at one version of the views: a row, or none. */
type Step = { at: number; encoded: string | undefined };

/**
 * One projected key that changed since its audience was last told: what the
 * audience held before, and each thing it became since, oldest first. From
 * that, what any one viewer holds of it is known exactly, whenever their
 * snapshot was read.
 */
type Untold = {
  /** The row as it was before the first change, or undefined for none. */
  before: string | undefined;
  steps: Step[];
  /** While untold: whether the row is now other than it was before. */
  differs?: boolean;
  /**
   * Each time a clear took the row and another row took its key again
   * before every viewer was told, oldest first. A viewer whose cursor is
   * past a clear's `n` was told of it: they hold the key as it was at that
   * clear, version `at`, until a later clear they were told of.
   */
  owedAt?: { n: number; at: number }[];
};

/**
 * A row a `clear` took that some viewers held. Each viewer is told of it in
 * its turn, at most a budget of such rows a flush, counting only rows that
 * viewer held. Its place in that order is `n`: rows a clear took come after
 * every row an earlier clear took, and within one clear by bucket, then key.
 * So the order follows the clears alone, never who read the views when.
 */
type Owed = {
  n: number;
  bucket: string;
  key: string;
  change: Untold;
  /** False once a row took the key again, or every viewer was told. */
  live: boolean;
  /** An earlier clear of the key was told to some viewers: see `owedAt`. */
  marked: boolean;
};

/** Where a viewer has got to in the rows clears took, in each of its audiences. */
export type OwedCursor = { shared: number; own: number };

/** One viewer's walk through an audience's rows clears took, for one flush. */
type OwedWalk = { remove: RowRef[]; bytes: number; next: number; more: boolean; used: number };

/** What one audience (a role, or one subject) holds of one bucket. */
type Bucket = {
  rows: Map<string, Delivered>;
  /** Source row to the projected key it currently feeds. */
  bySource: Map<TableKey, string>;
  /** Projected key to the source row that owns it. */
  owner: Map<string, TableKey>;
  /** Changes the next flush tells in full. */
  untold: Map<string, Untold>;
  /**
   * Rows a `clear` took. They are out of `rows` already, so no snapshot
   * carries them and a new row is free to take such a key. Only telling
   * those who held them is left, a bounded number each flush.
   */
  owed: Map<string, Owed>;
  /**
   * Sources withheld because another row held the key they project to,
   * each with the key it wants. One takes the key when it is given up.
   */
  withheld: Map<TableKey, { key: string; reported: boolean }>;
};

/** Whose audience it is, to address what it is told. */
type AudienceOf = { role: Role } | { subject: Subject };

type Audience = {
  of: AudienceOf;
  buckets: Map<string, Bucket>;
  /** Untold changes whose row is now other than before them. */
  untoldDiffering: number;
  /** The first place in rows clears took that an untold change depends on. */
  untoldCut: number;
  /** The first and last versions an untold change was noted at. */
  untoldSince: number;
  untoldUntil: number;
  /** Rows clears took that someone may still be owed, in their order. */
  owed: Owed[];
  /** Of those, the ones a viewer from before the clear held. */
  heldOwed: Owed[];
  /** Live ones whose key some viewers were told of an earlier clear of. */
  markedOwed: number;
  nextOwed: number;
  /** The first version any owed row changed at, and the last. */
  owedSince: number;
  owedUntil: number;
};

const newAudience = (of: AudienceOf): Audience => ({
  of,
  buckets: new Map(),
  untoldDiffering: 0,
  untoldCut: Number.POSITIVE_INFINITY,
  untoldSince: Number.POSITIVE_INFINITY,
  untoldUntil: Number.NEGATIVE_INFINITY,
  owed: [],
  heldOwed: [],
  markedOwed: 0,
  nextOwed: 0,
  owedSince: Number.POSITIVE_INFINITY,
  owedUntil: Number.NEGATIVE_INFINITY,
});

const emptyOps = (): ViewOps => ({ put: [], remove: [], bytes: 0 });

const bucketOf = (audience: Audience, name: string): Bucket => {
  let bucket = audience.buckets.get(name);
  if (!bucket) {
    bucket = {
      rows: new Map(),
      bySource: new Map(),
      owner: new Map(),
      untold: new Map(),
      owed: new Map(),
      withheld: new Map(),
    };
    audience.buckets.set(name, bucket);
  }
  return bucket;
};

/** A projected row and its size on the wire, for splitting a snapshot. */
export type SizedRow = { row: ProjectedRow; bytes: number };

/** One viewer's rows as committed, read at the moment of asking. */
export type CommittedView = {
  get(bucket: string, key: string): Json | undefined;
  /** What a row takes on the wire, counted as a snapshot's parts count it. */
  bytes(bucket: string, key: string): number;
  keys(bucket: string): Iterable<string>;
  size(bucket: string): number;
};

/** A whole view, and the version of the views it was read at. */
export type ViewSnapshot = { rows: SizedRow[]; version: number };

/**
 * What a viewer whose snapshot was read at `version` holds of a changed key:
 * the last thing it became by then, or what was held before the change.
 */
const heldAt = (change: Untold, version: number): string | undefined => {
  let held = change.before;
  for (const step of change.steps) {
    if (step.at > version) break;
    held = step.encoded;
  }
  return held;
};

/**
 * What a viewer at `version`, got to `cursor` in the rows clears took, holds
 * of a changed key.
 */
const heldBy = (change: Untold, version: number, cursor: number): string | undefined => {
  let told: { n: number; at: number } | undefined;
  for (const clear of change.owedAt ?? []) {
    if (clear.n >= cursor) break;
    told = clear;
  }
  return told ? heldAt(change, Math.max(version, told.at)) : heldAt(change, version);
};

/** The first place in rows clears took, kept in order, at or after `from`. */
const firstOwed = (list: readonly Owed[], from: number): number => {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (list[middle].n < from) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** What a viewer was sent of its view, bucket by bucket: each row as sent. */
export type HeldRows = Map<string, Map<string, Json>>;

/**
 * Bytes a row takes in a frame, counted as JSON on the wire: the row object
 * `{"bucket":..,"key":..,"value":..}` and the comma that follows it in an
 * array. A whole array of rows is one byte more than its rows, for the
 * brackets less the last comma. Bucket and key are measured as encoded,
 * escapes and all, never by their length in UTF-16 units.
 */
export const rowBytes = (bucket: string, key: string, encodedValue: string): number =>
  ROW_FRAMING_BYTES +
  Buffer.byteLength(JSON.stringify(bucket)) +
  Buffer.byteLength(JSON.stringify(key)) +
  Buffer.byteLength(encodedValue);

/** Bytes a removal takes in a patch: `{"bucket":..,"key":..}` and its comma. */
export const refBytes = (bucket: string, key: string): number =>
  REF_FRAMING_BYTES +
  Buffer.byteLength(JSON.stringify(bucket)) +
  Buffer.byteLength(JSON.stringify(key));

/** The bytes an array of rows adds to the rows in it. */
export const ARRAY_BYTES = 1;

/** `{"bucket":` `,"key":` `,"value":` `}` and a comma. */
const ROW_FRAMING_BYTES = 28;
/** `{"bucket":` `,"key":` `}` and a comma. */
const REF_FRAMING_BYTES = 19;

/**
 * Every frame lists its rows by bucket, then key. The order a cache took
 * rows in depends on who read it when, so a frame that followed it would
 * differ for one viewer with what other viewers did.
 */
const inPlace = (a: { bucket: string; key: string }, b: { bucket: string; key: string }): number =>
  a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

const placed = (ops: ViewOps): ViewOps => {
  ops.put.sort(inPlace);
  ops.remove.sort(inPlace);
  return ops;
};

const rowsOf = (audience: Audience, into: SizedRow[]): void => {
  for (const [bucket, state] of audience.buckets) {
    for (const [key, delivered] of state.rows) {
      into.push({
        row: { bucket, key, value: delivered.value },
        bytes: delivered.bytes,
      });
    }
  }
};

type Told = Untold & {
  bucket: string;
  key: string;
  /** The row as it is now, or undefined when it is gone. */
  now: Delivered | undefined;
};

/**
 * What one audience is told in one flush. Its viewers did not all take
 * their view at the same moment, so each is told from their own. For every
 * changed row, what a viewer holds is the row as it stood at their snapshot,
 * and they are sent the difference between that and the row now. So a
 * viewer is told to drop a row only if they were handed it: one that came
 * and went without ever being in their view is not named to them, not even
 * by its key, whatever it did in between.
 */
export class ViewChanges {
  /** The first version any of these changes was made at. */
  private readonly since: number;
  /** The first place in rows clears took that a change here depends on. */
  private readonly cut: number;
  private whole: ViewOps | null = null;

  constructor(private readonly told: readonly Told[]) {
    this.since = told.reduce(
      (first, change) => Math.min(first, change.steps[0].at),
      Number.POSITIVE_INFINITY,
    );
    this.cut = told.reduce(
      (first, change) => Math.min(first, change.owedAt?.[0]?.n ?? Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY,
    );
  }

  /**
   * The changes for a viewer whose snapshot was read at `version`, got to
   * `cursor` in the rows clears took, or undefined when there is nothing to
   * tell them.
   */
  for(version: number, cursor: number): ViewOps | undefined {
    // Nearly every viewer took their view before any of it: one answer.
    const ops =
      version < this.since && cursor <= this.cut
        ? (this.whole ??= this.opsSince(version, cursor))
        : this.opsSince(version, cursor);
    return ops.put.length === 0 && ops.remove.length === 0 ? undefined : ops;
  }

  private opsSince(version: number, cursor: number): ViewOps {
    const ops = emptyOps();
    for (const change of this.told) {
      // The row as their snapshot had it: the last thing it became by then.
      const held = heldBy(change, version, cursor);
      if (change.now) {
        if (held === change.now.encoded) continue;
        ops.put.push({
          bucket: change.bucket,
          key: change.key,
          value: change.now.value,
        });
        ops.bytes += change.now.bytes;
      } else {
        // Never in their view, so there is nothing for them to drop.
        if (held === undefined) continue;
        ops.remove.push({ bucket: change.bucket, key: change.key });
        ops.bytes += refBytes(change.bucket, change.key);
      }
    }
    return placed(ops);
  }
}

export type ViewFlush = {
  shared: Map<Role, ViewChanges>;
  personal: Map<Subject, ViewChanges>;
};

export type LiveAudiences = {
  roles: ReadonlySet<Role>;
  subjects: ReadonlySet<Subject>;
};

/**
 * Turns private rows into what each audience may see, and remembers what
 * each audience already holds. A change is sent only when the projected row
 * differs from the held one, so a write nobody in an audience can see sends
 * that audience nothing, not even an empty frame they could time.
 *
 * Shared buckets are kept once per role and reused by everyone in it. A
 * personal bucket is kept per subject and only while that subject is here.
 *
 * What is kept always equals the committed rows before anything is read
 * from it. Every committed write is taken in first, whether the reader is a
 * flush or a snapshot for someone who has just opened the app, so a snapshot
 * never carries a row that was hidden, changed or removed a moment before.
 * Only telling the viewers who already hold a view waits for the flush.
 */
export class ViewTracker {
  private policy: RoomPolicy;
  private readonly roles = new Map<Role, Audience>();
  private readonly subjects = new Map<Subject, Audience>();
  /** Per personal view: who owns which source rows. */
  private readonly owned = new Map<string, Map<Subject, Set<TableKey>>>();
  private readonly ownerOf = new Map<string, Map<TableKey, Subject>>();
  private readonly viewsByTable = new Map<string, [string, RuntimeView][]>();
  /** Audiences with changes their viewers have yet to be told, oldest first. */
  private readonly changed = new Set<Audience>();
  /** Rows clears took, in audiences, that some viewer may still be owed. */
  private owedLive = 0;
  /** Rows one commit's clears took, put in their order once it is taken in. */
  private readonly owing = new Map<Audience, Owed[]>();
  /** Keys given up while taking writes in, for a withheld row to take. */
  private readonly freed: [Audience, string, string][] = [];
  /** This flush's walks through rows clears took, shared by alike viewers. */
  private readonly walks = new Map<Audience, Map<string, OwedWalk>>();
  /** Changed or owed rows the checks have looked at, to bound their cost. */
  private work = 0;
  /** Counts each time committed writes are taken in. */
  private version = 0;

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
   * The room's mode or flags changed, so any projection may differ. Every
   * row is projected again for every audience that holds a view, and only
   * what comes out different is noted, to be told like any other change. A
   * switch that changes nothing anyone sees, such as one that only decides
   * who may take part, notes nothing and sends no rows at all.
   */
  setPolicy(policy: RoomPolicy): void {
    this.policy = policy;
    // First what was committed and not yet taken in, now under the new policy.
    this.absorb();
    this.version += 1;
    this.reconcile((change) => {
      for (const [name, view] of Object.entries(this.definition.views)) {
        if (view.kind === "shared") {
          for (const [key, row] of this.store.rows(view.source)) {
            for (const [role, audience] of this.roles) {
              change(
                audience,
                name,
                key,
                this.project(name, () => view.project(row, role, this.policy)),
              );
            }
          }
          continue;
        }
        for (const [subject, audience] of this.subjects) {
          for (const key of this.owned.get(name)!.get(subject) ?? []) {
            const row = this.store.get(view.source, key);
            if (!row) continue;
            change(
              audience,
              name,
              key,
              this.project(name, () => view.project(row, this.policy)),
            );
          }
        }
      }
    });
  }

  /**
   * Applies a set of row changes to the audiences. Every key a changed row
   * gives up is released before any changed row takes a key, so one row can
   * take over a key another just left.
   */
  private reconcile(
    visit: (
      change: (
        audience: Audience,
        name: string,
        source: TableKey,
        projected: { key: string; value: Json } | null,
      ) => void,
    ) => void,
  ): void {
    const placements: (() => void)[] = [];
    visit((audience, name, source, projected) => {
      this.release(audience, name, source, projected);
      if (projected) {
        placements.push(() => this.place(audience, name, source, projected));
      }
    });
    for (const place of placements) place();
    this.heal();
  }

  /** Notes a key given up where a withheld row may want it. */
  private free(audience: Audience, name: string, key: string): void {
    this.work += 1;
    this.freed.push([audience, name, key]);
  }

  /** Gives each key given up to a row withheld for want of it, if one still wants it. */
  private heal(): void {
    // Walked in place, never shifted: a clear frees a key for each row.
    for (let index = 0; index < this.freed.length; index += 1) {
      const [audience, name, key] = this.freed[index];
      const bucket = audience.buckets.get(name);
      if (!bucket || bucket.owner.has(key)) continue;
      for (const [source, withheld] of [...bucket.withheld]) {
        if (withheld.key !== key) continue;
        bucket.withheld.delete(source);
        const projected = this.projectFor(audience, name, source);
        if (projected) this.place(audience, name, source, projected);
        if (bucket.owner.has(key)) break;
      }
    }
    this.freed.length = 0;
  }

  /** What one source row projects to for an audience now, or null for nothing. */
  private projectFor(
    audience: Audience,
    name: string,
    source: TableKey,
  ): { key: string; value: Json } | null {
    const view = this.definition.views[name];
    const row = this.store.get(view.source, source);
    if (!row) return null;
    if (view.kind === "shared") {
      if (!("role" in audience.of)) return null;
      const { role } = audience.of;
      return this.project(name, () => view.project(row, role, this.policy));
    }
    if (!("subject" in audience.of) || view.owner(row) !== audience.of.subject) return null;
    return this.project(name, () => view.project(row, this.policy));
  }

  /** Whether some viewer has yet to be told of a change, or of a clear. */
  get hasUntold(): boolean {
    return this.changed.size > 0 || this.owedLive > 0;
  }

  /** Whether some viewer may still be owed a row a clear took. */
  get hasOwed(): boolean {
    return this.owedLive > 0;
  }

  /** Changed or owed rows looked at by every check so far. */
  get examined(): number {
    return this.work;
  }

  /**
   * Takes in what a transaction just committed. Run after every commit, so
   * the views are always the committed rows, and reading them, as a viewer
   * who has just opened the app does, never changes them.
   */
  takeIn(): void {
    this.absorb();
  }

  /** How many audiences' views are kept. */
  get held(): { roles: number; subjects: number } {
    return { roles: this.roles.size, subjects: this.subjects.size };
  }

  /**
   * A whole view for one viewer: their role's rows and their own, as
   * committed. The version says which changes it already has, so the next
   * flush tells this viewer only what came after.
   */
  snapshot(role: Role, subject: Subject): ViewSnapshot {
    this.absorb();
    const rows: SizedRow[] = [];
    rowsOf(this.roleAudience(role), rows);
    rowsOf(this.subjectAudience(subject), rows);
    rows.sort((a, b) => inPlace(a.row, b.row));
    return { rows, version: this.version };
  }

  /** The bytes one viewer's view as committed now takes in a snapshot's rows. */
  viewBytes(role: Role, subject: Subject): number {
    this.absorb();
    let bytes = 0;
    for (const audience of [this.roleAudience(role), this.subjectAudience(subject)]) {
      for (const bucket of audience.buckets.values()) {
        for (const row of bucket.rows.values()) bytes += row.bytes;
      }
    }
    return bytes;
  }

  /**
   * One viewer's view as committed right now, to read rows from. It is for
   * code that says later what a frame told it: reading here at the moment
   * of saying means a row hidden or changed since is never said as it was.
   * The reader is good only until the next write.
   */
  committed(role: Role, subject: Subject): CommittedView {
    this.absorb();
    const shared = this.roleAudience(role).buckets;
    const own = this.subjectAudience(subject).buckets;
    const bucketOf = (name: string) => shared.get(name) ?? own.get(name);
    return {
      get: (bucket, key) => bucketOf(bucket)?.rows.get(key)?.value,
      bytes: (bucket, key) => bucketOf(bucket)?.rows.get(key)?.bytes ?? 0,
      keys: (bucket) => bucketOf(bucket)?.rows.keys() ?? [],
      size: (bucket) => bucketOf(bucket)?.rows.size ?? 0,
    };
  }

  /**
   * What a viewer who holds `held` must be told to hold their view as
   * committed now, and the version that is. It is read at the moment of
   * asking, so nothing in it is older than what the viewer has, and nothing
   * is a row their view no longer has. A row is put where what is held is
   * not the row as committed, and removed only where it is held.
   */
  catchUp(role: Role, subject: Subject, held: HeldRows): { ops: ViewOps; version: number } {
    this.absorb();
    const shared = this.roleAudience(role).buckets;
    const own = this.subjectAudience(subject).buckets;
    const ops: ViewOps = { put: [], remove: [], bytes: 0 };
    for (const buckets of [shared, own]) {
      for (const [bucket, state] of buckets) {
        const had = held.get(bucket);
        for (const [key, delivered] of state.rows) {
          // A row's value is replaced only when its encoding changes.
          if (had?.get(key) === delivered.value) continue;
          ops.put.push({ bucket, key, value: delivered.value });
          ops.bytes += delivered.bytes;
        }
      }
    }
    for (const [bucket, rows] of held) {
      const now = (shared.get(bucket) ?? own.get(bucket))?.rows;
      for (const key of rows.keys()) {
        if (now?.has(key)) continue;
        ops.remove.push({ bucket, key });
        ops.bytes += refBytes(bucket, key);
      }
    }
    return { ops: placed(ops), version: this.version };
  }

  /**
   * Whether a viewer whose snapshot was read at `version`, got to `from` in
   * the rows clears took, holds anything other than what is committed for
   * them. Every write is taken in as it commits, so the views are the
   * committed rows, and only this viewer's audiences are read: writes they
   * cannot see never count, and nobody else opening the app changes what is
   * there to compare. A viewer from before every change pending is answered
   * from counts kept as the changes are noted, without looking at the rows.
   */
  pendingSince(role: Role, subject: Subject, version: number, from: OwedCursor): boolean {
    const shared = this.roles.get(role);
    const own = this.subjects.get(subject);
    return (
      (shared !== undefined &&
        (this.untoldBehind(shared, version, from.shared) ||
          this.owedHeld(shared, version, from.shared))) ||
      (own !== undefined &&
        (this.untoldBehind(own, version, from.own) || this.owedHeld(own, version, from.own)))
    );
  }

  /** Whether an untold change leaves such a viewer with another row than the views have. */
  private untoldBehind(audience: Audience, version: number, cursor: number): boolean {
    if (audience.untoldUntil === Number.NEGATIVE_INFINITY) return false;
    if (cursor <= audience.untoldCut) {
      if (version < audience.untoldSince) return audience.untoldDiffering > 0;
      if (version >= audience.untoldUntil) return false;
    }
    for (const bucket of audience.buckets.values()) {
      for (const [key, change] of bucket.untold) {
        this.work += 1;
        if (heldBy(change, version, cursor) !== bucket.rows.get(key)?.encoded) return true;
      }
    }
    return false;
  }

  /** Whether such a viewer still holds a row a clear took, past where it got to. */
  private owedHeld(audience: Audience, version: number, from: number): boolean {
    if (audience.owed.length === 0 || version >= audience.owedUntil) return false;
    if (version < audience.owedSince && audience.markedOwed === 0) {
      // They held every such row the audience held before the clear.
      const held = audience.heldOwed;
      while (held.length > 0 && !held[held.length - 1].live) held.pop();
      return held.length > 0 && held[held.length - 1].n >= from;
    }
    for (let index = firstOwed(audience.owed, from); index < audience.owed.length; index += 1) {
      const owed = audience.owed[index];
      if (!owed.live) continue;
      this.work += 1;
      if (heldBy(owed.change, version, from) !== undefined) return true;
    }
    return false;
  }

  /**
   * What one viewer at `version`, got to `from`, is told now of the rows
   * clears took: the next ones it held, up to the budget, in their order.
   * Rows it never held are passed over and count for nothing, so what it is
   * told, and when, follows from its own view alone. `more` says rows it
   * held are still to come.
   */
  owedFor(
    role: Role,
    subject: Subject,
    version: number,
    from: OwedCursor,
  ): { ops: ViewOps | undefined; next: OwedCursor; more: boolean } {
    const budget = Math.max(1, this.options.clearedRowsPerFlush);
    const shared = this.walkOwed(this.roles.get(role), version, from.shared, budget);
    const own = this.walkOwed(this.subjects.get(subject), version, from.own, budget - shared.used);
    const ops = emptyOps();
    for (const walked of [shared, own]) {
      ops.remove.push(...walked.remove);
      ops.bytes += walked.bytes;
    }
    return {
      ops: ops.remove.length > 0 ? placed(ops) : undefined,
      next: { shared: shared.next, own: own.next },
      more: shared.more || own.more,
    };
  }

  private walkOwed(
    audience: Audience | undefined,
    version: number,
    from: number,
    budget: number,
  ): OwedWalk {
    if (!audience) return { remove: [], bytes: 0, next: from, more: false, used: 0 };
    if (audience.owed.length === 0 || version >= audience.owedUntil) {
      return { remove: [], bytes: 0, next: audience.nextOwed, more: false, used: 0 };
    }
    // Everyone whose view is from before the clears holds the same of them,
    // so one walk from one place serves them all.
    const shareable = version < audience.owedSince;
    const memoKey = `${from}:${budget}`;
    const remembered = shareable ? this.walks.get(audience)?.get(memoKey) : undefined;
    if (remembered) return remembered;
    const walked: OwedWalk = { remove: [], bytes: 0, next: audience.nextOwed, more: false, used: 0 };
    for (let index = firstOwed(audience.owed, from); index < audience.owed.length; index += 1) {
      const owed = audience.owed[index];
      if (!owed.live) continue;
      this.work += 1;
      if (heldBy(owed.change, version, from) === undefined) continue;
      if (walked.used === budget) {
        walked.next = owed.n;
        walked.more = true;
        break;
      }
      walked.used += 1;
      walked.remove.push({ bucket: owed.bucket, key: owed.key });
      walked.bytes += refBytes(owed.bucket, owed.key);
    }
    if (shareable) {
      let byKey = this.walks.get(audience);
      if (!byKey) {
        byKey = new Map();
        this.walks.set(audience, byKey);
      }
      byKey.set(memoKey, walked);
    }
    return walked;
  }

  /** Where a viewer whose view is the committed rows now starts in rows clears took. */
  owedEnd(role: Role, subject: Subject): OwedCursor {
    return {
      shared: this.roles.get(role)?.nextOwed ?? 0,
      own: this.subjects.get(subject)?.nextOwed ?? 0,
    };
  }

  /**
   * Lets go of the rows clears took that no viewer still has to be told of:
   * those before the least place any viewer of the audience has got to.
   */
  settleOwed(least: {
    roles: ReadonlyMap<Role, number>;
    subjects: ReadonlyMap<Subject, number>;
  }): void {
    for (const [role, audience] of this.roles) {
      this.settle(audience, least.roles.get(role) ?? Number.POSITIVE_INFINITY);
    }
    for (const [subject, audience] of this.subjects) {
      this.settle(audience, least.subjects.get(subject) ?? Number.POSITIVE_INFINITY);
    }
  }

  private settle(audience: Audience, from: number): void {
    const list = audience.owed;
    let drop = 0;
    while (drop < list.length && (!list[drop].live || list[drop].n < from)) {
      const owed = list[drop];
      if (owed.live) {
        owed.live = false;
        audience.buckets.get(owed.bucket)?.owed.delete(owed.key);
        this.owedLive -= 1;
        if (owed.marked) audience.markedOwed -= 1;
      }
      drop += 1;
    }
    if (drop > 0) list.splice(0, drop);
    if (list.length === 0) {
      audience.heldOwed = [];
      audience.markedOwed = 0;
      audience.owedSince = Number.POSITIVE_INFINITY;
      audience.owedUntil = Number.NEGATIVE_INFINITY;
    }
  }

  /**
   * One viewer's rows as the committed rows project them now, worked out
   * afresh from the tables and kept nowhere: nothing is taken in and no
   * cache changes. For checks that must not disturb what they check.
   */
  projectedFor(role: Role, subject: Subject): CommittedView {
    const shared = this.buildRole(role).buckets;
    const own = this.scanSubject(subject).buckets;
    const bucketOf = (name: string) => shared.get(name) ?? own.get(name);
    return {
      get: (bucket, key) => bucketOf(bucket)?.rows.get(key)?.value,
      bytes: (bucket, key) => bucketOf(bucket)?.rows.get(key)?.bytes ?? 0,
      keys: (bucket) => bucketOf(bucket)?.rows.keys() ?? [],
      size: (bucket) => bucketOf(bucket)?.rows.size ?? 0,
    };
  }

  /** Forgets the views of audiences nobody holds any more. */
  keep(live: LiveAudiences): void {
    for (const [role, audience] of this.roles) {
      if (live.roles.has(role)) continue;
      this.roles.delete(role);
      this.forget(audience);
    }
    for (const [subject, audience] of this.subjects) {
      if (live.subjects.has(subject)) continue;
      this.subjects.delete(subject);
      this.forget(audience);
    }
  }

  private forget(audience: Audience): void {
    this.changed.delete(audience);
    this.settle(audience, Number.POSITIVE_INFINITY);
  }

  /**
   * Takes in every committed write and returns what each live audience must
   * be told. Audiences that left are forgotten.
   */
  flush(live: LiveAudiences): ViewFlush {
    this.keep(live);
    this.absorb();
    this.walks.clear();
    this.reportWithheld();
    const flushed = this.tell();
    if (this.options.verify) this.verify();
    return flushed;
  }

  /**
   * Each projected row needs its own key. A row that claims a key another
   * row holds is withheld, and takes the key if it is given up, so a key
   * handed from one row to another over two writes ends with the second. One
   * still withheld at a flush is a bug in the app: reported once, and an
   * error under verification.
   */
  private reportWithheld(): void {
    for (const audiences of [this.roles, this.subjects]) {
      for (const audience of audiences.values()) {
        for (const [name, bucket] of audience.buckets) {
          for (const [source, withheld] of bucket.withheld) {
            if (withheld.reported) continue;
            withheld.reported = true;
            const message = `${this.definition.contract.id}: view ${name} projected two rows to the key "${withheld.key}"`;
            if (this.options.verify) throw new Error(message);
            Logger.error(`[Authority] ${message}. The later row, ${source}, is withheld.`);
          }
        }
      }
    }
  }

  /**
   * Brings what every audience holds in line with the committed rows, and
   * notes each change for the viewers who have yet to hear of it. It runs
   * before anything is read from the views.
   */
  private absorb(): void {
    if (!this.store.hasCleared && !this.store.hasDirty) return;
    this.version += 1;
    this.absorbCleared();
    this.absorbDirty();
    this.orderOwing();
  }

  private absorbDirty(): void {
    const dirty = this.store.takeDirty();
    this.reconcile((change) => {
      for (const [tableName, keys] of dirty) {
        const views = this.viewsByTable.get(tableName);
        if (!views) continue;
        for (const key of keys) {
          const row = this.store.get(tableName, key);
          for (const [name, view] of views) {
            if (view.kind === "shared") {
              for (const [role, audience] of this.roles) {
                change(
                  audience,
                  name,
                  key,
                  row ? this.project(name, () => view.project(row, role, this.policy)) : null,
                );
              }
              continue;
            }
            const previousOwner = this.ownerOf.get(name)!.get(key);
            const nextOwner = row ? view.owner(row) : undefined;
            if (previousOwner !== undefined && previousOwner !== nextOwner) {
              this.disown(name, previousOwner, key);
              const audience = this.subjects.get(previousOwner);
              if (audience) change(audience, name, key, null);
            }
            if (nextOwner === undefined || !row) continue;
            this.own(name, nextOwner, key);
            const audience = this.subjects.get(nextOwner);
            if (audience) {
              change(
                audience,
                name,
                key,
                this.project(name, () => view.project(row, this.policy)),
              );
            }
          }
        }
      }
    });
  }

  /**
   * Takes every row a `clear` removed out of every audience's rows. A
   * cleared row that was written again since is taken out all the same, and
   * placed again as the new row it is.
   */
  private absorbCleared(): void {
    if (!this.store.hasCleared) return;
    for (const [tableName, keys] of this.store.takeCleared()) {
      const views = this.viewsByTable.get(tableName);
      if (!views) continue;
      for (const key of keys) {
        for (const [name, view] of views) {
          if (view.kind === "shared") {
            for (const audience of this.roles.values()) {
              this.owe(audience, name, key);
            }
            continue;
          }
          const owner = this.ownerOf.get(name)!.get(key);
          if (owner === undefined) continue;
          this.disown(name, owner, key);
          const audience = this.subjects.get(owner);
          if (audience) this.owe(audience, name, key);
        }
      }
    }
  }

  /**
   * Gathers what each audience is told now: every change, in full. Rows a
   * clear took are not among them: each viewer is told of those in its own
   * turn, as `owedFor` says.
   */
  private tell(): ViewFlush {
    const shared = new Map<Role, ViewChanges>();
    const personal = new Map<Subject, ViewChanges>();
    for (const audience of this.changed) {
      const told: Told[] = [];
      for (const [name, bucket] of audience.buckets) {
        for (const [key, change] of bucket.untold) {
          told.push({ ...change, bucket: name, key, now: bucket.rows.get(key) });
        }
        bucket.untold.clear();
      }
      audience.untoldDiffering = 0;
      audience.untoldCut = Number.POSITIVE_INFINITY;
      audience.untoldSince = Number.POSITIVE_INFINITY;
      audience.untoldUntil = Number.NEGATIVE_INFINITY;
      if (told.length === 0) continue;
      if ("role" in audience.of) {
        shared.set(audience.of.role, new ViewChanges(told));
      } else {
        personal.set(audience.of.subject, new ViewChanges(told));
      }
    }
    this.changed.clear();
    return { shared, personal };
  }

  /**
   * Puts the rows this commit's clears took in their order: after every row
   * an earlier clear took, and among themselves by bucket, then key.
   */
  private orderOwing(): void {
    for (const [audience, list] of this.owing) {
      list.sort(inPlace);
      for (const owed of list) {
        if (!owed.live) continue;
        owed.n = audience.nextOwed;
        audience.nextOwed += 1;
        audience.owed.push(owed);
        if (owed.change.owedAt) {
          owed.marked = true;
          audience.markedOwed += 1;
        }
        if (owed.change.before !== undefined) audience.heldOwed.push(owed);
        const { steps } = owed.change;
        audience.owedSince = Math.min(audience.owedSince, steps[0].at);
        audience.owedUntil = Math.max(audience.owedUntil, steps[steps.length - 1].at);
        this.owedLive += 1;
      }
    }
    this.owing.clear();
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

  /**
   * A role's view built from the committed rows. Nobody holds it yet, so
   * nothing in it is noted as a change to tell.
   */
  private buildRole(role: Role): Audience {
    const audience = newAudience({ role });
    for (const [name, view] of Object.entries(this.definition.views)) {
      if (view.kind !== "shared") continue;
      bucketOf(audience, name);
      for (const [key, row] of this.store.rows(view.source)) {
        const projected = this.project(name, () => view.project(row, role, this.policy));
        if (projected) this.place(audience, name, key, projected, false);
      }
    }
    return audience;
  }

  private buildSubject(subject: Subject): Audience {
    const audience = newAudience({ subject });
    for (const [name, view] of Object.entries(this.definition.views)) {
      if (view.kind !== "personal") continue;
      bucketOf(audience, name);
      for (const key of this.owned.get(name)!.get(subject) ?? []) {
        const row = this.store.get(view.source, key);
        if (!row || view.owner(row) !== subject) continue;
        const projected = this.project(name, () => view.project(row, this.policy));
        if (projected) this.place(audience, name, key, projected, false);
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

  /**
   * Notes what a key is about to become for an audience whose viewers hold
   * it as it is now: the row `next`, or nothing. `later` marks a row a
   * `clear` took, which each viewer is told of in its turn.
   */
  private note(
    audience: Audience,
    name: string,
    bucket: Bucket,
    key: string,
    later: boolean,
    next: string | undefined,
  ): void {
    const untold = bucket.untold.get(key);
    const owed = bucket.owed.get(key);
    const change = untold ?? owed?.change ?? { before: bucket.rows.get(key)?.encoded, steps: [] };
    if (untold?.differs) audience.untoldDiffering -= 1;
    if (owed) {
      // A row takes the key again before every viewer was told of the clear.
      // Those who were told hold it as the clear left it.
      owed.live = false;
      bucket.owed.delete(key);
      if (owed.marked) audience.markedOwed -= 1;
      if (owed.n >= 0) {
        this.owedLive -= 1;
        (change.owedAt ??= []).push({ n: owed.n, at: change.steps[change.steps.length - 1].at });
      }
    }
    // One version is one moment: only where the key ended up in it counts.
    const last = change.steps[change.steps.length - 1];
    if (last?.at === this.version) last.encoded = next;
    else change.steps.push({ at: this.version, encoded: next });
    if (later) {
      bucket.untold.delete(key);
      const entry: Owed = { n: -1, bucket: name, key, change, live: true, marked: false };
      bucket.owed.set(key, entry);
      const list = this.owing.get(audience);
      if (list) list.push(entry);
      else this.owing.set(audience, [entry]);
      return;
    }
    bucket.untold.set(key, change);
    change.differs = next !== change.before;
    if (change.differs) audience.untoldDiffering += 1;
    if (change.owedAt) audience.untoldCut = Math.min(audience.untoldCut, change.owedAt[0].n);
    audience.untoldSince = Math.min(audience.untoldSince, change.steps[0].at);
    audience.untoldUntil = Math.max(audience.untoldUntil, this.version);
    this.changed.add(audience);
  }

  /** Takes a cleared row out of an audience's bucket. */
  private owe(audience: Audience, name: string, source: TableKey): void {
    const bucket = audience.buckets.get(name);
    bucket?.withheld.delete(source);
    const key = bucket?.bySource.get(source);
    if (!bucket || key === undefined) return;
    bucket.bySource.delete(source);
    if (bucket.owner.get(key) !== source) return;
    this.note(audience, name, bucket, key, true, undefined);
    bucket.owner.delete(key);
    bucket.rows.delete(key);
    if (bucket.withheld.size > 0) this.free(audience, name, key);
  }

  /** Gives up the key a source row held when it no longer projects to it. */
  private release(
    audience: Audience,
    name: string,
    source: TableKey,
    projected: { key: string; value: Json } | null,
  ): void {
    const bucket = bucketOf(audience, name);
    // A withheld row is placed again, or withheld again, from what it is now.
    bucket.withheld.delete(source);
    const previousKey = bucket.bySource.get(source);
    if (
      previousKey === undefined ||
      (projected !== null && projected.key === previousKey)
    ) {
      return;
    }
    bucket.bySource.delete(source);
    if (bucket.owner.get(previousKey) !== source) return;
    this.note(audience, name, bucket, previousKey, false, undefined);
    bucket.owner.delete(previousKey);
    bucket.rows.delete(previousKey);
    if (bucket.withheld.size > 0) this.free(audience, name, previousKey);
  }

  private place(
    audience: Audience,
    name: string,
    source: TableKey,
    projected: { key: string; value: Json },
    tell = true,
  ): void {
    const bucket = bucketOf(audience, name);
    // Each projected row needs its own key. When two source rows claim one,
    // the first keeps it and the second is withheld, so removing either can
    // never take the other's row away from a viewer.
    const owner = bucket.owner.get(projected.key);
    if (owner !== undefined && owner !== source) {
      bucket.withheld.set(source, { key: projected.key, reported: false });
      return;
    }

    const encoded = JSON.stringify(projected.value);
    bucket.bySource.set(source, projected.key);
    bucket.owner.set(projected.key, source);
    if (bucket.rows.get(projected.key)?.encoded === encoded) return;
    if (tell) this.note(audience, name, bucket, projected.key, false, encoded);
    const bytes = rowBytes(name, projected.key, encoded);
    bucket.rows.set(projected.key, { encoded, value: projected.value, bytes });
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
          [...audience.buckets]
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
    const audience = newAudience({ subject });
    for (const [name, view] of Object.entries(this.definition.views)) {
      if (view.kind !== "personal") continue;
      bucketOf(audience, name);
      for (const [key, row] of this.store.rows(view.source)) {
        if (view.owner(row) !== subject) continue;
        const projected = this.project(name, () => view.project(row, this.policy));
        if (projected) this.place(audience, name, key, projected, false);
      }
    }
    return audience;
  }
}
