import { existsSync, readdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Older SFUs fell back to JSON files in their container layer when SQLite was
 * locked. scripts/deploy-sfu.sh copies those files here, one folder per old
 * container, before it replaces the container; each store imports them once.
 */
export const fallbackImportDir = (): string => {
  const stateDir =
    process.env.RECORDING_STORAGE_PATH?.trim() ||
    dirname(resolve(process.env.CONCLAVE_SQLITE_PATH?.trim() || join(process.cwd(), "data", "conclave.sqlite")));
  return join(stateDir, "json-fallback-import");
};

export const pendingFallbackFiles = (fileName: string): string[] => {
  const root = fallbackImportDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, fileName))
    .filter((file) => existsSync(file));
};

export const markFallbackImported = (file: string): void => {
  try {
    renameSync(file, `${file}.imported`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

/** Adds records the store lacks and replaces older ones; a newer stored record wins. */
export const mergeNewerRecords = <T extends { updatedAt?: number }>(
  existing: T[],
  incoming: T[],
  keyOf: (record: T) => string,
): { merged: T[]; changed: T[] } => {
  const byKey = new Map(existing.map((record) => [keyOf(record), record]));
  const changed = new Map<string, T>();
  for (const record of incoming) {
    const key = keyOf(record);
    const current = byKey.get(key);
    if (current && (current.updatedAt ?? 0) >= (record.updatedAt ?? 0)) continue;
    byKey.set(key, record);
    changed.set(key, record);
  }
  return { merged: [...byKey.values()], changed: [...changed.values()] };
};
