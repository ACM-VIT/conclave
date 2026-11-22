import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Lets the test save from a second SFU while the import is reading its file.
const fsHook = vi.hoisted(() => ({ onRead: null as null | ((path: string) => void) }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const result = fs.readFileSync(...args);
      const hook = fsHook.onRead;
      if (hook && typeof args[0] === "string" && args[0].endsWith(join("sfu-a", "scheduling.json"))) {
        fsHook.onRead = null;
        hook(args[0]);
      }
      return result;
    },
  };
});

const { createSchedulingPersistence, importFallbackScheduling } = await import("../server/scheduling.js");

const profile = (id: string, updatedAt: number, name: string) => ({
  id, clientId: "conclave", userId: `user-${id}`, email: `${id}@example.test`, name, username: id,
  timeZone: "Asia/Kolkata", createdAt: 1, updatedAt,
});
const snapshot = (profiles: ReturnType<typeof profile>[]) => ({ profiles, availability: [], eventTypes: [], calendars: [] });

let stateDir = "";

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "sfu-fallback-import-race-"));
  vi.stubEnv("RECORDING_STORAGE_PATH", stateDir);
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(stateDir, "conclave.sqlite"));
  for (const variable of ["SCHEDULING_SQLITE_PATH", "SCHEDULING_PERSISTENCE", "REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL"]) {
    vi.stubEnv(variable, "");
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  fsHook.onRead = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("importing a JSON fallback file while the other SFU keeps saving", () => {
  it("keeps what the other SFU saved after the import started", async () => {
    const importing = createSchedulingPersistence();
    const other = createSchedulingPersistence();
    await importing.save(snapshot([profile("edited", 100, "first name")]));
    mkdirSync(join(stateDir, "json-fallback-import", "sfu-a"), { recursive: true });
    writeFileSync(
      join(stateDir, "json-fallback-import", "sfu-a", "scheduling.json"),
      JSON.stringify(snapshot([profile("edited", 200, "fallback name"), profile("only-in-fallback", 1, "fallback host")])),
    );
    fsHook.onRead = () => {
      void other.save(snapshot([profile("edited", 300, "saved by the other SFU"), profile("new-on-other", 1, "new host")]));
    };

    expect(await importFallbackScheduling(importing)).toBe(1);
    expect(fsHook.onRead).toBeNull();
    const stored = new Map((await createSchedulingPersistence().load()).profiles.map((entry) => [entry.id, entry.name]));
    expect(stored).toEqual(new Map([
      ["edited", "saved by the other SFU"],
      ["new-on-other", "new host"],
      ["only-in-fallback", "fallback host"],
    ]));
  });
});
