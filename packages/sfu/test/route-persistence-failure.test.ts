import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import { createSfuApp } from "../server/http/createApp.js";
import { initScheduledMeetings, initScheduledWebinars, initScheduling } from "../server/init.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createScheduledMeetingPersistence } from "../server/scheduledMeetings.js";
import { createSchedulingPersistence } from "../server/scheduling.js";
import { createSfuState, type SfuState } from "../server/state.js";

// Lets a test hold booking emails while they render, so an edit can land mid-render.
const emailRender = vi.hoisted(() => ({ hold: null as null | (() => Promise<void>) }));

// Lets a test take a background retry and run it when it chooses, instead of on a timer.
const retries = vi.hoisted(() => ({ taken: null as null | Array<() => Promise<unknown>> }));

vi.mock("../server/persistThenApply.js", async (importOriginal) => {
  const helpers = await importOriginal<typeof import("../server/persistThenApply.js")>();
  return {
    ...helpers,
    retryInBackground: (what: string, attempt: () => Promise<unknown>) => {
      if (retries.taken) retries.taken.push(attempt);
      else helpers.retryInBackground(what, attempt);
    },
  };
});

vi.mock("../server/email/schedulingTemplates.js", async (importOriginal) => {
  const templates = await importOriginal<typeof import("../server/email/schedulingTemplates.js")>();
  return {
    ...templates,
    renderSchedulingEmail: async (...args: Parameters<typeof templates.renderSchedulingEmail>) => {
      await emailRender.hold?.();
      return templates.renderSchedulingEmail(...args);
    },
  };
});

let stateDir = "";
const servers: Server[] = [];
const host = { "x-user-id": "host-user", "x-user-email": "host@example.test", "x-user-name": "Host" };

const startSfu = async () => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: "route-save-failure", instanceUrl: "http://localhost", ttlMs: 45000 }),
  });
  await initScheduledWebinars(state);
  await initScheduledMeetings(state);
  await initScheduling(state);
  const server = createServer(createSfuApp({ state, config, getIo: () => null }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { "x-sfu-secret": config.sfuSecret, "x-sfu-client": "conclave", "content-type": "application/json", ...host },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: response.status, body: json };
  };
  return { state, call };
};

const failSaves = (persistence: object, methods: string[]) => {
  for (const method of methods) {
    vi.spyOn(persistence as Record<string, () => void>, method).mockImplementation(() => {
      throw new Error("database is locked");
    });
  }
};

const snapshot = (state: SfuState) => ({
  meetings: JSON.stringify([...state.scheduledMeetings.byId.values()]),
  meetingCodes: JSON.stringify([...state.scheduledMeetings.byRoomCode]),
  meetingDeletions: JSON.stringify([...state.scheduledMeetings.deletedAt]),
  webinars: JSON.stringify([...state.scheduledWebinars.byId.values()]),
  webinarSlugs: JSON.stringify([...state.scheduledWebinars.bySlug]),
  webinarDeletions: JSON.stringify([...state.scheduledWebinars.deletedAt]),
});

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "sfu-route-save-failure-"));
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(stateDir, "conclave.sqlite"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(stateDir, "json-fallback-import"));
  for (const variable of ["SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL"]) {
    vi.stubEnv(variable, "");
  }
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(async () => {
  retries.taken = null;
  emailRender.hold = null;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

const deferred = () => {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const later = Date.now() + 3_600_000;
const unavailable = { error: "persistence_unavailable" };

describe("a route whose save fails", () => {
  it("answers 503 for a scheduled meeting and leaves the meeting as it was", async () => {
    const { state, call } = await startSfu();
    const created = await call("POST", "/scheduled-meetings", { title: "Planning", scheduledStartAt: later });
    expect(created.status).toBe(201);
    const id = (created.body.scheduledMeeting as { id: string }).id;
    failSaves(state.scheduledMeetingPersistence!, ["saveChanged", "deleteRecords"]);
    const before = snapshot(state);

    const renamed = await call("PATCH", `/scheduled-meetings/${id}`, { title: "Renamed", roomCode: "fresh-room" });
    const cancelled = await call("POST", `/scheduled-meetings/${id}/cancel`);
    const deleted = await call("DELETE", `/scheduled-meetings/${id}`);
    const added = await call("POST", "/scheduled-meetings", { title: "Another", scheduledStartAt: later });

    for (const response of [renamed, cancelled, deleted, added]) {
      expect([response.status, response.body.error]).toEqual([503, unavailable.error]);
    }
    expect(snapshot(state)).toEqual(before);
  });

  it("keeps exactly one active meeting on a code when its delete fails while a create races for the code", async () => {
    const { state, call } = await startSfu();
    const created = await call("POST", "/scheduled-meetings", { title: "Planning", scheduledStartAt: later, roomCode: "race-room" });
    expect(created.status).toBe(201);
    const id = (created.body.scheduledMeeting as { id: string }).id;
    const deleteStarted = deferred();
    const failDelete = deferred();
    vi.spyOn(state.scheduledMeetingPersistence!, "deleteRecords").mockImplementationOnce(async () => {
      deleteStarted.resolve();
      await failDelete.promise;
      throw new Error("database is locked");
    });

    const deleting = call("DELETE", `/scheduled-meetings/${id}`);
    await deleteStarted.promise;
    const racing = call("POST", "/scheduled-meetings", { title: "Racer", scheduledStartAt: later, roomCode: "race-room" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    failDelete.resolve();
    const [deleted, raced] = await Promise.all([deleting, racing]);

    expect([deleted.status, deleted.body.error]).toEqual([503, unavailable.error]);
    expect(raced.status).toBe(400);
    const active = (meetings: Array<{ roomCode: string; status: string; title: string }>) =>
      meetings.filter((meeting) => meeting.roomCode === "race-room" && ["scheduled", "live"].includes(meeting.status));
    expect(active([...state.scheduledMeetings.byId.values()]).map((meeting) => meeting.title)).toEqual(["Planning"]);
    expect(active(await createScheduledMeetingPersistence().load()).map((meeting) => meeting.title)).toEqual(["Planning"]);
  });

  it("lets only one of two creates racing for a code have it while the first save is still running", async () => {
    const { state, call } = await startSfu();
    const persistence = state.scheduledMeetingPersistence!;
    const saveChanged = persistence.saveChanged!.bind(persistence);
    const saveStarted = deferred();
    const finishSave = deferred();
    vi.spyOn(persistence, "saveChanged").mockImplementationOnce(async (meetings) => {
      saveStarted.resolve();
      await finishSave.promise;
      await saveChanged(meetings);
    });

    const first = call("POST", "/scheduled-meetings", { title: "First", scheduledStartAt: later, roomCode: "one-room" });
    await saveStarted.promise;
    const second = call("POST", "/scheduled-meetings", { title: "Second", scheduledStartAt: later, roomCode: "one-room" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    finishSave.resolve();

    expect([(await first).status, (await second).status]).toEqual([201, 400]);
    const titles = (await createScheduledMeetingPersistence().load()).filter((meeting) => meeting.roomCode === "one-room").map((meeting) => meeting.title);
    expect(titles).toEqual(["First"]);
  });

  it("frees a code for the create queued behind its delete once the delete is saved", async () => {
    const { state, call } = await startSfu();
    const created = await call("POST", "/scheduled-meetings", { title: "Planning", scheduledStartAt: later, roomCode: "free-room" });
    const id = (created.body.scheduledMeeting as { id: string }).id;
    const persistence = state.scheduledMeetingPersistence!;
    const deleteRecords = persistence.deleteRecords!.bind(persistence);
    const deleteStarted = deferred();
    const finishDelete = deferred();
    vi.spyOn(persistence, "deleteRecords").mockImplementationOnce(async (deletions) => {
      deleteStarted.resolve();
      await finishDelete.promise;
      await deleteRecords(deletions);
    });

    const deleting = call("DELETE", `/scheduled-meetings/${id}`);
    await deleteStarted.promise;
    const racing = call("POST", "/scheduled-meetings", { title: "Next", scheduledStartAt: later, roomCode: "free-room" });
    finishDelete.resolve();
    const [deleted, raced] = await Promise.all([deleting, racing]);

    expect([deleted.status, raced.status]).toEqual([200, 201]);
    const titles = (await createScheduledMeetingPersistence().load()).filter((meeting) => meeting.roomCode === "free-room").map((meeting) => meeting.title);
    expect(titles).toEqual(["Next"]);
  });

  it("answers 503 for a scheduled webinar and leaves the webinar as it was", async () => {
    const { state, call } = await startSfu();
    const created = await call("POST", "/scheduled-webinars", { title: "Launch", scheduledStartAt: later, linkSlug: "launch-day" });
    expect(created.status).toBe(201);
    const id = (created.body.scheduledWebinar as { id: string }).id;
    failSaves(state.scheduledWebinarPersistence!, ["saveChanged", "deleteRecords"]);
    const before = snapshot(state);
    const roomState = () => [state.webinarConfigs.size, state.webinarLinks.size];
    const roomStateBefore = roomState();

    const renamed = await call("PATCH", `/scheduled-webinars/${id}`, { title: "Renamed", linkSlug: "launch-renamed" });
    const started = await call("POST", `/scheduled-webinars/${id}/start`);
    const invited = await call("POST", `/scheduled-webinars/${id}/cohost-invite`);
    const deleted = await call("DELETE", `/scheduled-webinars/${id}`);
    const added = await call("POST", "/scheduled-webinars", { title: "Another", scheduledStartAt: later, linkSlug: "another-day" });

    for (const response of [renamed, started, invited, deleted, added]) {
      expect([response.status, response.body.error]).toEqual([503, unavailable.error]);
    }
    expect(snapshot(state)).toEqual(before);
    expect(roomState()).toEqual(roomStateBefore);
  });

  it("rolls a failed scheduling edit back, so a later unrelated save does not persist it", async () => {
    const { state, call } = await startSfu();
    const first = await call("GET", "/scheduling/profile");
    expect(first.status).toBe(200);
    const original = first.body.profile as { id: string; name: string; username: string };
    const persistence = state.schedulingPersistence!;
    const save = persistence.save.bind(persistence);
    vi.spyOn(persistence, "save")
      .mockImplementationOnce(save)
      .mockImplementationOnce(() => {
        throw new Error("database is locked");
      });

    const failed = await call("PUT", "/scheduling/profile", { name: "Failed Name", username: "failed-username" });
    expect([failed.status, failed.body.error]).toEqual([503, unavailable.error]);
    const held = state.scheduling.profilesById.get(original.id)!;
    expect([held.name, held.username]).toEqual([original.name, original.username]);
    expect(state.scheduling.profileIdByUsername.get(`conclave:${original.username}`)).toBe(original.id);
    expect(state.scheduling.profileIdByUsername.has("conclave:failed-username")).toBe(false);

    const unrelated = await call("POST", "/scheduling/event-types", { title: "Intro call" });
    expect(unrelated.status).toBe(201);
    const stored = (await createSchedulingPersistence().load()).profiles.find((entry) => entry.id === original.id)!;
    expect([stored.name, stored.username]).toEqual([original.name, original.username]);
  });

  it("answers 503 with the same code for a scheduling route", async () => {
    const { state, call } = await startSfu();
    expect((await call("GET", "/scheduling/profile")).status).toBe(200);
    failSaves(state.schedulingPersistence!, ["save"]);

    const response = await call("PUT", "/scheduling/profile", { name: "Renamed Host" });
    expect([response.status, response.body.error]).toEqual([503, unavailable.error]);
  });
});

const EMAIL_WORKER = "https://email-worker.example.test";

const GOOGLE_EVENTS = "https://www.googleapis.com/calendar/v3/calendars/";

/**
 * Answers Google and the email worker in-process; every other request goes
 * out as usual. `beforeInsert` runs while Google is creating the event.
 */
const fakeOutsideServices = (options: { beforeInsert?: () => Promise<void>; beforeMove?: () => Promise<void> } = {}) => {
  const passThrough = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://www.googleapis.com/calendar/v3/freeBusy")) {
      return Response.json({ calendars: { primary: { busy: [] } } });
    }
    if (url.startsWith(GOOGLE_EVENTS)) {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (init?.method === "POST") await options.beforeInsert?.();
      if (init?.method === "PATCH") await options.beforeMove?.();
      return Response.json({ id: "google-event-1" });
    }
    if (url.startsWith(EMAIL_WORKER)) return Response.json({ ok: true });
    return passThrough(input, init);
  });
};

type OutsideServices = ReturnType<typeof fakeOutsideServices>;

const requestsTo = (outside: OutsideServices, prefix: string, method?: string) =>
  outside.mock.calls.filter(
    ([input, init]) =>
      (input instanceof Request ? input.url : String(input)).startsWith(prefix) && (!method || init?.method === method),
  );

const bodyOf = (call: Parameters<typeof fetch>) => JSON.parse(String(call[1]?.body)) as { start: { dateTime: string } };

const bookableHost = async (call: Awaited<ReturnType<typeof startSfu>>["call"]) => {
  const { username } = (await call("GET", "/scheduling/profile")).body.profile as { username: string };
  const { slug } = (await call("POST", "/scheduling/event-types", { title: "Intro call", isActive: true })).body.eventType as { slug: string };
  const connected = await call("POST", "/scheduling/calendar/google", {
    refreshToken: "refresh-token",
    accessToken: "access-token",
    accessTokenExpiresAt: Date.now() + 3_600_000,
  });
  expect(connected.status).toBe(200);
  const slots = (await call("GET", `/scheduling/public/${username}/${slug}/slots`)).body.slots as Array<{ startAt: number }>;
  expect(slots.length).toBeGreaterThan(0);
  const book = () =>
    call("POST", `/scheduling/public/${username}/${slug}/book`, {
      startAt: slots[0].startAt,
      attendeeName: "Guest",
      attendeeEmail: "guest@example.test",
    });
  return { book, startAt: slots[0].startAt };
};

/** Starts a booking and holds Google's reply to the event insert until `answer` runs. */
const bookWithGoogleHeld = async (
  state: SfuState,
  call: Awaited<ReturnType<typeof startSfu>>["call"],
  beforeMove?: () => Promise<void>,
) => {
  const insertStarted = deferred();
  const insertAnswered = deferred();
  const outside = fakeOutsideServices({
    beforeInsert: async () => {
      insertStarted.resolve();
      await insertAnswered.promise;
    },
    beforeMove,
  });
  const { book, startAt } = await bookableHost(call);
  const booking = book();
  await insertStarted.promise;
  const saved = [...state.scheduledMeetings.byId.values()].find((meeting) => meeting.source === "booking_link")!;
  return { outside, booking, saved, startAt, answer: () => insertAnswered.resolve() };
};

type Confirmation = { id: string; calendarEventId: string | null; syncStatus: string; emailNotificationStatus: string; startsAt: number };

describe("a booking", () => {
  beforeEach(() => {
    vi.stubEnv("SCHEDULING_EMAIL_WORKER_URL", EMAIL_WORKER);
    vi.stubEnv("SCHEDULING_EMAIL_WORKER_SECRET", "email-secret");
    vi.stubEnv("SFU_FOLLOW_UP_RETRY_DELAYS_MS", "20,40,80");
  });

  it("whose event id save fails succeeds and sends the confirmation, reads pending until the id is saved, then records it", async () => {
    const { state, call } = await startSfu();
    const outside = fakeOutsideServices();
    const { book } = await bookableHost(call);
    const persistence = state.scheduledMeetingPersistence!;
    const saveChanged = persistence.saveChanged!.bind(persistence);
    const allowRetry = deferred();
    let syncedSaves = 0;
    vi.spyOn(persistence, "saveChanged").mockImplementation(async (meetings) => {
      if (meetings.some((meeting) => meeting.calendarSyncStatus === "synced")) {
        syncedSaves += 1;
        if (syncedSaves === 1) throw new Error("database is locked");
        await allowRetry.promise;
      }
      await saveChanged(meetings);
    });

    const booked = await book();

    expect(booked.status).toBe(201);
    const booking = booked.body.booking as Confirmation;
    expect([booking.calendarEventId, booking.syncStatus, booking.emailNotificationStatus]).toEqual([null, "pending", "sent"]);
    expect(state.scheduledMeetings.byId.get(booking.id)?.calendarSyncStatus).toBe("pending");
    expect(requestsTo(outside, GOOGLE_EVENTS)).toHaveLength(1);
    expect(requestsTo(outside, EMAIL_WORKER)).toHaveLength(1);
    allowRetry.resolve();
    await vi.waitFor(async () => {
      const stored = (await createScheduledMeetingPersistence().load()).find((meeting) => meeting.id === booking.id);
      expect([stored?.googleCalendarEventId, stored?.calendarSyncStatus, stored?.emailNotificationStatus]).toEqual(["google-event-1", "synced", "sent"]);
    }, { timeout: 5_000, interval: 20 });
    const held = state.scheduledMeetings.byId.get(booking.id);
    expect([held?.googleCalendarEventId, held?.calendarSyncStatus]).toEqual(["google-event-1", "synced"]);
    expect(requestsTo(outside, GOOGLE_EVENTS)).toHaveLength(1);
  });

  it("whose own save fails answers 503 and creates no Google event", async () => {
    const { state, call } = await startSfu();
    const outside = fakeOutsideServices();
    const { book } = await bookableHost(call);
    vi.spyOn(state.scheduledMeetingPersistence!, "saveChanged").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });

    const failed = await book();

    expect([failed.status, failed.body.error]).toEqual([503, unavailable.error]);
    expect(requestsTo(outside, GOOGLE_EVENTS)).toHaveLength(0);
    expect(requestsTo(outside, EMAIL_WORKER)).toHaveLength(0);
    expect([...state.scheduledMeetings.byId.values()].filter((meeting) => meeting.source === "booking_link")).toEqual([]);
    expect((await createScheduledMeetingPersistence().load()).filter((meeting) => meeting.source === "booking_link")).toEqual([]);

    const retried = await book();
    expect(retried.status).toBe(201);
    expect(requestsTo(outside, GOOGLE_EVENTS)).toHaveLength(1);
  });

  it("rescheduled while Google is replying keeps the event id and moves the event to the new times", async () => {
    const { state, call } = await startSfu();
    const { outside, booking, saved, startAt, answer } = await bookWithGoogleHeld(state, call);
    const movedStart = startAt + 2 * 3_600_000;
    const moved = await call("PATCH", `/scheduled-meetings/${saved.id}`, { scheduledStartAt: movedStart, scheduledEndAt: movedStart + 1_800_000 });
    expect(moved.status).toBe(200);
    answer();

    const booked = await booking;

    expect(booked.status).toBe(201);
    const confirmation = booked.body.booking as Confirmation;
    expect([confirmation.calendarEventId, confirmation.syncStatus, confirmation.startsAt]).toEqual(["google-event-1", "synced", movedStart]);
    const patches = requestsTo(outside, `${GOOGLE_EVENTS}primary/events/google-event-1`, "PATCH");
    expect(patches.map((request) => bodyOf(request).start.dateTime)).toEqual([new Date(movedStart).toISOString()]);
    const stored = (await createScheduledMeetingPersistence().load()).find((meeting) => meeting.id === saved.id);
    expect([stored?.googleCalendarEventId, stored?.calendarSyncStatus, stored?.scheduledStartAt]).toEqual(["google-event-1", "synced", movedStart]);
  });

  it("retried after Google accepted a move confirms against the time Google holds, not the time it was created at", async () => {
    retries.taken = [];
    const { state, call } = await startSfu();
    const { outside, booking, saved, startAt, answer } = await bookWithGoogleHeld(state, call);
    const persistence = state.scheduledMeetingPersistence!;
    const saveChanged = persistence.saveChanged!.bind(persistence);
    let syncedSaveFailed = false;
    vi.spyOn(persistence, "saveChanged").mockImplementation(async (meetings) => {
      if (!syncedSaveFailed && meetings.some((meeting) => meeting.calendarSyncStatus === "synced")) {
        syncedSaveFailed = true;
        throw new Error("database is locked");
      }
      await saveChanged(meetings);
    });
    const movedStart = startAt + 2 * 3_600_000;
    await call("PATCH", `/scheduled-meetings/${saved.id}`, { scheduledStartAt: movedStart, scheduledEndAt: movedStart + 1_800_000 });
    answer();

    expect(((await booking).body.booking as Confirmation).syncStatus).toBe("pending");
    await call("PATCH", `/scheduled-meetings/${saved.id}`, { scheduledStartAt: startAt, scheduledEndAt: startAt + 1_800_000 });

    expect(retries.taken).toHaveLength(1);
    await retries.taken[0]();

    const stored = (await createScheduledMeetingPersistence().load()).find((meeting) => meeting.id === saved.id);
    expect([stored?.calendarSyncStatus, stored?.scheduledStartAt]).toEqual(["synced", startAt]);
    const moves = requestsTo(outside, `${GOOGLE_EVENTS}primary/events/google-event-1`, "PATCH");
    expect(moves.map((request) => bodyOf(request).start.dateTime)).toEqual([movedStart, startAt].map((at) => new Date(at).toISOString()));
  });

  it("redoes a Google move whose reply was lost before the booking reads synced", async () => {
    retries.taken = [];
    const { state, call } = await startSfu();
    let moveLost = false;
    const { outside, booking, saved, startAt, answer } = await bookWithGoogleHeld(state, call, () => {
      if (moveLost) return Promise.resolve();
      moveLost = true;
      return Promise.reject(new TypeError("fetch failed"));
    });
    const movedStart = startAt + 2 * 3_600_000;
    await call("PATCH", `/scheduled-meetings/${saved.id}`, { scheduledStartAt: movedStart, scheduledEndAt: movedStart + 1_800_000 });
    answer();

    expect(((await booking).body.booking as Confirmation).syncStatus).toBe("pending");
    await call("PATCH", `/scheduled-meetings/${saved.id}`, { scheduledStartAt: startAt, scheduledEndAt: startAt + 1_800_000 });

    expect(retries.taken).toHaveLength(1);
    await retries.taken[0]();

    const stored = (await createScheduledMeetingPersistence().load()).find((meeting) => meeting.id === saved.id);
    expect([stored?.calendarSyncStatus, stored?.scheduledStartAt]).toEqual(["synced", startAt]);
    const moves = requestsTo(outside, `${GOOGLE_EVENTS}primary/events/google-event-1`, "PATCH");
    expect(moves.map((request) => bodyOf(request).start.dateTime)).toEqual([movedStart, startAt].map((at) => new Date(at).toISOString()));
  });

  it("builds the confirmation email from one saved copy, so a mid-render edit cannot split its times", async () => {
    const { state, call } = await startSfu();
    const outside = fakeOutsideServices();
    const { book, startAt } = await bookableHost(call);
    const renderStarted = deferred();
    const finishRender = deferred();
    emailRender.hold = async () => {
      renderStarted.resolve();
      await finishRender.promise;
    };
    try {
      const booking = book();
      await renderStarted.promise;
      const saved = [...state.scheduledMeetings.byId.values()].find((meeting) => meeting.source === "booking_link")!;
      const movedStart = startAt + 2 * 3_600_000;
      await call("PATCH", `/scheduled-meetings/${saved.id}`, { scheduledStartAt: movedStart, scheduledEndAt: movedStart + 1_800_000 });
      finishRender.resolve();
      expect((await booking).status).toBe(201);
    } finally {
      emailRender.hold = null;
    }

    const [request] = requestsTo(outside, EMAIL_WORKER);
    const { messages } = JSON.parse(String(request[1]?.body)) as { messages: Array<{ attachments?: Array<{ content: string }> }> };
    const icsStart = new Date(startAt).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    for (const message of messages) {
      expect(message.attachments?.[0]?.content).toContain(`DTSTART:${icsStart}`);
    }
  });

  it("deleted while Google is replying removes the orphaned event and is never reported synced", async () => {
    const { state, call } = await startSfu();
    const { outside, booking, saved, answer } = await bookWithGoogleHeld(state, call);
    expect((await call("DELETE", `/scheduled-meetings/${saved.id}`)).status).toBe(200);
    answer();

    const booked = await booking;

    expect(booked.status).toBe(201);
    expect((booked.body.booking as Confirmation).syncStatus).not.toBe("synced");
    expect(requestsTo(outside, `${GOOGLE_EVENTS}primary/events/google-event-1`, "DELETE")).toHaveLength(1);
    expect(requestsTo(outside, EMAIL_WORKER)).toHaveLength(0);
    expect(state.scheduledMeetings.byId.has(saved.id)).toBe(false);
    expect((await createScheduledMeetingPersistence().load()).some((meeting) => meeting.id === saved.id)).toBe(false);
  });

  it("whose host reconnects Google while Google is replying deletes the event from the old calendar and marks the sync failed", async () => {
    const { state, call } = await startSfu();
    const { outside, booking, saved, answer } = await bookWithGoogleHeld(state, call);
    const reconnected = await call("POST", "/scheduling/calendar/google", {
      refreshToken: "other-account-refresh",
      accessToken: "other-account-access",
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });
    expect(reconnected.status).toBe(200);
    answer();

    const booked = await booking;

    expect((booked.body.booking as Confirmation).syncStatus).toBe("failed");
    const deletes = requestsTo(outside, `${GOOGLE_EVENTS}primary/events/google-event-1`, "DELETE");
    expect(deletes.map(([, init]) => new Headers(init?.headers).get("authorization"))).toEqual(["Bearer access-token"]);
    const stored = (await createScheduledMeetingPersistence().load()).find((meeting) => meeting.id === saved.id);
    expect([stored?.googleCalendarEventId ?? null, stored?.calendarSyncStatus]).toEqual([null, "failed"]);
  });
});

describe("a late writer", () => {
  it("runs a reload after an edit that is waiting on its save, and keeps the event type the reload recovered", async () => {
    const { state, call } = await startSfu();
    const { id: profileId, username, userId } = (await call("GET", "/scheduling/profile")).body.profile as { id: string; username: string; userId: string };
    const persistence = state.schedulingPersistence!;
    const save = persistence.save.bind(persistence);
    const editSaveStarted = deferred();
    const finishEditSave = deferred();
    vi.spyOn(persistence, "save")
      .mockImplementationOnce(save)
      .mockImplementationOnce(async (snapshot) => {
        editSaveStarted.resolve();
        await finishEditSave.promise;
        await save(snapshot);
      });

    const editing = call("PUT", "/scheduling/profile", { name: "Edited Host" });
    await editSaveStarted.promise;
    const now = Date.now();
    const recovered = {
      id: "recovered-event-type", clientId: "conclave", profileId, userId, slug: "recovered-call", title: "Recovered call",
      description: "", durationMinutes: 30, minimumNoticeMinutes: 0, bookingWindowDays: 14, bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0, isActive: true, requiresCalendar: false, createdAt: now, updatedAt: now,
    };
    await createSchedulingPersistence().save({ profiles: [], availability: [], eventTypes: [recovered], calendars: [] });
    let reloadAnswered = false;
    const reloading = call("POST", "/admin/reload-stores").finally(() => {
      reloadAnswered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const answeredBeforeTheEdit = reloadAnswered;
    finishEditSave.resolve();

    expect([(await editing).status, (await reloading).status]).toEqual([200, 200]);
    expect(answeredBeforeTheEdit).toBe(false);
    expect(state.scheduling.eventTypesById.get(recovered.id)?.slug).toBe("recovered-call");
    expect((await call("GET", `/scheduling/public/${username}/recovered-call`)).status).toBe(200);
    expect(state.scheduling.profilesById.get(profileId)?.name).toBe("Edited Host");
  });

  it("drops a Google token refresh that comes back after the host reconnected, keeping the new token", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-secret");
    const { state, call } = await startSfu();
    const { id: profileId, username } = (await call("GET", "/scheduling/profile")).body.profile as { id: string; username: string };
    const { slug } = (await call("POST", "/scheduling/event-types", { title: "Intro call", isActive: true })).body.eventType as { slug: string };
    await call("POST", "/scheduling/calendar/google", { refreshToken: "old-refresh", accessToken: "old-access", accessTokenExpiresAt: Date.now() - 1_000 });
    const refreshStarted = deferred();
    const answerRefresh = deferred();
    const passThrough = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        refreshStarted.resolve();
        await answerRefresh.promise;
        return Response.json({ access_token: "stale-access", expires_in: 3600 });
      }
      if (url.startsWith("https://www.googleapis.com/calendar/v3/freeBusy")) {
        return Response.json({ calendars: { primary: { busy: [] } } });
      }
      return passThrough(input, init);
    });

    const slots = call("GET", `/scheduling/public/${username}/${slug}/slots`);
    await refreshStarted.promise;
    const reconnected = await call("POST", "/scheduling/calendar/google", {
      refreshToken: "new-refresh",
      accessToken: "new-access",
      accessTokenExpiresAt: Date.now() + 3_600_000,
      email: "new-account@example.test",
    });
    expect(reconnected.status).toBe(200);
    answerRefresh.resolve();
    expect((await slots).status).toBe(200);

    const held = state.scheduling.calendarByProfileId.get(profileId);
    expect([held?.refreshToken, held?.accessToken, held?.email]).toEqual(["new-refresh", "new-access", "new-account@example.test"]);
    const stored = (await createSchedulingPersistence().load()).calendars.find((calendar) => calendar.profileId === profileId);
    expect([stored?.refreshToken, stored?.accessToken]).toEqual(["new-refresh", "new-access"]);
  });

  it("saves a Google token refresh when the connection did not change meanwhile", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-secret");
    const { state, call } = await startSfu();
    const { id: profileId, username } = (await call("GET", "/scheduling/profile")).body.profile as { id: string; username: string };
    const { slug } = (await call("POST", "/scheduling/event-types", { title: "Intro call", isActive: true })).body.eventType as { slug: string };
    await call("POST", "/scheduling/calendar/google", { refreshToken: "only-refresh", accessToken: "expired-access", accessTokenExpiresAt: Date.now() - 1_000 });
    const passThrough = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "fresh-access", expires_in: 3600 });
      if (url.startsWith("https://www.googleapis.com/calendar/v3/freeBusy")) return Response.json({ calendars: { primary: { busy: [] } } });
      return passThrough(input, init);
    });

    expect((await call("GET", `/scheduling/public/${username}/${slug}/slots`)).status).toBe(200);
    expect(state.scheduling.calendarByProfileId.get(profileId)?.accessToken).toBe("fresh-access");
  });
});
