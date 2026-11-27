import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import * as encoding from "lib0/encoding";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer } from "socket.io";
import { io as connectSocket, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { config } from "../config/config.js";
import { Room } from "../config/classes/Room.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createSfuSocketServer } from "../server/socket/createSocketServer.js";
import { createSfuState } from "../server/state.js";
import { seededRandom } from "./support/appsRoom.js";
import { BOARD, makeWorkRooms } from "./support/appsWorkRoom.js";

const WRITER_CLIENT = 7;

const boardWrittenBy = (clientID: number): Uint8Array => {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  doc.getMap("m").set("seed", 1);
  return Y.encodeStateAsUpdate(doc);
};

const NEON_DELETE_AT_STATE = Uint8Array.from([0, 1, WRITER_CLIENT, 1, 1, 0]);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a delete at the writer's state with no length", () => {
  const board = () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rooms = makeWorkRooms();
    const host = rooms.connect("host#1", { host: true });
    host.command("open", BOARD);
    host.sync();
    host.sendRaw(boardWrittenBy(WRITER_CLIENT));
    const room = rooms.roomFor("room");
    expect(Y.getState(room.apps.liveDoc(BOARD)!.store, WRITER_CLIENT)).toBe(1);
    return { ...rooms, host, room };
  };

  it.each([
    ["from a guest that has not synced, which gets the room's copy", false],
    ["from a guest writing to a locked board, which changes nothing", true],
  ])("is answered without throwing %s", (_, locked) => {
    const { connect, host } = board();
    const guest = connect("guest#1");
    if (locked) {
      guest.sync();
      host.command("lock");
    }
    const before = guest.received.length;

    expect(() => guest.sendRaw(NEON_DELETE_AT_STATE)).not.toThrow();

    const answered = guest.received.slice(before);
    expect(answered.filter((entry) => entry.event === "apps:yjs:refused")).toEqual([]);
    expect(answered.filter((entry) => entry.event === "apps:yjs:update" && entry.direct)).toHaveLength(locked ? 0 : 1);
  });
});

const CLIENT_ID = "conclave";
const ROOM_ID = "untrusted";
const HOST = "host@example.com";

type Stack = { io: SocketIOServer; http: HttpServer; url: string; room: Room };

const stacks: Stack[] = [];
const sockets: ClientSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  for (const stack of stacks.splice(0)) {
    await stack.io.close();
    stack.http.close();
  }
});

const startSfu = async (): Promise<Stack> => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: "untrusted", instanceUrl: "http://localhost", ttlMs: 45_000 }),
  });
  const router = { closed: false, rtpCapabilities: { codecs: [], headerExtensions: [] }, close: () => {} };
  const room = new Room({ id: ROOM_ID, clientId: CLIENT_ID, workerPid: null, router: router as unknown as Router });
  room.makePrimaryHost(HOST);
  state.rooms.set(room.channelId, room);
  const http = createServer();
  const io = createSfuSocketServer(http, { state });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const stack = { io, http, room, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
  stacks.push(stack);
  return stack;
};

const ask = <Reply>(socket: ClientSocket, event: string, payload?: unknown) =>
  new Promise<Reply>((resolve) => {
    if (payload === undefined) socket.emit(event, resolve);
    else socket.emit(event, payload, resolve);
  });

const join = async (stack: Stack, email: string): Promise<ClientSocket> => {
  stack.room.allowUser(email);
  const session = `session-${email}`;
  const token = jwt.sign(
    { userId: email, email, name: email, sessionId: session, clientId: CLIENT_ID, joinMode: "meeting" },
    config.sfuSecret,
    { algorithm: "HS256" },
  );
  const socket = connectSocket(stack.url, { auth: { token }, transports: ["websocket"], forceNew: true, reconnection: false });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  const joined = await ask<{ error?: string; status?: string }>(socket, "joinRoom", { roomId: ROOM_ID, sessionId: session });
  if (joined.error || joined.status === "waiting") throw new Error(`join failed: ${joined.error ?? joined.status}`);
  return socket;
};

describe("Neon's six bytes over a real socket.io server", () => {
  it("are refused by the apps handler itself, and the SFU keeps serving every socket", async () => {
    const failures: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => failures.push(args.map(String).join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stack = await startSfu();
    const host = await join(stack, HOST);
    const guest = await join(stack, "guest@example.com");
    expect(await ask(host, "apps:open", { appId: BOARD })).toMatchObject({ success: true });
    await ask(host, "apps:yjs:sync", { appId: BOARD, syncMessage: Y.encodeStateVector(new Y.Doc()) });
    host.emit("apps:yjs:update", { appId: BOARD, update: boardWrittenBy(WRITER_CLIENT) });
    await ask(host, "apps:getState");
    expect(Y.getState(stack.room.apps.liveDoc(BOARD)!.store, WRITER_CLIENT)).toBe(1);

    for (let round = 0; round < 5; round += 1) guest.emit("apps:yjs:update", { appId: BOARD, update: NEON_DELETE_AT_STATE });
    await ask(host, "apps:lock", { locked: true });
    await ask(guest, "apps:yjs:sync", { appId: BOARD, syncMessage: Y.encodeStateVector(new Y.Doc()) });
    for (let round = 0; round < 5; round += 1) guest.emit("apps:yjs:update", { appId: BOARD, update: NEON_DELETE_AT_STATE });

    const state = await ask<{ activeAppId: string | null; locked: boolean }>(guest, "apps:getState");
    const sync = await ask<{ syncMessage?: unknown }>(host, "apps:yjs:sync", {
      appId: BOARD,
      syncMessage: Y.encodeStateVector(new Y.Doc()),
    });
    expect(state).toMatchObject({ activeAppId: BOARD, locked: true });
    expect(sync).toHaveProperty("syncMessage");
    expect(failures.filter((line) => line.includes("Handler for"))).toEqual([]);
  });
});

const varUint = (value: number): number[] => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, value);
  return Array.from(encoding.toUint8Array(encoder));
};

const fuzzPayloads = (random: () => number, known: { clients: number[]; state: (client: number) => number; valid: Uint8Array[] }) => {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const int = (max: number) => Math.floor(random() * max);
  const around = (value: number) => Math.max(0, value + pick([-2, -1, 0, 1, 2, 1000, 2 ** 31]));
  const randomBytes = () => Uint8Array.from({ length: int(48) }, () => int(256));
  const mutate = (source: Uint8Array) => {
    const bytes = Array.from(source);
    const edits = 1 + int(4);
    for (let edit = 0; edit < edits; edit += 1) {
      const at = int(bytes.length + 1);
      const roll = random();
      if (roll < 0.3) bytes.splice(at, 1);
      else if (roll < 0.6) bytes.splice(at, 0, int(256));
      else if (bytes.length > 0) bytes[at % bytes.length] ^= 1 << int(8);
    }
    return Uint8Array.from(bytes);
  };
  const deleteSet = () => {
    const client = known.clients.length > 0 && random() < 0.8 ? pick(known.clients) : int(2 ** 32);
    const entries = 1 + int(3);
    const bytes = [0, 1, ...varUint(client), ...varUint(entries)];
    for (let entry = 0; entry < entries; entry += 1) {
      bytes.push(...varUint(around(known.state(client))), ...varUint(pick([0, 1, 2, around(3)])));
    }
    return Uint8Array.from(bytes);
  };
  const stateVector = () => {
    const entries = int(5);
    const bytes = [...varUint(random() < 0.1 ? 2 ** 31 : entries)];
    for (let entry = 0; entry < entries; entry += 1) bytes.push(...varUint(int(2 ** 32)), ...varUint(int(2 ** 20)));
    return random() < 0.3 ? Uint8Array.from(bytes.slice(0, int(bytes.length + 1))) : Uint8Array.from(bytes);
  };
  const awareness = () => {
    const state = pick(['{"x":1}', "null", "{", "ÿ", '"s"', ""]);
    const length = random() < 0.2 ? 2 ** 30 : new TextEncoder().encode(state).length;
    const bytes = [...varUint(1 + int(2)), ...varUint(int(2 ** 32)), ...varUint(int(10)), ...varUint(length)];
    bytes.push(...new TextEncoder().encode(state));
    return random() < 0.3 ? Uint8Array.from(bytes.slice(0, int(bytes.length + 1))) : Uint8Array.from(bytes);
  };
  const asWire = (bytes: Uint8Array): unknown =>
    pick<() => unknown>([
      () => bytes,
      () => Buffer.from(bytes).toString("base64"),
      () => Array.from(bytes),
      () => ({ type: "Buffer", data: Array.from(bytes) }),
      () => [...Array.from(bytes), "x"],
      () => `${Buffer.from(bytes).toString("base64")}!`,
      () => ({ length: bytes.length }),
      () => null,
      () => 12,
    ])();
  const update = () =>
    pick<() => Uint8Array>([
      randomBytes,
      deleteSet,
      () => (known.valid.length > 0 ? mutate(pick(known.valid)) : randomBytes()),
      () => (known.valid.length > 0 ? pick(known.valid).slice(0, int(pick(known.valid).length)) : randomBytes()),
      () => Uint8Array.from([0, 0]),
      () => Uint8Array.from([0, 1, ...varUint(pick(known.clients.length ? known.clients : [1])), 1, 0, 0]),
    ])();
  return { update: () => asWire(update()), stateVector: () => asWire(stateVector()), awareness: () => asWire(awareness()), pick };
};

describe("the apps handlers under malformed input", () => {
  it.each([7, 270, 4242])("refuse or ignore every malformed update, sync and presence packet, seed %i", (seed) => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const random = seededRandom(seed);
    const rooms = makeWorkRooms();
    const host = rooms.connect("host#1", { host: true });
    host.command("open", BOARD);
    host.sync();
    const writer = rooms.connect("writer#1", { host: true });
    writer.sync();
    const peers = [
      rooms.connect("unsynced#1"),
      rooms.connect("synced#1"),
      rooms.connect("legacy#1", { legacy: true }),
      rooms.connect("legacy-synced#1", { legacy: true }),
    ];
    peers[1].sync();
    peers[3].sync();
    const room = rooms.roomFor("room");
    const known = {
      clients: [] as number[],
      state: (client: number) => Y.getState(room.apps.liveDoc(BOARD)?.store ?? new Y.Doc().store, client),
      valid: [] as Uint8Array[],
    };
    const payloads = fuzzPayloads(random, known);
    let probes = 0;

    for (let step = 1; step <= 1500; step += 1) {
      const peer = payloads.pick(peers);
      const roll = random();
      if (roll < 0.6) peer.sendPayload(payloads.update(), payloads.pick([undefined, "copy-x", `copy-${step}`]));
      else if (roll < 0.8) peer.syncPayload(payloads.stateVector());
      else if (roll < 0.95) peer.awarenessPayload(payloads.awareness());
      else host.command(payloads.pick(["lock", "unlock"] as const));
      if (step % 50 !== 0) continue;
      vi.advanceTimersByTime(40);
      for (const reacting of peers) reacting.react();
      const [id] = writer.write(1);
      vi.advanceTimersByTime(40);
      expect(room.apps.liveDoc(BOARD)!.getMap("m").has(id)).toBe(true);
      expect(writer.sync().reply).toBeDefined();
      known.valid = rooms.sent.map((entry) => entry.update);
      known.clients = [...new Set(known.valid.flatMap((update) => Y.decodeUpdate(update).structs.map((struct) => struct.id.client)))];
      probes += 1;
    }

    expect(probes).toBe(30);
  });
});
