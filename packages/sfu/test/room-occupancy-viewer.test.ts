import { createServer, type Server } from "node:http";
import type { Router } from "mediasoup/types";
import type { Socket } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import { createSfuApp } from "../server/http/createApp.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createMeeting, meetingByRoomCode } from "../server/controlPlane/meetingCommands.js";
import { updateRoomInvitation } from "../server/controlPlane/inviteeCommands.js";
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

const occupancy = async (url: string, viewerKey?: string, viewerProofs: string[] = []) => {
  const query = new URLSearchParams({ clientId: "conclave" });
  if (viewerKey) query.set("viewerKey", viewerKey);
  for (const proof of viewerProofs) query.append("viewerProof", proof);
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
  const seat = new Client({ id: "guest-in#s", socket: { id: "s", emit: () => true } as unknown as Socket });
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

  describe("for a guest with a pass, who has one key per tab", () => {
    const seatGuest = (state: SfuState) => {
      const room = state.rooms.get("conclave:abc-mnop-xyz")!;
      const seat = new Client({
        id: "guest-gp_first-tab#t1",
        socket: { id: "t1", emit: () => true } as unknown as Socket,
      });
      room.setUserIdentity(seat.id, "guest-gp_first-tab", "Guest", { guestProof: "proof-g" });
      room.addClient(seat);
      return room;
    };

    it("vouches for the guest's reloaded tab, which asks under the pass", async () => {
      const state = setup();
      seatGuest(state);
      const url = await start(state);
      expect((await occupancy(url, "guest-tab-2", ["proof-g"])).viewerIsMember).toBe(true);
      expect((await occupancy(url, undefined, ["proof-g"])).viewerIsMember).toBe(true);
      expect((await occupancy(url, undefined, ["proof-other"])).viewerIsMember).toBe(false);
      expect((await occupancy(url, "guest-tab-2")).viewerIsMember).toBe(false);
    });

    it("stops vouching for every tab of the guest once a host removes one", async () => {
      const state = setup();
      const room = seatGuest(state);
      room.removeUser("guest-gp_first-tab");
      const url = await start(state);
      expect((await occupancy(url, undefined, ["proof-g"])).viewerIsMember).toBe(false);
    });

    it("weighs a block under every pass the web sends, however many it sends", async () => {
      const state = setup();
      const room = seatGuest(state);
      const blocked = new Client({
        id: "guest-gp_blocked-tab#t9",
        socket: { id: "t9", emit: () => true } as unknown as Socket,
      });
      room.setUserIdentity(blocked.id, "guest-gp_blocked-tab", "Guest", {
        guestProof: "proof-blocked",
      });
      room.addClient(blocked);
      room.blockUser("guest-gp_blocked-tab");
      const url = await start(state);
      const unknown = Array.from({ length: 14 }, (_, index) => `proof-unknown-${index}`);
      expect((await occupancy(url, undefined, ["proof-g", ...unknown])).viewerIsMember).toBe(true);
      expect(
        (await occupancy(url, undefined, ["proof-g", ...unknown, "proof-blocked"])).viewerIsMember,
      ).toBe(false);
      expect(
        (await occupancy(url, undefined, ["proof-g", ...unknown.slice(0, 8), "proof-blocked"]))
          .viewerIsMember,
      ).toBe(false);
      expect(
        (await occupancy(url, undefined, ["proof-g", ...unknown, "proof-more", "proof-blocked"]))
          .viewerIsMember,
      ).toBe(false);
    });

    it("does not vouch for an old app's own key through the guest's pass", async () => {
      const state = setup();
      seatGuest(state);
      const url = await start(state);
      expect((await occupancy(url, "guest-old-app", ["proof-g"])).viewerIsMember).toBe(true);
      expect((await occupancy(url, "guest-old-app")).viewerIsMember).toBe(false);
    });
  });

  describe("for someone invited to a scheduled meeting", () => {
    const scheduled = async () => {
      const state = setup();
      await state.controlPlane.commit(createMeeting(
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
      ));
      return { state, room: state.rooms.get("conclave:abc-mnop-xyz")! };
    };

    it("vouches for them while the invitation stands", async () => {
      const { state } = await scheduled();
      const url = await start(state);
      expect((await occupancy(url, "invitee@example.com")).viewerIsMember).toBe(true);
    });

    it("stops vouching once a host blocks them", async () => {
      const { state, room } = await scheduled();
      room.blockUser("invitee@example.com");
      const url = await start(state);
      expect((await occupancy(url, "invitee@example.com")).viewerIsMember).toBe(false);
    });

    it("stops vouching once a host removes them", async () => {
      const { state, room } = await scheduled();
      room.revokeLockedAllowedUser("invitee@example.com");
      const url = await start(state);
      expect((await occupancy(url, "invitee@example.com")).viewerIsMember).toBe(false);
    });

    it("does not vouch for a removed invitee while the meeting has no room", async () => {
      const { state } = await scheduled();
      const meeting = await state.controlPlane.read(meetingByRoomCode("conclave", "abc-mnop-xyz"));
      expect(meeting).not.toBeNull();
      expect(await state.controlPlane.commit(updateRoomInvitation(meeting!, {
        kind: "decide", email: "invitee@example.com", removed: true, at: Date.now(),
      }))).toMatchObject({ ok: true });
      state.rooms.clear();
      const url = await start(state);
      expect(await occupancy(url, "invitee@example.com")).toEqual({
        room: null,
        viewerIsMember: false,
      });
    });
  });
});
