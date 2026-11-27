/**
 * Measures telling a webinar of old clients about Q&A changes.
 *
 *   pnpm -C packages/sfu exec tsx scripts/measure-legacy-qa-flush.ts [listeners] [questions] [--out file.json]
 *   pnpm -C packages/sfu exec tsx scripts/measure-legacy-qa-flush.ts [listeners] --trim [--out file.json]
 *   pnpm -C packages/sfu exec tsx scripts/measure-legacy-qa-flush.ts [listeners] [questions] --policy [--out file.json]
 *
 * The first form changes `questions` questions in one flush. The second has
 * every listener upvote one question with the old event, beside 50 answered
 * questions everyone lists, then fills the book until the upvoted question
 * is dropped, and measures telling them so. The third fills the book with
 * `questions` answered questions, then has the host turn Q&A off and on,
 * and webinar mode off and on, and measures what each switch sends.
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
  legacyQaUpvote,
} from "../server/apps/authority/legacyWebinarQa.js";
import { DEFAULT_AUTHORITY_LIMITS } from "../server/apps/authority/limits.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import { createConnectionContext } from "../server/socket/context.js";
import { createSfuState } from "../server/state.js";
import { getOrCreateWebinarRoomConfig } from "../server/webinar.js";
import type {
  WebinarQaChangedNotification,
  WebinarQaSnapshot,
} from "../types.js";

// The room's budgets refill with the clock, so the setup moves it by hand.
const realNow = Date.now.bind(Date);
let clockOffsetMs = 0;
Date.now = () => realNow() + clockOffsetMs;

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
const TRIM = args.includes("--trim");
const POLICY = args.includes("--policy");
const RUNS = 5;

const counters = { encodings: 0, encodedBytes: 0, socketWrites: 0 };
/** Socket writes by event name. */
const writesByEvent = new Map<string, number>();
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
      writesByEvent.set(event, (writesByEvent.get(event) ?? 0) + 1);
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
  if (kind === "host") {
    room.grantHost(key, "fallback");
    room.makePrimaryHost(key);
  }
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

const megabytes = (bytes: number): number => Number((bytes / 1024 / 1024).toFixed(2));

/**
 * Runs `step` and every turn of the event loop after it until `done`, and
 * times the longest of those turns.
 */
const timed = async (
  step: () => void,
  done: () => boolean,
): Promise<{ longestBlockMs: number; totalMs: number; turns: number }> => {
  let longest = 0;
  let turns = 0;
  const started = performance.now();
  let mark = started;
  step();
  // The microtasks the step queued run before this continues.
  await Promise.resolve();
  await Promise.resolve();
  for (;;) {
    const now = performance.now();
    longest = Math.max(longest, now - mark);
    turns += 1;
    if (done()) break;
    if (turns > 10_000) throw new Error("The fan-out never finished");
    await turn();
    mark = now;
  }
  return { longestBlockMs: longest, totalMs: performance.now() - started, turns };
};

const finish = (report: object): void => {
  console.log(JSON.stringify(report, null, 2));
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
};

/** One flush that changes `QUESTIONS` questions for every listener. */
const measureChange = async (): Promise<void> => {
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
    clockOffsetMs += 10_000;
    const next = run % 2 === 0 ? "answered" : "answering";
    for (const id of ids) moderate(id, next);
    await turn();
    counters.encodings = counters.encodedBytes = counters.socketWrites = 0;
    const timing = await timed(
      () => authority.flushNow(),
      () => heard.every((statuses) => ids.every((id) => statuses.get(id) === next)),
    );
    runs.push({ ...counters, ...timing });
  }

  const median = (values: number[]): number =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  finish({
    listeners: LISTENERS,
    changedQuestions: QUESTIONS,
    runs: RUNS,
    socketWrites: median(runs.map((run) => run.socketWrites)),
    encodings: median(runs.map((run) => run.encodings)),
    encodedMegabytes: megabytes(median(runs.map((run) => run.encodedBytes))),
    turnsOfTheEventLoop: median(runs.map((run) => run.turns)),
    longestBlockMs: Number(median(runs.map((run) => run.longestBlockMs)).toFixed(1)),
    totalMs: Number(median(runs.map((run) => run.totalMs)).toFixed(1)),
    perRun: runs.map((run) => ({
      ...run,
      longestBlockMs: Number(run.longestBlockMs.toFixed(1)),
      totalMs: Number(run.totalMs.toFixed(1)),
    })),
  });
  authority.close();
};

/**
 * Every listener upvotes one question with the old event. The book then
 * fills until that question is dropped, and its upvotes with it.
 */
const measureTrim = async (): Promise<void> => {
  const host = seat("asha@example.com", "Asha", "host");
  const authority = getRoomAuthority(state, room);
  if (!authority) throw new Error("The room has no authority runtime");

  const lists: Set<string>[] = [];
  const attendees: ReturnType<typeof seat>[] = [];
  for (let index = 0; index < LISTENERS; index += 1) {
    const attendee = seat(`attendee${index}@example.com`, `Attendee ${index}`, "attendee");
    const list = new Set<string>();
    attendee.on("webinar:qaSnapshot", (payload) => {
      list.clear();
      for (const entry of (payload as WebinarQaSnapshot).entries) list.add(entry.id);
    });
    attendee.on("webinar:qaChanged", (payload) => {
      const { entry, removedId } = payload as WebinarQaChangedNotification;
      if (removedId) list.delete(removedId);
      else if (entry) list.add(entry.id);
    });
    lists.push(list);
    attendees.push(attendee);
    attachLegacyQaFeed(attendee.context);
  }
  const ask = (index: number, text: string): string => {
    const asked = legacyQaSubmit(authority, attendees[index].context, text);
    if (!("id" in asked)) throw new Error(`ask failed: ${JSON.stringify(asked)}`);
    return asked.id;
  };
  const moderate = (id: string, action: string): void => {
    const result = authority.actAs(host.context, "qa", "moderate", { id, action });
    if (!result.ok) throw new Error(`moderate failed: ${JSON.stringify(result)}`);
  };

  const popular = ask(0, "The question everybody upvotes?");
  moderate(popular, "answering");
  authority.flushNow();
  await settle();
  // As fast as the room takes it: a wave in one instant, then two seconds.
  for (let first = 0; first < LISTENERS; first += 200) {
    clockOffsetMs += 2_000;
    for (const attendee of attendees.slice(first, first + 200)) {
      const voted = legacyQaUpvote(authority, attendee.context, popular);
      if (!("success" in voted)) throw new Error(`upvote failed: ${JSON.stringify(voted)}`);
    }
    authority.flushNow();
    await settle();
  }
  moderate(popular, "answered");
  // Fifty more answered questions, which every attendee lists.
  const ANSWERED = 50;
  for (let index = 1; index <= ANSWERED; index += 1) {
    clockOffsetMs += 1_000;
    moderate(ask(index, `An answered question, number ${index}, at some length?`), "answered");
  }
  authority.flushNow();
  await settle();
  // Questions still waiting fill the book to one short of its cap of 300.
  let waiting = 299 - ANSWERED;
  for (let round = 0; waiting > 0; round += 1) {
    clockOffsetMs += 60_000;
    for (let index = 100; index < 200 && waiting > 0; index += 1, waiting -= 1) {
      ask(index, `Still waiting for a host, round ${round}?`);
    }
    authority.flushNow();
    await settle();
  }
  const listedBefore = lists.filter((list) => list.has(popular)).length;

  counters.encodings = counters.encodedBytes = counters.socketWrites = 0;
  writesByEvent.clear();
  // The 301st question takes the book over its cap.
  clockOffsetMs += 60_000;
  ask(200, "The one that takes the book over its cap?");
  let longestBlockMs = 0;
  let totalMs = 0;
  let flushes = 0;
  // The upvote rows are told to their owners a bounded number a flush, so
  // flush for as long as that takes, and then until two in a row send nothing.
  const atLeast =
    Math.ceil(LISTENERS / DEFAULT_AUTHORITY_LIMITS.clearedRowsPerFlush) + 1;
  for (let quiet = 0; quiet < 2 || flushes < atLeast; ) {
    const writesBefore = counters.socketWrites;
    clockOffsetMs += 50;
    const timing = await timed(() => authority.flushNow(), () => true);
    await settle();
    longestBlockMs = Math.max(longestBlockMs, timing.longestBlockMs);
    totalMs += timing.totalMs;
    flushes += 1;
    quiet = counters.socketWrites === writesBefore ? quiet + 1 : 0;
    if (flushes > 200) throw new Error("The trim never finished telling");
  }

  finish({
    listeners: LISTENERS,
    upvotersOfTheDroppedQuestion: LISTENERS,
    listedItBefore: listedBefore,
    stillListIt: lists.filter((list) => list.has(popular)).length,
    flushes,
    wholeListsSent: writesByEvent.get("webinar:qaSnapshot") ?? 0,
    changeEventsSent: writesByEvent.get("webinar:qaChanged") ?? 0,
    socketWrites: counters.socketWrites,
    encodings: counters.encodings,
    encodedMegabytes: megabytes(counters.encodedBytes),
    longestBlockMs: Number(longestBlockMs.toFixed(1)),
    flushCpuMs: Number(totalMs.toFixed(1)),
  });
  authority.close();
};

/**
 * The host's switches in a webinar whose book is full of answered
 * questions: Q&A off and on, which decides only who may ask, and webinar
 * mode off and on, which takes Q&A from the attendees and gives it back.
 */
const measurePolicy = async (): Promise<void> => {
  const host = seat("asha@example.com", "Asha", "host");
  const authority = getRoomAuthority(state, room);
  if (!authority) throw new Error("The room has no authority runtime");
  const attendees: ReturnType<typeof seat>[] = [];
  const listed: number[] = [];
  for (let index = 0; index < LISTENERS; index += 1) {
    const attendee = seat(`attendee${index}@example.com`, `Attendee ${index}`, "attendee");
    const at = index;
    listed.push(0);
    attendee.on("webinar:qaSnapshot", (payload) => {
      listed[at] = (payload as WebinarQaSnapshot).entries.length;
    });
    attendees.push(attendee);
    attachLegacyQaFeed(attendee.context);
  }
  for (let index = 0; index < QUESTIONS; index += 1) {
    clockOffsetMs += 1_000;
    const asked = legacyQaSubmit(
      authority,
      attendees[index % LISTENERS].context,
      `Question number ${index}, asked at a length that a real one might have, about the thing being shown?`,
    );
    if (!("id" in asked)) throw new Error(`ask failed: ${JSON.stringify(asked)}`);
    const answered = authority.actAs(host.context, "qa", "moderate", {
      id: asked.id,
      action: "answered",
      answerText: "An answer of a sentence or two, as a host would give it during the session.",
    });
    if (!answered.ok) throw new Error(`moderate failed: ${JSON.stringify(answered)}`);
    if (index % 20 === 19) {
      authority.flushNow();
      await settle();
    }
  }
  authority.flushNow();
  await settle();

  const config = getOrCreateWebinarRoomConfig(state.webinarConfigs, room.channelId);
  const measure = async (name: string, change: () => void) => {
    clockOffsetMs += 10_000;
    counters.encodings = counters.encodedBytes = counters.socketWrites = 0;
    writesByEvent.clear();
    // Done when four turns in a row write nothing.
    let quiet = 0;
    let writes = 0;
    const timing = await timed(
      () => {
        change();
        authority.policyChanged();
        authority.flushNow();
      },
      () => {
        quiet = counters.socketWrites === writes ? quiet + 1 : 0;
        writes = counters.socketWrites;
        return quiet >= 4;
      },
    );
    await settle();
    return {
      switch: name,
      wholeListsSent: writesByEvent.get("webinar:qaSnapshot") ?? 0,
      changeEventsSent: writesByEvent.get("webinar:qaChanged") ?? 0,
      encodings: counters.encodings,
      encodedMegabytes: megabytes(counters.encodedBytes),
      turnsOfTheEventLoop: timing.turns,
      longestBlockMs: Number(timing.longestBlockMs.toFixed(1)),
      totalMs: Number(timing.totalMs.toFixed(1)),
      entriesInTheLastListAnAttendeeWasSent: listed[LISTENERS - 1],
    };
  };

  const switches = [
    await measure("Q&A off", () => {
      config.qaEnabled = false;
    }),
    await measure("Q&A on", () => {
      config.qaEnabled = true;
    }),
    await measure("webinar mode off", () => {
      config.enabled = false;
    }),
    await measure("webinar mode on", () => {
      config.enabled = true;
    }),
  ];
  finish({ listeners: LISTENERS, questions: QUESTIONS, switches });
  authority.close();
};

const main = POLICY ? measurePolicy : TRIM ? measureTrim : measureChange;

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
