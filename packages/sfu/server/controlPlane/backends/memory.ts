import { KINDS, type CommitResult, type Kind, type RawStored } from "../model.js";
import {
  ReplayEntropy,
  execute,
  isEmptyWriteSet,
  query,
  type Command,
  type Query,
  type Source,
  type WriteSet,
} from "../tx.js";
import type { Backend } from "./backend.js";

type StoredText = { rev: number; legacy: number | null; json: string };

export type MemoryData = {
  rev: number;
  records: Record<Kind, Map<string, StoredText>>;
  unique: Map<string, string>;
  tags: Map<string, Set<string>>;
  tombstones: Map<string, number>;
};

const tagKey = (kind: Kind, tag: string): string => `${kind}|${tag}`;
const tombKey = (kind: Kind, id: string): string => `${kind}:${id}`;

export const createMemoryData = (): MemoryData => ({
  rev: 0,
  records: Object.fromEntries(KINDS.map((kind) => [kind, new Map()])) as Record<
    Kind,
    Map<string, StoredText>
  >,
  unique: new Map(),
  tags: new Map(),
  tombstones: new Map(),
});

export const memorySource = (data: MemoryData): Source => ({
  record: (kind, id): RawStored | null => {
    const stored = data.records[kind].get(id);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored.json);
    return { rev: stored.rev, legacy: stored.legacy, value };
  },
  owner: (field) => data.unique.get(field) ?? null,
  tagMembers: (kind, tag) => [...(data.tags.get(tagKey(kind, tag)) ?? [])],
  allIds: (kind) => [...data.records[kind].keys()],
  tombstone: (kind, id) => data.tombstones.get(tombKey(kind, id)) ?? null,
});

export const applyWriteSet = (data: MemoryData, writes: WriteSet): () => void => {
  const undo: Array<() => void> = [];
  const previousRev = data.rev;
  const rev = data.rev + 1;
  data.rev = rev;
  undo.push(() => {
    data.rev = previousRev;
  });
  for (const write of writes.records) {
    const map = data.records[write.kind];
    const before = map.get(write.id);
    undo.push(() => {
      if (before) map.set(write.id, before);
      else map.delete(write.id);
    });
    if (write.encoded === null) map.delete(write.id);
    else map.set(write.id, { rev, legacy: write.legacy, json: JSON.stringify(write.encoded) });
  }
  for (const change of writes.unique) {
    const before = data.unique.get(change.field);
    undo.push(() => {
      if (before === undefined) data.unique.delete(change.field);
      else data.unique.set(change.field, before);
    });
    if (change.owner === null) data.unique.delete(change.field);
    else data.unique.set(change.field, change.owner);
  }
  for (const change of writes.tags) {
    const key = tagKey(change.kind, change.tag);
    const members = data.tags.get(key) ?? new Set<string>();
    const had = members.has(change.id);
    undo.push(() => {
      const current = data.tags.get(key) ?? new Set<string>();
      if (had) current.add(change.id);
      else current.delete(change.id);
      if (current.size === 0) data.tags.delete(key);
      else data.tags.set(key, current);
    });
    if (change.present) members.add(change.id);
    else members.delete(change.id);
    if (members.size === 0) data.tags.delete(key);
    else data.tags.set(key, members);
  }
  for (const removal of writes.tombstones) {
    const key = tombKey(removal.kind, removal.id);
    const before = data.tombstones.get(key);
    undo.push(() => {
      if (before === undefined) data.tombstones.delete(key);
      else data.tombstones.set(key, before);
    });
    data.tombstones.set(key, rev);
  }
  return () => {
    for (const step of undo.reverse()) step();
  };
};

export const runOnMemory = <T>(
  data: MemoryData,
  command: Command<T>,
  now: number,
  persist: () => void,
): CommitResult<T> => {
  const { outcome, writes } = execute(memorySource(data), command, {
    now,
    entropy: new ReplayEntropy(),
  });
  if (!outcome.ok) return outcome;
  if (isEmptyWriteSet(writes)) return { ok: true, value: outcome.value, rev: data.rev };
  const undo = applyWriteSet(data, writes);
  try {
    persist();
  } catch (error) {
    undo();
    throw error;
  }
  return { ok: true, value: outcome.value, rev: data.rev };
};

export const readMemory = <T>(data: MemoryData, read: Query<T>, now: number): T =>
  query(memorySource(data), read, { now, entropy: new ReplayEntropy() });

export const createMemoryBackend = (data: MemoryData = createMemoryData()): Backend => ({
  mode: "memory",
  commit: async (command, now) => runOnMemory(data, command, now, () => {}),
  read: async (read, now) => readMemory(data, read, now),
  close: async () => {},
});
