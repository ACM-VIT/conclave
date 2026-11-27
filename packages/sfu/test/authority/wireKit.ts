/**
 * A real SFU socket server for tests: socket.io with the SFU's auth and every
 * handler it registers, a room to join, and real client connections.
 */
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer } from "socket.io";
import { io as connectSocket, type Socket as ClientSocket } from "socket.io-client";
import {
  AUTHORITY_EVENTS,
  AuthorityClient,
  type AuthorityContract,
  type AuthorityFrame,
  type AuthoritySession,
  type Json,
} from "@conclave/apps-sdk/authority";
import type { AuthorityModule } from "@conclave/apps-sdk/authority/server";
import { config } from "../../config/config.js";
import { Room } from "../../config/classes/Room.js";
import { createAppsAuthorityRuntime } from "../../server/apps/authority/index.js";
import {
  DEFAULT_AUTHORITY_LIMITS,
  type AuthorityLimits,
} from "../../server/apps/authority/limits.js";
import { LocalRoomRegistry } from "../../server/roomRegistry.js";
import { createSfuSocketServer } from "../../server/socket/createSocketServer.js";
import { createSfuState, type SfuState } from "../../server/state.js";

export const CLIENT_ID = "conclave";
export const ROOM_ID = "wire";
export const HOST = "asha@example.com";

export type Stack = {
  state: SfuState;
  io: SocketIOServer;
  http: HttpServer;
  room: Room;
  url: string;
};

export type Peer<C extends AuthorityContract> = {
  socket: ClientSocket;
  seatId: string;
  client: AuthorityClient;
  session: AuthoritySession<C>;
  /** Every authority frame this socket received, in order. */
  frames: AuthorityFrame[];
};

export const stacks: Stack[] = [];
export const sockets: ClientSocket[] = [];

/** Closes every socket and server a test opened. Call from `afterEach`. */
export const closeAll = async (): Promise<void> => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  for (const stack of stacks.splice(0)) {
    await stack.io.close();
    stack.http.close();
  }
};

export const until = async (check: () => boolean, label: string, timeoutMs = 4_000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A room with a stand-in router, registered as the SFU would register it. */
export const addRoom = (state: SfuState, id: string): Room => {
  const router = {
    closed: false,
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close: () => {
      router.closed = true;
    },
  };
  const room = new Room({
    id,
    clientId: CLIENT_ID,
    workerPid: null,
    router: router as unknown as Router,
  });
  room.grantHost(HOST, "fallback");
  room.makePrimaryHost(HOST);
  state.rooms.set(room.channelId, room);
  return room;
};

export const start = async (
  modules: readonly AuthorityModule[] | null,
  limits: Partial<AuthorityLimits> = {},
): Promise<Stack> => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "authority-wire",
      instanceUrl: "http://localhost",
      ttlMs: 45_000,
    }),
    appsAuthority: modules
      ? createAppsAuthorityRuntime({
          modules,
          verifyViews: true,
          limits: { ...DEFAULT_AUTHORITY_LIMITS, ...limits },
        })
      : null,
  });
  const http = createServer();
  const io = createSfuSocketServer(http, { state });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const room = addRoom(state, ROOM_ID);
  const stack = {
    state,
    io,
    http,
    room,
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
  };
  stacks.push(stack);
  return stack;
};

export const ask = <Reply>(socket: ClientSocket, event: string, payload?: unknown) =>
  new Promise<Reply>((resolve) => {
    if (payload === undefined) socket.emit(event, resolve);
    else socket.emit(event, payload, resolve);
  });

/** A real connection that authenticates and joins the room. */
export const connect = async (
  stack: Stack,
  who: { email: string; name: string; session: string },
  options: {
    join?: { roomId: string; joinMode?: string };
    reconnection?: boolean;
    transports?: ("polling" | "websocket")[];
    /** Runs before the join, as a client that listens first would. */
    prepare?: (socket: ClientSocket) => void;
  } = {},
): Promise<{ socket: ClientSocket; seatId: string; frames: AuthorityFrame[] }> => {
  stack.room.allowUser(who.email);
  const token = jwt.sign(
    {
      userId: who.email,
      email: who.email.includes("@") ? who.email : undefined,
      name: who.name,
      sessionId: who.session,
      clientId: CLIENT_ID,
      joinMode: options.join?.joinMode ?? "meeting",
    },
    config.sfuSecret,
    { algorithm: "HS256" },
  );
  const socket = connectSocket(stack.url, {
    auth: { token },
    transports: options.transports ?? ["websocket"],
    forceNew: true,
    reconnection: options.reconnection ?? false,
    reconnectionDelay: 20,
    reconnectionDelayMax: 40,
  });
  sockets.push(socket);
  const frames: AuthorityFrame[] = [];
  socket.on(AUTHORITY_EVENTS.frame, (frame: AuthorityFrame) => frames.push(frame));
  options.prepare?.(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  const joined = await ask<{ error?: string; status?: string }>(socket, "joinRoom", {
    roomId: options.join?.roomId ?? ROOM_ID,
    sessionId: who.session,
  });
  if (joined.error || joined.status === "waiting") {
    throw new Error(`join failed: ${joined.error ?? joined.status}`);
  }
  return { socket, seatId: `${who.email}#${who.session}`, frames };
};

export const open = async <C extends AuthorityContract>(
  stack: Stack,
  who: { email: string; name: string; session: string },
  contract: C,
  options: {
    ackTimeoutMs?: number;
    expectReady?: boolean;
    reconnection?: boolean;
    transports?: ("polling" | "websocket")[];
    join?: { roomId: string; joinMode?: string };
  } = {},
): Promise<Peer<C>> => {
  const connection = await connect(stack, who, {
    reconnection: options.reconnection,
    transports: options.transports,
    join: options.join,
  });
  const client = new AuthorityClient({
    socket: connection.socket,
    ackTimeoutMs: options.ackTimeoutMs ?? 1_000,
  });
  const session = client.open(contract);
  client.joined();
  if (options.expectReady !== false) {
    await until(() => session.getState().kind === "ready", `${who.name} ready`);
  }
  return { ...connection, client, session };
};

export const row = <C extends AuthorityContract>(peer: Peer<C>, bucket: string, key: string): Json | null => {
  const state = peer.session.getState();
  if (state.kind !== "ready") return null;
  return (state.view as Record<string, ReadonlyMap<string, Json>>)[bucket]?.get(key) ?? null;
};

export const rows = <C extends AuthorityContract>(peer: Peer<C>, bucket: string): Json[] => {
  const state = peer.session.getState();
  if (state.kind !== "ready") return [];
  return [...((state.view as Record<string, ReadonlyMap<string, Json>>)[bucket]?.values() ?? [])];
};

export const field = (value: Json | null, ...path: string[]): Json | null => {
  let node: Json | null = value;
  for (const key of path) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
    node = (node as { readonly [key: string]: Json })[key] ?? null;
  }
  return node;
};
