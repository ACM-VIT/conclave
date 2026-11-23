/**
 * The browser's telemetry outbox: built events wait here and go to /ingest in
 * batches, so a call costs a handful of requests rather than one per event.
 *
 * A batch goes when the interval ends, when it holds MAX_BATCH_EVENTS, or
 * before it would pass MAX_BATCH_BYTES. An exception sends early, at most
 * once per URGENT_FLUSH_GAP_MS.
 *
 * The outbox owns every batch until /ingest answers a send of it: a batch is
 * queued, in flight or waiting to retry. When the page goes away, the queue
 * and every batch waiting to retry go by beacon, within one budget shared by
 * every beacon and keepalive request still outstanding, as the browser counts
 * them, and every batch not yet answered, in flight or not, is saved in
 * storage, one entry per batch. A saved copy is removed only once a send of it
 * is answered; a later page load, or this one when it comes back, sends what
 * storage holds. A beacon is never answered, so its batch is sent again then,
 * and /ingest takes each uuid once. A batch too old for /ingest to date by its
 * own clock is dropped, never sent, and counted.
 */

import { z } from "zod";
import { answerOf } from "./telemetry-answers";
import { MAX_EVENT_AGE_MS } from "./telemetry-schema";

export type OutboxEvent = {
  uuid: string;
  event: string;
  timestamp?: string;
  properties: Record<string, unknown>;
};

export const FLUSH_INTERVAL_MS = 5000;
export const MAX_BATCH_EVENTS = 20;
// The browser allows 64 KB across all outstanding beacons and keepalive
// requests of a page; batches and that shared budget stay under it.
export const MAX_BATCH_BYTES = 48 * 1024;
export const UNLOAD_BUDGET_BYTES = 56 * 1024;
// How long a beacon is counted as outstanding: it cannot be observed to end.
const BEACON_OUTSTANDING_MS = 10_000;
export const URGENT_FLUSH_GAP_MS = 3000;
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];
const MAX_REMEMBERED_UUIDS = 2000;
// /ingest keeps an event's own time only within MAX_EVENT_AGE_MS of receiving
// it. A batch older than this, a minute short of that for the request and a
// clock a little off, is dropped rather than sent to be dated wrong.
export const MAX_SEND_AGE_MS = MAX_EVENT_AGE_MS - 60_000;
// The longest a replay holds the tabs' lock waiting for its sends' first
// answers, so a send that never answers holds up no other tab.
export const REPLAY_HOLD_MS = 10_000;

/** A batch as storage keeps it for a later page load. */
export type StoredBatch = {
  id: string;
  events: OutboxEvent[];
  /** When its oldest event happened, by this browser's clock. */
  oldestAt: number;
  /**
   * A send of it may have arrived without an answer: it went by beacon, or by
   * a keepalive request still in flight when it was saved.
   */
  sent: boolean;
  /** No send before this time, by this browser's clock: a Retry-After /ingest gave. */
  notBefore: number;
};

/** Storage the site's tabs share, one entry per batch. */
export type BatchStore = {
  save: (batch: StoredBatch) => void;
  remove: (id: string) => void;
  list: () => StoredBatch[];
};

/** Batches dropped as too old to send: `unsent` of them had no send that may have arrived. */
export type DroppedBatches = { batches: number; events: number; unsent: number };

export type OutboxDeps = {
  token: string;
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  /**
   * Posts a batch body to /ingest: the response's status and Retry-After
   * header, or a rejection with no answer.
   */
  post: (body: string, keepalive: boolean) => Promise<{ status: number; retryAfter: string | null }>;
  /** Queues a batch body by beacon; false when the browser will not take it. */
  beacon: (body: string) => boolean;
  /** A new batch's id, a uuid. */
  newId: () => string;
  store: BatchStore;
  /** Runs `replay` holding a lock the site's tabs share, once it is this tab's turn. */
  lock: (replay: () => Promise<void>) => void;
  onStale: (dropped: DroppedBatches) => void;
};

type Batch = {
  id: string;
  events: OutboxEvent[];
  oldestAt: number;
  attempt: number;
  timer: unknown;
  // How a request for it is in flight, if one is.
  inFlight: "keepalive" | "fetch" | null;
  // A beacon of it was taken, which no answer confirms.
  beaconed: boolean;
  // No send before this time: the Retry-After of its last answer.
  notBefore: number;
};

type Queued = { event: OutboxEvent; bytes: number };

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

export function createOutbox(deps: OutboxDeps) {
  const queue: Queued[] = [];
  let queuedBytes = 0;
  const seen = new Set<string>();
  // An interval or early send, and when it is due.
  let flushTimer: { handle: unknown; due: number } | null = null;
  let lastUrgentAt = Number.NEGATIVE_INFINITY;
  // Every batch this page holds until /ingest answers it.
  const live = new Map<string, Batch>();
  // Bytes of keepalive requests still in flight, and of recent beacons.
  let keepaliveBytes = 0;
  const beacons: Array<{ bytes: number; at: number }> = [];
  // A replay waiting for the lock reads storage once it has it, so one
  // waiting covers every later ask; an ask while one runs adds one more pass.
  let replay: "idle" | "waiting" | "running" = "idle";
  let replayAgain = false;

  // The wrapper a batch body adds around its events.
  const overhead = byteLength(
    JSON.stringify({ api_key: deps.token, batch: [], sent_at: new Date(0).toISOString() }),
  );
  // Stamped with the time of each send, so /ingest can tell an event's age
  // by the browser's own clock.
  const bodyOf = (events: OutboxEvent[]): string =>
    JSON.stringify({ api_key: deps.token, batch: events, sent_at: new Date(deps.now()).toISOString() });

  const remember = (uuid: string): boolean => {
    if (seen.has(uuid)) return false;
    if (seen.size >= MAX_REMEMBERED_UUIDS) seen.delete(seen.values().next().value as string);
    seen.add(uuid);
    return true;
  };

  const cancelFlush = (): void => {
    if (flushTimer) deps.clearTimer(flushTimer.handle);
    flushTimer = null;
  };

  const scheduleFlush = (ms: number): void => {
    const due = deps.now() + ms;
    if (flushTimer && flushTimer.due <= due) return;
    cancelFlush();
    flushTimer = { handle: deps.setTimer(flush, ms), due };
  };

  // Splits queued events into batches within MAX_BATCH_BYTES and MAX_BATCH_EVENTS.
  const batchesOf = (items: Queued[]): Batch[] => {
    const groups: OutboxEvent[][] = [];
    let current: OutboxEvent[] = [];
    let bytes = overhead;
    for (const item of items) {
      const separator = current.length > 0 ? 1 : 0;
      if (current.length > 0 && (bytes + separator + item.bytes > MAX_BATCH_BYTES || current.length >= MAX_BATCH_EVENTS)) {
        groups.push(current);
        current = [];
        bytes = overhead;
      }
      bytes += (current.length > 0 ? 1 : 0) + item.bytes;
      current.push(item.event);
    }
    if (current.length > 0) groups.push(current);
    return groups.map((events) => ({
      id: deps.newId(),
      events,
      oldestAt: events.reduce((oldest, event) => {
        const at = Date.parse(event.timestamp ?? "");
        return Number.isNaN(at) ? oldest : Math.min(oldest, at);
      }, deps.now()),
      attempt: 0,
      timer: null,
      inFlight: null,
      beaconed: false,
      notBefore: 0,
    }));
  };

  const beaconBytes = (): number => {
    while (beacons.length > 0 && deps.now() - beacons[0].at >= BEACON_OUTSTANDING_MS) beacons.shift();
    return beacons.reduce((total, beacon) => total + beacon.bytes, 0);
  };

  const stored = (batch: Batch): StoredBatch => ({
    id: batch.id,
    events: batch.events,
    oldestAt: batch.oldestAt,
    sent: batch.beaconed || batch.inFlight === "keepalive",
    notBefore: batch.notBefore,
  });

  const tooOld = (oldestAt: number): boolean => deps.now() - oldestAt > MAX_SEND_AGE_MS;

  const counted = (batches: StoredBatch[]): DroppedBatches => ({
    batches: batches.length,
    events: batches.reduce((total, batch) => total + batch.events.length, 0),
    unsent: batches.filter((batch) => !batch.sent).length,
  });

  // Answered, or dropped: the outbox and storage let it go.
  const release = (batch: Batch): void => {
    live.delete(batch.id);
    deps.store.remove(batch.id);
  };

  // A batch goes by keepalive only within the shared budget, so the page can
  // still send what it holds when it goes away. Resolves on the first answer.
  const send = (batch: Batch): Promise<void> => {
    if (tooOld(batch.oldestAt)) {
      release(batch);
      deps.onStale(counted([stored(batch)]));
      return Promise.resolve();
    }
    live.set(batch.id, batch);
    const body = bodyOf(batch.events);
    const bytes = byteLength(body);
    const keepalive = bytes <= MAX_BATCH_BYTES && keepaliveBytes + beaconBytes() + bytes <= UNLOAD_BUDGET_BYTES;
    if (keepalive) keepaliveBytes += bytes;
    batch.inFlight = keepalive ? "keepalive" : "fetch";
    const answered = (reply: { status: number; retryAfter: string | null } | null): void => {
      if (keepalive) keepaliveBytes -= bytes;
      batch.inFlight = null;
      const answer = reply ? answerOf(reply.status, reply.retryAfter, deps.now()) : null;
      if (answer && answer.outcome !== "retry") release(batch);
      else retry(batch, answer?.afterMs ?? null);
    };
    return deps.post(body, keepalive).then(answered, () => answered(null));
  };

  // After the next delay of the schedule, or the Retry-After /ingest asked
  // for when that is longer.
  const retry = (batch: Batch, afterMs: number | null): void => {
    const delay = RETRY_DELAYS_MS[batch.attempt];
    batch.attempt += 1;
    batch.notBefore = afterMs === null ? 0 : deps.now() + Math.max(delay ?? 0, afterMs);
    if (delay === undefined) {
      // This page has given up on it: storage keeps it for the next replay.
      live.delete(batch.id);
      deps.store.save(stored(batch));
      return;
    }
    if (afterMs === null) {
      sendLater(batch, delay);
      return;
    }
    // /ingest asked it to wait: storage takes it, with the time it may go,
    // and its next send is a locked replay then, which reads storage again,
    // so no tab sends it sooner, or after another tab has.
    live.delete(batch.id);
    deps.store.save(stored(batch));
    replayAt(batch.notBefore);
  };

  // Held as a batch waiting to send, so the page going away saves it.
  const sendLater = (batch: Batch, ms: number): void => {
    live.set(batch.id, batch);
    batch.timer = deps.setTimer(() => {
      batch.timer = null;
      void send(batch);
    }, ms);
  };

  // One timer, for the earliest saved batch /ingest asked to wait for.
  let waitTimer: { handle: unknown; at: number } | null = null;
  const replayAt = (at: number): void => {
    if (waitTimer && waitTimer.at <= at) return;
    if (waitTimer) deps.clearTimer(waitTimer.handle);
    const handle = deps.setTimer(() => {
      waitTimer = null;
      replaySaved();
    }, Math.max(at - deps.now(), 0));
    waitTimer = { handle, at };
  };

  // One pass over storage: sends each batch in it, from any tab, that this
  // page is not already sending, and drops the ones too old to send.
  const replayPass = async (): Promise<void> => {
    const stale: StoredBatch[] = [];
    const sends: Array<Promise<void>> = [];
    for (const saved of deps.store.list()) {
      if (live.has(saved.id)) continue;
      if (tooOld(saved.oldestAt)) {
        deps.store.remove(saved.id);
        stale.push(saved);
        continue;
      }
      const batch: Batch = {
        id: saved.id,
        events: saved.events,
        oldestAt: saved.oldestAt,
        attempt: 0,
        timer: null,
        inFlight: null,
        beaconed: saved.sent,
        notBefore: saved.notBefore,
      };
      if (saved.notBefore > deps.now()) replayAt(saved.notBefore);
      else sends.push(send(batch));
    }
    if (stale.length > 0) deps.onStale(counted(stale));
    if (sends.length === 0) return;
    let timer: unknown = null;
    await Promise.race([
      Promise.all(sends),
      new Promise<void>((resolve) => (timer = deps.setTimer(resolve, REPLAY_HOLD_MS))),
    ]);
    deps.clearTimer(timer);
  };

  /**
   * Sends what storage holds, from any tab, holding the replay lock until
   * each send has its first answer, or REPLAY_HOLD_MS; a batch this page is
   * still sending is left to that send. A batch too old to send is dropped,
   * and the drops of one pass are counted together. An ask while a pass
   * runs, such as a page coming back as one waits for its answers, gets a
   * pass of its own after it, so nothing saved meanwhile waits for the
   * next page load. A batch /ingest asked to wait for is left in storage,
   * and a locked replay reads storage again when its time comes.
   */
  function replaySaved(): void {
    if (replay === "waiting") return;
    if (replay === "running") {
      replayAgain = true;
      return;
    }
    replay = "waiting";
    deps.lock(async () => {
      replay = "running";
      try {
        do {
          replayAgain = false;
          await replayPass();
        } while (replayAgain);
      } finally {
        replay = "idle";
      }
    });
  }

  function flush(): void {
    cancelFlush();
    if (queue.length === 0) return;
    const items = queue.splice(0);
    queuedBytes = 0;
    for (const batch of batchesOf(items)) void send(batch);
  }

  return {
    /**
     * Queues a built event; `urgent` (an exception) asks for an early send,
     * and `deferred` (a page going away, whose flushForUnload follows) asks
     * for none at all.
     */
    add(event: OutboxEvent, { urgent = false, deferred = false }: { urgent?: boolean; deferred?: boolean } = {}): void {
      if (!remember(event.uuid)) return;
      const bytes = byteLength(JSON.stringify(event));
      if (deferred) {
        queue.push({ event, bytes });
        queuedBytes += bytes;
        return;
      }
      if (queue.length > 0 && overhead + queuedBytes + queue.length + bytes > MAX_BATCH_BYTES) flush();
      queue.push({ event, bytes });
      queuedBytes += bytes;
      if (queue.length >= MAX_BATCH_EVENTS || overhead + queuedBytes + queue.length > MAX_BATCH_BYTES) {
        flush();
      } else if (urgent) {
        const since = deps.now() - lastUrgentAt;
        if (since >= URGENT_FLUSH_GAP_MS) {
          lastUrgentAt = deps.now();
          flush();
        } else {
          scheduleFlush(URGENT_FLUSH_GAP_MS - since);
        }
      } else {
        scheduleFlush(FLUSH_INTERVAL_MS);
      }
    },

    /**
     * The page is going away: the queue and every batch waiting to retry go
     * now by beacon, as far as the shared budget allows, and storage takes
     * them over. A batch in flight is saved too, and stays until its answer.
     */
    flushForUnload(): void {
      cancelFlush();
      const items = queue.splice(0);
      queuedBytes = 0;
      const held = [...live.values()];
      let budget = UNLOAD_BUDGET_BYTES - keepaliveBytes - beaconBytes();
      for (const batch of [...held.filter((each) => each.inFlight === null), ...batchesOf(items)]) {
        if (batch.timer !== null) deps.clearTimer(batch.timer);
        live.delete(batch.id);
        const body = bodyOf(batch.events);
        const bytes = byteLength(body);
        const due = batch.notBefore <= deps.now();
        if (due && !tooOld(batch.oldestAt) && bytes <= budget && deps.beacon(body)) {
          budget -= bytes;
          beacons.push({ bytes, at: deps.now() });
          batch.beaconed = true;
        }
        deps.store.save(stored(batch));
      }
      for (const batch of held) if (batch.inFlight !== null) deps.store.save(stored(batch));
    },

    replaySaved,
  };
}

export type Outbox = ReturnType<typeof createOutbox>;

// Saved batches the tabs of a site keep together, at most: the oldest go first.
export const STORED_BATCH_PREFIX = "conclave:telemetry:batch:";
export const MAX_STORED_CHARS = 512 * 1024;

const StoredBatchSchema = z.object({
  id: z.string().min(1).max(64),
  events: z
    .array(
      z.object({
        uuid: z.string(),
        event: z.string(),
        timestamp: z.string().optional(),
        properties: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(MAX_BATCH_EVENTS),
  oldestAt: z.number(),
  sent: z.boolean(),
  notBefore: z.number().default(0),
});

/**
 * Saved batches in web storage, each under its own key (the prefix and the
 * batch's id), so tabs saving or removing at once never write over each
 * other's entries. An entry that does not parse is removed.
 */
export function createBatchStore(storage: () => Storage): BatchStore {
  const keyOf = (id: string) => `${STORED_BATCH_PREFIX}${id}`;
  const entries = (area: Storage): Array<{ key: string; text: string }> => {
    const found: Array<{ key: string; text: string }> = [];
    for (let index = 0; index < area.length; index++) {
      const key = area.key(index);
      const text = key?.startsWith(STORED_BATCH_PREFIX) ? area.getItem(key) : null;
      if (key && text !== null) found.push({ key, text });
    }
    return found;
  };
  const parse = (key: string, text: string): StoredBatch | null => {
    try {
      const parsed = StoredBatchSchema.safeParse(JSON.parse(text));
      return parsed.success && keyOf(parsed.data.id) === key ? parsed.data : null;
    } catch {
      return null;
    }
  };
  return {
    save(batch) {
      try {
        const area = storage();
        const key = keyOf(batch.id);
        const text = JSON.stringify(batch);
        const others = entries(area).filter((entry) => entry.key !== key);
        let total = others.reduce((sum, entry) => sum + entry.text.length, text.length);
        if (total > MAX_STORED_CHARS) {
          const oldestFirst = others
            .map((entry) => ({ ...entry, oldestAt: parse(entry.key, entry.text)?.oldestAt ?? Number.NEGATIVE_INFINITY }))
            .sort((a, b) => a.oldestAt - b.oldestAt);
          for (const entry of oldestFirst) {
            if (total <= MAX_STORED_CHARS) break;
            area.removeItem(entry.key);
            total -= entry.text.length;
          }
        }
        area.setItem(key, text);
      } catch {}
    },
    remove(id) {
      try {
        storage().removeItem(keyOf(id));
      } catch {}
    },
    list() {
      try {
        const area = storage();
        return entries(area).flatMap(({ key, text }) => {
          const batch = parse(key, text);
          if (!batch) area.removeItem(key);
          return batch ? [batch] : [];
        });
      } catch {
        return [];
      }
    },
  };
}
