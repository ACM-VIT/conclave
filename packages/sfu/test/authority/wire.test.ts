/**
 * The authority transport on real sockets: a real socket.io server with the
 * SFU's auth and every handler it registers, real client connections that
 * join through `joinRoom`, and the real client session on each.
 */
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer } from "socket.io";
import { io as connectSocket, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHORITY_EVENTS,
  AuthorityClient,
  type AuthorityContract,
  type AuthorityFrame,
  type AuthorityResult,
  type AuthoritySession,
  type Json,
} from "@conclave/apps-sdk/authority";
import type { AuthorityModule } from "@conclave/apps-sdk/authority/server";
import { config } from "../../config/config.js";
import { answer } from "./answer.js";
import { Room } from "../../config/classes/Room.js";
import {
  createAppsAuthorityRuntime,
  getRoomAuthority,
  socketPressure,
} from "../../server/apps/authority/index.js";
import {
  DEFAULT_AUTHORITY_LIMITS,
  type AuthorityLimits,
} from "../../server/apps/authority/limits.js";
import { LocalRoomRegistry } from "../../server/roomRegistry.js";
import { forceCloseRoom } from "../../server/rooms.js";
import { createSfuSocketServer } from "../../server/socket/createSocketServer.js";
import { createSfuState, type SfuState } from "../../server/state.js";
import {
  getOrCreateWebinarRoomConfig,
  setCustomWebinarLinkSlug,
} from "../../server/webinar.js";
import { emitWebinarConfigChanged } from "../../server/webinarNotifications.js";
import { pollsAuthority, pollsContract } from "./fixtures/polls.js";
import { probeAuthority, probeContract } from "./fixtures/probe.js";
import { qaAuthority } from "./fixtures/qa.js";

const CLIENT_ID = "conclave";
const ROOM_ID = "wire";
const HOST = "asha@example.com";

type Stack = {
  state: SfuState;
  io: SocketIOServer;
  http: HttpServer;
  room: Room;
  url: string;
};

type Peer<C extends AuthorityContract> = {
  socket: ClientSocket;
  seatId: string;
  client: AuthorityClient;
  session: AuthoritySession<C>;
  /** Every authority frame this socket received, in order. */
  frames: AuthorityFrame[];
};

const stacks: Stack[] = [];
const sockets: ClientSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  for (const stack of stacks.splice(0)) {
    await stack.io.close();
    stack.http.close();
  }
});

const until = async (check: () => boolean, label: string, timeoutMs = 4_000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A room with a stand-in router, registered as the SFU would register it. */
const addRoom = (state: SfuState, id: string): Room => {
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
  room.hostUserKey = HOST;
  state.rooms.set(room.channelId, room);
  return room;
};

const start = async (
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

const ask = <Reply>(socket: ClientSocket, event: string, payload?: unknown) =>
  new Promise<Reply>((resolve) => {
    if (payload === undefined) socket.emit(event, resolve);
    else socket.emit(event, payload, resolve);
  });

/** A real connection that authenticates and joins the room. */
const connect = async (
  stack: Stack,
  who: { email: string; name: string; session: string },
  options: {
    join?: { roomId: string; joinMode?: string };
    reconnection?: boolean;
    transports?: ("polling" | "websocket")[];
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

const open = async <C extends AuthorityContract>(
  stack: Stack,
  who: { email: string; name: string; session: string },
  contract: C,
  options: {
    ackTimeoutMs?: number;
    expectReady?: boolean;
    reconnection?: boolean;
    transports?: ("polling" | "websocket")[];
  } = {},
): Promise<Peer<C>> => {
  const connection = await connect(stack, who, {
    reconnection: options.reconnection,
    transports: options.transports,
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

const row = <C extends AuthorityContract>(peer: Peer<C>, bucket: string, key: string): Json | null => {
  const state = peer.session.getState();
  if (state.kind !== "ready") return null;
  return (state.view as Record<string, ReadonlyMap<string, Json>>)[bucket]?.get(key) ?? null;
};

const rows = <C extends AuthorityContract>(peer: Peer<C>, bucket: string): Json[] => {
  const state = peer.session.getState();
  if (state.kind !== "ready") return [];
  return [...((state.view as Record<string, ReadonlyMap<string, Json>>)[bucket]?.values() ?? [])];
};

const field = (value: Json | null, ...path: string[]): Json | null => {
  let node: Json | null = value;
  for (const key of path) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
    node = (node as { readonly [key: string]: Json })[key] ?? null;
  }
  return node;
};

/** Rows in a frame that show poll results. */
const tallies = (frames: AuthorityFrame[]) =>
  frames.flatMap((frame) =>
    frame.kind === "replace" || frame.kind === "patch"
      ? (frame.kind === "replace" ? frame.rows : frame.put).filter(
          (entry) => entry.bucket === "polls" && field(entry.value, "results") !== null,
        )
      : [],
  );

const asha = { email: HOST, name: "Asha", session: "h1" };
const priya = { email: "priya@example.com", name: "Priya", session: "p1" };
const ravi = { email: "ravi@example.com", name: "Ravi", session: "r1" };

const createPoll = async (hostPeer: Peer<typeof pollsContract>): Promise<string> => {
  const created = await hostPeer.session.act("create", {
    question: "Lunch?",
    options: ["Tea", "Coffee"],
  });
  if (!created.ok) throw new Error(`create failed: ${created.code}`);
  return created.value.pollId;
};

describe("authority transport on real sockets", () => {
  it("delivers each connection its own view and nothing else", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const voter = await open(stack, priya, pollsContract);
    const other = await open(stack, ravi, pollsContract);
    const pollId = await createPoll(host);
    await until(() => row(other, "polls", pollId) !== null, "poll reaches Ravi");

    const voted = await voter.session.act("vote", { pollId, optionIds: ["o1"] });
    await until(
      () => field(row(host, "polls", pollId), "results", "voterCount") === 1,
      "tally reaches the host",
    );
    await wait(120);

    expect(answer(voted)).toEqual({ ok: true, value: null });
    expect(field(row(voter, "myVotes", pollId), "optionIds")).toEqual(["o1"]);
    expect(tallies(voter.frames)).toEqual([]);
    expect(tallies(other.frames)).toEqual([]);
    expect(JSON.stringify(other.frames)).not.toContain("myVotes");
  });

  it("two tabs of one person share one vote and both learn of it", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const tabA = await open(stack, priya, pollsContract);
    const tabB = await open(stack, { ...priya, session: "p2" }, pollsContract);
    const pollId = await createPoll(host);
    await until(() => row(tabB, "polls", pollId) !== null, "poll reaches tab B");

    const [first, second] = await Promise.all([
      tabA.session.act("vote", { pollId, optionIds: ["o1"] }),
      tabB.session.act("vote", { pollId, optionIds: ["o2"] }),
    ]);
    await until(() => row(tabA, "myVotes", pollId) !== null, "tab A learns");
    await until(() => row(tabB, "myVotes", pollId) !== null, "tab B learns");

    expect([first.ok, second.ok].filter(Boolean).length).toBe(1);
    expect(row(tabA, "myVotes", pollId)).toEqual(row(tabB, "myVotes", pollId));
    await until(
      () => field(row(host, "polls", pollId), "results", "voterCount") === 1,
      "one voter counted",
    );
  });

  it("a removed co-host gets nothing more and can do nothing more", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const cohost = await open(stack, ravi, pollsContract);
    const pollId = await createPoll(host);
    await ask(host.socket, "promoteHost", { userId: cohost.seatId });
    await until(
      () => field(row(cohost, "polls", pollId), "results") !== null,
      "promotion shows the tally",
    );

    const kicked = new Promise<void>((resolve) => cohost.socket.once("disconnect", () => resolve()));
    await ask(host.socket, "kickUser", { userId: cohost.seatId });
    await kicked;
    const framesAtKick = cohost.frames.length;
    await host.session.act("share", { pollId, shared: true });
    await wait(150);

    // The same identity cannot walk back in as a host.
    const rejoined = await connect(stack, ravi);
    const exportAfter = await ask<AuthorityResult<Json>>(rejoined.socket, AUTHORITY_EVENTS.query, {
      roomEpoch: getRoomAuthority(stack.state, stack.room)!.roomEpoch,
      subscription: cohost.frames[0].subscription,
      generation: 2,
      request: "export-after-kick",
      query: "exportBallots",
      input: { pollId },
    });

    expect(cohost.frames.slice(framesAtKick).filter((frame) => frame.kind !== "revoke")).toEqual([]);
    expect(exportAfter).toEqual({ ok: false, code: "not-subscribed" });
    expect(stack.room.isAdminUserKey(ravi.email)).toBe(false);
  });

  it("ends the first socket's view when a second connection takes its seat", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const first = await open(stack, priya, pollsContract);
    const pollId = await createPoll(host);
    await until(() => row(first, "polls", pollId) !== null, "poll reaches the first socket");

    // Same session, new socket: the room swaps the seat, the old socket stays open.
    const second = await open(stack, priya, pollsContract);
    await until(() => first.session.getState().kind === "revoked", "old view revoked");
    const framesAtSwap = first.frames.length;
    await host.session.act("share", { pollId, shared: true });
    await until(() => field(row(second, "polls", pollId), "resultsShared") === true, "new socket updated");
    const oldVote = await ask<AuthorityResult<Json>>(first.socket, AUTHORITY_EVENTS.act, {
      roomEpoch: getRoomAuthority(stack.state, stack.room)!.roomEpoch,
      subscription: first.frames[0].subscription,
      generation: 1,
      operation: { issuedAtMs: Date.now(), nonce: "op-from-old-socket" },
      action: "vote",
      input: { pollId, optionIds: ["o1"] },
    });

    expect(first.socket.connected).toBe(true);
    expect(first.frames.slice(framesAtSwap)).toEqual([]);
    expect(oldVote).toEqual({ ok: false, code: "not-in-room" });
  });

  it("a demoted panelist loses the meeting's apps and keeps only the audience's", async () => {
    const stack = await start([pollsAuthority, qaAuthority]);
    const host = await open(stack, asha, pollsContract);
    const panelist = await open(stack, priya, pollsContract);
    const pollId = await createPoll(host);
    await until(() => row(panelist, "polls", pollId) !== null, "poll reaches the panelist");

    const webinar = getOrCreateWebinarRoomConfig(stack.state.webinarConfigs, stack.room.channelId);
    webinar.enabled = true;
    webinar.publicAccess = true;
    setCustomWebinarLinkSlug({
      webinarConfig: webinar,
      webinarLinks: stack.state.webinarLinks,
      room: stack.room,
      slug: "launch",
    });
    emitWebinarConfigChanged(stack.io, stack.state, stack.room);

    const gone = new Promise<void>((resolve) => panelist.socket.once("disconnect", () => resolve()));
    await ask(host.socket, "webinar:demoteParticipant", { userId: panelist.seatId });
    await gone;
    const framesAtDemotion = panelist.frames.length;
    await host.session.act("share", { pollId, shared: true });
    await wait(150);

    const audience = await connect(stack, priya, {
      join: { roomId: "launch", joinMode: "webinar_attendee" },
    });
    const capability = await ask<AuthorityResult<{ apps: { app: string; instance: string }[] }>>(
      audience.socket,
      AUTHORITY_EVENTS.capabilities,
      { protocols: [1] },
    );
    const pollsInstance = host.client.entryFor(pollsContract)!.instance;
    const sneak = await ask<AuthorityResult<null>>(audience.socket, AUTHORITY_EVENTS.subscribe, {
      roomEpoch: getRoomAuthority(stack.state, stack.room)!.roomEpoch,
      instance: pollsInstance,
      app: "polls",
      major: 1,
      subscription: "sneak-back-in",
    });

    expect(panelist.frames.slice(framesAtDemotion)).toEqual([]);
    expect(capability.ok && capability.value.apps.map((entry) => entry.app)).toEqual(["qa"]);
    expect(sneak).toEqual({ ok: false, code: "forbidden" });
    expect(audience.frames).toEqual([]);
  });

  it("a reconnecting client gets its view back and its vote still stands", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const voter = await open(stack, priya, pollsContract, { reconnection: true });
    const pollId = await createPoll(host);
    await until(() => row(voter, "polls", pollId) !== null, "poll reaches the voter");
    await voter.session.act("vote", { pollId, optionIds: ["o1"] });

    // The transport drops. socket.io reconnects, and the app rejoins the room.
    voter.socket.once("connect", () => {
      void ask(voter.socket, "joinRoom", { roomId: ROOM_ID, sessionId: priya.session });
    });
    voter.socket.io.engine.close();
    await until(() => voter.session.getState().kind !== "ready", "view dropped on disconnect");
    await until(() => voter.session.getState().kind === "ready", "view back after reconnect", 8_000);

    const again = await voter.session.act("vote", { pollId, optionIds: ["o2"] });

    expect(field(row(voter, "myVotes", pollId), "optionIds")).toEqual(["o1"]);
    expect(again).toEqual({ ok: false, code: "rejected", reason: "already-voted" });
    expect(field(row(host, "polls", pollId), "results", "voterCount")).toBe(1);
  });

  it("resends an action whose answer was lost, and it runs once", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const voter = await open(stack, priya, pollsContract, { ackTimeoutMs: 150 });
    const pollId = await createPoll(host);
    await until(() => row(voter, "polls", pollId) !== null, "poll reaches the voter");

    const emit = voter.socket.emit.bind(voter.socket);
    let lost = 0;
    voter.socket.emit = ((event: string, ...args: unknown[]) => {
      if (event === AUTHORITY_EVENTS.act && lost === 0) {
        lost += 1;
        return emit(event, args[0], () => {});
      }
      return emit(event, ...args);
    }) as ClientSocket["emit"];

    const result = await voter.session.act("vote", { pollId, optionIds: ["o1"] });
    await until(
      () => field(row(host, "polls", pollId), "results", "voterCount") === 1,
      "the vote counted",
    );

    expect(lost).toBe(1);
    expect(answer(result)).toEqual({ ok: true, value: null });
  });

  it("does not carry an unanswered action into another room", async () => {
    const stack = await start([probeAuthority]);
    addRoom(stack.state, "elsewhere").allowUser(asha.email);
    const host = await open(stack, asha, probeContract, { ackTimeoutMs: 150 });

    // The first room runs the action. Its answer never arrives.
    const emit = host.socket.emit.bind(host.socket);
    let lost = 0;
    host.socket.emit = ((event: string, ...args: unknown[]) => {
      if (event === AUTHORITY_EVENTS.act && lost === 0) {
        lost += 1;
        return emit(event, args[0], () => {});
      }
      return emit(event, ...args);
    }) as ClientSocket["emit"];
    const pending = host.session.act("put", { id: "note", text: "for the first room" });
    await until(() => lost === 1, "the action left");

    // The same socket moves to another room before the retry goes out.
    await ask(host.socket, "joinRoom", { roomId: "elsewhere", sessionId: asha.session });
    host.client.joined();
    const result = await pending;
    await until(() => host.session.getState().kind === "ready", "the other room's view");
    await wait(150);

    expect(result).toEqual({ ok: false, code: "unknown-outcome" });
    expect(rows(host, "notes")).toEqual([]);
  });

  it("holds patches back from a polling client that has stopped asking for them", async () => {
    // Only the bytes can say this client is behind: the packet marks are out of reach.
    const stack = await start([probeAuthority], {
      socketSoftBytes: 24 * 1024,
      socketSoftPackets: 100_000,
      socketHardPackets: 1_000_000,
      lagRecheckMs: 50,
    });
    const hostPeer = await open(stack, asha, probeContract);
    const slow = await open(stack, priya, probeContract, { transports: ["polling"] });
    const serverSide = stack.io.sockets.sockets.get(slow.socket.id ?? "");
    if (!serverSide) throw new Error("no server socket for the polling client");
    const authority = getRoomAuthority(stack.state, stack.room);
    if (!authority) throw new Error("the room has no authority runtime");
    const transport = slow.socket.io.engine.transport as unknown as {
      pause(done: () => void): void;
      readyState: string;
      _poll(): void;
    };
    const before = socketPressure(serverSide);
    const framesBefore = slow.frames.length;
    // The client stops polling, as one on a stalled connection would. The
    // poll it already has open is answered, and it asks for nothing after.
    transport.pause(() => {});

    // Sixty notes of about 4 KB each, changed one after another.
    const text = (round: number) => `${round} `.padEnd(3_900, "x");
    const queued: number[] = [];
    for (let round = 0; round < 60; round += 1) {
      await hostPeer.session.act("put", { id: `n${round % 5}`, text: text(round) });
      await wait(12);
      queued.push(socketPressure(serverSide).packets);
    }
    await until(() => row(hostPeer, "notes", "n4") !== null, "the host has the last notes");
    const behind = socketPressure(serverSide);
    const patchesQueuedAtTheEnd = queued[queued.length - 1] - queued[queued.length - 10];

    // It polls again, and is caught up with one whole view.
    transport.readyState = "open";
    transport._poll();
    await until(
      () => field(row(slow, "notes", "n4"), "text") === text(59),
      "the slow client has the latest notes",
      6_000,
    );

    // While it polls, its queue holds next to nothing from one poll to the next.
    expect(before.bytes).toBeLessThan(1_024);
    // Its queue is counted in bytes, and passes the mark long before 60 patches.
    expect(behind.bytes).toBeGreaterThan(24 * 1024);
    expect(behind.bytes).toBeLessThan(60 * 3_900);
    expect(behind.packets).toBeLessThan(20);
    // Once it was behind, nothing more was queued for it.
    expect(patchesQueuedAtTheEnd).toBe(0);
    expect(authority.stats.resnapshots).toBeGreaterThanOrEqual(1);
    expect(slow.frames.slice(framesBefore).some((frame) => frame.kind === "replace")).toBe(true);
    expect(rows(slow, "notes").length).toBe(5);
  }, 20_000);

  it("fires a timer on the server with no client asking", async () => {
    const stack = await start([probeAuthority]);
    const host = await open(stack, asha, probeContract);
    const watcher = await open(stack, priya, probeContract);

    const scheduledAt = Date.now();
    await host.session.act("schedule", { id: "bell", afterMs: 200, label: "ring" });
    host.socket.disconnect();
    await until(() => rows(watcher, "fired").length === 1, "the timer fired");

    expect(Date.now() - scheduledAt).toBeGreaterThanOrEqual(195);
    expect(field(rows(watcher, "fired")[0], "label")).toBe("ring");
  });

  it("tears everything down with the room", async () => {
    const stack = await start([probeAuthority]);
    const host = await open(stack, asha, probeContract);
    await host.session.act("schedule", { id: "bell", afterMs: 200, label: "never" });
    const authority = getRoomAuthority(stack.state, stack.room)!;
    const framesAtClose = host.frames.length;

    forceCloseRoom(stack.state, stack.room);
    await wait(400);
    const afterClose = await ask<AuthorityResult<Json>>(host.socket, AUTHORITY_EVENTS.act, {
      roomEpoch: authority.roomEpoch,
      subscription: host.frames[0].subscription,
      generation: 1,
      operation: { issuedAtMs: Date.now(), nonce: "op-after-close" },
      action: "put",
      input: { id: "late", text: "too late" },
    });

    expect(authority.isClosed).toBe(true);
    expect(host.frames.slice(framesAtClose)).toMatchObject([
      { kind: "revoke", reason: "closed" },
    ]);
    expect(host.session.getState()).toEqual({ kind: "revoked", reason: "closed" });
    expect(afterClose).toEqual({ ok: false, code: "not-in-room" });
  });

  it("an SFU without the runtime never answers, so the client hides the app", async () => {
    const stack = await start(null);
    const host = await open(stack, asha, pollsContract, {
      ackTimeoutMs: 200,
      expectReady: false,
    });
    await until(() => host.client.capabilities.kind === "unsupported", "client gives up");

    expect(host.session.getState()).toEqual({ kind: "unsupported" });
    expect(await host.session.act("create", { question: "Q", options: ["a", "b"] })).toEqual({
      ok: false,
      code: "unsupported",
    });
    expect(host.frames).toEqual([]);
  });

  it("a client that never asks is sent no authority event", async () => {
    const stack = await start([pollsAuthority]);
    const host = await open(stack, asha, pollsContract);
    const legacy = await connect(stack, priya);
    const seen: string[] = [];
    legacy.socket.onAny((event: string) => {
      if (event.startsWith("apps:authority")) seen.push(event);
    });

    const pollId = await createPoll(host);
    await host.session.act("share", { pollId, shared: true });
    await wait(150);

    expect(seen).toEqual([]);
    expect(legacy.frames).toEqual([]);
  });
});
