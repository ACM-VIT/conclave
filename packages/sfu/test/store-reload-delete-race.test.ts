import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledMeeting, ScheduledWebinar } from "../types.js";
import { initScheduledMeetings, initScheduledWebinars, initScheduling } from "../server/init.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import {
  changeMeetings,
  createScheduledMeetingPersistence,
  deleteScheduledMeeting,
} from "../server/scheduledMeetings.js";
import {
  changeWebinars,
  createScheduledWebinarPersistence,
  deleteScheduledWebinar,
} from "../server/scheduledWebinars.js";
import {
  changeSchedulingHost,
  clearGoogleCalendarConnection,
  createSchedulingPersistence,
  deleteEventType,
} from "../server/scheduling.js";
import { createSfuState, type SfuState } from "../server/state.js";
import { reloadPersistedStores } from "../server/storeReload.js";

const later = Date.now() + 3_600_000;
const meeting = {
  id: "doomed-meeting", clientId: "conclave", roomCode: "doomed-room", title: "fixture", hostEmail: "host@example.test",
  hostName: "", hostUserId: null, scheduledStartAt: later, scheduledEndAt: later + 3_600_000, status: "scheduled",
  startedAt: null, endedAt: null, createdAt: 1, createdBy: "host@example.test", updatedAt: 1, source: "manual", eventTypeId: null,
} as unknown as ScheduledMeeting;
const webinar = {
  id: "doomed-webinar", clientId: "conclave", roomId: "doomed-room", linkSlug: "doomed-room", title: "fixture",
  description: "", hostEmail: "host@example.test", hostName: "", hostUserId: null, coHosts: [], scheduledStartAt: later,
  scheduledEndAt: later + 3_600_000, status: "scheduled", publicAccess: true, maxAttendees: 500, requiresInviteCode: false,
  waitingRoomEnabled: true, earlyEntryMinutes: 10, qaEnabled: true, notes: "", createdAt: 1, createdBy: "", updatedAt: 1,
  liveStartedAt: null, endedAt: null, totalJoinCount: 0, peakAttendeeCount: 0, coHostInviteTokenHash: null,
  coHostInviteTokenCreatedAt: null,
} as unknown as ScheduledWebinar;
const profile = {
  id: "host", clientId: "conclave", userId: "user-host", email: "host@example.test", name: "Host", username: "host",
  timeZone: "UTC", createdAt: 1, updatedAt: 1,
};
const eventType = {
  id: "intro", clientId: "conclave", profileId: "host", userId: "user-host", slug: "intro", title: "Intro", description: "",
  durationMinutes: 30, minimumNoticeMinutes: 0, bookingWindowDays: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
  isActive: true, requiresCalendar: false, createdAt: 1, updatedAt: 1,
};
const calendar = {
  id: "calendar-host", clientId: "conclave", profileId: "host", userId: "user-host", provider: "google", status: "connected",
  email: "host@example.test", calendarId: "primary", accessToken: "access", refreshToken: "refresh",
  accessTokenExpiresAt: later, scopes: [], connectedAt: 1, updatedAt: 1, error: null,
};

let stateDir = "";

const startState = async (): Promise<SfuState> => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: "race", instanceUrl: "http://localhost", ttlMs: 45000 }),
  });
  await initScheduledWebinars(state);
  await initScheduledMeetings(state);
  await initScheduling(state);
  return state;
};

// Lets the test delete a record after the reload's read returned but before the reload merges it.
const holdFirstRead = (persistence: object) => {
  let release!: () => void;
  let markRead!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const read = new Promise<void>((resolve) => { markRead = resolve; });
  const target = persistence as Record<string, (...args: unknown[]) => unknown>;
  const method = ["loadState", "load"].find((name) => typeof target[name] === "function")!;
  const original = target[method].bind(persistence);
  vi.spyOn(target, method).mockImplementationOnce(async (...args: unknown[]) => {
    const result = await original(...args);
    markRead();
    await gate;
    return result;
  });
  return { read, release };
};

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "sfu-reload-delete-race-"));
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(stateDir, "conclave.sqlite"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(stateDir, "json-fallback-import"));
  for (const variable of ["SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL"]) {
    vi.stubEnv(variable, "");
  }
  for (const method of ["log", "info", "warn"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("a reload racing a delete", () => {
  it("keeps a meeting deleted while the reload's read was in flight deleted", async () => {
    await createScheduledMeetingPersistence().saveChanged?.([meeting]);
    const state = await startState();
    const hold = holdFirstRead(state.scheduledMeetingPersistence!);

    const reload = reloadPersistedStores(state);
    await hold.read;
    await changeMeetings(state.scheduledMeetings, state.scheduledMeetingPersistence, [meeting.id], (draft) =>
      deleteScheduledMeeting(draft, meeting.id),
    );
    hold.release();
    await reload;

    expect(state.scheduledMeetings.byId.has(meeting.id)).toBe(false);
    expect((await createScheduledMeetingPersistence().load()).map((entry) => entry.id)).toEqual([]);
  });

  it.each(["event type", "calendar connection"])("keeps a %s deleted while the reload's read was in flight deleted", async (kind) => {
    await createSchedulingPersistence().save({ profiles: [profile], availability: [], eventTypes: [eventType], calendars: [calendar] } as never);
    const state = await startState();
    const hold = holdFirstRead(state.schedulingPersistence!);

    const reload = reloadPersistedStores(state);
    await hold.read;
    await changeSchedulingHost(state.scheduling, state.schedulingPersistence, "host", (draft) => {
      const host = draft.profilesById.get("host")!;
      if (kind === "event type") deleteEventType(draft, host, eventType.id);
      else clearGoogleCalendarConnection(draft, host);
    });
    hold.release();
    await reload;

    const stored = await createSchedulingPersistence().load();
    if (kind === "event type") {
      expect([state.scheduling.eventTypesById.has(eventType.id), stored.eventTypes.length]).toEqual([false, 0]);
    } else {
      expect([state.scheduling.calendarByProfileId.has("host"), stored.calendars.length]).toEqual([false, 0]);
    }
  });

  it("keeps a webinar one SFU deleted deleted when the other saves or reloads its stale copy", async () => {
    createScheduledWebinarPersistence().saveChanged?.([webinar]);
    const sfuA = await startState();
    const sfuB = await startState();

    await changeWebinars(sfuA.scheduledWebinars, sfuA.scheduledWebinarPersistence, [webinar.id], (draft) =>
      deleteScheduledWebinar(draft, webinar.id),
    );
    await changeWebinars(sfuB.scheduledWebinars, sfuB.scheduledWebinarPersistence, [webinar.id], (draft) => {
      draft.byId.get(webinar.id)!.updatedAt = 2;
    });
    await reloadPersistedStores(sfuB);

    expect(createScheduledWebinarPersistence().load().map((entry) => entry.id)).toEqual([]);
    expect(sfuB.scheduledWebinars.byId.has(webinar.id)).toBe(false);
  });
});
