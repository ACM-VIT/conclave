import { describe, expect, it } from "vitest";
import {
  createBatchStore,
  createOutbox,
  type DroppedBatches,
  FLUSH_INTERVAL_MS,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  MAX_STORED_CHARS,
  type OutboxEvent,
  REPLAY_HOLD_MS,
  type StoredBatch,
  UNLOAD_BUDGET_BYTES,
  URGENT_FLUSH_GAP_MS,
} from "../src/app/lib/telemetry-outbox";

const KEY = "phc_test_project";
const START = Date.parse("2026-11-23T00:00:00.000Z");
const MINUTE = 60_000;

type Answer = number | "offline" | "pending" | Promise<number>;

/** Storage the next page load reads, shared by the outboxes a test makes: one entry per batch. */
const memoryStore = () => {
  const saved = new Map<string, StoredBatch>();
  return {
    save: (batch: StoredBatch) => void saved.set(batch.id, structuredClone(batch)),
    remove: (id: string) => void saved.delete(id),
    list: () => [...saved.values()].map((batch) => structuredClone(batch)),
  };
};

type Store = ReturnType<typeof memoryStore> | ReturnType<typeof createBatchStore>;

/** A Web Locks lock the tabs of a test share: each request waits its turn. */
const sharedLock = () => {
  const waiting: Array<() => Promise<void>> = [];
  let held = false;
  const next = (): void => {
    const run = waiting.shift();
    if (!run) return;
    held = true;
    void run().finally(() => {
      held = false;
      next();
    });
  };
  const lock = (replay: () => Promise<void>) => {
    waiting.push(replay);
    if (!held) next();
  };
  return Object.assign(lock, { waiting: () => waiting.length, held: () => held });
};

const noLock = (replay: () => Promise<void>) => void replay();

let batchIds = 0;

/** A clock, timers, transports and storage the test drives by hand. */
const harness = ({
  answers = [] as Answer[],
  store = memoryStore() as Store,
  at = START,
  lock = noLock,
} = {}) => {
  let now = at;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let ids = 0;
  const posts: Array<{ body: string; keepalive: boolean; at: number }> = [];
  const beacons: string[] = [];
  const dropped: DroppedBatches[] = [];
  let beaconRefuses = false;
  const outbox = createOutbox({
    token: KEY,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++ids;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    post: (body, keepalive) => {
      posts.push({ body, keepalive, at: now });
      const answer = answers.shift() ?? 200;
      if (answer === "pending") return new Promise<number>(() => {});
      if (answer instanceof Promise) return answer;
      return answer === "offline" ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(answer);
    },
    beacon: (body) => {
      if (beaconRefuses) return false;
      beacons.push(body);
      return true;
    },
    newId: () => `0196f0a1-0000-7000-9000-${String(++batchIds).padStart(12, "0")}`,
    store,
    lock,
    onStale: (counted) => dropped.push(counted),
  });
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      // Answers already given settle first, and may set timers of their own.
      await new Promise((resolve) => setTimeout(resolve, 0));
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      now = next.at;
      next.fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    now = until;
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const batchOf = (body: string) => JSON.parse(body) as { api_key: string; batch: OutboxEvent[]; sent_at: string };
  const uuidsIn = (bodies: string[]) => bodies.flatMap((body) => batchOf(body).batch.map((event) => event.uuid));
  return {
    outbox,
    posts,
    beacons,
    dropped,
    advance,
    batchOf,
    uuidsIn,
    posted: () => uuidsIn(posts.map((post) => post.body)),
    refuseBeacons: () => (beaconRefuses = true),
  };
};

const storedUuids = (store: Store) => store.list().flatMap((batch) => batch.events.map((event) => event.uuid));

let n = 0;
const event = (name = "meet_join_attempt", padding = 0, at = START): OutboxEvent => ({
  uuid: `0196f0a1-0000-7000-8000-${String(++n).padStart(12, "0")}`,
  event: name,
  timestamp: new Date(at).toISOString(),
  properties: { token: KEY, joinMode: "meeting", ...(padding ? { $exception_list: [{ value: "x".repeat(padding) }] } : {}) },
});

const answerLater = () => {
  let answer: (status: number) => void = () => {};
  const promise = new Promise<number>((resolve) => (answer = resolve));
  return { promise, answer };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the telemetry outbox", () => {
  it("sends the events of an interval as one batch request", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.outbox.add(event());
    await h.advance(FLUSH_INTERVAL_MS - 1);
    expect(h.posts).toHaveLength(0);

    await h.advance(1);
    expect(h.posts).toHaveLength(1);
    expect(h.batchOf(h.posts[0].body)).toMatchObject({ api_key: KEY });
    expect(h.batchOf(h.posts[0].body).batch).toHaveLength(5);
    expect(h.posts[0].keepalive).toBe(true);
  });

  it("sends a batch as soon as it holds the most events a batch takes", async () => {
    const h = harness();
    for (let i = 0; i < MAX_BATCH_EVENTS; i++) h.outbox.add(event());
    await h.advance(0);

    expect(h.posts).toHaveLength(1);
    expect(h.batchOf(h.posts[0].body).batch).toHaveLength(MAX_BATCH_EVENTS);
  });

  it("keeps every batch under the byte cap, sending a full one before it would pass it", async () => {
    const h = harness();
    const big = Math.floor(MAX_BATCH_BYTES / 3);
    for (let i = 0; i < 4; i++) h.outbox.add(event("meet_join_attempt", big));
    await h.advance(FLUSH_INTERVAL_MS);

    expect(h.posts.length).toBeGreaterThanOrEqual(2);
    for (const { body } of h.posts) expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    expect(h.posted()).toHaveLength(4);
  });

  it("sends an exception at once, but at most one early send per gap", async () => {
    const h = harness();
    h.outbox.add(event("meet_join_attempt"));
    h.outbox.add(event("$exception"), { urgent: true });
    await h.advance(0);
    expect(h.posts).toHaveLength(1);
    expect(h.batchOf(h.posts[0].body).batch.map((sent) => sent.event)).toEqual(["meet_join_attempt", "$exception"]);

    await h.advance(1000);
    h.outbox.add(event("$exception"), { urgent: true });
    h.outbox.add(event("$exception"), { urgent: true });
    await h.advance(0);
    expect(h.posts).toHaveLength(1);

    await h.advance(URGENT_FLUSH_GAP_MS - 1000);
    expect(h.posts).toHaveLength(2);
    expect(h.batchOf(h.posts[1].body).batch).toHaveLength(2);
  });

  it("sends the whole queue as one beacon when the page goes away, and nothing twice", async () => {
    const h = harness();
    for (let i = 0; i < 7; i++) h.outbox.add(event());
    h.outbox.flushForUnload();
    h.outbox.flushForUnload();
    await h.advance(FLUSH_INTERVAL_MS * 2);

    expect(h.posts).toHaveLength(0);
    expect(h.beacons).toHaveLength(1);
    expect(h.uuidsIn(h.beacons)).toHaveLength(7);
  });

  it("retries a failed batch with the very same events, stamped with the time of each send, and never a delivered one", async () => {
    const h = harness({ answers: [503, "offline", 200] });
    for (let i = 0; i < 3; i++) h.outbox.add(event());
    await h.advance(FLUSH_INTERVAL_MS);
    await h.advance(60_000);

    expect(h.posts).toHaveLength(3);
    const sent = h.posts.map((post) => h.batchOf(post.body));
    expect(sent[1].batch).toEqual(sent[0].batch);
    expect(sent[2].batch).toEqual(sent[0].batch);
    expect(sent.map((body) => body.sent_at)).toEqual(h.posts.map((post) => new Date(post.at).toISOString()));
    await h.advance(120_000);
    expect(h.posts).toHaveLength(3);
  });

  it("drops a batch /ingest refused, which a retry would not change", async () => {
    const h = harness({ answers: [400] });
    h.outbox.add(event());
    await h.advance(FLUSH_INTERVAL_MS);
    await h.advance(120_000);

    expect(h.posts).toHaveLength(1);
  });

  it("queues an event once, whatever adds it again", async () => {
    const h = harness();
    const once = event();
    h.outbox.add(once);
    h.outbox.add(once);
    h.outbox.flushForUnload();
    h.outbox.add(once);
    h.outbox.flushForUnload();

    expect(h.uuidsIn(h.beacons)).toEqual([once.uuid]);
  });
});

describe("the outbox as the page goes away", () => {
  it("saves every batch not yet answered, and beacons the ones not in flight", async () => {
    const store = memoryStore();
    const h = harness({ answers: [503, "pending"], store });
    const waiting = event();
    h.outbox.add(waiting);
    await h.advance(FLUSH_INTERVAL_MS);
    const inFlight = event("$exception");
    h.outbox.add(inFlight, { urgent: true });
    const queued = event();
    h.outbox.add(queued);
    h.outbox.flushForUnload();

    expect(h.posted()).toEqual([waiting.uuid, inFlight.uuid]);
    expect(h.uuidsIn(h.beacons).sort()).toEqual([waiting.uuid, queued.uuid].sort());
    expect(storedUuids(store).sort()).toEqual([waiting.uuid, inFlight.uuid, queued.uuid].sort());
    await h.advance(120_000);
    expect(h.posts).toHaveLength(2);
  });

  it("saves a request in flight past the keepalive budget, which the page's end cancels, and the next load sends it", async () => {
    const store = memoryStore();
    const h = harness({ answers: ["pending", "pending"], store });
    // The first batch takes most of the shared budget by keepalive; the next
    // goes as a plain request the browser cancels as the page goes away.
    for (let i = 0; i < 2; i++) h.outbox.add(event("meet_join_attempt", 20 * 1024));
    await h.advance(FLUSH_INTERVAL_MS);
    const overflow = [event("meet_join_attempt", 15 * 1024), event("meet_join_attempt", 15 * 1024)];
    for (const item of overflow) h.outbox.add(item);
    await h.advance(FLUSH_INTERVAL_MS);
    expect(h.posts.map((post) => post.keepalive)).toEqual([true, false]);
    h.outbox.flushForUnload();

    const saved = store.list();
    expect(saved.map((batch) => batch.events.map((item) => item.uuid))).toContainEqual(overflow.map((item) => item.uuid));
    expect(saved.find((batch) => batch.events[0].uuid === overflow[0].uuid)).toMatchObject({ sent: false });

    const nextLoad = harness({ store, at: START + 20_000 });
    nextLoad.outbox.replaySaved();
    await nextLoad.advance(0);
    expect(nextLoad.posted()).toEqual(expect.arrayContaining(overflow.map((item) => item.uuid)));
    expect(store.list()).toEqual([]);
  });

  it("removes a saved copy only once its send is answered", async () => {
    const store = memoryStore();
    const first = harness({ store });
    first.refuseBeacons();
    const kept = event();
    first.outbox.add(kept);
    first.outbox.flushForUnload();
    expect(storedUuids(store)).toEqual([kept.uuid]);

    const later = answerLater();
    const nextLoad = harness({ answers: [later.promise], store, at: START + 10_000 });
    nextLoad.outbox.replaySaved();
    await nextLoad.advance(0);
    expect(nextLoad.posted()).toEqual([kept.uuid]);
    expect(storedUuids(store)).toEqual([kept.uuid]);

    // A page that goes away before the answer keeps it for the load after.
    nextLoad.outbox.flushForUnload();
    expect(storedUuids(store)).toEqual([kept.uuid]);

    later.answer(503);
    await nextLoad.advance(0);
    expect(storedUuids(store)).toEqual([kept.uuid]);
    await nextLoad.advance(2000);
    expect(nextLoad.posts).toHaveLength(2);
    expect(storedUuids(store)).toEqual([]);
  });

  it("keeps what the browser will not take by beacon for the next page load", async () => {
    const store = memoryStore();
    const h = harness({ store });
    h.refuseBeacons();
    const kept = event();
    h.outbox.add(kept);
    h.outbox.flushForUnload();

    expect(h.posts).toEqual([]);
    expect(store.list()).toEqual([expect.objectContaining({ sent: false, events: [kept] })]);
  });

  it("sends only what fits one shared unload budget, keeps every batch, and the next load sends each", async () => {
    const store = memoryStore();
    const h = harness({ store });
    // A page going away builds every held report at once: more than the
    // browser's 64 KB allowance for beacons and keepalive requests together.
    const big = 30 * 1024;
    const queued = Array.from({ length: 4 }, () => event("meet_join_attempt", big));
    for (const item of queued) h.outbox.add(item, { deferred: true });
    expect(h.posts).toHaveLength(0);
    h.outbox.flushForUnload();

    const beaconBytes = h.beacons.reduce((total, body) => total + new TextEncoder().encode(body).byteLength, 0);
    expect(beaconBytes).toBeLessThanOrEqual(UNLOAD_BUDGET_BYTES);
    const beaconed = h.uuidsIn(h.beacons);
    expect(beaconed.length).toBeGreaterThan(0);
    expect(beaconed.length).toBeLessThan(queued.length);
    expect(storedUuids(store).sort()).toEqual(queued.map((item) => item.uuid).sort());
    const sent = store.list().filter((batch) => batch.sent).flatMap((batch) => batch.events.map((item) => item.uuid));
    expect(sent.sort()).toEqual(beaconed.sort());

    const nextLoad = harness({ store, at: START + 30_000 });
    nextLoad.outbox.replaySaved();
    await nextLoad.advance(0);
    expect(nextLoad.posted().sort()).toEqual(queued.map((item) => item.uuid).sort());
    expect(store.list()).toEqual([]);
  });

  it("counts keepalive requests still in flight against the unload budget", async () => {
    const store = memoryStore();
    const h = harness({ answers: ["pending"], store });
    const early = [event("meet_join_attempt", 20 * 1024), event("meet_join_attempt", 20 * 1024)];
    for (const item of early) h.outbox.add(item);
    await h.advance(FLUSH_INTERVAL_MS);
    expect(h.posts).toEqual([expect.objectContaining({ keepalive: true })]);
    const late = event("meet_join_attempt", 20 * 1024);
    h.outbox.add(late);
    h.outbox.flushForUnload();

    expect(h.beacons).toEqual([]);
    const saved = store.list().map((batch) => ({ uuids: batch.events.map((item) => item.uuid), sent: batch.sent }));
    expect(saved).toEqual(
      expect.arrayContaining([
        { uuids: early.map((item) => item.uuid), sent: true },
        { uuids: [late.uuid], sent: false },
      ]),
    );
  });

  it("keeps a batch whose retries ran out for the next replay", async () => {
    const store = memoryStore();
    const h = harness({ answers: Array.from({ length: 6 }, () => 503), store });
    const failing = event();
    h.outbox.add(failing);
    await h.advance(FLUSH_INTERVAL_MS);
    await h.advance(120_000);

    expect(h.posts).toHaveLength(6);
    expect(store.list()).toEqual([expect.objectContaining({ sent: false, events: [failing] })]);
  });
});

describe("saved batches across tabs", () => {
  /**
   * One origin's local storage as the tabs see it: a tab reads what was
   * there when it opened, so two tabs saving at once both read before either
   * writes, as a read, append and write of one shared entry would.
   */
  const origin = () => {
    const items = new Map<string, string>();
    const tab = (): Storage => {
      const seen = new Map(items);
      return {
        get length() {
          return seen.size;
        },
        key: (index: number) => [...seen.keys()][index] ?? null,
        getItem: (key: string) => seen.get(key) ?? null,
        setItem: (key: string, value: string) => {
          items.set(key, value);
          seen.set(key, value);
        },
        removeItem: (key: string) => {
          items.delete(key);
          seen.delete(key);
        },
        clear: () => {
          items.clear();
          seen.clear();
        },
      };
    };
    return { items, tab };
  };

  it("loses nothing when two tabs save at once", async () => {
    const site = origin();
    const tabs = [site.tab(), site.tab()].map((storage) => {
      const h = harness({ store: createBatchStore(() => storage) });
      h.refuseBeacons();
      return h;
    });
    const saved = tabs.map((tab) => {
      const items = [event(), event()];
      for (const item of items) tab.outbox.add(item);
      return items;
    });
    for (const tab of tabs) tab.outbox.flushForUnload();

    const store = createBatchStore(() => site.tab());
    expect(storedUuids(store).sort()).toEqual(saved.flat().map((item) => item.uuid).sort());
    const nextLoad = harness({ store, at: START + 10_000 });
    nextLoad.outbox.replaySaved();
    await nextLoad.advance(0);
    expect(nextLoad.posted().sort()).toEqual(saved.flat().map((item) => item.uuid).sort());
    expect(site.items.size).toBe(0);
  });

  it("removes only what a replay sent, never what another tab saved while it ran", async () => {
    const site = origin();
    const firstTab = harness({ store: createBatchStore(() => site.tab()) });
    firstTab.refuseBeacons();
    const earlier = event();
    firstTab.outbox.add(earlier);
    firstTab.outbox.flushForUnload();

    const later = answerLater();
    const replaying = harness({ answers: [later.promise], store: createBatchStore(() => site.tab()), at: START + 5000 });
    replaying.outbox.replaySaved();
    await settle();
    expect(replaying.posted()).toEqual([earlier.uuid]);

    const closing = harness({ store: createBatchStore(() => site.tab()), at: START + 6000 });
    closing.refuseBeacons();
    const meanwhile = event("meet_join_attempt", 0, START + 6000);
    closing.outbox.add(meanwhile);
    closing.outbox.flushForUnload();
    later.answer(200);
    await settle();

    expect(storedUuids(createBatchStore(() => site.tab()))).toEqual([meanwhile.uuid]);
  });

  it("replays each saved batch from one tab at a time where the lock is available", async () => {
    const store = memoryStore();
    const closed = harness({ store });
    closed.refuseBeacons();
    const items = [event(), event(), event()];
    for (const item of items) closed.outbox.add(item);
    closed.outbox.flushForUnload();

    const lock = sharedLock();
    const loads = [harness({ store, lock, at: START + 5000 }), harness({ store, lock, at: START + 5000 })];
    for (const load of loads) load.outbox.replaySaved();
    await settle();

    expect(loads.flatMap((load) => load.posted()).sort()).toEqual(items.map((item) => item.uuid).sort());
    expect(store.list()).toEqual([]);
  });

  it("replays again once a replay in progress ends, for a batch saved while it waited for an answer", async () => {
    const store = memoryStore();
    const closed = harness({ store });
    closed.refuseBeacons();
    const earlier = event();
    closed.outbox.add(earlier);
    closed.outbox.flushForUnload();

    const later = answerLater();
    const page = harness({ answers: [later.promise], store, lock: sharedLock(), at: START + 5000 });
    page.outbox.replaySaved();
    await settle();
    expect(page.posted()).toEqual([earlier.uuid]);

    // The page hides, saving what it holds, and comes back while the
    // replay still waits for its answer.
    page.refuseBeacons();
    const meanwhile = event("meet_join_attempt", 0, START + 5000);
    page.outbox.add(meanwhile);
    page.outbox.flushForUnload();
    page.outbox.replaySaved();
    later.answer(200);
    await page.advance(0);

    expect(page.posted()).toEqual([earlier.uuid, meanwhile.uuid]);
    expect(store.list()).toEqual([]);
  });

  it("waits its turn when another tab holds the lock, then sends what was saved meanwhile", async () => {
    const store = memoryStore();
    const lock = sharedLock();
    const closed = harness({ store });
    closed.refuseBeacons();
    const earlier = event();
    closed.outbox.add(earlier);
    closed.outbox.flushForUnload();

    const later = answerLater();
    const holder = harness({ answers: [later.promise], store, lock, at: START + 5000 });
    holder.outbox.replaySaved();
    await settle();

    const other = harness({ store, lock, at: START + 5000 });
    other.refuseBeacons();
    const meanwhile = event("meet_join_attempt", 0, START + 5000);
    other.outbox.add(meanwhile);
    other.outbox.flushForUnload();
    other.outbox.replaySaved();
    await settle();
    expect(other.posts).toEqual([]);

    later.answer(200);
    await other.advance(0);
    expect(other.posted()).toEqual([meanwhile.uuid]);
    expect(store.list()).toEqual([]);
  });

  it("holds the lock no longer than REPLAY_HOLD_MS for a send that never answers", async () => {
    const store = memoryStore();
    const lock = sharedLock();
    const closed = harness({ store });
    closed.refuseBeacons();
    const stuck = event();
    closed.outbox.add(stuck);
    closed.outbox.flushForUnload();

    const holder = harness({ answers: ["pending"], store, lock, at: START + 5000 });
    holder.outbox.replaySaved();
    const other = harness({ store, lock, at: START + 5000 });
    other.outbox.replaySaved();
    await holder.advance(REPLAY_HOLD_MS - 1);
    expect(other.posts).toEqual([]);

    await holder.advance(1);
    await other.advance(0);
    expect(other.posted()).toEqual([stuck.uuid]);
    expect(lock.held()).toBe(false);
  });

  it("asks for the lock once while a replay waits for it, however often the page comes back", async () => {
    const lock = sharedLock();
    const holder = harness({ answers: ["pending"], lock });
    holder.outbox.replaySaved();
    const page = harness({ lock });
    for (let i = 0; i < 5; i++) page.outbox.replaySaved();

    expect(lock.waiting()).toBe(1);
  });

  it("loses nothing without the lock: two tabs replaying at once both send, and /ingest takes the uuid once", async () => {
    const store = memoryStore();
    const closed = harness({ store });
    closed.refuseBeacons();
    const items = [event(), event()];
    for (const item of items) closed.outbox.add(item);
    closed.outbox.flushForUnload();

    const loads = [harness({ store, at: START + 5000 }), harness({ store, at: START + 5000 })];
    for (const load of loads) load.outbox.replaySaved();
    await settle();

    for (const load of loads) expect(load.posted().sort()).toEqual(items.map((item) => item.uuid).sort());
    expect(store.list()).toEqual([]);
  });

  it("keeps at most the storage cap, the oldest batches going first", () => {
    const site = origin();
    const storage = site.tab();
    const store = createBatchStore(() => storage);
    const size = 40 * 1024;
    const count = Math.ceil(MAX_STORED_CHARS / size) + 2;
    for (let i = 0; i < count; i++) {
      store.save({ id: `batch-${i}`, events: [event("meet_join_attempt", size, START + i * 1000)], oldestAt: START + i * 1000, sent: false });
    }

    const kept = store.list().map((batch) => batch.id);
    const chars = [...site.items.values()].reduce((total, text) => total + text.length, 0);
    expect(chars).toBeLessThanOrEqual(MAX_STORED_CHARS);
    expect(kept).toContain(`batch-${count - 1}`);
    expect(kept).not.toContain("batch-0");
  });
});

describe("saved batches too old for /ingest", () => {
  it("drops a batch saved more than 5 minutes ago and counts it, never sending it to be dated now", async () => {
    const store = memoryStore();
    const closed = harness({ store });
    closed.refuseBeacons();
    const old = [event(), event()];
    for (const item of old) closed.outbox.add(item);
    closed.outbox.flushForUnload();
    const beaconed = harness({ store });
    const alsoOld = event();
    beaconed.outbox.add(alsoOld);
    beaconed.outbox.flushForUnload();
    expect(beaconed.uuidsIn(beaconed.beacons)).toEqual([alsoOld.uuid]);

    const nextLoad = harness({ store, at: START + 5 * MINUTE + 1000 });
    nextLoad.outbox.replaySaved();
    await nextLoad.advance(0);

    expect(nextLoad.posts).toEqual([]);
    expect(store.list()).toEqual([]);
    // One aggregate count; `unsent` is the batch no beacon may have delivered.
    expect(nextLoad.dropped).toEqual([{ batches: 2, events: 3, unsent: 1 }]);
  });

  it("sends a batch younger than that with the times its events had", async () => {
    const store = memoryStore();
    const closed = harness({ store });
    closed.refuseBeacons();
    const recent = event();
    closed.outbox.add(recent);
    closed.outbox.flushForUnload();

    const nextLoad = harness({ store, at: START + 3 * MINUTE });
    nextLoad.outbox.replaySaved();
    await nextLoad.advance(0);

    const [sent] = nextLoad.posts.map((post) => nextLoad.batchOf(post.body));
    expect(sent.batch).toEqual([recent]);
    expect(sent.sent_at).toBe(new Date(START + 3 * MINUTE).toISOString());
    expect(nextLoad.dropped).toEqual([]);
  });

  it("drops a retry once it has grown too old to send, and counts it", async () => {
    const store = memoryStore();
    const closed = harness({ store });
    closed.refuseBeacons();
    closed.outbox.add(event());
    closed.outbox.flushForUnload();

    const nextLoad = harness({ answers: Array.from({ length: 6 }, () => 503), store, at: START + 3.5 * MINUTE });
    nextLoad.outbox.replaySaved();
    await nextLoad.advance(2 * MINUTE);

    for (const post of nextLoad.posts) expect(post.at - START).toBeLessThanOrEqual(5 * MINUTE);
    expect(nextLoad.posts.length).toBeLessThan(6);
    expect(store.list()).toEqual([]);
    expect(nextLoad.dropped).toEqual([{ batches: 1, events: 1, unsent: 1 }]);
  });
});
