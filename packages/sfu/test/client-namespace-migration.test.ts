import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduledWebinar } from "../types.js";
import { config } from "../config/config.js";
import { canMigrateClientNamespace } from "../server/clientIds.js";
import { createSfuApp } from "../server/http/createApp.js";
import { createMeeting, meetingById } from "../server/controlPlane/meetingCommands.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createSfuState } from "../server/state.js";
import { webinarById } from "../server/controlPlane/webinarCommands.js";
import { seed } from "./support/controlPlane.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.unstubAllEnvs();
});

describe("client namespace migration", () => {
  it("only moves data from a legacy alias into the deployment's default client", () => {
    expect(canMigrateClientNamespace("default", "conclave")).toBe(true);
    expect(canMigrateClientNamespace("public", "conclave")).toBe(true);
    expect(canMigrateClientNamespace("conclave", "evil")).toBe(false);
    expect(canMigrateClientNamespace("conclave", "conclave")).toBe(false);
    expect(canMigrateClientNamespace("internal", "conclave")).toBe(false);
  });

  it("looks up a current scheduled meeting by room code only in the requested tenant", async () => {
    vi.stubEnv("SFU_CLIENT_ID", "conclave");
    const state = createSfuState({
      roomRegistry: new LocalRoomRegistry({ instanceId: "ns", instanceUrl: "http://localhost", ttlMs: 45000 }),
    });
    const created = await state.controlPlane.commit(createMeeting({
      title: "Scheduled fixture", roomCode: "review-cross-route", scheduledStartAt: Date.now() + 3_600_000,
    }, { clientId: "conclave", createdBy: "review@example.test", defaultHostEmail: "review@example.test", defaultHostUserId: null }));
    if (!created.ok) throw new Error("Could not seed the scheduled meeting");
    const server = createServer(createSfuApp({ state, config, getIo: () => null }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const fetchRoom = (path: string, clientId: string) =>
      fetch(`http://127.0.0.1:${address.port}/scheduled-meetings${path}/by-room/review-cross-route?clientId=${clientId}`, {
        headers: { "x-sfu-secret": config.sfuSecret },
      });
    for (const path of ["", "/public"]) {
      expect((await fetchRoom(path, "conclave")).status).toBe(200);
      expect((await fetchRoom(path, "acme")).status).toBe(404);
    }
    expect(await state.controlPlane.read(meetingById(created.value.id))).toEqual(created.value);
  });

  it("does not move a scheduled webinar into a client id named by the request", async () => {
    const state = createSfuState({
      roomRegistry: new LocalRoomRegistry({ instanceId: "ns", instanceUrl: "http://localhost", ttlMs: 45000 }),
    });
    const now = Date.now();
    const webinar = {
      id: "w1", clientId: "conclave", roomId: "sched-abc", linkSlug: "launch", title: "Launch", description: "",
      hostEmail: "host@example.com", hostName: "Host", hostUserId: null, coHosts: [],
      scheduledStartAt: now + 3_600_000, scheduledEndAt: now + 7_200_000, status: "scheduled",
      publicAccess: true, maxAttendees: 100, requiresInviteCode: false, waitingRoomEnabled: false,
      earlyEntryMinutes: 10, qaEnabled: true, notes: "", createdAt: now, createdBy: "host@example.com",
      updatedAt: now, liveStartedAt: null, endedAt: null, totalJoinCount: 0, peakAttendeeCount: 0,
      webinarLink: "http://localhost/w/launch", coHostInviteTokenHash: null, coHostInviteTokenCreatedAt: null,
    } as ScheduledWebinar;
    await seed(state.controlPlane, "webinar", webinar);

    const server = createServer(createSfuApp({ state, config, getIo: () => null }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const response = await fetch(`http://127.0.0.1:${address.port}/scheduled-webinars/by-slug/launch`, {
      headers: { "x-sfu-secret": config.sfuSecret, "x-sfu-client": "evil" },
    });
    expect(response.status).toBe(200);
    expect((await state.controlPlane.read(webinarById("w1")))?.clientId).toBe("conclave");
  });
});
