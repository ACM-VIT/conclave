import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openSqliteDatabase } from "../server/controlPlane/backends/sqlite.js";
import {
  deleteMeeting,
  meetingById,
  meetingByRoomCode,
} from "../server/controlPlane/meetingCommands.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import {
  bookingTarget,
  hostCalendar,
  hostDashboard,
  profileForUser,
} from "../server/controlPlane/schedulingCommands.js";
import type { ControlPlaneStore } from "../server/controlPlane/store.js";
import {
  acceptWebinarCoHostInvite,
  webinarBySlug,
} from "../server/controlPlane/webinarCommands.js";
import { hashCoHostInviteToken } from "../server/scheduledWebinars.js";
import { hasRedis, startRedis, type RedisServer } from "./support/redisServer.js";

const SECRET = "legacy-token-secret";

const legacyEncrypt = (token: string): string => {
  const iv = randomBytes(12);
  const key = createHash("sha256").update(SECRET).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
};

const profile = {
  id: "profile-1",
  clientId: "default",
  userId: "host-user",
  email: "host@example.test",
  name: "Host",
  username: "host",
  timeZone: "Asia/Kolkata",
  createdAt: 900,
  updatedAt: 1000,
};
const tombstonedProfile = { ...profile, id: "profile-gone", userId: "gone-user", username: "gone", updatedAt: 500 };
const hours = {
  profileId: "profile-1",
  availability: {
    timeZone: "Asia/Kolkata",
    windows: [{ day: 1, startMinutes: 600, endMinutes: 960 }],
    overrides: [{ date: "2099-01-01", windows: [], unavailable: true }],
  },
};
const eventType = {
  id: "event-1",
  clientId: "conclave",
  profileId: "profile-1",
  userId: "host-user",
  slug: "intro",
  title: "Intro call",
  description: "",
  durationMinutes: 30,
  minimumNoticeMinutes: 0,
  bookingWindowDays: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  isActive: true,
  requiresCalendar: false,
  createdAt: 950,
  updatedAt: 960,
};
const calendar = () => ({
  id: "calendar-1",
  clientId: "conclave",
  profileId: "profile-1",
  userId: "host-user",
  provider: "google",
  status: "connected",
  email: "host@example.test",
  calendarId: "primary",
  accessToken: legacyEncrypt("legacy-access"),
  refreshToken: legacyEncrypt("legacy-refresh"),
  accessTokenExpiresAt: 2_000_000_000_000,
  scopes: ["calendar"],
  connectedAt: 970,
  updatedAt: 980,
  error: null,
});
type LegacyMeeting = Record<string, unknown> & {
  id: string;
  clientId: string;
  roomCode: string;
  status: string;
  scheduledStartAt: number;
  scheduledEndAt: number;
  updatedAt?: number;
};

const meeting = (overrides: { id: string; roomCode: string } & Record<string, unknown>): LegacyMeeting => ({
  clientId: "conclave",
  title: "Standup",
  hostEmail: "host@example.test",
  hostName: "Host",
  hostUserId: "host-user",
  scheduledStartAt: 4_000_000_000_000,
  scheduledEndAt: 4_000_003_600_000,
  status: "scheduled",
  startedAt: null,
  endedAt: null,
  createdBy: "host@example.test",
  source: "manual",
  ...overrides,
});
const meetings = [
  meeting({ id: "meeting-no-stamp", roomCode: "plain-room", createdAt: 1200 }),
  meeting({ id: "meeting-ended", roomCode: "shared-room", status: "ended", createdAt: 1100, updatedAt: 1150 }),
  meeting({ id: "meeting-reused", roomCode: "shared-room", createdAt: 1300, updatedAt: 1300 }),
];
const webinar = {
  id: "webinar-1",
  clientId: "conclave",
  roomId: "sched-abcd1234",
  linkSlug: "launch",
  title: "Launch",
  description: "",
  hostEmail: "host@example.test",
  hostName: "Host",
  hostUserId: "host-user",
  coHosts: [{ email: "cohost@example.test" }],
  scheduledStartAt: 4_000_000_000_000,
  scheduledEndAt: 4_000_003_600_000,
  status: "scheduled",
  publicAccess: true,
  maxAttendees: 500,
  requiresInviteCode: false,
  waitingRoomEnabled: true,
  earlyEntryMinutes: 10,
  qaEnabled: true,
  notes: "",
  createdAt: 1400,
  createdBy: "host@example.test",
  updatedAt: 1450,
  liveStartedAt: null,
  endedAt: null,
  totalJoinCount: 3,
  peakAttendeeCount: 2,
  webinarLink: "https://old.example/w/launch",
  coHostInviteTokenHash: hashCoHostInviteToken("cohost-token"),
  coHostInviteTokenCreatedAt: 1440,
};

const writeLegacySqlite = (path: string, options: { scheduling: boolean; meetings: boolean }) => {
  const db = openSqliteDatabase(path);
  db.exec(`
    CREATE TABLE scheduled_webinars (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, room_id TEXT NOT NULL,
      link_slug TEXT NOT NULL, status TEXT NOT NULL, scheduled_start_at INTEGER NOT NULL,
      scheduled_end_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE scheduled_meetings (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, room_code TEXT NOT NULL,
      status TEXT NOT NULL, scheduled_start_at INTEGER NOT NULL, scheduled_end_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE scheduling_records (kind TEXT NOT NULL, id TEXT NOT NULL, client_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (kind, id));
  `);
  db.prepare(
    "INSERT INTO scheduled_webinars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(webinar.id, webinar.clientId, webinar.roomId, webinar.linkSlug, webinar.status, webinar.scheduledStartAt, webinar.scheduledEndAt, webinar.updatedAt, JSON.stringify(webinar));
  if (options.meetings) {
    for (const entry of meetings) {
      db.prepare("INSERT INTO scheduled_meetings VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        entry.id, entry.clientId, entry.roomCode, entry.status, entry.scheduledStartAt, entry.scheduledEndAt,
        Number(entry.updatedAt ?? 0), JSON.stringify(entry),
      );
    }
  }
  if (options.scheduling) {
    const insert = db.prepare("INSERT INTO scheduling_records VALUES (?, ?, ?, ?, ?)");
    insert.run("profile", profile.id, "conclave", profile.updatedAt, JSON.stringify(profile));
    insert.run("availability", profile.id, "conclave", 5_000_000, JSON.stringify(hours));
    insert.run("event_type", eventType.id, "conclave", eventType.updatedAt, JSON.stringify(eventType));
    insert.run("calendar", profile.id, "conclave", 980, JSON.stringify(calendar()));
  }
  db.close();
};

const writeLegacyJson = (dir: string) => {
  writeFileSync(join(dir, "scheduled-meetings.json"), JSON.stringify(meetings, null, 2));
  writeFileSync(join(dir, "scheduled-webinars.json"), JSON.stringify([webinar], null, 2));
  writeFileSync(
    join(dir, "scheduling.json"),
    JSON.stringify({ profiles: [profile], availability: [hours], eventTypes: [eventType], calendars: [calendar()] }, null, 2),
  );
};

const writeLegacyRedis = async (url: string, prefix: string) => {
  const client = createClient({ url });
  await client.connect();
  await client.hSet(`${prefix}:scheduled-meetings`, Object.fromEntries(meetings.map((entry) => [entry.id, JSON.stringify(entry)])));
  const wrapped = (record: { updatedAt?: number }, payload: unknown) => JSON.stringify({ updatedAt: record.updatedAt, payload });
  await client.hSet(`${prefix}:scheduling:profiles`, {
    [profile.id]: wrapped(profile, profile),
    [tombstonedProfile.id]: wrapped(tombstonedProfile, tombstonedProfile),
  });
  await client.hSet(`${prefix}:scheduling:availability`, { [profile.id]: wrapped(profile, hours) });
  await client.hSet(`${prefix}:scheduling:event-types`, { [eventType.id]: wrapped(eventType, eventType) });
  await client.hSet(`${prefix}:scheduling:calendars`, { [profile.id]: wrapped(calendar(), calendar()) });
  await client.hSet(`${prefix}:scheduling:tombstones`, { [`profile:${tombstonedProfile.id}`]: "600" });
  await client.quit();
};

let redis: RedisServer | null = null;
let dir = "";
const stores: ControlPlaneStore[] = [];

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(6600);
});

afterAll(() => {
  redis?.stop();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-legacy-import-"));
  mkdirSync(join(dir, "json"));
  vi.stubEnv("SCHEDULING_TOKEN_SECRET", SECRET);
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONTROL_PLANE_JSON_PATH", join(dir, "control-plane.json"));
  vi.stubEnv("SCHEDULING_PATH", join(dir, "json", "scheduling.json"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(dir, "json", "scheduled-meetings.json"));
  vi.stubEnv("SCHEDULED_WEBINARS_PATH", join(dir, "json", "scheduled-webinars.json"));
  vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", `legacy:${Date.now()}:${Math.random()}`);
  for (const variable of ["REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH"]) {
    vi.stubEnv(variable, "");
  }
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const start = async (): Promise<ControlPlaneStore> => {
  const store = await openControlPlane(resolveControlPlaneConfig());
  stores.push(store);
  return store;
};

const restart = async (store: ControlPlaneStore): Promise<ControlPlaneStore> => {
  stores.splice(stores.indexOf(store), 1);
  await store.close();
  return start();
};

const expectEverythingLoaded = async (store: ControlPlaneStore) => {
  const host = await store.read(profileForUser("conclave", "host-user"));
  expect(host).toEqual({ ...profile, clientId: "conclave" });
  expect(await store.read(profileForUser("conclave", "gone-user"))).toBeNull();
  const dashboard = await store.read(hostDashboard("profile-1"));
  expect(dashboard?.availability).toEqual({ ...hours.availability, updatedAt: profile.updatedAt });
  expect(dashboard?.eventTypes).toEqual([eventType]);
  expect(dashboard?.calendar.status).toBe("connected");
  const connection = await store.read(hostCalendar("profile-1"));
  expect(connection).toMatchObject({ accessToken: "legacy-access", refreshToken: "legacy-refresh" });
  expect(connection?.grantId).toMatch(/^legacy-grant:/);
  const target = await store.read(bookingTarget("conclave", "host", "intro"));
  expect("error" in target).toBe(false);
  expect(await store.read(meetingById("meeting-no-stamp"))).toMatchObject({ createdAt: 1200, updatedAt: 1200 });
  expect(await store.read(meetingById("meeting-ended"))).toMatchObject({ status: "ended", updatedAt: 1150 });
  expect((await store.read(meetingByRoomCode("conclave", "shared-room")))?.id).toBe("meeting-reused");
  expect(await store.read(webinarBySlug("launch"))).toMatchObject({
    id: "webinar-1",
    totalJoinCount: 3,
    coHosts: [{ email: "cohost@example.test" }],
    updatedAt: 1450,
  });
  const accepted = await store.commit(
    acceptWebinarCoHostInvite(hashCoHostInviteToken("cohost-token"), { email: "late@example.test" }),
  );
  expect(accepted).toMatchObject({ ok: true, value: { id: "webinar-1" } });
};

const expectRestartsChangeNothing = async (first: ControlPlaneStore) => {
  const revs = () =>
    first.read((view) => [...view.all("meeting"), ...view.all("webinar"), ...view.all("profile")].map((stored) => stored.rev));
  const before = await revs();
  const second = await restart(first);
  const after = await second.read((view) =>
    [...view.all("meeting"), ...view.all("webinar"), ...view.all("profile")].map((stored) => stored.rev),
  );
  expect(after).toEqual(before);
  expect((await second.commit(deleteMeeting("meeting-no-stamp", { email: null, isAdmin: true }))).ok).toBe(true);
  const third = await restart(second);
  expect(await third.read(meetingById("meeting-no-stamp"))).toBeNull();
};

describe("loading data saved by the previous release", () => {
  it("keeps every record from the old SQLite tables", async () => {
    vi.stubEnv("CONTROL_PLANE_PERSISTENCE", "sqlite");
    writeLegacySqlite(join(dir, "conclave.sqlite"), { scheduling: true, meetings: true });
    const store = await start();
    await expectEverythingLoaded(store);
    await expectRestartsChangeNothing(store);
  });

  it("keeps every record from the old JSON files", async () => {
    vi.stubEnv("CONTROL_PLANE_PERSISTENCE", "json");
    writeLegacyJson(join(dir, "json"));
    const store = await start();
    await expectEverythingLoaded(store);
    await expectRestartsChangeNothing(store);
  });

  it("falls back to the old JSON files when the old SQLite tables are empty", async () => {
    vi.stubEnv("CONTROL_PLANE_PERSISTENCE", "sqlite");
    writeLegacyJson(join(dir, "json"));
    const store = await start();
    await expectEverythingLoaded(store);
  });

  it.skipIf(!hasRedis)(
    "keeps the old Redis meetings and scheduling and the SQLite webinars, ignoring the stale SQLite mirror",
    async () => {
      vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", redis!.url);
      const prefix = String(process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX);
      await writeLegacyRedis(redis!.url, prefix);
      writeLegacySqlite(join(dir, "conclave.sqlite"), { scheduling: false, meetings: false });
      const mirror = openSqliteDatabase(join(dir, "conclave.sqlite"));
      mirror.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_meetings (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, room_code TEXT NOT NULL,
          status TEXT NOT NULL, scheduled_start_at INTEGER NOT NULL, scheduled_end_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL);
      `);
      const stale = meeting({ id: "mirror-only", roomCode: "mirror-room", createdAt: 1, updatedAt: 1 });
      mirror.prepare("INSERT INTO scheduled_meetings VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        stale.id, stale.clientId, stale.roomCode, stale.status, stale.scheduledStartAt, stale.scheduledEndAt, 1, JSON.stringify(stale),
      );
      mirror.close();
      const store = await start();
      expect(store.mode).toBe("redis");
      await expectEverythingLoaded(store);
      expect(await store.read(meetingById("mirror-only"))).toBeNull();
      await expectRestartsChangeNothing(store);
    },
  );

  it.skipIf(!hasRedis)(
    "starts when the only calendar it cannot decrypt was already deleted in the old Redis store",
    async () => {
      vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", redis!.url);
      const prefix = String(process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX);
      await writeLegacyRedis(redis!.url, prefix);
      const client = createClient({ url: redis!.url });
      await client.connect();
      await client.hSet(`${prefix}:scheduling:tombstones`, { [`calendar:${profile.id}`]: "990" });
      await client.quit();
      vi.stubEnv("SCHEDULING_TOKEN_SECRET", "a-rotated-secret");
      const store = await start();
      expect(await store.read(hostCalendar(profile.id))).toBeNull();
      expect((await store.read((view) => view.all("profile"))).map(({ value }) => value.id)).toContain(profile.id);
    },
  );
});
