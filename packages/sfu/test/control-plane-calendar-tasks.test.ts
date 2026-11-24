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

let google = new FakeGoogle(new Gates());
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
  google = new FakeGoogle(new Gates());
  vi.stubEnv("GOOGLE_CLIENT_ID", "tasks-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "tasks-secret");
  vi.stubEnv("SCHEDULING_EMAIL_WORKER_URL", "");
  for (const method of ["log", "info", "warn", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
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
