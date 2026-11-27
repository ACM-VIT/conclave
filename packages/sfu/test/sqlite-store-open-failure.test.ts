import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledMeetingPersistence } from "../server/scheduledMeetings.js";
import { createScheduledWebinarPersistence } from "../server/scheduledWebinars.js";
import { createSchedulingPersistence } from "../server/scheduling.js";

const stores = [
  { name: "scheduling", open: () => createSchedulingPersistence() },
  { name: "scheduled meetings", open: () => createScheduledMeetingPersistence() },
  { name: "scheduled webinars", open: () => createScheduledWebinarPersistence() },
];

const openHandles = (path: string): number => {
  const target = realpathSync(path);
  if (existsSync("/proc/self/fd")) {
    return readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`) === target;
      } catch {
        return false;
      }
    }).length;
  }
  const listing = spawnSync("lsof", ["-p", String(process.pid), "-Fn"], { encoding: "utf8" });
  return listing.stdout.split("\n").filter((line) => line === `n${target}`).length;
};

let dir = "";
const sqlitePath = () => join(dir, "conclave.sqlite");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-sqlite-open-failure-"));
  vi.stubEnv("CONCLAVE_SQLITE_PATH", sqlitePath());
  for (const variable of ["SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL"]) {
    vi.stubEnv(variable, "");
  }
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe.each(stores)("the $name store", ({ open }) => {
  it("closes its database handle when opening fails after the write check", () => {
    const reader = new DatabaseSync(sqlitePath());
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM sqlite_master").get();

      expect(open).toThrow(/locked/);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
    expect(openHandles(sqlitePath())).toBe(0);
  }, 30_000);
});
