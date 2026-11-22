import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import { createSfuApp } from "../server/http/createApp.js";
import type { ScheduledMeeting } from "../types.js";
import { initScheduledMeetings, initScheduledWebinars, initScheduling } from "../server/init.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import {
  createScheduledMeetingPersistence,
  deleteScheduledMeeting,
  persistScheduledMeetingDeletes,
  type ScheduledMeetingPersistence,
} from "../server/scheduledMeetings.js";
import { createSchedulingPersistence, type SchedulingPersistence } from "../server/scheduling.js";
import { createSfuState } from "../server/state.js";
import { reloadPersistedStores } from "../server/storeReload.js";
import { hasRedis, startRedis } from "./support/redisServer.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const later = Date.now() + 3_600_000;
const meeting = (id: string): ScheduledMeeting => ({
  id, clientId: "conclave", roomCode: `${id}-room`, title: id, hostEmail: "host@example.test", hostName: "", hostUserId: null,
  scheduledStartAt: later, scheduledEndAt: later + 3_600_000, status: "scheduled", startedAt: null, endedAt: null,
  createdAt: 1, createdBy: "host@example.test", updatedAt: 1, source: "manual", eventTypeId: null,
} as unknown as ScheduledMeeting);
const profile = (id: string) => ({
  id, clientId: "conclave", userId: `user-${id}`, email: `${id}@example.test`, name: id, username: id, timeZone: "UTC",
  createdAt: 1, updatedAt: 1,
});

// SFU A in its own process. It pauses right after its first EVAL until the test lets it go.
const SFU_A = `
import { existsSync, writeFileSync } from "node:fs";
const { createClient } = await import("redis");
let proto = Object.getPrototypeOf(createClient());
while (!Object.prototype.hasOwnProperty.call(proto, "sendCommand")) proto = Object.getPrototypeOf(proto);
const sendCommand = proto.sendCommand;
let held = false;
proto.sendCommand = async function (args, ...rest) {
  const result = await sendCommand.call(this, args, ...rest);
  if (!held && Array.isArray(args) && args[0] === "EVAL") {
    held = true;
    writeFileSync(process.env.HELD_MARKER, "");
    while (!existsSync(process.env.GO_MARKER)) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return result;
};
const store = process.env.STORE;
const persistence = store === "meetings"
  ? (await import("./server/scheduledMeetings.ts")).createScheduledMeetingPersistence()
  : (await import("./server/scheduling.ts")).createSchedulingPersistence();
const loaded = await persistence.load();
const ids = store === "meetings" ? loaded.map((entry) => entry.id) : loaded.profiles.map((entry) => entry.id);
console.log(JSON.stringify(ids.sort()));
await persistence.close?.();
`;

let redis: { url: string; stop: () => void } | null = null;
let stateDir = "";
let prefix = 0;
let open: Array<ScheduledMeetingPersistence | SchedulingPersistence> = [];
const track = <T extends ScheduledMeetingPersistence | SchedulingPersistence>(persistence: T): T => {
  open.push(persistence);
  return persistence;
};

const startSfuA = (store: "meetings" | "scheduling") => {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", SFU_A], {
    cwd: packageDir,
    env: { ...process.env, STORE: store, HELD_MARKER: join(stateDir, "a-held"), GO_MARKER: join(stateDir, "a-go") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((done) => child.on("exit", done));
  return { exited, stdout: () => stdout, stderr: () => stderr };
};

describe.skipIf(!hasRedis)("SFUs sharing one Redis", () => {
  beforeAll(async () => {
    redis = await startRedis(6470);
  });

  afterAll(() => {
    redis?.stop();
  });

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "sfu-redis-shared-"));
    prefix += 1;
    vi.stubEnv("CONCLAVE_SQLITE_PATH", join(stateDir, "conclave.sqlite"));
    vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(stateDir, "json-fallback-import"));
    vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", redis!.url);
    vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", `redis-shared-test-${process.pid}-${prefix}`);
    for (const variable of ["SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "SCHEDULED_WEBINARS_PERSISTENCE", "REDIS_URL", "SFU_REDIS_URL"]) {
      vi.stubEnv(variable, "");
    }
    vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", "redis");
    vi.stubEnv("SCHEDULING_PERSISTENCE", "redis");
    for (const method of ["log", "info", "warn"] as const) vi.spyOn(console, method).mockImplementation(() => {});
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

  it.each(["meetings", "scheduling"] as const)("both start with every saved %s record when they start together on an empty Redis", async (store) => {
    const saved = ["first", "second", "third"];
    if (store === "meetings") {
      vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", "sqlite");
      await track(createScheduledMeetingPersistence()).saveChanged?.(saved.map(meeting));
      vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", "redis");
    } else {
      vi.stubEnv("SCHEDULING_PERSISTENCE", "sqlite");
      await track(createSchedulingPersistence()).save({ profiles: saved.map(profile), availability: [], eventTypes: [], calendars: [] });
      vi.stubEnv("SCHEDULING_PERSISTENCE", "redis");
    }

    const sfuA = startSfuA(store);
    await vi.waitFor(() => expect(existsSync(join(stateDir, "a-held"))).toBe(true), { timeout: 60_000, interval: 50 });
    const sfuB = store === "meetings" ? track(createScheduledMeetingPersistence()) : track(createSchedulingPersistence());
    const loaded = await sfuB.load();
    const ids = Array.isArray(loaded) ? loaded.map((entry) => entry.id) : loaded.profiles.map((entry) => entry.id);
    writeFileSync(join(stateDir, "a-go"), "");

    expect(ids.sort()).toEqual(saved.sort());
    expect(await sfuA.exited, sfuA.stderr()).toBe(0);
    expect(JSON.parse(sfuA.stdout().trim().split("\n").at(-1) ?? "[]")).toEqual(saved.sort());
  }, 120_000);

  it.each(["meetings", "scheduling"] as const)("treats an established Redis %s store as authoritative on the first start of the new image", async (store) => {
    const keyPrefix = process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX!;
    const raw = createClient({ url: redis!.url });
    await raw.connect();
    if (store === "meetings") {
      vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", "sqlite");
      await track(createScheduledMeetingPersistence()).saveChanged?.([meeting("kept"), meeting("deleted-in-redis")]);
      vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", "redis");
      await raw.hSet(`${keyPrefix}:scheduled-meetings`, "kept", JSON.stringify(meeting("kept")));
    } else {
      vi.stubEnv("SCHEDULING_PERSISTENCE", "sqlite");
      await track(createSchedulingPersistence()).save({ profiles: [profile("kept"), profile("deleted-in-redis")], availability: [], eventTypes: [], calendars: [] });
      vi.stubEnv("SCHEDULING_PERSISTENCE", "redis");
      await raw.hSet(`${keyPrefix}:scheduling:profiles`, "kept", JSON.stringify({ updatedAt: 1, payload: profile("kept") }));
    }
    await raw.quit();

    const upgraded = store === "meetings" ? track(createScheduledMeetingPersistence()) : track(createSchedulingPersistence());
    const loaded = await upgraded.load();
    const ids = Array.isArray(loaded) ? loaded.map((entry) => entry.id) : loaded.profiles.map((entry) => entry.id);
    expect(ids).toEqual(["kept"]);
  });

  it.each(["meetings", "scheduling"] as const)("reseeds when Redis loses its %s data while the SFUs run", async (store) => {
    const saved = ["first", "second"];
    if (store === "meetings") {
      vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", "sqlite");
      await track(createScheduledMeetingPersistence()).saveChanged?.(saved.map(meeting));
      vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", "redis");
    } else {
      vi.stubEnv("SCHEDULING_PERSISTENCE", "sqlite");
      await track(createSchedulingPersistence()).save({ profiles: saved.map(profile), availability: [], eventTypes: [], calendars: [] });
      vi.stubEnv("SCHEDULING_PERSISTENCE", "redis");
    }
    const sfuA = store === "meetings" ? track(createScheduledMeetingPersistence()) : track(createSchedulingPersistence());
    await sfuA.load();

    const raw = createClient({ url: redis!.url });
    await raw.connect();
    await raw.flushDb();
    await raw.quit();
    if (store === "meetings") {
      await (sfuA as ScheduledMeetingPersistence).saveChanged?.([meeting("after-loss")]);
    } else {
      await (sfuA as SchedulingPersistence).save({ profiles: [profile("after-loss")], availability: [], eventTypes: [], calendars: [] });
    }
    await sfuA.flush?.();

    const ids = async (persistence: ScheduledMeetingPersistence | SchedulingPersistence) => {
      const loaded = await persistence.load();
      return (Array.isArray(loaded) ? loaded.map((entry) => entry.id) : loaded.profiles.map((entry) => entry.id)).sort();
    };
    const sfuB = store === "meetings" ? track(createScheduledMeetingPersistence()) : track(createSchedulingPersistence());
    expect(await ids(sfuB)).toEqual(["after-loss", "first", "second"]);
    expect(await ids(sfuA)).toEqual(["after-loss", "first", "second"]);
  });

  it("answers 500 when the SQLite mirror cannot take a reload's write-back", async () => {
    const state = createSfuState({
      roomRegistry: new LocalRoomRegistry({ instanceId: "mirror-lock", instanceUrl: "http://localhost", ttlMs: 45000 }),
    });
    await initScheduledWebinars(state);
    await initScheduledMeetings(state);
    await initScheduling(state);
    track(state.scheduledMeetingPersistence!);
    track(state.schedulingPersistence!);
    const server: Server = createServer(createSfuApp({ state, config, getIo: () => null }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const holder = new DatabaseSync(join(stateDir, "conclave.sqlite"));
    holder.exec("BEGIN IMMEDIATE");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/admin/reload-stores`, {
        method: "POST",
        headers: { "x-sfu-secret": config.sfuSecret },
      });
      expect(response.status).toBe(500);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("keeps a meeting deleted while the reload's Redis read was in flight deleted", async () => {
    const doomed = meeting("doomed");
    const seed = track(createScheduledMeetingPersistence());
    await seed.load();
    await seed.saveChanged?.([doomed]);
    await seed.flush?.();
    const state = createSfuState({
      roomRegistry: new LocalRoomRegistry({ instanceId: "redis-race", instanceUrl: "http://localhost", ttlMs: 45000 }),
    });
    await initScheduledWebinars(state);
    await initScheduledMeetings(state);
    await initScheduling(state);
    const persistence = track(state.scheduledMeetingPersistence!);
    track(state.schedulingPersistence!);
    const target = persistence as unknown as Record<string, (...args: unknown[]) => unknown>;
    const method = ["loadState", "load"].find((name) => typeof target[name] === "function")!;
    const original = target[method].bind(persistence);
    let release!: () => void;
    let markRead!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = new Promise<void>((resolve) => { markRead = resolve; });
    vi.spyOn(target, method).mockImplementationOnce(async (...args: unknown[]) => {
      const result = await original(...args);
      markRead();
      await gate;
      return result;
    });

    const reload = reloadPersistedStores(state);
    await read;
    deleteScheduledMeeting(state.scheduledMeetings, doomed.id);
    await persistScheduledMeetingDeletes(state.scheduledMeetings, persistence, [doomed.id]);
    release();
    await reload;

    expect(state.scheduledMeetings.byId.has(doomed.id)).toBe(false);
    expect((await track(createScheduledMeetingPersistence()).load()).map((entry) => entry.id)).toEqual([]);
  });
});
