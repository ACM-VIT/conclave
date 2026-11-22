import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import { getAdminAuditEntries } from "../server/admin/adminAudit.js";
import { createSfuApp } from "../server/http/createApp.js";
import { initScheduledMeetings, initScheduledWebinars, initScheduling } from "../server/init.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createSchedulingPersistence } from "../server/scheduling.js";
import { createSfuState } from "../server/state.js";

const meeting = {
  id: "prior-meeting", clientId: "conclave", roomCode: "fixture-room", title: "fixture", hostEmail: "host@example.test",
  hostName: "", hostUserId: null, scheduledStartAt: Date.now() + 3_600_000, scheduledEndAt: Date.now() + 7_200_000,
  status: "scheduled", startedAt: null, endedAt: null, createdAt: 1, createdBy: "host@example.test", updatedAt: 1,
  source: "manual", eventTypeId: null,
};
const webinar = {
  id: "prior-webinar", clientId: "conclave", roomId: "fixture-room", linkSlug: "fixture-room", title: "fixture",
  description: "", hostEmail: "host@example.test", hostName: "", hostUserId: null, coHosts: [],
  scheduledStartAt: Date.now() + 3_600_000, scheduledEndAt: Date.now() + 7_200_000, status: "scheduled",
  publicAccess: true, maxAttendees: 500, requiresInviteCode: false, waitingRoomEnabled: true, earlyEntryMinutes: 10,
  qaEnabled: true, notes: "", createdAt: 1, createdBy: "", updatedAt: 1, liveStartedAt: null, endedAt: null,
  totalJoinCount: 0, peakAttendeeCount: 0, coHostInviteTokenHash: null, coHostInviteTokenCreatedAt: null,
};
const profile = {
  id: "original-profile", clientId: "conclave", userId: "review-host", email: "host@example.test", name: "Review Host",
  username: "review-host", timeZone: "UTC", createdAt: 1, updatedAt: 1,
};

let stateDir = "";
const servers: Server[] = [];

const startSfu = async () => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: `sfu-${servers.length}`, instanceUrl: "http://localhost", ttlMs: 45000 }),
  });
  await initScheduledWebinars(state);
  await initScheduledMeetings(state);
  await initScheduling(state);
  const server = createServer(createSfuApp({ state, config, getIo: () => null }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { "x-sfu-secret": config.sfuSecret, "x-sfu-client": "conclave", ...headers },
    });
    const text = await response.text();
    let body: Record<string, { id?: string } | undefined> = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      body = {};
    }
    return { status: response.status, body };
  };
  return { call };
};

const hostHeaders = { "x-user-id": "review-host", "x-user-email": "host@example.test", "x-user-name": "Review Host" };

const recoverOnNextStart = () => {
  const dir = join(stateDir, "json-fallback-import", "sfu-a");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scheduled-meetings.json"), JSON.stringify([meeting]));
  writeFileSync(join(dir, "scheduled-webinars.json"), JSON.stringify([webinar]));
  writeFileSync(join(dir, "scheduling.json"), JSON.stringify({ profiles: [profile], availability: [], eventTypes: [], calendars: [] }));
};

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "sfu-rolling-reload-"));
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(stateDir, "conclave.sqlite"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(stateDir, "json-fallback-import"));
  for (const variable of ["SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL"]) {
    vi.stubEnv(variable, "");
  }
  for (const method of ["log", "info", "warn"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("a rolling restart where the second SFU recovers records", () => {
  it("serves every recovered record from both SFUs once the deploy reloads them", async () => {
    const first = await startSfu();
    recoverOnNextStart();
    const second = await startSfu();

    for (const sfu of [first, second]) {
      expect((await sfu.call("POST", "/admin/reload-stores")).status).toBe(200);
    }
    for (const sfu of [first, second]) {
      const meetingRead = await sfu.call("GET", "/scheduled-meetings/by-room/fixture-room");
      expect([meetingRead.status, meetingRead.body.scheduledMeeting?.id]).toEqual([200, "prior-meeting"]);
      const webinarRead = await sfu.call("GET", "/scheduled-webinars/by-slug/fixture-room");
      expect([webinarRead.status, webinarRead.body.scheduledWebinar?.id]).toEqual([200, "prior-webinar"]);
      const profileRead = await sfu.call("GET", "/scheduling/profile", hostHeaders);
      expect([profileRead.status, profileRead.body.profile?.id]).toEqual([200, "original-profile"]);
    }
    const stored = await createSchedulingPersistence().load();
    expect(stored.profiles.map((entry) => entry.id)).toEqual(["original-profile"]);
  });

  it("finds a recovered profile it has not loaded before creating a new one", async () => {
    const first = await startSfu();
    recoverOnNextStart();
    await startSfu();

    const profileRead = await first.call("GET", "/scheduling/profile", hostHeaders);
    expect([profileRead.status, profileRead.body.profile?.id]).toEqual([200, "original-profile"]);
    const stored = await createSchedulingPersistence().load();
    expect(stored.profiles.map((entry) => entry.id)).toEqual(["original-profile"]);
  });

  it("records a reload in the admin activity feed with the operator", async () => {
    const sfu = await startSfu();
    expect((await sfu.call("POST", "/admin/reload-stores", { "x-sfu-operator": "ops@example.test" })).status).toBe(200);
    const reloads = getAdminAuditEntries().filter((entry) => entry.path === "/admin/reload-stores");
    expect(reloads.at(-1)).toMatchObject({ operator: "ops@example.test", method: "POST", ok: true });
  });

  it("answers 500 when writing the merged records back fails", async () => {
    const sfu = await startSfu();
    const holder = new DatabaseSync(join(stateDir, "conclave.sqlite"));
    holder.exec("BEGIN IMMEDIATE");
    try {
      expect((await sfu.call("POST", "/admin/reload-stores")).status).toBe(500);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  }, 30_000);

  it("answers 500 when a JSON store cannot take the write-back", async () => {
    vi.stubEnv("SCHEDULING_PERSISTENCE", "json");
    vi.stubEnv("SCHEDULING_PATH", join(stateDir, "json-store", "scheduling.json"));
    mkdirSync(join(stateDir, "json-store"));
    writeFileSync(join(stateDir, "json-store", "scheduling.json"), JSON.stringify({ profiles: [profile], availability: [], eventTypes: [], calendars: [] }));
    const sfu = await startSfu();
    chmodSync(join(stateDir, "json-store"), 0o500);
    try {
      expect((await sfu.call("POST", "/admin/reload-stores")).status).toBe(500);
    } finally {
      chmodSync(join(stateDir, "json-store"), 0o700);
    }
  });

  it("refuses a reload without the SFU secret", async () => {
    const sfu = await startSfu();
    expect((await sfu.call("POST", "/admin/reload-stores", { "x-sfu-secret": "wrong" })).status).toBe(401);
  });
});
