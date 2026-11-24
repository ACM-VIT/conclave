import { createServer, type Server } from "node:http";
import type { Router } from "mediasoup/types";
import type { Socket } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import { createSfuApp } from "../server/http/createApp.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import {
  createScheduledMeeting,
  setScheduledInviteeReadmission,
} from "../server/scheduledMeetings.js";
import { createSfuState, type SfuState } from "../server/state.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const start = async (state: SfuState) => {
  const server = createServer(createSfuApp({ state, config }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
};

const occupancy = async (url: string, viewerKey?: string) => {
  const query = new URLSearchParams({ clientId: "conclave" });
  if (viewerKey) query.set("viewerKey", viewerKey);
  const response = await fetch(`${url}/rooms/abc-mnop-xyz?${query}`, {
    headers: { "x-sfu-secret": config.sfuSecret },
  });
  return response.json() as Promise<{
    room: { id: string; userCount: number } | null;
    viewerIsMember?: boolean;
  }>;
};

const setup = () => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "occupancy-test",
      instanceUrl: "http://localhost",
      ttlMs: 45000,
    }),
  });
  const room = new Room({
    id: "abc-mnop-xyz",
    clientId: "conclave",
    workerPid: null,
    router: {} as Router,
  });
  state.rooms.set(room.channelId, room);
  const seat = new Client({ id: "guest-in#s", socket: { id: "s" } as Socket });
  room.setUserIdentity(seat.id, "guest-in", "In");
  room.addClient(seat);
  room.grantHost("host@example.com", "fallback");
  room.makePrimaryHost("host@example.com");
  room.restoreAdmission("guest-admitted", undefined, { pastLock: true });
  return state;
};

describe("room occupancy for a viewer", () => {
  it("vouches only for people in, hosting or admitted to the room", async () => {
    const url = await start(setup());

    expect(await occupancy(url, "guest-in")).toMatchObject({
      room: { id: "abc-mnop-xyz", userCount: 1 },
      viewerIsMember: true,
    });
    expect((await occupancy(url, "host@example.com")).viewerIsMember).toBe(true);
    expect((await occupancy(url, "guest-admitted")).viewerIsMember).toBe(true);
    expect((await occupancy(url, "guest-stranger")).viewerIsMember).toBe(false);
  });

  it("does not vouch for anyone at a code with no room", async () => {
    const url = await start(setup());
    const response = await fetch(`${url}/rooms/nope-nope-nop?viewerKey=guest-in`, {
      headers: { "x-sfu-secret": config.sfuSecret },
    });
    expect(await response.json()).toEqual({ room: null, viewerIsMember: false });
  });

  describe("for someone invited to a scheduled meeting", () => {
    const scheduled = () => {
      const state = setup();
      createScheduledMeeting(
        state.scheduledMeetings,
        {
          title: "Intro call",
          scheduledStartAt: Date.now(),
          roomCode: "abc-mnop-xyz",
          hostEmail: "host@example.com",
          attendeeEmail: "invitee@example.com",
        },
        {
          clientId: "conclave",
          createdBy: "host@example.com",
          defaultHostEmail: "host@example.com",
          defaultHostUserId: null,
        },
      );
      return { state, room: state.rooms.get("conclave:abc-mnop-xyz")! };
    };

    it("vouches for them while the invitation stands", async () => {
      const { state } = scheduled();
      const url = await start(state);
      expect((await occupancy(url, "invitee@example.com")).viewerIsMember).toBe(true);
    });

    it("stops vouching once a host blocks them", async () => {
      const { state, room } = scheduled();
      room.blockUser("invitee@example.com");
      const url = await start(state);
      expect((await occupancy(url, "invitee@example.com")).viewerIsMember).toBe(false);
    });

    it("stops vouching once a host removes them", async () => {
      const { state, room } = scheduled();
      room.revokeLockedAllowedUser("invitee@example.com");
      const url = await start(state);
      expect((await occupancy(url, "invitee@example.com")).viewerIsMember).toBe(false);
    });

    it("does not vouch for a removed invitee while the meeting has no room", async () => {
      const { state } = scheduled();
      setScheduledInviteeReadmission(
        state.scheduledMeetings,
        "conclave",
        "abc-mnop-xyz",
        "invitee@example.com",
        true,
      );
      state.rooms.clear();
      const url = await start(state);
      expect(await occupancy(url, "invitee@example.com")).toEqual({
        room: null,
        viewerIsMember: false,
      });
    });
  });
});
