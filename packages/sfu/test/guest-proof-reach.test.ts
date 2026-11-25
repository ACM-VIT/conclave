import type { Router } from "mediasoup/types";
import type { Socket } from "socket.io";
import { describe, expect, it } from "vitest";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import { config } from "../config/config.js";
import { issueRoomRecoveryPass } from "../server/roomRecoveryPass.js";

const PASS = "proof-g";
const ROOM_TAB = "guest-gp_room-tab";
const OTHER_ROOM_TAB = "guest-gp_other-tab";
const OLD_APP = "guest-old-app";

const endOfTurn = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const makeRoom = () => {
  const room = new Room({
    id: "abc-mnop-xyz",
    clientId: "conclave",
    workerPid: null,
    router: {} as Router,
  });
  return room;
};

const seat = (room: Room, userKey: string, tab: string, guestProof?: string): Client => {
  const client = new Client({
    id: `${userKey}#${tab}`,
    socket: { id: tab, connected: true, emit: () => true } as unknown as Socket,
  });
  room.setUserIdentity(client.id, userKey, "Guest", { guestProof });
  room.addClient(client);
  return client;
};

const knock = (room: Room, userKey: string, tab: string, guestProof?: string): void => {
  room.addPendingClient(
    userKey,
    `${userKey}#${tab}`,
    { id: tab, connected: true, emit: () => true } as unknown as Socket,
    "Guest",
    guestProof,
  );
};

type Check = (room: Room, userKey: string) => boolean;

const rights: Array<{ right: string; give: (room: Room) => void; holds: Check }> = [
  {
    right: "the host's seat",
    give: (room) => {
      room.grantHost(ROOM_TAB, "fallback");
      room.makePrimaryHost(ROOM_TAB);
    },
    holds: (room, userKey) => room.isHostUserKey(userKey, PASS),
  },
  {
    right: "a host right",
    give: (room) => room.grantHost(ROOM_TAB, "promoted"),
    holds: (room, userKey) => room.isAdminUserKey(userKey, PASS),
  },
  {
    right: "a live host seat",
    give: (room) => room.grantHost(ROOM_TAB, "promoted"),
    holds: (room, userKey) => room.hasLiveHostSeat(userKey, PASS),
  },
  {
    right: "an admission past the lock",
    give: (room) => room.allowLockedUser(ROOM_TAB),
    holds: (room, userKey) => room.isLockedAllowed(userKey, PASS),
  },
  {
    right: "an admission past the waiting room",
    give: (room) => room.admitUserKeys([{ userKey: ROOM_TAB, scopes: ["waitingRoom"] }]),
    holds: (room, userKey) => room.isAllowed(userKey, PASS),
  },
  {
    right: "a stage invite",
    give: (room) => room.promoteWebinarUserKey(ROOM_TAB),
    holds: (room, userKey) => room.hasStageInvite(userKey, PASS),
  },
  {
    right: "a view of the headcount",
    give: () => undefined,
    holds: (room, userKey) => room.isMemberUserKey(userKey, PASS),
  },
];

const removals: Array<{ removal: string; make: (room: Room, userKey: string) => void; holds: Check }> = [
  {
    removal: "a block",
    make: (room, userKey) => room.blockUser(userKey),
    holds: (room, userKey) => room.isBlocked(userKey, PASS),
  },
  {
    removal: "a removal",
    make: (room, userKey) => room.removeUser(userKey),
    holds: (room, userKey) => room.needsReadmission(userKey, PASS),
  },
  {
    removal: "an admission taken back",
    make: (room, userKey) => room.revokeAllowedUser(userKey),
    holds: (room, userKey) => room.needsReadmission(userKey, PASS),
  },
  {
    removal: "a move back to the audience",
    make: (room, userKey) => room.markWebinarDemotedUserKey(userKey),
    holds: (room, userKey) => room.isWebinarDemotedUserKey(userKey, PASS),
  },
];

describe("how far a guest's proof reaches", () => {
  describe.each(rights)("$right", ({ give, holds }) => {
    it("reaches the guest's other tabs, whose keys were issued from the pass for this room", () => {
      const room = makeRoom();
      seat(room, ROOM_TAB, "t1", PASS);
      give(room);
      expect(holds(room, OTHER_ROOM_TAB)).toBe(true);
    });

    it("never reaches an old app's own key, whatever pass its token shows", () => {
      const room = makeRoom();
      seat(room, ROOM_TAB, "t1", PASS);
      knock(room, OLD_APP, "t2", PASS);
      give(room);
      expect(holds(room, OLD_APP)).toBe(false);
    });
  });

  describe.each(removals)("$removal", ({ make, holds }) => {
    it("reaches an old app's key that shows the guest's pass", () => {
      const room = makeRoom();
      seat(room, ROOM_TAB, "t1", PASS);
      make(room, ROOM_TAB);
      expect(holds(room, OLD_APP)).toBe(true);
    });

    it("of an old app's key reaches the guest's tabs under the pass it showed", () => {
      const room = makeRoom();
      seat(room, OLD_APP, "t2", PASS);
      make(room, OLD_APP);
      expect(holds(room, OTHER_ROOM_TAB)).toBe(true);
    });
  });

  it("gives no recovery pass to an old app whose pass had its admission taken back", () => {
    const room = makeRoom();
    const tab = seat(room, ROOM_TAB, "t1", PASS);
    room.revokeAllowedUser(ROOM_TAB);
    room.removeClient(tab.id);
    const oldApp = seat(room, OLD_APP, "t2", PASS);
    expect(room.recordsItsCall).toBe(true);
    expect(issueRoomRecoveryPass(room, oldApp, config.sfuSecret)).toBeNull();
  });

  it("binds a key issued from a pass to its pass when it comes back, even if it held something first", () => {
    const room = makeRoom();
    room.requireReadmission(ROOM_TAB);
    expect(room.claimGuestIdentity(ROOM_TAB, PASS)).toEqual({ ok: true, bindTo: PASS });
    expect(room.claimGuestIdentity(OLD_APP, undefined)).toEqual({ ok: true, bindTo: undefined });
  });

  it("lets go of the pass of a key once an admission lifts the last thing it held", async () => {
    const room = makeRoom();
    const tab = seat(room, ROOM_TAB, "t1", PASS);
    room.blockUser(ROOM_TAB);
    room.removeClient(tab.id);
    await endOfTurn();
    expect(room.guestProofOf(ROOM_TAB)).toBe(PASS);
    knock(room, OTHER_ROOM_TAB, "t3", PASS);
    room.admitUserKeys([{ userKey: OTHER_ROOM_TAB, scopes: ["waitingRoom", "lock"] }]);
    await endOfTurn();
    expect(room.isBlocked(ROOM_TAB, PASS)).toBe(false);
    expect(room.guestProofOf(ROOM_TAB)).toBeUndefined();
  });

  it("lets go of the passes of a lost call's hosts and removed guests once its window ends", async () => {
    const room = makeRoom();
    room.awaitingOpener = { lost: null };
    room.restoreLostCall({
      hostUserKey: ROOM_TAB,
      adminUserKeys: [ROOM_TAB],
      coHostUserKeys: [],
      readmissionRequiredUserKeys: [OTHER_ROOM_TAB],
      guestPasses: { [ROOM_TAB]: [PASS], [OTHER_ROOM_TAB]: ["proof-other"] },
      claimableUntil: Date.now() + 60_000,
      passGeneration: null,
    });
    expect(room.boundGuestIdentityCount).toBe(2);
    room.endLostCall();
    await endOfTurn();
    expect(room.boundGuestIdentityCount).toBe(0);
  });
});
