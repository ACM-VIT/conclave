import { describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
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

const dropConnection = (peer: { socket: Socket }) => {
  (peer.socket as { connected: boolean }).connected = false;
};

// What every other participant can read off the wire: the identity and
// session id, but never the pass proof.
const publicIdentity = (user: SfuAuthPayload): SfuAuthPayload => {
  const { guestProof: _proof, ...visible } = user;
  return visible;
};

const refused = expect.objectContaining({ error: expect.any(String) });
const joined = expect.objectContaining({ status: "joined" });

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
