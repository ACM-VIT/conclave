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
  const leave = vi.fn();
  const emit = vi.fn();
  const socket = {
    id,
    data: { user },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit,
    disconnect: vi.fn(),
    connected: true,
    join: vi.fn(),
    leave,
    to: () => ({ emit: vi.fn() }),
  } as unknown as Socket;
  return { socket, handlers, leave, emit };
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
const join = async (
  state: SfuState,
  user: SfuAuthPayload,
  roomId = "room",
  payload: Record<string, unknown> = {},
) => {
  const peer = makeSocket(`socket-${++socketCount}`, user);
  const context = createConnectionContext(io, peer.socket, state);
  registerJoinRoomHandler(context);
  const ack = vi.fn();
  await peer.handlers.get("joinRoom")!(...[
    { roomId, sessionId: user.sessionId, ...payload },
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

// The room drops a proof at the end of the turn in which its user key lost
// its last right, so a check for that waits one tick.
const endOfTurn = () => Promise.resolve();

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

describe("a stage invite for a guest whose key differs between the audience and the stage", () => {
  const audience = {
    userId: "guest-gp_KKKKKKKKKKKKKKKKKKKKKK",
    clientId: "conclave",
    sessionId: "view-1",
    joinMode: "webinar_attendee",
    guestProof: "proof-of-the-viewer-pass",
  } satisfies SfuAuthPayload;
  // The same browser tab asking for the room itself: another seat key, the
  // same pass.
  const onStage = {
    ...audience,
    userId: "guest-gp_LLLLLLLLLLLLLLLLLLLLLL",
    joinMode: "meeting",
    guestRoom: "room",
  } satisfies SfuAuthPayload;

  // A locked webinar: only the host's invite gets anyone past the lock.
  const invited = async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const config = getOrCreateWebinarRoomConfig(state.webinarConfigs, room.channelId);
    config.enabled = true;
    config.publicAccess = true;
    setCustomWebinarLinkSlug({
      webinarConfig: config,
      webinarLinks: state.webinarLinks,
      room: { channelId: room.channelId, id: room.id, clientId: room.clientId },
      slug: "launch",
    });
    expect((await join(state, audience, "launch")).ack).toHaveBeenCalledWith(joined);
    room.setLocked(true);
    room.promoteWebinarUserKey(audience.userId);
    return { state, room };
  };

  it("lets the invited guest onto the stage under its other key", async () => {
    const { state, room } = await invited();

    const promoted = await join(state, onStage);

    expect(promoted.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "joined", webinarRole: "participant" }),
    );
    expect(room.isWebinarPromotedUserKey(onStage.userId)).toBe(true);
    expect(room.isWebinarPromotedUserKey(audience.userId)).toBe(false);
  });

  it.each([
    ["no pass", {}],
    ["another pass", { guestProof: "proof-of-another-pass" }],
  ])("does not let a join with %s use the invite", async (_label, intruderPass) => {
    const { state, room } = await invited();

    const attempt = await join(state, {
      ...publicIdentity(onStage),
      userId: "guest-gp_MMMMMMMMMMMMMMMMMMMMMM",
      ...intruderPass,
    });

    expect(attempt.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "waiting" }),
    );
    expect(room.isWebinarPromotedUserKey(audience.userId)).toBe(true);
  });

  it("lets a guest the host moved back to the audience take a fresh invite", async () => {
    const { state, room } = await invited();
    await join(state, onStage);
    // What the host's "move to audience" does to a speaker.
    room.revokeWebinarPromotion(onStage.userId);
    room.markWebinarDemotedUserKey(onStage.userId);
    room.removeClient(`${onStage.userId}#view-1`);
    expect((await join(state, onStage)).ack).toHaveBeenCalledWith(refused);

    room.promoteWebinarUserKey(audience.userId);
    const back = await join(state, onStage);

    expect(back.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "joined", webinarRole: "participant" }),
    );
  });

  it("does not hand the invite to a token that was not issued for this room", async () => {
    const { state, room } = await invited();
    const { guestRoom: _room, ...anyRoomToken } = onStage;

    const attempt = await join(state, anyRoomToken);

    expect(attempt.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "waiting" }),
    );
    expect(room.isWebinarPromotedUserKey(audience.userId)).toBe(true);
  });

  it("keeps the invited guest bound to its pass once it is on the stage", async () => {
    const { state } = await invited();
    await join(state, onStage);

    const attempt = await join(state, publicIdentity(onStage));

    expect(attempt.ack).toHaveBeenCalledWith(refused);
    expect(attempt.context.currentClient).toBeNull();
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

  it("removes every seated tab of the blocked guest's pass, and no one else", async () => {
    const state = makeState();
    const host = await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const first = tab("tab-1", "proof-of-pass-e", "E");
    const second = tab("tab-2", "proof-of-pass-e", "E");
    const someoneElse = tab("tab-1", "proof-of-pass-f", "F");
    await join(state, first);
    const sibling = await join(state, second);
    await join(state, someoneElse);

    const blocked = vi.fn();
    await host.peer.handlers.get("admin:blockUsers")!(...[
      { userKeys: [first.userId] },
      blocked,
    ] as never[]);

    expect(blocked).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        kickedUserIds: expect.arrayContaining([
          `${first.userId}#tab-1`,
          `${second.userId}#tab-2`,
        ]) as unknown,
      }),
    );
    expect(room.getClient(`${first.userId}#tab-1`)).toBeUndefined();
    expect(room.getClient(`${second.userId}#tab-2`)).toBeUndefined();
    expect(sibling.peer.emit).toHaveBeenCalledWith(
      "kicked",
      expect.objectContaining({ roomId: "room" }),
    );
    expect(room.getClient(`${someoneElse.userId}#tab-1`)).toBeDefined();
    expect(room.getClient(guestHostSeat)).toBeDefined();
  });

  it("sends away a tab of the blocked guest's pass that is waiting to be let in", async () => {
    const state = makeState();
    const host = await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const first = tab("tab-1", "proof-of-pass-e", "E");
    const second = tab("tab-2", "proof-of-pass-e", "E");
    await join(state, first);
    room.setLocked(true);
    const waiting = await join(state, second);
    expect(waiting.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "waiting" }),
    );

    await host.peer.handlers.get("admin:blockUsers")!(...[
      { userKeys: [first.userId] },
      vi.fn(),
    ] as never[]);

    expect(room.pendingClients.has(second.userId)).toBe(false);
    expect(waiting.peer.emit).toHaveBeenCalledWith(
      "joinRejected",
      expect.objectContaining({ roomId: "room" }),
    );
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
      host.peer.leave.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishLeaving = resolve;
        }),
      );

      const switching = switchRoom(host, owner, "room");
      await vi.waitFor(() => expect(host.peer.leave).toHaveBeenCalled());
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

  it.each([
    ["no pass", {}],
    ["another pass", { guestProof: "proof-of-another-pass" }],
  ])(
    "keep the admission the host gives back with an unblock, from a browser with %s",
    async (_label, intruderPass) => {
      const state = makeState();
      const host = await join(state, guestHost);
      const room = state.rooms.get("conclave:room")!;
      const older = {
        userId: "guest-1700000000001-def456",
        clientId: "conclave",
        sessionId: "1700000000001-def456",
        guestProof: "proof-of-the-older-pass",
      } satisfies SfuAuthPayload;
      await join(state, older);
      room.blockUser(older.userId);
      room.removeClient(`${older.userId}#${older.sessionId}`);
      room.setLocked(true);

      const allowed = vi.fn();
      await host.peer.handlers.get("admin:allowUsers")!(...[
        { userKeys: [older.userId] },
        allowed,
      ] as never[]);
      expect(allowed).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );

      const attempt = await join(state, {
        ...publicIdentity(older),
        ...intruderPass,
      });
      expect(attempt.ack).toHaveBeenCalledWith(refused);
      expect(attempt.context.currentClient).toBeNull();

      const back = await join(state, older);
      expect(back.ack).toHaveBeenCalledWith(joined);
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

describe("a host action that names a guest the room does not know", () => {
  const older = {
    userId: "guest-1700000000002-ghi789",
    clientId: "conclave",
    sessionId: "1700000000002-ghi789",
    guestProof: "proof-of-the-older-pass",
  } satisfies SfuAuthPayload;
  const olderSeat = `${older.userId}#${older.sessionId}`;
  const waiting: unknown = expect.objectContaining({ status: "waiting" });

  const allowUsers = async (
    host: Awaited<ReturnType<typeof join>>,
    userKeys: string[],
  ) => {
    const ack = vi.fn();
    await host.peer.handlers.get("admin:allowUsers")!(...[
      { userKeys },
      ack,
    ] as never[]);
    return ack;
  };

  // A locked meeting that a guest on an older client joined and left. The
  // room has dropped its proof by the time the host acts.
  const lockedRoomTheGuestLeft = async () => {
    const state = makeState();
    const host = await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    await join(state, older);
    room.removeClient(olderSeat);
    await endOfTurn();
    room.setLocked(true);
    return { state, host, room };
  };

  it.each([
    ["no pass", {}],
    ["another pass", { guestProof: "proof-of-another-pass" }],
  ])(
    "does not admit the guest's public key for a browser with %s to use",
    async (_label, intruderPass) => {
      const { state, host, room } = await lockedRoomTheGuestLeft();

      const allowed = await allowUsers(host, [older.userId]);

      expect(allowed).toHaveBeenCalledWith(
        expect.objectContaining({ allowed: [], refused: [older.userId] }),
      );
      expect(room.isAllowed(older.userId)).toBe(false);
      expect(room.isLockedAllowed(older.userId)).toBe(false);
      const attempt = await join(state, {
        ...publicIdentity(older),
        ...intruderPass,
      });
      expect(attempt.ack).toHaveBeenCalledWith(waiting);
    },
  );

  it("admits that guest from its waiting entry, bound to the pass it knocked with", async () => {
    const { state, host } = await lockedRoomTheGuestLeft();
    await allowUsers(host, [older.userId]);
    expect((await join(state, older)).ack).toHaveBeenCalledWith(waiting);

    const allowed = await allowUsers(host, [older.userId]);

    expect(allowed).toHaveBeenCalledWith(
      expect.objectContaining({ allowed: [older.userId], refused: [] }),
    );
    const intruder = await join(state, publicIdentity(older));
    expect(intruder.ack).toHaveBeenCalledWith(refused);
    expect((await join(state, older)).ack).toHaveBeenCalledWith(joined);
  });

  it.each(["alex@example.com", "guest-relations@example.com"])(
    "still admits the account %s ahead of time",
    async (email) => {
      const { state, host } = await lockedRoomTheGuestLeft();

      const allowed = await allowUsers(host, [email]);

      expect(allowed).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, allowed: [email], refused: [] }),
      );
      const account = await join(state, {
        email,
        userId: email,
        clientId: "conclave",
        sessionId: "s2",
      });
      expect(account.ack).toHaveBeenCalledWith(joined);
    },
  );

  it("answers with a failure when it could admit none of the keys", async () => {
    const { host } = await lockedRoomTheGuestLeft();

    const allowed = await allowUsers(host, [older.userId]);

    expect(allowed).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.any(String) as unknown,
        allowed: [],
        refused: [older.userId],
      }),
    );
  });

  it("answers with a success that names what it refused when it admitted some", async () => {
    const { host } = await lockedRoomTheGuestLeft();

    const allowed = await allowUsers(host, [older.userId, "alex@example.com"]);

    expect(allowed).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        allowed: ["alex@example.com"],
        refused: [older.userId],
      }),
    );
  });

  it("leaves a block in place when it cannot admit the blocked guest", async () => {
    const state = makeState();
    const host = await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const withoutPass = publicIdentity(older);
    await join(state, withoutPass);
    room.blockUser(older.userId);
    room.removeClient(olderSeat);
    await endOfTurn();

    const allowed = await allowUsers(host, [older.userId]);

    expect(allowed).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, refused: [older.userId] }),
    );
    expect(room.isBlocked(older.userId)).toBe(true);
    expect(room.isAllowed(older.userId)).toBe(false);
  });

  it("still admits a guest that is in the room without a pass", async () => {
    const state = makeState();
    const host = await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    await join(state, publicIdentity(older));

    const allowed = await allowUsers(host, [older.userId]);

    expect(allowed).toHaveBeenCalledWith(
      expect.objectContaining({ allowed: [older.userId], refused: [] }),
    );
    expect(room.isAllowed(older.userId)).toBe(true);
  });
});

describe("a guest join token issued for one room", () => {
  const scoped = {
    userId: "guest-gp_RRRRRRRRRRRRRRRRRRRRRR",
    clientId: "conclave",
    sessionId: "tab-1",
    guestProof: "proof-of-pass-r",
    guestRoom: "room",
    allowRoomCreation: true,
  } satisfies SfuAuthPayload;

  it("joins that room", async () => {
    const state = makeState();
    expect((await join(state, scoped)).ack).toHaveBeenCalledWith(joined);
  });

  it("is refused in any other room, and creates none", async () => {
    const state = makeState();
    await join(state, scoped);

    const elsewhere = await join(state, scoped, "other-room");

    expect(elsewhere.ack).toHaveBeenCalledWith(refused);
    expect(elsewhere.context.currentClient).toBeNull();
    expect(state.rooms.has("conclave:other-room")).toBe(false);
  });

  it("cannot be moved to another room on the socket it joined with", async () => {
    const state = makeState();
    const seated = await join(state, scoped);

    const moved = await switchRoom(seated, scoped, "other-room");

    expect(moved).toHaveBeenCalledWith(refused);
    expect(state.rooms.has("conclave:other-room")).toBe(false);
  });

  it("is not needed from a client that predates guest passes", async () => {
    const state = makeState();
    const { guestRoom: _room, ...older } = { ...scoped, userId: "guest-tab-1" };

    expect((await join(state, older, "any-room")).ack).toHaveBeenCalledWith(joined);
  });
});

describe("a guest whose pass changed between two joins from one tab", () => {
  // The join route issues this when a tab that held `guestHost`'s seat comes
  // back under the browser's other pass and still has its previous token.
  const successor = {
    userId: "guest-gp_SSSSSSSSSSSSSSSSSSSSSS",
    clientId: "conclave",
    sessionId: guestHost.sessionId,
    guestProof: "proof-of-the-cookie-pass",
    guestRoom: "room",
    guestWas: { userKey: guestHost.userId, guestProof: guestHost.guestProof },
  } satisfies SfuAuthPayload;
  const successorSeat = `${successor.userId}#${successor.sessionId}`;

  it("keeps host under its new key", async () => {
    const state = makeState();
    const before = await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    dropConnection(before.peer);

    const after = await join(state, successor);

    expect(after.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "joined", hostUserId: successorSeat }),
    );
    expect(after.context.currentClient).toBeInstanceOf(Admin);
    expect(room.getClient(guestHostSeat)).toBeUndefined();
  });

  it("keeps an admission past the lock under its new key", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const guest = {
      userId: "guest-gp_TTTTTTTTTTTTTTTTTTTTTT",
      clientId: "conclave",
      sessionId: "tab-7",
      guestProof: "proof-of-pass-t",
    } satisfies SfuAuthPayload;
    await join(state, guest);
    room.setLocked(true);
    room.allowLockedUser(guest.userId);
    room.removeClient(`${guest.userId}#tab-7`);

    const back = await join(state, {
      ...guest,
      userId: "guest-gp_UUUUUUUUUUUUUUUUUUUUUU",
      guestProof: "proof-of-the-cookie-pass",
      guestRoom: "room",
      guestWas: { userKey: guest.userId, guestProof: guest.guestProof },
    });

    expect(back.ack).toHaveBeenCalledWith(joined);
  });

  it.each([
    ["names a key whose proof it does not have", { userKey: guestHost.userId, guestProof: "a-guess" }],
    ["names no proof", { userKey: guestHost.userId }],
  ])("gets nothing when it %s", async (_label, guestWas) => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;

    const attempt = await join(state, { ...successor, guestWas });

    expect(attempt.context.currentClient).not.toBeInstanceOf(Admin);
    expect(room.getHostUserId()).toBe(guestHostSeat);
  });

  it("gets nothing from a token that was not issued for this room", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const { guestRoom: _room, ...anyRoomToken } = successor;

    const attempt = await join(state, anyRoomToken);

    expect(attempt.context.currentClient).not.toBeInstanceOf(Admin);
    expect(room.getHostUserId()).toBe(guestHostSeat);
  });

  it("is still blocked when the key it comes from is blocked", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const guest = {
      userId: "guest-gp_TTTTTTTTTTTTTTTTTTTTTT",
      clientId: "conclave",
      sessionId: "tab-7",
      guestProof: "proof-of-pass-t",
    } satisfies SfuAuthPayload;
    await join(state, guest);
    room.blockUser(guest.userId);
    room.removeClient(`${guest.userId}#tab-7`);

    const back = await join(state, {
      ...guest,
      userId: "guest-gp_UUUUUUUUUUUUUUUUUUUUUU",
      guestProof: "proof-of-the-cookie-pass",
      guestRoom: "room",
      guestWas: { userKey: guest.userId, guestProof: guest.guestProof },
    });

    expect(back.ack).toHaveBeenCalledWith({
      error: "You are not allowed to join this meeting.",
    });
  });
});

describe("what the lobby work needs from the room", () => {
  const agent = {
    userId: "guest-agent-session-1",
    clientId: "conclave",
    sessionId: "agent-session-1",
  } satisfies SfuAuthPayload;
  const waiting: unknown = expect.objectContaining({ status: "waiting" });

  const lockedRoom = async () => {
    const state = makeState();
    const host = await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    room.setLocked(true);
    return { state, host, room };
  };
  const createAdmission = async (host: Awaited<ReturnType<typeof join>>) => {
    const ack = vi.fn();
    await host.peer.handlers.get("admin:createAdmission")!(...[{}, ack] as never[]);
    return (ack.mock.calls[0]?.[0] ?? {}) as { success?: boolean; admissionCode?: string };
  };

  it("admits a join that presents an admission the host created, and keeps it admitted", async () => {
    const { state, host, room } = await lockedRoom();
    const { success, admissionCode } = await createAdmission(host);
    expect(success).toBe(true);

    const first = await join(state, agent, "room", { admissionCode });
    expect(first.ack).toHaveBeenCalledWith(joined);

    room.removeClient(`${agent.userId}#${agent.sessionId}`);
    expect((await join(state, agent)).ack).toHaveBeenCalledWith(joined);
  });

  it("admits one join per admission", async () => {
    const { state, host } = await lockedRoom();
    const { admissionCode } = await createAdmission(host);
    await join(state, agent, "room", { admissionCode });

    const second = await join(
      state,
      { ...agent, userId: "guest-someone-else", sessionId: "someone-else" },
      "room",
      { admissionCode },
    );

    expect(second.ack).toHaveBeenCalledWith(waiting);
  });

  it("makes a join without an admission wait, or with one that was never issued", async () => {
    const { state } = await lockedRoom();

    expect((await join(state, agent)).ack).toHaveBeenCalledWith(waiting);
    expect(
      (await join(state, agent, "room", { admissionCode: "not-issued" })).ack,
    ).toHaveBeenCalledWith(waiting);
  });

  it("restores a persisted admission for the guest that proves the pass it was given to", async () => {
    // A room recreated after a restart has no record of the guest.
    const { state, room } = await lockedRoom();
    const guest = {
      userId: "guest-gp_VVVVVVVVVVVVVVVVVVVVVV",
      clientId: "conclave",
      sessionId: "tab-9",
      guestProof: "proof-of-pass-v",
    } satisfies SfuAuthPayload;

    expect(room.restoreAdmission(guest.userId, guest.guestProof, { pastLock: true })).toBe(true);

    const intruder = await join(state, { ...guest, guestProof: "proof-of-another-pass" });
    expect(intruder.ack).toHaveBeenCalledWith(refused);
    expect((await join(state, guest)).ack).toHaveBeenCalledWith(joined);
  });

  it("does not restore an admission for a guest that is blocked", async () => {
    const { state, room } = await lockedRoom();
    const guest = {
      userId: "guest-gp_VVVVVVVVVVVVVVVVVVVVVV",
      clientId: "conclave",
      sessionId: "tab-9",
      guestProof: "proof-of-pass-v",
    } satisfies SfuAuthPayload;
    room.setLocked(false);
    await join(state, guest);
    room.blockUser(guest.userId);
    room.removeClient(`${guest.userId}#tab-9`);

    expect(room.restoreAdmission(guest.userId, guest.guestProof)).toBe(false);
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
    await endOfTurn();
    expect(room.boundGuestIdentityCount).toBe(1);
    return { state, room };
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
    const { room } = await departedGuestWith(retain);

    lose(room);
    await endOfTurn();

    expect(room.boundGuestIdentityCount).toBe(0);
  });

  it("stays bound while one host action swaps its last right for another", async () => {
    const { state, room } = await departedGuestWith((live) =>
      live.blockUser(guest.userId),
    );

    room.unblockUser(guest.userId);
    room.allowUser(guest.userId);
    await endOfTurn();

    expect(room.boundGuestIdentityCount).toBe(1);
    const attempt = await join(state, publicIdentity(guest));
    expect(attempt.ack).toHaveBeenCalledWith(refused);
  });

  it("stays bound when its stage invite is renewed as the oldest of a full list", async () => {
    const { room } = await departedGuestWith((live) =>
      live.promoteWebinarUserKey(guest.userId),
    );
    for (let invited = 0; invited < 199; invited += 1) {
      room.promoteWebinarUserKey(`invited-${invited}@example.com`);
    }

    room.promoteWebinarUserKey(guest.userId);
    await endOfTurn();

    expect(room.isWebinarPromotedUserKey(guest.userId)).toBe(true);
    expect(room.boundGuestIdentityCount).toBe(1);
  });

  it("is not kept once its stage invite has expired", async () => {
    vi.useFakeTimers();
    try {
      const { room } = await departedGuestWith((live) =>
        live.promoteWebinarUserKey(guest.userId),
      );

      vi.advanceTimersByTime(5 * 60 * 60 * 1000);

      expect(room.isWebinarPromotedUserKey(guest.userId)).toBe(false);
      await endOfTurn();
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
