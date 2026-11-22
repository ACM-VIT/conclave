import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Logger } from "../utilities/loggers.js";
import { isSqliteLockedError } from "./sqliteWriteCheck.js";

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

const pendingFallbackFiles = (fileName: string): string[] => {
  const root = fallbackImportDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, fileName))
    .filter((file) => existsSync(file));
};

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const markFallbackImported = (file: string): void => {
  try {
    renameSync(file, `${file}.imported`);
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
  importIfNewer: ((record: T) => boolean | Promise<boolean>) | undefined;
};

export const importFallbackFiles = async <T>(importer: FallbackImporter<T>): Promise<number> => {
  const files = pendingFallbackFiles(importer.fileName);
  if (files.length === 0) return 0;
  const { importIfNewer } = importer;
  if (!importIfNewer) {
    Logger.warn(`Left ${files.length} JSON fallback file(s) in place: this ${importer.noun} store cannot import them (${files.join(", ")})`);
    return 0;
  }
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

export const requireRecord = <T>(record: T | null, noun: string): T => {
  if (!record) throw new Error(`not a stored ${noun}`);
  return record;
};
