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

/**
 * Reads a JSON store: one array holding the live records and, as entries
 * marked `deleted`, the deletion stamps. Older SFUs skip the stamp entries,
 * because they are not valid records.
 */
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

/**
 * Applies changed records and deletion stamps to a JSON store in one atomic
 * write, by the same rule as SQLite and Redis: per record, the newest stamp
 * wins, a value or a deletion. `newer` keeps what is stored on a tie, for
 * imports. Returns how many records the change wrote.
 */
export const commitStampedJson = <T extends Stamped>(
  path: string,
  normalize: (entry: unknown) => T | null,
  change: StampedChange<T>,
  mode: "save" | "newer" = "save",
): number => {
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
  return written;
};
