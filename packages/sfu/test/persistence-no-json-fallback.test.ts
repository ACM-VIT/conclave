import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledMeetingPersistence } from "../server/scheduledMeetings.js";
import { createScheduledWebinarPersistence } from "../server/scheduledWebinars.js";
import { createSchedulingPersistence } from "../server/scheduling.js";

const stores = [
  { name: "scheduling", modeVariable: "SCHEDULING_PERSISTENCE", jsonVariable: "SCHEDULING_PATH", open: () => createSchedulingPersistence() },
  { name: "scheduled meetings", modeVariable: "SCHEDULED_MEETINGS_PERSISTENCE", jsonVariable: "SCHEDULED_MEETINGS_PATH", open: () => createScheduledMeetingPersistence() },
  { name: "scheduled webinars", modeVariable: "SCHEDULED_WEBINARS_PERSISTENCE", jsonVariable: "SCHEDULED_WEBINARS_PATH", open: () => createScheduledWebinarPersistence() },
];

let dir = "";
let jsonPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-no-json-fallback-"));
  jsonPath = join(dir, "store.json");
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "");
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(blocker, "conclave.sqlite"));
  for (const variable of ["SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH", "REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL"]) {
    vi.stubEnv(variable, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("a SQLite store that will not open", () => {
  for (const store of stores) {
    for (const nodeEnv of ["production", "development"]) {
      it(`stops ${store.name} startup in ${nodeEnv} instead of writing JSON anywhere`, () => {
        vi.stubEnv("NODE_ENV", nodeEnv);
        vi.stubEnv(store.modeVariable, "");
        vi.stubEnv(store.jsonVariable, jsonPath);
        expect(() => store.open()).toThrow();
        expect(existsSync(jsonPath)).toBe(false);
      });
    }

    it(`still uses JSON for ${store.name} when the operator selects it`, async () => {
      vi.stubEnv(store.modeVariable, "json");
      vi.stubEnv(store.jsonVariable, jsonPath);
      const persistence = store.open();
      await persistence.save(await persistence.load());
      expect(existsSync(jsonPath)).toBe(true);
    });
  }
});
