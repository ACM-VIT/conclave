import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledMeetingPersistence } from "../server/scheduledMeetings.js";
import { createScheduledWebinarPersistence } from "../server/scheduledWebinars.js";
import { createSchedulingPersistence } from "../server/scheduling.js";

// Each store's mode variable, JSON path variable, and a save of an empty snapshot.
const stores = [
  {
    name: "scheduling",
    modeVariable: "SCHEDULING_PERSISTENCE",
    jsonVariable: "SCHEDULING_PATH",
    openAndSave: async () => {
      const persistence = createSchedulingPersistence();
      await persistence.save(await persistence.load());
    },
  },
  {
    name: "scheduled meetings",
    modeVariable: "SCHEDULED_MEETINGS_PERSISTENCE",
    jsonVariable: "SCHEDULED_MEETINGS_PATH",
    openAndSave: async () => {
      await createScheduledMeetingPersistence().save([]);
    },
  },
  {
    name: "scheduled webinars",
    modeVariable: "SCHEDULED_WEBINARS_PERSISTENCE",
    jsonVariable: "SCHEDULED_WEBINARS_PATH",
    openAndSave: async () => {
      createScheduledWebinarPersistence().save([]);
    },
  },
];

let dir = "";
let jsonPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-json-fallback-"));
  jsonPath = join(dir, "store.json");
  // A regular file where SQLite expects a directory, so SQLite cannot open.
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "");
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(blocker, "conclave.sqlite"));
  for (const variable of ["SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH", "REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL"]) {
    vi.stubEnv(variable, "");
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("JSON fallback when SQLite will not open", () => {
  for (const store of stores) {
    describe(store.name, () => {
      beforeEach(() => {
        vi.stubEnv(store.modeVariable, "");
        vi.stubEnv(store.jsonVariable, jsonPath);
      });

      it("refuses to start in production instead of writing a private JSON copy", async () => {
        vi.stubEnv("NODE_ENV", "production");
        await expect(store.openAndSave()).rejects.toThrow(
          new RegExp(`refuses the JSON fallback[\\s\\S]*${store.modeVariable}=json`),
        );
        expect(existsSync(jsonPath)).toBe(false);
      });

      it("still falls back to JSON outside production", async () => {
        vi.stubEnv("NODE_ENV", "development");
        await store.openAndSave();
        expect(existsSync(jsonPath)).toBe(true);
      });

      it("uses JSON in production when the operator chooses it", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv(store.modeVariable, "json");
        await store.openAndSave();
        expect(existsSync(jsonPath)).toBe(true);
      });
    });
  }
});
