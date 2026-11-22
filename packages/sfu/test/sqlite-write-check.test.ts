import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledMeetingPersistence } from "../server/scheduledMeetings.js";
import { createScheduledWebinarPersistence } from "../server/scheduledWebinars.js";
import { createSchedulingPersistence } from "../server/scheduling.js";

// An image built before the non-root switch leaves the SQLite file owned by
// root. The SFU user can still open it, read-only, so only a real write shows
// the problem. chmod stands in for root ownership; root itself ignores it.
const runsAsRoot = process.getuid?.() === 0;

const stores = [
  { name: "scheduling", open: () => createSchedulingPersistence() },
  { name: "scheduled meetings", open: () => createScheduledMeetingPersistence() },
  { name: "scheduled webinars", open: () => createScheduledWebinarPersistence() },
];

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-sqlite-write-check-"));
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  for (const variable of ["SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL"]) {
    vi.stubEnv(variable, "");
  }
  vi.stubEnv("NODE_ENV", "production");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  chmodSync(dir, 0o755);
  if (existsSync(join(dir, "conclave.sqlite"))) chmodSync(join(dir, "conclave.sqlite"), 0o644);
  rmSync(dir, { recursive: true, force: true });
});

describe("SQLite write check at startup", () => {
  for (const store of stores) {
    it.skipIf(runsAsRoot)(`refuses a ${store.name} database the SFU can open but not write`, async () => {
      await store.open().close?.();
      chmodSync(join(dir, "conclave.sqlite"), 0o444);

      expect(() => store.open()).toThrow(/conclave\.sqlite is not writable[\s\S]*ownership step in packages\/sfu\/README\.md/);
    });

    it.skipIf(runsAsRoot)(`refuses a ${store.name} database whose directory the SFU cannot write`, async () => {
      await store.open().close?.();
      chmodSync(dir, 0o555);

      expect(() => store.open()).toThrow(/is not writable[\s\S]*ownership step/);
    });

    it(`opens a writable ${store.name} database and leaves nothing behind`, async () => {
      await store.open().close?.();
      await store.open().close?.();
      expect(readdirSync(dir).filter((name) => name.startsWith(".write-check"))).toEqual([]);
    });
  }
});
