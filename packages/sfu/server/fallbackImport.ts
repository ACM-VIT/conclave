import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { Logger } from "../utilities/loggers.js";
import { isSqliteLockedError } from "./sqliteWriteCheck.js";

/**
 * Older SFUs fell back to JSON files in their container layer when SQLite was
 * locked. The deploy copies them into CONCLAVE_FALLBACK_IMPORT_DIR, one folder
 * per old container. The SFU image sets that path on the recordings mount, so
 * the copy and this import read the same container path, never a host path.
 */
export const fallbackImportDir = (): string =>
  resolve(process.env.CONCLAVE_FALLBACK_IMPORT_DIR?.trim() || join(process.cwd(), "data", "json-fallback-import"));

const IMPORTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const containerDirs = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(root, name));

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Recovered records name hosts and attendees: only the SFU user may read them, and archives go after a week. */
const secureImportDir = (root: string): void => {
  try {
    chmodSync(root, 0o700);
    for (const dir of containerDirs(root)) {
      chmodSync(dir, 0o700);
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (name.endsWith(".imported") && Date.now() - statSync(file).mtimeMs > IMPORTED_RETENTION_MS) {
          rmSync(file, { force: true });
        } else {
          chmodSync(file, 0o600);
        }
      }
    }
  } catch (error) {
    Logger.warn(`Could not restrict or prune ${root} (${reasonOf(error)})`);
  }
};

const pendingFallbackFiles = (fileName: string): string[] => {
  const root = fallbackImportDir();
  if (!existsSync(root)) return [];
  secureImportDir(root);
  return containerDirs(root)
    .map((dir) => join(dir, fileName))
    .filter((file) => existsSync(file));
};

const markFallbackImported = (file: string): void => {
  try {
    const archived = `${file}.imported`;
    renameSync(file, archived);
    const now = new Date();
    utimesSync(archived, now, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    Logger.warn(`Imported ${file} but could not rename it (${reasonOf(error)}); the next start checks it again`);
  }
};

export type FallbackImporter<T> = {
  fileName: string;
  noun: string;
  records: (data: unknown) => T[];
  describe: (record: T, index: number) => string;
  importIfNewer: (record: T) => boolean | Promise<boolean>;
};

export const importFallbackFiles = async <T>(importer: FallbackImporter<T>): Promise<number> => {
  const files = pendingFallbackFiles(importer.fileName);
  if (files.length === 0) return 0;
  const { importIfNewer } = importer;
  let imported = 0;
  for (const file of files) {
    const failures: string[] = [];
    try {
      const records = importer.records(JSON.parse(readFileSync(file, "utf8")));
      for (const [index, record] of records.entries()) {
        try {
          if (await importIfNewer(record)) imported += 1;
        } catch (error) {
          if (isSqliteLockedError(error)) throw error;
          failures.push(`${importer.describe(record, index)}: ${reasonOf(error)}`);
        }
      }
    } catch (error) {
      if (isSqliteLockedError(error)) throw error;
      failures.push(reasonOf(error));
    }
    if (failures.length === 0) {
      markFallbackImported(file);
    } else {
      Logger.warn(`Kept ${file} for the next start; ${failures.length} part(s) did not import: ${failures.join("; ")}`);
    }
  }
  Logger.warn(`Imported ${imported} ${importer.noun}(s) from ${files.length} JSON fallback file(s)`);
  return imported;
};

export const requireArray = (data: unknown, what: string): unknown[] => {
  if (!Array.isArray(data)) throw new Error(`expected an array of ${what}`);
  return data;
};

export const describeEntry = (noun: string) => (entry: unknown, index: number): string => {
  const id = entry && typeof entry === "object" && "id" in entry ? String(entry.id) : "";
  return id ? `${noun} ${id}` : `${noun} #${index + 1}`;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const readJsonStore = (path: string): unknown =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;

export const replaceIfNewer = (
  entries: unknown[],
  matches: (entry: Record<string, unknown>) => boolean,
  incoming: unknown,
  incomingUpdatedAt: number,
  storedUpdatedAt: (entry: Record<string, unknown>) => number = (entry) => finiteNumber(entry.updatedAt) ?? 0,
): boolean => {
  const index = entries.findIndex((entry) => isObject(entry) && matches(entry));
  const stored = entries[index];
  if (isObject(stored) && storedUpdatedAt(stored) >= incomingUpdatedAt) return false;
  if (index >= 0) entries[index] = incoming;
  else entries.push(incoming);
  return true;
};

export const requireRecord = <T>(record: T | null, noun: string): T => {
  if (!record) throw new Error(`not a stored ${noun}`);
  return record;
};
