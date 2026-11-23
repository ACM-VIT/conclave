import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Stamped = { id: string; updatedAt: number };
export type Deletion = { id: string; deletedAt: number };
export type StampedState<T> = { records: T[]; deletedAt: Map<string, number> };
export type StampedChange<T> = { upserts: T[]; deletions: Deletion[] };

type StoredDeletion = { id: string; deletedAt: number; deleted: true };

const isStoredDeletion = (entry: unknown): entry is StoredDeletion =>
  Boolean(entry) &&
  typeof entry === "object" &&
  (entry as { deleted?: unknown }).deleted === true &&
  typeof (entry as { id?: unknown }).id === "string" &&
  Number.isFinite((entry as { deletedAt?: unknown }).deletedAt);

const writeAtomic = (path: string, data: string): void => {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
};

export const readStampedJson = <T>(path: string, normalize: (entry: unknown) => T | null): StampedState<T> => {
  if (!existsSync(path)) return { records: [], deletedAt: new Map() };
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data)) throw new Error(`${path} is not a list of records`);
  const deletedAt = new Map<string, number>();
  const records: T[] = [];
  for (const entry of data) {
    if (isStoredDeletion(entry)) {
      deletedAt.set(entry.id, Math.max(deletedAt.get(entry.id) ?? 0, entry.deletedAt));
      continue;
    }
    const record = normalize(entry);
    if (record) records.push(record);
  }
  return { records, deletedAt };
};

export type StampedCommit<T> = { id: string; record: T | null; deletedAt: number | null };

export const commitStampedJson = <T extends Stamped>(
  path: string,
  normalize: (entry: unknown) => T | null,
  change: StampedChange<T>,
  mode: "save" | "newer" = "save",
): { written: number; touched: StampedCommit<T>[] } => {
  const state = readStampedJson(path, normalize);
  const byId = new Map(state.records.map((record) => [record.id, record]));
  const wins = (incoming: number, stored: number | undefined): boolean =>
    stored === undefined || (mode === "newer" ? incoming > stored : incoming >= stored);
  let written = 0;
  for (const record of change.upserts) {
    if (!wins(record.updatedAt, state.deletedAt.get(record.id)) || !wins(record.updatedAt, byId.get(record.id)?.updatedAt)) {
      continue;
    }
    byId.set(record.id, record);
    written += 1;
  }
  for (const { id, deletedAt } of change.deletions) {
    const held = byId.get(id);
    if (held && held.updatedAt < deletedAt) byId.delete(id);
    state.deletedAt.set(id, Math.max(state.deletedAt.get(id) ?? 0, deletedAt));
  }
  const stamps: StoredDeletion[] = [...state.deletedAt].map(([id, deletedAt]) => ({ id, deletedAt, deleted: true }));
  writeAtomic(path, JSON.stringify([...byId.values(), ...stamps], null, 2));
  const ids = [...new Set([...change.upserts.map((record) => record.id), ...change.deletions.map((deletion) => deletion.id)])];
  return {
    written,
    touched: ids.map((id) => ({ id, record: byId.get(id) ?? null, deletedAt: state.deletedAt.get(id) ?? null })),
  };
};
