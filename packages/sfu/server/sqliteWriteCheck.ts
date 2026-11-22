import { unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
    const probe = join(dirname(path), `.write-check-${process.pid}`);
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
