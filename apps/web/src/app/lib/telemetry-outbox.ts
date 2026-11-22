/**
 * The browser's telemetry outbox: built events wait here and go to /ingest in
 * batches, so a call costs a handful of requests rather than one per event.
 *
 * A batch goes when the interval ends, when it holds MAX_BATCH_EVENTS, or
 * before it would pass MAX_BATCH_BYTES. An exception sends early, at most
 * once per URGENT_FLUSH_GAP_MS. When the page goes away, the queue and any
 * batch waiting to retry go by beacon, split to stay within the limit. Every
 * event is in exactly one batch: an event is queued once by its uuid, a
 * delivered batch is never sent again, and a failed one is retried with the
 * very same body.
 */

export type OutboxEvent = {
  uuid: string;
  event: string;
  timestamp?: string;
  properties: Record<string, unknown>;
};

export const FLUSH_INTERVAL_MS = 5000;
export const MAX_BATCH_EVENTS = 20;
// Under the browser's 64 KB budget for beacons and keepalive requests.
export const MAX_BATCH_BYTES = 48 * 1024;
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

  const send = (batch: Batch): void => {
    deps.post(batch.body, byteLength(batch.body) <= MAX_BATCH_BYTES).then(
      (status) => {
        if (status === 429 || status >= 500) retry(batch);
      },
      () => retry(batch),
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
    /** Queues a built event; `urgent` (an exception) asks for an early send. */
    add(event: OutboxEvent, { urgent = false }: { urgent?: boolean } = {}): void {
      if (!remember(event.uuid)) return;
      const bytes = byteLength(JSON.stringify(event));
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
     * now by beacon, or by keepalive fetch where the browser refuses a
     * beacon. A batch in flight is left to finish.
     */
    flushForUnload(): void {
      cancelFlush();
      const waiting = [...retrying];
      retrying.clear();
      for (const batch of waiting) deps.clearTimer(batch.timer);
      const items = queue.splice(0);
      queuedBytes = 0;
      for (const body of [...waiting.map((batch) => batch.body), ...bodiesOf(items)]) {
        if (!deps.beacon(body)) void deps.post(body, true).catch(() => {});
      }
    },
  };
}

export type Outbox = ReturnType<typeof createOutbox>;
