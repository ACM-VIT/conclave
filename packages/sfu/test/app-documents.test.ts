import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createAppDocumentEngine, type FromWorker } from "../server/apps/documents/engine.js";
import {
  createAppDocumentPool,
  type AppDocumentPool,
  type AppDocumentPoolOptions,
} from "../server/apps/documents/pool.js";
import { config } from "../config/config.js";
import { createSfuServer } from "../server/createSfuServer.js";
import { edit, inAppRoom as inRoom } from "./fixtures/app-room.js";

const STALLING_WORKER = new URL("./fixtures/stalling-app-document-worker.ts", import.meta.url);
const SLOW_START_WORKER = new URL("./fixtures/slow-start-app-document-worker.ts", import.meta.url);
const FAILING_WORKER = new URL("./fixtures/failing-app-document-worker.ts", import.meta.url);
const CRASHED_ONCE_FLAG = join(tmpdir(), `conclave-app-document-crash-${process.pid}`);

const pools: AppDocumentPool[] = [];
const createPool = (options: Partial<AppDocumentPoolOptions> = {}): AppDocumentPool => {
  const pool = createAppDocumentPool({
    workers: 1,
    deadlineMs: 5_000,
    maxDocumentBytes: 1024 * 1024,
    ...options,
  });
  pools.push(pool);
  return pool;
};

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  rmSync(CRASHED_ONCE_FLAG, { force: true });
  vi.restoreAllMocks();
});

const joinedText = async (document: { sync: (vector: Uint8Array) => Promise<{ ok: true; update: Uint8Array } | { ok: false; reason: string }> }) => {
  const synced = await document.sync(Y.encodeStateVector(new Y.Doc()));
  if (!synced.ok) throw new Error(synced.reason);
  const joined = new Y.Doc();
  Y.applyUpdate(joined, synced.update);
  return joined.getText("t").toString();
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

  it("yields the rest of a run once the run has used its time slice", () => {
    const engine = createAppDocumentEngine({ maxDocumentBytes: 1024 * 1024 });
    engine.handle({ type: "run", document: 1, load: { base: null, tail: [] }, operations: [] }, () => {});
    steppingClock();
    const replies: FromWorker["type"][] = [];

    engine.handle({ type: "run", document: 1, load: null, operations: applies(["a", "b", "c"]) }, (reply) => {
      replies.push(reply.type);
    });

    expect(replies).toEqual(["applied", "yielded"]);
  });

  it("measures an update that unlocks pending edits after applying it and refuses it past the limit", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const engine = createAppDocumentEngine({ maxDocumentBytes: 10_000 });
    const first = new Y.Doc();
    first.clientID = 1;
    const second = new Y.Doc();
    second.clientID = 2;
    const base = edit(first, (text) => text.insert(0, "x".repeat(5000)));
    const unlock = edit(first, (text) => text.insert(5000, "y"));
    Y.applyUpdate(second, base);
    Y.applyUpdate(second, unlock);
    const inserts = edit(second, (text) => {
      text.insert(5001, "z");
      for (let index = 4990; index > 0; index -= 12) text.insert(index, "b");
    });
    const replies: FromWorker[] = [];

    engine.handle(
      {
        type: "run",
        document: 1,
        load: { base: null, tail: [] },
        operations: [base, inserts, unlock].map((update) => ({ kind: "apply" as const, update })),
      },
      (reply) => replies.push(reply),
    );

    expect(unlock.length * 16).toBeLessThan(10_000 - 8_745);
    expect(replies.map((reply) => (reply.type === "refused" ? reply.reason : reply.type))).toEqual([
      "loaded",
      "applied",
      "applied",
      "too-large",
    ]);
  });

  it("yields before any operation when rebuilding used the time slice", () => {
    steppingClock();
    const engine = createAppDocumentEngine({ maxDocumentBytes: 1024 * 1024 });
    const replies: FromWorker["type"][] = [];

    engine.handle({ type: "run", document: 1, load: { base: null, tail: [] }, operations: applies(["a"]) }, (reply) => {
      replies.push(reply.type);
    });

    expect(replies).toEqual(["loaded", "yielded"]);
  });
});

describe("app documents", () => {
  it("keeps a document a late joiner can load when an update unlocks pending edits", async () => {
    const room = inRoom(createPool({ maxDocumentBytes: 10_000 }), "pending");
    await room.open();
    const first = new Y.Doc();
    first.clientID = 1;
    const second = new Y.Doc();
    second.clientID = 2;
    const base = edit(first, (text) => text.insert(0, "x".repeat(5000)));
    const unlock = edit(first, (text) => text.insert(5000, "y"));
    Y.applyUpdate(second, base);
    Y.applyUpdate(second, unlock);
    const inserts = edit(second, (text) => {
      text.insert(5001, "z");
      for (let index = 4990; index > 0; index -= 12) text.insert(index, "b");
    });

    room.send(base);
    room.send(inserts);
    room.send(unlock);

    expect((await room.joinDocument()).encodedBytes).toBeLessThanOrEqual(10_000);
    expect(room.relayed).toEqual([base, inserts]);
  });


  it("tells a late joiner to retry while the queue is full and serves the board once it drains", async () => {
    const pool = createPool({
      deadlineMs: 300,
      workerUrl: STALLING_WORKER,
      limits: { document: { jobs: 2, bytes: 1024 * 1024 }, total: { jobs: 64, bytes: 8 * 1024 * 1024 } },
    });
    const room = inRoom(pool, "busy");
    await room.open();
    const { hello, fromOther, world } = authors();
    room.send(hello);
    expect(await room.join()).toBe("hello");
    room.send(fromOther("STALL"));
    room.send(world());

    let response = await room.requestSync(new Y.Doc());
    expect(response).toMatchObject({ retryable: true, retryAfterMs: 250 });
    expect(response).not.toHaveProperty("syncMessage");
    for (let attempt = 0; attempt < 40 && !("syncMessage" in response); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, "retryAfterMs" in response ? response.retryAfterMs : 0));
      response = await room.requestSync(new Y.Doc());
    }

    if (!("syncMessage" in response)) throw new Error(response.error);
    const joined = new Y.Doc();
    Y.applyUpdate(joined, response.syncMessage);
    expect(joined.getText("t").toString()).toBe("hello world");
  });

  it("uses the app document deadline from the config passed to createSfuServer", async () => {
    const serverWith = (deadlineMs: number) => {
      const server = createSfuServer({ config: { ...config, appDocuments: { deadlineMs } } });
      pools.push(server.state.appDocuments);
      return server;
    };
    const { hello } = authors();

    expect((await serverWith(0.001).state.appDocuments.open().apply(hello)).ok).toBe(false);
    expect(await serverWith(60_000).state.appDocuments.open().apply(hello)).toEqual({ ok: true });
  });

  it("tells a client that syncs too often to retry shortly", async () => {
    const room = inRoom(createPool(), "rate");
    await room.open();

    const responses = await Promise.all(Array.from({ length: 11 }, () => room.requestSync(new Y.Doc())));

    expect(responses.slice(0, 10).every((response) => "syncMessage" in response)).toBe(true);
    expect(responses[10]).toMatchObject({ retryable: true, retryAfterMs: 500 });
  });

  it("gives a late joiner every accepted update and relays each one in order", async () => {
    const room = inRoom(createPool(), "order");
    await room.open();
    const author = new Y.Doc();
    const updates = ["one ", "two ", "three"].map((word) =>
      edit(author, (text) => text.insert(text.length, word)),
    );

    updates.forEach(room.send);

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

    expect(holder.getText("t").toString()).toBe("hello world");
    expect((response.syncMessage).length).toBeLessThan(Y.encodeStateAsUpdate(author).length);
    expect(response.stateVector).toEqual(Y.encodeStateVector(author));
  });

  it("refuses an update that outlasts the deadline, never relays it, and applies the next one", async () => {
    const room = inRoom(createPool({ deadlineMs: 300, workerUrl: STALLING_WORKER }), "deadline");
    await room.open();
    const { hello, fromOther, world } = authors();
    const stalled = fromOther("STALL");
    const next = world();

    room.send(hello);
    room.send(stalled);
    room.send(next);

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

  it("keeps every room's accepted updates when a stuck worker is replaced", async () => {
    const pool = createPool({ deadlineMs: 300, workerUrl: STALLING_WORKER });
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
    const more = edit(notes, (text) => text.insert(4, " and more"));
    bystander.send(more);

    expect(await bystander.join()).toBe("kept and more");
    expect(bystander.relayed.at(-1)).toEqual(more);
    expect(await stuck.join()).toBe("hello");
  });

  it("keeps other rooms moving on another worker while one room's update is stuck", async () => {
    const pool = createPool({ workers: 2, workerUrl: STALLING_WORKER });
    const stuckDocument = pool.open();
    const bystander = inRoom(pool, "moving");
    await bystander.open();
    const { hello, fromOther } = authors();
    expect(await stuckDocument.apply(hello)).toEqual({ ok: true });
    let settled = false;
    const stuck = stuckDocument.apply(fromOther("STALL")).finally(() => {
      settled = true;
    });

    const update = edit(new Y.Doc(), (text) => text.insert(0, "still moving"));
    bystander.send(update);

    expect(await bystander.join()).toBe("still moving");
    expect(bystander.relayed).toEqual([update]);
    expect(settled).toBe(false);
    await pool.close();
    expect(await stuck).toEqual({ ok: false, reason: "closed" });
  });

  it("does not count a slow worker start against a document's deadline", async () => {
    const pool = createPool({ deadlineMs: 50, workerUrl: SLOW_START_WORKER });
    const document = pool.open();
    const { hello } = authors();

    expect(await document.apply(hello)).toEqual({ ok: true });
    const synced = await document.sync(Y.encodeStateVector(new Y.Doc()));
    if (!synced.ok) throw new Error(synced.reason);
    const joined = new Y.Doc();
    Y.applyUpdate(joined, synced.update);
    expect(joined.getText("t").toString()).toBe("hello");
  });

  it("keeps what it accepted when the sender reuses its buffer", async () => {
    const pool = createPool({ deadlineMs: 300, workerUrl: STALLING_WORKER });
    const kept = pool.open();
    const other = pool.open();
    const { hello, fromOther } = authors();
    const sent = Buffer.from(edit(new Y.Doc(), (text) => text.insert(0, "original")));
    expect(await kept.apply(sent)).toEqual({ ok: true });
    sent.fill(0);
    expect(await other.apply(hello)).toEqual({ ok: true });
    expect(await other.apply(fromOther("STALL"))).toEqual({ ok: false, reason: "timed-out" });

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
    const pool = createPool({ deadlineMs: 300, workerUrl: STALLING_WORKER });
    const fragile = pool.open();
    const other = pool.open();
    const { hello, fromOther } = authors();
    const notes = new Y.Doc();
    expect(await fragile.apply(edit(notes, (text) => text.insert(0, "CRASH-LOAD")))).toEqual({ ok: true });
    expect(await other.apply(hello)).toEqual({ ok: true });
    expect(await other.apply(fromOther("STALL"))).toEqual({ ok: false, reason: "timed-out" });

    expect(await fragile.apply(edit(notes, (text) => text.insert(10, " kept")))).toEqual({ ok: true });
    expect(await joinedText(fragile)).toBe("CRASH-LOAD kept");
  });

  it("lets another document go first when a run yields", async () => {
    const pool = createPool({ workerUrl: STALLING_WORKER });
    const blocker = pool.open();
    const yielding = pool.open();
    const waiting = pool.open();
    const { fromOther } = authors();
    const order: string[] = [];
    const track = (name: string, result: Promise<unknown>) => result.then(() => order.push(name));
    const blocked = track("pause", blocker.apply(fromOther("PAUSE")));
    const settled = [
      track("yield", yielding.apply(fromOther("YIELD"))),
      track("after yield", yielding.apply(fromOther("y"))),
      track("other", waiting.apply(fromOther("o"))),
    ];

    await Promise.all([blocked, ...settled]);

    expect(order).toEqual(["pause", "yield", "other", "after yield"]);
  });

  it("refuses a flood instead of queueing it", async () => {
    const pool = createPool({
      workerUrl: STALLING_WORKER,
      limits: { document: { jobs: 3, bytes: 64 * 1024 }, total: { jobs: 5, bytes: 1024 * 1024 } },
    });
    const first = pool.open();
    const second = pool.open();
    const { hello, fromOther } = authors();
    expect(await first.apply(hello)).toEqual({ ok: true });
    const stuck = first.apply(fromOther("STALL"));
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
    const pool = createPool({
      workerUrl: STALLING_WORKER,
      limits: { document: { jobs: 4, bytes: 1024 * 1024 }, total: { jobs: 4, bytes: 1024 * 1024 } },
    });
    const busy = pool.open();
    const closing = pool.open();
    const { fromOther } = authors();
    const busyPause = busy.apply(fromOther("PAUSE"));
    const queued = [
      closing.apply(fromOther("PAUSE")),
      closing.apply(Uint8Array.of(9, 9, 9)),
      closing.apply(fromOther("x")),
    ];

    expect(await busyPause).toEqual({ ok: true });
    closing.close();

    expect(await Promise.all(queued)).toEqual(queued.map(() => ({ ok: false, reason: "closed" })));
    const fresh = pool.open();
    const author = new Y.Doc();
    const accepted = await Promise.all(
      ["a", "b", "c", "d"].map((word) => fresh.apply(edit(author, (text) => text.insert(text.length, word)))),
    );
    expect(accepted).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
  });

  it("stops serving a document that cannot be rebuilt in time and keeps serving the rest", async () => {
    const pool = createPool({ deadlineMs: 150, workerUrl: STALLING_WORKER });
    const slow = pool.open();
    const other = pool.open();
    const { hello, fromOther } = authors();
    expect(await slow.apply(edit(new Y.Doc(), (text) => text.insert(0, "SLOW-LOAD")))).toEqual({ ok: true });
    expect(await other.apply(hello)).toEqual({ ok: true });
    expect(await other.apply(fromOther("STALL"))).toEqual({ ok: false, reason: "timed-out" });

    expect(await slow.apply(edit(new Y.Doc(), (text) => text.insert(0, "x")))).toEqual({ ok: false, reason: "unavailable" });
    expect(await slow.sync(Y.encodeStateVector(new Y.Doc()))).toEqual({ ok: false, reason: "unavailable" });
    const synced = await other.sync(Y.encodeStateVector(new Y.Doc()));
    if (!synced.ok) throw new Error(synced.reason);
    const joined = new Y.Doc();
    Y.applyUpdate(joined, synced.update);
    expect(joined.getText("t").toString()).toBe("hello");
  });

  it("drops a closed app's queued updates and starts the reopened app empty", async () => {
    const room = inRoom(createPool({ workerUrl: STALLING_WORKER, deadlineMs: 300 }), "close");
    await room.open();
    const { hello, fromOther, world } = authors();
    room.send(hello);
    expect(await room.join()).toBe("hello");
    room.send(fromOther("STALL"));
    room.send(world());

    await room.close();
    await room.open();

    expect(await room.join()).toBe("");
    expect(room.relayed).toEqual([hello]);
  });
});
