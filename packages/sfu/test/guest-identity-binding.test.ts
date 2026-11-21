import { describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import type { Room } from "../config/classes/Room.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { createSfuState, type SfuState } from "../server/state.js";
import {
  getOrCreateWebinarRoomConfig,
  setCustomWebinarLinkSlug,
} from "../server/webinar.js";

type Handler = (...args: never[]) => void | Promise<void>;

const makeSocket = (id: string, user: SfuAuthPayload) => {
  const handlers = new Map<string, Handler>();
  const socket = {
    id,
    data: { user },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
    join: vi.fn(),
    leave: vi.fn(),
    to: () => ({ emit: vi.fn() }),
  } as unknown as Socket;
  return { socket, handlers };
};

const makeState = (): SfuState => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "guest-identity-test",
      instanceUrl: "http://localhost",
      ttlMs: 45000,
    }),
  });
  const router = {
    closed: false,
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close: vi.fn(),
  } as unknown as Router;
  state.workers = [
    { pid: 1, closed: false, createRouter: async () => router } as unknown as Worker,
  ];
  return state;
};

const io = { to: () => ({ emit: vi.fn() }) } as unknown as SocketIOServer;

let socketCount = 0;
const join = async (state: SfuState, user: SfuAuthPayload, roomId = "room") => {
  const peer = makeSocket(`socket-${++socketCount}`, user);
  const context = createConnectionContext(io, peer.socket, state);
  registerJoinRoomHandler(context);
  const ack = vi.fn();
  await peer.handlers.get("joinRoom")!(...[
    { roomId, sessionId: user.sessionId },
    ack,
  ] as never[]);
  return { context, peer, ack };
};

// The same socket asks for another room, as a client does when it switches.
const switchRoom = async (
  from: Awaited<ReturnType<typeof join>>,
  user: SfuAuthPayload,
  roomId: string,
) => {
  const ack = vi.fn();
  await from.peer.handlers.get("joinRoom")!(...[
    { roomId, sessionId: user.sessionId },
    ack,
  ] as never[]);
  return ack;
};

const dropConnection = (peer: { socket: Socket }) => {
  (peer.socket as { connected: boolean }).connected = false;
};

// What every other participant can read off the wire: the identity and
// session id, but never the pass proof.
const publicIdentity = (user: SfuAuthPayload): SfuAuthPayload => {
  const { guestProof: _proof, ...visible } = user;
  return visible;
};

const refused: unknown = expect.objectContaining({
  error: expect.any(String) as unknown,
});
const joined: unknown = expect.objectContaining({ status: "joined" });

const guestHost = {
  userId: "guest-gp_AAAAAAAAAAAAAAAAAAAAAA.tab-1",
  clientId: "conclave",
  sessionId: "tab-1",
  allowRoomCreation: true,
  guestProof: "proof-of-the-host-pass",
} satisfies SfuAuthPayload;
const guestHostSeat = `${guestHost.userId}#${guestHost.sessionId}`;

describe("guest host identity", () => {
  it.each([
    ["no pass", publicIdentity(guestHost)],
    ["another pass", { ...guestHost, guestProof: "proof-of-another-pass" }],
  ])("refuses a join that presents the host's public id with %s", async (_label, intruder) => {
    const state = makeState();
    const host = await join(state, guestHost);
    expect(host.context.currentClient).toBeInstanceOf(Admin);
    const room = state.rooms.get("conclave:room")!;

    const attempt = await join(state, intruder);

    expect(attempt.ack).toHaveBeenCalledWith(refused);
    expect(attempt.context.currentClient).toBeNull();
    expect(room.getClient(guestHostSeat)).toBe(host.context.currentClient);
    expect(room.getHostUserId()).toBe(guestHostSeat);
  });

  it("does not hand host to the public id after the host's seat is gone", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    await join(state, {
      userId: "guest-gp_BBBBBBBBBBBBBBBBBBBBBB.tab-2",
      clientId: "conclave",
      sessionId: "tab-2",
      guestProof: "proof-of-a-participant-pass",
    });
    room.removeClient(guestHostSeat);

    const attempt = await join(state, publicIdentity(guestHost));

    expect(attempt.ack).toHaveBeenCalledWith(refused);
    expect(attempt.context.currentClient).toBeNull();
    expect(room.getClient(guestHostSeat)).toBeUndefined();
  });

  it("restores the seat and host when the host reconnects with its pass", async () => {
    const state = makeState();
    const host = await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    dropConnection(host.peer);

    const back = await join(state, guestHost);

    expect(back.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "joined", hostUserId: guestHostSeat }),
    );
    expect(back.context.currentClient).toBeInstanceOf(Admin);
    expect(room.getClient(guestHostSeat)).toBe(back.context.currentClient);
  });

  it("restores host for the pass that created the room after its seat is gone", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    await join(state, {
      userId: "guest-gp_BBBBBBBBBBBBBBBBBBBBBB.tab-2",
      clientId: "conclave",
      sessionId: "tab-2",
      guestProof: "proof-of-a-participant-pass",
    });
    room.removeClient(guestHostSeat);

    const back = await join(state, guestHost);

    expect(back.ack).toHaveBeenCalledWith(joined);
    expect(back.context.currentClient).toBeInstanceOf(Admin);
    expect(room.getHostUserId()).toBe(guestHostSeat);
  });
});

describe("signed-in host identity", () => {
  it("restores the seat and host on reconnect without any guest pass", async () => {
    const signedIn = {
      email: "host@example.com",
      userId: "host@example.com",
      clientId: "conclave",
      sessionId: "s1",
      allowRoomCreation: true,
    } satisfies SfuAuthPayload;
    const state = makeState();
    const host = await join(state, signedIn);
    const room = state.rooms.get("conclave:room")!;
    dropConnection(host.peer);

    const back = await join(state, signedIn);

    expect(back.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "joined", hostUserId: "host@example.com#s1" }),
    );
    expect(back.context.currentClient).toBeInstanceOf(Admin);
    expect(room.getClient("host@example.com#s1")).toBe(back.context.currentClient);
  });
});

describe("webinar attendee seats", () => {
  const attendee = {
    userId: "guest-gp_CCCCCCCCCCCCCCCCCCCCCC.view-1",
    clientId: "conclave",
    sessionId: "view-1",
    joinMode: "webinar_attendee",
    guestProof: "proof-of-the-viewer-pass",
  } satisfies SfuAuthPayload;
  const attendeeSeat = `${attendee.userId}#${attendee.sessionId}`;

  // A live webinar whose single audience seat is taken.
  const setup = async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const config = getOrCreateWebinarRoomConfig(state.webinarConfigs, room.channelId);
    config.enabled = true;
    config.publicAccess = true;
    config.maxAttendees = 1;
    setCustomWebinarLinkSlug({
      webinarConfig: config,
      webinarLinks: state.webinarLinks,
      room: { channelId: room.channelId, id: room.id, clientId: room.clientId },
      slug: "launch",
    });
    const viewer = await join(state, attendee, "launch");
    expect(viewer.ack).toHaveBeenCalledWith(joined);
    return { state, room, viewer };
  };

  it("refuses to hand an attendee's seat to its public id", async () => {
    const { state, room, viewer } = await setup();

    const attempt = await join(state, publicIdentity(attendee), "launch");

    expect(attempt.ack).toHaveBeenCalledWith(refused);
    expect(attempt.context.currentClient).toBeNull();
    expect(room.getClient(attendeeSeat)).toBe(viewer.context.currentClient);
  });

  it("lets the attendee reclaim its seat with its pass while the webinar is full", async () => {
    const { state, room, viewer } = await setup();
    dropConnection(viewer.peer);

    const back = await join(state, attendee, "launch");

    expect(back.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "joined", webinarRole: "attendee" }),
    );
    expect(room.getClient(attendeeSeat)).toBe(back.context.currentClient);
    expect(room.getWebinarAttendeeCount()).toBe(1);
  });

  it("does not honor a stage invite for the invited id without its pass", async () => {
    const { state, room } = await setup();
    room.promoteWebinarUserKey(attendee.userId);
    const onStage = { ...attendee, joinMode: "meeting" };

    const attempt = await join(state, publicIdentity(onStage));
    expect(attempt.ack).toHaveBeenCalledWith(refused);
    expect(attempt.context.currentClient).toBeNull();

    const promoted = await join(state, onStage);
    expect(promoted.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "joined", webinarRole: "participant" }),
    );
  });
});

describe("waiting room admission", () => {
  it("admits the guest the host let in, not another holder of its public id", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    room.setLocked(true);
    const guest = {
      userId: "guest-gp_DDDDDDDDDDDDDDDDDDDDDD.tab-3",
      clientId: "conclave",
      sessionId: "tab-3",
      guestProof: "proof-of-the-admitted-pass",
    } satisfies SfuAuthPayload;
    const knock = await join(state, guest);
    expect(knock.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting" }));
    room.allowLockedUser(guest.userId);

    const attempt = await join(state, { ...publicIdentity(guest), sessionId: "tab-9" });
    expect(attempt.ack).toHaveBeenCalledWith(refused);
    expect(attempt.context.currentClient).toBeNull();

    const admitted = await join(state, guest);
    expect(admitted.ack).toHaveBeenCalledWith(joined);
  });
});

describe("blocking a guest", () => {
  const tab = (sessionId: string, guestProof: string, guestId: string) =>
    ({
      userId: `guest-gp_${guestId.repeat(22)}.${sessionId}`,
      clientId: "conclave",
      sessionId,
      guestProof,
    }) satisfies SfuAuthPayload;
  const notAllowed = { error: "You are not allowed to join this meeting." };

  it("keeps the blocked guest's other tabs out, and no one else", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const blockedTab = tab("tab-1", "proof-of-pass-e", "E");
    await join(state, blockedTab);
    room.blockUser(blockedTab.userId);
    room.removeClient(`${blockedTab.userId}#tab-1`);

    const sameTab = await join(state, blockedTab);
    const otherTab = await join(state, tab("tab-2", "proof-of-pass-e", "E"));
    const someoneElse = await join(state, tab("tab-1", "proof-of-pass-f", "F"));

    expect(sameTab.ack).toHaveBeenCalledWith(notAllowed);
    expect(otherTab.ack).toHaveBeenCalledWith(notAllowed);
    expect(someoneElse.ack).toHaveBeenCalledWith(joined);
  });

  it("lets every tab of the pass back in once the host unblocks it", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const blockedTab = tab("tab-1", "proof-of-pass-e", "E");
    await join(state, blockedTab);
    room.blockUser(blockedTab.userId);
    room.removeClient(`${blockedTab.userId}#tab-1`);
    room.unblockUser(blockedTab.userId);

    const otherTab = await join(state, tab("tab-2", "proof-of-pass-e", "E"));
    expect(otherTab.ack).toHaveBeenCalledWith(joined);
  });

  it("keeps the pass out while any of its tabs is still blocked", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const first = tab("tab-1", "proof-of-pass-e", "E");
    const second = tab("tab-2", "proof-of-pass-e", "E");
    await join(state, first);
    await join(state, second);
    room.blockUser(first.userId);
    room.blockUser(second.userId);
    room.removeClient(`${first.userId}#tab-1`);
    room.removeClient(`${second.userId}#tab-2`);
    room.unblockUser(first.userId);

    const third = await join(state, tab("tab-3", "proof-of-pass-e", "E"));
    expect(third.ack).toHaveBeenCalledWith(notAllowed);
  });
});

describe("guests on clients that predate guest passes", () => {
  const olderHost = {
    userId: "guest-1700000000000-abc123",
    clientId: "conclave",
    sessionId: "1700000000000-abc123",
    allowRoomCreation: true,
  } satisfies SfuAuthPayload;
  const olderHostSeat = `${olderHost.userId}#${olderHost.sessionId}`;

  it("are bound to their pass when they enter with one", async () => {
    const state = makeState();
    const host = await join(state, { ...olderHost, guestProof: "proof-of-the-older-pass" });
    const room = state.rooms.get("conclave:room")!;

    const replay = await join(state, olderHost);
    const replayWithOwnPass = await join(state, { ...olderHost, guestProof: "proof-of-another-pass" });

    expect(replay.ack).toHaveBeenCalledWith(refused);
    expect(replayWithOwnPass.ack).toHaveBeenCalledWith(refused);
    expect(room.getClient(olderHostSeat)).toBe(host.context.currentClient);
  });

  it.each([
    ["no pass", olderHost],
    ["another pass", { ...olderHost, guestProof: "proof-of-another-pass" }],
  ])(
    "keep host when a join with %s arrives while they are still leaving their previous room",
    async (_label, intruder) => {
      const state = makeState();
      const owner = { ...olderHost, guestProof: "proof-of-the-older-pass" };
      const host = await join(state, owner, "previous-room");
      let finishLeaving = () => {};
      vi.mocked(host.peer.socket.leave).mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishLeaving = resolve;
        }),
      );

      const switching = switchRoom(host, owner, "room");
      await vi.waitFor(() => expect(host.peer.socket.leave).toHaveBeenCalled());
      const attempt = await join(state, intruder);
      finishLeaving();
      const switched = await switching;

      const room = state.rooms.get("conclave:room")!;
      expect(switched).toHaveBeenCalledWith(
        expect.objectContaining({ status: "joined", hostUserId: olderHostSeat }),
      );
      expect(attempt.ack).toHaveBeenCalledWith(refused);
      expect(attempt.context.currentClient).toBeNull();
      expect(host.context.currentClient).toBeInstanceOf(Admin);
      expect(room.getClient(olderHostSeat)).toBe(host.context.currentClient);
    },
  );

  it("that entered without a pass can still come back, even after someone joined with one", async () => {
    const state = makeState();
    await join(state, olderHost);
    const room = state.rooms.get("conclave:room")!;

    const withPass = await join(state, { ...olderHost, guestProof: "proof-of-a-later-pass" });
    expect(withPass.ack).toHaveBeenCalledWith(joined);

    const original = await join(state, olderHost);
    expect(original.ack).toHaveBeenCalledWith(joined);
    expect(original.context.currentClient).toBeInstanceOf(Admin);
    expect(room.getClient(olderHostSeat)).toBe(original.context.currentClient);
  });
});

describe("a guest identity that holds nothing in the room", () => {
  const signedInHost = {
    email: "host@example.com",
    userId: "host@example.com",
    clientId: "conclave",
    sessionId: "s1",
    allowRoomCreation: true,
  } satisfies SfuAuthPayload;
  const guest = {
    userId: "guest-gp_HHHHHHHHHHHHHHHHHHHHHH.tab-1",
    clientId: "conclave",
    sessionId: "tab-1",
    guestProof: "proof-of-pass-h",
  } satisfies SfuAuthPayload;
  const guestSeat = `${guest.userId}#${guest.sessionId}`;

  // A guest that joined, got `retain` from the host, and left. The right it
  // was given outlives its seat, and so does the proof it is bound to.
  const departedGuestWith = async (retain: (room: Room) => void) => {
    const state = makeState();
    await join(state, signedInHost);
    const room = state.rooms.get("conclave:room")!;
    expect((await join(state, guest)).ack).toHaveBeenCalledWith(joined);
    retain(room);
    room.removeClient(guestSeat);
    expect(room.boundGuestIdentityCount).toBe(1);
    return room;
  };

  it.each<[string, (room: Room) => void, (room: Room) => void]>([
    [
      "the host locks the room again, which ends its admission",
      (room) => room.allowLockedUser(guest.userId),
      (room) => room.setLocked(true),
    ],
    [
      "the host revokes its admission past the lock",
      (room) => room.allowLockedUser(guest.userId),
      (room) => room.revokeLockedAllowedUser(guest.userId),
    ],
    [
      "the host revokes its waiting-room admission",
      (room) => room.allowUser(guest.userId),
      (room) => room.revokeAllowedUser(guest.userId),
    ],
    [
      "the host unblocks it",
      (room) => room.blockUser(guest.userId),
      (room) => room.unblockUser(guest.userId),
    ],
    [
      "the host withdraws its stage invite",
      (room) => room.promoteWebinarUserKey(guest.userId),
      (room) => room.revokeWebinarPromotion(guest.userId),
    ],
    [
      "newer stage invites push its invite out",
      (room) => room.promoteWebinarUserKey(guest.userId),
      (room) => {
        for (let invited = 0; invited < 200; invited += 1) {
          room.promoteWebinarUserKey(`invited-${invited}@example.com`);
        }
      },
    ],
  ])("is not kept once %s", async (_label, retain, lose) => {
    const room = await departedGuestWith(retain);

    lose(room);

    expect(room.boundGuestIdentityCount).toBe(0);
  });

  it("is not kept once its stage invite has expired", async () => {
    vi.useFakeTimers();
    try {
      const room = await departedGuestWith((live) =>
        live.promoteWebinarUserKey(guest.userId),
      );

      vi.advanceTimersByTime(5 * 60 * 60 * 1000);

      expect(room.isWebinarPromotedUserKey(guest.userId)).toBe(false);
      expect(room.boundGuestIdentityCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is kept for as long as it is still seated, whatever the host withdraws", async () => {
    const state = makeState();
    await join(state, signedInHost);
    const room = state.rooms.get("conclave:room")!;
    await join(state, guest);
    room.allowLockedUser(guest.userId);

    room.setLocked(true);
    room.revokeAllowedUser(guest.userId);
    room.unblockUser(guest.userId);
    room.revokeWebinarPromotion(guest.userId);

    const attempt = await join(state, publicIdentity(guest));
    expect(attempt.ack).toHaveBeenCalledWith(refused);
    expect(room.boundGuestIdentityCount).toBe(1);
  });

  it("is not kept after the guest leaves", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const visitor = {
      userId: "guest-gp_GGGGGGGGGGGGGGGGGGGGGG.tab-1",
      clientId: "conclave",
      sessionId: "tab-1",
      guestProof: "proof-of-pass-g",
    } satisfies SfuAuthPayload;
    await join(state, visitor);
    room.removeClient(`${visitor.userId}#tab-1`);

    const fresh = await join(state, { ...visitor, guestProof: "proof-of-pass-h" });
    expect(fresh.ack).toHaveBeenCalledWith(joined);
  });

  it("is still held while the guest waits to be let in", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    room.setLocked(true);
    const visitor = {
      userId: "guest-gp_GGGGGGGGGGGGGGGGGGGGGG.tab-1",
      clientId: "conclave",
      sessionId: "tab-1",
      guestProof: "proof-of-pass-g",
    } satisfies SfuAuthPayload;
    await join(state, visitor);

    const attempt = await join(state, { ...visitor, guestProof: "proof-of-pass-h" });
    expect(attempt.ack).toHaveBeenCalledWith(refused);
    expect(room.pendingClients.get(visitor.userId)?.socket.id).not.toBe(attempt.peer.socket.id);

    room.removePendingClient(visitor.userId);
    const later = await join(state, { ...visitor, guestProof: "proof-of-pass-h" });
    expect(later.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting" }));
  });
});
