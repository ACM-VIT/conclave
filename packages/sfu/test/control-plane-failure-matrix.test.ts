import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startCaseSfu, type CaseSfu } from "./support/caseHarness.js";
import { EMAIL_WORKER_URL, FakeEmail, FakeGoogle, Gates, installFakeFetch } from "./support/fakeServices.js";
import { hasRedis, startRedis, type RedisServer } from "./support/redisServer.js";

type Mode = "sqlite" | "json" | "redis";

const HOST = { "x-user-id": "host-user", "x-user-email": "host@example.test", "x-user-name": "Host" };
const DAY_MS = 86_400_000;
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinutes: 0, endMinutes: 24 * 60 }));
const runsAsRoot = process.getuid?.() === 0;

let redis: RedisServer | null = null;
let restoreFetch: () => void = () => {};
const gates = new Gates();
let google = new FakeGoogle(gates);
let dir = "";
let prefix = "";
const running: CaseSfu[] = [];

const host = (sfu: CaseSfu, method: string, path: string, body?: unknown) => sfu.call(method, path, body, HOST);

type Fault = { inject: () => Promise<void>; clear: () => Promise<void> };

const holdSqliteLock = (path: string) => {
  let child: ReturnType<typeof spawn> | null = null;
  return {
    inject: () =>
      new Promise<void>((ready, failed) => {
        child = spawn(process.execPath, ["--no-warnings", "-e", `
          const { DatabaseSync } = require("node:sqlite");
          const db = new DatabaseSync(${JSON.stringify(path)});
          db.exec("PRAGMA busy_timeout = 100");
          db.exec("BEGIN IMMEDIATE");
          console.log("locked");
          process.stdin.on("data", () => { db.exec("ROLLBACK"); db.close(); process.exit(0); });
        `], { stdio: ["pipe", "pipe", "inherit"] });
        child.stdout?.once("data", () => ready());
        child.once("error", failed);
      }),
    clear: () =>
      new Promise<void>((done) => {
        if (!child) return done();
        child.once("exit", () => done());
        child.stdin?.write("go");
      }),
  };
};

const denyRedisEval = (): Fault => {
  const admin = () => {
    const client = createClient({ url: redis!.url });
    client.on("error", () => {});
    return client;
  };
  return {
    inject: async () => {
      const client = admin();
      await client.connect();
      await client.sendCommand(["ACL", "SETUSER", "default", "-eval"]);
      await client.quit();
    },
    clear: async () => {
      const client = admin();
      await client.connect();
      await client.sendCommand(["ACL", "SETUSER", "default", "+eval"]);
      await client.quit();
    },
  };
};

const readOnlyDirectory = (): Fault => ({
  inject: async () => {
    chmodSync(dir, 0o555);
  },
  clear: async () => {
    chmodSync(dir, 0o755);
  },
});

const faultFor = (mode: Mode): Fault =>
  mode === "sqlite" ? holdSqliteLock(join(dir, "conclave.sqlite")) : mode === "redis" ? denyRedisEval() : readOnlyDirectory();

const configure = (mode: Mode) => {
  for (const variable of ["SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE"]) {
    vi.stubEnv(variable, "");
  }
  vi.stubEnv("CONTROL_PLANE_PERSISTENCE", mode);
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONTROL_PLANE_JSON_PATH", join(dir, "control-plane.json"));
  vi.stubEnv("SCHEDULING_PATH", join(dir, "scheduling.json"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(dir, "scheduled-meetings.json"));
  vi.stubEnv("SCHEDULED_WEBINARS_PATH", join(dir, "scheduled-webinars.json"));
  vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", mode === "redis" ? redis!.url : "");
  vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", prefix);
};

const start = async () => {
  const sfu = await startCaseSfu("matrix");
  running.push(sfu);
  return sfu;
};

const restart = async (sfu: CaseSfu) => {
  running.splice(running.indexOf(sfu), 1);
  await sfu.stop();
  return start();
};

type Snapshot = Record<string, unknown>;

const snapshot = async (sfu: CaseSfu): Promise<Snapshot> => ({
  eventTypes: (await host(sfu, "GET", "/scheduling/event-types")).body.eventTypes,
  availability: (await host(sfu, "GET", "/scheduling/availability/default")).body.availability,
  bookings: (await host(sfu, "GET", "/scheduling/bookings")).body.bookings,
  meetings: (await host(sfu, "GET", "/scheduled-meetings")).body.scheduledMeetings,
  webinars: (await host(sfu, "GET", "/scheduled-webinars")).body.scheduledWebinars,
});

type World = { eventTypeId: string; username: string; meetingId: string; webinarId: string };

const seed = async (sfu: CaseSfu): Promise<World> => {
  const profile = await host(sfu, "GET", "/scheduling/profile");
  await host(sfu, "PUT", "/scheduling/availability/default", { timeZone: "UTC", windows: ALL_DAY, overrides: [] });
  await host(sfu, "PUT", "/scheduling/profile", { timeZone: "UTC" });
  const eventType = await host(sfu, "POST", "/scheduling/event-types", {
    title: "Intro",
    slug: "intro",
    isActive: true,
    minimumNoticeMinutes: 0,
  });
  await host(sfu, "POST", "/scheduling/calendar/google", { refreshToken: "refresh", accessToken: "stale", accessTokenExpiresAt: 1 });
  const meeting = await host(sfu, "POST", "/scheduled-meetings", { title: "Standup", scheduledStartAt: Date.now() + DAY_MS });
  const webinar = await host(sfu, "POST", "/scheduled-webinars", { title: "Launch", scheduledStartAt: Date.now() + DAY_MS });
  return {
    eventTypeId: (eventType.body.eventType as { id: string }).id,
    username: (profile.body.profile as { username: string }).username,
    meetingId: (meeting.body.scheduledMeeting as { id: string }).id,
    webinarId: (webinar.body.scheduledWebinar as { id: string }).id,
  };
};

const slot = () => Math.ceil((Date.now() + 2 * DAY_MS) / 1_800_000) * 1_800_000;

const writes: Array<{ domain: string; label: string; run: (sfu: CaseSfu, world: World) => ReturnType<CaseSfu["call"]> }> = [
  { domain: "scheduling", label: "edit an event type", run: (sfu, world) => host(sfu, "PATCH", `/scheduling/event-types/${world.eventTypeId}`, { title: "Renamed" }) },
  { domain: "scheduling", label: "save hours", run: (sfu) => host(sfu, "PUT", "/scheduling/availability/default", { timeZone: "UTC", windows: ALL_DAY, overrides: [{ date: "2099-01-01", unavailable: true, windows: [] }] }) },
  { domain: "scheduling", label: "book a slot", run: (sfu, world) => sfu.call("POST", `/scheduling/public/${world.username}/intro/book`, { startAt: slot(), attendeeName: "Guest", attendeeEmail: "guest@example.test" }) },
  { domain: "meetings", label: "create a meeting", run: (sfu) => host(sfu, "POST", "/scheduled-meetings", { title: "New", scheduledStartAt: Date.now() + DAY_MS }) },
  { domain: "meetings", label: "edit a meeting", run: (sfu, world) => host(sfu, "PATCH", `/scheduled-meetings/${world.meetingId}`, { title: "Renamed" }) },
  { domain: "meetings", label: "delete a meeting", run: (sfu, world) => host(sfu, "DELETE", `/scheduled-meetings/${world.meetingId}`) },
  { domain: "webinars", label: "create a webinar", run: (sfu) => host(sfu, "POST", "/scheduled-webinars", { title: "New", scheduledStartAt: Date.now() + DAY_MS }) },
  { domain: "webinars", label: "edit a webinar", run: (sfu, world) => host(sfu, "PATCH", `/scheduled-webinars/${world.webinarId}`, { title: "Renamed" }) },
  { domain: "webinars", label: "delete a webinar", run: (sfu, world) => host(sfu, "DELETE", `/scheduled-webinars/${world.webinarId}`) },
];

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(6720);
  restoreFetch = installFakeFetch(() => google, () => new FakeEmail(gates));
});

afterAll(() => {
  restoreFetch();
  redis?.stop();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-cp-matrix-"));
  prefix = `matrix:${Date.now()}:${Math.random()}`;
  google = new FakeGoogle(gates);
  vi.stubEnv("GOOGLE_CLIENT_ID", "matrix-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "matrix-secret");
  vi.stubEnv("SCHEDULING_EMAIL_WORKER_URL", EMAIL_WORKER_URL);
  vi.stubEnv("SCHEDULING_EMAIL_WORKER_SECRET", "matrix-email-secret");
  vi.stubEnv("SFU_FOLLOW_UP_RETRY_DELAYS_MS", "600000");
  for (const variable of ["REDIS_URL", "SFU_REDIS_URL", "SFU_CLIENT_ID", "SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH"]) {
    vi.stubEnv(variable, "");
  }
  for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(async () => {
  for (const sfu of running.splice(0)) await sfu.stop().catch(() => undefined);
  chmodSync(dir, 0o755);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const modes: Mode[] = [
  "sqlite",
  ...(runsAsRoot ? [] : (["json"] as const)),
  ...(hasRedis ? (["redis"] as const) : []),
];

describe.each(modes)("a %s store that fails a write", (mode) => {
  it.each(writes)(
    "answers 503 to $domain: $label, changes nothing, and still holds the same data after a restart",
    async (write) => {
      configure(mode);
      const sfu = await start();
      const world = await seed(sfu);
      const before = await snapshot(sfu);
      const eventsBefore = google.created.length;
      const fault = faultFor(mode);
      await fault.inject();
      let reply: Awaited<ReturnType<CaseSfu["call"]>>;
      try {
        reply = await write.run(sfu, world);
      } finally {
        await fault.clear();
      }
      expect(reply.status).toBe(503);
      expect(reply.body.error).toBe("Couldn't save, try again.");
      expect(google.created.length).toBe(eventsBefore);
      expect(await snapshot(sfu)).toEqual(before);
      const again = await restart(sfu);
      expect(await snapshot(again)).toEqual(before);
      const retried = await write.run(again, world);
      expect(retried.status).toBeLessThan(300);
    },
    30_000,
  );
});
