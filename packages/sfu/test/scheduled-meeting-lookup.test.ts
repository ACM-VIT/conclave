import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerScheduledMeetingRoutes } from "../server/http/scheduledMeetingRoutes.js";
import {
  createScheduledMeeting,
  createScheduledMeetingStore,
  getScheduledMeetingById,
} from "../server/scheduledMeetings.js";
import type { SfuState } from "../server/state.js";

const SECRET = "test-secret-0123456789";
const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  vi.unstubAllEnvs();
});

async function bookingService() {
  const store = createScheduledMeetingStore();
  const meeting = createScheduledMeeting(
    store,
    { title: "Weekly sync", scheduledStartAt: Date.now() + 60_000, roomCode: "weekly-sync" },
    {
      clientId: "conclave",
      createdBy: "host@example.com",
      defaultHostEmail: "host@example.com",
      defaultHostUserId: null,
    },
  );
  const app = express();
  registerScheduledMeetingRoutes(app, {
    state: { scheduledMeetings: store } as unknown as SfuState,
    sfuSecret: SECRET,
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const lookUp = async (clientId: string) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/scheduled-meetings/public/by-room/weekly-sync?clientId=${clientId}`,
      { headers: { "x-sfu-secret": SECRET } },
    );
    return response.ok
      ? ((await response.json()) as { scheduledMeeting: { clientId: string } }).scheduledMeeting
      : null;
  };
  return { store, meeting, lookUp };
}

describe("looking a booking up by room code", () => {
  it("answers only for the tenant asked and never moves the booking", async () => {
    vi.stubEnv("SFU_CLIENT_ID", "acme");
    const { store, meeting, lookUp } = await bookingService();

    expect(await lookUp("acme")).toBeNull();
    expect(await lookUp("beta")).toBeNull();
    expect(getScheduledMeetingById(store, meeting.id)?.clientId).toBe("conclave");
    expect(await lookUp("conclave")).toMatchObject({ clientId: "conclave" });
    expect(await lookUp("default")).toMatchObject({ clientId: "conclave" });
  });
});
