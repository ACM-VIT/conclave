import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginLegacyImport } from "../server/controlPlane/legacyImport.js";
import { meetingById } from "../server/controlPlane/meetingCommands.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import type { ControlPlaneStore } from "../server/controlPlane/store.js";
import { legacyMeeting } from "./support/oldSfu.js";

const race = vi.hoisted(() => ({ armed: false, taken: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    const claimed = typeof path === "string" ? /^(.*)\.claimed-(\d+)-(\d+)$/.exec(path) : null;
    if (race.armed && claimed) {
      race.armed = false;
      const taken = `${claimed[1]}.claimed-${Number(claimed[2]) + 1}-0`;
      actual.renameSync(path as string, taken);
      race.taken.push(taken);
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

let dir = "";
const stores: ControlPlaneStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-claim-race-"));
  vi.stubEnv("CONTROL_PLANE_PERSISTENCE", "sqlite");
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(dir, "import"));
  vi.stubEnv("SCHEDULING_PATH", join(dir, "old", "scheduling.json"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(dir, "old", "scheduled-meetings.json"));
  vi.stubEnv("SCHEDULED_WEBINARS_PATH", join(dir, "old", "scheduled-webinars.json"));
  for (const variable of ["REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH"]) {
    vi.stubEnv(variable, "");
  }
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  race.armed = false;
  race.taken = [];
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const start = async () => {
  const store = await openControlPlane(resolveControlPlaneConfig());
  stores.push(store);
  return store;
};

describe("a container copy a newer import renames between this import's claim and its read", () => {
  it("does not stop startup, and a later start that takes over the claim imports it", async () => {
    const path = join(dir, "import", "sfu-a", "20261124T000000001Z-sfu-deploy-1", "scheduled-meetings.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([legacyMeeting("m", { title: "Copied", updatedAt: 100 })]));
    race.armed = true;

    const first = await start();
    expect(race.taken).toHaveLength(1);
    expect(existsSync(race.taken[0])).toBe(true);
    expect(await first.read(meetingById("m"))).toBeNull();
    expect((await first.commit(beginLegacyImport())).ok).toBe(true);

    stores.splice(stores.indexOf(first), 1);
    await first.close();
    const second = await start();
    expect((await second.read(meetingById("m")))?.title).toBe("Copied");
    expect(readdirSync(dirname(path))).toEqual(["scheduled-meetings.json.adopted"]);
  });
});
