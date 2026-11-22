/**
 * Measures telling a webinar of old clients about one flush of Q&A changes.
 *
 *   pnpm -C packages/sfu exec tsx scripts/measure-legacy-qa-flush.ts [listeners] [questions] [--out file.json]
 *
 * The room, the Q&A app, the runtime and the legacy adapter are the real
 * ones. The sockets are simulated: nothing crosses a network, but every
 * packet is built as socket.io builds it. A packet sent to one socket is
 * encoded and framed for that socket. A local broadcast is encoded and
 * framed once and the same bytes are queued for each socket, which is what
 * socket.io's adapter does. What is measured is therefore the server's own
 * work for the fan-out: how often it encodes, how much it queues, and for
 * how long it holds the event loop.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { pollsAuthority } from "@conclave/apps-sdk/polls/server";
import { qaAuthority } from "@conclave/apps-sdk/qa/server";
import { Admin } from "../config/classes/Admin.js";
import { Client } from "../config/classes/Client.js";
import { Room } from "../config/classes/Room.js";
import {
  createAppsAuthorityRuntime,
  getRoomAuthority,
} from "../server/apps/authority/index.js";
import {
  attachLegacyQaFeed,
  legacyQaSubmit,
} from "../server/apps/authority/legacyWebinarQa.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createConnectionContext } from "../server/socket/context.js";
import { createSfuState } from "../server/state.js";
import { getOrCreateWebinarRoomConfig } from "../server/webinar.js";
import type { WebinarQaChangedNotification } from "../types.js";

const fromSocketIo = createRequire(createRequire(import.meta.url).resolve("socket.io"));
const { Encoder } = fromSocketIo("socket.io-parser") as {
  Encoder: new () => { encode(packet: object): string[] };
};
const { Sender } = createRequire(fromSocketIo.resolve("engine.io"))("ws") as {
  Sender: { frame(data: Buffer, options: object): Buffer[] };
};

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : null;
const numbers = args.filter(
  (arg, index) => /^\d+$/.test(arg) && (outIndex < 0 || index !== outIndex + 1),
);
const LISTENERS = Number(numbers[0] ?? 5_000);
const QUESTIONS = Number(numbers[1] ?? 20);
const RUNS = 5;

const counters = { encodings: 0, encodedBytes: 0, socketWrites: 0 };
const encoder = new Encoder();

/** One packet as it would leave for a websocket: encoded, then framed. */
const encode = (event: string, payload: unknown): Buffer[] => {
  const [text] = encoder.encode({ type: 2, data: [event, payload], nsp: "/" });
  // Engine.io marks a message packet with a leading "4".
  const data = Buffer.from(`4${text}`);
  counters.encodings += 1;
  counters.encodedBytes += data.length;
  return Sender.frame(data, { readOnly: false, mask: false, rsv1: false, opcode: 1, fin: true });
};

type Listener = (payload: unknown) => void;
type FakeSocket = Socket & { queue(frame: Buffer[], event: string, payload: unknown): void };
const sockets = new Map<string, FakeSocket>();

const makeSocket = (
  id: string,
): { socket: FakeSocket; on: (event: string, listener: Listener) => void } => {
  const listeners = new Map<string, Listener>();
  const socket = {
    id,
    data: {},
    connected: true,
    conn: { writeBuffer: [] as unknown[] },
    on: () => socket,
    join: () => {},
    leave: () => {},
    to: () => ({ emit: () => true }),
    disconnect: () => socket,
    /** Queues bytes for this socket and hands the client the payload. */
    queue(_frame: Buffer[], event: string, payload: unknown) {
      counters.socketWrites += 1;
      listeners.get(event)?.(payload);
    },
    emit(event: string, payload?: unknown) {
      socket.queue(encode(event, payload), event, payload);
      return true;
    },
  } as unknown as FakeSocket;
  sockets.set(id, socket);
  return { socket, on: (event, listener) => listeners.set(event, listener) };
};

const io = {
  to: () => ({ emit: () => true }),
  local: {
    to: (ids: string | string[]) => ({
      emit: (event: string, payload: unknown) => {
        const frame = encode(event, payload);
        for (const id of [ids].flat()) sockets.get(id)?.queue(frame, event, payload);
        return true;
      },
    }),
  },
} as unknown as SocketIOServer;

const state = createSfuState({
  roomRegistry: new LocalRoomRegistry({
    instanceId: "legacy-qa-flush",
    instanceUrl: "http://localhost",
    ttlMs: 45_000,
  }),
  appsAuthority: createAppsAuthorityRuntime({
    modules: [pollsAuthority, qaAuthority],
    verifyViews: false,
  }),
});
const room = new Room({
  id: "legacy-qa-flush",
  clientId: "conclave",
  workerPid: null,
  router: { closed: false, close: () => {} } as unknown as Router,
});
state.rooms.set(room.channelId, room);
getOrCreateWebinarRoomConfig(state.webinarConfigs, room.channelId).enabled = true;

const seat = (key: string, name: string, kind: "host" | "attendee") => {
  const { socket, on } = makeSocket(`socket-${key}`);
  const id = `${key}#s1`;
  const client =
    kind === "host"
      ? new Admin({ id, socket })
      : new Client({ id, socket, mode: "webinar_attendee" });
  room.setUserIdentity(id, key, name);
  if (kind === "host") room.hostUserKey = key;
  room.addClient(client);
  const context = createConnectionContext(io, socket, state);
  context.currentRoom = room;
  context.currentClient = client;
  return { context, on };
};

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const settle = async (): Promise<void> => {
  for (let index = 0; index < 400; index += 1) await turn();
};

const main = async (): Promise<void> => {
  const host = seat("asha@example.com", "Asha", "host");
  const authority = getRoomAuthority(state, room);
  if (!authority) throw new Error("The room has no authority runtime");

  /** How many of the changes each listener has heard, as status by id. */
  const heard: Map<string, string>[] = [];
  const attendees: ReturnType<typeof seat>[] = [];
  for (let index = 0; index < LISTENERS; index += 1) {
    const attendee = seat(`attendee${index}@example.com`, `Attendee ${index}`, "attendee");
    const statuses = new Map<string, string>();
    attendee.on("webinar:qaChanged", (payload) => {
      const entry = (payload as WebinarQaChangedNotification).entry;
      if (entry) statuses.set(entry.id, entry.status);
    });
    heard.push(statuses);
    attendees.push(attendee);
    attachLegacyQaFeed(attendee.context);
  }

  const moderate = (id: string, action: string): void => {
    const result = authority.actAs(host.context, "qa", "moderate", { id, action });
    if (!result.ok) throw new Error(`moderate failed: ${JSON.stringify(result)}`);
  };
  const ids: string[] = [];
  for (let index = 0; index < QUESTIONS; index += 1) {
    const asked = legacyQaSubmit(authority, attendees[index].context, `Question number ${index}, at some length?`);
    if (!("id" in asked)) throw new Error(`ask failed: ${JSON.stringify(asked)}`);
    ids.push(asked.id);
    moderate(asked.id, "answering");
  }
  authority.flushNow();
  await settle();

  const runs: {
    encodings: number;
    encodedBytes: number;
    socketWrites: number;
    longestBlockMs: number;
    totalMs: number;
    turns: number;
  }[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    // The moderator's own rate refills between runs.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const next = run % 2 === 0 ? "answered" : "answering";
    for (const id of ids) moderate(id, next);
    await turn();
    counters.encodings = counters.encodedBytes = counters.socketWrites = 0;

    // Each turn of the event loop that does part of the fan-out is timed.
    const everyoneHeard = (): boolean =>
      heard.every((statuses) => ids.every((id) => statuses.get(id) === next));
    let longest = 0;
    let turns = 0;
    const started = performance.now();
    let mark = started;
    authority.flushNow();
    // The microtasks the flush queued run before this continues.
    await Promise.resolve();
    await Promise.resolve();
    for (;;) {
      const now = performance.now();
      longest = Math.max(longest, now - mark);
      turns += 1;
      if (everyoneHeard()) break;
      if (turns > 10_000) throw new Error("The fan-out never finished");
      await turn();
      mark = now;
    }
    const totalMs = performance.now() - started;
    runs.push({ ...counters, longestBlockMs: longest, totalMs, turns });
  }

  const median = (values: number[]): number =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const report = {
    listeners: LISTENERS,
    changedQuestions: QUESTIONS,
    runs: RUNS,
    socketWrites: median(runs.map((run) => run.socketWrites)),
    encodings: median(runs.map((run) => run.encodings)),
    encodedMegabytes: Number((median(runs.map((run) => run.encodedBytes)) / 1024 / 1024).toFixed(2)),
    turnsOfTheEventLoop: median(runs.map((run) => run.turns)),
    longestBlockMs: Number(median(runs.map((run) => run.longestBlockMs)).toFixed(1)),
    totalMs: Number(median(runs.map((run) => run.totalMs)).toFixed(1)),
    perRun: runs.map((run) => ({
      ...run,
      longestBlockMs: Number(run.longestBlockMs.toFixed(1)),
      totalMs: Number(run.totalMs.toFixed(1)),
    })),
  };
  console.log(JSON.stringify(report, null, 2));
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  authority.close();
};

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
