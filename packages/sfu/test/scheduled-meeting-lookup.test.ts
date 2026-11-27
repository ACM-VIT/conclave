import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryBackend } from "../server/controlPlane/backends/memory.js";
import { createMeeting, meetingById } from "../server/controlPlane/meetingCommands.js";
import { controlPlaneStore } from "../server/controlPlane/store.js";
import { registerScheduledMeetingRoutes } from "../server/http/scheduledMeetingRoutes.js";
import { registerSchedulingRoutes } from "../server/http/schedulingRoutes.js";
import type { SfuState } from "../server/state.js";
import type { ScheduledMeeting, SchedulingProfile } from "../types.js";

const SECRET = "test-secret-0123456789";
const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  vi.unstubAllEnvs();
});

async function bookingService() {
  const store = controlPlaneStore(createMemoryBackend());
  const meeting = await store.commit(createMeeting(
    { title: "Weekly sync", scheduledStartAt: Date.now() + 60_000, roomCode: "weekly-sync" },
    {
      clientId: "conclave",
      createdBy: "host@example.com",
      defaultHostEmail: "host@example.com",
      defaultHostUserId: null,
    },
  ));
  if (!meeting.ok) throw new Error("Could not seed meeting");
  const app = express();
  app.use(express.json());
  const state = { controlPlane: store, calendarTasks: { draining: false } } as SfuState;
  registerScheduledMeetingRoutes(app, { state, sfuSecret: SECRET });
  registerSchedulingRoutes(app, { state, sfuSecret: SECRET });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const call = async (path: string, clientId: string, method = "GET", body?: object) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        "x-sfu-secret": SECRET,
        "x-sfu-client": clientId,
        "x-user-id": "host",
        "x-user-email": "host@example.com",
        "x-user-is-admin": "1",
        "content-type": "application/json",
      },
      body: body && JSON.stringify(body),
    });
    const payload = await response.json() as {
      profile?: SchedulingProfile;
      scheduledMeeting?: ScheduledMeeting | null;
    };
    return { status: response.status, body: payload };
  };
  return { store, meeting: meeting.value, call };
}

describe("looking a booking up by room code", () => {
  it("answers only for the tenant asked and never moves the booking", async () => {
    vi.stubEnv("SFU_CLIENT_ID", "acme");
    const { store, meeting, call } = await bookingService();
    const v1 = "/scheduled-meetings/public/by-room/weekly-sync";
    const v2 = "/scheduled-meetings/public/v2/by-room/weekly-sync";

    expect((await call(v1, "acme")).status).toBe(404);
    expect(await call(v2, "acme")).toEqual({ status: 200, body: { scheduledMeeting: null } });
    expect(await call(v2, "beta")).toEqual({ status: 200, body: { scheduledMeeting: null } });
    expect(await call(v2, "default")).toMatchObject({
      status: 200, body: { scheduledMeeting: { clientId: "conclave" } },
    });
    expect((await call(v2, "conclave")).body.scheduledMeeting).not.toHaveProperty("hostEmail");
    expect((await store.read(meetingById(meeting.id)))?.clientId).toBe("conclave");
  });

  it("keeps by-ID reads and changes in the selected tenant even for the same admin", async () => {
    vi.stubEnv("SFU_CLIENT_ID", "conclave");
    const { call, meeting } = await bookingService();
    const byId = `/scheduled-meetings/${meeting.id}`;
    expect(await call("/scheduled-meetings?scope=all", "acme")).toEqual({
      status: 200, body: { scheduledMeetings: [] },
    });
    expect((await call(byId, "acme")).status).toBe(404);
    expect((await call(byId, "acme", "PATCH", { title: "Wrong tenant" })).status).toBe(404);
    expect((await call(byId, "acme", "DELETE")).status).toBe(404);
    expect((await call(byId, "conclave")).body.scheduledMeeting?.title).toBe("Weekly sync");
    expect((await call(byId, "conclave", "PATCH", { title: "Renamed" })).status).toBe(200);
    expect((await call(byId, "conclave")).body.scheduledMeeting?.title).toBe("Renamed");
  });
});

it("edits only the selected scheduling profile and exposes booking pages only in its namespace", async () => {
  vi.stubEnv("SFU_CLIENT_ID", "conclave");
  const { call } = await bookingService();
  const path = "/scheduling/profile";
  const primary = (await call(path, "conclave")).body.profile;
  if (!primary) throw new Error("Could not create the default profile");
  expect((await call("/scheduling/event-types", "conclave", "POST", {
    title: "Default only", slug: "default-only", isActive: true,
  })).status).toBe(201);
  const custom = (await call(path, "acme")).body.profile;
  expect(custom).toMatchObject({ clientId: "acme" });
  expect(custom?.id).not.toBe(primary.id);
  expect((await call(path, "acme", "PUT", { name: "Acme host" })).body.profile?.name).toBe("Acme host");
  expect((await call(path, "conclave")).body.profile).toEqual(primary);
  const page = `/scheduling/public/${primary.username}/default-only`;
  expect((await call(page, "conclave")).status).toBe(200);
  expect((await call(page, "acme")).status).toBe(404);
});
