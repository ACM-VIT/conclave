import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import {
  blockUserKey,
  toPendingUserSnapshots,
  withdrawWaitingRequest,
} from "../server/admin/controlPlane.js";
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

// What the room is told. `socket.to(...)` goes elsewhere: this is `io.to(...)`.
const broadcast = vi.fn();
const io = { to: () => ({ emit: broadcast }) } as unknown as SocketIOServer;

// The join route issues a seat key (`guest-gp_...`) for one room and always
// says which. A fixture that names such a key and says nothing about the
// room is given the room it joins. One that sets `guestRoom` itself, to a
// room or to `undefined`, is left as written.
const asIssued = (user: SfuAuthPayload, roomId: string): SfuAuthPayload =>
  "guestRoom" in user || !user.userId?.startsWith("guest-gp_")
    ? user
    : { ...user, guestRoom: roomId };

let socketCount = 0;
const join = async (
  state: SfuState,
  user: SfuAuthPayload,
  roomId = "room",
  payload: Record<string, unknown> = {},
) => {
  const peer = makeSocket(`socket-${++socketCount}`, asIssued(user, roomId));
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
    ["no pass", { userId: "guest-a-client-that-names-itself", guestRoom: undefined }],
    ["another pass", { userId: "guest-gp_MMMMMMMMMMMMMMMMMMMMMM", guestProof: "proof-of-another-pass" }],
  ])("does not let a join with %s use the invite", async (_label, intruder) => {
    const { state, room } = await invited();

    const attempt = await join(state, { ...publicIdentity(onStage), ...intruder });

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
    const anyRoomToken = { ...onStage, guestRoom: undefined };

    const attempt = await join(state, anyRoomToken);

    expect(attempt.ack).toHaveBeenCalledWith(refused);
    expect(attempt.context.currentClient).toBeNull();
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
    guestWas: [{ userKey: guestHost.userId, guestProof: guestHost.guestProof }],
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
      guestWas: [{ userKey: guest.userId, guestProof: guest.guestProof }],
    });

    expect(back.ack).toHaveBeenCalledWith(joined);
  });

  it.each([
    ["names a key whose proof it does not have", [{ userKey: guestHost.userId, guestProof: "a-guess" }]],
    ["names no proof", [{ userKey: guestHost.userId }]],
    ["names a seat outside a list", { userKey: guestHost.userId, guestProof: guestHost.guestProof }],
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
    const anyRoomToken = { ...successor, guestRoom: undefined };

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
      guestWas: [{ userKey: guest.userId, guestProof: guest.guestProof }],
    });

    expect(back.ack).toHaveBeenCalledWith({
      error: "You are not allowed to join this meeting.",
    });
  });
});

const guestSeatOf = (tab: { userId: string; sessionId: string }) =>
  `${tab.userId}#${tab.sessionId}`;

// How the join token names the seats a tab held under the browser's other
// passes.
const formerSeats = (...seats: Array<{ userId: string; guestProof: string }>) =>
  seats.map((seat) => ({ userKey: seat.userId, guestProof: seat.guestProof }));

describe("a block and a guest whose pass changed", () => {
  beforeEach(() => broadcast.mockClear());
  const guest = {
    userId: "guest-gp_TTTTTTTTTTTTTTTTTTTTTT",
    clientId: "conclave",
    sessionId: "tab-7",
    guestProof: "proof-of-pass-t",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  const guestSeat = `${guest.userId}#${guest.sessionId}`;
  const underNewPass = {
    ...guest,
    userId: "guest-gp_UUUUUUUUUUUUUUUUUUUUUU",
    guestProof: "proof-of-the-other-pass",
  } satisfies SfuAuthPayload;
  const notAllowed: unknown = expect.objectContaining({
    error: "You are not allowed to join this meeting.",
  });

  it("stays on the old identity and reaches the new one", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    await join(state, guest);
    room.blockUser(guest.userId);
    room.removeClient(guestSeat);

    const moved = await join(state, { ...underNewPass, guestWas: formerSeats(guest) });
    await endOfTurn();
    const replayed = await join(state, guest);
    const again = await join(state, underNewPass);

    expect(moved.ack).toHaveBeenCalledWith(notAllowed);
    expect(replayed.ack).toHaveBeenCalledWith(notAllowed);
    expect(again.ack).toHaveBeenCalledWith(notAllowed);
  });

  it("still keeps out the guest's other tab on the old pass", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const otherTab = { ...guest, userId: "guest-gp_VVVVVVVVVVVVVVVVVVVVVV", sessionId: "tab-8" } satisfies SfuAuthPayload;
    await join(state, guest);
    room.blockUser(guest.userId);
    room.removeClient(guestSeat);

    await join(state, { ...underNewPass, guestWas: formerSeats(guest) });
    await endOfTurn();
    const attempt = await join(state, otherTab);

    expect(attempt.ack).toHaveBeenCalledWith(notAllowed);
  });

  it("moves nothing from an identity that the block covers", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const blockedTab = { ...guest, userId: "guest-gp_VVVVVVVVVVVVVVVVVVVVVV", sessionId: "tab-8" } satisfies SfuAuthPayload;
    await join(state, guest);
    await join(state, blockedTab);
    room.setLocked(true);
    room.allowLockedUser(guest.userId);
    room.blockUser(blockedTab.userId);
    room.removeClient(guestSeat);
    room.removeClient(`${blockedTab.userId}#tab-8`);

    const attempt = await join(state, { ...underNewPass, guestWas: formerSeats(guest) });

    expect(attempt.ack).toHaveBeenCalledWith(notAllowed);
    expect(room.isLockedAllowed(underNewPass.userId)).toBe(false);
  });

  it("on the new pass moves nothing to it, and reaches the old identity", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const blockedTab = { ...underNewPass, userId: "guest-gp_WWWWWWWWWWWWWWWWWWWWWW", sessionId: "tab-8" } satisfies SfuAuthPayload;
    await join(state, guest);
    await join(state, blockedTab);
    room.setLocked(true);
    room.allowLockedUser(guest.userId);
    room.blockUser(blockedTab.userId);
    room.removeClient(`${blockedTab.userId}#tab-8`);
    room.removeClient(guestSeat);

    const moved = await join(state, { ...underNewPass, guestWas: formerSeats(guest) });
    await endOfTurn();
    const replayed = await join(state, guest);

    expect(moved.ack).toHaveBeenCalledWith(notAllowed);
    expect(replayed.ack).toHaveBeenCalledWith(notAllowed);
    expect(room.isLockedAllowed(underNewPass.userId)).toBe(false);
  });
});

describe("a tab that comes back under another pass while its old socket still looks connected", () => {
  beforeEach(() => broadcast.mockClear());
  const guest = {
    userId: "guest-gp_TTTTTTTTTTTTTTTTTTTTTT",
    clientId: "conclave",
    sessionId: "tab-7",
    guestProof: "proof-of-pass-t",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  const guestSeat = `${guest.userId}#${guest.sessionId}`;
  const underNewPass = {
    ...guest,
    userId: "guest-gp_UUUUUUUUUUUUUUUUUUUUUU",
    guestProof: "proof-of-the-other-pass",
    guestWas: formerSeats(guest),
  } satisfies SfuAuthPayload;
  const newSeat = `${underNewPass.userId}#${underNewPass.sessionId}`;

  it("has one seat, and the room is told the old one left", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const before = await join(state, guest);
    expect(before.peer.socket.connected).toBe(true);

    const after = await join(state, underNewPass);

    expect(after.ack).toHaveBeenCalledWith(joined);
    expect([...room.clients.keys()].sort()).toEqual([guestHostSeat, newSeat].sort());
    expect([...room.userKeysById.keys()].sort()).toEqual([guestHostSeat, newSeat].sort());
    expect(broadcast).toHaveBeenCalledWith("userLeft", { userId: guestSeat, roomId: "room" });
  });

  it("is the host once, when the old seat was the host", async () => {
    const state = makeState();
    const hostTab = { ...guestHost, guestRoom: "room" } satisfies SfuAuthPayload;
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    const successor = {
      ...hostTab,
      userId: "guest-gp_SSSSSSSSSSSSSSSSSSSSSS",
      guestProof: "proof-of-the-cookie-pass",
      guestWas: formerSeats(hostTab),
    } satisfies SfuAuthPayload;

    const after = await join(state, successor);

    const seat = `${successor.userId}#${successor.sessionId}`;
    expect(after.context.currentClient).toBeInstanceOf(Admin);
    expect([...room.clients.keys()]).toEqual([seat]);
    expect(room.getHostUserId()).toBe(seat);
  });

  it("does not take the seat of a tab that proves nothing about it", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    await join(state, guest);

    await join(state, { ...underNewPass, guestWas: [{ userKey: guest.userId, guestProof: "a-guess" }] });

    expect(room.getClient(guestSeat)).toBeDefined();
  });
});

describe("what a guest may do, in every tab of its browser", () => {
  const hostTab = { ...guestHost, guestRoom: "room" } satisfies SfuAuthPayload;
  // Another tab of the same browser: the same pass, another public key.
  const otherTabOf = (
    tab: { guestProof: string },
    sessionId: string,
    letter: string,
  ) =>
    ({
      userId: `guest-gp_${letter.repeat(22)}`,
      clientId: "conclave",
      sessionId,
      guestProof: tab.guestProof,
      guestRoom: "room",
    }) satisfies SfuAuthPayload;
  const guest = {
    userId: "guest-gp_TTTTTTTTTTTTTTTTTTTTTT",
    clientId: "conclave",
    sessionId: "tab-7",
    guestProof: "proof-of-pass-t",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  const waiting: unknown = expect.objectContaining({ status: "waiting" });

  it("is to host, from a second tab of the host's browser", async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    const second = otherTabOf(hostTab, "tab-2", "H");

    const joinedSecond = await join(state, second);

    const secondSeat = `${second.userId}#tab-2`;
    expect(joinedSecond.context.currentClient).toBeInstanceOf(Admin);
    expect(joinedSecond.ack).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "joined",
        hostUserIds: expect.arrayContaining([guestHostSeat, secondSeat]) as unknown,
      }),
    );
    expect(room.getHostUserId()).toBe(guestHostSeat);
  });

  it("is still to host from the second tab after the first has left", async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    const second = otherTabOf(hostTab, "tab-2", "H");
    await join(state, second);

    room.removeClient(guestHostSeat);
    await endOfTurn();
    const third = await join(state, otherTabOf(hostTab, "tab-3", "J"));

    expect(room.getHostUserId()).toBe(`${second.userId}#tab-2`);
    expect(third.context.currentClient).toBeInstanceOf(Admin);
  });

  it("is not to host for a guest with another pass, or one that names itself with the host's proof", async () => {
    const state = makeState();
    await join(state, hostTab);

    const stranger = await join(state, { ...otherTabOf(hostTab, "tab-2", "H"), guestProof: "proof-of-another-pass" });
    const anyRoomToken = { ...otherTabOf(hostTab, "tab-3", "J"), guestRoom: undefined };
    const selfNamed = await join(state, anyRoomToken);

    expect(stranger.context.currentClient).not.toBeInstanceOf(Admin);
    expect(selfNamed.context.currentClient).not.toBeInstanceOf(Admin);
  });

  it("is to pass the lock, once a host admitted one of its tabs", async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    await join(state, guest);
    room.setLocked(true);
    room.allowLockedUser(guest.userId);

    const secondTab = await join(state, otherTabOf(guest, "tab-8", "V"));
    const stranger = await join(state, { ...otherTabOf(guest, "tab-9", "W"), guestProof: "proof-of-another-pass" });

    expect(secondTab.ack).toHaveBeenCalledWith(joined);
    expect(stranger.ack).toHaveBeenCalledWith(waiting);
  });

  it("ends for every tab when a host revokes the admission of one", async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    await join(state, guest);
    const second = otherTabOf(guest, "tab-8", "V");
    await join(state, second);
    room.setLocked(true);
    room.allowLockedUser(guest.userId);
    room.allowLockedUser(second.userId);

    room.revokeLockedAllowedUser(second.userId);
    room.removeClient(guestSeatOf(guest));
    const back = await join(state, guest);

    expect(back.ack).toHaveBeenCalledWith(waiting);
  });

  it("does not come back for any tab after a host removed one", async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    await join(state, guest);
    const second = otherTabOf(guest, "tab-8", "V");
    await join(state, second);
    room.setLocked(true);
    room.allowLockedUser(guest.userId);

    room.dropRejoinGrants(second.userId);
    room.removeClient(`${second.userId}#tab-8`);
    const back = await join(state, second);

    expect(back.ack).toHaveBeenCalledWith(waiting);
    expect(room.isLockedAllowed(guest.userId)).toBe(false);
  });
});

describe("a guest whose browser holds two passes", () => {
  beforeEach(() => broadcast.mockClear());
  const hostTab = { ...guestHost, guestRoom: "room" } satisfies SfuAuthPayload;
  const guest = {
    userId: "guest-gp_TTTTTTTTTTTTTTTTTTTTTT",
    clientId: "conclave",
    sessionId: "tab-7",
    guestProof: "proof-of-pass-t",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  const underOtherPass = {
    ...guest,
    userId: "guest-gp_UUUUUUUUUUUUUUUUUUUUUU",
    guestProof: "proof-of-the-other-pass",
    guestWas: formerSeats(guest),
  } satisfies SfuAuthPayload;
  const notAllowed: unknown = expect.objectContaining({
    error: "You are not allowed to join this meeting.",
  });

  it("keeps host when the join that first named its old seat never finished", async () => {
    const state = makeState();
    const first = await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    const successor = {
      ...hostTab,
      userId: "guest-gp_SSSSSSSSSSSSSSSSSSSSSS",
      guestProof: "proof-of-the-settled-pass",
      guestWas: formerSeats(hostTab),
    } satisfies SfuAuthPayload;
    dropConnection(first.peer);
    room.linkGuestPasses(successor.guestWas, successor.guestProof);
    await endOfTurn();

    const retried = await join(state, successor);

    expect(retried.ack).toHaveBeenCalledWith(joined);
    expect(retried.context.currentClient).toBeInstanceOf(Admin);
    expect(room.getHostUserId()).toBe(`${successor.userId}#${successor.sessionId}`);
  });

  it("is host in a fresh tab that is on the other pass", async () => {
    const state = makeState();
    await join(state, hostTab);
    const freshTab = {
      userId: "guest-gp_FFFFFFFFFFFFFFFFFFFFFF",
      clientId: "conclave",
      sessionId: "tab-2",
      guestProof: "proof-of-the-settled-pass",
      guestRoom: "room",
      guestWas: [{ userKey: "guest-gp_GGGGGGGGGGGGGGGGGGGGGG", guestProof: hostTab.guestProof }],
    } satisfies SfuAuthPayload;

    const second = await join(state, freshTab);

    expect(second.context.currentClient).toBeInstanceOf(Admin);
  });

  it("is removed from every tab, under either pass, by a block set after the passes were linked", async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    const stillOnOldPass = { ...guest, userId: "guest-gp_VVVVVVVVVVVVVVVVVVVVVV", sessionId: "tab-8" } satisfies SfuAuthPayload;
    await join(state, guest);
    await join(state, stillOnOldPass);
    await join(state, underOtherPass);

    const sameGuest = room.identitiesOfSameGuest(underOtherPass.userId);
    room.blockUser(underOtherPass.userId);
    room.removeClient(`${stillOnOldPass.userId}#tab-8`);
    await endOfTurn();
    const oldPassAgain = await join(state, stillOnOldPass);
    const thirdTab = await join(state, { ...guest, userId: "guest-gp_XXXXXXXXXXXXXXXXXXXXXX", sessionId: "tab-9" });

    expect(sameGuest.sort()).toEqual([stillOnOldPass.userId, underOtherPass.userId].sort());
    expect(oldPassAgain.ack).toHaveBeenCalledWith(notAllowed);
    expect(thirdTab.ack).toHaveBeenCalledWith(notAllowed);
  });

  it("is let back in under both passes when the host lifts that block", async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    await join(state, guest);
    await join(state, underOtherPass);
    room.blockUser(underOtherPass.userId);
    room.removeClient(`${underOtherPass.userId}#${underOtherPass.sessionId}`);

    room.unblockUser(underOtherPass.userId);
    const back = await join(state, guest);

    expect(back.ack).toHaveBeenCalledWith(joined);
  });

  it("is not linked to a pass the room has never seen", async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;

    await join(state, {
      ...underOtherPass,
      guestWas: [{ userKey: "guest-gp_NNNNNNNNNNNNNNNNNNNNNN", guestProof: "proof-nobody-here-has" }],
    });

    expect(room.identitiesOfSameGuest(underOtherPass.userId)).toEqual([underOtherPass.userId]);
  });

  it("leaves nothing behind once it holds nothing in the room", async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    await join(state, guest);
    await join(state, underOtherPass);
    const boundWithHostOnly = 1;

    room.removeClient(`${underOtherPass.userId}#${underOtherPass.sessionId}`);
    await endOfTurn();
    await join(state, { ...underOtherPass, guestWas: undefined });

    expect(room.identitiesOfSameGuest(underOtherPass.userId)).toEqual([underOtherPass.userId]);
    expect(room.boundGuestIdentityCount).toBe(boundWithHostOnly + 1);
  });
});

describe("a browser whose passes arrived out of order", () => {
  // Five pages loaded together and each was given a pass. Pass 1 sorts
  // lowest, so it is the one the browser ends up going by.
  const proofOfPass = (order: number) => `proof-of-pass-${order}`;
  const tabUnder = (order: number, sessionId: string, others: number[] = []) =>
    ({
      userId: `guest-gp_${sessionId}-under-pass-${order}`,
      clientId: "conclave",
      sessionId,
      guestProof: proofOfPass(order),
      guestRoom: "room",
      allowRoomCreation: true,
      ...(others.length > 0
        ? {
            guestWas: others.map((other) => ({
              userKey: `guest-gp_${sessionId}-under-pass-${other}`,
              guestProof: proofOfPass(other),
            })),
          }
        : {}),
    }) satisfies SfuAuthPayload;
  const seatOf = (tab: { userId: string; sessionId: string }) => `${tab.userId}#${tab.sessionId}`;

  it.each([2, 3, 4, 5])(
    "keeps host for the tab that became host under pass %i before the others landed",
    async (hostPass) => {
      const state = makeState();
      await join(state, tabUnder(hostPass, "tab-1"));
      const room = state.rooms.get("conclave:room")!;
      const back = tabUnder(1, "tab-1", [2, 3, 4, 5]);

      const rejoined = await join(state, back);

      expect(rejoined.ack).toHaveBeenCalledWith(joined);
      expect(rejoined.context.currentClient).toBeInstanceOf(Admin);
      expect(room.getHostUserId()).toBe(seatOf(back));
      expect([...room.clients.keys()]).toEqual([seatOf(back)]);
    },
  );

  it("is one guest even when no single token named all the passes", async () => {
    const state = makeState();
    await join(state, tabUnder(5, "tab-1"));
    const room = state.rooms.get("conclave:room")!;

    const second = await join(state, tabUnder(3, "tab-2", [5]));
    const third = await join(state, tabUnder(2, "tab-3", [3]));
    const fourth = await join(state, tabUnder(1, "tab-4", [2]));

    for (const tab of [second, third, fourth]) {
      expect(tab.context.currentClient).toBeInstanceOf(Admin);
    }
    expect(room.identitiesOfSameGuest(tabUnder(1, "tab-4").userId)).toHaveLength(4);
  });

  it("is still not a guest whose passes the room has never seen together", async () => {
    const state = makeState();
    await join(state, tabUnder(5, "tab-1"));

    const stranger = await join(state, {
      ...tabUnder(1, "tab-9", [2, 3, 4]),
      guestProof: "proof-of-a-stranger",
    });

    expect(stranger.context.currentClient).not.toBeInstanceOf(Admin);
  });
});

describe("a guest who waits to be let in and comes back under another pass", () => {
  const hostTab = { ...guestHost, guestRoom: "room" } satisfies SfuAuthPayload;
  const guest = {
    userId: "guest-gp_TTTTTTTTTTTTTTTTTTTTTT",
    clientId: "conclave",
    sessionId: "tab-7",
    guestProof: "proof-of-pass-t",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  const underOtherPass = {
    ...guest,
    userId: "guest-gp_UUUUUUUUUUUUUUUUUUUUUU",
    guestProof: "proof-of-the-other-pass",
    guestWas: formerSeats(guest),
  } satisfies SfuAuthPayload;
  const waiting: unknown = expect.objectContaining({ status: "waiting" });

  it("has one request in the lobby, and the host is told the old one is gone", async () => {
    const state = makeState();
    const host = await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    room.setLocked(true);
    const first = await join(state, guest);
    expect(first.ack).toHaveBeenCalledWith(waiting);
    expect(first.peer.socket.connected).toBe(true);

    const second = await join(state, underOtherPass);

    expect(second.ack).toHaveBeenCalledWith(waiting);
    expect([...room.pendingClients.keys()]).toEqual([underOtherPass.userId]);
    expect(room.pendingClients.get(underOtherPass.userId)?.socket).toBe(second.peer.socket);
    expect(host.peer.emit).toHaveBeenCalledWith("pendingUserLeft", {
      userId: guest.userId,
      roomId: "room",
    });
  });

  it("is let straight in, with no request left behind, when the host has admitted it meanwhile", async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    room.setLocked(true);
    await join(state, guest);
    const otherTabAdmitted = { ...underOtherPass, userId: "guest-gp_VVVVVVVVVVVVVVVVVVVVVV", sessionId: "tab-8", guestWas: undefined };
    await join(state, otherTabAdmitted);
    room.allowLockedUser(otherTabAdmitted.userId);

    const back = await join(state, underOtherPass);

    expect(back.ack).toHaveBeenCalledWith(joined);
    expect(room.pendingClients.has(guest.userId)).toBe(false);
  });

  it("leaves the request of a guest it proves nothing about", async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    room.setLocked(true);
    await join(state, guest);

    await join(state, { ...underOtherPass, guestWas: [{ userKey: guest.userId, guestProof: "a-guess" }] });

    expect([...room.pendingClients.keys()].sort()).toEqual([guest.userId, underOtherPass.userId].sort());
  });
});

describe("a guest who asks to be let in from more than one tab", () => {
  const hostTab = { ...guestHost, guestRoom: "room" } satisfies SfuAuthPayload;
  const guest = {
    userId: "guest-gp_TTTTTTTTTTTTTTTTTTTTTT",
    clientId: "conclave",
    sessionId: "tab-7",
    guestProof: "proof-of-pass-t",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  const onTheSamePass = {
    ...guest,
    userId: "guest-gp_VVVVVVVVVVVVVVVVVVVVVV",
    sessionId: "tab-8",
  } satisfies SfuAuthPayload;
  // The browser holds two passes. This tab goes by the other one, and its
  // token names the seat it would hold under the first tab's pass.
  const onALinkedPass = {
    ...guest,
    userId: "guest-gp_UUUUUUUUUUUUUUUUUUUUUU",
    sessionId: "tab-9",
    guestProof: "proof-of-the-other-pass",
    guestWas: [{ userKey: "guest-gp_WWWWWWWWWWWWWWWWWWWWWW", guestProof: guest.guestProof }],
  } satisfies SfuAuthPayload;
  const stranger = {
    ...guest,
    userId: "guest-gp_XXXXXXXXXXXXXXXXXXXXXX",
    sessionId: "tab-1",
    guestProof: "proof-of-a-stranger",
  } satisfies SfuAuthPayload;
  const otherTabs: Array<[string, SfuAuthPayload & { userId: string }]> = [
    ["two tabs on one pass", onTheSamePass],
    ["two tabs on linked passes", onALinkedPass],
  ];

  type Joined = Awaited<ReturnType<typeof join>>;
  const lockedRoom = async () => {
    const state = makeState();
    const host = await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    room.setLocked(true);
    return { state, room, host };
  };
  const heard = (host: Joined, event: string) =>
    host.peer.emit.mock.calls
      .filter(([name]) => name === event)
      .map(([, payload]) => (payload as { userId: string }).userId);
  const hostAsks = async (host: Joined, event: string, payload: unknown) => {
    const ack = vi.fn();
    await host.peer.handlers.get(event)!(...([payload, ack] as never[]));
    return ack;
  };
  const approved = ["joinApproved", { roomId: "room" }] as const;
  const turnedAway = ["joinRejected", { roomId: "room" }] as const;

  it.each(otherTabs)("shows the hosts one request for %s", async (_label, otherTab) => {
    const { state, room, host } = await lockedRoom();

    await join(state, guest);
    await join(state, otherTab);
    await join(state, stranger);

    expect(heard(host, "userRequestedJoin")).toEqual([guest.userId, stranger.userId]);
    expect(toPendingUserSnapshots(room).map((row) => row.userId)).toEqual([guest.userId, stranger.userId]);
    expect(room.pendingClients.size).toBe(3);
  });

  it.each(otherTabs)("lets every tab in when a host admits the request, for %s", async (_label, otherTab) => {
    const { state, room, host } = await lockedRoom();
    const first = await join(state, guest);
    const second = await join(state, otherTab);
    const other = await join(state, stranger);

    const answer = await hostAsks(host, "admitUser", { userId: guest.userId });

    expect(answer).toHaveBeenCalledWith({ success: true });
    expect(first.peer.emit).toHaveBeenCalledWith(...approved);
    expect(second.peer.emit).toHaveBeenCalledWith(...approved);
    expect(other.peer.emit).not.toHaveBeenCalledWith(...approved);
    expect([...room.pendingClients.keys()]).toEqual([stranger.userId]);
    expect(heard(host, "userAdmitted")).toEqual([guest.userId]);
    expect((await join(state, guest)).ack).toHaveBeenCalledWith(joined);
    expect((await join(state, otherTab)).ack).toHaveBeenCalledWith(joined);
  });

  it.each(otherTabs)("turns every tab away when a host denies the request, for %s", async (_label, otherTab) => {
    const { state, room, host } = await lockedRoom();
    const first = await join(state, guest);
    const second = await join(state, otherTab);
    const other = await join(state, stranger);

    const answer = await hostAsks(host, "rejectUser", { userId: guest.userId });

    expect(answer).toHaveBeenCalledWith({ success: true });
    expect(first.peer.emit).toHaveBeenCalledWith(...turnedAway);
    expect(second.peer.emit).toHaveBeenCalledWith(...turnedAway);
    expect(other.peer.emit).not.toHaveBeenCalledWith(...turnedAway);
    expect([...room.pendingClients.keys()]).toEqual([stranger.userId]);
    expect(heard(host, "userRejected")).toEqual([guest.userId]);
  });

  it.each(otherTabs)("shows the hosts the other tab's request when the first tab gives up, for %s", async (_label, otherTab) => {
    const { state, room, host } = await lockedRoom();
    await join(state, guest);
    await join(state, otherTab);

    withdrawWaitingRequest(room, guest.userId);

    expect(heard(host, "pendingUserLeft")).toEqual([guest.userId]);
    expect(heard(host, "userRequestedJoin")).toEqual([guest.userId, otherTab.userId]);
    expect(toPendingUserSnapshots(room).map((row) => row.userId)).toEqual([otherTab.userId]);
  });

  it("tells the hosts nothing when a tab whose request was not shown gives up", async () => {
    const { state, room, host } = await lockedRoom();
    await join(state, guest);
    await join(state, onTheSamePass);

    withdrawWaitingRequest(room, onTheSamePass.userId);

    expect(heard(host, "pendingUserLeft")).toEqual([]);
    expect(toPendingUserSnapshots(room).map((row) => row.userId)).toEqual([guest.userId]);
  });

  it("removes every waiting tab when a host blocks the request", async () => {
    const { state, room, host } = await lockedRoom();
    const first = await join(state, guest);
    const second = await join(state, onALinkedPass);

    blockUserKey(room, guest.userId, { reason: "Blocked by host", kickPresent: true, io, state });
    const again = await join(state, onALinkedPass);

    expect(first.peer.emit).toHaveBeenCalledWith(...turnedAway);
    expect(second.peer.emit).toHaveBeenCalledWith(...turnedAway);
    expect(room.pendingClients.size).toBe(0);
    expect(again.ack).toHaveBeenCalledWith(
      expect.objectContaining({ error: "You are not allowed to join this meeting." }),
    );
    expect(heard(host, "userRequestedJoin")).toEqual([guest.userId]);
  });

  it("lets every tab in through the call that admits a list of keys", async () => {
    const { state, room, host } = await lockedRoom();
    const first = await join(state, guest);
    const second = await join(state, onTheSamePass);

    const answer = await hostAsks(host, "admin:allowUsers", { userKeys: [guest.userId] });

    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, admitted: [guest.userId] }),
    );
    expect(first.peer.emit).toHaveBeenCalledWith(...approved);
    expect(second.peer.emit).toHaveBeenCalledWith(...approved);
    expect(room.pendingClients.size).toBe(0);
  });

  it("treats two tabs of a client that names itself as one guest when they show one pass", async () => {
    const { state, room, host } = await lockedRoom();
    const older = (sessionId: string) =>
      ({ userId: `guest-${sessionId}`, clientId: "conclave", sessionId, guestProof: "proof-of-the-older-pass" }) satisfies SfuAuthPayload;
    const first = await join(state, older("older-tab-1"));
    const second = await join(state, older("older-tab-2"));

    await hostAsks(host, "admitUser", { userId: "guest-older-tab-1" });

    expect(heard(host, "userRequestedJoin")).toEqual(["guest-older-tab-1"]);
    expect(first.peer.emit).toHaveBeenCalledWith(...approved);
    expect(second.peer.emit).toHaveBeenCalledWith(...approved);
    expect(room.pendingClients.size).toBe(0);
    expect((await join(state, older("older-tab-2"))).ack).toHaveBeenCalledWith(joined);
  });

  it("keeps a guest with no pass to one request per tab", async () => {
    const { state, host } = await lockedRoom();
    const noPass = (sessionId: string) =>
      ({ userId: `guest-${sessionId}`, clientId: "conclave", sessionId }) satisfies SfuAuthPayload;
    const first = await join(state, noPass("older-tab-1"));
    const second = await join(state, noPass("older-tab-2"));

    await hostAsks(host, "admitUser", { userId: "guest-older-tab-1" });

    expect(heard(host, "userRequestedJoin")).toEqual(["guest-older-tab-1", "guest-older-tab-2"]);
    expect(first.peer.emit).toHaveBeenCalledWith(...approved);
    expect(second.peer.emit).not.toHaveBeenCalledWith(...approved);
  });
});

describe("a guest that is a co-host under one pass and blocked under another", () => {
  const hostTab = { ...guestHost, guestRoom: "room" } satisfies SfuAuthPayload;
  const coHostTab = {
    userId: "guest-gp_CCCCCCCCCCCCCCCCCCCCCC",
    clientId: "conclave",
    sessionId: "tab-7",
    guestProof: "proof-of-the-co-host-pass",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  const blockedTab = {
    userId: "guest-gp_BBBBBBBBBBBBBBBBBBBBBB",
    clientId: "conclave",
    sessionId: "tab-8",
    guestProof: "proof-of-the-blocked-pass",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  const notAllowed: unknown = expect.objectContaining({
    error: "You are not allowed to join this meeting.",
  });
  // Both tabs are in the room, the room does not know they are one guest,
  // one is made a co-host and the other is blocked. Then both leave.
  const coHostAndBlocked = async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    await join(state, coHostTab);
    await join(state, blockedTab);
    room.promoteClientToAdmin(`${coHostTab.userId}#tab-7`);
    room.blockUser(blockedTab.userId);
    room.removeClient(`${blockedTab.userId}#tab-8`);
    room.removeClient(`${coHostTab.userId}#tab-7`);
    return { state, room };
  };

  it("stays out when its co-host tab comes back and the browser shows both passes", async () => {
    const { state, room } = await coHostAndBlocked();

    const back = await join(state, {
      ...coHostTab,
      guestWas: [{ userKey: "guest-gp_DDDDDDDDDDDDDDDDDDDDDD", guestProof: blockedTab.guestProof }],
    });

    expect(back.ack).toHaveBeenCalledWith(notAllowed);
    expect(back.context.currentClient).toBeNull();
    expect(room.isAdminUserKey(coHostTab.userId)).toBe(false);
  });

  it("stays out when a new tab comes back under the blocked pass and names the co-host pass", async () => {
    const { state } = await coHostAndBlocked();

    const back = await join(state, {
      ...blockedTab,
      userId: "guest-gp_EEEEEEEEEEEEEEEEEEEEEE",
      sessionId: "tab-9",
      guestWas: [{ userKey: "guest-gp_FFFFFFFFFFFFFFFFFFFFFF", guestProof: coHostTab.guestProof }],
    });

    expect(back.ack).toHaveBeenCalledWith(notAllowed);
    expect(back.context.currentClient).toBeNull();
  });

  it("blocked first, then linked: loses its co-host seat and every right when a tab shows both passes", async () => {
    broadcast.mockClear();
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    const coHost = await join(state, coHostTab);
    const coHostSeat = `${coHostTab.userId}#tab-7`;
    room.promoteClientToAdmin(coHostSeat);
    room.setLocked(true);
    room.allowLockedUser(coHostTab.userId);
    room.promoteWebinarUserKey(coHostTab.userId);
    await join(state, { ...blockedTab, guestWas: undefined });
    room.blockUser(blockedTab.userId);
    room.removeClient(`${blockedTab.userId}#tab-8`);
    expect(room.getClient(coHostSeat)).toBeInstanceOf(Admin);

    const third = await join(state, {
      ...coHostTab,
      userId: "guest-gp_GGGGGGGGGGGGGGGGGGGGGG",
      sessionId: "tab-9",
      guestWas: [{ userKey: "guest-gp_HHHHHHHHHHHHHHHHHHHHHH", guestProof: blockedTab.guestProof }],
    });

    expect(third.ack).toHaveBeenCalledWith(notAllowed);
    expect(room.getClient(coHostSeat)).toBeUndefined();
    expect(coHost.peer.emit).toHaveBeenCalledWith("kicked", expect.objectContaining({ roomId: "room" }));
    expect(broadcast).toHaveBeenCalledWith("userLeft", { userId: coHostSeat, roomId: "room" });
    expect(room.isAdminUserKey(coHostTab.userId)).toBe(false);
    expect(room.isLockedAllowed(coHostTab.userId)).toBe(false);
    expect(room.isWebinarPromotedUserKey(coHostTab.userId)).toBe(false);
    expect([...room.clients.keys()]).toEqual([guestHostSeat]);
  });

  it("blocked first, then linked: loses primary host too, and a waiting tab is turned away", async () => {
    const state = makeState();
    const primary = await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    const coHost = await join(state, coHostTab);
    room.promoteClientToAdmin(`${coHostTab.userId}#tab-7`);
    await join(state, blockedTab);
    room.blockUser(blockedTab.userId);
    room.removeClient(`${blockedTab.userId}#tab-8`);
    room.setLocked(true);
    const waitingTab = await join(state, {
      ...hostTab,
      userId: "guest-gp_JJJJJJJJJJJJJJJJJJJJJJ",
      sessionId: "tab-5",
      guestProof: "proof-of-a-third-pass",
    });
    expect([...room.pendingClients.keys()]).toEqual(["guest-gp_JJJJJJJJJJJJJJJJJJJJJJ"]);

    // A tab of the primary host's browser shows that the host's pass, the
    // waiting tab's pass and the blocked pass are one guest.
    await join(state, {
      ...hostTab,
      userId: "guest-gp_KKKKKKKKKKKKKKKKKKKKKK",
      sessionId: "tab-6",
      guestWas: [
        { userKey: "guest-gp_LLLLLLLLLLLLLLLLLLLLLL", guestProof: blockedTab.guestProof },
        { userKey: "guest-gp_MMMMMMMMMMMMMMMMMMMMMM", guestProof: "proof-of-a-third-pass" },
      ],
    });

    expect(room.getClient(guestHostSeat)).toBeUndefined();
    expect(primary.peer.emit).toHaveBeenCalledWith("kicked", expect.objectContaining({ roomId: "room" }));
    expect(room.hostUserKey).toBeNull();
    expect(room.pendingClients.size).toBe(0);
    expect(waitingTab.peer.emit).toHaveBeenCalledWith("joinRejected", { roomId: "room" });
    expect(room.getClient(`${coHostTab.userId}#tab-7`)).toBe(coHost.context.currentClient);
  });

  it("linked first, then blocked: every seat goes, and no right comes back", async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    const coHost = await join(state, coHostTab);
    const coHostSeat = `${coHostTab.userId}#tab-7`;
    room.promoteClientToAdmin(coHostSeat);
    const other = await join(state, {
      ...blockedTab,
      guestWas: [{ userKey: "guest-gp_NNNNNNNNNNNNNNNNNNNNNN", guestProof: coHostTab.guestProof }],
    });
    expect(other.context.currentClient).toBeInstanceOf(Admin);

    const result = blockUserKey(room, blockedTab.userId, { reason: "Blocked by host", kickPresent: true, io, state });
    await endOfTurn();
    const coHostAgain = await join(state, coHostTab);
    const otherAgain = await join(state, blockedTab);

    expect(result.kickedUserIds.sort()).toEqual([`${blockedTab.userId}#tab-8`, coHostSeat].sort());
    expect(coHost.peer.emit).toHaveBeenCalledWith("kicked", expect.objectContaining({ roomId: "room" }));
    expect([...room.clients.keys()]).toEqual([guestHostSeat]);
    expect(coHostAgain.ack).toHaveBeenCalledWith(notAllowed);
    expect(otherAgain.ack).toHaveBeenCalledWith(notAllowed);
    expect(room.isAdminUserKey(coHostTab.userId, coHostTab.guestProof)).toBe(false);
  });

  it.each([
    ["a co-host", (room: Room, userKey: string) => room.registerAdminUserKey(userKey)],
    ["the primary host", (room: Room, userKey: string) => void (room.hostUserKey = userKey)],
    ["admitted past the lock", (room: Room, userKey: string) => void room.lockedAllowedUsers.add(userKey)],
  ])("is refused before any right is looked at, even were it still on record as %s", async (_label, keepRight) => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    await join(state, coHostTab);
    room.removeClient(`${coHostTab.userId}#tab-7`);
    room.blockUser(coHostTab.userId);
    keepRight(room, coHostTab.userId);

    const back = await join(state, coHostTab);

    expect(back.ack).toHaveBeenCalledWith(notAllowed);
    expect(back.context.currentClient).toBeNull();
  });

  it("is not a co-host any more after a block set while none of its tabs was in the room", async () => {
    const state = makeState();
    await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    await join(state, coHostTab);
    room.promoteClientToAdmin(`${coHostTab.userId}#tab-7`);
    room.removeClient(`${coHostTab.userId}#tab-7`);

    room.blockUser(coHostTab.userId);
    const back = await join(state, coHostTab);

    expect(back.ack).toHaveBeenCalledWith(notAllowed);
    expect(room.isAdminUserKey(coHostTab.userId)).toBe(false);
  });
});

describe("a guest join token whose claims are malformed", () => {
  const roomScoped = {
    userId: "guest-gp_TTTTTTTTTTTTTTTTTTTTTT",
    clientId: "conclave",
    sessionId: "tab-7",
    guestProof: "proof-of-pass-t",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  const notVerified: unknown = expect.objectContaining({
    error: "This guest session could not be verified. Reload the page to join again.",
  });

  it.each([
    ["a room and no proof", { ...roomScoped, guestProof: undefined }],
    ["a proof of the wrong type", { ...roomScoped, guestProof: 7 }],
    ["a room of the wrong type", { ...roomScoped, guestRoom: { id: "room" } }],
    ["a room and a key no pass was issued for", { ...roomScoped, userId: "guest-tab-7" }],
    ["an issued seat key and no room", { ...roomScoped, guestRoom: undefined }],
    ["a former seat with no proof", { ...roomScoped, guestWas: [{ userKey: "guest-gp_UUUUUUUUUUUUUUUUUUUUUU" }] }],
    ["a former seat that is not a seat key", { ...roomScoped, guestWas: [{ userKey: "me@example.com", guestProof: "p" }] }],
  ])("is refused with %s, and nothing is seated", async (_label, claims) => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;

    const attempt = await join(state, claims);

    expect(attempt.ack).toHaveBeenCalledWith(notVerified);
    expect(attempt.context.currentClient).toBeNull();
    expect(room.clients.size).toBe(1);
  });

  it("joins with a claim no reader knows, which then counts for nothing", async () => {
    const state = makeState();
    await join(state, guestHost);

    const attempt = await join(state, { ...roomScoped, isRoomOwner: true, guestIsHost: true });

    expect(attempt.ack).toHaveBeenCalledWith(joined);
    expect(attempt.context.currentClient).not.toBeInstanceOf(Admin);
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
