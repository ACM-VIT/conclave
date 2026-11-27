import { BroadcastChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createAppDocumentEngine, type FromWorker } from "../server/apps/documents/engine.js";
import {
  createAppDocumentPool,
  RESIDENT_OVERHEAD_BYTES,
  type AppDocument,
  type AppDocumentPool,
  type AppDocumentPoolOptions,
} from "../server/apps/documents/pool.js";
import { config } from "../config/config.js";
import { createSfuServer } from "../server/createSfuServer.js";
import { edit, inAppRoom as inRoom } from "./fixtures/app-room.js";

const STALLING_WORKER = new URL("./fixtures/stalling-app-document-worker.ts", import.meta.url);
const SLOW_START_WORKER = new URL("./fixtures/slow-start-app-document-worker.ts", import.meta.url);
const FAILING_WORKER = new URL("./fixtures/failing-app-document-worker.ts", import.meta.url);
const DEADLINE_MS = 300;

type FixtureEvent = { event: string; document?: number };

const cleanups: Array<() => Promise<void> | void> = [];
const createPool = (options: Partial<AppDocumentPoolOptions> = {}): AppDocumentPool => {
  const pool = createAppDocumentPool({
    workers: 1,
    deadlineMs: 5_000,
    maxDocumentBytes: 1024 * 1024,
    ...options,
  });
  cleanups.push(() => pool.close());
  return pool;
};

const createFixture = () => {
  const gate = new Int32Array(new SharedArrayBuffer(12));
  const name = `app-document-fixture-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const channel = new BroadcastChannel(name);
  const log: FixtureEvent[] = [];
  let unseen: FixtureEvent[] = [];
  let waiters: Array<{ event: string; resolve: (event: FixtureEvent) => void }> = [];
  channel.onmessage = (message) => {
    const event = (message as { data: FixtureEvent }).data;
    log.push(event);
    const waiter = waiters.find((candidate) => candidate.event === event.event);
    if (waiter) {
      waiters = waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve(event);
    } else {
      unseen.push(event);
    }
  };
  cleanups.push(() => channel.close());
  return {
    workerData: { gate, channel: name },
    count: (event: string) => log.filter((entry) => entry.event === event).length,
    forget: () => {
      unseen = [];
    },
    next: (event: string) => {
      const index = unseen.findIndex((entry) => entry.event === event);
      if (index >= 0) return Promise.resolve(unseen.splice(index, 1)[0]);
      return new Promise<FixtureEvent>((resolve) => waiters.push({ event, resolve }));
    },
    release: () => {
      Atomics.add(gate, 0, 1);
      Atomics.notify(gate, 0);
    },
  };
};

const manualClock = () => {
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let waiters: Array<{ ms: number; resolve: () => void }> = [];
  const isArmed = (ms: number) => [...timers.values()].some((timer) => timer.ms === ms);
  return {
    setTimeout: (callback: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { callback, ms });
      const ready = waiters.filter((waiter) => waiter.ms === ms);
      waiters = waiters.filter((waiter) => waiter.ms !== ms);
      for (const waiter of ready) waiter.resolve();
      return id;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
    isArmed,
    expire: async (ms: number) => {
      if (!isArmed(ms)) await new Promise<void>((resolve) => waiters.push({ ms, resolve }));
      for (const [id, timer] of [...timers]) {
        if (timer.ms !== ms) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settledNow = async <T>(promise: Promise<T>): Promise<T | undefined> => {
  let value: T | undefined;
  void promise.then((settled) => {
    value = settled;
  });
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  return value;
};

const eventually = async (check: () => boolean): Promise<void> => {
  while (!check()) await new Promise((resolve) => setImmediate(resolve));
};

const fakeHandlerTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

const textOf = (doc: Y.Doc) => doc.getText("t").toString();

const joinedText = async (document: { sync: (vector: Uint8Array) => Promise<{ ok: true; update: Uint8Array } | { ok: false; reason: string }> }) => {
  const synced = await document.sync(Y.encodeStateVector(new Y.Doc()));
  if (!synced.ok) throw new Error(synced.reason);
  const joined = new Y.Doc();
  Y.applyUpdate(joined, synced.update);
  return textOf(joined);
};

const authors = () => {
  const author = new Y.Doc();
  const other = new Y.Doc();
  const hello = edit(author, (text) => text.insert(0, "hello"));
  Y.applyUpdate(other, hello);
  return {
    hello,
    fromOther: (word: string) => edit(other, (text) => text.insert(5, word)),
    world: () => edit(author, (text) => text.insert(5, " world")),
  };
};

const writer = () => {
  const doc = new Y.Doc();
  return (word: string) => edit(doc, (text) => text.insert(text.length, word));
};

const merged = (...updates: Uint8Array[]) => {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return textOf(doc);
};

describe("current Wheel document contract", () => {
  it("rehydrates a retained Wheel document after worker eviction but not after room teardown", async () => {
    const fixture = createFixture();
    const pool = createPool({ residentBytes: RESIDENT_OVERHEAD_BYTES, workerUrl: STALLING_WORKER, workerData: fixture.workerData });
    const workerDocuments: AppDocument[] = [];
    const openDocument = pool.open;
    vi.spyOn(pool, "open").mockImplementation(() => {
      const handle = openDocument();
      workerDocuments.push(handle);
      return handle;
    });
    const room = inRoom(pool, "retained-wheel", { appId: "wheel" });
    const legacy = new Y.Doc();
    cleanups.push(() => legacy.destroy());
    const entries = new Y.Array<{ id: string; label: string }>();
    const stored = [{ id: "ada", label: "Ada" }, { id: "grace", label: "Grace" }];
    legacy.getMap("wheel").set("entries", entries);
    entries.push(stored);

    await room.open();
    const { document } = await fixture.next("loaded");
    expect((await room.acknowledged({ update: Y.encodeStateAsUpdate(legacy) })).receipt).toEqual({ committed: true });
    await fixture.next("dropped");
    expect(await room.close()).toMatchObject({ success: true });
    expect(await room.present("wheel")).toMatchObject({ success: true });
    const { doc: cold } = await room.joinDocument();
    cleanups.push(() => cold.destroy());
    expect(await fixture.next("loaded")).toMatchObject({ document });
    expect((cold.getMap("wheel").get("entries") as Y.Array<unknown>).toArray()).toEqual(stored);
    expect(cold.getArray("wheel.entries").toArray()).toEqual([]);

    room.room.close();
    const [retained] = workerDocuments;
    expect(retained).toBeDefined();
    expect(await retained.sync(Y.encodeStateVector(cold))).toEqual({ ok: false, reason: "closed" });
    expect(room.room.apps.snapshot()).toMatchObject({ activeAppId: null, savedAppIds: [] });
    const restarted = inRoom(pool, "retained-wheel", { appId: "wheel" });
    await restarted.open();
    const { doc: fresh } = await restarted.joinDocument();
    cleanups.push(() => fresh.destroy());
    expect(fresh.getMap("wheel").has("entries")).toBe(false);
    expect(fresh.getArray("wheel.entries").toArray()).toEqual([]);
  });
});

describe("app document engine", () => {
  const steppingClock = () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 15));
  };
  const applies = (words: string[]) => {
    const author = new Y.Doc();
    return words.map((word) => ({
      kind: "apply" as const,
      update: edit(author, (text) => text.insert(text.length, word)),
    }));
  };
  const engineFor = (options: { maxUpdateBytes?: number } = {}) =>
    createAppDocumentEngine({ maxDocumentBytes: 1024 * 1024, maxUpdateBytes: 256 * 1024, ...options });
  const outcomes = (replies: FromWorker[]) =>
    replies.map((reply) => (reply.type === "refused" ? reply.reason : reply.type));

  it("yields the rest of a run once the run has used its time slice", () => {
    const engine = engineFor();
    engine.handle({ type: "run", document: 1, load: { base: null, tail: [] }, operations: [] }, () => {});
    steppingClock();
    const replies: FromWorker[] = [];

    engine.handle({ type: "run", document: 1, load: null, operations: applies(["a", "b", "c"]) }, (reply) => {
      replies.push(reply);
    });

    expect(outcomes(replies)).toEqual(["applied", "yielded"]);
  });

  it("runs one operation after a rebuild that used the time slice before it yields", () => {
    steppingClock();
    const engine = engineFor();
    const replies: FromWorker[] = [];

    engine.handle({ type: "run", document: 1, load: { base: null, tail: [] }, operations: applies(["a", "b"]) }, (reply) => {
      replies.push(reply);
    });

    expect(outcomes(replies)).toEqual(["loaded", "applied", "yielded"]);
  });

  it("refuses an update that builds on a change the document does not have", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const engine = engineFor();
    const first = new Y.Doc();
    const second = new Y.Doc();
    const base = edit(first, (text) => text.insert(0, "x".repeat(50)));
    const missing = edit(first, (text) => text.insert(50, "y"));
    Y.applyUpdate(second, base);
    Y.applyUpdate(second, missing);
    const dependent = edit(second, (text) => text.insert(51, "z"));
    const replies: FromWorker[] = [];

    engine.handle(
      {
        type: "run",
        document: 1,
        load: { base: null, tail: [] },
        operations: [base, dependent, missing].map((update) => ({ kind: "apply" as const, update })),
      },
      (reply) => replies.push(reply),
    );

    expect(outcomes(replies)).toEqual(["loaded", "applied", "missing-dependency"]);
    expect(replies.at(-1)).toMatchObject({ evicted: true });
  });

  it("refuses an update over the size cap without applying it", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const engine = engineFor({ maxUpdateBytes: 100 });
    const author = new Y.Doc();
    const small = edit(author, (text) => text.insert(0, "kept"));
    const large = edit(author, (text) => text.insert(4, "x".repeat(200)));
    const replies: FromWorker[] = [];

    engine.handle(
      {
        type: "run",
        document: 1,
        load: { base: null, tail: [] },
        operations: [
          { kind: "apply", update: small },
          { kind: "apply", update: large },
          { kind: "sync", stateVector: Y.encodeStateVector(new Y.Doc()) },
        ],
      },
      (reply) => replies.push(reply),
    );

    expect(outcomes(replies)).toEqual(["loaded", "applied", "too-large", "synced"]);
    const synced = replies.at(-1) as Extract<FromWorker, { type: "synced" }>;
    expect(merged(synced.update)).toBe("kept");
  });
});

describe("app documents", { timeout: 30_000 }, () => {
  it("gives a late joiner every accepted update and relays each one in order", async () => {
    const room = inRoom(createPool(), "order");
    await room.open();
    const author = new Y.Doc();
    const updates = ["one ", "two ", "three"].map((word) =>
      edit(author, (text) => text.insert(text.length, word)),
    );

    updates.forEach((update) => room.send(update));

    expect(await room.join()).toBe("one two three");
    expect(room.relayed).toEqual(updates);
  });

  it("sends a joiner only the part of the document it is missing", async () => {
    const room = inRoom(createPool(), "diff");
    await room.open();
    const author = new Y.Doc();
    const hello = edit(author, (text) => text.insert(0, "hello"));
    const holder = new Y.Doc();
    Y.applyUpdate(holder, hello);
    room.send(hello);
    room.send(edit(author, (text) => text.insert(5, " world")));

    const response = await room.syncFrom(holder);
    Y.applyUpdate(holder, response.syncMessage);

    expect(textOf(holder)).toBe("hello world");
    expect(response.syncMessage.length).toBeLessThan(Y.encodeStateAsUpdate(author).length);
    expect(response.stateVector).toEqual(Y.encodeStateVector(author));
  });

  it("refuses an edit that builds on a change the server never got and tells its author", async () => {
    const room = inRoom(createPool(), "missing");
    await room.open();
    const first = new Y.Doc();
    const second = new Y.Doc();
    const base = edit(first, (text) => text.insert(0, "x".repeat(50)));
    const missing = edit(first, (text) => text.insert(50, "y"));
    Y.applyUpdate(second, base);
    Y.applyUpdate(second, missing);
    const dependent = edit(second, (text) => text.insert(51, "z"));

    room.send(base, "first");
    room.send(dependent, "second");
    room.send(missing, "first");

    expect(await room.join()).toBe(merged(base, missing));
    expect(room.relayed).toEqual([base, missing]);
    expect(room.refused).toEqual([{ appId: "board", replicaId: "second", reason: "unresolved" }]);
  });

  it("refuses an author's later edits after one is refused and tells the author once", async () => {
    const clock = manualClock();
    const fixture = createFixture();
    const room = inRoom(createPool({ deadlineMs: DEADLINE_MS, clock, workerUrl: STALLING_WORKER, workerData: fixture.workerData }), "author");
    await room.open();
    const author = new Y.Doc();
    const hello = edit(author, (text) => text.insert(0, "hello"));
    room.send(hello, "author");
    room.send(edit(author, (text) => text.insert(5, " STALL")), "author");
    await fixture.next("stalled");
    await clock.expire(DEADLINE_MS);
    room.send(edit(author, (text) => text.insert(11, " more")), "author");
    room.send(edit(author, (text) => text.insert(16, " and more")), "author");

    expect(await room.join()).toBe("hello");
    expect(room.relayed).toEqual([hello]);
    expect(room.refused).toEqual([{ appId: "board", replicaId: "author", reason: "timed-out" }]);
  });

  it("brings the author, a peer and a late joiner to the same document after a refusal", async () => {
    const clock = manualClock();
    const fixture = createFixture();
    const room = inRoom(createPool({ deadlineMs: DEADLINE_MS, clock, workerUrl: STALLING_WORKER, workerData: fixture.workerData }), "converge");
    await room.open();
    let authorDoc = new Y.Doc();
    let replica = "author-1";
    const write = (change: (text: Y.Text) => void) => room.send(edit(authorDoc, change), replica);
    const rebuildAuthor = async () => {
      authorDoc = new Y.Doc();
      replica = "author-2";
      Y.applyUpdate(authorDoc, (await room.syncFrom(authorDoc)).syncMessage);
    };

    write((text) => text.insert(0, "hello"));
    write((text) => text.insert(5, " STALL"));
    await fixture.next("stalled");
    await clock.expire(DEADLINE_MS);
    for (let index = 0; index < 8; index += 1) write((text) => text.insert(text.length, ` entry ${index}`));
    await room.join();
    expect(room.refused).toHaveLength(1);
    await rebuildAuthor();
    write((text) => text.insert(text.length, " after"));

    const late = await room.join();
    const peer = new Y.Doc();
    for (const update of room.relayed) Y.applyUpdate(peer, update);
    expect(textOf(authorDoc)).toBe(late);
    expect(textOf(peer)).toBe(late);
    expect(late).toBe("hello after");
  });

  it("tells a current writer about the update limit and restarts a legacy writer's copy", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const pool = createPool();
    const legacy = inRoom(pool, "rate-legacy");
    const current = inRoom(pool, "rate-current");
    await legacy.open();
    await current.open();
    for (const [room, replica] of [[legacy, undefined], [current, "current"]] as const) {
      const doc = new Y.Doc();
      for (let index = 0; index < 61; index += 1) {
        room.send(edit(doc, (text) => text.insert(0, "l")), replica);
      }
    }

    expect(legacy.refused).toEqual([]);
    const restart = legacy.inbox.find(({ event }) => event === "apps:state");
    expect(restart?.payload).toMatchObject({ activeAppId: null });
    expect(current.refused).toEqual([{ appId: "board", replicaId: "current", reason: "rate-limited" }]);
  });

  it("tells a client that can retry to try again while the queue is full, and holds an older client's sync until it can answer", async () => {
    fakeHandlerTimers();
    const fixture = createFixture();
    const room = inRoom(
      createPool({
        workerUrl: STALLING_WORKER,
        workerData: fixture.workerData,
        limits: { document: { jobs: 2, bytes: 1024 * 1024 }, total: { jobs: 64, bytes: 8 * 1024 * 1024 } },
      }),
      "busy",
    );
    await room.open();
    const { hello, fromOther, world } = authors();
    room.send(hello);
    expect(await room.join()).toBe("hello");
    const held = fromOther("HOLD");
    const next = world();
    room.send(held);
    await fixture.next("held");
    room.send(next);

    const retryAware = await room.requestSync(new Y.Doc(), true);
    const older = room.requestSync(new Y.Doc(), false);
    expect(await settledNow(older)).toBeUndefined();
    fixture.forget();
    fixture.release();
    await eventually(() => room.relayed.length === 3);
    await vi.advanceTimersByTimeAsync(250);

    expect(retryAware).toMatchObject({ retryable: true, retryAfterMs: 250 });
    expect(retryAware).not.toHaveProperty("syncMessage");
    const answer = await older;
    if (!("syncMessage" in answer)) throw new Error(answer.error);
    expect(merged(answer.syncMessage)).toBe(merged(hello, held, next));
  });

  const stuckBehindAnotherRoom = async (name: string, totalJobs: number) => {
    const fixture = createFixture();
    const pool = createPool({
      clock: manualClock(),
      workerUrl: STALLING_WORKER,
      workerData: fixture.workerData,
      limits: { document: { jobs: 64, bytes: 1024 * 1024 }, total: { jobs: totalJobs, bytes: 8 * 1024 * 1024 } },
    });
    const stuck = inRoom(pool, `${name}-stuck`);
    const room = inRoom(pool, name);
    await stuck.open();
    await room.open();
    const write = writer();
    stuck.send(write("STALL"));
    await fixture.next("stalled");
    return { stuck, room, write };
  };

  it("answers an older client's held sync with App not active once its app was reopened", async () => {
    fakeHandlerTimers();
    const { stuck, room, write } = await stuckBehindAnotherRoom("reopened", 3);
    stuck.send(write("a"));
    stuck.send(write("b"));
    const older = room.requestSync(new Y.Doc(), false);
    expect(await settledNow(older)).toBeUndefined();

    await room.close();
    await room.present("board");
    await stuck.clear();
    await vi.advanceTimersByTimeAsync(250);

    expect(await settledNow(older)).toEqual({ error: "App not active" });
  });

  it("pins an older client's sync to the app it arrived for, even when the rate limit holds it first", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const room = inRoom(createPool(), "pinned-on-arrival");
    await room.open();
    room.send(writer()("before"));
    await Promise.all(Array.from({ length: 10 }, () => room.requestSync(new Y.Doc())));
    const older = room.requestSync(new Y.Doc(), false);
    expect(await settledNow(older)).toBeUndefined();

    await room.close();
    await room.present("board");
    await vi.advanceTimersByTimeAsync(500);

    expect(await settledNow(older)).toEqual({ error: "App not active" });
  });

  it("charges every held older-client sync against the sync budget until one of its attempts is paid", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pool = createPool();
    let syncsReachingTheDocument = 0;
    const counting: AppDocumentPool = {
      close: () => pool.close(),
      open: () => {
        const document = pool.open();
        return {
          ...document,
          sync: (stateVector) => {
            syncsReachingTheDocument += 1;
            return document.sync(stateVector);
          },
        };
      },
    };
    const room = inRoom(counting, "held-budget");
    await room.open();
    await Promise.all(Array.from({ length: 10 }, () => room.requestSync(new Y.Doc())));
    const before = syncsReachingTheDocument;
    const held = Array.from({ length: 4 }, () => room.requestSync(new Y.Doc(), false));
    expect(await settledNow(Promise.race(held))).toBeUndefined();

    await vi.advanceTimersByTimeAsync(500);
    expect(syncsReachingTheDocument - before).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(syncsReachingTheDocument - before).toBe(4);
  });

  it("answers a sync from outside a room at once, with a retry hint only for a client that can retry", async () => {
    const room = inRoom(createPool(), "no-room");
    await room.open();
    room.leave();

    expect(await room.requestSync(new Y.Doc(), false)).toEqual({ error: "Not in a room" });
    expect(await room.requestSync(new Y.Doc(), true)).toEqual({ error: "Not in a room", retryable: true, retryAfterMs: 500 });
  });

  it("drops an older client's held sync when its socket disconnects", async () => {
    fakeHandlerTimers();
    const { stuck, room, write } = await stuckBehindAnotherRoom("gone", 3);
    stuck.send(write("a"));
    stuck.send(write("b"));
    const older = room.requestSync(new Y.Doc(), false);
    expect(await settledNow(older)).toBeUndefined();

    room.disconnect();
    await stuck.clear();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await settledNow(older)).toBeUndefined();
  });

  it("answers an older client within 25 seconds even while its sync is still queued", async () => {
    fakeHandlerTimers();
    const { room } = await stuckBehindAnotherRoom("deadline-hold", 64);
    const older = room.requestSync(new Y.Doc(), false);

    await vi.advanceTimersByTimeAsync(24_999);
    expect(await settledNow(older)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(await settledNow(older)).toEqual({ error: "App document is busy" });
  });

  it("holds at most four older-client syncs, counting each one until it is answered", async () => {
    fakeHandlerTimers();
    const { stuck, room, write } = await stuckBehindAnotherRoom("held-cap", 3);
    stuck.send(write("a"));
    stuck.send(write("b"));
    const held = Array.from({ length: 4 }, () => room.requestSync(new Y.Doc(), false));
    expect(await settledNow(Promise.race(held))).toBeUndefined();
    expect(await settledNow(room.requestSync(new Y.Doc(), false))).toEqual({ error: "Too many app sync requests" });

    await stuck.clear();
    await vi.advanceTimersByTimeAsync(250);

    expect(await settledNow(Promise.race(held))).toBeUndefined();
    expect(await settledNow(room.requestSync(new Y.Doc(), false))).toEqual({ error: "Too many app sync requests" });
  });

  it("counts every open older-client sync against the cap, whether it is queued, waiting for room or waiting for budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { room } = await stuckBehindAnotherRoom("cap-every-path", 3);
    const queued = [room.requestSync(new Y.Doc(), false), room.requestSync(new Y.Doc(), false)];
    const waitingForRoom = room.requestSync(new Y.Doc(), false);
    const spent = await Promise.all(Array.from({ length: 7 }, () => room.requestSync(new Y.Doc(), true)));
    expect(spent.every((reply) => "retryable" in reply)).toBe(true);
    const waitingForBudget = room.requestSync(new Y.Doc(), false);
    expect(await settledNow(Promise.race([...queued, waitingForRoom, waitingForBudget]))).toBeUndefined();

    expect(await settledNow(room.requestSync(new Y.Doc(), false))).toEqual({ error: "Too many app sync requests" });

    await vi.advanceTimersByTimeAsync(25_000);
    expect(await settledNow(Promise.all([...queued, waitingForRoom, waitingForBudget]))).toHaveLength(4);
    expect(await settledNow(room.requestSync(new Y.Doc(), false))).toBeUndefined();
  });

  it("uses the app document deadline from the config passed to createSfuServer", async () => {
    const serverWith = (deadlineMs: number) => {
      const server = createSfuServer({ config: { ...config, appDocuments: { deadlineMs } } });
      cleanups.push(() => server.state.appDocuments.close());
      return server;
    };
    const { hello } = authors();

    expect((await serverWith(0.001).state.appDocuments.open().apply(hello)).ok).toBe(false);
    expect(await serverWith(60_000).state.appDocuments.open().apply(hello)).toEqual({ ok: true });
  });

  it("tells a client that syncs too often to retry shortly", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const room = inRoom(createPool(), "rate");
    await room.open();

    const responses = await Promise.all(Array.from({ length: 11 }, () => room.requestSync(new Y.Doc())));

    expect(responses.slice(0, 10).every((response) => "syncMessage" in response)).toBe(true);
    expect(responses[10]).toMatchObject({ retryable: true, retryAfterMs: 500 });
  });

  it("refuses an update that outlasts the deadline, never relays it, and applies the next one", async () => {
    const clock = manualClock();
    const fixture = createFixture();
    const room = inRoom(createPool({ deadlineMs: DEADLINE_MS, clock, workerUrl: STALLING_WORKER, workerData: fixture.workerData }), "deadline");
    await room.open();
    const { hello, fromOther, world } = authors();
    const next = world();

    room.send(hello);
    room.send(fromOther("STALL"));
    room.send(next);
    await fixture.next("stalled");
    await clock.expire(DEADLINE_MS);

    expect(await room.join()).toBe("hello world");
    expect(room.relayed).toEqual([hello, next]);
  });

  it("refuses an update the worker finished only after its deadline", async () => {
    const room = inRoom(createPool({ workerUrl: STALLING_WORKER }), "late");
    await room.open();
    const { hello, fromOther, world } = authors();
    const next = world();

    room.send(hello);
    room.send(fromOther("LATE"));
    room.send(next);

    expect(await room.join()).toBe("hello world");
    expect(room.relayed).toEqual([hello, next]);
  });

  it("refuses the update a worker dies on and applies the next one", async () => {
    const room = inRoom(createPool({ workerUrl: STALLING_WORKER }), "crash");
    await room.open();
    const { hello, fromOther, world } = authors();
    const next = world();

    room.send(hello);
    room.send(fromOther("CRASH"));
    room.send(next);

    expect(await room.join()).toBe("hello world");
    expect(room.relayed).toEqual([hello, next]);
  });

  it("replaces a worker that runs out of memory and keeps every committed document", async () => {
    const pool = createPool({ heap: { oldMb: 48, youngMb: 8 }, workerUrl: STALLING_WORKER });
    const kept = pool.open();
    const hungry = pool.open();
    expect(await kept.apply(writer()("hello"))).toEqual({ ok: true });

    expect(await hungry.apply(writer()("OOM"))).toEqual({ ok: false, reason: "crashed" });

    expect(await joinedText(kept)).toBe("hello");
    expect(await hungry.apply(writer()("after"))).toEqual({ ok: true });
  });

  it("keeps resident documents within the worker's budget and rebuilds the ones it puts aside", async () => {
    const fixture = createFixture();
    const pool = createPool({ residentBytes: 2 * RESIDENT_OVERHEAD_BYTES + 1_000, workerUrl: STALLING_WORKER, workerData: fixture.workerData });
    const first = pool.open();
    const second = pool.open();
    const firstAuthor = new Y.Doc();
    const secondAuthor = new Y.Doc();
    expect(await first.apply(edit(firstAuthor, (text) => text.insert(0, "a".repeat(600))))).toEqual({ ok: true });
    expect(await second.apply(edit(secondAuthor, (text) => text.insert(0, "b".repeat(600))))).toEqual({ ok: true });

    expect(await first.apply(edit(firstAuthor, (text) => text.insert(600, "!")))).toEqual({ ok: true });

    expect(await joinedText(second)).toBe("b".repeat(600));
    expect(await joinedText(first)).toBe(`${"a".repeat(600)}!`);
    expect(fixture.count("loaded")).toBe(5);
  });

  it("puts a document aside as soon as another one grows past the worker's budget", async () => {
    const fixture = createFixture();
    const pool = createPool({ residentBytes: 2 * RESIDENT_OVERHEAD_BYTES + 1_000, workerUrl: STALLING_WORKER, workerData: fixture.workerData });
    const first = pool.open();
    const second = pool.open();
    expect(await first.apply(writer()("a".repeat(600)))).toEqual({ ok: true });
    const { document: firstId } = await fixture.next("loaded");
    expect(await second.apply(writer()("b".repeat(600)))).toEqual({ ok: true });

    expect(await fixture.next("dropped")).toMatchObject({ document: firstId });
  });

  it("puts aside a document that alone outgrows the worker's budget once its run ends", async () => {
    const fixture = createFixture();
    const pool = createPool({ residentBytes: RESIDENT_OVERHEAD_BYTES, workerUrl: STALLING_WORKER, workerData: fixture.workerData });
    const only = pool.open();

    expect(await only.apply(writer()("grows past the budget"))).toEqual({ ok: true });

    const { document: loadedId } = await fixture.next("loaded");
    expect(await fixture.next("dropped")).toMatchObject({ document: loadedId });
    expect(await joinedText(only)).toBe("grows past the budget");
  });

  it("charges every resident document, even an empty one, against the worker's budget", async () => {
    const fixture = createFixture();
    const pool = createPool({ residentBytes: RESIDENT_OVERHEAD_BYTES, workerUrl: STALLING_WORKER, workerData: fixture.workerData });
    const first = pool.open();
    const second = pool.open();
    await joinedText(first);
    const { document: firstId } = await fixture.next("loaded");

    await joinedText(second);

    expect(await fixture.next("dropped")).toMatchObject({ document: firstId });
  });

  it("keeps every room's accepted updates when a stuck worker is replaced", async () => {
    const clock = manualClock();
    const fixture = createFixture();
    const pool = createPool({ deadlineMs: DEADLINE_MS, clock, workerUrl: STALLING_WORKER, workerData: fixture.workerData });
    const stuck = inRoom(pool, "stuck");
    const bystander = inRoom(pool, "bystander");
    await stuck.open();
    await bystander.open();
    const { hello, fromOther } = authors();
    const notes = new Y.Doc();
    bystander.send(edit(notes, (text) => text.insert(0, "kept")));
    stuck.send(hello);
    expect(await bystander.join()).toBe("kept");

    stuck.send(fromOther("STALL"));
    await fixture.next("stalled");
    const more = edit(notes, (text) => text.insert(4, " and more"));
    bystander.send(more);
    await clock.expire(DEADLINE_MS);

    expect(await bystander.join()).toBe("kept and more");
    expect(bystander.relayed.at(-1)).toEqual(more);
    expect(await stuck.join()).toBe("hello");
  });

  it("keeps other rooms moving on another worker while one room's update is stuck", async () => {
    const fixture = createFixture();
    const pool = createPool({ workers: 2, workerUrl: STALLING_WORKER, workerData: fixture.workerData });
    const stuckDocument = pool.open();
    const bystander = inRoom(pool, "moving");
    await bystander.open();
    const { hello, fromOther } = authors();
    expect(await stuckDocument.apply(hello)).toEqual({ ok: true });
    let settled = false;
    const stuck = stuckDocument.apply(fromOther("STALL")).finally(() => {
      settled = true;
    });
    await fixture.next("stalled");

    const update = edit(new Y.Doc(), (text) => text.insert(0, "still moving"));
    bystander.send(update);

    expect(await bystander.join()).toBe("still moving");
    expect(bystander.relayed).toEqual([update]);
    expect(settled).toBe(false);
    await pool.close();
    expect(await stuck).toEqual({ ok: false, reason: "closed" });
  });

  it("does not count a slow worker start against a document's deadline", async () => {
    const clock = manualClock();
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const deadlineMs = 60_000;
    const pool = createPool({ deadlineMs, clock, workerUrl: SLOW_START_WORKER, workerData: { gate } });
    const document = pool.open();
    const { hello } = authors();
    const applied = document.apply(hello);

    expect(clock.isArmed(deadlineMs * 4)).toBe(false);
    expect(clock.isArmed(deadlineMs)).toBe(false);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);

    expect(await applied).toEqual({ ok: true });
    expect(await joinedText(document)).toBe("hello");
  });

  it("keeps what it accepted when the sender reuses its buffer", async () => {
    const clock = manualClock();
    const fixture = createFixture();
    const pool = createPool({ deadlineMs: DEADLINE_MS, clock, workerUrl: STALLING_WORKER, workerData: fixture.workerData });
    const kept = pool.open();
    const other = pool.open();
    const { hello, fromOther } = authors();
    const sent = Buffer.from(edit(new Y.Doc(), (text) => text.insert(0, "original")));
    expect(await kept.apply(sent)).toEqual({ ok: true });
    sent.fill(0);
    expect(await other.apply(hello)).toEqual({ ok: true });
    const stalled = other.apply(fromOther("STALL"));
    await fixture.next("stalled");
    await clock.expire(DEADLINE_MS);
    expect(await stalled).toEqual({ ok: false, reason: "timed-out" });

    expect(await joinedText(kept)).toBe("original");
  });

  it("refuses every queued update when the worker cannot start", async () => {
    const pool = createPool({ workerUrl: FAILING_WORKER });
    const document = pool.open();
    const { hello, fromOther } = authors();

    const results = await Promise.all([document.apply(hello), document.apply(fromOther("x"))]);

    expect(results).toEqual([
      { ok: false, reason: "crashed" },
      { ok: false, reason: "crashed" },
    ]);
  });

  it("rebuilds a document again when its worker dies while rebuilding it", async () => {
    const clock = manualClock();
    const fixture = createFixture();
    const pool = createPool({ deadlineMs: DEADLINE_MS, clock, workerUrl: STALLING_WORKER, workerData: fixture.workerData });
    const fragile = pool.open();
    const other = pool.open();
    const { hello, fromOther } = authors();
    const notes = new Y.Doc();
    expect(await fragile.apply(edit(notes, (text) => text.insert(0, "CRASH-LOAD")))).toEqual({ ok: true });
    expect(await other.apply(hello)).toEqual({ ok: true });
    const stalled = other.apply(fromOther("STALL"));
    await fixture.next("stalled");
    await clock.expire(DEADLINE_MS);
    expect(await stalled).toEqual({ ok: false, reason: "timed-out" });

    expect(await fragile.apply(edit(notes, (text) => text.insert(10, " kept")))).toEqual({ ok: true });
    expect(await joinedText(fragile)).toBe("CRASH-LOAD kept");
  });

  it("lets another document go first when a run yields", async () => {
    const fixture = createFixture();
    const pool = createPool({ workerUrl: STALLING_WORKER, workerData: fixture.workerData });
    const blocker = pool.open();
    const yielding = pool.open();
    const waiting = pool.open();
    const writeBlocker = writer();
    const writeYielding = writer();
    const writeWaiting = writer();
    expect(await blocker.apply(writeBlocker("warm"))).toEqual({ ok: true });
    expect(await yielding.apply(writeYielding("warm"))).toEqual({ ok: true });
    expect(await waiting.apply(writeWaiting("warm"))).toEqual({ ok: true });
    const order: string[] = [];
    const track = (name: string, result: Promise<unknown>) =>
      result.then((outcome) => order.push((outcome as { ok: boolean }).ok ? name : `${name} refused`));
    const blocked = track("hold", blocker.apply(writeBlocker("HOLD")));
    await fixture.next("held");
    const settled = [
      track("yield", yielding.apply(writeYielding("YIELD"))),
      track("after yield", yielding.apply(writeYielding("y"))),
      track("other", waiting.apply(writeWaiting("o"))),
    ];
    fixture.release();

    await Promise.all([blocked, ...settled]);

    expect(order).toEqual(["hold", "yield", "other", "after yield"]);
  });

  it("refuses a flood instead of queueing it", async () => {
    const fixture = createFixture();
    const pool = createPool({
      workerUrl: STALLING_WORKER,
      workerData: fixture.workerData,
      limits: { document: { jobs: 3, bytes: 64 * 1024 }, total: { jobs: 5, bytes: 1024 * 1024 } },
    });
    const first = pool.open();
    const second = pool.open();
    const { hello, fromOther } = authors();
    expect(await first.apply(hello)).toEqual({ ok: true });
    const stuck = first.apply(fromOther("STALL"));
    await fixture.next("stalled");
    const queued = [first.apply(fromOther("a")), first.apply(fromOther("b"))];

    expect(await first.apply(fromOther("c"))).toEqual({ ok: false, reason: "queue-full" });
    queued.push(second.apply(fromOther("d")), second.apply(fromOther("e")));
    expect(await second.apply(fromOther("f"))).toEqual({ ok: false, reason: "queue-full" });
    expect(await pool.open().apply(new Uint8Array(65 * 1024))).toEqual({ ok: false, reason: "queue-full" });

    await pool.close();
    expect(await stuck).toEqual({ ok: false, reason: "closed" });
    expect(await Promise.all(queued)).toEqual(queued.map(() => ({ ok: false, reason: "closed" })));
  });

  it("settles and frees the updates of a document closed while the worker rejects one", async () => {
    const fixture = createFixture();
    const pool = createPool({
      workerUrl: STALLING_WORKER,
      workerData: fixture.workerData,
      limits: { document: { jobs: 4, bytes: 1024 * 1024 }, total: { jobs: 4, bytes: 1024 * 1024 } },
    });
    const busy = pool.open();
    const closing = pool.open();
    const writeClosing = writer();
    const busyHold = busy.apply(writer()("HOLD"));
    await fixture.next("held");
    const queued = [
      closing.apply(writeClosing("HOLD")),
      closing.apply(Uint8Array.of(9, 9, 9)),
      closing.apply(writeClosing("x")),
    ];
    fixture.release();
    expect(await busyHold).toEqual({ ok: true });
    await fixture.next("held");

    closing.close();
    fixture.release();

    expect(await Promise.all(queued)).toEqual(queued.map(() => ({ ok: false, reason: "closed" })));
    const fresh = pool.open();
    const author = new Y.Doc();
    const accepted = await Promise.all(
      ["a", "b", "c", "d"].map((word) => fresh.apply(edit(author, (text) => text.insert(text.length, word)))),
    );
    expect(accepted).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
  });

  it("stops serving a document that cannot be rebuilt in time and keeps serving the rest", async () => {
    const clock = manualClock();
    const fixture = createFixture();
    const pool = createPool({ deadlineMs: DEADLINE_MS, clock, workerUrl: STALLING_WORKER, workerData: fixture.workerData });
    const slow = pool.open();
    const other = pool.open();
    const { hello, fromOther } = authors();
    expect(await slow.apply(edit(new Y.Doc(), (text) => text.insert(0, "SLOW-LOAD")))).toEqual({ ok: true });
    expect(await other.apply(hello)).toEqual({ ok: true });
    const stalled = other.apply(fromOther("STALL"));
    await fixture.next("stalled");
    await clock.expire(DEADLINE_MS);
    expect(await stalled).toEqual({ ok: false, reason: "timed-out" });

    const refused = slow.apply(edit(new Y.Doc(), (text) => text.insert(0, "x")));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await fixture.next("stalled-load");
      await clock.expire(DEADLINE_MS * 4);
    }

    expect(await refused).toEqual({ ok: false, reason: "unavailable" });
    expect(await slow.sync(Y.encodeStateVector(new Y.Doc()))).toEqual({ ok: false, reason: "unavailable" });
    expect(await joinedText(other)).toBe("hello");
  });

  it("keeps a worker-backed stroke already in flight when the host closes the board", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = createFixture();
    const room = inRoom(createPool({ workerUrl: STALLING_WORKER, workerData: fixture.workerData }), "close-held", { appId: "whiteboard" });
    await room.open();
    const writer = new Y.Doc();
    const update = edit(writer, (text) => text.insert(0, "HOLD this stroke"));
    const upload = room.acknowledged({ update }, "stroke");
    await fixture.next("held");
    const close = room.close();
    expect(await settledNow(close)).toBeUndefined();
    expect(await settledNow(upload)).toBeUndefined();

    fixture.release();
    expect((await upload).relayed).toBe(1);
    expect(await close).toMatchObject({ success: true });
    expect(room.room.apps.snapshot().savedAppIds).toEqual(["whiteboard"]);
    expect(await room.present("wheel")).toMatchObject({ success: true });
    expect(await room.present("whiteboard")).toMatchObject({ success: true });
    expect(await room.join()).toBe("HOLD this stroke");
  });

  it("never echoes the worker's speculative Wheel add before commit", async () => {
    const fixture = createFixture();
    const room = inRoom(createPool({ workerUrl: STALLING_WORKER, workerData: fixture.workerData }), "wheel-commit", { appId: "wheel" });
    await room.open();
    const writer = new Y.Doc();
    writer.getArray("wheel.entries").push([{ id: "ada", label: "HOLD Ada" }]);
    const update = Y.encodeStateAsUpdate(writer);
    const upload = room.acknowledged({ update });
    await fixture.next("held");
    expect(await settledNow(upload)).toBeUndefined();
    expect(room.inbox).toEqual([]);
    expect(room.relayed).toEqual([]);

    fixture.release();
    expect(await upload).toEqual({
      receipt: { committed: true },
      inbox: [{ event: "apps:yjs:update", payload: { appId: "wheel", update } }],
      relayed: 1,
    });
    expect((await room.joinDocument()).doc.getArray("wheel.entries").toArray()).toEqual([
      { id: "ada", label: "HOLD Ada" },
    ]);
  });

  it("keeps only committed whiteboard edits across Close and Present when a worker misses its deadline", async () => {
    const clock = manualClock();
    const fixture = createFixture();
    const room = inRoom(createPool({ deadlineMs: DEADLINE_MS, clock, workerUrl: STALLING_WORKER, workerData: fixture.workerData }), "close", { appId: "whiteboard" });
    await room.open();
    const { hello, fromOther, world } = authors();
    room.send(hello);
    expect(await room.join()).toBe("hello");
    room.send(fromOther("STALL"));
    await fixture.next("stalled");
    room.send(world());

    const before = room.room.apps.snapshot();
    expect(await room.close()).toMatchObject({ success: true });
    expect(room.room.apps.snapshot().savedAppIds).toEqual(["whiteboard"]);
    expect(await room.present("wheel", before.revision)).toMatchObject({ success: false, code: "stale_revision" });
    expect(await room.present("whiteboard")).toMatchObject({ success: true });
    expect(room.room.apps.snapshot().docGeneration).toBe(before.docGeneration);
    const joined = room.join();
    await clock.expire(DEADLINE_MS);

    expect(await joined).toBe("hello");
    expect(room.relayed).toEqual([hello]);
  });
});
