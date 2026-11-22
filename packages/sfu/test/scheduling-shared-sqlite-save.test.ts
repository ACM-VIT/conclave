import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulingPersistence, importFallbackScheduling, type SchedulingPersistence } from "../server/scheduling.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

const profile = (id: string, updatedAt: number, name = id) => ({
  id, clientId: "conclave", userId: `user-${id}`, email: `${id}@example.test`, name, username: id,
  timeZone: "Asia/Kolkata", createdAt: 1, updatedAt,
});
const hours = (startMinutes: number, updatedAt: number) => ({
  profileId: "host",
  availability: { timeZone: "Asia/Kolkata", windows: [{ day: 1 as const, startMinutes, endMinutes: 1020 }], overrides: [], updatedAt },
});
const eventType = (id: string, profileId: string, updatedAt: number) => ({
  id, clientId: "conclave", profileId, userId: `user-${profileId}`, slug: id, title: id, description: "",
  durationMinutes: 30, minimumNoticeMinutes: 0, bookingWindowDays: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
  isActive: true, requiresCalendar: false, createdAt: 1, updatedAt,
});

// SFU A in its own process: loads the shared store, waits, then saves its edited copy.
const SFU_A = `
import { existsSync, writeFileSync } from "node:fs";
const scheduling = await import("./server/scheduling.ts");
const persistence = scheduling.createSchedulingPersistence();
const store = scheduling.createSchedulingStore();
await scheduling.loadPersistedScheduling(store, persistence);
writeFileSync(process.env.LOADED_MARKER, "");
const pause = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(process.env.GO_MARKER)) Atomics.wait(pause, 0, 0, 25);
const host = store.profilesById.get("host");
host.name = "renamed on SFU A";
host.updatedAt = 300;
scheduling.deleteEventType(store, host, "intro");
await scheduling.persistScheduling(store, persistence);
persistence.close?.();
`;

let stateDir = "";
let open: SchedulingPersistence[] = [];

const stateEnv = () => ({
  CONCLAVE_SQLITE_PATH: join(stateDir, "conclave.sqlite"),
  CONCLAVE_FALLBACK_IMPORT_DIR: join(stateDir, "json-fallback-import"),
  SCHEDULING_PERSISTENCE: "sqlite",
  SCHEDULING_SQLITE_PATH: "",
  REDIS_URL: "",
  SFU_REDIS_URL: "",
  SFU_PERSISTENCE_REDIS_URL: "",
  LOADED_MARKER: join(stateDir, "a-loaded"),
  GO_MARKER: join(stateDir, "a-go"),
});

const startSfuA = () => {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", SFU_A], {
    cwd: packageDir,
    env: { ...process.env, ...stateEnv() },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((done) => child.on("exit", done));
  return { child, exited, stderr: () => stderr };
};

const persistence = () => {
  const created = createSchedulingPersistence();
  open.push(created);
  return created;
};

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "sfu-scheduling-shared-save-"));
  for (const [key, value] of Object.entries(stateEnv())) vi.stubEnv(key, value);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const created of open) await created.close?.();
  open = [];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("two SFUs saving scheduling records to one SQLite file", () => {
  it("keeps what one SFU recovered when the other saves the older snapshot it loaded", async () => {
    await persistence().save({ profiles: [profile("host", 100)], availability: [hours(540, 100)], eventTypes: [eventType("intro", "host", 100)], calendars: [] });

    const sfuA = startSfuA();
    await vi.waitFor(() => expect(existsSync(join(stateDir, "a-loaded"))).toBe(true), { timeout: 60_000, interval: 50 });

    mkdirSync(join(stateDir, "json-fallback-import", "sfu-b"), { recursive: true });
    writeFileSync(join(stateDir, "json-fallback-import", "sfu-b", "scheduling.json"), JSON.stringify({
      profiles: [profile("recovered-host", 50)],
      availability: [hours(600, 200)],
      eventTypes: [eventType("recovered-type", "recovered-host", 50)],
      calendars: [],
    }));
    const sfuB = persistence();
    expect(await importFallbackScheduling(sfuB)).toBe(3);
    const sfuBSnapshot = await sfuB.load();

    writeFileSync(join(stateDir, "a-go"), "");
    expect(await sfuA.exited, sfuA.stderr()).toBe(0);

    const afterA = await persistence().load();
    expect(new Map(afterA.profiles.map((entry) => [entry.id, entry.name]))).toEqual(new Map([
      ["host", "renamed on SFU A"],
      ["recovered-host", "recovered-host"],
    ]));
    expect(afterA.availability.map((entry) => entry.availability.windows[0]?.startMinutes)).toEqual([600]);
    expect(afterA.eventTypes.map((entry) => entry.id)).toEqual(["recovered-type"]);

    await sfuB.save(sfuBSnapshot);
    const afterB = await persistence().load();
    expect(afterB.profiles.find((entry) => entry.id === "host")?.name).toBe("renamed on SFU A");
    expect(afterB.eventTypes.map((entry) => entry.id)).toEqual(["recovered-type"]);
    expect(afterB.availability.map((entry) => entry.availability.windows[0]?.startMinutes)).toEqual([600]);
  }, 120_000);
});
