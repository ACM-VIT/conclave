import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { config } from "../config/config.js";
import { drainCalendarTasks, runCalendarTask } from "../server/calendarTasks.js";
import { createMemoryBackend, createMemoryData } from "../server/controlPlane/backends/memory.js";
import { CALENDAR_CHANGED, CALENDAR_TASK_LEASE_MS, CALENDAR_TASK_RETRY_DELAYS_MS } from "../server/controlPlane/calendarTaskCommands.js";
import { fail } from "../server/controlPlane/model.js";
import { controlPlaneStore, type ControlPlaneStore } from "../server/controlPlane/store.js";
import { createSfuApp } from "../server/http/createApp.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createSfuState, type SfuState } from "../server/state.js";
import { EMAIL_WORKER_URL, FakeEmail, FakeGoogle, Gates, installFakeFetch } from "./support/fakeServices.js";

const HOST = { "x-user-id": "host-user", "x-user-email": "host@example.test", "x-user-name": "Host" };
const DAY_MS = 86_400_000;
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinutes: 0, endMinutes: 24 * 60 }));

let gates = new Gates();
let google = new FakeGoogle(gates);
let email: FakeEmail | null = null;
let restoreFetch: () => void = () => {};
let errors: MockInstance<(...args: unknown[]) => void>;
const servers: Server[] = [];

beforeAll(() => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1") throw new Error(`Unexpected outbound request: ${url.origin}`);
    return original(input, init);
  };
  const restoreFakeFetch = installFakeFetch(() => google, () => email);
  restoreFetch = () => {
    restoreFakeFetch();
    globalThis.fetch = original;
  };
});

afterAll(() => {
  restoreFetch();
});

beforeEach(() => {
  gates = new Gates();
  google = new FakeGoogle(gates);
  email = null;
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
  const seams = { afterBookingCommit: null as (() => Promise<void>) | null, commitConflicts: 0 };
  const store = controlPlaneStore(createMemoryBackend(createMemoryData()), () => clock.now);
  const controlPlane: ControlPlaneStore = {
    ...store,
    commit: async (command) => {
      if (seams.commitConflicts > 0) {
        seams.commitConflicts -= 1;
        return fail("conflict", "This changed elsewhere at the same moment. Try again.");
      }
      const result = await store.commit(command);
      const booked = result.ok && typeof result.value === "object" && result.value !== null && "calendarTaskId" in result.value;
      const seam = seams.afterBookingCommit;
      if (booked && seam) {
        seams.afterBookingCommit = null;
        await seam();
      }
      return result;
    },
  };
  const state: SfuState = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: "tasks", instanceUrl: "http://localhost", ttlMs: 45000 }),
    controlPlane,
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
  return { state, clock, call, username, seams };
};

type Sfu = Awaited<ReturnType<typeof sfuWithClock>>;

const bookIntro = (call: Sfu["call"], username: string) =>
  call("POST", `/scheduling/public/${username}/intro/book`, {
    startAt: Math.ceil((Date.now() + 2 * DAY_MS) / 1_800_000) * 1_800_000,
    attendeeName: "Guest",
    attendeeEmail: "guest@example.test",
  });

const savedMeeting = async (call: Sfu["call"], id: string) =>
  (await call("GET", `/scheduled-meetings/${id}`)).body.scheduledMeeting as Record<string, unknown>;

const calendarTasks = (state: SfuState) => state.controlPlane.read((view) => view.all("calendarTask").map((stored) => stored.value));

describe("public booking confirmation", () => {
  beforeEach(() => {
    vi.stubEnv("SCHEDULING_EMAIL_WORKER_URL", EMAIL_WORKER_URL);
    vi.stubEnv("SCHEDULING_EMAIL_WORKER_SECRET", "tasks-email-secret");
    vi.stubEnv("SFU_FOLLOW_UP_RETRY_DELAYS_MS", "0,0");
    email = new FakeEmail(gates);
  });

  const onlyBookingId = async (call: Sfu["call"]) => {
    const { body } = await call("GET", "/scheduling/bookings");
    const bookings = body.bookings as Array<{ id: string }>;
    expect(bookings).toHaveLength(1);
    return bookings[0].id;
  };

  it("confirms a saved booking and retries only the email result after Redis conflicts", async () => {
    const { call, username, seams } = await sfuWithClock();
    gates.parking.add("email");
    const booking = bookIntro(call, username);
    let id = "";
    try {
      await vi.waitFor(() => expect(gates.parked.map((entry) => entry.kind)).toEqual(["email"]));
      id = await onlyBookingId(call);
      seams.commitConflicts = 2;
    } finally {
      gates.drain();
    }

    const booked = await booking;
    expect(booked.status).toBe(201);
    expect(booked.body.booking).toMatchObject({ id, emailNotificationStatus: "sent" });
    await vi.waitFor(async () => {
      expect(await savedMeeting(call, id)).toMatchObject({ status: "scheduled", emailNotificationStatus: "sent" });
    });
    expect(email?.sent).toEqual([
      { type: "booking-attendee-confirmation", meetingId: id, to: "guest@example.test" },
      { type: "booking-host-notification", meetingId: id, to: "host@example.test" },
    ]);
  });

  it.each(["cancel", "delete"] as const)("does not confirm when the host chooses to %s after the initial calendar lease expires", async (action) => {
    const { state, clock, call, username, seams } = await sfuWithClock();
    let id = "";
    seams.afterBookingCommit = async () => {
      id = await onlyBookingId(call);
      clock.now += CALENDAR_TASK_LEASE_MS;
      await drainCalendarTasks(state);
      expect(google.events.size).toBe(1);
      gates.parking.add("google-delete");
      const ended = action === "cancel"
        ? await call("POST", `/scheduled-meetings/${id}/cancel`)
        : await call("DELETE", `/scheduled-meetings/${id}`);
      expect(ended.status).toBe(200);
      expect(await calendarTasks(state)).toMatchObject([{ action: "delete", meetingId: id }]);
    };
    try {
      const booked = await bookIntro(call, username);
      expect(booked.status).toBe(409);
      expect(booked.body).toEqual({ error: "This booking is no longer available." });
      expect(email?.sent).toEqual([]);
      if (action === "cancel") {
        expect(await savedMeeting(call, id)).toMatchObject({ status: "cancelled", emailNotificationStatus: "pending" });
      } else {
        expect((await call("GET", `/scheduled-meetings/${id}`)).status).toBe(404);
      }
    } finally {
      gates.drain();
      await vi.waitFor(() => expect(state.calendarTasks.draining).toBe(false));
    }
    expect(google.events.size).toBe(0);
  });

  it("uses the linked event when another calendar worker completes the booking first", async () => {
    const { state, clock, call, username, seams } = await sfuWithClock();
    seams.afterBookingCommit = async () => {
      clock.now += CALENDAR_TASK_LEASE_MS;
      await drainCalendarTasks(state);
    };
    const booked = await bookIntro(call, username);

    expect(booked.status).toBe(201);
    expect(google.created).toHaveLength(1);
    expect(booked.body.booking).toMatchObject({
      calendarEventId: google.created[0].id,
      syncStatus: "synced",
      emailNotificationStatus: "sent",
    });
    expect(email?.sent.map((sent) => sent.type)).toEqual(["booking-attendee-confirmation", "booking-host-notification"]);
  });

  it.each([0, 1])("rejects a cancellation while email is in flight with %i result write conflicts", async (conflicts) => {
    const { call, username, seams, state } = await sfuWithClock();
    gates.parking.add("email");
    const booking = bookIntro(call, username);
    let id = "";
    try {
      await vi.waitFor(() => expect(gates.parked.map((entry) => entry.kind)).toEqual(["email"]));
      id = await onlyBookingId(call);
      expect((await call("POST", `/scheduled-meetings/${id}/cancel`)).status).toBe(200);
      await vi.waitFor(() => expect(state.calendarTasks.draining).toBe(false));
      seams.commitConflicts = conflicts;
    } finally {
      gates.drain();
    }

    const booked = await booking;
    expect(booked.status).toBe(409);
    expect(booked.body).toEqual({ error: "This booking is no longer available." });
    expect(await savedMeeting(call, id)).toMatchObject({ status: "cancelled", emailNotificationStatus: "pending" });
  });
});

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

describe("a booking moved before its Google event was linked", () => {
  const moveBooking = async (call: Sfu["call"], id: string) => {
    const saved = await savedMeeting(call, id);
    const startAt = Number(saved.scheduledStartAt) + DAY_MS;
    const endAt = Number(saved.scheduledEndAt) + DAY_MS;
    const updated = await call("PATCH", `/scheduled-meetings/${id}`, {
      scheduledStartAt: startAt, scheduledEndAt: endAt,
    });
    expect(updated.status).toBe(200);
    return { startAt, endAt };
  };

  it.each(["503", "lost reply"] as const)("uses the new times after a %s from the previous insert", async (failure) => {
    const { state, clock, call, username } = await sfuWithClock();
    google.failCreatesWith = failure === "503" ? 503 : null;
    google.loseCreateReplies = failure === "lost reply";
    const booked = await bookIntro(call, username);
    expect(booked.status).toBe(201);
    expect(booked.body.calendarError).toBeTruthy();
    const id = (booked.body.booking as { id: string }).id;
    const obsoleteId = [...google.events.keys()][0];

    const times = await moveBooking(call, id);
    google.failCreatesWith = null;
    google.loseCreateReplies = false;
    clock.now += DAY_MS;
    await drainCalendarTasks(state);

    expect([...google.events.values()]).toEqual([expect.objectContaining(times)]);
    const [current] = google.events.values();
    expect(current.id).not.toBe(obsoleteId);
    expect(await savedMeeting(call, id)).toMatchObject({
      googleCalendarEventId: current.id, calendarSyncStatus: "synced", calendarSyncError: null,
    });
    expect(google.createAttempts).toBe(2);
  });

  it("checks the booking again before POST when OAuth was in flight during the move", async () => {
    const { state, call, username, seams } = await sfuWithClock();
    seams.afterBookingCommit = async () => {
      state.googleAccessTokens.clear();
      gates.parking.add("google-token");
    };
    const booking = bookIntro(call, username);
    try {
      await vi.waitFor(() => expect(gates.parked.map((entry) => entry.kind)).toEqual(["google-token"]));
      const [{ id }] = (await call("GET", "/scheduling/bookings")).body.bookings as Array<{ id: string }>;
      const times = await moveBooking(call, id);
      gates.drain();
      expect((await booking).status).toBe(201);
      expect(google.created).toEqual([expect.objectContaining(times)]);
      expect(await savedMeeting(call, id)).toMatchObject({ googleCalendarEventId: google.created[0].id, calendarSyncStatus: "synced" });
    } finally {
      gates.drain();
      await booking;
    }
  });

  it.each([false, true])("removes a moved event before the original lease ends, lost reply %s", async (lostReply) => {
    const { call, username } = await sfuWithClock();
    gates.parking.add("google-created");
    const booking = bookIntro(call, username);
    try {
      await vi.waitFor(() => expect(gates.parked.map((entry) => entry.kind)).toEqual(["google-created"]));
      const [{ id }] = (await call("GET", "/scheduling/bookings")).body.bookings as Array<{ id: string }>;
      const times = await moveBooking(call, id);
      gates.parking.delete("google-created");
      gates.parking.add("google-delete");
      google.loseCreateReplies = lostReply;
      gates.releaseAt(0);
      await vi.waitFor(() => expect(gates.parked.map((entry) => entry.kind)).toEqual(["google-delete"]));
      expect(await savedMeeting(call, id)).toMatchObject({ googleCalendarEventId: null });
      google.loseCreateReplies = false;
      gates.drain();
      expect((await booking).status).toBe(201);
      expect([...google.events.values()]).toEqual([expect.objectContaining(times)]);
      expect(await savedMeeting(call, id)).toMatchObject({ googleCalendarEventId: google.created[1].id, calendarSyncStatus: "synced" });
    } finally {
      gates.drain();
      await booking;
    }
  });

  it.each(["before Google writes", "after Google writes"] as const)(
    "does not let an out-of-lease insert link an obsolete event %s",
    async (when) => {
      const { state, clock, call, username } = await sfuWithClock();
      const kind = when === "before Google writes" ? "google-create" : "google-created";
      gates.parking.add(kind);
      const booking = bookIntro(call, username);
      try {
        await vi.waitFor(() => expect(gates.parked.map((entry) => entry.kind)).toEqual([kind]));
        const [{ id }] = (await call("GET", "/scheduling/bookings")).body.bookings as Array<{ id: string }>;
        const [oldTask] = await calendarTasks(state);
        const times = await moveBooking(call, id);

        gates.parking.delete(kind);
        clock.now += CALENDAR_TASK_LEASE_MS;
        await runCalendarTask(state, oldTask.id);
        await drainCalendarTasks(state);
        expect([...google.events.values()]).toEqual([expect.objectContaining(times)]);
        const [current] = google.events.values();
        expect(current.id).not.toBe(oldTask.eventId);
        expect(await savedMeeting(call, id)).toMatchObject({ googleCalendarEventId: current.id, calendarSyncStatus: "synced" });

        gates.drain();
        expect((await booking).status).toBe(201);
        clock.now += DAY_MS;
        await drainCalendarTasks(state);
        expect([...google.events.keys()]).toEqual([current.id]);
        expect(await savedMeeting(call, id)).toMatchObject({ googleCalendarEventId: current.id, calendarSyncStatus: "synced" });
      } finally {
        gates.drain();
        await booking;
      }
    },
  );
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

describe("a host who changes Google Calendar between a booking's commit and its calendar check", () => {
  const changes = {
    disconnects: (call: Sfu["call"]) => call("DELETE", "/scheduling/calendar/google"),
    reconnects: (call: Sfu["call"]) =>
      call("POST", "/scheduling/calendar/google", { refreshToken: "second-grant", accessToken: "stale", accessTokenExpiresAt: 1 }),
  };

  it.each(["disconnects", "reconnects"] as const)(
    "answers 201 with the saved booking and its calendar error, and emails it, when the host %s",
    async (change) => {
      vi.stubEnv("SCHEDULING_EMAIL_WORKER_URL", EMAIL_WORKER_URL);
      vi.stubEnv("SCHEDULING_EMAIL_WORKER_SECRET", "tasks-email-secret");
      email = new FakeEmail(gates);
      const { state, clock, call, username, seams } = await sfuWithClock();
      seams.afterBookingCommit = async () => {
        expect((await changes[change](call)).status).toBe(200);
      };

      const booked = await bookIntro(call, username);

      expect(booked.status).toBe(201);
      expect(booked.body.calendarError).toBe(CALENDAR_CHANGED);
      const id = (booked.body.booking as { id: string }).id;
      expect(await savedMeeting(call, id)).toMatchObject({
        status: "scheduled",
        calendarSyncStatus: "failed",
        calendarSyncError: CALENDAR_CHANGED,
        googleCalendarEventId: null,
        emailNotificationStatus: "sent",
      });
      expect(email.sent.map((sent) => sent.type).sort()).toEqual(["booking-attendee-confirmation", "booking-host-notification"]);
      expect(google.createAttempts).toBe(0);
      expect(await calendarTasks(state)).toEqual([]);
      for (let round = 0; round <= CALENDAR_TASK_RETRY_DELAYS_MS.length; round += 1) {
        clock.now += DAY_MS;
        await drainCalendarTasks(state);
      }
      expect((await call("GET", "/health")).body.calendarTasks).toEqual({ failed: 0 });
    },
  );

  it("reports the calendar error when the grant changes while Google creates the event", async () => {
    const { state, call, username } = await sfuWithClock();
    gates.parking.add("google-created");
    const booking = bookIntro(call, username);
    try {
      await vi.waitFor(() => expect(gates.parked.map((entry) => entry.kind)).toEqual(["google-created"]));
      expect((await changes.reconnects(call)).status).toBe(200);
    } finally {
      gates.drain();
    }
    const booked = await booking;

    expect(booked.status).toBe(201);
    expect(booked.body.calendarError).toBe(CALENDAR_CHANGED);
    const id = (booked.body.booking as { id: string }).id;
    expect(await savedMeeting(call, id)).toMatchObject({ calendarSyncStatus: "failed", calendarSyncError: CALENDAR_CHANGED, googleCalendarEventId: null });
    expect(state.calendarTasks.failed).toBe(0);
  });
});

describe("a cancelled booking that is opened again", () => {
  const cancelled = async (sfu: Sfu) => {
    const booked = await bookIntro(sfu.call, sfu.username);
    const id = (booked.body.booking as { id: string }).id;
    const [first] = google.events.values();
    expect(await savedMeeting(sfu.call, id)).toMatchObject({ googleCalendarEventId: first.id, calendarSyncStatus: "synced" });
    expect((await sfu.call("POST", `/scheduled-meetings/${id}/cancel`)).status).toBe(200);
    return { id, firstEventId: first.id };
  };

  const reopen = {
    "started": (call: Sfu["call"], id: string) => call("POST", `/scheduled-meetings/${id}/start`),
    "set back to scheduled": (call: Sfu["call"], id: string) => call("PATCH", `/scheduled-meetings/${id}`, { status: "scheduled" }),
  };

  it.each(["started", "set back to scheduled"] as const)("gets a new Google event when it is %s after its event was removed", async (how) => {
    const sfu = await sfuWithClock();
    const { id, firstEventId } = await cancelled(sfu);
    await vi.waitFor(() => expect(google.events.size).toBe(0));

    const reopened = await reopen[how](sfu.call, id);
    expect(reopened.status).toBe(200);
    expect(reopened.body.scheduledMeeting).toMatchObject({ googleCalendarEventId: null, calendarSyncStatus: "pending" });
    await vi.waitFor(async () => expect((await savedMeeting(sfu.call, id)).calendarSyncStatus).toBe("synced"));

    const [event] = google.events.values();
    expect(google.events.size).toBe(1);
    expect(event.id).not.toBe(firstEventId);
    expect(await savedMeeting(sfu.call, id)).toMatchObject({ googleCalendarEventId: event.id, calendarSyncError: null });
  });

  it("ends with one linked event when it is opened again before the old event was removed", async () => {
    const sfu = await sfuWithClock();
    gates.parking.add("google-delete");
    const { id, firstEventId } = await cancelled(sfu);
    try {
      await vi.waitFor(() => expect(gates.parked.map((entry) => entry.kind)).toEqual(["google-delete"]));
      expect((await reopen.started(sfu.call, id)).status).toBe(200);
    } finally {
      gates.drain();
    }
    await vi.waitFor(() => expect(sfu.state.calendarTasks.draining).toBe(false));
    await drainCalendarTasks(sfu.state);

    const [event] = google.events.values();
    expect(google.events.size).toBe(1);
    expect(event.id).not.toBe(firstEventId);
    expect(await savedMeeting(sfu.call, id)).toMatchObject({ googleCalendarEventId: event.id, status: "live" });
    expect((await calendarTasks(sfu.state)).map((task) => `${task.action} ${task.state}`)).toEqual(["create linked"]);
  });

  it("is marked failed, not synced, when Google Calendar is no longer connected", async () => {
    const sfu = await sfuWithClock();
    const { id } = await cancelled(sfu);
    await vi.waitFor(() => expect(google.events.size).toBe(0));
    expect((await sfu.call("DELETE", "/scheduling/calendar/google")).status).toBe(200);

    const reopened = await reopen.started(sfu.call, id);
    expect(reopened.body.scheduledMeeting).toMatchObject({
      googleCalendarEventId: null,
      calendarSyncStatus: "failed",
      calendarSyncError: "Google Calendar is not connected.",
    });
    expect(google.events.size).toBe(0);
    expect(await calendarTasks(sfu.state)).toEqual([]);
  });

  it("keeps the event of a booking that was cancelled and opened again while Google still created it", async () => {
    const sfu = await sfuWithClock();
    gates.parking.add("google-create");
    const booking = bookIntro(sfu.call, sfu.username);
    let id = "";
    try {
      await vi.waitFor(() => expect(gates.parked.map((entry) => entry.kind)).toEqual(["google-create"]));
      id = ((await sfu.call("GET", "/scheduling/bookings")).body.bookings as Array<{ id: string }>)[0].id;
      expect((await sfu.call("POST", `/scheduled-meetings/${id}/cancel`)).status).toBe(200);
      expect((await reopen["set back to scheduled"](sfu.call, id)).status).toBe(200);
    } finally {
      gates.drain();
    }
    expect((await booking).status).toBe(201);
    await drainCalendarTasks(sfu.state);

    const [event] = google.events.values();
    expect(google.created).toHaveLength(1);
    expect(await savedMeeting(sfu.call, id)).toMatchObject({ googleCalendarEventId: event.id, calendarSyncStatus: "synced" });
    expect((await calendarTasks(sfu.state)).map((task) => `${task.action} ${task.state}`)).toEqual(["create linked"]);
  });
});
