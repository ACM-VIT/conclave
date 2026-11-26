import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { config } from "../config/config.js";
import { drainCalendarTasks } from "../server/calendarTasks.js";
import { createMemoryBackend, createMemoryData } from "../server/controlPlane/backends/memory.js";
import { CALENDAR_TASK_RETRY_DELAYS_MS } from "../server/controlPlane/calendarTaskCommands.js";
import { controlPlaneStore } from "../server/controlPlane/store.js";
import { createSfuApp } from "../server/http/createApp.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createSfuState, type SfuState } from "../server/state.js";
import { FakeGoogle, Gates, installFakeFetch } from "./support/fakeServices.js";

const HOST = { "x-user-id": "host-user", "x-user-email": "host@example.test", "x-user-name": "Host" };
const DAY_MS = 86_400_000;
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinutes: 0, endMinutes: 24 * 60 }));

let gates = new Gates();
let google = new FakeGoogle(gates);
let restoreFetch: () => void = () => {};
let errors: MockInstance<(...args: unknown[]) => void>;
const servers: Server[] = [];

beforeAll(() => {
  restoreFetch = installFakeFetch(() => google, () => null);
});

afterAll(() => {
  restoreFetch();
});

beforeEach(() => {
  gates = new Gates();
  google = new FakeGoogle(gates);
  vi.stubEnv("GOOGLE_CLIENT_ID", "tasks-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "tasks-secret");
  vi.stubEnv("SCHEDULING_EMAIL_WORKER_URL", "");
  for (const method of ["log", "info", "warn", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  gates.drain();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const sfuWithClock = async () => {
  const clock = { now: Date.now() };
  const state: SfuState = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: "tasks", instanceUrl: "http://localhost", ttlMs: 45000 }),
    controlPlane: controlPlaneStore(createMemoryBackend(createMemoryData()), () => clock.now),
  });
  const server = createServer(createSfuApp({ state, config, getIo: () => null }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { "x-sfu-secret": config.sfuSecret, "x-sfu-client": "conclave", "content-type": "application/json", ...HOST },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const profile = await call("GET", "/scheduling/profile");
  await call("PUT", "/scheduling/availability/default", { timeZone: "UTC", windows: ALL_DAY, overrides: [] });
  await call("PUT", "/scheduling/profile", { timeZone: "UTC" });
  await call("POST", "/scheduling/event-types", { title: "Intro", slug: "intro", isActive: true, minimumNoticeMinutes: 0 });
  await call("POST", "/scheduling/calendar/google", { refreshToken: "refresh", accessToken: "stale", accessTokenExpiresAt: 1 });
  const username = (profile.body.profile as { username: string }).username;
  return { state, clock, call, username };
};

describe("a calendar task Google keeps refusing", () => {
  it("stops after a bounded number of attempts, logs it, marks the booking failed and reports it in /health", async () => {
    const { state, clock, call, username } = await sfuWithClock();
    google.failCreatesWith = 503;
    const startAt = Math.ceil((Date.now() + 2 * DAY_MS) / 1_800_000) * 1_800_000;
    const booked = await call("POST", `/scheduling/public/${username}/intro/book`, { startAt, attendeeName: "Guest", attendeeEmail: "guest@example.test" });
    expect(booked.status).toBe(201);
    expect(booked.body.calendarError).toBeTruthy();
    const id = (booked.body.booking as { id: string }).id;
    expect(((await call("GET", `/scheduled-meetings/${id}`)).body.scheduledMeeting as { calendarSyncStatus: string }).calendarSyncStatus).toBe("pending");

    for (let round = 0; round < CALENDAR_TASK_RETRY_DELAYS_MS.length + 4; round += 1) {
      clock.now += DAY_MS;
      await drainCalendarTasks(state);
    }

    expect(google.createAttempts).toBe(CALENDAR_TASK_RETRY_DELAYS_MS.length + 1);
    expect(google.events.size).toBe(0);
    const saved = (await call("GET", `/scheduled-meetings/${id}`)).body.scheduledMeeting as { calendarSyncStatus: string; calendarSyncError: string };
    expect(saved.calendarSyncStatus).toBe("failed");
    expect(errors.mock.calls.some((args) => /gave up on calendar task .* after 7 attempts/.test(String(args.join(" "))))).toBe(true);
    expect(state.calendarTasks.failed).toBe(1);
    expect((await call("GET", "/health")).body.calendarTasks).toEqual({ failed: 1 });
  });

  it("links the event once Google answers again before the attempts run out", async () => {
    const { state, clock, call, username } = await sfuWithClock();
    google.failCreatesWith = 503;
    const startAt = Math.ceil((Date.now() + 2 * DAY_MS) / 1_800_000) * 1_800_000;
    const booked = await call("POST", `/scheduling/public/${username}/intro/book`, { startAt, attendeeName: "Guest", attendeeEmail: "guest@example.test" });
    const id = (booked.body.booking as { id: string }).id;
    clock.now += DAY_MS;
    await drainCalendarTasks(state);
    google.failCreatesWith = null;
    clock.now += DAY_MS;
    await drainCalendarTasks(state);
    const [event] = google.events.values();
    const saved = (await call("GET", `/scheduled-meetings/${id}`)).body.scheduledMeeting as Record<string, unknown>;
    expect(saved).toMatchObject({ googleCalendarEventId: event.id, calendarSyncStatus: "synced", calendarSyncError: null });
    expect(state.calendarTasks.failed).toBe(0);
  });
});

describe("a booking cancelled and then deleted", () => {
  it("drops its event link when cancelled, so deleting it later writes no second task", async () => {
    const { state, call, username } = await sfuWithClock();
    const startAt = Math.ceil((Date.now() + 2 * DAY_MS) / 1_800_000) * 1_800_000;
    const booked = await call("POST", `/scheduling/public/${username}/intro/book`, { startAt, attendeeName: "Guest", attendeeEmail: "guest@example.test" });
    const id = (booked.body.booking as { id: string }).id;
    expect(google.events.size).toBe(1);

    const cancelled = await call("POST", `/scheduled-meetings/${id}/cancel`);
    expect((cancelled.body.scheduledMeeting as { googleCalendarEventId: string | null }).googleCalendarEventId).toBeNull();
    await drainCalendarTasks(state);
    expect(google.events.size).toBe(0);
    expect(await state.controlPlane.read((view) => view.all("calendarTask"))).toEqual([]);

    expect((await call("DELETE", `/scheduled-meetings/${id}`)).status).toBe(200);
    expect(await state.controlPlane.read((view) => view.all("calendarTask"))).toEqual([]);
  });
});

describe("an ambiguous Google insert", () => {
  const book = (call: Awaited<ReturnType<typeof sfuWithClock>>["call"], username: string) =>
    call("POST", `/scheduling/public/${username}/intro/book`, {
      startAt: Math.ceil((Date.now() + 2 * DAY_MS) / 1_800_000) * 1_800_000,
      attendeeName: "Guest",
      attendeeEmail: "guest@example.test",
    });

  it.each(["cancel", "delete"] as const)("cleans up the event on %s even after all insert replies were lost", async (action) => {
    const { state, clock, call, username } = await sfuWithClock();
    google.loseCreateReplies = true;
    const booked = await book(call, username);
    const id = (booked.body.booking as { id: string }).id;
    for (const _ of CALENDAR_TASK_RETRY_DELAYS_MS) {
      clock.now += DAY_MS;
      await drainCalendarTasks(state);
    }
    expect(state.calendarTasks.failed).toBe(1);
    expect(google.events.size).toBe(1);

    const ended = action === "cancel"
      ? await call("POST", `/scheduled-meetings/${id}/cancel`)
      : await call("DELETE", `/scheduled-meetings/${id}`);
    expect(ended.status).toBe(200);
    await vi.waitFor(() => expect(google.events.size).toBe(0));
    expect(google.created).toHaveLength(1);
  });

  it("rechecks a missing event if an expired insert can still land at Google", async () => {
    const { state, clock, call, username } = await sfuWithClock();
    gates.parking.add("google-create");
    const booking = book(call, username);
    try {
      await vi.waitFor(() => expect(gates.parked.map((entry) => entry.kind)).toEqual(["google-create"]));
      const listed = (await call("GET", "/scheduling/bookings")).body.bookings as Array<{ id: string }>;
      expect((await call("DELETE", `/scheduled-meetings/${listed[0].id}`)).status).toBe(200);
      clock.now += DAY_MS;
      await drainCalendarTasks(state);
      expect(google.deleteAttempts).toBe(1);
      expect(google.events.size).toBe(0);
    } finally {
      gates.drain();
      await booking;
    }
    clock.now += DAY_MS;
    await drainCalendarTasks(state);
    expect(google.created).toHaveLength(1);
    expect(google.events.size).toBe(0);
  });

  it("keeps an expired worker's error off the booking and the newer attempt", async () => {
    const { state, clock, call, username } = await sfuWithClock();
    gates.parking.add("google-create");
    const booking = book(call, username);
    let retry: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(gates.parked.map((entry) => entry.kind)).toEqual(["google-create"]));
      gates.parking.delete("google-create");
      gates.parking.add("google-created");
      clock.now += DAY_MS;
      retry = drainCalendarTasks(state, { retryDelaysMs: [] });
      await vi.waitFor(() => expect(gates.parked.map((entry) => entry.kind)).toEqual(["google-create", "google-created"]));
      google.loseCreateReplies = true;
      gates.releaseAt(0);
      const booked = await booking;
      expect(booked.body.calendarError).toBeUndefined();
      const id = (booked.body.booking as { id: string }).id;
      const before = (await call("GET", `/scheduled-meetings/${id}`)).body.scheduledMeeting;
      expect(before).toMatchObject({ calendarSyncStatus: "pending", calendarSyncError: null });
      google.loseCreateReplies = false;
      gates.drain();
      await retry;
      const after = (await call("GET", `/scheduled-meetings/${id}`)).body.scheduledMeeting;
      expect(after).toMatchObject({ calendarSyncStatus: "synced", calendarSyncError: null });
      expect(google.created).toHaveLength(1);
    } finally {
      gates.drain();
      await Promise.allSettled([booking, retry]);
    }
  });

  it("retains cleanup for a linked event when the original Google grant is replaced", async () => {
    const { state, clock, call, username } = await sfuWithClock();
    const booked = await book(call, username);
    const id = (booked.body.booking as { id: string }).id;
    expect(google.events.size).toBe(1);
    expect((await call("POST", "/scheduling/calendar/google", {
      email: "different@example.test", refreshToken: "different-account", accessToken: "stale", accessTokenExpiresAt: 1,
    })).status).toBe(200);
    expect((await call("POST", `/scheduled-meetings/${id}/cancel`)).status).toBe(200);
    for (let retry = 0; retry <= CALENDAR_TASK_RETRY_DELAYS_MS.length; retry += 1) {
      clock.now += DAY_MS;
      await drainCalendarTasks(state);
    }
    expect(google.deleteAttempts).toBe(0);
    expect(google.events.size).toBe(1);
    expect((await call("GET", "/health")).body.calendarTasks).toEqual({ failed: 1 });
  });
});
