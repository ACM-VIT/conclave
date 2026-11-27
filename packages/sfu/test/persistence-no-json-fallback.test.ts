import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureHostProfile } from "../server/controlPlane/schedulingCommands.js";
import { openControlPlane } from "../server/controlPlane/open.js";

const openAndWrite = async (): Promise<void> => {
  const store = await openControlPlane();
  try {
    const result = await store.commit(
      ensureHostProfile({ clientId: "conclave", userId: "user-1", email: "host@example.test" }, { syncIdentity: true }),
    );
    if (!result.ok) throw new Error(result.message);
  } finally {
    await store.close();
  }
};

const modes = [
  { name: "CONTROL_PLANE_PERSISTENCE", variables: ["CONTROL_PLANE_PERSISTENCE"] },
  {
    name: "the per-store mode variables",
    variables: ["SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE"],
  },
];

let dir = "";
let jsonPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-no-json-fallback-"));
  jsonPath = join(dir, "store.json");
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "");
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(blocker, "conclave.sqlite"));
  for (const variable of ["SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH", "REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL", "CONTROL_PLANE_PERSISTENCE", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE"]) {
    vi.stubEnv(variable, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("a SQLite store that will not open", () => {
  for (const nodeEnv of ["production", "development"]) {
    it(`stops startup in ${nodeEnv} instead of writing JSON anywhere`, async () => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("CONTROL_PLANE_JSON_PATH", jsonPath);
      vi.stubEnv("SCHEDULING_PATH", jsonPath);
      vi.stubEnv("SCHEDULED_MEETINGS_PATH", jsonPath);
      vi.stubEnv("SCHEDULED_WEBINARS_PATH", jsonPath);
      await expect(openAndWrite()).rejects.toThrow();
      expect(existsSync(jsonPath)).toBe(false);
    });
  }

  for (const mode of modes) {
    it(`still uses JSON when the operator selects it with ${mode.name}`, async () => {
      for (const variable of mode.variables) vi.stubEnv(variable, "json");
      vi.stubEnv("CONTROL_PLANE_JSON_PATH", jsonPath);
      await openAndWrite();
      expect(existsSync(jsonPath)).toBe(true);
    });
  }
});
