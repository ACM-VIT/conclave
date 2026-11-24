import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { asRecord } from "../../../utilities/untrusted.js";
import { openSqliteStore } from "../../sqliteWriteCheck.js";
import { StoreUnavailableError, type CommitResult, type RawStored } from "../model.js";
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

type Statement = {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

export type SqliteDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
};

export const openSqliteDatabase = (path: string): SqliteDatabase => {
  mkdirSync(dirname(path), { recursive: true });
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  return new DatabaseSync(path);
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS control_plane_records (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    legacy INTEGER,
    value_json TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE TABLE IF NOT EXISTS control_plane_unique (
    field TEXT PRIMARY KEY,
    owner TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS control_plane_tags (
    kind TEXT NOT NULL,
    tag TEXT NOT NULL,
    id TEXT NOT NULL,
    PRIMARY KEY (kind, tag, id)
  );
  CREATE TABLE IF NOT EXISTS control_plane_tombstones (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE TABLE IF NOT EXISTS control_plane_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
`;

const unavailable = (error: unknown): Error =>
  error instanceof Error && /database is locked|SQLITE_BUSY|disk I\/O|SQLITE_IOERR|readonly/i.test(error.message)
    ? new StoreUnavailableError(`Control-plane SQLite store is unavailable: ${error.message}`, {
        cause: error,
      })
    : error instanceof Error
      ? error
      : new Error(String(error));

export const createSqliteBackend = (path: string): Backend =>
  openSqliteStore(openSqliteDatabase(path), path, sqliteBackendOn);

export const SQLITE_COMMIT_WAIT_MS = 1_000;

const commitWaitMs = (): number => {
  const configured = Number(process.env.CONTROL_PLANE_SQLITE_COMMIT_WAIT_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : SQLITE_COMMIT_WAIT_MS;
};

const sqliteBackendOn = (db: SqliteDatabase): Backend => {
  db.exec(SCHEMA);
  db.exec(`PRAGMA busy_timeout = ${commitWaitMs()}`);

  const statements = {
    record: db.prepare(
      "SELECT rev, legacy, value_json FROM control_plane_records WHERE kind = ? AND id = ?",
    ),
    ids: db.prepare("SELECT id FROM control_plane_records WHERE kind = ?"),
    owner: db.prepare("SELECT owner FROM control_plane_unique WHERE field = ?"),
    members: db.prepare("SELECT id FROM control_plane_tags WHERE kind = ? AND tag = ?"),
    tombstone: db.prepare(
      "SELECT rev FROM control_plane_tombstones WHERE kind = ? AND id = ?",
    ),
    rev: db.prepare("SELECT value FROM control_plane_meta WHERE key = 'rev'"),
    setRev: db.prepare(
      "INSERT INTO control_plane_meta (key, value) VALUES ('rev', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
    putRecord: db.prepare(
      "INSERT INTO control_plane_records (kind, id, rev, legacy, value_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET rev = excluded.rev, legacy = excluded.legacy, value_json = excluded.value_json",
    ),
    dropRecord: db.prepare("DELETE FROM control_plane_records WHERE kind = ? AND id = ?"),
    putOwner: db.prepare(
      "INSERT INTO control_plane_unique (field, owner) VALUES (?, ?) ON CONFLICT(field) DO UPDATE SET owner = excluded.owner",
    ),
    dropOwner: db.prepare("DELETE FROM control_plane_unique WHERE field = ?"),
    addTag: db.prepare(
      "INSERT OR IGNORE INTO control_plane_tags (kind, tag, id) VALUES (?, ?, ?)",
    ),
    dropTag: db.prepare("DELETE FROM control_plane_tags WHERE kind = ? AND tag = ? AND id = ?"),
    putTombstone: db.prepare(
      "INSERT INTO control_plane_tombstones (kind, id, rev) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET rev = excluded.rev",
    ),
  };

  const ids = (rows: unknown[]): string[] =>
    rows.map((row) => asRecord(row).id).filter((id): id is string => typeof id === "string");

  const source: Source = {
    record: (kind, id): RawStored | null => {
      const row = statements.record.get(kind, id);
      if (!row) return null;
      const fields = asRecord(row);
      const value: unknown = JSON.parse(String(fields.value_json));
      return {
        rev: Number(fields.rev),
        legacy: fields.legacy === null || fields.legacy === undefined ? null : Number(fields.legacy),
        value,
      };
    },
    owner: (field) => {
      const row = statements.owner.get(field);
      const owner = row ? asRecord(row).owner : null;
      return typeof owner === "string" ? owner : null;
    },
    tagMembers: (kind, tag) => ids(statements.members.all(kind, tag)),
    allIds: (kind) => ids(statements.ids.all(kind)),
    tombstone: (kind, id) => {
      const row = statements.tombstone.get(kind, id);
      return row ? Number(asRecord(row).rev) : null;
    },
  };

  const currentRev = (): number => {
    const row = statements.rev.get();
    return row ? Number(asRecord(row).value) : 0;
  };

  const apply = (writes: WriteSet, rev: number): void => {
    for (const write of writes.records) {
      if (write.encoded === null) statements.dropRecord.run(write.kind, write.id);
      else {
        statements.putRecord.run(
          write.kind,
          write.id,
          rev,
          write.legacy,
          JSON.stringify(write.encoded),
        );
      }
    }
    for (const change of writes.unique) {
      if (change.owner === null) statements.dropOwner.run(change.field);
      else statements.putOwner.run(change.field, change.owner);
    }
    for (const change of writes.tags) {
      if (change.present) statements.addTag.run(change.kind, change.tag, change.id);
      else statements.dropTag.run(change.kind, change.tag, change.id);
    }
    for (const removal of writes.tombstones) {
      statements.putTombstone.run(removal.kind, removal.id, rev);
    }
    statements.setRev.run(rev);
  };

  const rollback = (): void => {
    try {
      db.exec("ROLLBACK");
    } catch {
      return;
    }
  };

  let closed = false;
  const commit = <T>(command: Command<T>, now: number): CommitResult<T> => {
    if (closed) throw new Error("The control-plane store is closed.");
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw unavailable(error);
    }
    try {
      const { outcome, writes } = execute(source, command, {
        now,
        entropy: new ReplayEntropy(),
      });
      if (!outcome.ok) {
        rollback();
        return outcome;
      }
      if (isEmptyWriteSet(writes)) {
        const rev = currentRev();
        rollback();
        return { ok: true, value: outcome.value, rev };
      }
      const rev = currentRev() + 1;
      apply(writes, rev);
      db.exec("COMMIT");
      return { ok: true, value: outcome.value, rev };
    } catch (error) {
      rollback();
      throw unavailable(error);
    }
  };

  const read = <T>(read: Query<T>, now: number): T => {
    if (closed) throw new Error("The control-plane store is closed.");
    try {
      db.exec("BEGIN");
    } catch (error) {
      throw unavailable(error);
    }
    try {
      return query(source, read, { now, entropy: new ReplayEntropy() });
    } catch (error) {
      throw unavailable(error);
    } finally {
      rollback();
    }
  };

  return {
    mode: "sqlite",
    commit: async (command, now) => commit(command, now),
    read: async (readFn, now) => read(readFn, now),
    close: async () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
};
