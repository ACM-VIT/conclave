import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CARRY_TABLE, consolidateForCarry, prepareFolder, readCarryMark, targetState } from "../server/layerDatabase.js";

const dirs: string[] = [];
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "layer-database-")));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const writeUncheckpointed = (path: string, ids: string[]): void => {
  const script = `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE meetings (id TEXT PRIMARY KEY)");
for (const id of JSON.parse(process.argv[2])) db.prepare("INSERT INTO meetings (id) VALUES (?)").run(id);
process.kill(process.pid, "SIGKILL");`;
  spawnSync(process.execPath, ["--no-warnings", "-e", script, path, JSON.stringify(ids)], { stdio: "ignore" });
};

const rows = (path: string): string[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT id FROM meetings ORDER BY id").all().map((row) => String(row.id));
  } finally {
    db.close();
  }
};

const mark = { container: "4f2c1d", startedAt: "2026-11-25T08:00:00.000000000Z" };

describe("carrying a database out of an old container's layer", () => {
  it("folds the write-ahead log into one self-contained file that records where it came from", () => {
    const path = join(scratch(), "db");
    writeUncheckpointed(path, ["kept", "only in the log"]);
    expect(existsSync(`${path}-wal`)).toBe(true);

    consolidateForCarry(path, mark);

    expect(readdirSync(join(path, "..")).sort()).toEqual(["db"]);
    expect(rows(path)).toEqual(["kept", "only in the log"]);
    expect(readCarryMark(path)).toEqual(mark);
  });

  it("refuses a file that is not a sound database and leaves no mark", () => {
    const path = join(scratch(), "db");
    writeFileSync(path, "SQLite format 3\0 but not really a database");
    expect(() => consolidateForCarry(path, mark)).toThrow();
    expect(readCarryMark(path)).toBeNull();
  });

  it("names every state a target can be in, and reads a mark only from a closed, single-file database", () => {
    const dir = scratch();
    const carried = join(dir, "carried.sqlite");
    writeUncheckpointed(carried, ["kept"]);
    consolidateForCarry(carried, mark);
    const unmarked = join(dir, "unmarked.sqlite");
    new DatabaseSync(unmarked).close();
    const markedButOpen = join(dir, "open.sqlite");
    writeUncheckpointed(markedButOpen, ["kept"]);
    const notADatabase = join(dir, "text.sqlite");
    writeFileSync(notADatabase, "kept");
    const logOnly = join(dir, "log-only.sqlite");
    writeFileSync(`${logOnly}-wal`, "kept");
    const journalOnly = join(dir, "journal-only.sqlite");
    writeFileSync(`${journalOnly}-journal`, "");
    writeFileSync(join(dir, "a-file"), "");

    expect({
      free: targetState(join(dir, "free.sqlite"), dir),
      carried: targetState(carried, dir),
      unmarked: targetState(unmarked, dir),
      "a database with its log beside it": targetState(markedButOpen, dir),
      "not a database": targetState(notADatabase, dir),
      "a log with no database": targetState(logOnly, dir),
      "a journal with no database": targetState(journalOnly, dir),
      "folders that do not exist yet": targetState(join(dir, "missing", "deeper", "db.sqlite"), dir),
      "under a file, not a folder": targetState(join(dir, "a-file", "db.sqlite"), dir),
      "off the volume": targetState(join(scratch(), "db.sqlite"), dir),
      "the volume folder itself": targetState(dir, dir),
    }).toEqual({
      free: { state: "free" },
      carried: { state: "carried", mark },
      unmarked: { state: "taken" },
      "a database with its log beside it": { state: "taken" },
      "not a database": { state: "taken" },
      "a log with no database": { state: "taken" },
      "a journal with no database": { state: "taken" },
      "folders that do not exist yet": { state: "free" },
      "under a file, not a folder": { state: "unwritable" },
      "off the volume": { state: "outside" },
      "the volume folder itself": { state: "outside" },
    });
    expect(readdirSync(dir).filter((name) => name.startsWith(".conclave-write-check-"))).toEqual([]);
  });

  it("creates every missing folder inside the volume with mode 0700 for the given owner, and nothing outside it", () => {
    const volume = scratch();
    mkdirSync(join(volume, "existing"));
    const owner = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    prepareFolder(join(volume, "existing", "state", "deeper"), volume, owner);
    expect([join(volume, "existing", "state"), join(volume, "existing", "state", "deeper")].map((folder) => (statSync(folder).mode & 0o777).toString(8))).toEqual(["700", "700"]);
    prepareFolder(join(volume, "existing", "state", "deeper"), volume, owner);
    const outside = join(scratch(), "elsewhere");
    expect(() => prepareFolder(outside, volume, owner)).toThrow(/not on the recordings volume/);
    expect(existsSync(outside)).toBe(false);
  });

  it("keeps every earlier mark and reads the latest", () => {
    const path = join(scratch(), "db");
    writeUncheckpointed(path, ["kept"]);
    consolidateForCarry(path, mark);
    consolidateForCarry(path, { container: "9e8d7c", startedAt: "2026-11-25T09:30:00.000000000Z" });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare(`SELECT count(*) AS marks FROM ${CARRY_TABLE}`).get()).toEqual({ marks: 2 });
    } finally {
      db.close();
    }
    expect(readCarryMark(path)).toEqual({ container: "9e8d7c", startedAt: "2026-11-25T09:30:00.000000000Z" });
  });
});
