import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config/config.js";
import { createSfuApp } from "../server/http/createApp.js";
import { initScheduledMeetings, initScheduledWebinars, initScheduling } from "../server/init.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createSfuState, type SfuState } from "../server/state.js";

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
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

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

  it("answers 503 with the same code for a scheduling route", async () => {
    const { state, call } = await startSfu();
    expect((await call("GET", "/scheduling/profile")).status).toBe(200);
    failSaves(state.schedulingPersistence!, ["save"]);

    const response = await call("PUT", "/scheduling/profile", { name: "Renamed Host" });
    expect([response.status, response.body.error]).toEqual([503, unavailable.error]);
  });
});
