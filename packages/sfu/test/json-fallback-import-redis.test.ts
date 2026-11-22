import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledMeeting } from "../types.js";
import { createScheduledMeetingPersistence, importFallbackMeetings, type ScheduledMeetingPersistence } from "../server/scheduledMeetings.js";
import { createSchedulingPersistence, importFallbackScheduling, type SchedulingPersistence } from "../server/scheduling.js";

const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;

const freePort = async (): Promise<number> => {
  for (let port = 6460; port < 6470; port += 1) {
    const free = await new Promise<boolean>((done) => {
      const probe = createServer().once("error", () => done(false)).listen(port, "127.0.0.1", () => probe.close(() => done(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port in 6460-6469");
};

const meeting = (id: string, updatedAt: number, title: string): ScheduledMeeting => ({
  id, clientId: "conclave", roomCode: `${id}-room`, title, hostEmail: "host@example.test", hostName: "", hostUserId: null,
  scheduledStartAt: 200, scheduledEndAt: 3_600_200, status: "scheduled", startedAt: null, endedAt: null,
  createdAt: 1, createdBy: "host@example.test", updatedAt, source: "manual", eventTypeId: null,
} as unknown as ScheduledMeeting);

const profile = { id: "host", clientId: "conclave", userId: "user-host", email: "host@example.test", name: "Host", username: "host", timeZone: "Asia/Kolkata", createdAt: 1, updatedAt: 100 };
const hours = (updatedAt: number, startMinutes: number) => ({
  profileId: "host",
  availability: { timeZone: "Asia/Kolkata", windows: [{ day: 1 as const, startMinutes, endMinutes: 1020 }], overrides: [], updatedAt },
});

let redis: ChildProcess | null = null;
let redisUrl = "";
let stateDir = "";
let open: Array<ScheduledMeetingPersistence | SchedulingPersistence> = [];
let prefix = 0;

const writeFallback = (container: string, file: string, data: unknown) => {
  mkdirSync(join(stateDir, "json-fallback-import", container), { recursive: true });
  writeFileSync(join(stateDir, "json-fallback-import", container, file), JSON.stringify(data));
};
const track = <T extends ScheduledMeetingPersistence | SchedulingPersistence>(persistence: T): T => {
  open.push(persistence);
  return persistence;
};

describe.skipIf(!hasRedis)("importing JSON fallback files into Redis", () => {
  beforeAll(async () => {
    const port = await freePort();
    redisUrl = `redis://127.0.0.1:${port}`;
    redis = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
    const client = createClient({ url: redisUrl, socket: { reconnectStrategy: (retries) => (retries > 50 ? false : 100) } });
    client.on("error", () => {});
    await client.connect();
    await client.quit();
  });

  afterAll(() => {
    redis?.kill();
  });

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "sfu-fallback-import-redis-"));
    prefix += 1;
    vi.stubEnv("RECORDING_STORAGE_PATH", stateDir);
    vi.stubEnv("CONCLAVE_SQLITE_PATH", join(stateDir, "conclave.sqlite"));
    vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(stateDir, "json-fallback-import"));
    vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", redisUrl);
    vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", `fallback-import-test-${process.pid}-${prefix}`);
    for (const variable of ["SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_MEETINGS_PATH", "SCHEDULING_PATH", "REDIS_URL", "SFU_REDIS_URL"]) {
      vi.stubEnv(variable, "");
    }
    vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", "redis");
    vi.stubEnv("SCHEDULING_PERSISTENCE", "redis");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await Promise.all(open.map(async (persistence) => {
      await persistence.close?.();
    }));
    open = [];
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("keeps a meeting the other SFU saved after the import read the store", async () => {
    const importing = track(createScheduledMeetingPersistence());
    const other = track(createScheduledMeetingPersistence());
    await importing.save([meeting("edited", 100, "first title")]);
    await importing.flush?.();
    writeFallback("sfu-a", "scheduled-meetings.json", [meeting("edited", 200, "fallback title"), meeting("only-in-fallback", 1, "fallback meeting")]);
    const importIfNewer = importing.importIfNewer.bind(importing);
    let otherSaved = false;
    vi.spyOn(importing, "importIfNewer").mockImplementationOnce(async (record) => {
      await other.saveChanged?.([meeting("edited", 300, "saved by the other SFU")]);
      await other.flush?.();
      otherSaved = true;
      return importIfNewer(record);
    });

    expect(await importFallbackMeetings(importing)).toBe(1);
    expect(otherSaved).toBe(true);
    const stored = new Map((await track(createScheduledMeetingPersistence()).load()).map((entry) => [entry.id, entry.title]));
    expect(stored).toEqual(new Map([["edited", "saved by the other SFU"], ["only-in-fallback", "fallback meeting"]]));
  });

  it("a snapshot save keeps meetings the other SFU added and deletes nothing", async () => {
    const sfuA = track(createScheduledMeetingPersistence());
    await sfuA.save([meeting("first", 100, "saved by SFU A")]);
    await sfuA.flush?.();
    const sfuB = track(createScheduledMeetingPersistence());
    await sfuB.load();
    await sfuB.saveChanged?.([meeting("added-on-b", 1, "saved by SFU B")]);
    await sfuB.flush?.();
    const titles = async () => new Map((await track(createScheduledMeetingPersistence()).load()).map((entry) => [entry.id, entry.title]));

    await sfuA.save([meeting("first", 50, "older copy on SFU A")]);
    await sfuA.flush?.();
    expect(await titles()).toEqual(new Map([["first", "saved by SFU A"], ["added-on-b", "saved by SFU B"]]));

    await sfuA.save([]);
    await sfuA.flush?.();
    expect(await titles()).toEqual(new Map([["first", "saved by SFU A"], ["added-on-b", "saved by SFU B"]]));

    await sfuA.deleteRecords?.([{ id: "first", deletedAt: 150 }]);
    await sfuA.flush?.();
    expect(await titles()).toEqual(new Map([["added-on-b", "saved by SFU B"]]));
  });

  it("still copies SQLite into an empty Redis when the import runs first", async () => {
    vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", "sqlite");
    const sqlite = track(createScheduledMeetingPersistence());
    await sqlite.save([meeting("from-sqlite", 1, "saved before Redis")]);
    vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", "redis");
    writeFallback("sfu-a", "scheduled-meetings.json", [meeting("only-in-fallback", 1, "fallback meeting")]);
    const persistence = track(createScheduledMeetingPersistence());

    expect(await importFallbackMeetings(persistence)).toBe(1);
    const stored = (await track(createScheduledMeetingPersistence()).load()).map((entry) => entry.id).sort();
    expect(stored).toEqual(["from-sqlite", "only-in-fallback"]);
  });

  it("merges booking hours by their own updated time, newer wins", async () => {
    const persistence = track(createSchedulingPersistence());
    await persistence.save({ profiles: [profile], availability: [hours(100, 540)], eventTypes: [], calendars: [] });
    await persistence.flush?.();
    writeFallback("sfu-a", "scheduling.json", { profiles: [profile], availability: [hours(200, 600)], eventTypes: [], calendars: [] });
    writeFallback("sfu-b", "scheduling.json", { profiles: [], availability: [hours(50, 480)], eventTypes: [], calendars: [] });

    expect(await importFallbackScheduling(persistence)).toBe(1);
    expect((await track(createSchedulingPersistence()).load()).availability).toEqual([hours(200, 600)]);
  });

  it("does not bring back an event type deleted after the old SFU saved it", async () => {
    const eventType = {
      id: "intro-call", clientId: "conclave", profileId: "host", userId: "user-host", slug: "intro", title: "Intro",
      description: "", durationMinutes: 30, minimumNoticeMinutes: 0, bookingWindowDays: 30, bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0, isActive: true, requiresCalendar: false, createdAt: 1, updatedAt: 100,
    };
    const persistence = track(createSchedulingPersistence());
    await persistence.save({ profiles: [profile], availability: [], eventTypes: [eventType], calendars: [] });
    await persistence.save({ profiles: [profile], availability: [], eventTypes: [], calendars: [], deleted: [{ kind: "event_type", id: "intro-call", deletedAt: 150 }] });
    await persistence.flush?.();
    writeFallback("sfu-a", "scheduling.json", { profiles: [], availability: [], eventTypes: [eventType], calendars: [] });

    expect(await importFallbackScheduling(persistence)).toBe(0);
    expect((await track(createSchedulingPersistence()).load()).eventTypes).toEqual([]);
  });
});
