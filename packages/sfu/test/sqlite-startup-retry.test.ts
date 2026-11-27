import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allWebinars } from "../server/controlPlane/webinarCommands.js";
import { openControlPlane } from "../server/controlPlane/open.js";
import { retryWhileSqliteLocked } from "../server/sqliteWriteCheck.js";

let dir = "";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

// Another SFU holds the shared database's write lock for longer than the 5 s
// busy timeout, as at boot when both instances open it together.
const holdWriteLock = (path: string, holdMs: number) =>
  new Promise<{ release: Promise<number | null> }>((ready, failed) => {
    const child = spawn(process.execPath, ["--no-warnings", "-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(path)});
      db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS other_instance (x)");
      db.exec("BEGIN IMMEDIATE");
      db.exec("INSERT INTO other_instance VALUES (1)");
      console.log("locked");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${holdMs});
    `], { stdio: ["ignore", "pipe", "inherit"] });
    const release = new Promise<number | null>((done) => child.once("exit", done));
    child.stdout.once("data", () => ready({ release }));
    child.once("error", failed);
  });

describe("SQLite at startup", () => {
  it("waits out another SFU's lock that outlasts the busy timeout", async () => {
    dir = mkdtempSync(join(tmpdir(), "sfu-sqlite-startup-retry-"));
    vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
    vi.stubEnv("SCHEDULED_WEBINARS_SQLITE_PATH", "");
    vi.stubEnv("SCHEDULED_WEBINARS_PERSISTENCE", "");
    vi.stubEnv("CONTROL_PLANE_PERSISTENCE", "sqlite");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { release } = await holdWriteLock(join(dir, "conclave.sqlite"), 6_500);

    const store = await openControlPlane();

    expect(await store.read(allWebinars)).toEqual([]);
    await store.close();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/SQLite is locked by another process/);
    await release;
  }, 30_000);

  it("stops at once on a failure that is not a lock", async () => {
    const step = vi.fn(() => {
      throw new Error("conclave.sqlite is not writable by uid 1000 (attempt to write a readonly database)");
    });
    await expect(retryWhileSqliteLocked(step, { sleep: async () => {} })).rejects.toThrow(/not writable/);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("gives up once the startup budget is spent", async () => {
    const step = vi.fn(() => {
      throw new Error("database is locked");
    });
    await expect(retryWhileSqliteLocked(step, { budgetMs: 1_000, sleep: async () => {} })).rejects.toThrow(/database is locked/);
    expect(step.mock.calls.length).toBeGreaterThan(1);
  });
});
