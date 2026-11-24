import { randomBytes, randomUUID } from "node:crypto";
import { identityOf, specOf } from "./entities.js";
import { hashLegacyValue } from "./legacyHash.js";
import {
  InvalidInput,
  StoreCorruptionError,
  isDataKind,
  legacyCopyKey,
  UniqueViolation,
  fail,
  uniqueField,
  type Entropy,
  type EntityMap,
  type Kind,
  type Outcome,
  type RawStored,
  type Stored,
  type UniqueIndex,
} from "./model.js";

export interface Source {
  record(kind: Kind, id: string): RawStored | null;
  owner(field: string): string | null;
  tagMembers(kind: Kind, tag: string): readonly string[];
  allIds(kind: Kind): readonly string[];
  tombstone(kind: Kind, id: string): number | null;
}

export interface TxRead {
  readonly now: number;
  readonly entropy: Entropy;
  get<K extends Kind>(kind: K, id: string): Stored<K> | null;
  owner(index: UniqueIndex, key: string): string | null;
  lookup<K extends Kind>(kind: K, index: UniqueIndex, key: string): Stored<K> | null;
  tagged<K extends Kind>(kind: K, tag: string): Stored<K>[];
  all<K extends Kind>(kind: K): Stored<K>[];
  tombstone(kind: Kind, id: string): number | null;
}

export interface Tx extends TxRead {
  put<K extends Kind>(kind: K, value: EntityMap[K]): void;
  remove(kind: Kind, id: string): void;
  importLegacy<K extends Kind>(kind: K, value: EntityMap[K], stamp: number): string[];
}

export type Command<T> = (tx: Tx) => Outcome<T>;
export type Query<T> = (view: TxRead) => T;

export type RecordWrite = {
  kind: Kind;
  id: string;
  encoded: unknown;
  legacy: number | null;
};

export type WriteSet = {
  records: RecordWrite[];
  unique: Array<{ field: string; owner: string | null }>;
  tags: Array<{ kind: Kind; tag: string; id: string; present: boolean }>;
  tombstones: Array<{ kind: Kind; id: string }>;
};

export const isEmptyWriteSet = (writes: WriteSet): boolean => writes.records.length === 0;

const PENDING_REV = -1;

const INDEX_KIND: Record<UniqueIndex, Kind> = {
  profileUser: "profile",
  profileUsername: "profile",
  eventSlug: "eventType",
  meetingCode: "meeting",
  webinarSlug: "webinar",
  webinarRoom: "webinar",
  cohostToken: "webinar",
};

const slot = (kind: Kind, id: string): string => `${kind}\u0000${id}`;

type Pending = { kind: Kind; id: string; value: unknown; legacy: number | null };

export class ReplayEntropy implements Entropy {
  private readonly log: unknown[] = [];
  private cursor = 0;

  restart(): void {
    this.cursor = 0;
  }

  private next<T>(make: () => T): T {
    if (this.cursor < this.log.length) {
      const value = this.log[this.cursor] as T;
      this.cursor += 1;
      return value;
    }
    const value = make();
    this.log.push(value);
    this.cursor += 1;
    return value;
  }

  uuid = (): string => this.next(() => randomUUID());

  bytes = (length: number): Buffer =>
    Buffer.from(this.next(() => randomBytes(length).toString("hex")), "hex");

  float = (): number => this.next(() => Math.random());
}

class TxImpl implements Tx {
  readonly now: number;
  readonly entropy: Entropy;
  private readonly source: Source;
  private readonly decoded = new Map<string, Stored<Kind> | null>();
  private readonly pending = new Map<string, Pending>();
  private readonly uniqueChanges = new Map<string, string | null>();
  private readonly tagChanges = new Map<string, Map<string, boolean>>();
  private readonly removed = new Map<string, { kind: Kind; id: string }>();

  constructor(source: Source, now: number, entropy: Entropy) {
    this.source = source;
    this.now = now;
    this.entropy = entropy;
  }

  get<K extends Kind>(kind: K, id: string): Stored<K> | null {
    const key = slot(kind, id);
    const written = this.pending.get(key);
    if (written) {
      return written.value === null
        ? null
        : { rev: PENDING_REV, legacy: written.legacy, value: written.value as EntityMap[K] };
    }
    if (this.decoded.has(key)) return this.decoded.get(key) as Stored<K> | null;
    const raw = this.source.record(kind, id);
    let stored: Stored<K> | null = null;
    if (raw) {
      const value = specOf(kind).decode(raw.value);
      if (!value) throw new StoreCorruptionError(`Stored ${kind} ${id} is unreadable.`);
      stored = { rev: raw.rev, legacy: raw.legacy, value };
    }
    this.decoded.set(key, stored);
    return stored;
  }

  owner(index: UniqueIndex, key: string): string | null {
    return this.ownerOf(uniqueField(index, key));
  }

  lookup<K extends Kind>(kind: K, index: UniqueIndex, key: string): Stored<K> | null {
    const id = this.owner(index, key);
    return id ? this.get(kind, id) : null;
  }

  tagged<K extends Kind>(kind: K, tag: string): Stored<K>[] {
    const members = new Set(this.source.tagMembers(kind, tag));
    for (const [id, present] of this.tagChanges.get(slot(kind, tag)) ?? []) {
      if (present) members.add(id);
      else members.delete(id);
    }
    return this.collect(kind, members);
  }

  all<K extends Kind>(kind: K): Stored<K>[] {
    const ids = new Set(this.source.allIds(kind));
    for (const entry of this.pending.values()) {
      if (entry.kind === kind) ids.add(entry.id);
    }
    return this.collect(kind, ids);
  }

  tombstone(kind: Kind, id: string): number | null {
    if (this.removed.has(slot(kind, id))) return PENDING_REV;
    return this.source.tombstone(kind, id);
  }

  put<K extends Kind>(kind: K, value: EntityMap[K]): void {
    this.write(kind, value, null, false);
  }

  importLegacy<K extends Kind>(kind: K, value: EntityMap[K], stamp: number): string[] {
    return this.write(kind, value, stamp, true);
  }

  remove(kind: Kind, id: string): void {
    const current = this.get(kind, id);
    if (!current) return;
    const spec = specOf(kind);
    for (const [index, key] of spec.unique(current.value)) {
      const field = uniqueField(index, key);
      if (this.ownerOf(field) === id) this.uniqueChanges.set(field, null);
    }
    for (const tag of spec.tags(current.value)) this.setTag(kind, tag, id, false);
    const key = slot(kind, id);
    this.pending.set(key, { kind, id, value: null, legacy: null });
    this.removed.set(key, { kind, id });
    if (isDataKind(kind)) {
      this.write(
        "removal",
        {
          key: legacyCopyKey(kind, id),
          kind,
          id,
          identity: identityOf<Kind>(kind, current.value),
          hash: hashLegacyValue(current.value),
        },
        null,
        false,
      );
    }
  }

  writeSet(): WriteSet {
    return {
      records: [...this.pending.values()].map((entry) => ({
        kind: entry.kind,
        id: entry.id,
        encoded:
          entry.value === null
            ? null
            : specOf(entry.kind).encode(entry.value as never),
        legacy: entry.legacy,
      })),
      unique: [...this.uniqueChanges].map(([field, owner]) => ({ field, owner })),
      tags: [...this.tagChanges].flatMap(([key, members]) => {
        const [kind, tag] = key.split("\u0000") as [Kind, string];
        return [...members].map(([id, present]) => ({ kind, tag, id, present }));
      }),
      tombstones: [...this.removed.values()],
    };
  }

  private ownerOf(field: string): string | null {
    if (this.uniqueChanges.has(field)) return this.uniqueChanges.get(field) ?? null;
    const holder = this.source.owner(field);
    if (!holder) return null;
    const index = field.slice(0, field.indexOf(":")) as UniqueIndex;
    const kind = INDEX_KIND[index];
    const record = this.get(kind, holder);
    const claims = record
      ? specOf(kind)
          .unique(record.value)
          .some(([name, key]) => uniqueField(name, key) === field)
      : false;
    return claims ? holder : null;
  }

  private collect<K extends Kind>(kind: K, ids: Iterable<string>): Stored<K>[] {
    const result: Stored<K>[] = [];
    for (const id of ids) {
      const stored = this.get(kind, id);
      if (stored) result.push(stored);
    }
    return result;
  }

  private setTag(kind: Kind, tag: string, id: string, present: boolean): void {
    const key = slot(kind, tag);
    const members = this.tagChanges.get(key) ?? new Map<string, boolean>();
    members.set(id, present);
    this.tagChanges.set(key, members);
  }

  private write<K extends Kind>(
    kind: K,
    value: EntityMap[K],
    legacy: number | null,
    tolerateTaken: boolean,
  ): string[] {
    const spec = specOf(kind);
    const id = spec.id(value);
    const current = this.get(kind, id);
    const before = new Map(
      (current ? spec.unique(current.value) : []).map(([index, key]) => [
        uniqueField(index, key),
        true,
      ]),
    );
    const after = spec.unique(value).map(([index, key]) => uniqueField(index, key));
    const skipped: string[] = [];
    for (const field of before.keys()) {
      if (!after.includes(field) && this.ownerOf(field) === id) {
        this.uniqueChanges.set(field, null);
      }
    }
    for (const field of after) {
      if (before.has(field)) continue;
      const holder = this.ownerOf(field);
      if (holder && holder !== id) {
        if (!tolerateTaken) throw new UniqueViolation(field);
        skipped.push(field);
        continue;
      }
      this.uniqueChanges.set(field, id);
    }
    const tagsBefore = new Set(current ? spec.tags(current.value) : []);
    const tagsAfter = new Set(spec.tags(value));
    for (const tag of tagsBefore) if (!tagsAfter.has(tag)) this.setTag(kind, tag, id, false);
    for (const tag of tagsAfter) if (!tagsBefore.has(tag)) this.setTag(kind, tag, id, true);
    const key = slot(kind, id);
    this.pending.set(key, { kind, id, value, legacy });
    this.removed.delete(key);
    return skipped;
  }
}

export type Executed<T> = { outcome: Outcome<T>; writes: WriteSet };

export const execute = <T>(
  source: Source,
  command: Command<T>,
  context: { now: number; entropy: ReplayEntropy },
): Executed<T> => {
  context.entropy.restart();
  const tx = new TxImpl(source, context.now, context.entropy);
  let outcome: Outcome<T>;
  try {
    outcome = command(tx);
  } catch (error) {
    if (error instanceof UniqueViolation) {
      return { outcome: fail("duplicate", error.message), writes: emptyWriteSet() };
    }
    if (error instanceof InvalidInput) {
      return { outcome: fail("invalid", error.message), writes: emptyWriteSet() };
    }
    throw error;
  }
  return { outcome, writes: outcome.ok ? tx.writeSet() : emptyWriteSet() };
};

export const query = <T>(
  source: Source,
  read: Query<T>,
  context: { now: number; entropy: ReplayEntropy },
): T => {
  context.entropy.restart();
  return read(new TxImpl(source, context.now, context.entropy));
};

export const emptyWriteSet = (): WriteSet => ({
  records: [],
  unique: [],
  tags: [],
  tombstones: [],
});
