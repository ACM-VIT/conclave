/**
 * The browser's telemetry outbox: built events wait here and go to /ingest in
 * batches, so a call costs a handful of requests rather than one per event.
 *
 * A batch goes when the interval ends, when it holds MAX_BATCH_EVENTS, or
 * before it would pass MAX_BATCH_BYTES. An exception sends early, at most
 * once per URGENT_FLUSH_GAP_MS. When the page goes away, the queue and any
 * batch waiting to retry go by beacon, split to stay within the limit, and
 * within one budget shared by every beacon and keepalive request still
 * outstanding, as the browser counts them. What does not fit, or what the
 * browser refuses, is kept in storage, and the next page load sends it first.
 * Every event is in exactly one batch: an event is queued once by its uuid, a
 * delivered batch is never sent again, a failed one is retried with the very
 * same body, and a batch leaves the outbox only once a send of it was
 * accepted.
 */

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

export type OutboxDeps = {
  token: string;
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  /** Posts a batch body to /ingest: the response's status, or a rejection with no answer. */
  post: (body: string, keepalive: boolean) => Promise<number>;
  /** Queues a batch body by beacon; false when the browser will not take it. */
  beacon: (body: string) => boolean;
  /** Storage that outlives the page: what could not be sent as it went away. */
  spill: { save: (bodies: string[]) => void; take: () => string[] };
};

type Batch = { body: string; attempt: number; timer: unknown };

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

export function createOutbox(deps: OutboxDeps) {
  const queue: Array<{ event: OutboxEvent; bytes: number }> = [];
  let queuedBytes = 0;
  const seen = new Set<string>();
  // An interval or early send, and when it is due.
  let flushTimer: { handle: unknown; due: number } | null = null;
  let lastUrgentAt = Number.NEGATIVE_INFINITY;
  const retrying = new Set<Batch>();
  // Bytes of keepalive requests still in flight, and of recent beacons.
  let keepaliveBytes = 0;
  const beacons: Array<{ bytes: number; at: number }> = [];

  // The wrapper a batch body adds around its events.
  const overhead = byteLength(
    JSON.stringify({ api_key: deps.token, batch: [], sent_at: new Date(0).toISOString() }),
  );
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

  // Splits events into bodies within MAX_BATCH_BYTES and MAX_BATCH_EVENTS.
  const bodiesOf = (items: Array<{ event: OutboxEvent; bytes: number }>): string[] => {
    const bodies: string[] = [];
    let current: OutboxEvent[] = [];
    let bytes = overhead;
    for (const item of items) {
      const separator = current.length > 0 ? 1 : 0;
      if (current.length > 0 && (bytes + separator + item.bytes > MAX_BATCH_BYTES || current.length >= MAX_BATCH_EVENTS)) {
        bodies.push(bodyOf(current));
        current = [];
        bytes = overhead;
      }
      bytes += (current.length > 0 ? 1 : 0) + item.bytes;
      current.push(item.event);
    }
    if (current.length > 0) bodies.push(bodyOf(current));
    return bodies;
  };

  const beaconBytes = (): number => {
    while (beacons.length > 0 && deps.now() - beacons[0].at >= BEACON_OUTSTANDING_MS) beacons.shift();
    return beacons.reduce((total, beacon) => total + beacon.bytes, 0);
  };

  // A batch goes by keepalive only within the shared budget, so the page can
  // still send what it holds when it goes away.
  const send = (batch: Batch): void => {
    const bytes = byteLength(batch.body);
    const keepalive = bytes <= MAX_BATCH_BYTES && keepaliveBytes + beaconBytes() + bytes <= UNLOAD_BUDGET_BYTES;
    if (keepalive) keepaliveBytes += bytes;
    const settled = () => {
      if (keepalive) keepaliveBytes -= bytes;
    };
    deps.post(batch.body, keepalive).then(
      (status) => {
        settled();
        if (status === 429 || status >= 500) retry(batch);
      },
      () => {
        settled();
        retry(batch);
      },
    );
  };

  const retry = (batch: Batch): void => {
    const delay = RETRY_DELAYS_MS[batch.attempt];
    if (delay === undefined) return;
    batch.attempt += 1;
    retrying.add(batch);
    batch.timer = deps.setTimer(() => {
      retrying.delete(batch);
      send(batch);
    }, delay);
  };

  function flush(): void {
    cancelFlush();
    if (queue.length === 0) return;
    const items = queue.splice(0);
    queuedBytes = 0;
    for (const body of bodiesOf(items)) send({ body, attempt: 0, timer: null });
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
     * now by beacon, as far as the shared budget allows. A batch the budget
     * cannot take, or the browser refuses, is kept for the next page load. A
     * batch in flight is left to finish.
     */
    flushForUnload(): void {
      cancelFlush();
      const waiting = [...retrying];
      retrying.clear();
      for (const batch of waiting) deps.clearTimer(batch.timer);
      const items = queue.splice(0);
      queuedBytes = 0;
      let budget = UNLOAD_BUDGET_BYTES - keepaliveBytes - beaconBytes();
      const kept: string[] = [];
      for (const body of [...waiting.map((batch) => batch.body), ...bodiesOf(items)]) {
        const bytes = byteLength(body);
        if (bytes <= budget && deps.beacon(body)) {
          budget -= bytes;
          beacons.push({ bytes, at: deps.now() });
        } else {
          kept.push(body);
        }
      }
      if (kept.length > 0) deps.spill.save(kept);
    },

    /** Sends what an earlier page load kept as it went away, before anything else. */
    sendSpilled(): void {
      for (const body of deps.spill.take()) send({ body, attempt: 0, timer: null });
    },
  };
}

export type Outbox = ReturnType<typeof createOutbox>;
