import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledMeeting, ScheduledWebinar } from "../types.js";
import { createScheduledMeetingPersistence, importFallbackMeetings } from "../server/scheduledMeetings.js";
import { createScheduledWebinarPersistence, importFallbackWebinars } from "../server/scheduledWebinars.js";
import { createSchedulingPersistence, importFallbackScheduling } from "../server/scheduling.js";

// Records an older SFU wrote to JSON in its container layer while SQLite was
// locked, in the shape Astra's review captured from that revision.
const meeting = (id: string, updatedAt: number, title = "fixture"): ScheduledMeeting => ({
  id, clientId: "conclave", roomCode: `${id}-room`, title, hostEmail: "host@example.test", hostName: "", hostUserId: null,
  scheduledStartAt: 200, scheduledEndAt: 3_600_200, status: "scheduled", startedAt: null, endedAt: null,
  createdAt: 1_795_362_378_287, createdBy: "host@example.test", updatedAt, source: "manual", eventTypeId: null,
  attendeeName: null, attendeeEmail: null, attendeeNote: null, attendeeTimeZone: null, googleCalendarEventId: null,
  calendarSyncStatus: "not_required", calendarSyncError: null, emailNotificationStatus: "not_configured",
  emailNotificationError: null, emailNotificationSentAt: null, emailReminderStatus: "not_configured",
  emailReminderError: null, emailReminderSentAt: null,
} as unknown as ScheduledMeeting);

const webinar = (id: string, updatedAt: number): ScheduledWebinar => ({
  id, clientId: "conclave", roomId: `${id}-room`, linkSlug: `${id}-room`, title: "fixture", description: "",
  hostEmail: "host@example.test", hostName: "", hostUserId: null, coHosts: [], scheduledStartAt: 200,
  scheduledEndAt: 3_600_200, status: "scheduled", publicAccess: true, maxAttendees: 500, requiresInviteCode: false,
  waitingRoomEnabled: true, earlyEntryMinutes: 10, qaEnabled: true, notes: "", createdAt: 1_795_362_378_288,
  createdBy: "", updatedAt, liveStartedAt: null, endedAt: null, totalJoinCount: 0, peakAttendeeCount: 0,
  webinarLink: `https://conclave.acmvit.in/w/${id}-room`, coHostInviteTokenHash: null, coHostInviteTokenCreatedAt: null,
} as unknown as ScheduledWebinar);

let stateDir = "";
const importDir = (container: string) => join(stateDir, "json-fallback-import", container);
const writeFallback = (container: string, file: string, data: unknown) => {
  mkdirSync(importDir(container), { recursive: true });
  writeFileSync(join(importDir(container), file), JSON.stringify(data));
};

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "sfu-fallback-import-"));
  vi.stubEnv("RECORDING_STORAGE_PATH", stateDir);
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(stateDir, "conclave.sqlite"));
  for (const variable of ["SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "SCHEDULING_PATH", "SCHEDULED_MEETINGS_PATH", "SCHEDULED_WEBINARS_PATH", "REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL"]) {
    vi.stubEnv(variable, "");
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("importing JSON fallback files copied from old containers", () => {
  it("adds meetings SQLite lacks, keeps newer stored ones, and imports each file once", async () => {
    const persistence = createScheduledMeetingPersistence();
    await persistence.save([meeting("stored-newer", 50, "kept from SQLite")]);
    writeFallback("sfu-a", "scheduled-meetings.json", [meeting("prior-meeting", 1), meeting("stored-newer", 10, "older copy")]);
    writeFallback("sfu-b", "scheduled-meetings.json", [meeting("other-instance", 1)]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await importFallbackMeetings(persistence)).toBe(2);
    // Production logs at warn by default; the count must reach the operator there.
    expect(warn.mock.calls.flat().join(" ")).toMatch(/Imported 2 scheduled meeting\(s\) from 2 JSON fallback file\(s\)/);
    const saved = (await createScheduledMeetingPersistence().load());
    expect(saved.map((entry) => entry.id).sort()).toEqual(["other-instance", "prior-meeting", "stored-newer"]);
    expect(saved.find((entry) => entry.id === "stored-newer")?.title).toBe("kept from SQLite");
    expect(readdirSync(importDir("sfu-a"))).toEqual(["scheduled-meetings.json.imported"]);
    expect(await importFallbackMeetings(persistence)).toBe(0);
  });

  it("imports webinars the old container saved", async () => {
    const persistence = createScheduledWebinarPersistence();
    writeFallback("sfu-a", "scheduled-webinars.json", [webinar("prior-webinar", 1)]);
    expect(await importFallbackWebinars(persistence)).toBe(1);
    expect(createScheduledWebinarPersistence().load().map((entry) => entry.id)).toEqual(["prior-webinar"]);
    expect(await importFallbackWebinars(persistence)).toBe(0);
  });

  it("keeps a file that does not parse and imports it on a later start", async () => {
    const persistence = createScheduledWebinarPersistence();
    mkdirSync(importDir("sfu-a"), { recursive: true });
    writeFileSync(join(importDir("sfu-a"), "scheduled-webinars.json"), '[{"id": "cut-off-mid-write"');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await importFallbackWebinars(persistence)).toBe(0);
    expect(readdirSync(importDir("sfu-a"))).toEqual(["scheduled-webinars.json"]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/Kept .*sfu-a.scheduled-webinars\.json/);

    writeFallback("sfu-a", "scheduled-webinars.json", [webinar("prior-webinar", 1)]);
    expect(await importFallbackWebinars(persistence)).toBe(1);
    expect(readdirSync(importDir("sfu-a"))).toEqual(["scheduled-webinars.json.imported"]);
  });

  it("keeps a file when the store refuses one of its records and still imports the rest", async () => {
    const persistence = createScheduledWebinarPersistence();
    persistence.save([webinar("stored", 50)]);
    writeFallback("sfu-a", "scheduled-webinars.json", [
      { ...webinar("clashing-link", 5), linkSlug: "stored-room" },
      webinar("prior-webinar", 1),
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await importFallbackWebinars(persistence)).toBe(1);
    expect(createScheduledWebinarPersistence().load().map((entry) => entry.id).sort()).toEqual(["prior-webinar", "stored"]);
    expect(readdirSync(importDir("sfu-a"))).toEqual(["scheduled-webinars.json"]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/clashing-link.*UNIQUE/);
  });

  it("imports scheduling profiles the old container saved", async () => {
    const persistence = createSchedulingPersistence();
    writeFallback("sfu-a", "scheduling.json", {
      profiles: [{ id: "prior-profile", clientId: "conclave", userId: "user-prior", email: "host@example.test", name: "Prior Host", username: "prior-host", timeZone: "Asia/Kolkata", createdAt: 1, updatedAt: 1 }],
      availability: [], eventTypes: [], calendars: [],
    });
    expect(await importFallbackScheduling(persistence)).toBe(1);
    expect((await createSchedulingPersistence().load()).profiles.map((profile) => profile.id)).toEqual(["prior-profile"]);
    expect(existsSync(join(importDir("sfu-a"), "scheduling.json"))).toBe(false);
    expect(await importFallbackScheduling(persistence)).toBe(0);
  });

  it("merges booking hours by their own updated time, newer wins", async () => {
    const persistence = createSchedulingPersistence();
    const profile = { id: "host", clientId: "conclave", userId: "user-host", email: "host@example.test", name: "Host", username: "host", timeZone: "Asia/Kolkata", createdAt: 1, updatedAt: 100 };
    const hours = (updatedAt: number, startMinutes: number) => ({
      profileId: "host",
      availability: { timeZone: "Asia/Kolkata", windows: [{ day: 1 as const, startMinutes, endMinutes: 1020 }], overrides: [], updatedAt },
    });
    await persistence.save({ profiles: [profile], availability: [hours(100, 540)], eventTypes: [], calendars: [] });
    writeFallback("sfu-a", "scheduling.json", { profiles: [profile], availability: [hours(200, 600)], eventTypes: [], calendars: [] });
    writeFallback("sfu-b", "scheduling.json", { profiles: [], availability: [hours(50, 480)], eventTypes: [], calendars: [] });

    expect(await importFallbackScheduling(persistence)).toBe(1);
    expect((await createSchedulingPersistence().load()).availability).toEqual([hours(200, 600)]);
  });
});
