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
};

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
  owed: Map<string, Untold>;
};

/** Whose audience it is, to address what it is told. */
type AudienceOf = { role: Role } | { subject: Subject };

type Audience = { of: AudienceOf; buckets: Map<string, Bucket> };

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

/** What a viewer was sent of its view, bucket by bucket: each row as sent. */
export type HeldRows = Map<string, Map<string, Json>>;

/** Framing around one row on the wire: its field names and punctuation. */
const ROW_OVERHEAD_BYTES = 32;

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
  private whole: ViewOps | null = null;

  constructor(private readonly told: readonly Told[]) {
    this.since = told.reduce(
      (first, change) => Math.min(first, change.steps[0].at),
      Number.POSITIVE_INFINITY,
    );
  }

  /**
   * The changes for a viewer whose snapshot was read at `version`, or
   * undefined when there is nothing to tell them.
   */
  for(version: number): ViewOps | undefined {
    // Nearly every viewer took their view before any of it: one answer.
    const ops =
      version < this.since
        ? (this.whole ??= this.opsSince(version))
        : this.opsSince(version);
    return ops.put.length === 0 && ops.remove.length === 0 ? undefined : ops;
  }

  private opsSince(version: number): ViewOps {
    const ops = emptyOps();
    for (const change of this.told) {
      // The row as their snapshot had it: the last thing it became by then.
      let held = change.before;
      for (const step of change.steps) {
        if (step.at > version) break;
        held = step.encoded;
      }
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
        ops.bytes += change.bucket.length + change.key.length + ROW_OVERHEAD_BYTES;
      }
    }
    return ops;
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
  }

  /** Whether some viewer has yet to be told of a change. */
  get hasUntold(): boolean {
    return this.changed.size > 0;
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
    return { rows, version: this.version };
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
        ops.bytes += bucket.length + key.length + ROW_OVERHEAD_BYTES;
      }
    }
    return { ops, version: this.version };
  }

  /** Forgets the views of audiences nobody holds any more. */
  keep(live: LiveAudiences): void {
    for (const [role, audience] of this.roles) {
      if (live.roles.has(role)) continue;
      this.roles.delete(role);
      this.changed.delete(audience);
    }
    for (const [subject, audience] of this.subjects) {
      if (live.subjects.has(subject)) continue;
      this.subjects.delete(subject);
      this.changed.delete(audience);
    }
  }

  /**
   * Takes in every committed write and returns what each live audience must
   * be told. Audiences that left are forgotten.
   */
  flush(live: LiveAudiences): ViewFlush {
    this.keep(live);
    this.absorb();
    const flushed = this.tell();
    if (this.options.verify) this.verify();
    return flushed;
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
   * Gathers what each audience is told now. Ordinary changes are told in
   * full. Rows a `clear` took are told a bounded number in one flush: each
   * role's audience up to `clearedRowsPerFlush` of them, which bounds the
   * patch. People's own rows share one such allowance between them, because
   * each person told is a frame of their own. A person is told all they are
   * owed in one frame where the allowance lasts, so 5,000 people who each
   * held five such rows get one frame each and not five.
   */
  private tell(): ViewFlush {
    const shared = new Map<Role, ViewChanges>();
    const personal = new Map<Subject, ViewChanges>();
    // At least one, or the telling would never finish.
    const allowance = Math.max(1, this.options.clearedRowsPerFlush);
    let leftForPeople = allowance;
    for (const audience of this.changed) {
      const forRole = "role" in audience.of;
      let room = forRole ? allowance : leftForPeople;
      const told: Told[] = [];
      let settled = true;
      for (const [name, bucket] of audience.buckets) {
        for (const [key, change] of bucket.untold) {
          told.push({ ...change, bucket: name, key, now: bucket.rows.get(key) });
        }
        bucket.untold.clear();
        for (const [key, change] of bucket.owed) {
          if (room === 0) {
            settled = false;
            break;
          }
          room -= 1;
          bucket.owed.delete(key);
          told.push({ ...change, bucket: name, key, now: bucket.rows.get(key) });
        }
      }
      if (!forRole) leftForPeople = room;
      if (settled) this.changed.delete(audience);
      if (told.length === 0) continue;
      if ("role" in audience.of) {
        shared.set(audience.of.role, new ViewChanges(told));
      } else {
        personal.set(audience.of.subject, new ViewChanges(told));
      }
    }
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

  /**
   * A role's view built from the committed rows. Nobody holds it yet, so
   * nothing in it is noted as a change to tell.
   */
  private buildRole(role: Role): Audience {
    const audience: Audience = { of: { role }, buckets: new Map() };
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
    const audience: Audience = { of: { subject }, buckets: new Map() };
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
   * `clear` took, which is told in batches.
   */
  private note(
    audience: Audience,
    bucket: Bucket,
    key: string,
    later: boolean,
    next: string | undefined,
  ): void {
    const noted = bucket.untold.get(key) ?? bucket.owed.get(key);
    const change = noted ?? { before: bucket.rows.get(key)?.encoded, steps: [] };
    // One version is one moment: only where the key ended up in it counts.
    const last = change.steps[change.steps.length - 1];
    if (last?.at === this.version) last.encoded = next;
    else change.steps.push({ at: this.version, encoded: next });
    (later ? bucket.untold : bucket.owed).delete(key);
    (later ? bucket.owed : bucket.untold).set(key, change);
    this.changed.add(audience);
  }

  /** Takes a cleared row out of an audience's bucket. */
  private owe(audience: Audience, name: string, source: TableKey): void {
    const bucket = audience.buckets.get(name);
    const key = bucket?.bySource.get(source);
    if (!bucket || key === undefined) return;
    bucket.bySource.delete(source);
    if (bucket.owner.get(key) !== source) return;
    this.note(audience, bucket, key, true, undefined);
    bucket.owner.delete(key);
    bucket.rows.delete(key);
  }

  /** Gives up the key a source row held when it no longer projects to it. */
  private release(
    audience: Audience,
    name: string,
    source: TableKey,
    projected: { key: string; value: Json } | null,
  ): void {
    const bucket = bucketOf(audience, name);
    const previousKey = bucket.bySource.get(source);
    if (
      previousKey === undefined ||
      (projected !== null && projected.key === previousKey)
    ) {
      return;
    }
    bucket.bySource.delete(source);
    if (bucket.owner.get(previousKey) !== source) return;
    this.note(audience, bucket, previousKey, false, undefined);
    bucket.owner.delete(previousKey);
    bucket.rows.delete(previousKey);
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
      const message = `${this.definition.contract.id}: view ${name} projected two rows to the key "${projected.key}"`;
      if (this.options.verify) throw new Error(message);
      Logger.error(`[Authority] ${message}. The later row is withheld.`);
      return;
    }

    const encoded = JSON.stringify(projected.value);
    bucket.bySource.set(source, projected.key);
    bucket.owner.set(projected.key, source);
    if (bucket.rows.get(projected.key)?.encoded === encoded) return;
    if (tell) this.note(audience, bucket, projected.key, false, encoded);
    const bytes =
      Buffer.byteLength(encoded) +
      name.length +
      projected.key.length +
      ROW_OVERHEAD_BYTES;
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
    const audience: Audience = { of: { subject }, buckets: new Map() };
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
