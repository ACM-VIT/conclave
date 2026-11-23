import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(stateDir, "json-fallback-import"));
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
    await persistence.saveChanged([meeting("stored-newer", 50, "kept from SQLite")]);
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

  it("reads the folder the deploy copied into when RECORDING_STORAGE_PATH names a custom host folder", async () => {
    // Compose mounts that host folder at /var/lib/conclave/recordings but passes the host path in as is.
    vi.stubEnv("RECORDING_STORAGE_PATH", "/srv/conclave-state");
    const persistence = createScheduledWebinarPersistence();
    writeFallback("sfu-a", "scheduled-webinars.json", [webinar("prior-webinar", 1)]);

    expect(await importFallbackWebinars(persistence)).toBe(1);
    expect(readdirSync(importDir("sfu-a"))).toEqual(["scheduled-webinars.json.imported"]);
  });

  it("keeps recovery files private and drops imported archives after seven days", async () => {
    const persistence = createScheduledWebinarPersistence();
    writeFallback("sfu-a", "scheduled-webinars.json", [webinar("prior-webinar", 1)]);
    writeFallback("sfu-b", "scheduled-meetings.json.imported", []);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(importDir("sfu-b"), "scheduled-meetings.json.imported"), eightDaysAgo, eightDaysAgo);
    writeFallback("sfu-b", "scheduling.json.imported", {});
    for (const dir of [join(stateDir, "json-fallback-import"), importDir("sfu-a"), importDir("sfu-b")]) chmodSync(dir, 0o755);
    const mode = (path: string) => statSync(path).mode & 0o777;

    expect(await importFallbackWebinars(persistence)).toBe(1);
    expect(mode(join(stateDir, "json-fallback-import"))).toBe(0o700);
    expect([mode(importDir("sfu-a")), mode(importDir("sfu-b"))]).toEqual([0o700, 0o700]);
    expect(mode(join(importDir("sfu-a"), "scheduled-webinars.json.imported"))).toBe(0o600);
    expect(mode(join(importDir("sfu-b"), "scheduling.json.imported"))).toBe(0o600);
    expect(readdirSync(importDir("sfu-b"))).toEqual(["scheduling.json.imported"]);
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
    persistence.saveChanged([webinar("stored", 50)]);
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

describe("importing JSON fallback files into a single-instance JSON store", () => {
  const store = (file: string) => join(stateDir, "store", file);
  const storedJson = (file: string): unknown => JSON.parse(readFileSync(store(file), "utf8"));

  beforeEach(() => {
    for (const prefix of ["SCHEDULING", "SCHEDULED_MEETINGS", "SCHEDULED_WEBINARS"]) {
      vi.stubEnv(`${prefix}_PERSISTENCE`, "json");
    }
    vi.stubEnv("SCHEDULING_PATH", store("scheduling.json"));
    vi.stubEnv("SCHEDULED_MEETINGS_PATH", store("scheduled-meetings.json"));
    vi.stubEnv("SCHEDULED_WEBINARS_PATH", store("scheduled-webinars.json"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("merges meetings by updated time and imports each file once", async () => {
    const persistence = createScheduledMeetingPersistence();
    await persistence.saveChanged([meeting("stored-newer", 50, "kept from the store")]);
    writeFallback("sfu-a", "scheduled-meetings.json", [meeting("prior-meeting", 1), meeting("stored-newer", 10, "older copy")]);

    expect(await importFallbackMeetings(persistence)).toBe(1);
    const saved = await createScheduledMeetingPersistence().load();
    expect(new Map(saved.map((entry) => [entry.id, entry.title]))).toEqual(new Map([["stored-newer", "kept from the store"], ["prior-meeting", "fixture"]]));
    expect(readdirSync(importDir("sfu-a"))).toEqual(["scheduled-meetings.json.imported"]);
    expect(readdirSync(join(stateDir, "store"))).toEqual(["scheduled-meetings.json"]);
  });

  it("merges webinars by updated time", async () => {
    const persistence = createScheduledWebinarPersistence();
    persistence.saveChanged([webinar("stored-newer", 50)]);
    writeFallback("sfu-a", "scheduled-webinars.json", [webinar("prior-webinar", 1), webinar("stored-newer", 10)]);

    expect(await importFallbackWebinars(persistence)).toBe(1);
    const saved = createScheduledWebinarPersistence().load();
    expect(new Map(saved.map((entry) => [entry.id, entry.updatedAt]))).toEqual(new Map([["stored-newer", 50], ["prior-webinar", 1]]));
  });

  it("merges scheduling records and booking hours by updated time", async () => {
    const persistence = createSchedulingPersistence();
    const profile = { id: "host", clientId: "conclave", userId: "user-host", email: "host@example.test", name: "Host", username: "host", timeZone: "Asia/Kolkata", createdAt: 1, updatedAt: 100 };
    const hours = (updatedAt: number, startMinutes: number) => ({
      profileId: "host",
      availability: { timeZone: "Asia/Kolkata", windows: [{ day: 1 as const, startMinutes, endMinutes: 1020 }], overrides: [], updatedAt },
    });
    await persistence.save({ profiles: [profile], availability: [hours(100, 540)], eventTypes: [], calendars: [] });
    writeFallback("sfu-a", "scheduling.json", {
      profiles: [{ ...profile, id: "prior-host", userId: "user-prior", username: "prior-host", updatedAt: 1 }],
      availability: [hours(200, 600)],
      eventTypes: [],
      calendars: [],
    });
    writeFallback("sfu-b", "scheduling.json", { profiles: [], availability: [hours(50, 480)], eventTypes: [], calendars: [] });

    expect(await importFallbackScheduling(persistence)).toBe(2);
    const saved = await createSchedulingPersistence().load();
    expect(saved.profiles.map((entry) => entry.id).sort()).toEqual(["host", "prior-host"]);
    expect(saved.availability).toEqual([hours(200, 600)]);
  });

  describe("when the stored hours predate their own updatedAt", () => {
    const profile = (updatedAt: number) => ({ id: "host", clientId: "conclave", userId: "user-host", email: "host@example.test", name: "Host", username: "host", timeZone: "Asia/Kolkata", createdAt: 1, updatedAt });
    const hours = (startMinutes: number, updatedAt?: number) => ({
      profileId: "host",
      availability: { timeZone: "Asia/Kolkata", windows: [{ day: 1 as const, startMinutes, endMinutes: 1020 }], overrides: [], ...(updatedAt === undefined ? {} : { updatedAt }) },
    });
    const storedHours = () => (storedJson("scheduling.json") as { availability: ReturnType<typeof hours>[] }).availability;

    beforeEach(() => {
      mkdirSync(join(stateDir, "store"), { recursive: true });
      writeFileSync(store("scheduling.json"), JSON.stringify({ profiles: [profile(100)], availability: [hours(540)], eventTypes: [], calendars: [] }));
    });

    it("compares them with the profile as stored before the import, not the recovered profile", async () => {
      writeFallback("sfu-a", "scheduling.json", { profiles: [profile(200)], availability: [hours(600, 200)], eventTypes: [], calendars: [] });

      expect(await importFallbackScheduling(createSchedulingPersistence())).toBe(2);
      expect(storedHours()).toEqual([hours(600, 200)]);
    });

    it("still does when an earlier file brought the newer profile", async () => {
      writeFallback("sfu-a", "scheduling.json", { profiles: [profile(200)], availability: [], eventTypes: [], calendars: [] });
      writeFallback("sfu-b", "scheduling.json", { profiles: [], availability: [hours(600, 200)], eventTypes: [], calendars: [] });

      expect(await importFallbackScheduling(createSchedulingPersistence())).toBe(2);
      expect(storedHours()).toEqual([hours(600, 200)]);
    });

    it("stamps imported hours with the time they were compared at", async () => {
      writeFallback("sfu-a", "scheduling.json", { profiles: [profile(300)], availability: [hours(660)], eventTypes: [], calendars: [] });

      expect(await importFallbackScheduling(createSchedulingPersistence())).toBe(2);
      expect(storedHours()).toEqual([hours(660, 300)]);
    });
  });

  it("keeps the fallback file and leaves a damaged store untouched", async () => {
    mkdirSync(join(stateDir, "store"), { recursive: true });
    writeFileSync(store("scheduled-meetings.json"), '[{"id": "half-written"');
    writeFallback("sfu-a", "scheduled-meetings.json", [meeting("prior-meeting", 1)]);

    expect(await importFallbackMeetings(createScheduledMeetingPersistence())).toBe(0);
    expect(readFileSync(store("scheduled-meetings.json"), "utf8")).toBe('[{"id": "half-written"');
    expect(readdirSync(importDir("sfu-a"))).toEqual(["scheduled-meetings.json"]);
  });
});
