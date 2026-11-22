import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Logger } from "../utilities/loggers.js";

type SqliteDatabase = { exec(sql: string): void; close(): void };

const PERMISSION_ERROR = /readonly|EACCES|EPERM|EROFS/i;

// SQLite rolls back on its own after some I/O errors; keep the original error.
const rollbackIfOpen = (db: SqliteDatabase): void => {
  try {
    db.exec("ROLLBACK");
  } catch {
    return;
  }
};

/**
 * Proves at startup that the SFU can write its SQLite file and the directory
 * beside it. Images before the non-root switch left both owned by root, and
 * SQLite then opens the file read-only: schema checks pass and every later
 * save fails after the request has already answered.
 */
export const assertSqliteWritable = (db: SqliteDatabase, path: string): void => {
  try {
    // Both SFU containers run as PID 1 on one volume, so the name must be unique.
    const probe = join(dirname(path), `.write-check-${randomUUID()}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE IF NOT EXISTS conclave_write_check (id INTEGER)");
      db.exec("INSERT INTO conclave_write_check (id) VALUES (1)");
    } finally {
      rollbackIfOpen(db);
    }
  } catch (error) {
    db.close();
    const reason = error instanceof Error ? error.message : String(error);
    if (!PERMISSION_ERROR.test(reason)) throw error;
    throw new Error(
      `${path} is not writable by uid ${process.getuid?.() ?? "unknown"} (${reason}). Hand the recordings volume to the SFU user with the ownership step in packages/sfu/README.md; scripts/deploy-sfu.sh runs it before starting each container.`,
      { cause: error },
    );
  }
};

const LOCKED = /database is locked|SQLITE_BUSY/i;

export const isSqliteLockedError = (error: unknown): boolean =>
  LOCKED.test(error instanceof Error ? error.message : String(error));

/**
 * Two SFUs open the shared SQLite file together at boot, and one can hold its
 * write lock past the other's busy timeout. Retries a locked store with
 * backoff inside a startup budget; any other failure stops startup at once.
 */
export const retryWhileSqliteLocked = async <T>(
  step: () => T | Promise<T>,
  { budgetMs = 60_000, sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)) } = {},
): Promise<T> => {
  const deadline = Date.now() + budgetMs;
  for (let delay = 250; ; delay = Math.min(delay * 2, 4_000)) {
    try {
      return await step();
    } catch (error) {
      if (!isSqliteLockedError(error) || Date.now() + delay > deadline) throw error;
      Logger.warn(`SQLite is locked by another process (${error instanceof Error ? error.message : String(error)}); retrying in ${delay} ms`);
      await sleep(delay);
    }
  }
};
