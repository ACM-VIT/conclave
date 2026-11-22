import { describe, expect, it } from "vitest";
import {
  createOutbox,
  FLUSH_INTERVAL_MS,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  type OutboxEvent,
  UNLOAD_BUDGET_BYTES,
  URGENT_FLUSH_GAP_MS,
} from "../src/app/lib/telemetry-outbox";

const KEY = "phc_test_project";

/** A clock, timers and transports the test drives by hand. */
/** Storage the next page load reads, shared by the outboxes a test makes. */
const spillStore = () => {
  let saved: string[] = [];
  return {
    save: (bodies: string[]) => {
      saved = [...saved, ...bodies];
    },
    take: () => saved.splice(0),
    peek: () => [...saved],
  };
};

const harness = (
  answers: Array<number | "offline" | "pending"> = [],
  spill: ReturnType<typeof spillStore> = spillStore(),
) => {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let ids = 0;
  const posts: Array<{ body: string; keepalive: boolean }> = [];
  const beacons: string[] = [];
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
      posts.push({ body, keepalive });
      const answer = answers.shift() ?? 200;
      if (answer === "pending") return new Promise<number>(() => {});
      return answer === "offline" ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(answer);
    },
    beacon: (body) => {
      if (beaconRefuses) return false;
      beacons.push(body);
      return true;
    },
    spill,
  });
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
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
  const batchOf = (body: string) => (JSON.parse(body) as { api_key: string; batch: OutboxEvent[] });
  const uuidsIn = (bodies: string[]) => bodies.flatMap((body) => batchOf(body).batch.map((event) => event.uuid));
  return {
    outbox,
    posts,
    beacons,
    advance,
    batchOf,
    uuidsIn,
    refuseBeacons: () => (beaconRefuses = true),
  };
};

let n = 0;
const event = (name = "meet_join_attempt", padding = 0): OutboxEvent => ({
  uuid: `0196f0a1-0000-7000-8000-${String(++n).padStart(12, "0")}`,
  event: name,
  timestamp: "2026-11-23T00:00:00.000Z",
  properties: { token: KEY, joinMode: "meeting", ...(padding ? { $exception_list: [{ value: "x".repeat(padding) }] } : {}) },
});

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
    expect(h.uuidsIn(h.posts.map((post) => post.body))).toHaveLength(4);
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

  it("sends each event once, by post, beacon or the next page load, when posts are still in flight", async () => {
    const spill = spillStore();
    const h = harness(Array.from({ length: 10 }, () => "pending" as const), spill);
    const big = Math.floor(MAX_BATCH_BYTES / 2.5);
    // Queued faster than the cap sends them: each add past the cap starts a post that never answers.
    for (let i = 0; i < 6; i++) h.outbox.add(event("meet_join_attempt", big));
    const posted = h.uuidsIn(h.posts.map((post) => post.body));
    h.outbox.flushForUnload();

    for (const body of h.beacons) expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    const all = [...posted, ...h.uuidsIn(h.beacons), ...h.uuidsIn(spill.peek())];
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);
  });

  it("retries a failed batch with the very same body, and never a delivered one", async () => {
    const h = harness([503, "offline", 200]);
    for (let i = 0; i < 3; i++) h.outbox.add(event());
    await h.advance(FLUSH_INTERVAL_MS);
    await h.advance(60_000);

    expect(h.posts).toHaveLength(3);
    expect(new Set(h.posts.map((post) => post.body)).size).toBe(1);
    await h.advance(120_000);
    expect(h.posts).toHaveLength(3);
  });

  it("drops a batch /ingest refused, which a retry would not change", async () => {
    const h = harness([400]);
    h.outbox.add(event());
    await h.advance(FLUSH_INTERVAL_MS);
    await h.advance(120_000);

    expect(h.posts).toHaveLength(1);
  });

  it("sends a batch waiting to retry by beacon when the page goes away, but not one in flight", async () => {
    const h = harness([503, "pending"]);
    const waiting = event();
    h.outbox.add(waiting);
    await h.advance(FLUSH_INTERVAL_MS);
    const inFlight = event("$exception");
    h.outbox.add(inFlight, { urgent: true });
    const queued = event();
    h.outbox.add(queued);
    h.outbox.flushForUnload();

    expect(h.uuidsIn(h.posts.map((post) => post.body))).toEqual([waiting.uuid, inFlight.uuid]);
    expect(h.uuidsIn(h.beacons).sort()).toEqual([waiting.uuid, queued.uuid].sort());
    await h.advance(120_000);
    expect(h.posts).toHaveLength(2);
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

  it("keeps what the browser will not take by beacon for the next page load, and clears nothing it did not accept", async () => {
    const spill = spillStore();
    const h = harness([], spill);
    h.refuseBeacons();
    const kept = event();
    h.outbox.add(kept);
    h.outbox.flushForUnload();

    expect(h.posts).toEqual([]);
    expect(h.uuidsIn(spill.peek())).toEqual([kept.uuid]);
  });

  it("sends only what fits one shared unload budget, keeps the rest, and the next load sends it once", async () => {
    const spill = spillStore();
    const h = harness([], spill);
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
    const spilled = h.uuidsIn(spill.peek());
    expect(beaconed.length).toBeGreaterThan(0);
    expect(spilled.length).toBeGreaterThan(0);
    expect([...beaconed, ...spilled].sort()).toEqual(queued.map((item) => item.uuid).sort());

    const nextLoad = harness([], spill);
    nextLoad.outbox.sendSpilled();
    await nextLoad.advance(0);
    expect(nextLoad.uuidsIn(nextLoad.posts.map((post) => post.body)).sort()).toEqual(spilled.sort());
    expect(spill.peek()).toEqual([]);
  });

  it("counts keepalive requests still in flight against the unload budget", async () => {
    const spill = spillStore();
    const h = harness(["pending"], spill);
    for (let i = 0; i < 2; i++) h.outbox.add(event("meet_join_attempt", 20 * 1024));
    await h.advance(FLUSH_INTERVAL_MS);
    expect(h.posts).toEqual([expect.objectContaining({ keepalive: true })]);
    const late = event("meet_join_attempt", 20 * 1024);
    h.outbox.add(late);
    h.outbox.flushForUnload();

    expect(h.beacons).toEqual([]);
    expect(h.uuidsIn(spill.peek())).toEqual([late.uuid]);
  });
});
