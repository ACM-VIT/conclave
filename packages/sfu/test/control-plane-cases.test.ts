import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startCaseSfu, warmCaseModules, type CaseReply, type CaseSfu } from "./support/caseHarness.js";
import { EMAIL_WORKER_URL, FakeEmail, FakeGoogle, Gates, installFakeFetch } from "./support/fakeServices.js";
import { hasRedis, startRedis, type RedisServer } from "./support/redisServer.js";

type Mode = "sqlite" | "json" | "redis";

const HOST = { "x-user-id": "host-user", "x-user-email": "host@example.test", "x-user-name": "Host" };
const CASE_TIMEOUT_MS = 15_000;
vi.setConfig({ testTimeout: CASE_TIMEOUT_MS });
const DAY_MS = 86_400_000;
const HALF_HOUR = 1_800_000;
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinutes: 0, endMinutes: 24 * 60 }));

let redis: RedisServer | null = null;
let restoreFetch: () => void = () => {};
const gates = new Gates();
let google = new FakeGoogle(gates);
let email = new FakeEmail(gates);
let dir = "";
const running: CaseSfu[] = [];

const configure = (next: Mode) => {
  for (const variable of ["SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE"]) {
    vi.stubEnv(variable, next);
  }
  vi.stubEnv("CONTROL_PLANE_PERSISTENCE", "");
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONTROL_PLANE_JSON_PATH", join(dir, "control-plane.json"));
  vi.stubEnv("SCHEDULING_PATH", join(dir, "scheduling.json"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(dir, "scheduled-meetings.json"));
  vi.stubEnv("SCHEDULED_WEBINARS_PATH", join(dir, "scheduled-webinars.json"));
  vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", next === "redis" ? redis!.url : "");
  vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", `cases:${Date.now()}:${Math.random()}`);
};

const start = async (name: string, skewMs = 0): Promise<CaseSfu> => {
  const sfu = await startCaseSfu(name, { skewMs });
  running.push(sfu);
  return sfu;
};

const stop = async (sfu: CaseSfu) => {
  running.splice(running.indexOf(sfu), 1);
  await sfu.stop();
};

const restart = async (sfu: CaseSfu, name: string, skewMs = 0) => {
  await stop(sfu);
  return start(name, skewMs);
};

const observe = async <T,>(read: (observer: CaseSfu) => Promise<T>): Promise<T> => {
  const observer = await start("observer");
  try {
    return await read(observer);
  } finally {
    await stop(observer);
  }
};

const host = (sfu: CaseSfu, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  sfu.call(method, path, body, { ...HOST, ...headers });

const field = <T,>(reply: CaseReply, name: string): T => reply.body[name] as T;

const waitFor = async (condition: () => boolean, label: string) => {
  for (let round = 0; round < 500; round += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const setUpHost = async (sfu: CaseSfu, headers: Record<string, string> = {}) => {
  const profile = await host(sfu, "GET", "/scheduling/profile", undefined, headers);
  await host(sfu, "PUT", "/scheduling/availability/default", { timeZone: "UTC", windows: ALL_DAY, overrides: [] }, headers);
  await host(sfu, "PUT", "/scheduling/profile", { timeZone: "UTC" }, headers);
  const created = await host(sfu, "POST", "/scheduling/event-types", {
    title: "Intro",
    slug: "intro",
    isActive: true,
    minimumNoticeMinutes: 0,
    bookingWindowDays: 60,
    durationMinutes: 30,
  }, headers);
  return {
    username: field<{ username: string }>(profile, "profile").username,
    eventTypeId: field<{ id: string }>(created, "eventType").id,
  };
};

const connectCalendar = (sfu: CaseSfu, refreshToken = "refresh-1") =>
  host(sfu, "POST", "/scheduling/calendar/google", { refreshToken, accessToken: "stale", accessTokenExpiresAt: 1 });

const slotAfter = (offsetMs: number) => Math.ceil((Date.now() + offsetMs) / HALF_HOUR) * HALF_HOUR;

const book = (sfu: CaseSfu, username: string, startAt: number, guest = "guest@example.test") =>
  sfu.call("POST", `/scheduling/public/${username}/intro/book`, { startAt, attendeeName: "Guest", attendeeEmail: guest });

const bookings = async (sfu: CaseSfu) =>
  field<Array<{ id: string; scheduledStartAt: number; status: string }>>(await host(sfu, "GET", "/scheduling/bookings"), "bookings");

const eventTypes = async (sfu: CaseSfu) =>
  field<Array<{ id: string; title: string; slug: string; durationMinutes: number }>>(
    await host(sfu, "GET", "/scheduling/event-types"),
    "eventTypes",
  );

const createMeeting = async (sfu: CaseSfu, body: Record<string, unknown> = {}) =>
  field<{ id: string; roomCode: string; updatedAt: number }>(
    await host(sfu, "POST", "/scheduled-meetings", { title: "Standup", scheduledStartAt: Date.now() + DAY_MS, ...body }),
    "scheduledMeeting",
  );

const createWebinar = async (sfu: CaseSfu, body: Record<string, unknown> = {}) =>
  field<{ id: string; linkSlug: string }>(
    await host(sfu, "POST", "/scheduled-webinars", { title: "Launch", scheduledStartAt: Date.now() + DAY_MS, ...body }),
    "scheduledWebinar",
  );

const legacySqlite = (build: (db: { exec: (sql: string) => void; prepare: (sql: string) => { run: (...values: unknown[]) => unknown } }) => void) => {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => { exec: (sql: string) => void; prepare: (sql: string) => { run: (...values: unknown[]) => unknown }; close: () => void };
  };
  const db = new DatabaseSync(join(dir, "conclave.sqlite"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_meetings (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, room_code TEXT NOT NULL,
      status TEXT NOT NULL, scheduled_start_at INTEGER NOT NULL, scheduled_end_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduled_webinars (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, room_id TEXT NOT NULL,
      link_slug TEXT NOT NULL, status TEXT NOT NULL, scheduled_start_at INTEGER NOT NULL,
      scheduled_end_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_records (kind TEXT NOT NULL, id TEXT NOT NULL, client_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (kind, id));
  `);
  build(db);
  db.close();
};

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(6680);
  restoreFetch = installFakeFetch(() => google, () => email);
  await warmCaseModules();
}, 120_000);

afterAll(() => {
  restoreFetch();
  redis?.stop();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-cp-cases-"));
  google = new FakeGoogle(gates);
  email = new FakeEmail(gates);
  vi.stubEnv("GOOGLE_CLIENT_ID", "case-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "case-secret");
  vi.stubEnv("SCHEDULING_EMAIL_WORKER_URL", EMAIL_WORKER_URL);
  vi.stubEnv("SCHEDULING_EMAIL_WORKER_SECRET", "case-email-secret");
  vi.stubEnv("SCHEDULING_EMAIL_TIMEOUT_MS", "600000");
  vi.stubEnv("SCHEDULING_EMAIL_REMINDER_MINUTES", "1440");
  vi.stubEnv("SFU_FOLLOW_UP_RETRY_DELAYS_MS", "600000");
  vi.stubEnv("SFU_BOOKING_SLOT_LOCK_TTL_MS", "1000");
  for (const variable of ["REDIS_URL", "SFU_REDIS_URL", "SFU_CLIENT_ID", "NEXT_PUBLIC_SFU_CLIENT_ID", "SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH"]) {
    vi.stubEnv(variable, "");
  }
  for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  configure("sqlite");
});

afterEach(async () => {
  gates.drain();
  for (const sfu of running.splice(0)) await sfu.stop().catch(() => undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const customClientSurvivesRestart = async () => {
    const client = { "x-sfu-client": "acme" };
    const a = await start("A");
    const { username } = await setUpHost(a, client);
    const first = field<{ id: string }>(await host(a, "GET", "/scheduling/profile", undefined, client), "profile");
    await stop(a);
    const again = await start("A");
    const second = field<{ id: string; clientId: string }>(await host(again, "GET", "/scheduling/profile", undefined, client), "profile");
    expect(second).toMatchObject({ id: first.id, clientId: "acme" });
    expect((await again.call("GET", `/scheduling/public/${username}/intro`, undefined, client)).status).toBe(200);
  };

const sharedModes: Mode[] = hasRedis ? ["sqlite", "redis"] : ["sqlite"];

describe.each(sharedModes)("two SFUs on one %s store", (current) => {
  beforeEach(() => configure(current));

  it("keep both SFUs' edits to one event type, and each answer is what was saved [1, 12, 22, finding: answered values storage did not keep]", async () => {
    const a = await start("A");
    const { eventTypeId } = await setUpHost(a);
    const b = await start("B", -60_000);
    expect((await host(a, "PATCH", `/scheduling/event-types/${eventTypeId}`, { title: "Renamed on A" })).status).toBe(200);
    const answer = await host(b, "PATCH", `/scheduling/event-types/${eventTypeId}`, { durationMinutes: 45 });
    expect(answer.status).toBe(200);
    const saved = await observe(async (observer) => (await eventTypes(observer)).find((entry) => entry.id === eventTypeId));
    expect(saved).toMatchObject({ title: "Renamed on A", durationMinutes: 45 });
    expect(field<{ durationMinutes: number; title: string }>(answer, "eventType")).toMatchObject({ durationMinutes: 45, title: "Renamed on A" });
  });

  it("do not edit an event type back into existence after the other SFU deleted it [1, 22]", async () => {
    const a = await start("A");
    const { eventTypeId } = await setUpHost(a);
    const b = await start("B");
    expect((await host(a, "DELETE", `/scheduling/event-types/${eventTypeId}`)).status).toBe(200);
    expect((await host(b, "PATCH", `/scheduling/event-types/${eventTypeId}`, { title: "Back" })).status).toBe(404);
    expect(await observe(eventTypes)).toEqual([]);
  });

  it("keep a meeting deleted when the other SFU edits it afterwards [4, 22, finding: a deleted meeting came back]", async () => {
    const a = await start("A");
    const meeting = await createMeeting(a);
    const b = await start("B");
    expect((await host(a, "DELETE", `/scheduled-meetings/${meeting.id}`)).status).toBe(200);
    expect((await host(b, "PATCH", `/scheduled-meetings/${meeting.id}`, { title: "Back" })).status).toBe(404);
    expect((await observe((observer) => host(observer, "GET", `/scheduled-meetings/${meeting.id}`))).status).toBe(404);
  });

  it("keep a meeting deleted by a slow-clock SFU after an edit elsewhere [4, 5]", async () => {
    const a = await start("A");
    const meeting = await createMeeting(a);
    const b = await start("B", -60_000);
    expect((await host(a, "PATCH", `/scheduled-meetings/${meeting.id}`, { title: "Renamed" })).status).toBe(200);
    expect((await host(b, "DELETE", `/scheduled-meetings/${meeting.id}`)).status).toBe(200);
    expect((await observe((observer) => host(observer, "GET", `/scheduled-meetings/${meeting.id}`))).status).toBe(404);
  });

  it("keep a webinar deleted when the other SFU edits it afterwards [2]", async () => {
    const a = await start("A");
    const webinar = await createWebinar(a);
    const b = await start("B");
    expect((await host(a, "DELETE", `/scheduled-webinars/${webinar.id}`)).status).toBe(200);
    expect((await host(b, "PATCH", `/scheduled-webinars/${webinar.id}`, { title: "Back" })).status).toBe(404);
    expect((await observe((observer) => host(observer, "GET", `/scheduled-webinars/${webinar.id}`))).status).toBe(404);
  });

  it("keep a webinar deleted by a slow-clock SFU after an edit elsewhere [2, 5]", async () => {
    const a = await start("A");
    const webinar = await createWebinar(a);
    const b = await start("B", -60_000);
    expect((await host(a, "PATCH", `/scheduled-webinars/${webinar.id}`, { title: "Renamed" })).status).toBe(200);
    expect((await host(b, "DELETE", `/scheduled-webinars/${webinar.id}`)).status).toBe(200);
    expect((await observe((observer) => host(observer, "GET", `/scheduled-webinars/${webinar.id}`))).status).toBe(404);
  });

  it("hand out co-host links that work on either SFU and keep the other SFU's edit [3, 15]", async () => {
    const a = await start("A");
    const webinar = await createWebinar(a);
    const b = await start("B", -60_000);
    expect((await host(a, "PATCH", `/scheduled-webinars/${webinar.id}`, { title: "Renamed on A" })).status).toBe(200);
    const invite = await host(b, "POST", `/scheduled-webinars/${webinar.id}/cohost-invite`);
    expect(invite.status).toBe(200);
    const token = decodeURIComponent(String(invite.body.coHostInviteLink).split("/").pop() ?? "");
    const accepted = await a.call("POST", `/scheduled-webinars/cohost-invites/${encodeURIComponent(token)}/accept`, undefined, {
      "x-user-id": "cohost",
      "x-user-email": "cohost@example.test",
    });
    expect(accepted.status).toBe(200);
    const saved = await observe((observer) => host(observer, "GET", `/scheduled-webinars/${webinar.id}`));
    expect(field<{ title: string; coHosts: Array<{ email: string }> }>(saved, "scheduledWebinar")).toMatchObject({
      title: "Renamed on A",
      coHosts: [{ email: "cohost@example.test" }],
    });
  });

  it("keep an invite code set on a slow-clock SFU [3]", async () => {
    const a = await start("A");
    const webinar = await createWebinar(a);
    const b = await start("B", -60_000);
    expect((await host(a, "PATCH", `/scheduled-webinars/${webinar.id}`, { title: "Renamed on A" })).status).toBe(200);
    const answer = await host(b, "PATCH", `/scheduled-webinars/${webinar.id}`, { inviteCode: "secret-code" });
    expect(field<{ requiresInviteCode: boolean }>(answer, "scheduledWebinar").requiresInviteCode).toBe(true);
    const saved = await observe((observer) => host(observer, "GET", `/scheduled-webinars/${webinar.id}`));
    expect(field<{ title: string; requiresInviteCode: boolean }>(saved, "scheduledWebinar")).toMatchObject({
      title: "Renamed on A",
      requiresInviteCode: true,
    });
  });

  it("do not book a day the host closed on the other SFU while the booking waited on free/busy [6, finding: bookings into closed hours]", async () => {
    const a = await start("A");
    const { username } = await setUpHost(a);
    await connectCalendar(a);
    const b = await start("B");
    const startAt = slotAfter(2 * DAY_MS);
    gates.parking.add("freebusy");
    const pending = book(a, username, startAt);
    await waitFor(() => gates.parked.length === 1, "the booking to reach free/busy");
    const date = new Date(startAt).toISOString().slice(0, 10);
    expect((await host(b, "PUT", "/scheduling/availability/default", {
      timeZone: "UTC",
      windows: ALL_DAY,
      overrides: [{ date, unavailable: true, windows: [] }],
    })).status).toBe(200);
    gates.drain();
    expect((await pending).status).toBe(409);
    expect(await observe(bookings)).toEqual([]);
  });

  it("give two guests booking one slot on two SFUs one booking, however slow free/busy is [7]", async () => {
    const a = await start("A");
    const { username } = await setUpHost(a);
    await connectCalendar(a);
    const b = await start("B");
    const startAt = slotAfter(2 * DAY_MS);
    gates.parking.add("freebusy");
    const replies: CaseReply[] = [];
    const first = book(a, username, startAt, "one@example.test").then((reply) => replies.push(reply));
    await waitFor(() => gates.parked.length === 1, "the first booking to reach free/busy");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const second = book(b, username, startAt, "two@example.test").then((reply) => replies.push(reply));
    await waitFor(() => gates.parked.length === 2 || replies.length === 1, "the second booking to reach free/busy or end");
    gates.drain();
    await Promise.all([first, second]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
    expect((await observe(bookings)).filter((entry) => entry.scheduledStartAt === startAt)).toHaveLength(1);
  });

  it("never let a read on one SFU overwrite an edit made on the other [8]", async () => {
    const a = await start("A");
    const { eventTypeId } = await setUpHost(a);
    const b = await start("B");
    expect((await host(a, "PATCH", `/scheduling/event-types/${eventTypeId}`, { title: "Renamed on A" })).status).toBe(200);
    expect((await host(b, "GET", "/scheduling/profile")).status).toBe(200);
    expect((await observe(eventTypes)).map((entry) => entry.title)).toEqual(["Renamed on A"]);
  });

  it("give a host one profile even when first visits reach both SFUs [9]", async () => {
    const a = await start("A");
    const b = await start("B");
    const first = field<{ id: string }>(await host(a, "GET", "/scheduling/profile"), "profile");
    const second = field<{ id: string }>(await host(b, "GET", "/scheduling/profile"), "profile");
    expect(second.id).toBe(first.id);
    expect(field<{ id: string }>(await observe((observer) => host(observer, "GET", "/scheduling/profile")), "profile").id).toBe(first.id);
  });

  it("never give one room code to two active meetings [10]", async () => {
    const a = await start("A");
    const b = await start("B");
    await createMeeting(a, { roomCode: "team-sync" });
    expect((await host(b, "POST", "/scheduled-meetings", { title: "Other", scheduledStartAt: Date.now() + DAY_MS, roomCode: "team-sync" })).status).toBe(400);
    const owners = await observe((observer) => host(observer, "GET", "/scheduled-meetings"));
    expect(field<unknown[]>(owners, "scheduledMeetings")).toHaveLength(1);
  });

  it("never give one event-type link to two event types of a host [10]", async () => {
    const a = await start("A");
    await host(a, "GET", "/scheduling/profile");
    const b = await start("B");
    await host(a, "POST", "/scheduling/event-types", { title: "Intro", slug: "intro", isActive: true });
    await host(b, "POST", "/scheduling/event-types", { title: "Intro", slug: "intro", isActive: true });
    const slugs = (await observe(eventTypes)).map((entry) => entry.slug).sort();
    expect(slugs).toEqual(["intro", "intro-2"]);
  });

  it("tell the second SFU a webinar link code is taken instead of answering a save that failed [11]", async () => {
    const a = await start("A");
    const b = await start("B");
    const first = await createWebinar(a, { linkSlug: "launch-day" });
    const second = await host(b, "POST", "/scheduled-webinars", { title: "Copy", scheduledStartAt: Date.now() + DAY_MS, linkSlug: "launch-day" });
    expect(second.status).toBe(400);
    const found = await observe((observer) => host(observer, "GET", "/scheduled-webinars/by-slug/launch-day"));
    expect(field<{ id: string }>(found, "scheduledWebinar").id).toBe(first.id);
  });

  it("keep edits to different fields of one meeting from both SFUs [12]", async () => {
    const a = await start("A");
    const meeting = await createMeeting(a);
    const b = await start("B", -60_000);
    const moved = Date.now() + 2 * DAY_MS;
    expect((await host(a, "PATCH", `/scheduled-meetings/${meeting.id}`, { title: "Renamed on A" })).status).toBe(200);
    expect((await host(b, "PATCH", `/scheduled-meetings/${meeting.id}`, { scheduledStartAt: moved, scheduledEndAt: moved + 3_600_000 })).status).toBe(200);
    const saved = await observe((observer) => host(observer, "GET", `/scheduled-meetings/${meeting.id}`));
    expect(field<{ title: string; scheduledStartAt: number }>(saved, "scheduledMeeting")).toMatchObject({ title: "Renamed on A", scheduledStartAt: moved });
  });

  it("refuse a calendar reconnect without a refresh token after the other SFU disconnected it [14]", async () => {
    const a = await start("A");
    await setUpHost(a);
    await connectCalendar(a);
    const b = await start("B");
    expect((await host(a, "DELETE", "/scheduling/calendar/google")).status).toBe(200);
    expect((await host(b, "POST", "/scheduling/calendar/google", { accessToken: "fresh" })).status).toBe(400);
    const calendar = await observe((observer) => host(observer, "GET", "/scheduling/calendar/google"));
    expect(field<{ status: string }>(calendar, "calendar").status).toBe("not_connected");
  });

  it("refuse an edit from a co-host the other SFU removed [15]", async () => {
    const a = await start("A");
    const webinar = await createWebinar(a, { coHosts: [{ email: "cohost@example.test" }] });
    const b = await start("B");
    expect((await host(a, "PATCH", `/scheduled-webinars/${webinar.id}`, { coHosts: [] })).status).toBe(200);
    const edit = await b.call("PATCH", `/scheduled-webinars/${webinar.id}`, { title: "Mine now" }, {
      "x-user-id": "cohost",
      "x-user-email": "cohost@example.test",
    });
    expect(edit.status).toBe(403);
  });

  it("leave no calendar event and say so when a booking is deleted while its event is created [5, 16]", async () => {
    const a = await start("A");
    const { username } = await setUpHost(a);
    await connectCalendar(a);
    gates.parking.add("google-create");
    const pending = book(a, username, slotAfter(2 * DAY_MS));
    await waitFor(() => gates.parked.length === 1, "the booking to reach Google");
    const [booking] = await bookings(a);
    expect((await host(a, "DELETE", `/scheduled-meetings/${booking.id}`)).status).toBe(200);
    gates.drain();
    const reply = await pending;
    expect(reply.status).toBe(409);
    expect([...google.events.values()]).toEqual([]);
    expect(email.sent).toEqual([]);
  });

  it("keep a booking's new time when the host moves it while its calendar event is created [16]", async () => {
    const a = await start("A");
    const { username } = await setUpHost(a);
    await connectCalendar(a);
    const b = await start("B");
    gates.parking.add("google-create");
    const pending = book(a, username, slotAfter(2 * DAY_MS));
    await waitFor(() => gates.parked.length === 1, "the booking to reach Google");
    const [booking] = await bookings(a);
    const moved = booking.scheduledStartAt + 3 * 3_600_000;
    const b2 = await restart(b, "B");
    expect((await host(b2, "PATCH", `/scheduled-meetings/${booking.id}`, { scheduledStartAt: moved, scheduledEndAt: moved + HALF_HOUR })).status).toBe(200);
    gates.drain();
    await pending;
    const saved = await observe((observer) => host(observer, "GET", `/scheduled-meetings/${booking.id}`));
    expect(field<{ scheduledStartAt: number }>(saved, "scheduledMeeting").scheduledStartAt).toBe(moved);
  });

  it("send one reminder when both SFUs scan [17, 18]", async () => {
    const a = await start("A");
    const { username } = await setUpHost(a);
    const startAt = slotAfter(DAY_MS + 2 * HALF_HOUR);
    expect((await book(a, username, startAt)).status).toBe(201);
    const due = startAt - DAY_MS - Date.now() + 60_000;
    const [one, two] = [await start("B", due), await start("C", due)];
    await one.scanReminders();
    await two.scanReminders();
    expect(email.sent.filter((entry) => entry.type === "booking-attendee-reminder")).toHaveLength(1);
  });

  it("keep a cancel made while a reminder was being sent [18]", async () => {
    const a = await start("A");
    const { username } = await setUpHost(a);
    const startAt = slotAfter(DAY_MS + 2 * HALF_HOUR);
    const booked = field<{ id: string }>(await book(a, username, startAt), "booking");
    const due = startAt - DAY_MS - Date.now() + 60_000;
    const b = await start("B", due);
    gates.parking.add("email");
    const scanning = b.scanReminders();
    await waitFor(() => gates.parked.length === 1, "the reminder to reach the email worker");
    expect((await host(a, "POST", `/scheduled-meetings/${booked.id}/cancel`)).status).toBe(200);
    gates.drain();
    await scanning;
    const saved = await observe((observer) => host(observer, "GET", `/scheduled-meetings/${booked.id}`));
    expect(field<{ status: string }>(saved, "scheduledMeeting").status).toBe("cancelled");
  });

  it("do not let a webinar tick on one SFU undo an edit made on the other [19]", async () => {
    const a = await start("A");
    const webinar = await createWebinar(a, { scheduledStartAt: Date.now() - 60_000 });
    const b = await start("B");
    expect((await host(a, "PATCH", `/scheduled-webinars/${webinar.id}`, { title: "Renamed on A" })).status).toBe(200);
    await b.tickWebinars();
    const saved = await observe((observer) => host(observer, "GET", `/scheduled-webinars/${webinar.id}`));
    expect(field<{ title: string; status: string }>(saved, "scheduledWebinar")).toMatchObject({ title: "Renamed on A", status: "live" });
  });

  it("show the same hours on every SFU after edits on either, also after a restart [finding: hours differ from storage after a restart]", async () => {
    const a = await start("A");
    await setUpHost(a);
    const b = await start("B");
    const overrides = [{ date: "2099-01-01", unavailable: true, windows: [] }];
    expect((await host(a, "PUT", "/scheduling/availability/default", { timeZone: "UTC", windows: ALL_DAY, overrides })).status).toBe(200);
    const read = async (sfu: CaseSfu) =>
      field<{ overrides: unknown }>(await host(sfu, "GET", "/scheduling/availability/default"), "availability").overrides;
    expect(await read(b)).toEqual(overrides);
    const a2 = await restart(a, "A");
    expect(await read(a2)).toEqual(overrides);
  });

  it("keep records of a custom client in that client across restarts [23]", customClientSurvivesRestart);

  it("keep no second copy of the data that could diverge from the shared store [26]", async () => {
    const a = await start("A");
    const meeting = await createMeeting(a);
    const b = await start("B");
    expect((await host(a, "DELETE", `/scheduled-meetings/${meeting.id}`)).status).toBe(200);
    await createMeeting(b, { title: "Another" });
    const b2 = await restart(b, "B");
    expect((await host(b2, "GET", `/scheduled-meetings/${meeting.id}`)).status).toBe(404);
    if (current !== "redis") return;
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => { prepare: (sql: string) => { all: () => unknown[] }; close: () => void };
    };
    let rows = 0;
    try {
      const db = new DatabaseSync(join(dir, "conclave.sqlite"));
      for (const table of ["scheduled_meetings", "scheduling_records", "scheduled_webinars", "control_plane_records"]) {
        try {
          rows += db.prepare(`SELECT 1 FROM ${table}`).all().length;
        } catch {
          continue;
        }
      }
      db.close();
    } catch {
      rows = 0;
    }
    expect(rows).toBe(0);
  });

  it("never write on a lookup that falls back to a legacy client namespace [13]", async () => {
    vi.stubEnv("SFU_CLIENT_ID", "acme");
    const a = await start("A");
    const meeting = await createMeeting(a, { roomCode: "legacy-room" });
    const b = await start("B");
    expect((await b.call("GET", "/scheduled-meetings/by-room/legacy-room", undefined, { "x-sfu-client": "acme" })).status).toBe(200);
    const saved = await observe((observer) => host(observer, "GET", `/scheduled-meetings/${meeting.id}`));
    expect(field<{ clientId: string; updatedAt: number }>(saved, "scheduledMeeting")).toMatchObject({
      clientId: "conclave",
      updatedAt: meeting.updatedAt,
    });
  });
});

describe("a host whose profile is stored under a legacy client of the deployment", () => {
  it("is busy during meetings created in the deployment's own client, in the slot list and at booking", async () => {
    const legacy = await start("A");
    const { username } = await setUpHost(legacy);
    await stop(legacy);
    vi.stubEnv("SFU_CLIENT_ID", "acme");
    const sfu = await start("B");
    const acme = { "x-sfu-client": "acme" };
    const profile = field<{ clientId: string; username: string }>(await host(sfu, "GET", "/scheduling/profile", undefined, acme), "profile");
    expect(profile).toMatchObject({ clientId: "conclave", username });
    const startAt = slotAfter(2 * DAY_MS);
    const manual = await host(sfu, "POST", "/scheduled-meetings", { title: "Standup", scheduledStartAt: startAt, scheduledEndAt: startAt + HALF_HOUR }, acme);
    expect(field<{ clientId: string }>(manual, "scheduledMeeting").clientId).toBe("acme");

    const slots = field<Array<{ startAt: number }>>(
      await sfu.call("GET", `/scheduling/public/${username}/intro/slots?from=${startAt - DAY_MS}&to=${startAt + DAY_MS}`, undefined, acme),
      "slots",
    );
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.some((slot) => slot.startAt === startAt)).toBe(false);
    const booked = await sfu.call("POST", `/scheduling/public/${username}/intro/book`, { startAt, attendeeName: "Guest", attendeeEmail: "guest@example.test" }, acme);
    expect(booked.status).toBe(409);
    expect(await bookings(sfu)).toEqual([]);
  });

  it("stays free during another host's meeting in the deployment's client", async () => {
    const legacy = await start("A");
    const { username } = await setUpHost(legacy);
    await stop(legacy);
    vi.stubEnv("SFU_CLIENT_ID", "acme");
    const sfu = await start("B");
    const acme = { "x-sfu-client": "acme" };
    const startAt = slotAfter(2 * DAY_MS);
    const other = { "x-user-id": "other-user", "x-user-email": "other@example.test", "x-user-name": "Other", ...acme };
    expect((await sfu.call("POST", "/scheduled-meetings", { title: "Theirs", scheduledStartAt: startAt, scheduledEndAt: startAt + HALF_HOUR }, other)).status).toBe(201);

    const booked = await sfu.call("POST", `/scheduling/public/${username}/intro/book`, { startAt, attendeeName: "Guest", attendeeEmail: "guest@example.test" }, acme);
    expect(booked.status).toBe(201);
  });
});

describe("one SFU booking an event type with buffers", () => {
  it("refuses a time whose buffer overlaps a Google Calendar event, as the slot list does", async () => {
    const a = await start("A");
    const { username, eventTypeId } = await setUpHost(a);
    expect((await host(a, "PATCH", `/scheduling/event-types/${eventTypeId}`, { bufferBeforeMinutes: 15, bufferAfterMinutes: 15 })).status).toBe(200);
    await connectCalendar(a);
    const startAt = slotAfter(2 * DAY_MS);
    google.busy.push({ startAt: startAt - 40 * 60_000, endAt: startAt - 10 * 60_000 });
    google.busy.push({ startAt: startAt + HALF_HOUR + 5 * 60_000, endAt: startAt + HALF_HOUR + 20 * 60_000 });
    const slots = field<Array<{ startAt: number }>>(
      await a.call("GET", `/scheduling/public/${username}/intro/slots?from=${startAt - DAY_MS}&to=${startAt + DAY_MS}`),
      "slots",
    );
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.some((slot) => slot.startAt === startAt)).toBe(false);
    expect((await book(a, username, startAt)).status).toBe(409);
    expect(await bookings(a)).toEqual([]);
  });
});

describe("one SFU on a JSON store", () => {
  beforeEach(() => configure("json"));

  it("keeps records of a custom client in that client across restarts [23]", customClientSurvivesRestart);
});

describe("data saved before stamps existed", () => {
  const legacyProfile = {
    id: "profile-1", clientId: "conclave", userId: "host-user", email: "host@example.test", name: "Host",
    username: "host", timeZone: "UTC", createdAt: 1_000, updatedAt: 1_000,
  };

  it("keeps one stamp on legacy hours across SFUs and restarts, and a newer edit survives a restart [20, finding: reloads rewrote stored hours]", async () => {
    legacySqlite((db) => {
      db.prepare("INSERT INTO scheduling_records VALUES (?, ?, ?, ?, ?)").run("profile", legacyProfile.id, "conclave", 1_000, JSON.stringify(legacyProfile));
      db.prepare("INSERT INTO scheduling_records VALUES (?, ?, ?, ?, ?)").run(
        "availability", legacyProfile.id, "conclave", 1_000,
        JSON.stringify({ profileId: legacyProfile.id, availability: { timeZone: "UTC", windows: ALL_DAY, overrides: [] } }),
      );
    });
    const a = await start("A");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = await start("B");
    const stamp = async (sfu: CaseSfu) =>
      field<{ updatedAt: number }>(await host(sfu, "GET", "/scheduling/availability/default"), "availability").updatedAt;
    expect(await stamp(a)).toBe(1_000);
    expect(await stamp(b)).toBe(1_000);
    const overrides = [{ date: "2099-02-02", unavailable: true, windows: [] }];
    expect((await host(b, "PUT", "/scheduling/availability/default", { timeZone: "UTC", windows: ALL_DAY, overrides })).status).toBe(200);
    await restart(a, "A");
    const saved = await observe((observer) => host(observer, "GET", "/scheduling/availability/default"));
    expect(field<{ overrides: unknown }>(saved, "availability").overrides).toEqual(overrides);
  });

  it("keeps stable stamps on legacy meetings and webinars across SFUs [21]", async () => {
    const meeting = {
      id: "meeting-1", clientId: "conclave", roomCode: "legacy-room", title: "Standup", hostEmail: "host@example.test",
      scheduledStartAt: 4_000_000_000_000, scheduledEndAt: 4_000_003_600_000, status: "scheduled",
    };
    const webinar = {
      id: "webinar-1", clientId: "conclave", roomId: "sched-abcd1234", linkSlug: "legacy-launch", title: "Launch",
      hostEmail: "host@example.test", scheduledStartAt: 4_000_000_000_000, status: "scheduled", createdAt: 2_000,
    };
    legacySqlite((db) => {
      db.prepare("INSERT INTO scheduled_meetings VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        meeting.id, meeting.clientId, meeting.roomCode, meeting.status, meeting.scheduledStartAt, meeting.scheduledEndAt, 0, JSON.stringify(meeting),
      );
      db.prepare("INSERT INTO scheduled_webinars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        webinar.id, webinar.clientId, webinar.roomId, webinar.linkSlug, webinar.status, webinar.scheduledStartAt, webinar.scheduledStartAt + 3_600_000, 0, JSON.stringify(webinar),
      );
    });
    const a = await start("A");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = await start("B");
    const stamps = async (sfu: CaseSfu) => ({
      meeting: field<{ updatedAt: number }>(await host(sfu, "GET", `/scheduled-meetings/${meeting.id}`), "scheduledMeeting").updatedAt,
      webinar: field<{ updatedAt: number }>(await host(sfu, "GET", `/scheduled-webinars/${webinar.id}`), "scheduledWebinar").updatedAt,
    });
    expect(await stamps(a)).toEqual(await stamps(b));
    expect((await stamps(a)).webinar).toBe(2_000);
  });
});

describe("a store that is not safe to start on", () => {
  it("keeps JSON persistence to one SFU per file, so no SFU's saves drop another's [24]", async () => {
    configure("json");
    const a = await start("A");
    let b: CaseSfu | null = null;
    try {
      b = await start("B");
    } catch {
      b = null;
    }
    if (!b) return;
    await createMeeting(a, { title: "From A" });
    await createMeeting(b, { title: "From B" });
    await stop(a);
    await stop(b);
    const listed = await observe((observer) => host(observer, "GET", "/scheduled-meetings"));
    expect(field<unknown[]>(listed, "scheduledMeetings")).toHaveLength(2);
  });

  it("refuses to start on unreadable SQLite rows instead of starting empty [25]", async () => {
    legacySqlite((db) => {
      db.prepare("INSERT INTO scheduled_meetings VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("broken", "conclave", "room", "scheduled", 1, 2, 0, "{ not json");
    });
    await expect(start("A")).rejects.toThrow();
  });

  it("refuses to start on an unreadable JSON file instead of starting empty [25]", async () => {
    configure("json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "scheduled-meetings.json"), "{ broken");
    await expect(start("A")).rejects.toThrow();
  });
});

