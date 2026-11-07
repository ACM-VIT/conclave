import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router, Worker } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { Admin } from "../config/classes/Admin.js";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import type { SfuAuthPayload } from "../server/socket/auth.js";
import { createConnectionContext } from "../server/socket/context.js";
import { registerAdminHandlers } from "../server/socket/handlers/adminHandlers.js";
import { registerDisconnectHandlers } from "../server/socket/handlers/disconnectHandlers.js";
import { registerJoinRoomHandler } from "../server/socket/handlers/joinRoom.js";
import { registerTransportHandlers } from "../server/socket/handlers/transportHandlers.js";
import { getOrCreateRoomWithOrigin } from "../server/rooms.js";
import { createSfuState, type SfuState } from "../server/state.js";

type Handler = (...args: never[]) => void | Promise<void>;

afterEach(() => {
  vi.useRealTimers();
});

const makeSocket = (id: string, user: SfuAuthPayload = {}) => {
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

const makeState = (workers: Worker[] = []): SfuState => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "join-lifecycle-test",
      instanceUrl: "http://localhost",
      ttlMs: 45000,
    }),
  });
  state.workers = workers;
  return state;
};

const broadcast = vi.fn();
const io = { to: () => ({ emit: broadcast }) } as unknown as SocketIOServer;

const join = async (
  state: SfuState,
  socketId: string,
  user: SfuAuthPayload,
  roomId = "room",
) => {
  const peer = makeSocket(socketId, user);
  const context = createConnectionContext(io, peer.socket, state);
  registerJoinRoomHandler(context);
  const ack = vi.fn();
  await peer.handlers.get("joinRoom")!(...[
    { roomId, sessionId: user.sessionId },
    ack,
  ] as never[]);
  return { context, peer, ack };
};

describe("reconnect grace timer", () => {
  const guest = {
    userId: "guest-abc",
    clientId: "conclave",
    sessionId: "s1",
  } satisfies SfuAuthPayload;
  const guestSeatId = "guest-abc#s1";

  // A room with a host and a guest whose socket dropped: the guest's seat is
  // in its disconnect grace window.
  const setup = () => {
    vi.useFakeTimers();
    const state = makeState();
    const room = new Room({
      id: "room",
      clientId: "conclave",
      workerPid: null,
      router: {} as Router,
    });
    state.rooms.set(room.channelId, room);
    const host = new Admin({ id: "host#h", socket: makeSocket("host-socket").socket });
    room.setUserIdentity(host.id, "host@example.com", "Host");
    room.hostUserKey = "host@example.com";
    room.addClient(host);
    const oldSocket = makeSocket("old-guest-socket").socket;
    (oldSocket as { connected: boolean }).connected = false;
    const oldSeat = new Client({ id: guestSeatId, socket: oldSocket });
    room.setUserIdentity(oldSeat.id, "guest-abc", "Guest");
    room.addClient(oldSeat);
    const onExpire = vi.fn(() => room.removeClient(guestSeatId));
    room.scheduleDisconnect(guestSeatId, oldSocket.id, 10_000, onExpire);
    return { state, room, oldSeat, onExpire };
  };

  it.each([
    [
      "the room no longer allows guests",
      (room: Room) => { room.setNoGuests(true); },
      { error: "Guests are not allowed in this meeting." },
    ],
    [
      "the identity was blocked",
      (room: Room) => { room.blockUser("guest-abc"); },
      { error: "You are not allowed to join this meeting." },
    ],
  ])("keeps the old seat's timer when a reconnect is refused because %s", async (_label, configure, expected) => {
    const h = setup();
    configure(h.room);
    const { ack } = await join(h.state, "new-guest-socket", guest);

    expect(ack).toHaveBeenCalledWith(expected);
    expect(h.room.hasPendingDisconnect(guestSeatId)).toBe(true);
    expect(h.room.getClient(guestSeatId)).toBe(h.oldSeat);

    vi.advanceTimersByTime(10_000);
    expect(h.onExpire).toHaveBeenCalledOnce();
    expect(h.room.getClient(guestSeatId)).toBeUndefined();
  });

  it("keeps the old seat's timer when a reconnect is parked in the waiting room", async () => {
    const h = setup();
    h.room.setLocked(true);
    const { ack } = await join(h.state, "new-guest-socket", guest);

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting" }));
    expect(h.room.pendingClients.has("guest-abc")).toBe(true);
    expect(h.room.hasPendingDisconnect(guestSeatId)).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(h.onExpire).toHaveBeenCalledOnce();
    expect(h.room.getClient(guestSeatId)).toBeUndefined();
  });

  it("still cancels the timer and replaces the seat when the reconnect succeeds", async () => {
    const h = setup();
    const { ack, context } = await join(h.state, "new-guest-socket", guest);

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ status: "joined" }));
    expect(h.room.hasPendingDisconnect(guestSeatId)).toBe(false);
    expect(h.room.getClient(guestSeatId)).toBe(context.currentClient);
    expect(context.currentClient).not.toBe(h.oldSeat);

    vi.advanceTimersByTime(10_000);
    expect(h.onExpire).not.toHaveBeenCalled();
    expect(h.room.getClient(guestSeatId)).toBe(context.currentClient);
  });
});

describe("concurrent room creation", () => {
  it("makes only the joiner whose call created the room its host", async () => {
    let releaseRouter!: () => void;
    const routerReady = new Promise<void>((resolve) => { releaseRouter = resolve; });
    const router = {
      closed: false,
      rtpCapabilities: { codecs: [], headerExtensions: [] },
      close: vi.fn(),
    } as unknown as Router;
    const createRouter = vi.fn(async () => {
      await routerReady;
      return router;
    });
    const worker = { pid: 1, closed: false, createRouter } as unknown as Worker;
    const state = makeState([worker]);

    const creator = { userId: "alice", clientId: "conclave", sessionId: "a", allowRoomCreation: true };
    const racer = { userId: "bob", clientId: "conclave", sessionId: "b", allowRoomCreation: true };

    const first = join(state, "alice-socket", creator);
    // Let the first join reach the worker before the second one starts.
    await vi.waitFor(() => expect(createRouter).toHaveBeenCalledOnce());
    const second = join(state, "bob-socket", racer);
    releaseRouter();
    const [a, b] = await Promise.all([first, second]);

    expect(createRouter).toHaveBeenCalledOnce();
    expect(a.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "joined" }));
    expect(b.ack).toHaveBeenCalledWith(expect.objectContaining({ status: "joined" }));
    expect(a.context.currentClient).toBeInstanceOf(Admin);
    expect(b.context.currentClient).not.toBeInstanceOf(Admin);

    const room = state.rooms.get("conclave:room")!;
    expect(room.hostUserKey).toBe("alice");
    expect(room.isAdminUserKey("bob")).toBe(false);
    expect(room.getAdminUserIds()).toEqual(["alice#a"]);
  });
});

describe("delayed room end", () => {
  it("does not close or disconnect a newer room reopened on the same channel", async () => {
    vi.useFakeTimers();
    const state = makeState();
    const makeRoom = () => new Room({
      id: "room",
      clientId: "conclave",
      workerPid: null,
      router: { closed: false, close: vi.fn() } as unknown as Router,
    });
    const endedRoom = makeRoom();
    state.rooms.set(endedRoom.channelId, endedRoom);
    const disconnectSockets = vi.fn();
    const adminIo = {
      to: () => ({ emit: vi.fn() }),
      in: () => ({ disconnectSockets }),
    } as unknown as SocketIOServer;
    const hostSocket = makeSocket("host-socket");
    const host = new Admin({ id: "host#h", socket: hostSocket.socket });
    endedRoom.setUserIdentity(host.id, "host@example.com", "Host");
    endedRoom.addClient(host);
    const context = createConnectionContext(adminIo, hostSocket.socket, state);
    context.currentRoom = endedRoom;
    context.currentClient = host;
    registerAdminHandlers(context, { roomId: endedRoom.id });

    const ack = vi.fn();
    await hostSocket.handlers.get("admin:endRoom")!(...[{ delayMs: 10_000 }, ack] as never[]);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    // Everyone leaves early, the room is cleaned up, and the host reopens it.
    state.rooms.delete(endedRoom.channelId);
    const reopened = makeRoom();
    state.rooms.set(reopened.channelId, reopened);

    vi.advanceTimersByTime(10_000);
    expect(state.rooms.get("conclave:room")).toBe(reopened);
    expect(disconnectSockets).not.toHaveBeenCalled();
  });
});

describe("room lookup across the lease renew await", () => {
  it("creates a fresh room when the found room closed during the renew", async () => {
    const newRouter = { closed: false, rtpCapabilities: {}, close: vi.fn() } as unknown as Router;
    const createRouter = vi.fn(async () => newRouter);
    const state = makeState([{ pid: 1, closed: false, createRouter } as unknown as Worker]);
    const oldRoom = new Room({
      id: "room",
      clientId: "conclave",
      workerPid: null,
      router: { closed: false, close: vi.fn() } as unknown as Router,
    });
    state.rooms.set(oldRoom.channelId, oldRoom);

    let releaseRenew!: () => void;
    const renewGate = new Promise<void>((resolve) => { releaseRenew = resolve; });
    const renew = state.roomRegistry.renewRoom.bind(state.roomRegistry);
    state.roomRegistry.renewRoom = async (input) => {
      await renewGate;
      return renew(input);
    };

    const lookup = getOrCreateRoomWithOrigin(state, "conclave", "room");
    // The last client leaves while the lease is being renewed.
    state.rooms.delete(oldRoom.channelId);
    (oldRoom.router as { closed: boolean }).closed = true;
    releaseRenew();

    const result = await lookup;
    expect(result.created).toBe(true);
    expect(result.room).not.toBe(oldRoom);
    expect(state.rooms.get("conclave:room")).toBe(result.room);
  });
});

describe("transport creation across its await", () => {
  it("closes a transport created for a seat the socket no longer holds", async () => {
    const handlers = new Map<string, Handler>();
    const socket = {
      id: "s1",
      on: (event: string, handler: Handler) => handlers.set(event, handler),
    } as unknown as Socket;
    let resolveTransport!: (transport: unknown) => void;
    const close = vi.fn();
    const client = { id: "u#1", isObserver: false, producerTransport: null } as unknown as Client;
    const room = {
      createWebRtcTransport: vi.fn(() => new Promise((resolve) => { resolveTransport = resolve; })),
      getClient: (id: string) => (id === "u#1" ? client : undefined),
    } as unknown as Room;
    const context = createConnectionContext(io, socket, makeState());
    context.currentRoom = room;
    context.currentClient = client;
    registerTransportHandlers(context);

    const callback = vi.fn();
    const pending = handlers.get("createProducerTransport")!(...[callback] as never[]);
    // The socket disconnects while mediasoup is creating the transport.
    context.currentRoom = null;
    context.currentClient = null;
    resolveTransport({ id: "t1", close, on: vi.fn(), observer: { on: vi.fn() } });
    await pending;

    expect(close).toHaveBeenCalledOnce();
    expect(client.producerTransport).toBeNull();
    expect(callback).toHaveBeenCalledWith({ error: "Left the room while creating the transport" });
  });
});

describe("waiting-room entry on disconnect", () => {
  it("removes the entry even when the socket is also seated in another room", () => {
    vi.useFakeTimers();
    const state = makeState();
    const makeRoom = (id: string) => {
      const room = new Room({ id, clientId: "conclave", workerPid: null, router: { closed: false, close: vi.fn() } as unknown as Router });
      state.rooms.set(room.channelId, room);
      return room;
    };
    const seatedRoom = makeRoom("a");
    const waitingRoom = makeRoom("b");
    const waitingHost = new Admin({ id: "host#h", socket: makeSocket("host-socket").socket });
    waitingRoom.addClient(waitingHost);

    const peer = makeSocket("switching-socket", { userId: "u", clientId: "conclave" });
    const seat = new Client({ id: "u#1", socket: peer.socket });
    seatedRoom.addClient(seat);
    waitingRoom.addPendingClient("u", "u#1", peer.socket, "U");

    const context = createConnectionContext(io, peer.socket, state);
    context.currentRoom = seatedRoom;
    context.currentClient = seat;
    context.pendingRoomId = "b";
    context.pendingRoomChannelId = waitingRoom.channelId;
    context.pendingUserKey = "u";
    registerDisconnectHandlers(context);

    void peer.handlers.get("disconnect")!(...["transport close"] as never[]);
    expect(waitingRoom.pendingClients.has("u")).toBe(false);
  });
});
