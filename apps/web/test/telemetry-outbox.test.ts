import { describe, expect, it } from "vitest";
import {
  countDropped,
  createBatchStore,
  createOutbox,
  type DroppedBatches,
  FLUSH_INTERVAL_MS,
  LEASE_MS,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  MAX_STORED_CHARS,
  type OutboxEvent,
  SEND_DEADLINE_MS,
  STORED_BATCH_PREFIX,
  type StoredBatch,
  UNLOAD_BUDGET_BYTES,
  URGENT_FLUSH_GAP_MS,
} from "../src/app/lib/telemetry-outbox";

const KEY = "phc_test_project";
const START = Date.parse("2026-11-23T00:00:00.000Z");
const MINUTE = 60_000;

type Reply = { status: number; retryAfter: string | null; rejected?: number[] };
type Answer = number | Reply | "offline" | "pending" | Promise<number | Reply>;

/** Storage the next page load reads, shared by the outboxes a test makes: one entry per batch. */
const memoryStore = () => {
  const saved = new Map<string, StoredBatch>();
  return {
    save: (batch: StoredBatch) => {
      saved.set(batch.id, structuredClone(batch));
      return true;
    },
    get: (id: string) => {
      const batch = saved.get(id);
      return batch ? structuredClone(batch) : null;
    },
    remove: (id: string) => void saved.delete(id),
    list: () => [...saved.values()].map((batch) => structuredClone(batch)),
  };
};

const fullStorage = (): Storage => ({
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem: () => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  },
  removeItem: () => {},
  clear: () => {},
});

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
  clock = { now: at },
  ignoreAbort = false,
  shape = undefined as ((event: OutboxEvent) => OutboxEvent | null) | undefined,
} = {}) => {
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let ids = 0;
  const posts: Array<{ body: string; keepalive: boolean; at: number; signal?: AbortSignal }> = [];
  const beacons: string[] = [];
  const dropped: DroppedBatches[] = [];
  let beaconRefuses = false;
  const outbox = createOutbox({
    token: KEY,
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const id = ++ids;
      timers.push({ at: clock.now + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    post: (body, keepalive, signal) => {
      posts.push({ body, keepalive, at: clock.now, signal });
      const answer = answers.shift() ?? 200;
      const reply = (value: number | Reply): Reply => (typeof value === "number" ? { status: value, retryAfter: null } : value);
      const replied =
        answer === "pending"
          ? new Promise<Reply>(() => {})
          : answer === "offline"
            ? Promise.reject(new TypeError("Failed to fetch"))
            : answer instanceof Promise
              ? answer.then(reply)
              : Promise.resolve(reply(answer));
      if (!signal || ignoreAbort) return replied;
      return new Promise<Reply>((resolve, reject) => {
        const aborted = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal.aborted) aborted();
        signal.addEventListener("abort", aborted, { once: true });
        replied.then(resolve, reject);
      });
    },
    beacon: (body) => {
      if (beaconRefuses) return false;
      beacons.push(body);
      return true;
    },
    newId: () => `0196f0a1-0000-7000-9000-${String(++batchIds).padStart(12, "0")}`,
    store,
    lock,
    onStale: (batches) => dropped.push(countDropped(batches)),
    ...(shape ? { shape } : {}),
  });
  const advance = async (ms: number) => {
    const until = clock.now + ms;
    for (;;) {
      // Answers already given settle first, and may set timers of their own.
      await new Promise((resolve) => setTimeout(resolve, 0));
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      clock.now = next.at;
      next.fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    clock.now = until;
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

const memoryWebStorage = (): Storage => {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  };
};

let n = 0;
const event = (name = "meet_join_attempt", padding = 0, at = START): OutboxEvent => ({
  uuid: `0196f0a1-0000-7000-8000-${String(++n).padStart(12, "0")}`,
  event: name,
  timestamp: new Date(at).toISOString(),
  properties: { token: KEY, joinMode: "meeting", ...(padding ? { $exception_list: [{ value: "x".repeat(padding) }] } : {}) },
});

const answerLater = () => {
  let answer: (value: number | Reply) => void = () => {};
  const promise = new Promise<number | Reply>((resolve) => (answer = resolve));
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

describe("answers from /ingest", () => {
  it.each([
    [200, "delivered"],
    [204, "delivered"],
    [400, "refused"],
    [401, "refused"],
    [403, "refused"],
    [404, "refused"],
    [405, "refused"],
    [413, "refused"],
    [408, "retried"],
    [425, "retried"],
    [429, "retried"],
    [500, "retried"],
    [502, "retried"],
    [503, "retried"],
    [504, "retried"],
  ] as const)("takes %i as %s", async (status, outcome) => {
    const store = memoryStore();
    const h = harness({ answers: [status], store });
    h.refuseBeacons();
    const sent = event();
    h.outbox.add(sent);
    await h.advance(FLUSH_INTERVAL_MS);
    // A batch still owed a send is saved as the page goes away; one
    // delivered or refused for good is not.
    h.outbox.flushForUnload();

    expect(storedUuids(store)).toEqual(outcome === "retried" ? [sent.uuid] : []);
  });

  it("waits as long as Retry-After asks before sending again, at most a minute", async () => {
    const at = (h: ReturnType<typeof harness>) => h.posts.map((post) => post.at - START);
    const seconds = harness({ answers: [{ status: 429, retryAfter: "7" }] });
    seconds.outbox.add(event());
    await seconds.advance(FLUSH_INTERVAL_MS + 10_000);
    expect(at(seconds)).toEqual([5000, 12_000]);

    const date = harness({ answers: [{ status: 503, retryAfter: new Date(START + 5000 + 9000).toUTCString() }] });
    date.outbox.add(event());
    await date.advance(FLUSH_INTERVAL_MS + 10_000);
    expect(at(date)).toEqual([5000, 14_000]);

    const long = harness({ answers: [{ status: 429, retryAfter: "3600" }] });
    long.outbox.add(event());
    await long.advance(FLUSH_INTERVAL_MS + 2 * MINUTE);
    expect(at(long)).toEqual([5000, 65_000]);
  });
});

describe("a batch storage cannot take", () => {
  it("says so when web storage refuses the write", () => {
    const store = createBatchStore(fullStorage);

    expect(store.save({ id: "batch-full", events: [event()], oldestAt: START, sent: false, notBefore: 0, nextTry: 0, attempt: 0, sendId: "", leaseUntil: 0 })).toBe(false);
    expect(createBatchStore(() => memoryWebStorage()).save({ id: "batch-ok", events: [event()], oldestAt: START, sent: false, notBefore: 0, nextTry: 0, attempt: 0, sendId: "", leaseUntil: 0 })).toBe(true);
  });

  it("waits out a Retry-After in memory, and sends it then", async () => {
    const h = harness({ answers: [{ status: 503, retryAfter: "60" }], store: createBatchStore(fullStorage) });
    const waiting = event();
    h.outbox.add(waiting);
    await h.advance(FLUSH_INTERVAL_MS + 60_000);

    expect(h.posts.map((post) => post.at - START)).toEqual([5000, 65_000]);
    expect(h.posted()).toEqual([waiting.uuid, waiting.uuid]);
  });

  it("stays in memory as the page hides, and goes once the page stays", async () => {
    const h = harness({ answers: [503], store: createBatchStore(fullStorage) });
    h.refuseBeacons();
    const waiting = event();
    h.outbox.add(waiting);
    await h.advance(FLUSH_INTERVAL_MS);
    const queued = event();
    h.outbox.add(queued);
    h.outbox.flushForUnload();
    await h.advance(10_000);

    expect(h.posted()).toEqual(expect.arrayContaining([waiting.uuid, queued.uuid]));
    expect(h.posted().filter((uuid) => uuid === waiting.uuid)).toHaveLength(2);
  });

  it("keeps trying after its retries run out, until it is too old to send, and then counts it", async () => {
    const h = harness({ answers: Array.from({ length: 30 }, () => 503), store: createBatchStore(fullStorage) });
    h.outbox.add(event());
    await h.advance(6 * MINUTE);

    expect(h.posts.length).toBeGreaterThan(6);
    for (const post of h.posts) expect(post.at - START).toBeLessThanOrEqual(4 * MINUTE);
    expect(h.dropped).toEqual([{ batches: 1, events: 1, unsent: 1 }]);
  });
});

describe("retries /ingest asked to wait for", () => {
  it("keep the backoff schedule, then try every 30 s at its last step", async () => {
    const store = memoryStore();
    const h = harness({ answers: Array.from({ length: 30 }, () => ({ status: 429, retryAfter: "1" })), store });
    const limited = event();
    h.outbox.add(limited);
    await h.advance(3 * MINUTE);

    expect(h.posts.map((post) => post.at - START)).toEqual([5000, 7000, 11_000, 19_000, 35_000, 65_000, 95_000, 125_000, 155_000]);
    expect(store.list()).toEqual([]);
  });

  it("keep the schedule through a save and a replay", async () => {
    const store = memoryStore();
    const h = harness({ answers: Array.from({ length: 30 }, () => ({ status: 429, retryAfter: "1" })), store });
    h.refuseBeacons();
    h.outbox.add(event());
    await h.advance(FLUSH_INTERVAL_MS + 500);
    h.outbox.flushForUnload();
    expect(store.list()).toEqual([expect.objectContaining({ attempt: 1, nextTry: START + 7000 })]);
    h.outbox.replaySaved();
    await h.advance(59_000);

    expect(h.posts.map((post) => post.at - START)).toEqual([5000, 7000, 11_000, 19_000, 35_000]);
    expect(store.list()).toEqual([expect.objectContaining({ attempt: 5, nextTry: START + 65_000 })]);
  });
});

describe("a reply from a send another has replaced", () => {
  const savedBatch = (store: Store) => {
    const closed = harness({ store });
    closed.refuseBeacons();
    const waiting = event();
    closed.outbox.add(waiting);
    closed.outbox.flushForUnload();
    return waiting;
  };

  it("is cut off at its deadline, and cannot shorten the wait a newer send was given", async () => {
    const store = memoryStore();
    const waiting = savedBatch(store);
    const lock = sharedLock();
    const clock = { now: START + 5000 };
    const late = answerLater();
    const limited = { status: 429, retryAfter: "60" };
    const first = harness({ answers: [late.promise, limited], store, lock, clock });
    const second = harness({ answers: [limited], store, lock, clock });
    first.outbox.replaySaved();
    second.outbox.replaySaved();
    await settle();
    expect(second.posts).toEqual([]);

    await first.advance(SEND_DEADLINE_MS);
    expect(first.posts[0].signal?.aborted).toBe(true);
    for (let step = 0; step < 3; step++) {
      await second.advance(1000);
      await first.advance(0);
    }
    const sends = () => [...first.posts, ...second.posts];
    expect(sends().map((post) => post.at - START)).toEqual([5000, 5000 + SEND_DEADLINE_MS + 2000]);

    late.answer({ status: 429, retryAfter: "1" });
    for (let step = 0; step < 30; step++) {
      await first.advance(1000);
      await second.advance(0);
    }
    expect(sends()).toHaveLength(2);
    expect(store.list()).toEqual([expect.objectContaining({ notBefore: START + 5000 + SEND_DEADLINE_MS + 2000 + 60_000 })]);
    expect([...first.posted(), ...second.posted()]).toEqual([waiting.uuid, waiting.uuid]);
  });

  it("moves nothing when it arrives after its deadline, even if its request was never stopped", async () => {
    const store = memoryStore();
    const waiting = savedBatch(store);
    const clock = { now: START + 5000 };
    const late = answerLater();
    const page = harness({ answers: [late.promise, { status: 429, retryAfter: "60" }], store, clock, ignoreAbort: true });
    page.outbox.replaySaved();
    await page.advance(SEND_DEADLINE_MS + 2000);
    expect(page.posts.map((post) => post.at - START)).toEqual([5000, 5000 + SEND_DEADLINE_MS + 2000]);

    late.answer({ status: 429, retryAfter: "1" });
    await page.advance(30_000);

    expect(page.posts).toHaveLength(2);
    expect(store.list()).toEqual([expect.objectContaining({ notBefore: START + 5000 + SEND_DEADLINE_MS + 2000 + 60_000 })]);
    expect(page.posted()).toEqual([waiting.uuid, waiting.uuid]);
  });
});

describe("a batch /ingest asked to wait for", () => {
  it("is saved, not beaconed, while its Retry-After runs as the page hides", async () => {
    const store = memoryStore();
    const h = harness({ answers: [{ status: 503, retryAfter: "60" }], store });
    const waiting = event();
    h.outbox.add(waiting);
    await h.advance(FLUSH_INTERVAL_MS);
    h.outbox.flushForUnload();

    expect(h.beacons).toEqual([]);
    expect(store.list()).toEqual([expect.objectContaining({ events: [waiting], notBefore: START + 5000 + 60_000 })]);
  });

  it("is sent by a replay no sooner than its Retry-After allows, and kept until then", async () => {
    const store = memoryStore();
    const closed = harness({ answers: [{ status: 503, retryAfter: "60" }], store });
    const waiting = event();
    closed.outbox.add(waiting);
    await closed.advance(FLUSH_INTERVAL_MS);
    closed.outbox.flushForUnload();

    const nextLoad = harness({ store, at: START + 20_000 });
    nextLoad.outbox.replaySaved();
    await nextLoad.advance(0);
    expect(nextLoad.posts).toEqual([]);
    // Back in view again while it waits: still not before its time.
    nextLoad.outbox.flushForUnload();
    expect(nextLoad.beacons).toEqual([]);
    nextLoad.outbox.replaySaved();
    await nextLoad.advance(0);
    expect(nextLoad.posts).toEqual([]);
    expect(storedUuids(store)).toEqual([waiting.uuid]);

    await nextLoad.advance(START + 65_000 - (START + 20_000) - 1);
    expect(nextLoad.posts).toEqual([]);
    await nextLoad.advance(1);
    expect(nextLoad.posted()).toEqual([waiting.uuid]);
    expect(store.list()).toEqual([]);
  });

  it("is sent once by the tabs whose replays all held it, through a locked pass that reads storage again", async () => {
    const store = memoryStore();
    const closed = harness({ answers: [{ status: 503, retryAfter: "60" }], store });
    const waiting = event();
    closed.outbox.add(waiting);
    await closed.advance(FLUSH_INTERVAL_MS);
    closed.outbox.flushForUnload();

    const lock = sharedLock();
    const tabs = [harness({ store, lock, at: START + 20_000 }), harness({ store, lock, at: START + 20_000 })];
    for (const tab of tabs) tab.outbox.replaySaved();
    for (const tab of tabs) await tab.advance(45_000);

    expect(tabs.flatMap((tab) => tab.posted())).toEqual([waiting.uuid]);
    expect(store.list()).toEqual([]);
  });

  it("keeps every tab waiting for a new Retry-After its send was given", async () => {
    const store = memoryStore();
    const closed = harness({ answers: [{ status: 503, retryAfter: "60" }], store });
    const waiting = event();
    closed.outbox.add(waiting);
    await closed.advance(FLUSH_INTERVAL_MS);
    closed.outbox.flushForUnload();

    const lock = sharedLock();
    const first = harness({ answers: [{ status: 429, retryAfter: "30" }], store, lock, at: START + 20_000 });
    const second = harness({ store, lock, at: START + 20_000 });
    for (const tab of [first, second]) tab.outbox.replaySaved();
    await first.advance(45_000);
    await second.advance(45_000);
    expect(first.posted()).toEqual([waiting.uuid]);
    expect(second.posts).toEqual([]);
    expect(store.list()).toEqual([expect.objectContaining({ notBefore: START + 65_000 + 30_000 })]);

    await first.advance(30_000);
    await second.advance(30_000);
    expect([...first.posted(), ...second.posted()]).toEqual([waiting.uuid, waiting.uuid]);
    expect(store.list()).toEqual([]);
  });

  it("is held back from the beacon while an ordinary backoff runs, and sent at its time", async () => {
    const h = harness({ answers: [503], store: createBatchStore(fullStorage) });
    const failed = event();
    h.outbox.add(failed);
    await h.advance(FLUSH_INTERVAL_MS);
    h.outbox.flushForUnload();
    expect(h.beacons).toEqual([]);

    await h.advance(2000);
    expect(h.posts.map((post) => post.at - START)).toEqual([5000, 7000]);
  });

  it("is beaconed once however many lifecycle events follow, until its confirmation is due", async () => {
    const h = harness({ store: createBatchStore(fullStorage) });
    const queued = event();
    h.outbox.add(queued);
    h.outbox.flushForUnload();
    await h.advance(100);
    h.outbox.flushForUnload();
    await h.advance(100);
    h.outbox.flushForUnload();

    expect(h.uuidsIn(h.beacons)).toEqual([queued.uuid]);
    expect(h.posts).toEqual([]);
  });
});

describe("what a batch carries when it is sent", () => {
  const strip = (item: OutboxEvent): OutboxEvent | null => {
    if (item.event === "rogue") return null;
    const { forbidden: _forbidden, ...properties } = item.properties;
    return { ...item, properties };
  };

  it("builds every event through the outbound schema again at send time, a saved copy's too", async () => {
    const store = memoryStore();
    const kept = { ...event(), properties: { ...event().properties, forbidden: "Meet Mira" } };
    const rogue = { ...event("rogue") };
    store.save({ id: "saved-1", events: [kept, rogue], oldestAt: START, sent: false, notBefore: 0, nextTry: 0, attempt: 0, sendId: "", leaseUntil: 0 });
    const h = harness({ store, shape: strip, at: START + 1000 });
    h.outbox.replaySaved();
    await h.advance(0);

    const sent = h.posts.map((post) => h.batchOf(post.body).batch).flat();
    expect(sent.map((item) => item.uuid)).toEqual([kept.uuid]);
    expect(JSON.stringify(sent)).not.toContain("Meet Mira");
    expect(store.list()).toEqual([]);
  });

  it("sends a rebuilt copy and keeps the stored original, so every send rebuilds from what was captured", async () => {
    const store = memoryStore();
    const original = { ...event(), properties: { ...event().properties, shaped: 0 } };
    store.save({ id: "saved-3", events: [original], oldestAt: START, sent: false, notBefore: 0, nextTry: 0, attempt: 0, sendId: "", leaseUntil: 0 });
    const count = (item: OutboxEvent): OutboxEvent => ({
      ...item,
      properties: { ...item.properties, shaped: Number(item.properties.shaped) + 1 },
    });
    const h = harness({ store, shape: count, answers: [503, 200], at: START + 1000 });
    h.outbox.replaySaved();
    await h.advance(0);
    expect(store.list().map((batch) => batch.events)).toEqual([[original]]);

    await h.advance(2000);
    expect(h.posts.map((post) => h.batchOf(post.body).batch[0].properties.shaped)).toEqual([1, 1]);
    expect(store.list()).toEqual([]);
  });

  it("drops a batch whose every event the schema refuses, without sending it", async () => {
    const store = memoryStore();
    store.save({ id: "saved-2", events: [event("rogue")], oldestAt: START, sent: false, notBefore: 0, nextTry: 0, attempt: 0, sendId: "", leaseUntil: 0 });
    const h = harness({ store, shape: strip, at: START + 1000 });
    h.outbox.replaySaved();
    await h.advance(0);

    expect(h.posts).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it("cuts an oversized report down to fit, and sends it with the batch it shares", async () => {
    const h = harness();
    const normal = event();
    const frames = Array.from({ length: 5000 }, (_, index) => ({ filename: `/_next/static/chunks/frame-${index}.js`, lineno: index, colno: 1, in_app: true }));
    const huge: OutboxEvent = {
      ...event("$exception"),
      properties: { token: KEY, $exception_list: [{ type: "TypeError", value: "[message withheld]", stacktrace: { type: "raw", frames } }], note: "y".repeat(600_000) },
    };
    h.outbox.add(normal);
    h.outbox.add(huge, { urgent: true });
    await h.advance(FLUSH_INTERVAL_MS);

    for (const post of h.posts) expect(new TextEncoder().encode(post.body).byteLength).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    expect(h.posted().sort()).toEqual([normal.uuid, huge.uuid].sort());
    const sentHuge = h.posts.map((post) => h.batchOf(post.body).batch).flat().find((item) => item.uuid === huge.uuid) as OutboxEvent;
    const list = sentHuge.properties.$exception_list as Array<{ type: string; stacktrace?: { frames: unknown[] } }>;
    expect(list[0].type).toBe("TypeError");
    expect((list[0].stacktrace?.frames.length ?? 0) < frames.length).toBe(true);
  });
});

describe("the outbox as the page goes away", () => {
  it("saves every batch not yet answered, beacons only the ones that are due, and confirms each while the page stays", async () => {
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
    expect(h.uuidsIn(h.beacons)).toEqual([queued.uuid]);
    expect(storedUuids(store).sort()).toEqual([waiting.uuid, inFlight.uuid, queued.uuid].sort());
    await h.advance(120_000);
    expect(store.list()).toEqual([]);
    expect(new Set(h.posted())).toEqual(new Set([waiting.uuid, inFlight.uuid, queued.uuid]));
  });

  it("saves a request in flight past the keepalive budget, which the page's end cancels, and the next load sends it", async () => {
    const store = memoryStore();
    const h = harness({ answers: ["pending", "pending"], store });
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
    expect(nextLoad.posts).toEqual([]);
    await nextLoad.advance(LEASE_MS);
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

  it("keeps retrying a batch every 30 s once its schedule runs out, until it is answered", async () => {
    const store = memoryStore();
    const h = harness({ answers: Array.from({ length: 6 }, () => 503), store });
    h.outbox.add(event());
    await h.advance(FLUSH_INTERVAL_MS);
    await h.advance(120_000);

    expect(h.posts.map((post) => post.at - START)).toEqual([5000, 7000, 11_000, 19_000, 35_000, 65_000, 95_000]);
    expect(store.list()).toEqual([]);
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

  it("sends what was saved meanwhile at once, and leaves the batch another tab is sending to it", async () => {
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
    expect(other.posted()).toEqual([meanwhile.uuid]);

    later.answer(200);
    await holder.advance(0);
    await other.advance(0);
    expect(holder.posted()).toEqual([earlier.uuid]);
    expect(other.posted()).toEqual([meanwhile.uuid]);
    expect(store.list()).toEqual([]);
  });

  it("aborts a send that never answers at its deadline, and no other tab sends the batch before then", async () => {
    const store = memoryStore();
    const lock = sharedLock();
    const closed = harness({ store });
    closed.refuseBeacons();
    const stuck = event();
    closed.outbox.add(stuck);
    closed.outbox.flushForUnload();

    const clock = { now: START + 5000 };
    const holder = harness({ answers: ["pending"], store, lock, clock });
    holder.outbox.replaySaved();
    const other = harness({ store, lock, clock });
    other.outbox.replaySaved();
    await holder.advance(SEND_DEADLINE_MS - 1);
    await other.advance(0);
    expect(other.posts).toEqual([]);

    await holder.advance(1);
    expect(holder.posts[0].signal?.aborted).toBe(true);
    for (let step = 0; step < 4; step++) {
      await other.advance(1000);
      await holder.advance(0);
    }
    const sends = [...holder.posts, ...other.posts];
    expect(sends.map((post) => post.at - START)).toEqual([5000, 5000 + SEND_DEADLINE_MS + 2000]);
    expect(store.list()).toEqual([]);
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

  it("leaves a batch another tab has just claimed, even without the lock", async () => {
    const store = memoryStore();
    const closed = harness({ store });
    closed.refuseBeacons();
    const items = [event(), event()];
    for (const item of items) closed.outbox.add(item);
    closed.outbox.flushForUnload();

    const loads = [harness({ store, at: START + 5000 }), harness({ store, at: START + 5000 })];
    for (const load of loads) load.outbox.replaySaved();
    await settle();

    expect(loads[0].posted().sort()).toEqual(items.map((item) => item.uuid).sort());
    expect(loads[1].posts).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it("refuses a batch past the storage cap, and keeps what it holds", () => {
    const site = origin();
    const storage = site.tab();
    const store = createBatchStore(() => storage);
    const size = 40 * 1024;
    const count = Math.ceil(MAX_STORED_CHARS / size) + 2;
    const taken = Array.from({ length: count }, (_, i) =>
      store.save({ id: `batch-${i}`, events: [event("meet_join_attempt", size, START + i * 1000)], oldestAt: START + i * 1000, sent: false, notBefore: 0, nextTry: 0, attempt: 0, sendId: "", leaseUntil: 0 }),
    );

    const kept = store.list().map((batch) => batch.id);
    const chars = [...site.items.values()].reduce((total, text) => total + text.length, 0);
    expect(chars).toBeLessThanOrEqual(MAX_STORED_CHARS);
    expect(taken.at(-1)).toBe(false);
    expect(kept).toContain("batch-0");
    expect(kept).not.toContain(`batch-${count - 1}`);
    expect(kept).toEqual(Array.from({ length: taken.filter(Boolean).length }, (_, i) => `batch-${i}`));
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

const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
};

describe("one event's flaw stays with that event", () => {
  const flaws: Array<(item: OutboxEvent) => unknown> = [
    (item) => ({ ...item, uuid: "not-a-uuid" }),
    ({ uuid: _uuid, ...item }) => item,
    (item) => ({ ...item, uuid: 7 }),
    (item) => ({ ...item, timestamp: "not a time" }),
    ({ timestamp: _timestamp, ...item }) => item,
    (item) => ({ ...item, properties: "Meet Mira" }),
    (item) => ({ ...item, event: 7 }),
  ];

  it("keeps every sound event of a saved batch, whatever is wrong with the others, over 300 seeded batches", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = seeded(seed);
      const storage = memoryWebStorage();
      const events = Array.from({ length: 1 + Math.floor(random() * 8) }, (_, index) => event("meet_join_attempt", 0, START + index));
      const items = events.map((item) => (random() < 0.4 ? flaws[Math.floor(random() * flaws.length)](item) : item));
      const sound = events.filter((item, index) => items[index] === item);
      storage.setItem(`${STORED_BATCH_PREFIX}saved-${seed}`, JSON.stringify({ id: `saved-${seed}`, events: items, oldestAt: START, sent: false }));

      const listed = createBatchStore(() => storage).list();
      if (sound.length === 0) {
        expect(listed, `seed ${seed}`).toEqual([]);
        expect(storage.length, `seed ${seed}`).toBe(0);
      } else {
        expect(listed.map((batch) => batch.events), `seed ${seed}`).toEqual([sound]);
      }
    }
  });

  it("drops only the events /ingest names as refused, and sends the rest again", async () => {
    const h = harness({ answers: [{ status: 503, retryAfter: null, rejected: [1] }, 200] });
    const sent = [event(), event(), event()];
    for (const item of sent) h.outbox.add(item);
    await h.advance(FLUSH_INTERVAL_MS);
    await h.advance(2000);

    expect(h.posts.map((post) => h.batchOf(post.body).batch.map((item) => item.uuid))).toEqual([
      sent.map((item) => item.uuid),
      [sent[0].uuid, sent[2].uuid],
    ]);
  });

  it("finishes a batch whose every event /ingest refused, even on an answer worth retrying", async () => {
    const store = memoryStore();
    const h = harness({ answers: [{ status: 503, retryAfter: null, rejected: [0, 1] }], store });
    h.outbox.add(event());
    h.outbox.add(event());
    await h.advance(FLUSH_INTERVAL_MS);
    h.outbox.flushForUnload();
    await h.advance(10 * MINUTE);

    expect(h.posts).toHaveLength(1);
    expect(h.beacons).toEqual([]);
    expect(store.list()).toEqual([]);
  });
});
