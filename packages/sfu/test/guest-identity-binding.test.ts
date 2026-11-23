import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import {
  admitWaitingGuest,
  blockUserKey,
  forceRemoveClientNow,
  kickClient,
  toClusterSnapshot,
  toPendingUserSnapshots,
  toRoomSnapshot,
  withdrawWaitingRequest,
} from "../server/admin/controlPlane.js";
import type { Room } from "../config/classes/Room.js";
import { config as sfuConfig } from "../config/config.js";
import { Logger } from "../utilities/loggers.js";
import { createSfuApp } from "../server/http/createApp.js";
import { createTranscriptRelayRegistry } from "../server/transcript/relayRegistry.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerDisconnectHandlers } from "../server/socket/handlers/disconnectHandlers.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { registerWebinarInteractionHandlers } from "../server/socket/handlers/webinarInteractionHandlers.js";
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
  const disconnect = vi.fn();
  const socket = {
    id,
    data: { user },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit,
    disconnect,
    connected: true,
    join: vi.fn(),
    leave,
    to: () => ({ emit: vi.fn() }),
  } as unknown as Socket;
  return { socket, handlers, leave, emit, disconnect };
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
    const host = await join(state, guestHost);
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
    return { state, room, host };
  };

  it("lets the invited guest onto the stage under its other key", async () => {
    const { state, room } = await invited();

    const promoted = await join(state, onStage);

    expect(promoted.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: "joined", webinarRole: "participant" }),
    );
    // The invite is the guest's, so it holds under both keys.
    expect(room.isWebinarPromotedUserKey(onStage.userId)).toBe(true);
    expect(room.isWebinarPromotedUserKey(audience.userId)).toBe(true);
  });

  it("moves every stage tab of a demoted guest off the stage at once, and keeps them off until a newer invite (Greptile)", async () => {
    const { state, room, host } = await invited();
    const secondStageTab = { ...onStage, userId: "guest-gp_MMMMMMMMMMMMMMMMMMMMMM", sessionId: "view-2" } satisfies SfuAuthPayload;
    const otherAudience = { ...audience, userId: "guest-gp_NNNNNNNNNNNNNNNNNNNNNN", sessionId: "view-3", guestProof: "proof-of-another-viewer-pass" } satisfies SfuAuthPayload;
    const otherOnStage = { ...otherAudience, userId: "guest-gp_OOOOOOOOOOOOOOOOOOOOOO", joinMode: "meeting", guestRoom: "room" } satisfies SfuAuthPayload;
    const onStageAs: unknown = expect.objectContaining({ status: "joined", webinarRole: "participant" });
    const first = await join(state, onStage);
    const second = await join(state, secondStageTab);
    expect(first.ack).toHaveBeenCalledWith(onStageAs);
    expect(second.ack).toHaveBeenCalledWith(onStageAs);
    await join(state, otherAudience, "launch");
    room.promoteWebinarUserKey(otherAudience.userId);
    expect((await join(state, otherOnStage)).ack).toHaveBeenCalledWith(onStageAs);
    const seatOf = (user: SfuAuthPayload) => `${user.userId}#${user.sessionId}`;

    // The host moves the first stage tab back to the audience.
    registerWebinarInteractionHandlers(host.context);
    const demoted = vi.fn();
    await host.peer.handlers.get("webinar:demoteParticipant")!(...[
      { userId: seatOf(onStage) },
      demoted,
    ] as never[]);

    expect(demoted).toHaveBeenCalledWith({ success: true });
    for (const tab of [first, second]) {
      expect(tab.peer.emit).toHaveBeenCalledWith(
        "webinar:demoted",
        expect.objectContaining({ roomId: room.id, webinarLinkSlug: "launch" }),
      );
      expect(tab.peer.disconnect).toHaveBeenCalledWith(true);
    }
    expect(room.getClient(seatOf(onStage))).toBeUndefined();
    expect(room.getClient(seatOf(secondStageTab))).toBeUndefined();
    expect(room.getClient(seatOf(audience))?.isWebinarAttendee).toBe(true);
    expect(room.getClient(seatOf(otherOnStage))?.isWebinarAttendee).toBe(false);
    expect(room.getClient(guestHostSeat)).toBeDefined();
    await endOfTurn();
    const firstBack = await join(state, onStage);
    const secondBack = await join(state, secondStageTab);

    const toTheAudience: unknown = expect.objectContaining({ error: "Use the public webinar link to join as an attendee." });
    expect(firstBack.ack).toHaveBeenCalledWith(toTheAudience);
    expect(secondBack.ack).toHaveBeenCalledWith(toTheAudience);
    expect(room.isWebinarPromotedUserKey(onStage.userId)).toBe(false);
    expect(room.isWebinarPromotedUserKey(secondStageTab.userId)).toBe(false);
    expect(room.isWebinarDemotedUserKey(audience.userId, audience.guestProof)).toBe(true);

    // Only a newer invite lets the guest back on stage.
    room.promoteWebinarUserKey(audience.userId);
    expect((await join(state, onStage)).ack).toHaveBeenCalledWith(onStageAs);
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

  it("stays on the old identity, refuses every join that shows it, and records nothing for a refused one", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    await join(state, guest);
    room.blockUser(guest.userId);
    room.removeClient(guestSeat);
    await endOfTurn();
    const before = { links: room.linkedGuestPassCount, bound: room.boundGuestIdentityCount };

    const moved = await join(state, { ...underNewPass, guestWas: formerSeats(guest) });
    await endOfTurn();
    const replayed = await join(state, guest);
    const movedAgain = await join(state, { ...underNewPass, sessionId: "tab-9", guestWas: formerSeats(guest) });
    await endOfTurn();

    expect(moved.ack).toHaveBeenCalledWith(notAllowed);
    expect(replayed.ack).toHaveBeenCalledWith(notAllowed);
    expect(movedAgain.ack).toHaveBeenCalledWith(notAllowed);
    expect({ links: room.linkedGuestPassCount, bound: room.boundGuestIdentityCount }).toEqual(before);
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
    const shownAgain = await join(state, { ...underNewPass, sessionId: "tab-9", guestWas: formerSeats(guest) });
    // Shown alone, the old pass is no guest the room links to the block,
    // but the block ended its admission: it has to knock again.
    const alone = await join(state, guest);

    expect(moved.ack).toHaveBeenCalledWith(notAllowed);
    expect(shownAgain.ack).toHaveBeenCalledWith(notAllowed);
    expect(alone.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting" }));
    expect(room.isLockedAllowed(underNewPass.userId)).toBe(false);
    expect(room.linkedGuestPassCount).toBe(0);
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
  // What a host's screen holds, built from what the host's socket was sent.
  const lobbyOnHostScreen = (host: Joined): string[] => {
    let rows: string[] = [];
    for (const [event, payload] of host.peer.emit.mock.calls as Array<[string, { userId?: string; users?: Array<{ userId: string }> }]>) {
      if (event === "userRequestedJoin") rows = [...rows.filter((row) => row !== payload.userId), payload.userId!];
      if (["pendingUserLeft", "userAdmitted", "userRejected"].includes(event)) rows = rows.filter((row) => row !== payload.userId);
      if (event === "pendingUsersSnapshot") rows = payload.users!.map((user) => user.userId);
    }
    return rows;
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
    expect(lobbyOnHostScreen(host)).toEqual([stranger.userId]);
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
    expect(lobbyOnHostScreen(host)).toEqual([stranger.userId]);
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

  it("leaves the hosts' row as it is when a tab whose request was not shown gives up", async () => {
    const { state, room, host } = await lockedRoom();
    await join(state, guest);
    await join(state, onTheSamePass);

    withdrawWaitingRequest(room, onTheSamePass.userId);

    expect(lobbyOnHostScreen(host)).toEqual([guest.userId]);
    expect(heard(host, "userRequestedJoin")).toEqual([guest.userId]);
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

  // Two tabs of one browser wait under two passes the room has not linked.
  // A third tab of that browser then shows the room both passes.
  const onTheOtherPass = { ...onALinkedPass, guestWas: undefined } satisfies SfuAuthPayload;
  const thirdTabThatLinks = {
    ...guest,
    userId: "guest-gp_YYYYYYYYYYYYYYYYYYYYYY",
    sessionId: "tab-3",
    guestWas: [{ userKey: "guest-gp_ZZZZZZZZZZZZZZZZZZZZZZ", guestProof: onTheOtherPass.guestProof }],
  } satisfies SfuAuthPayload;

  it.each([
    ["admits", "admitUser", "joinApproved"],
    ["denies", "rejectUser", "joinRejected"],
  ])("collapses two rows into one when a third tab links the passes, and leaves none when a host %s it", async (_label, action, answerToTabs) => {
    const { state, room, host } = await lockedRoom();
    const first = await join(state, guest);
    const second = await join(state, onTheOtherPass);
    expect(lobbyOnHostScreen(host)).toEqual([guest.userId, onTheOtherPass.userId]);

    const third = await join(state, thirdTabThatLinks);

    expect(lobbyOnHostScreen(host)).toEqual([guest.userId]);
    expect(toPendingUserSnapshots(room).map((row) => row.userId)).toEqual([guest.userId]);

    await hostAsks(host, action, { userId: guest.userId });

    expect(lobbyOnHostScreen(host)).toEqual([]);
    expect(room.pendingClients.size).toBe(0);
    for (const tab of [first, second, third]) {
      expect(tab.peer.emit).toHaveBeenCalledWith(answerToTabs, { roomId: "room" });
    }
  });

  it.each([
    ["admits", "admitUser"],
    ["denies", "rejectUser"],
  ])("leaves no row on a host's screen that still showed both, when a host %s the guest", async (_label, action) => {
    const { state, room, host } = await lockedRoom();
    await join(state, guest);
    await join(state, onTheOtherPass);
    // The passes are linked without the hosts being told, as before the fix.
    room.linkGuestPasses([{ guestProof: onTheOtherPass.guestProof }], guest.guestProof);
    expect(lobbyOnHostScreen(host)).toEqual([guest.userId, onTheOtherPass.userId]);

    await hostAsks(host, action, { userId: guest.userId });

    expect(lobbyOnHostScreen(host)).toEqual([]);
  });

  it.each(otherTabs)("counts one waiting person for %s, wherever the admin views count", async (_label, otherTab) => {
    const { state, room } = await lockedRoom();
    await join(state, guest);
    await join(state, otherTab);
    await join(state, stranger);

    const snapshot = toRoomSnapshot(room);
    const cluster = toClusterSnapshot(state);

    expect(room.pendingClients.size).toBe(3);
    expect(snapshot.pendingUsers).toHaveLength(2);
    expect(snapshot.counts.pendingUsers).toBe(2);
    expect(room.waitingGuestCount).toBe(2);
    expect(cluster.counts.pendingUsers).toBe(2);
    expect(cluster.topRooms.find((entry) => entry.roomId === "room")?.pendingUserCount).toBe(2);
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

describe("a host's answer to a guest whose tabs the room has not linked yet", () => {
  const hostTab = { ...guestHost, guestRoom: "room" } satisfies SfuAuthPayload;
  // Two tabs of one browser were each given a pass before either cookie
  // had arrived, so they knock under passes A and B that the room cannot
  // tell are one guest.
  const tabA = {
    userId: "guest-gp_tab-1-under-pass-A",
    clientId: "conclave",
    sessionId: "tab-1",
    guestProof: "proof-of-pass-A",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  const tabB = {
    userId: "guest-gp_tab-2-under-pass-B",
    clientId: "conclave",
    sessionId: "tab-2",
    guestProof: "proof-of-pass-B",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  // The first tab reloads. By now the browser sends both passes.
  const tabAShowingBothPasses = {
    ...tabA,
    guestWas: [{ userKey: "guest-gp_tab-1-under-pass-B", guestProof: tabB.guestProof }],
  } satisfies SfuAuthPayload;
  const tabBShowingBothPasses = {
    ...tabB,
    guestWas: [{ userKey: "guest-gp_tab-2-under-pass-A", guestProof: tabA.guestProof }],
  } satisfies SfuAuthPayload;

  type Joined = Awaited<ReturnType<typeof join>>;
  const waiting: unknown = expect.objectContaining({ status: "waiting" });
  const approved = ["joinApproved", { roomId: "room" }] as const;
  const turnedAway = ["joinRejected", { roomId: "room" }] as const;
  const hostAsks = async (host: Joined, event: string, payload: unknown) => {
    const ack = vi.fn();
    await host.peer.handlers.get(event)!(...([payload, ack] as never[]));
    return ack;
  };
  const screenOf = (host: Joined): string[] => {
    let rows: string[] = [];
    for (const [event, payload] of host.peer.emit.mock.calls as Array<[string, { userId?: string; users?: Array<{ userId: string }> }]>) {
      if (event === "userRequestedJoin") rows = [...rows.filter((row) => row !== payload.userId), payload.userId!];
      if (["pendingUserLeft", "userAdmitted", "userRejected"].includes(event)) rows = rows.filter((row) => row !== payload.userId);
      if (event === "pendingUsersSnapshot") rows = payload.users!.map((user) => user.userId);
    }
    return rows;
  };
  const bothKnock = async () => {
    const state = makeState();
    const host = await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    room.setLocked(true);
    const first = await join(state, tabA);
    const second = await join(state, tabB);
    expect(screenOf(host)).toEqual([tabA.userId, tabB.userId]);
    return { state, room, host, first, second };
  };

  it("admitted, then linked: the tab that still waited is let in, and the lobby is empty", async () => {
    const { state, room, host, second } = await bothKnock();
    await hostAsks(host, "admitUser", { userId: tabA.userId });
    expect(second.peer.emit).not.toHaveBeenCalledWith(...approved);

    const reloaded = await join(state, tabAShowingBothPasses);

    expect(reloaded.ack).toHaveBeenCalledWith(joined);
    expect(second.peer.emit).toHaveBeenCalledWith(...approved);
    expect([...room.pendingClients.keys()]).toEqual([]);
    expect(screenOf(host)).toEqual([]);
    expect((await join(state, tabB)).ack).toHaveBeenCalledWith(joined);
  });

  it("denied, then linked: the tab that still waited is turned away, and only the new knock is shown", async () => {
    const { state, room, host, second } = await bothKnock();
    await hostAsks(host, "rejectUser", { userId: tabA.userId });
    expect(second.peer.emit).not.toHaveBeenCalledWith(...turnedAway);

    const reloaded = await join(state, tabAShowingBothPasses);

    expect(second.peer.emit).toHaveBeenCalledWith(...turnedAway);
    expect(reloaded.ack).toHaveBeenCalledWith(waiting);
    expect([...room.pendingClients.keys()]).toEqual([tabA.userId]);
    expect(screenOf(host)).toEqual([tabA.userId]);
  });

  it("denied, then linked, then admitted: the later answer stands for every tab", async () => {
    const { state, room, host } = await bothKnock();
    await hostAsks(host, "rejectUser", { userId: tabA.userId });
    const reloaded = await join(state, tabAShowingBothPasses);

    await hostAsks(host, "admitUser", { userId: tabA.userId });
    const otherTabAgain = await join(state, tabBShowingBothPasses);

    expect(reloaded.peer.emit).toHaveBeenCalledWith(...approved);
    expect(otherTabAgain.ack).toHaveBeenCalledWith(joined);
    expect(room.pendingClients.size).toBe(0);
    expect(screenOf(host)).toEqual([]);
  });

  it("denied under one pass and admitted under the other, then linked: the later answer wins", async () => {
    const { state, room, host, second } = await bothKnock();
    await hostAsks(host, "rejectUser", { userId: tabA.userId });
    await hostAsks(host, "admitUser", { userId: tabB.userId });
    expect(second.peer.emit).toHaveBeenCalledWith(...approved);

    const reloaded = await join(state, tabAShowingBothPasses);

    expect(reloaded.ack).toHaveBeenCalledWith(joined);
    expect(room.pendingClients.size).toBe(0);
  });

  it.each([
    ["admitted", "admitUser", approved],
    ["denied", "rejectUser", turnedAway],
  ] as const)("linked, then %s: every tab gets the answer", async (_label, action, answer) => {
    const state = makeState();
    const host = await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    room.setLocked(true);
    const first = await join(state, tabA);
    const second = await join(state, tabBShowingBothPasses);
    expect(screenOf(host)).toEqual([tabA.userId]);

    await hostAsks(host, action, { userId: tabA.userId });

    expect(first.peer.emit).toHaveBeenCalledWith(...answer);
    expect(second.peer.emit).toHaveBeenCalledWith(...answer);
    expect(room.pendingClients.size).toBe(0);
    expect(screenOf(host)).toEqual([]);
  });

  // A third pass of the same browser, and the tabs it knocks with.
  const tabUnderC = (sessionId: string, others: SfuAuthPayload[] = []) =>
    ({
      userId: `guest-gp_${sessionId}-under-pass-C`,
      clientId: "conclave",
      sessionId,
      guestProof: "proof-of-pass-C",
      guestRoom: "room",
      ...(others.length > 0
        ? { guestWas: others.map((other) => ({ userKey: `guest-gp_${sessionId}-under-${other.guestProof}`, guestProof: other.guestProof })) }
        : {}),
    }) satisfies SfuAuthPayload;

  it("a denial that reaches a tab later keeps its time: a request made after it still waits", async () => {
    const { state, room, host, second } = await bothKnock();
    await hostAsks(host, "rejectUser", { userId: tabA.userId });
    // A fresh request under pass B, made after the denial.
    const freshUnderB = { ...tabB, userId: "guest-gp_tab-3-under-pass-B", sessionId: "tab-3" } satisfies SfuAuthPayload;
    const fresh = await join(state, freshUnderB);
    expect(fresh.ack).toHaveBeenCalledWith(waiting);

    // A reload shows the room passes A and B: B's old request gets the denial.
    await join(state, tabAShowingBothPasses);
    expect(second.peer.emit).toHaveBeenCalledWith(...turnedAway);
    expect(fresh.peer.emit).not.toHaveBeenCalledWith(...turnedAway);
    // Another tab then shows the room pass C as well.
    await join(state, tabUnderC("tab-4", [tabA]));

    expect(fresh.peer.emit).not.toHaveBeenCalledWith(...turnedAway);
    expect(room.pendingClients.has(freshUnderB.userId)).toBe(true);
  });

  it("an admission that reaches a tab later keeps its time: a later denial still wins", async () => {
    const { state, room, host } = await bothKnock();
    await hostAsks(host, "admitUser", { userId: tabA.userId });
    const firstUnderC = await join(state, tabUnderC("tab-3"));
    await hostAsks(host, "rejectUser", { userId: tabUnderC("tab-3").userId });
    expect(firstUnderC.peer.emit).toHaveBeenCalledWith(...turnedAway);
    const fresh = await join(state, tabUnderC("tab-5"));

    // A reload shows the room passes A and B: B's old request gets the admission.
    await join(state, tabAShowingBothPasses);
    // Another tab then shows the room pass C as well. The host's latest
    // answer to this guest is the denial, which this request came after.
    await join(state, tabUnderC("tab-4", [tabA]));

    expect(fresh.peer.emit).not.toHaveBeenCalledWith(...approved);
    expect(room.pendingClients.has(tabUnderC("tab-5").userId)).toBe(true);
  });

  it("admitted under one pass and denied under the other, then linked: the later denial wins (Daybreak)", async () => {
    const { state, room, host } = await bothKnock();
    await hostAsks(host, "admitUser", { userId: tabA.userId });
    await hostAsks(host, "rejectUser", { userId: tabB.userId });

    // A new tab shows the room both passes, and B's tab tries again.
    const linking = await join(state, {
      ...tabA,
      userId: "guest-gp_tab-3-under-pass-A",
      sessionId: "tab-3",
      guestWas: [{ userKey: "guest-gp_tab-3-under-pass-B", guestProof: tabB.guestProof }],
    });
    const retry = await join(state, tabB);

    expect(linking.ack).toHaveBeenCalledWith(waiting);
    expect(retry.ack).toHaveBeenCalledWith(waiting);
    expect(room.isLockedAllowed(tabB.userId, tabB.guestProof)).toBe(false);
    expect(room.isAllowed(tabB.userId, tabB.guestProof)).toBe(false);
    expect(screenOf(host)).toEqual(["guest-gp_tab-3-under-pass-A"]);
    expect(toPendingUserSnapshots(room).map((row) => row.userId)).toEqual(screenOf(host));
  });

  it("denied, a fresh knock behind an older waiting tab, then linked: the fresh request takes the row (Astra)", async () => {
    const { state, room, host, second } = await bothKnock();
    await hostAsks(host, "rejectUser", { userId: tabA.userId });
    const freshUnderB = { ...tabB, userId: "guest-gp_tab-3-under-pass-B", sessionId: "tab-3" } satisfies SfuAuthPayload;
    const fresh = await join(state, freshUnderB);
    expect(screenOf(host)).toEqual([tabB.userId]);

    await join(state, {
      ...tabA,
      userId: "guest-gp_tab-4-under-pass-A",
      sessionId: "tab-4",
      guestWas: [{ userKey: "guest-gp_tab-4-under-pass-B", guestProof: tabB.guestProof }],
    });

    expect(second.peer.emit).toHaveBeenCalledWith(...turnedAway);
    expect(fresh.peer.emit).not.toHaveBeenCalledWith(...turnedAway);
    expect(screenOf(host)).toEqual([freshUnderB.userId]);
    expect(toPendingUserSnapshots(room).map((row) => row.userId)).toEqual([freshUnderB.userId]);
    expect(room.waitingGuestCount).toBe(1);
  });

  // The room keeps a lobby decision record of `limit` passes and keys.
  const withDecisionRecordLimit = async (limit: number, body: () => Promise<void>) => {
    const before = sfuConfig.lobbyDecisionRecordLimit;
    sfuConfig.lobbyDecisionRecordLimit = limit;
    try {
      await body();
    } finally {
      sfuConfig.lobbyDecisionRecordLimit = before;
    }
  };
  const otherGuest = (index: number) =>
    ({
      userId: `guest-gp_other-guest-${index}`,
      clientId: "conclave",
      sessionId: `other-${index}`,
      guestProof: `proof-of-other-pass-${index}`,
      guestRoom: "room",
    }) satisfies SfuAuthPayload;

  it("admitted under one pass and denied under the other stays refused once the record is full (Greptile)", async () => {
    await withDecisionRecordLimit(4, async () => {
      const { state, room, host } = await bothKnock();
      await hostAsks(host, "admitUser", { userId: tabA.userId });
      await hostAsks(host, "rejectUser", { userId: tabB.userId });
      const linking = await join(state, {
        ...tabA,
        userId: "guest-gp_tab-3-under-pass-A",
        sessionId: "tab-3",
        guestWas: [{ userKey: "guest-gp_tab-3-under-pass-B", guestProof: tabB.guestProof }],
      });
      expect(linking.ack).toHaveBeenCalledWith(waiting);

      // Enough other decisions to fill the record, and one more.
      for (let index = 0; index < 3; index += 1) {
        await join(state, otherGuest(index));
        await hostAsks(host, "admitUser", { userId: otherGuest(index).userId });
      }
      const retry = await join(state, tabB);

      expect(retry.ack).toHaveBeenCalledWith(waiting);
      expect(room.isLockedAllowed(tabB.userId, tabB.guestProof)).toBe(false);
      expect(room.isAllowed(tabB.userId, tabB.guestProof)).toBe(false);
    });
  });

  it("fails closed when the record holds only refusals: the host is told, nothing changes, and the request still waits (Astra)", async () => {
    await withDecisionRecordLimit(2, async () => {
      const warn = vi.spyOn(Logger, "warn");
      const { state, room, host, first } = await bothKnock();
      await hostAsks(host, "rejectUser", { userId: tabA.userId });
      await hostAsks(host, "rejectUser", { userId: tabB.userId });
      const third = await join(state, otherGuest(0));

      const answer = await hostAsks(host, "admitUser", { userId: otherGuest(0).userId });
      const back = await join(state, otherGuest(0));

      expect(answer).toHaveBeenCalledWith({
        success: false,
        code: "DECISION_RECORD_FULL",
        error: "Couldn't admit: this meeting has reached its limit of host decisions.",
      });
      expect(third.peer.emit).not.toHaveBeenCalledWith(...approved);
      expect(back.ack).toHaveBeenCalledWith(waiting);
      expect([...room.pendingClients.keys()]).toContain(otherGuest(0).userId);
      expect(screenOf(host)).toContain(otherGuest(0).userId);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("full of refusals"));
      expect(first.peer.emit).toHaveBeenCalledWith(...turnedAway);
      expect(room.isLockedAllowed(tabA.userId, tabA.guestProof)).toBe(false);
      warn.mockRestore();
    });
  });

  it("a denial does not turn away a tab that knocks after it", async () => {
    const { state, room, host } = await bothKnock();
    await hostAsks(host, "rejectUser", { userId: tabA.userId });
    await hostAsks(host, "rejectUser", { userId: tabB.userId });

    const knocksAgain = await join(state, tabBShowingBothPasses);

    expect(knocksAgain.ack).toHaveBeenCalledWith(waiting);
    expect(knocksAgain.peer.emit).not.toHaveBeenCalledWith(...turnedAway);
    expect([...room.pendingClients.keys()]).toEqual([tabB.userId]);
    expect(screenOf(host)).toEqual([tabB.userId]);
  });

  it("an admission that a host took back does not let the waiting tab in", async () => {
    const { state, room, host, second } = await bothKnock();
    await hostAsks(host, "admitUser", { userId: tabA.userId });
    room.revokeLockedAllowedUser(tabA.userId);
    room.revokeAllowedUser(tabA.userId);

    await join(state, tabAShowingBothPasses);

    expect(second.peer.emit).not.toHaveBeenCalledWith(...approved);
    expect(room.pendingClients.has(tabB.userId)).toBe(true);
  });
});

describe("what a join costs a room with a large lobby", () => {
  const hostTab = { ...guestHost, guestRoom: "room" } satisfies SfuAuthPayload;
  const waiter = (order: number, pass = order) =>
    ({
      userId: `guest-gp_waiting-tab-${order}`,
      clientId: "conclave",
      sessionId: `tab-${order}`,
      guestProof: `proof-of-pass-${pass}`,
      guestRoom: "room",
    }) satisfies SfuAuthPayload;
  const lockedRoomWith = async (waiting: number) => {
    const state = makeState();
    const host = await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    room.setLocked(true);
    for (let order = 0; order < waiting; order += 1) await join(state, waiter(order));
    return { state, room, host };
  };
  // The lobby as a slow reading of the room gives it: one row per guest,
  // found by going through every pass the room knows.
  const rowsTheSlowWay = (room: Room): string[] => {
    const rows: string[] = [];
    const covered = new Set<string>();
    for (const request of room.pendingClients.values()) {
      if (covered.has(request.userKey)) continue;
      rows.push(request.userKey);
      for (const userKey of room.identitiesOfSameGuest(request.userKey)) covered.add(userKey);
    }
    return rows;
  };

  it("does not go through the lobby, or the passes on record, for a join that links nothing", async () => {
    const { state, room } = await lockedRoomWith(6);
    const lobby = vi.spyOn(room, "waitingGuests");
    const passes = vi.spyOn(room, "identitiesOfSameGuest");

    const knock = await join(state, waiter(100));

    expect(knock.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting" }));
    expect(lobby).not.toHaveBeenCalled();
    expect(passes).not.toHaveBeenCalled();
  });

  it("builds the hosts' lobby without going through the passes on record", async () => {
    const { state, room } = await lockedRoomWith(6);
    await join(state, { ...waiter(101, 2), guestWas: undefined });
    const passes = vi.spyOn(room, "identitiesOfSameGuest");

    const rows = toPendingUserSnapshots(room).map((row) => row.userId);

    expect(rows).toHaveLength(6);
    expect(passes).not.toHaveBeenCalled();
  });

  it("tells the hosts which rows go when a join links passes, without reading the whole lobby", async () => {
    const { state, room, host } = await lockedRoomWith(6);
    const lobby = vi.spyOn(room, "waitingGuests");

    await join(state, {
      ...waiter(102, 1),
      guestWas: [{ userKey: "guest-gp_tab-102-under-pass-4", guestProof: "proof-of-pass-4" }],
    });

    expect(lobby).not.toHaveBeenCalled();
    expect(host.peer.emit).toHaveBeenCalledWith("pendingUserLeft", { userId: waiter(4).userId, roomId: "room" });
    expect(rowsTheSlowWay(room)).toEqual([0, 1, 2, 3, 5].map((order) => waiter(order).userId));
  });

  it("shows the same lobby as a slow reading of the room, through knocks, links, admits, denials and tabs that leave", async () => {
    const { state, room, host } = await lockedRoomWith(0);
    let seed = 20261122;
    const pick = (below: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % below;
    };
    const hostAsks = async (event: string, payload: unknown) =>
      host.peer.handlers.get(event)!(...([payload, vi.fn()] as never[]));

    for (let step = 0; step < 240; step += 1) {
      const waitingKeys = [...room.pendingClients.keys()];
      const action = pick(10);
      if (action < 5 || waitingKeys.length === 0) {
        const pass = pick(12);
        const linkTo = pick(12);
        await join(state, {
          ...waiter(1000 + step, pass),
          ...(pick(3) === 0 && linkTo !== pass
            ? { guestWas: [{ userKey: `guest-gp_tab-${1000 + step}-under-${linkTo}`, guestProof: `proof-of-pass-${linkTo}` }] }
            : {}),
        });
      } else if (action < 7) {
        withdrawWaitingRequest(room, waitingKeys[pick(waitingKeys.length)]);
      } else if (action < 9) {
        await hostAsks("admitUser", { userId: waitingKeys[pick(waitingKeys.length)] });
      } else {
        await hostAsks("rejectUser", { userId: waitingKeys[pick(waitingKeys.length)] });
      }
      await endOfTurn();

      expect(toPendingUserSnapshots(room).map((row) => row.userId)).toEqual(rowsTheSlowWay(room));
      for (const userKey of room.pendingClients.keys()) {
        const sameGuest = new Set(room.identitiesOfSameGuest(userKey));
        expect(room.waitingRequestsOfGuest(userKey).map((request) => request.userKey)).toEqual(
          [...room.pendingClients.keys()].filter((key) => sameGuest.has(key)),
        );
      }
    }
  });
});

describe("a removal of a tab whose pass the room links later", () => {
  const hostTab = { ...guestHost, guestRoom: "room" } satisfies SfuAuthPayload;
  const tabA = {
    userId: "guest-gp_tab-1-under-pass-A",
    clientId: "conclave",
    sessionId: "tab-1",
    guestProof: "proof-of-pass-A",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  const tabB = {
    userId: "guest-gp_tab-2-under-pass-B",
    clientId: "conclave",
    sessionId: "tab-2",
    guestProof: "proof-of-pass-B",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  const waiting: unknown = expect.objectContaining({ status: "waiting" });
  const hostAsks = async (host: Awaited<ReturnType<typeof join>>, event: string, payload: unknown) => {
    const ack = vi.fn();
    await host.peer.handlers.get(event)!(...([payload, ack] as never[]));
    return ack.mock.calls[0]?.[0] as { error?: string } | undefined;
  };

  it.each([
    ["a lock that records nothing for the tabs already in (Greptile)", (room: Room) => room.setLocked(true)],
    ["the host's lock, which admits the tabs already in", undefined],
  ] as const)("still refuses the guest once its passes link, after %s", async (_label, lock) => {
    const state = makeState();
    const host = await join(state, hostTab);
    const room = state.rooms.get("conclave:room")!;
    // Tab B comes into the open room under pass B.
    expect((await join(state, tabB)).ack).toHaveBeenCalledWith(joined);
    if (lock) lock(room);
    else expect(await hostAsks(host, "lockRoom", { locked: true })).not.toHaveProperty("error");
    // Tab A knocks under pass A, which the room cannot tell is the same guest, and is admitted.
    expect((await join(state, tabA)).ack).toHaveBeenCalledWith(waiting);
    expect(await hostAsks(host, "admitUser", { userId: tabA.userId })).not.toHaveProperty("error");

    expect(await hostAsks(host, "kickUser", { userId: `${tabB.userId}#${tabB.sessionId}` })).not.toHaveProperty("error");
    await endOfTurn();
    const back = await join(state, {
      ...tabB,
      guestWas: [{ userKey: "guest-gp_tab-2-under-pass-A", guestProof: tabA.guestProof }],
    });

    expect(back.ack).toHaveBeenCalledWith(waiting);
    expect(room.isLockedAllowed(tabB.userId, tabB.guestProof)).toBe(false);
    expect(room.isLockedAllowed(tabA.userId, tabA.guestProof)).toBe(false);
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

describe("the room's last co-host, blocked through a pass link", () => {
  const coHostTab = {
    userId: "guest-gp_last-co-host-tab-1",
    clientId: "conclave",
    sessionId: "co-1",
    guestProof: "proof-of-the-last-co-host-pass",
  } satisfies SfuAuthPayload;
  const otherTab = { ...coHostTab, userId: "guest-gp_last-co-host-tab-2", sessionId: "co-2" } satisfies SfuAuthPayload;
  const blockedTab = {
    userId: "guest-gp_last-co-host-blocked-tab",
    clientId: "conclave",
    sessionId: "co-3",
    guestProof: "proof-of-its-blocked-pass",
  } satisfies SfuAuthPayload;
  const bystander = {
    userId: "guest-gp_bystander",
    clientId: "conclave",
    sessionId: "by-1",
    guestProof: "proof-of-a-bystander-pass",
  } satisfies SfuAuthPayload;
  const seatOf = (user: SfuAuthPayload) => `${user.userId}#${user.sessionId}`;
  const ask = async (peer: { handlers: Map<string, Handler> }, event: string, payload: unknown) => {
    const ack = vi.fn();
    await peer.handlers.get(event)!(...([payload, ack] as never[]));
    return ack;
  };

  // Socket.IO runs the disconnect handler inside a server-side disconnect.
  const disconnectsLikeSocketIo = (joined: Awaited<ReturnType<typeof join>>) => {
    registerDisconnectHandlers(joined.context);
    joined.peer.disconnect.mockImplementation(() => {
      (joined.peer.socket as { connected: boolean }).connected = false;
      void joined.peer.handlers.get("disconnect")?.(...(["server namespace disconnect"] as never[]));
    });
    return joined;
  };

  it("hands the room to someone else, and the guest holds no host right once the block is lifted (Greptile)", async () => {
    const state = makeState();
    const host = await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    disconnectsLikeSocketIo(await join(state, coHostTab));
    disconnectsLikeSocketIo(await join(state, otherTab));
    expect(await ask(host.peer, "promoteHost", { userId: seatOf(coHostTab) })).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    await join(state, blockedTab);
    blockUserKey(room, blockedTab.userId, { reason: "Blocked by host", kickPresent: true, io, state });
    await join(state, bystander);
    // The host leaves, so the co-host is the room's last host.
    forceRemoveClientNow({ io, state, room, userId: guestHostSeat });
    expect(room.getClient(seatOf(coHostTab))).toBeInstanceOf(Admin);
    expect(room.getClient(seatOf(otherTab))).not.toBeInstanceOf(Admin);

    // A third tab of the guest's browser shows the blocked pass.
    const linking = await join(state, {
      ...coHostTab,
      userId: "guest-gp_last-co-host-tab-3",
      sessionId: "co-4",
      guestWas: [{ userKey: "guest-gp_last-co-host-tab-4", guestProof: blockedTab.guestProof }],
    });

    expect(linking.ack).toHaveBeenCalledWith(refused);
    expect(room.getClient(seatOf(coHostTab))).toBeUndefined();
    expect(room.getClient(seatOf(otherTab))).toBeUndefined();
    expect(room.getClient(seatOf(bystander))).toBeInstanceOf(Admin);
    expect(room.isAdminUserKey(otherTab.userId, otherTab.guestProof)).toBe(false);

    // Another host comes back and lifts the block.
    const hostAgain = await join(state, guestHost);
    expect(await ask(hostAgain.peer, "admin:unblockUsers", { userKeys: [blockedTab.userId] })).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    await endOfTurn();

    expect(room.isAdminUserKey(otherTab.userId, otherTab.guestProof)).toBe(false);
    expect(room.isAdminUserKey(coHostTab.userId, coHostTab.guestProof)).toBe(false);
    const back = await join(state, otherTab);
    expect(back.ack).toHaveBeenCalledWith(joined);
    expect(back.context.currentClient).not.toBeInstanceOf(Admin);
  });

  it("does not hand the room to another tab of a co-host removed as its last host", async () => {
    const state = makeState();
    const host = await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    await join(state, coHostTab);
    await join(state, otherTab);
    await join(state, bystander);
    expect(await ask(host.peer, "promoteHost", { userId: seatOf(coHostTab) })).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    forceRemoveClientNow({ io, state, room, userId: guestHostSeat });

    // An operator removes the co-host while no other host is in.
    expect(kickClient(room, seatOf(coHostTab), "Removed by host", { io, state })).toBe(true);

    expect(room.getClient(seatOf(otherTab))).not.toBeInstanceOf(Admin);
    expect(room.isAdminUserKey(otherTab.userId, otherTab.guestProof)).toBe(false);
    expect(room.getClient(seatOf(bystander))).toBeInstanceOf(Admin);
  });
});

describe("what a refused join leaves behind", () => {
  const guestOf = (name: string, extra: Omit<Partial<SfuAuthPayload>, "userId" | "guestProof"> = {}) =>
    ({
      userId: `guest-gp_${name}`,
      clientId: "conclave",
      sessionId: name,
      guestProof: `proof-of-${name}`,
      ...extra,
    }) satisfies SfuAuthPayload;
  const shows = (...seats: SfuAuthPayload[]) =>
    seats.map((seat) => ({ userKey: seat.userId!, guestProof: seat.guestProof! }));

  it("keeps a blocked guest's pass links as they are when it comes back under 200 fresh passes (Daybreak)", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const blocked = guestOf("daybreak-blocked");
    await join(state, blocked);
    blockUserKey(room, blocked.userId, { reason: "Blocked by host", kickPresent: true, io, state });
    await endOfTurn();
    const sizes = () => ({
      links: room.linkedGuestPassCount,
      decisions: room.decisionRecordCount,
      bindings: room.boundGuestIdentityCount,
      waiting: room.pendingClients.size,
      seats: room.clients.size,
    });
    const before = sizes();

    for (let index = 0; index < 200; index += 1) {
      const attempt = await join(state, guestOf(`daybreak-fresh-${index}`, { guestWas: shows(blocked) }));
      expect(attempt.ack).toHaveBeenCalledWith(refused);
    }
    await endOfTurn();

    expect(sizes()).toEqual(before);
  });

  it("records no link that would make one guest of more than 16 passes, and drops none it has", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const guests = Array.from({ length: 17 }, (_, index) => guestOf(`cap-${index}`));
    for (const guest of guests) await join(state, guest);
    const [first, ...rest] = guests;
    const last = rest.pop()!;

    const full = await join(state, { ...first, userId: `${first.userId}-tab-2`, sessionId: "cap-0-tab-2", guestWas: shows(...rest) });
    expect(full.ack).toHaveBeenCalledWith(joined);
    expect(room.linkedGuestPassCount).toBe(16);

    const over = await join(state, { ...last, userId: `${last.userId}-tab-2`, sessionId: "cap-16-tab-2", guestWas: shows(first) });
    expect(over.ack).toHaveBeenCalledWith(joined);
    expect(room.linkedGuestPassCount).toBe(16);
    expect(room.identitiesOfSameGuest(first.userId)).not.toContain(last.userId);
    expect(room.identitiesOfSameGuest(first.userId)).toContain(rest[0].userId);

    // A block on the full guest still reaches a join that shows its pass.
    blockUserKey(room, rest[0].userId, { reason: "Blocked by host", kickPresent: true, io, state });
    const shownAgain = await join(state, { ...last, userId: `${last.userId}-tab-3`, sessionId: "cap-16-tab-3", guestWas: shows(first) });
    expect(shownAgain.ack).toHaveBeenCalledWith(refused);
    expect(room.linkedGuestPassCount).toBe(16);
  });

  const withLimits = async (limits: { waiting?: number; seats?: number }, body: () => Promise<void>) => {
    const before = { waiting: sfuConfig.waitingRequestLimit, seats: sfuConfig.meetingSeatLimit };
    sfuConfig.waitingRequestLimit = limits.waiting ?? before.waiting;
    sfuConfig.meetingSeatLimit = limits.seats ?? before.seats;
    try {
      await body();
    } finally {
      sfuConfig.waitingRequestLimit = before.waiting;
      sfuConfig.meetingSeatLimit = before.seats;
    }
  };

  it("refuses a new request past the waiting room's limit and records nothing for it", async () => {
    await withLimits({ waiting: 2 }, async () => {
      const state = makeState();
      await join(state, guestHost);
      const room = state.rooms.get("conclave:room")!;
      room.setLocked(true);
      const waiting = expect.objectContaining({ status: "waiting" }) as unknown;
      expect((await join(state, guestOf("wait-a"))).ack).toHaveBeenCalledWith(waiting);
      expect((await join(state, guestOf("wait-b"))).ack).toHaveBeenCalledWith(waiting);
      await endOfTurn();
      const before = { bindings: room.boundGuestIdentityCount, waitingCount: room.pendingClients.size };

      const third = await join(state, guestOf("wait-c"));
      await endOfTurn();

      expect(third.ack).toHaveBeenCalledWith({ error: "The waiting room is full. Try again in a moment." });
      expect({ bindings: room.boundGuestIdentityCount, waitingCount: room.pendingClients.size }).toEqual(before);
      expect((await join(state, guestOf("wait-a"))).ack).toHaveBeenCalledWith(waiting);
    });
  });

  it("refuses a new seat past the meeting's limit, but not a tab coming back to its seat or a host", async () => {
    await withLimits({ seats: 2 }, async () => {
      const state = makeState();
      const host = await join(state, guestHost);
      const room = state.rooms.get("conclave:room")!;
      const seated = guestOf("seat-a");
      expect((await join(state, seated)).ack).toHaveBeenCalledWith(joined);
      await endOfTurn();
      const before = { bindings: room.boundGuestIdentityCount, seats: room.clients.size };

      const third = await join(state, guestOf("seat-b"));
      await endOfTurn();

      expect(third.ack).toHaveBeenCalledWith({ error: "This meeting is full." });
      expect({ bindings: room.boundGuestIdentityCount, seats: room.clients.size }).toEqual(before);
      expect((await join(state, seated)).ack).toHaveBeenCalledWith(joined);
      dropConnection(host.peer);
      expect((await join(state, guestHost)).ack).toHaveBeenCalledWith(joined);
    });
  });

  it("counts a tab that moves from the audience to the meeting against the meeting's limit (Greptile)", async () => {
    await withLimits({ seats: 2 }, async () => {
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
      expect((await join(state, guestOf("seat-a"))).ack).toHaveBeenCalledWith(joined);
      const account = { email: "alice@example.com", userId: "alice@example.com", clientId: "conclave", sessionId: "alice-1" } satisfies SfuAuthPayload;
      const watching = await join(state, { ...account, joinMode: "webinar_attendee" }, "launch");
      expect(watching.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "joined", webinarRole: "attendee" }));

      const toTheMeeting = await join(state, account);

      expect(toTheMeeting.ack).toHaveBeenCalledWith({ error: "This meeting is full." });
      expect(room.clients.size - room.getWebinarAttendeeCount()).toBe(2);
    });
  });
});

describe("a host action when the decision record is full of refusals (Astra)", () => {
  const full = {
    success: false,
    code: "DECISION_RECORD_FULL",
    error: "Couldn't admit: this meeting has reached its limit of host decisions.",
  };
  const guestOf = (name: string, extra: Omit<Partial<SfuAuthPayload>, "userId" | "guestProof"> = {}) =>
    ({
      userId: `guest-gp_${name}`,
      clientId: "conclave",
      sessionId: name,
      guestProof: `proof-of-${name}`,
      guestRoom: "room",
      ...extra,
    }) satisfies SfuAuthPayload;
  const ask = async (peer: { handlers: Map<string, Handler> }, event: string, ...payload: unknown[]) => {
    const ack = vi.fn();
    await peer.handlers.get(event)!(...([...payload, ack] as never[]));
    return ack;
  };
  const approved = ["joinApproved", { roomId: "room" }] as const;
  const waiting: unknown = expect.objectContaining({ status: "waiting" });

  // A locked room whose record holds two refusals and so has no room left,
  // and a guest who waits to be let in.
  const fullRoom = async (body: (room: Room, state: SfuState, host: Awaited<ReturnType<typeof join>>, waitingGuest: Awaited<ReturnType<typeof join>>) => Promise<void>) => {
    const limitBefore = sfuConfig.lobbyDecisionRecordLimit;
    sfuConfig.lobbyDecisionRecordLimit = 2;
    try {
      const state = makeState();
      const host = await join(state, guestHost);
      const room = state.rooms.get("conclave:room")!;
      room.setLocked(true);
      for (const name of ["turned-away-1", "turned-away-2"]) {
        await join(state, guestOf(name));
        expect(await ask(host.peer, "rejectUser", { userId: guestOf(name).userId })).toHaveBeenCalledWith({ success: true });
      }
      const waitingGuest = await join(state, guestOf("knocks"));
      expect(waitingGuest.ack).toHaveBeenCalledWith(waiting);
      await body(room, state, host, waitingGuest);
    } finally {
      sfuConfig.lobbyDecisionRecordLimit = limitBefore;
    }
  };
  const stillWaits = (room: Room, waitingGuest: Awaited<ReturnType<typeof join>>) => {
    expect([...room.pendingClients.keys()]).toContain(guestOf("knocks").userId);
    expect(waitingGuest.peer.emit).not.toHaveBeenCalledWith(...approved);
    expect(room.isLockedAllowed(guestOf("knocks").userId, guestOf("knocks").guestProof)).toBe(false);
  };

  it("still takes back a denial and invites a demoted guest again once refusals are past the limit (Greptile)", async () => {
    await fullRoom(async (room, state, host, waitingGuest) => {
      const config = getOrCreateWebinarRoomConfig(state.webinarConfigs, room.channelId);
      config.enabled = true;
      config.publicAccess = true;
      setCustomWebinarLinkSlug({
        webinarConfig: config,
        webinarLinks: state.webinarLinks,
        room: { channelId: room.channelId, id: room.id, clientId: room.clientId },
        slug: "launch",
      });
      const { guestRoom: _room, ...attendeeOfTheRoom } = guestOf("demoted-speaker");
      const attendee = { ...attendeeOfTheRoom, joinMode: "webinar_attendee" } satisfies SfuAuthPayload;
      const viewer = await join(state, attendee, "launch");
      room.markWebinarDemotedUserKey(attendee.userId);
      expect(await ask(host.peer, "rejectUser", { userId: guestOf("knocks").userId })).toHaveBeenCalledWith({ success: true });
      expect(waitingGuest.peer.emit).toHaveBeenCalledWith("joinRejected", { roomId: "room" });
      expect(room.decisionRecordCount).toBeGreaterThan(2);

      const back = await join(state, guestOf("turned-away-1"));
      expect(back.ack).toHaveBeenCalledWith(waiting);
      expect(await ask(host.peer, "admitUser", { userId: guestOf("turned-away-1").userId })).toHaveBeenCalledWith({ success: true });
      expect(back.peer.emit).toHaveBeenCalledWith(...approved);

      registerWebinarInteractionHandlers(host.context);
      expect(await ask(host.peer, "webinar:promoteAttendee", { userId: `${attendee.userId}#${attendee.sessionId}` })).toHaveBeenCalledWith({ success: true });
      expect(viewer.peer.emit).toHaveBeenCalledWith("webinar:promoted", expect.anything());
      expect(room.isWebinarDemotedUserKey(attendee.userId, attendee.guestProof)).toBe(false);
    });
  });

  it("fails admitting everyone who waits, and lets no one in", async () => {
    await fullRoom(async (room, _state, host, waitingGuest) => {
      expect(await ask(host.peer, "admin:admitAllPending")).toHaveBeenCalledWith(full);
      stillWaits(room, waitingGuest);
    });
  });

  it("fails admitting by key, lets no one in, and lifts no block", async () => {
    await fullRoom(async (room, state, host, waitingGuest) => {
      const blocked = guestOf("blocked-before");
      await join(state, { ...blocked, guestRoom: "room" });
      blockUserKey(room, blocked.userId, { reason: "Blocked by host", kickPresent: false, io, state });

      const answer = await ask(host.peer, "admin:allowUsers", { userKeys: [guestOf("knocks").userId, blocked.userId] });

      expect(answer).toHaveBeenCalledWith(expect.objectContaining({ ...full, allowed: [], admitted: [] }));
      stillWaits(room, waitingGuest);
      expect(room.isBlocked(blocked.userId, blocked.guestProof)).toBe(true);
    });
  });

  it("fails a stage invite, and the attendee is not invited", async () => {
    await fullRoom(async (room, state, host, _waitingGuest) => {
      const config = getOrCreateWebinarRoomConfig(state.webinarConfigs, room.channelId);
      config.enabled = true;
      config.publicAccess = true;
      setCustomWebinarLinkSlug({
        webinarConfig: config,
        webinarLinks: state.webinarLinks,
        room: { channelId: room.channelId, id: room.id, clientId: room.clientId },
        slug: "launch",
      });
      const { guestRoom: _room, ...attendeeOfTheRoom } = guestOf("in-the-audience");
      const attendee = { ...attendeeOfTheRoom, joinMode: "webinar_attendee" } satisfies SfuAuthPayload;
      const viewer = await join(state, attendee, "launch");
      expect(viewer.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "joined", webinarRole: "attendee" }));
      registerWebinarInteractionHandlers(host.context);

      const answer = await ask(host.peer, "webinar:promoteAttendee", { userId: `${attendee.userId}#${attendee.sessionId}` });

      expect(answer).toHaveBeenCalledWith({ ...full, error: "Couldn't invite: this meeting has reached its limit of host decisions." });
      expect(viewer.peer.emit).not.toHaveBeenCalledWith("webinar:promoted", expect.anything());
      expect(room.isWebinarPromotedUserKey(attendee.userId)).toBe(false);
    });
  });

  it("fails each HTTP admission with a 409 and the same code, and lets no one in", async () => {
    await fullRoom(async (room, state, _host, waitingGuest) => {
      const server = createServer(createSfuApp({ state, getIo: () => io }));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/rooms/room`;
        const post = (path: string, body: unknown = {}) =>
          fetch(`${base}${path}?clientId=conclave`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-sfu-secret": sfuConfig.sfuSecret },
            body: JSON.stringify(body),
          });
        for (const response of [
          await post(`/pending/${encodeURIComponent(guestOf("knocks").userId)}/admit`),
          await post("/pending/admit-all"),
          await post("/access/allow", { userKeys: [guestOf("knocks").userId] }),
        ]) {
          expect(response.status).toBe(409);
          expect(await response.json()).toEqual(expect.objectContaining(full));
        }
        stillWaits(room, waitingGuest);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});

describe("a host who lets in one guest by more than one key", () => {
  it("tells each waiting tab once (Greptile)", async () => {
    const state = makeState();
    const host = await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    room.setLocked(true);
    const tabOne = {
      userId: "guest-gp_named-twice-tab-1",
      clientId: "conclave",
      sessionId: "named-twice-1",
      guestProof: "proof-of-the-named-twice-pass",
      guestRoom: "room",
    } satisfies SfuAuthPayload;
    const tabTwo = { ...tabOne, userId: "guest-gp_named-twice-tab-2", sessionId: "named-twice-2" } satisfies SfuAuthPayload;
    const one = await join(state, tabOne);
    const two = await join(state, tabTwo);
    const waiting: unknown = expect.objectContaining({ status: "waiting" });
    expect(one.ack).toHaveBeenCalledWith(waiting);
    expect(two.ack).toHaveBeenCalledWith(waiting);

    const ack = vi.fn();
    await host.peer.handlers.get("admin:allowUsers")!(...([{ userKeys: [tabOne.userId, tabTwo.userId] }, ack] as never[]));

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const approvals = (peer: typeof one.peer) =>
      (peer.emit.mock.calls as Array<[string, ...unknown[]]>).filter(([event]) => event === "joinApproved").length;
    expect([approvals(one.peer), approvals(two.peer)]).toEqual([1, 1]);
  });
});

describe("what ending a seat releases", () => {
  // A transcript relay that counts the audio it would send the worker: each
  // sync stands for the relay taking the room's producers and sending on.
  const relayRig = (state: SfuState) => {
    const relays: Array<{ controllerUserId: string; closed: boolean; audioSent: number }> = [];
    state.transcriptRelays = createTranscriptRelayRegistry({
      enabled: true,
      createRelay: (options) => {
        const relay = { controllerUserId: options.controllerUserId, closed: false, audioSent: 0 };
        relays.push(relay);
        return {
          controllerUserId: options.controllerUserId,
          start: async () => {},
          prepareHandoff: async () => true,
          syncProducers: async () => {
            if (!relay.closed) relay.audioSent += 1;
          },
          close: () => {
            relay.closed = true;
          },
        };
      },
    });
    return relays;
  };
  const tabOf = (name: string, guestProof = `proof-of-${name}`) =>
    ({
      userId: `guest-gp_${name}`,
      clientId: "conclave",
      sessionId: name,
      guestProof,
      guestRoom: "room",
    }) satisfies SfuAuthPayload;
  const seatOf = (user: SfuAuthPayload) => `${user.userId}#${user.sessionId}`;
  const relayRun = async (state: SfuState, room: Room, controller: SfuAuthPayload) => {
    const started = await state.transcriptRelays.start({
      room,
      workerUrl: "http://worker.test",
      workerToken: "worker-token",
      controllerUserId: seatOf(controller),
      controllerDisplayName: "Controller",
      canReplaceExistingRelay: false,
    });
    expect(started).toMatchObject({ success: true });
    await state.transcriptRelays.syncRoom(room);
  };
  const stoppedFor = async (state: SfuState, room: Room, relay: { closed: boolean; audioSent: number }) => {
    await vi.waitFor(() => expect(relay.closed).toBe(true));
    const sent = relay.audioSent;
    await state.transcriptRelays.syncRoom(room);
    expect(relay.audioSent).toBe(sent);
    const replacement = await state.transcriptRelays.start({
      room,
      workerUrl: "http://worker.test",
      workerToken: "worker-token",
      controllerUserId: guestHostSeat,
      controllerDisplayName: "Host",
      canReplaceExistingRelay: false,
    });
    expect(replacement).toMatchObject({ success: true });
  };

  it("stops the transcript relay of a controller the host removes, and the worker gets no more of its audio (Greptile)", async () => {
    const state = makeState();
    const relays = relayRig(state);
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const controller = tabOf("relay-controller");
    await join(state, controller);
    await join(state, tabOf("still-speaking"));
    await relayRun(state, room, controller);
    expect(relays[0].audioSent).toBe(1);

    expect(kickClient(room, seatOf(controller), "Removed by host", { io, state })).toBe(true);

    await stoppedFor(state, room, relays[0]);
  });

  it("stops the transcript relay of a controller that a block reaches through a pass link (Greptile)", async () => {
    const state = makeState();
    const relays = relayRig(state);
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const controller = tabOf("relay-controller-2", "proof-of-the-controller-pass");
    const blocked = tabOf("blocked-elsewhere", "proof-of-the-blocked-pass");
    await join(state, controller);
    await join(state, tabOf("still-speaking-2"));
    await join(state, blocked);
    blockUserKey(room, blocked.userId, { reason: "Blocked by host", kickPresent: true, io, state });
    await relayRun(state, room, controller);

    const linking = await join(state, {
      ...controller,
      userId: "guest-gp_relay-controller-2-tab-2",
      sessionId: "relay-controller-2-tab-2",
      guestWas: [{ userKey: blocked.userId, guestProof: blocked.guestProof }],
    });

    expect(linking.ack).toHaveBeenCalledWith(refused);
    expect(room.getClient(seatOf(controller))).toBeUndefined();
    await stoppedFor(state, room, relays[0]);
  });
});

describe("a guest who is a co-host in two tabs, when one tab is removed", () => {
  const tabA = {
    userId: "guest-gp_two-host-tabs-a",
    clientId: "conclave",
    sessionId: "two-host-a",
    guestProof: "proof-of-the-two-host-tabs-pass",
    guestRoom: "room",
  } satisfies SfuAuthPayload;
  const tabB = { ...tabA, userId: "guest-gp_two-host-tabs-b", sessionId: "two-host-b" } satisfies SfuAuthPayload;
  const seatOf = (user: SfuAuthPayload) => `${user.userId}#${user.sessionId}`;
  const ask = async (peer: { handlers: Map<string, Handler> }, event: string, payload: unknown) => {
    const ack = vi.fn();
    await peer.handlers.get(event)!(...([payload, ack] as never[]));
    return ack;
  };
  const coHostInTwoTabs = async () => {
    const state = makeState();
    const host = await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const first = await join(state, tabA);
    expect(await ask(host.peer, "promoteHost", { userId: seatOf(tabA) })).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const second = await join(state, tabB);
    expect(room.getClient(seatOf(tabB))).toBeInstanceOf(Admin);
    expect(second.peer.handlers.has("lockRoom")).toBe(true);
    return { state, host, room, first, second };
  };

  it("leaves the other tab no host command at all (Daybreak)", async () => {
    const { host, room, second } = await coHostInTwoTabs();
    broadcast.mockClear();

    expect(await ask(host.peer, "kickUser", { userId: seatOf(tabA) })).toHaveBeenCalledWith({ success: true });

    expect(room.getClient(seatOf(tabB))).toBeDefined();
    expect(room.getClient(seatOf(tabB))).not.toBeInstanceOf(Admin);
    expect(room.isAdminUserKey(tabB.userId, tabB.guestProof)).toBe(false);
    expect(broadcast).toHaveBeenCalledWith("adminUsersChanged", { roomId: "room", hostUserIds: [guestHostSeat] });

    // Every host command the tab had, from the room's, is refused now.
    const commands = [...second.peer.handlers.keys()].filter((event) => event !== "joinRoom");
    expect(commands.length).toBeGreaterThan(30);
    const payload = {
      userId: guestHostSeat,
      targetUserId: guestHostSeat,
      userKeys: [guestHost.userId],
      locked: true,
      enabled: true,
      disabled: true,
      message: "Taken over",
      reason: "Taken over",
      roomId: "room",
    };
    const accepted: string[] = [];
    for (const event of commands) {
      const handler = second.peer.handlers.get(event)!;
      const ack = vi.fn();
      await (handler.length >= 2 ? handler(...([payload, ack] as never[])) : handler(...([ack] as never[])));
      const answer = ack.mock.calls[0]?.[0] as { error?: unknown; rooms?: Array<{ id: string }> } | undefined;
      // `getRooms` grants nothing: the token, not the seat, decides whether
      // it lists more than the caller's own room.
      if (event === "getRooms") {
        expect(answer?.rooms?.map((listed) => listed.id)).toEqual(["room"]);
        continue;
      }
      if (!answer || typeof answer.error !== "string") accepted.push(event);
    }
    expect(accepted).toEqual([]);
    expect(room.isLocked).toBe(false);
    expect(room.getClient(guestHostSeat)).toBeInstanceOf(Admin);
    registerWebinarInteractionHandlers(second.context);
    expect(await ask(second.peer, "webinar:demoteParticipant", { userId: guestHostSeat })).toHaveBeenCalledWith({ error: "Only hosts can do this" });
  });

  it("keeps a blocked co-host's tab in the room but no longer a host's, when the block does not remove it", async () => {
    const { state, room } = await coHostInTwoTabs();

    blockUserKey(room, tabA.userId, { reason: "Blocked by host", kickPresent: false, io, state });

    for (const tab of [tabA, tabB]) {
      expect(room.getClient(seatOf(tab))).toBeDefined();
      expect(room.getClient(seatOf(tab))).not.toBeInstanceOf(Admin);
    }
    expect(room.getClient(guestHostSeat)).toBeInstanceOf(Admin);
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
      "newer stage invites push its invite out of a full decision record",
      (room) => room.promoteWebinarUserKey(guest.userId),
      (room) => {
        for (let invited = 0; invited < sfuConfig.lobbyDecisionRecordLimit; invited += 1) {
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

describe("what a participant's own action adds to the decision record", () => {
  const withDecisionRecordLimit = async (limit: number, body: () => Promise<void>) => {
    const before = sfuConfig.lobbyDecisionRecordLimit;
    sfuConfig.lobbyDecisionRecordLimit = limit;
    try {
      await body();
    } finally {
      sfuConfig.lobbyDecisionRecordLimit = before;
    }
  };
  const seatOf = (user: SfuAuthPayload) => `${user.userId}#${user.sessionId}`;
  const ask = async (peer: { handlers: Map<string, Handler> }, event: string, ...payload: unknown[]) => {
    const ack = vi.fn();
    await peer.handlers.get(event)!(...([...payload, ack] as never[]));
    return ack;
  };
  const viewer = (index: number) =>
    ({
      userId: `guest-gp_viewer-${index}`,
      clientId: "conclave",
      sessionId: `view-${index}`,
      joinMode: "webinar_attendee",
      guestProof: `proof-of-viewer-pass-${index}`,
    }) satisfies SfuAuthPayload;
  const webinar = async (options: { locked: boolean }) => {
    const state = makeState();
    const host = await join(state, guestHost);
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
    if (options.locked) room.setLocked(true);
    registerWebinarInteractionHandlers(host.context);
    return { state, room, host };
  };
  const inTheAudience = async (state: SfuState, user: SfuAuthPayload) => {
    const attendee = await join(state, user, "launch");
    expect(attendee.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "joined", webinarRole: "attendee" }));
    registerWebinarInteractionHandlers(attendee.context);
    return attendee;
  };

  it("adds nothing when many fresh attendees decline an invite they never had, so hosts can still invite (Greptile)", async () => {
    await withDecisionRecordLimit(3, async () => {
      const { state, room, host } = await webinar({ locked: true });
      const before = room.decisionRecordCount;

      for (let index = 0; index < 8; index += 1) {
        const attendee = await inTheAudience(state, viewer(index));
        expect(await ask(attendee.peer, "webinar:declineStage")).toHaveBeenCalledWith({ success: true });
      }

      expect(room.decisionRecordCount).toBe(before);
      await inTheAudience(state, viewer(99));
      expect(await ask(host.peer, "webinar:promoteAttendee", { userId: seatOf(viewer(99)) })).toHaveBeenCalledWith({ success: true });
      expect(room.isWebinarPromotedUserKey(viewer(99).userId)).toBe(true);
    });
  });

  it("uses up a real invite when its guest declines it, and leaves no refusal behind", async () => {
    await withDecisionRecordLimit(1, async () => {
      const { state, room, host } = await webinar({ locked: true });
      const first = await inTheAudience(state, viewer(1));
      await ask(host.peer, "webinar:promoteAttendee", { userId: seatOf(viewer(1)) });
      expect(room.isWebinarPromotedUserKey(viewer(1).userId)).toBe(true);

      expect(await ask(first.peer, "webinar:declineStage")).toHaveBeenCalledWith({ success: true });

      expect(room.isWebinarPromotedUserKey(viewer(1).userId)).toBe(false);
      const onStage = await join(state, { ...viewer(1), userId: "guest-gp_viewer-1-on-stage", joinMode: "meeting" });
      expect(onStage.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting" }));
      // A declined invite holds no refusal, so it makes room for the next.
      await inTheAudience(state, viewer(2));
      await ask(host.peer, "webinar:promoteAttendee", { userId: seatOf(viewer(2)) });
      expect(room.isWebinarPromotedUserKey(viewer(2).userId)).toBe(true);
    });
  });

  it("adds nothing when a blocked guest comes back under fresh passes", async () => {
    const state = makeState();
    await join(state, guestHost);
    const room = state.rooms.get("conclave:room")!;
    const blocked = {
      userId: "guest-gp_blocked-tab",
      clientId: "conclave",
      sessionId: "blocked-tab",
      guestProof: "proof-of-the-blocked-pass",
    } satisfies SfuAuthPayload;
    await join(state, blocked);
    blockUserKey(room, blocked.userId, { reason: "Blocked by host", kickPresent: true, io, state });
    const before = room.decisionRecordCount;

    for (let index = 0; index < 6; index += 1) {
      const fresh = {
        userId: `guest-gp_fresh-${index}`,
        clientId: "conclave",
        sessionId: `fresh-${index}`,
        guestProof: `proof-of-fresh-pass-${index}`,
      } satisfies SfuAuthPayload;
      const seated = await join(state, fresh);
      expect(seated.ack).toHaveBeenCalledWith(joined);
      const linking = await join(state, {
        ...fresh,
        userId: `guest-gp_fresh-${index}-tab-2`,
        sessionId: `fresh-${index}-tab-2`,
        guestWas: [{ userKey: blocked.userId, guestProof: blocked.guestProof }],
      });

      expect(linking.ack).toHaveBeenCalledWith(refused);
      expect(seated.peer.emit).toHaveBeenCalledWith("kicked", expect.objectContaining({ roomId: "room" }));
      expect(room.getClient(seatOf(fresh))).toBeUndefined();
    }
    expect(room.decisionRecordCount).toBe(before);
  });

  it("keeps a legacy speaker moved back to the audience off the stage when its pass comes back in a new tab (Greptile)", async () => {
    const { state, room, host } = await webinar({ locked: false });
    const legacy = {
      userId: "guest-legacy-speaker",
      clientId: "conclave",
      sessionId: "speaker-1",
      joinMode: "meeting",
      guestProof: "proof-of-the-speaker-pass",
    } satisfies SfuAuthPayload;
    const speaker = await join(state, legacy);
    expect(speaker.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "joined", webinarRole: "participant" }));

    expect(await ask(host.peer, "webinar:demoteParticipant", { userId: seatOf(legacy) })).toHaveBeenCalledWith({ success: true });
    await endOfTurn();
    const newTab = {
      userId: "guest-gp_SSSSSSSSSSSSSSSSSSSSSS",
      clientId: "conclave",
      sessionId: "speaker-2",
      joinMode: "meeting",
      guestProof: legacy.guestProof,
    } satisfies SfuAuthPayload;
    const back = await join(state, newTab);

    expect(back.ack).toHaveBeenCalledWith(expect.objectContaining({ error: "Use the public webinar link to join as an attendee." }));
    expect(room.getClient(seatOf(newTab))).toBeUndefined();
    // The refusal keeps the legacy key bound to its pass.
    expect(room.isGuestKeyOfPass(legacy.userId, legacy.guestProof)).toBe(true);
  });

  it("leaves an account's waiting tab in the lobby when its other tab joins the audience (Greptile)", async () => {
    const { state, room } = await webinar({ locked: true });
    const meetingTab = {
      email: "alice@example.com",
      userId: "alice@example.com",
      clientId: "conclave",
      sessionId: "alice-1",
    } satisfies SfuAuthPayload;
    const waiting = await join(state, meetingTab);
    expect(waiting.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting" }));

    await inTheAudience(state, { ...meetingTab, sessionId: "alice-2", joinMode: "webinar_attendee" });

    expect(room.pendingClients.get(meetingTab.userId)?.userId).toBe(seatOf(meetingTab));
    expect(admitWaitingGuest(room, meetingTab.userId)).toEqual({ ok: true, admitted: [meetingTab.userId] });
    expect(waiting.peer.emit).toHaveBeenCalledWith("joinApproved", { roomId: "room" });
  });
});

describe("who may come in, against a slow reading of every decision", () => {
  // A locked room. Two guest browsers, each with passes the room learns are
  // one guest only when a tab's token names them. Every tab keeps one
  // session on one pass. The oracle below recomputes everything from the
  // whole history on every step, with none of the room's indexes.
  const BROWSERS = [
    ["proof-X1", "proof-X2", "proof-X3"],
    ["proof-Y1", "proof-Y2"],
  ];
  type Tab = { key: string; session: string; pass: string; browser: number };
  const tabs: Tab[] = BROWSERS.flatMap((passes, browser) =>
    passes.flatMap((pass) =>
      [0, 1].map((index) => {
        const session = `b${browser}-${pass.slice(-2)}-s${index}`;
        return { key: `guest-gp_${session}`, session, pass, browser };
      }),
    ),
  );
  const tabByKey = new Map(tabs.map((tab) => [tab.key, tab]));
  const hostPass = "proof-of-the-oracle-host";
  const hostTab = (session: string) =>
    ({
      userId: `guest-gp_host-${session}`,
      clientId: "conclave",
      sessionId: session,
      guestProof: hostPass,
      guestRoom: "room",
      allowRoomCreation: true,
    }) satisfies SfuAuthPayload;

  type Mark = { admitted: boolean; at: number; keys: Set<string> };
  type Scope = "wr" | "lock";
  type PassRecord = { wr?: Mark; lock?: Mark; answer?: { admitted: boolean; at: number } };
  class Oracle {
    constructor(readonly limit?: number) {}
    // Every decision ever made, never trimmed, to check that trimming the
    // room's record never lets in anyone this history refuses.
    full = new Map<string, PassRecord>();
    activity = new Map<string, number>();
    clock = 0;
    locked = true;
    lockedAt = 0;
    root = new Map<string, string>();
    records = new Map<string, PassRecord>();
    blocked = new Set<string>();
    // Keys the room gave host rights to (a host's promotion, a handoff, or
    // a join as a co-host), and the seated tabs that are hosts.
    coHosts = new Set<string>();
    adminSeats = new Set<string>();
    status = new Map<string, "idle" | "pending" | "seated">();
    arrival = new Map<string, number>();
    tick() {
      return (this.clock += 1);
    }
    find(pass: string): string {
      const parent = this.root.get(pass) ?? pass;
      return parent === pass ? pass : this.find(parent);
    }
    group(pass: string): Set<string> {
      const top = this.find(pass);
      return new Set(tabs.map((tab) => tab.pass).filter((other) => this.find(other) === top));
    }
    counts(scope: Scope, mark: Mark | undefined): mark is Mark {
      return mark !== undefined && (scope !== "lock" || mark.at > this.lockedAt);
    }
    named(key: string): boolean {
      const record = this.records.get(tabByKey.get(key)!.pass);
      return (["wr", "lock"] as const).some((scope) => {
        const mark = record?.[scope];
        return this.counts(scope, mark) && mark.admitted && mark.keys.has(key);
      });
    }
    // The keys the room has bound to the guest's passes.
    boundKeys(pass: string): string[] {
      return this.boundKeysOf(this.group(pass));
    }
    boundKeysOf(passes: Set<string>): string[] {
      return tabs
        .filter((tab) => passes.has(tab.pass))
        .filter((tab) => this.status.get(tab.key) === "pending" || this.status.get(tab.key) === "seated" || this.blocked.has(tab.key) || this.named(tab.key) || this.coHosts.has(tab.key))
        .map((tab) => tab.key);
    }
    known(pass: string): boolean {
      return this.records.has(pass) || this.boundKeys(pass).some((key) => tabByKey.get(key)!.pass === pass);
    }
    tabsOfGuest(pass: string, state: "pending" | "seated", passes = this.group(pass)): Tab[] {
      return tabs.filter((tab) => passes.has(tab.pass) && this.status.get(tab.key) === state);
    }
    latestMark(pass: string, scope: Scope, source = this.records): Mark | undefined {
      let latest: Mark | undefined;
      for (const other of this.group(pass)) {
        const mark = source.get(other)?.[scope];
        if (this.counts(scope, mark) && (!latest || mark.at > latest.at)) latest = mark;
      }
      return latest;
    }
    latestAnswer(pass: string) {
      let latest: { admitted: boolean; at: number } | undefined;
      for (const other of this.group(pass)) {
        const answer = this.records.get(other)?.answer;
        if (answer && (!latest || answer.at > latest.at)) latest = answer;
      }
      return latest;
    }
    scopeOfRoom(): Scope {
      return this.locked ? "lock" : "wr";
    }
    admits(pass: string, scope: Scope = this.scopeOfRoom()): boolean {
      return this.latestMark(pass, scope)?.admitted === true;
    }
    admitsWithWholeHistory(pass: string, scope: Scope = this.scopeOfRoom()): boolean {
      return this.latestMark(pass, scope, this.full)?.admitted === true;
    }
    guestBlocked(pass: string): boolean {
      const group = this.group(pass);
      return [...this.blocked].some((key) => group.has(tabByKey.get(key)!.pass));
    }
    // A co-host's right holds for the whole guest, and never while it is blocked.
    isCoHost(pass: string): boolean {
      if (this.guestBlocked(pass)) return false;
      const top = this.find(pass);
      return [...this.coHosts].some((key) => this.find(tabByKey.get(key)!.pass) === top);
    }
    refuses(record: PassRecord): boolean {
      return record.wr?.admitted === false || record.lock?.admitted === false || record.answer?.admitted === false;
    }
    // Finds room for a new record, as the room's ledger does. Returns false
    // when an admission cannot be kept.
    makeRoom(pass: string, refusal: boolean): boolean {
      if (this.records.has(pass) || this.limit === undefined || this.records.size < this.limit) return true;
      const evictable = [...this.records.keys()]
        .filter((other) => !this.refuses(this.records.get(other)!))
        .sort((a, b) => this.activity.get(a)! - this.activity.get(b)!);
      if (evictable.length > 0) {
        this.records.delete(evictable[0]);
        return true;
      }
      return refusal;
    }
    write(pass: string, change: (record: PassRecord, at: number) => void, refusal: boolean) {
      const at = this.tick();
      const whole = this.full.get(pass) ?? {};
      change(whole, at);
      this.full.set(pass, whole);
      if (!this.makeRoom(pass, refusal)) return;
      const record = this.records.get(pass) ?? {};
      change(record, at);
      this.records.set(pass, record);
      this.activity.set(pass, at);
    }
    admit(key: string, scopes: Scope[]) {
      for (const scope of scopes) {
        this.write(tabByKey.get(key)!.pass, (record, at) => {
          const current = record[scope];
          const keys = current?.admitted && this.counts(scope, current) ? new Set([...current.keys, key]) : new Set([key]);
          record[scope] = { admitted: true, at, keys };
          record.answer = { admitted: true, at };
        }, false);
      }
    }
    deny(key: string) {
      this.write(tabByKey.get(key)!.pass, (record, at) => {
        record.wr = { admitted: false, at, keys: new Set() };
        record.lock = { admitted: false, at, keys: new Set() };
        record.answer = { admitted: false, at };
      }, true);
    }
    // A revocation, a removal or a block: every pass the keys are bound
    // under gets the refusal, the ones with a record first. One that a
    // guest's own join sets off (`recordedOnly`) reaches only passes that
    // have a record, and is no decision of the hosts.
    revokeKeys(keys: string[], options: { recordedOnly?: boolean } = {}) {
      for (const key of keys) this.coHosts.delete(key);
      // A live seat is a host's only while its guest holds the right.
      for (const key of [...this.adminSeats]) {
        if (!this.isCoHost(tabByKey.get(key)!.pass)) this.adminSeats.delete(key);
      }
      const passes = [...new Set(keys.map((key) => tabByKey.get(key)!.pass))].filter(
        (pass) => !options.recordedOnly || this.records.has(pass),
      );
      const at = this.tick();
      const refuse = (record: PassRecord) => {
        record.wr = { admitted: false, at, keys: new Set() };
        record.lock = { admitted: false, at, keys: new Set() };
      };
      for (const pass of passes) {
        const whole = this.full.get(pass) ?? {};
        refuse(whole);
        this.full.set(pass, whole);
      }
      for (const pass of [...passes.filter((pass) => this.records.has(pass)), ...passes.filter((pass) => !this.records.has(pass))]) {
        this.makeRoom(pass, true);
        const record = this.records.get(pass) ?? {};
        refuse(record);
        this.records.set(pass, record);
        this.activity.set(pass, at);
      }
    }
    identities(key: string): string[] {
      return [...new Set([key, ...this.boundKeys(tabByKey.get(key)!.pass)])];
    }
    prune() {
      const groups = new Map<string, string[]>();
      for (const tab of tabs) {
        const top = this.find(tab.pass);
        groups.set(top, [...new Set([...(groups.get(top) ?? []), tab.pass])]);
      }
      for (const passes of groups.values()) {
        if (passes.length > 1 && !passes.some((pass) => this.known(pass))) {
          for (const pass of passes) this.root.delete(pass);
        }
      }
    }
    rows(): string[] {
      const rows: string[] = [];
      const seen = new Set<string>();
      const pending = tabs
        .filter((tab) => this.status.get(tab.key) === "pending")
        .sort((a, b) => this.arrival.get(a.key)! - this.arrival.get(b.key)!);
      for (const tab of pending) {
        const top = this.find(tab.pass);
        if (seen.has(top)) continue;
        seen.add(top);
        rows.push(tab.key);
      }
      return rows.sort();
    }
    removeGuestOf(pass: string, events: Map<string, string>, removedKeys: string[], passes = this.group(pass)) {
      for (const waiting of this.tabsOfGuest(pass, "pending", passes)) {
        this.status.set(waiting.key, "idle");
        events.set(waiting.key, "joinRejected");
      }
      for (const seated of this.tabsOfGuest(pass, "seated", passes)) {
        if (!removedKeys.includes(seated.key)) continue;
        this.status.set(seated.key, "idle");
        this.adminSeats.delete(seated.key);
        events.set(seated.key, "kicked");
      }
    }

    knock(tab: Tab, names: string[]) {
      const events = new Map<string, string>();
      // A join decides on the passes it shows; only one that waits or is
      // let in records the link.
      const others = names.filter((other) => this.known(other) && this.find(other) !== this.find(tab.pass));
      const union = new Set([...this.group(tab.pass), ...others.flatMap((other) => [...this.group(other)])]);
      const unionBlocked = [...this.blocked].some((key) => union.has(tabByKey.get(key)!.pass));
      if (others.length > 0 && unionBlocked) {
        const keys = this.boundKeysOf(union);
        this.revokeKeys(keys, { recordedOnly: true });
        this.removeGuestOf(tab.pass, events, keys, union);
        this.prune();
        return { outcome: "refused" as const, events };
      }
      if (this.blocked.has(tab.key) || this.guestBlocked(tab.pass)) {
        this.prune();
        return { outcome: "refused" as const, events };
      }
      for (const other of others) this.root.set(this.find(other), this.find(tab.pass));
      if (others.length > 0) {
        for (const waiting of this.tabsOfGuest(tab.pass, "pending")) {
          const answer = this.latestAnswer(waiting.pass);
          if (!answer || answer.at < this.arrival.get(waiting.key)!) continue;
          if (!answer.admitted) {
            this.status.set(waiting.key, "idle");
            events.set(waiting.key, "joinRejected");
          } else if (this.admits(waiting.pass)) {
            this.status.set(waiting.key, "idle");
            events.set(waiting.key, "joinApproved");
          }
        }
      }
      let outcome: "joined" | "waiting";
      if (this.isCoHost(tab.pass)) {
        outcome = "joined";
        this.status.set(tab.key, "seated");
        this.coHosts.add(tab.key);
        this.adminSeats.add(tab.key);
      } else if (!this.locked || this.admits(tab.pass)) {
        if (this.locked) {
          expect(this.admitsWithWholeHistory(tab.pass), `${tab.key} let in although the whole history refuses it`).toBe(true);
        }
        outcome = "joined";
        this.status.set(tab.key, "seated");
      } else {
        outcome = "waiting";
        if (this.status.get(tab.key) !== "pending") {
          this.arrival.set(tab.key, this.tick());
          this.status.set(tab.key, "pending");
        }
      }
      this.prune();
      return { outcome, events };
    }
    answer(row: string, admitted: boolean) {
      const events = new Map<string, string>();
      for (const waiting of this.tabsOfGuest(tabByKey.get(row)!.pass, "pending")) {
        if (admitted) this.admit(waiting.key, this.locked ? ["lock", "wr"] : ["wr"]);
        else this.deny(waiting.key);
        this.status.set(waiting.key, "idle");
        events.set(waiting.key, admitted ? "joinApproved" : "joinRejected");
      }
      this.prune();
      return events;
    }
    block(key: string) {
      const events = new Map<string, string>();
      const pass = tabByKey.get(key)!.pass;
      const identities = this.identities(key);
      const pending = identities.filter((other) => this.status.get(other) === "pending");
      const seated = identities.filter((other) => this.status.get(other) === "seated");
      this.revokeKeys(identities);
      this.blocked.add(key);
      for (const other of pending) {
        this.deny(other);
        this.status.set(other, "idle");
        events.set(other, "joinRejected");
      }
      for (const other of seated) {
        this.revokeKeys(this.identities(other));
        this.status.set(other, "idle");
        this.adminSeats.delete(other);
        events.set(other, "kicked");
      }
      void pass;
      this.prune();
      return events;
    }
    kick(key: string) {
      const events = new Map<string, string>();
      this.revokeKeys(this.identities(key));
      this.status.set(key, "idle");
      this.adminSeats.delete(key);
      events.set(key, "kicked");
      this.prune();
      return events;
    }
    setLocked(locked: boolean) {
      if (locked === this.locked) return;
      this.locked = locked;
      if (!locked) return;
      this.lockedAt = this.tick();
      for (const tab of tabs) {
        if (this.status.get(tab.key) === "seated") this.admit(tab.key, ["lock"]);
      }
      this.prune();
    }
    unblock(key: string) {
      this.blocked.delete(key);
      this.prune();
    }
    promote(key: string) {
      this.coHosts.add(key);
      this.adminSeats.add(key);
      this.prune();
    }
    withdraw(key: string) {
      this.status.set(key, "idle");
      this.prune();
    }
  }

  // What a host's screen holds, built from what its socket was sent.
  const screenOf = (emit: ReturnType<typeof vi.fn>): string[] => {
    let rows: string[] = [];
    for (const [event, payload] of emit.mock.calls as Array<[string, { userId?: string; users?: Array<{ userId: string }> }]>) {
      if (event === "userRequestedJoin") rows = [...rows.filter((row) => row !== payload.userId), payload.userId!];
      if (["pendingUserLeft", "userAdmitted", "userRejected"].includes(event)) rows = rows.filter((row) => row !== payload.userId);
      if (event === "pendingUsersSnapshot") rows = payload.users!.map((user) => user.userId);
    }
    return rows.sort();
  };

  type Step =
    | { kind: "knock"; key: string; names: string[] }
    | { kind: "admit" | "deny"; row: string }
    | { kind: "block" | "unblock" | "kick" | "withdraw" | "promote"; key: string }
    | { kind: "lock"; locked: boolean }
    | { kind: "hostReconnects" | "hostsLeave" };

  // The room's last co-host, a guest with several tabs, is blocked through
  // a pass link while no other host is in, and the block is lifted later.
  const tabOf = (browser: number, pass: string, index: number) => `guest-gp_b${browser}-${pass}-s${index}`;
  const lastCoHostBlockedByALink: Step[] = [
    { kind: "knock", key: tabOf(0, "X1", 0), names: [] },
    { kind: "admit", row: tabOf(0, "X1", 0) },
    { kind: "knock", key: tabOf(0, "X1", 0), names: [] },
    { kind: "knock", key: tabOf(0, "X1", 1), names: [] },
    { kind: "promote", key: tabOf(0, "X1", 0) },
    { kind: "knock", key: tabOf(0, "X2", 0), names: [] },
    { kind: "block", key: tabOf(0, "X2", 0) },
    { kind: "knock", key: tabOf(1, "Y1", 0), names: [] },
    { kind: "admit", row: tabOf(1, "Y1", 0) },
    { kind: "knock", key: tabOf(1, "Y1", 0), names: [] },
    { kind: "hostsLeave" },
    { kind: "knock", key: tabOf(0, "X3", 0), names: ["proof-X1", "proof-X2"] },
    { kind: "hostReconnects" },
    { kind: "unblock", key: tabOf(0, "X2", 0) },
    { kind: "knock", key: tabOf(0, "X1", 1), names: [] },
  ];

  const run = async (seed: number, steps: number, limit?: number, script: Step[] = []) => {
    // A lock admits the tabs already in, in the order they sat down, which
    // the oracle does not track; runs with a small record keep the room locked.
    const toggleLock = limit === undefined;
    // A host who acts once a second stays inside the admin rate limit.
    let now = Date.UTC(2026, 10, 22);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let random = seed;
    const pick = (below: number) => {
      random = (random * 1103515245 + 12345) % 2147483648;
      return random % below;
    };
    const state = makeState();
    const limitBefore = sfuConfig.lobbyDecisionRecordLimit;
    if (limit !== undefined) sfuConfig.lobbyDecisionRecordLimit = limit;
    const firstHost = await join(state, hostTab("host-0")).finally(() => {
      sfuConfig.lobbyDecisionRecordLimit = limitBefore;
    });
    const room = state.rooms.get("conclave:room")!;
    room.setLocked(true);
    const hosts = [firstHost];
    let hostSessions = 1;
    const oracle = new Oracle(limit);
    const peerOf = new Map<string, Awaited<ReturnType<typeof join>>["peer"]>();
    const history: string[] = [];
    const hostAsks = async (event: string, payload: unknown) => {
      const ack = vi.fn();
      await hosts[0].peer.handlers.get(event)!(...([payload, ack] as never[]));
      const answer = ack.mock.calls[0]?.[0] as { error?: string } | undefined;
      expect(answer?.error, `${event} ${JSON.stringify(payload)}, seed ${seed}`).toBeUndefined();
    };
    const seatOf = (key: string) => `${key}#${tabByKey.get(key)!.session}`;
    // What a room keeps per guest, which a refused join must not add to.
    const sizes = () => ({
      links: room.linkedGuestPassCount,
      bindings: room.boundGuestIdentityCount,
      decisions: room.decisionRecordCount,
      waiting: room.pendingClients.size,
      seats: room.clients.size,
    });
    const hostSeats = () => tabs.filter((tab) => room.getClient(seatOf(tab.key)) instanceof Admin).map((tab) => tab.key);
    // A tab that knocks again on a new socket leaves its old request on the
    // old one, and an answer to that request goes there.
    const earlierPeerOf = new Map<string, Awaited<ReturnType<typeof join>>["peer"]>();
    const expectAgreement = (events: Map<string, string>, callsBefore: Map<string, number>) => {
      const where = `seed ${seed}, after: ${history.slice(-6).join(" | ")}`;
      const pending = [...room.pendingClients.keys()].sort();
      const expectedPending = tabs.filter((tab) => oracle.status.get(tab.key) === "pending").map((tab) => tab.key).sort();
      expect(pending, `pending, ${where}`).toEqual(expectedPending);
      const seated = [...room.userKeysById.values()].filter((key) => tabByKey.has(key)).sort();
      const expectedSeated = tabs.filter((tab) => oracle.status.get(tab.key) === "seated").map((tab) => tab.key).sort();
      expect(seated, `seated, ${where}`).toEqual(expectedSeated);
      for (const [key, event] of events) {
        const peer = peerOf.get(key)!;
        const fresh = (peer.emit.mock.calls as Array<[string, ...unknown[]]>)
          .slice(callsBefore.get(key) ?? 0)
          .map(([name]) => name);
        const earlier = earlierPeerOf.get(key);
        const freshOnEarlier = earlier
          ? (earlier.emit.mock.calls as Array<[string, ...unknown[]]>)
              .slice(callsBefore.get(`earlier:${key}`) ?? 0)
              .map(([name]) => name)
          : [];
        expect([...fresh, ...freshOnEarlier], `${key} told ${event}, ${where}`).toContain(event);
      }
      const rows = oracle.rows();
      expect(toPendingUserSnapshots(room).map((row) => row.userId).sort(), `lobby, ${where}`).toEqual(rows);
      for (const host of hosts) {
        expect(screenOf(host.peer.emit), `host screen, ${where}`).toEqual(rows);
      }
      expect(room.waitingGuestCount, `count, ${where}`).toBe(rows.length);
      // A blocked guest never holds host rights, and once the block is
      // lifted it holds none until it is made a host again.
      for (const tab of tabs) {
        expect(room.isAdminUserKey(tab.key, tab.pass), `co-host ${tab.key}, ${where}`).toBe(oracle.isCoHost(tab.pass));
        expect(room.isHostUserKey(tab.key, tab.pass), `host ${tab.key}, ${where}`).toBe(false);
      }
      expect(hostSeats().sort(), `host seats, ${where}`).toEqual([...oracle.adminSeats].sort());
    };

    const randomStep = (): Step => {
      const pendingKeys = tabs.filter((tab) => oracle.status.get(tab.key) === "pending").map((tab) => tab.key);
      const seatedKeys = tabs.filter((tab) => oracle.status.get(tab.key) === "seated").map((tab) => tab.key);
      const plainSeats = seatedKeys.filter((key) => !oracle.adminSeats.has(key));
      const rows = oracle.rows();
      const hostIn = hosts.length > 0;
      const action = pick(24);
      const free = tabs.filter((tab) => oracle.status.get(tab.key) !== "seated");
      if (action < 9 && free.length > 0) {
        const tab = free[pick(free.length)];
        return { kind: "knock", key: tab.key, names: BROWSERS[tab.browser].filter((other) => other !== tab.pass && pick(3) === 0) };
      }
      if (action < 12 && hostIn && rows.length > 0) return { kind: "admit", row: rows[pick(rows.length)] };
      if (action < 15 && hostIn && rows.length > 0) return { kind: "deny", row: rows[pick(rows.length)] };
      if (action < 16 && hostIn && pendingKeys.length + seatedKeys.length > 0) {
        const candidates = [...pendingKeys, ...seatedKeys];
        return { kind: "block", key: candidates[pick(candidates.length)] };
      }
      if (action < 17 && hostIn && oracle.blocked.size > 0) {
        const blockedKeys = [...oracle.blocked];
        return { kind: "unblock", key: blockedKeys[pick(blockedKeys.length)] };
      }
      if (action < 18 && hostIn && seatedKeys.length > 0) return { kind: "kick", key: seatedKeys[pick(seatedKeys.length)] };
      if (action < 19 && hostIn && toggleLock) return { kind: "lock", locked: !oracle.locked };
      if (action < 21 && pendingKeys.length > 0) return { kind: "withdraw", key: pendingKeys[pick(pendingKeys.length)] };
      if (action < 22 && hostIn && plainSeats.length > 0) return { kind: "promote", key: plainSeats[pick(plainSeats.length)] };
      if (action < 23 && hostIn && seatedKeys.length > 0) return { kind: "hostsLeave" };
      return { kind: "hostReconnects" };
    };

    for (let step = 0; step < script.length + steps; step += 1) {
      now += 1000;
      const callsBefore = new Map([...peerOf].map(([key, peer]) => [key, peer.emit.mock.calls.length]));
      const next = step < script.length ? script[step] : randomStep();
      const hostSeatsBefore = new Set(oracle.adminSeats);
      const hostsBefore = hosts.length;
      // The guests a step takes out of the room, which a handoff must skip.
      let removedGuests: string[] = [];
      let refusedFrom: ReturnType<typeof sizes> | undefined;
      let events = new Map<string, string>();
      if (next.kind === "knock") {
        const tab = tabByKey.get(next.key)!;
        const names = next.names;
        history.push(`knock ${tab.key} naming [${names.join(",")}]`);
        const seatedBefore = tabs.filter((other) => oracle.status.get(other.key) === "seated").map((other) => other.key);
        const sizesBefore = sizes();
        const expected = oracle.knock(tab, names);
        events = expected.events;
        if (expected.outcome === "refused") refusedFrom = sizesBefore;
        removedGuests = seatedBefore.filter((key) => oracle.status.get(key) !== "seated");
        const joinedTab = await join(state, {
          userId: tab.key,
          clientId: "conclave",
          sessionId: tab.session,
          guestProof: tab.pass,
          guestRoom: "room",
          ...(names.length > 0
            ? { guestWas: names.map((other) => ({ userKey: `guest-gp_${tab.session}-under-${other}`, guestProof: other })) }
            : {}),
        });
        // Socket.IO runs the disconnect handler inside a server-side disconnect.
        registerDisconnectHandlers(joinedTab.context);
        joinedTab.peer.disconnect.mockImplementation(() => {
          (joinedTab.peer.socket as { connected: boolean }).connected = false;
          void joinedTab.peer.handlers.get("disconnect")?.(...(["server namespace disconnect"] as never[]));
        });
        const earlier = peerOf.get(tab.key);
        earlierPeerOf.delete(tab.key);
        if (earlier) {
          earlierPeerOf.set(tab.key, earlier);
          callsBefore.set(`earlier:${tab.key}`, callsBefore.get(tab.key) ?? 0);
        }
        peerOf.set(tab.key, joinedTab.peer);
        callsBefore.set(tab.key, 0);
        const ack = joinedTab.ack.mock.calls[0]?.[0] as { status?: string; error?: string };
        const outcome = ack?.status === "joined" ? "joined" : ack?.status === "waiting" ? "waiting" : /not allowed/i.test(ack?.error ?? "") ? "refused" : `other: ${JSON.stringify(ack)}`;
        expect(outcome, `join of ${tab.key}, seed ${seed}, after: ${history.slice(-6).join(" | ")}`).toBe(expected.outcome);
      } else if (next.kind === "admit" || next.kind === "deny") {
        history.push(`${next.kind} ${next.row}`);
        events = oracle.answer(next.row, next.kind === "admit");
        await hostAsks(next.kind === "admit" ? "admitUser" : "rejectUser", { userId: next.row });
      } else if (next.kind === "block") {
        history.push(`block ${next.key}`);
        removedGuests = oracle.identities(next.key);
        events = oracle.block(next.key);
        await hostAsks("admin:blockUsers", { userKeys: [next.key] });
      } else if (next.kind === "unblock") {
        history.push(`unblock ${next.key}`);
        oracle.unblock(next.key);
        await hostAsks("admin:unblockUsers", { userKeys: [next.key] });
      } else if (next.kind === "kick") {
        history.push(`kick ${next.key}`);
        removedGuests = oracle.identities(next.key);
        events = oracle.kick(next.key);
        await hostAsks("kickUser", { userId: seatOf(next.key) });
      } else if (next.kind === "lock") {
        history.push(next.locked ? "lock" : "unlock");
        oracle.setLocked(next.locked);
        await hostAsks("lockRoom", { locked: next.locked });
      } else if (next.kind === "withdraw") {
        history.push(`withdraw ${next.key}`);
        oracle.withdraw(next.key);
        withdrawWaitingRequest(room, next.key);
      } else if (next.kind === "promote") {
        history.push(`promote ${next.key}`);
        oracle.promote(next.key);
        await hostAsks("promoteHost", { userId: seatOf(next.key) });
      } else if (next.kind === "hostsLeave") {
        history.push("hosts leave");
        for (const host of hosts.splice(0)) {
          forceRemoveClientNow({ io, state, room, userId: host.context.currentClient!.id });
        }
      } else {
        history.push("host reconnects");
        hosts.push(await join(state, hostTab(`host-${hostSessions++}`)));
      }
      await endOfTurn();
      if (refusedFrom) {
        const after = sizes();
        for (const [name, before] of Object.entries(refusedFrom)) {
          expect(after[name as keyof typeof after], `a refused join grew ${name}, seed ${seed}, after: ${history.slice(-6).join(" | ")}`).toBeLessThanOrEqual(before);
        }
      }

      // With no host left, the room hands itself to one seat, never to a
      // guest that is blocked or that this step took out.
      const where = `seed ${seed}, after: ${history.slice(-6).join(" | ")}`;
      const promoted = hostSeats().filter((key) => !oracle.adminSeats.has(key));
      const lostAHost = hosts.length < hostsBefore || [...hostSeatsBefore].some((key) => !oracle.adminSeats.has(key));
      const hostless = hosts.length === 0 && oracle.adminSeats.size === 0;
      const removed = new Set(removedGuests.flatMap((key) => tabs.filter((tab) => oracle.find(tab.pass) === oracle.find(tabByKey.get(key)!.pass)).map((tab) => tab.key)));
      const eligible = tabs.filter((tab) => oracle.status.get(tab.key) === "seated" && !oracle.guestBlocked(tab.pass) && !removed.has(tab.key));
      expect(promoted.length, `seats made hosts, ${where}`).toBeLessThanOrEqual(lostAHost && hostless ? 1 : 0);
      if (lostAHost && hostless && eligible.length > 0) {
        expect(promoted.length, `the room was left without a host, ${where}`).toBe(1);
      }
      for (const key of promoted) {
        expect(eligible.map((tab) => tab.key), `handed to ${key}, ${where}`).toContain(key);
        oracle.promote(key);
      }
      expectAgreement(events, callsBefore);
      // A room left empty with no host closes, and the run ends with it.
      if (state.rooms.get("conclave:room") !== room) break;
    }
  };

  afterEach(() => vi.restoreAllMocks());

  it.each([1, 7, 42, 2026, 31337, 99991])("agrees with the oracle over 300 random steps (seed %i)", { timeout: 60_000 }, async (seed) => {
    await run(seed, 300);
  });

  it.each([1, 7, 42, 2026])("agrees with the oracle when the room's last co-host is blocked through a pass link, then 300 random steps (seed %i)", { timeout: 60_000 }, async (seed) => {
    await run(seed, 300, undefined, lastCoHostBlockedByALink);
  });

  it.each([
    [3, 2],
    [11, 3],
    [42, 2],
    [2026, 3],
    [31337, 1],
    [99991, 4],
  ])("agrees with the oracle when the decision record is small (seed %i, %i records)", { timeout: 60_000 }, async (seed, limit) => {
    await run(seed, 300, limit);
  });
});
