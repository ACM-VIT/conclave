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
export const MAX_BATCH_BYTES = 48 * 1024;
export const UNLOAD_BUDGET_BYTES = 56 * 1024;
const BEACON_OUTSTANDING_MS = 10_000;
export const URGENT_FLUSH_GAP_MS = 3000;
export const RETRY_DELAYS_MS: readonly number[] = [2000, 4000, 8000, 16000, 30000];
const MAX_REMEMBERED_UUIDS = 2000;
export const MAX_SEND_AGE_MS = MAX_EVENT_AGE_MS - 60_000;
export const SEND_DEADLINE_MS = 15_000;
export const LEASE_MS = SEND_DEADLINE_MS + 1000;
export const BEACON_CONFIRM_MS = 30_000;
export const MAX_EVENT_BYTES = 32 * 1024;
const MAX_TEXT_CHARS = 1024;

export type StoredBatch = {
  id: string;
  events: OutboxEvent[];
  oldestAt: number;
  sent: boolean;
  notBefore: number;
  nextTry: number;
  attempt: number;
  sendId: string;
  leaseUntil: number;
};

export type BatchStore = {
  save: (batch: StoredBatch) => boolean;
  get: (id: string) => StoredBatch | null;
  remove: (id: string) => void;
  list: () => StoredBatch[];
};

export type DroppedBatches = { batches: number; events: number; unsent: number };

export const countDropped = (batches: readonly StoredBatch[]): DroppedBatches => ({
  batches: batches.length,
  events: batches.reduce((total, batch) => total + batch.events.length, 0),
  unsent: batches.filter((batch) => !batch.sent).length,
});

export const retryDelay = (attempt: number): number =>
  RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];

export type OutboxDeps = {
  token: string;
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  post: (body: string, keepalive: boolean, signal?: AbortSignal) => Promise<{ status: number; retryAfter: string | null }>;
  beacon: (body: string) => boolean;
  newId: () => string;
  store: BatchStore;
  lock: (replay: () => Promise<void>) => void;
  onStale: (dropped: readonly StoredBatch[]) => void;
  shape?: (event: OutboxEvent) => OutboxEvent | null;
};

type InFlight = { keepalive: boolean };

type Batch = {
  id: string;
  events: OutboxEvent[];
  oldestAt: number;
  sent: boolean;
  notBefore: number;
  nextTry: number;
  attempt: number;
  sendId: string;
  leaseUntil: number;
  saved: boolean;
  timer: unknown;
  inFlight: InFlight | null;
};

type Queued = { event: OutboxEvent; bytes: number };

type Reply = { status: number; retryAfter: string | null };

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

const dueAt = (batch: { notBefore: number; nextTry: number; leaseUntil: number }): number =>
  Math.max(batch.notBefore, batch.nextTry, batch.leaseUntil);

const sizeOf = (value: unknown): number => byteLength(JSON.stringify(value) ?? "");

const cutText = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") return value.length > MAX_TEXT_CHARS ? value.slice(0, MAX_TEXT_CHARS) : value;
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cutText(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutText(item, depth + 1)]));
};

type ExceptionEntry = { stacktrace?: { frames?: unknown[] } } & Record<string, unknown>;

export const fitEvent = (event: OutboxEvent): OutboxEvent => {
  if (sizeOf(event) <= MAX_EVENT_BYTES) return event;
  const fits = (properties: Record<string, unknown>) => sizeOf({ ...event, properties }) <= MAX_EVENT_BYTES;
  let properties: Record<string, unknown> = { ...event.properties };
  const list = properties.$exception_list;
  if (Array.isArray(list) && list.length > 0) {
    let entries = (list as ExceptionEntry[]).map((entry) => ({ ...entry }));
    while (entries.length > 1 && !fits({ ...properties, $exception_list: entries })) entries = entries.slice(0, -1);
    const longest = () => entries.reduce((best, entry, index) => ((entry.stacktrace?.frames?.length ?? 0) > (entries[best].stacktrace?.frames?.length ?? 0) ? index : best), 0);
    while (!fits({ ...properties, $exception_list: entries })) {
      const index = longest();
      const frames = entries[index].stacktrace?.frames ?? [];
      if (frames.length <= 1) break;
      entries[index] = { ...entries[index], stacktrace: { ...entries[index].stacktrace, frames: frames.slice(-Math.ceil(frames.length / 2)) } };
    }
    properties = { ...properties, $exception_list: entries };
  }
  if (!fits(properties)) properties = cutText(properties) as Record<string, unknown>;
  const essential = new Set(["token", "distinct_id", "$exception_list"]);
  while (!fits(properties)) {
    const largest = Object.keys(properties)
      .filter((key) => !essential.has(key))
      .sort((a, b) => sizeOf(properties[b]) - sizeOf(properties[a]))[0];
    if (!largest) break;
    const { [largest]: _dropped, ...rest } = properties;
    properties = rest;
  }
  if (fits(properties)) return { ...event, properties };
  return {
    uuid: event.uuid,
    event: event.event.slice(0, MAX_TEXT_CHARS),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    properties: { token: properties.token, distinct_id: properties.distinct_id },
  };
};

export function createOutbox(deps: OutboxDeps) {
  const queue: Queued[] = [];
  let queuedBytes = 0;
  const seen = new Set<string>();
  let flushTimer: { handle: unknown; due: number } | null = null;
  let lastUrgentAt = Number.NEGATIVE_INFINITY;
  const live = new Map<string, Batch>();
  let keepaliveBytes = 0;
  const beacons: Array<{ bytes: number; at: number }> = [];
  let replay: "idle" | "waiting" | "running" = "idle";
  let replayAgain = false;
  let wakeTimer: { handle: unknown; at: number } | null = null;

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
      sent: false,
      notBefore: 0,
      nextTry: 0,
      attempt: 0,
      sendId: "",
      leaseUntil: 0,
      saved: false,
      timer: null,
      inFlight: null,
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
    sent: batch.sent || batch.inFlight?.keepalive === true,
    notBefore: batch.notBefore,
    nextTry: batch.nextTry,
    attempt: batch.attempt,
    sendId: batch.sendId,
    leaseUntil: batch.leaseUntil,
  });

  const fromStorage = (saved: StoredBatch): Batch => ({
    ...saved,
    saved: true,
    timer: null,
    inFlight: null,
  });

  const tooOld = (oldestAt: number): boolean => deps.now() - oldestAt > MAX_SEND_AGE_MS;

  const finish = (batch: Batch): void => {
    live.delete(batch.id);
    if (batch.saved) deps.store.remove(batch.id);
  };

  const expire = (batch: Batch): void => {
    finish(batch);
    deps.onStale([stored(batch)]);
  };

  const wakeAt = (at: number): void => {
    if (wakeTimer && wakeTimer.at <= at) return;
    if (wakeTimer) deps.clearTimer(wakeTimer.handle);
    const handle = deps.setTimer(() => {
      wakeTimer = null;
      replaySaved();
    }, Math.max(at - deps.now(), 0));
    wakeTimer = { handle, at };
  };

  const holdInMemory = (batch: Batch): void => {
    live.set(batch.id, batch);
    if (batch.timer !== null) deps.clearTimer(batch.timer);
    batch.timer = deps.setTimer(() => {
      batch.timer = null;
      send(batch);
    }, Math.max(dueAt(batch) - deps.now(), 0));
  };

  const toStorage = (batch: Batch): boolean => {
    if (!deps.store.save(stored(batch))) return false;
    batch.saved = true;
    if (batch.timer !== null) deps.clearTimer(batch.timer);
    batch.timer = null;
    live.delete(batch.id);
    wakeAt(dueAt(batch));
    return true;
  };

  const leaveStorage = (batch: Batch): void => {
    deps.store.remove(batch.id);
    batch.saved = false;
  };

  const retry = (batch: Batch, afterMs: number | null): void => {
    batch.nextTry = deps.now() + retryDelay(batch.attempt);
    batch.attempt += 1;
    if (afterMs !== null) batch.notBefore = Math.max(batch.notBefore, deps.now() + afterMs);
    if (batch.saved) {
      live.delete(batch.id);
      if (toStorage(batch)) return;
      leaveStorage(batch);
    }
    holdInMemory(batch);
  };

  const outgoing = (batch: Batch): OutboxEvent[] =>
    batch.events.flatMap((item) => {
      const built = deps.shape ? deps.shape(item) : item;
      return built ? [fitEvent(built)] : [];
    });

  const send = (batch: Batch): void => {
    if (tooOld(batch.oldestAt)) {
      expire(batch);
      return;
    }
    if (dueAt(batch) > deps.now()) {
      if (batch.saved) wakeAt(dueAt(batch));
      else holdInMemory(batch);
      return;
    }
    const events = outgoing(batch);
    if (events.length === 0) {
      finish(batch);
      return;
    }
    batch.sendId = deps.newId();
    batch.leaseUntil = deps.now() + LEASE_MS;
    if (batch.saved && !deps.store.save(stored(batch))) leaveStorage(batch);
    const sendId = batch.sendId;
    live.set(batch.id, batch);
    const body = bodyOf(events);
    const bytes = byteLength(body);
    const keepalive = bytes <= MAX_BATCH_BYTES && keepaliveBytes + beaconBytes() + bytes <= UNLOAD_BUDGET_BYTES;
    if (keepalive) keepaliveBytes += bytes;
    batch.inFlight = { keepalive };
    const cancel = new AbortController();
    let settled = false;
    let deadline: unknown = null;
    const settle = (reply: Reply | null): void => {
      if (settled) return;
      settled = true;
      deps.clearTimer(deadline);
      if (keepalive) keepaliveBytes -= bytes;
      batch.inFlight = null;
      batch.leaseUntil = 0;
      if (batch.saved) {
        const current = deps.store.get(batch.id);
        if (current?.sendId !== sendId) {
          live.delete(batch.id);
          return;
        }
        batch.notBefore = Math.max(batch.notBefore, current.notBefore);
      }
      const answer = reply ? answerOf(reply.status, reply.retryAfter, deps.now()) : null;
      if (answer && answer.outcome !== "retry") finish(batch);
      else retry(batch, answer?.afterMs ?? null);
    };
    deadline = deps.setTimer(() => {
      cancel.abort();
      settle(null);
    }, SEND_DEADLINE_MS);
    deps.post(body, keepalive, cancel.signal).then(settle, () => settle(null));
  };

  const replayPass = (): void => {
    const stale: StoredBatch[] = [];
    for (const saved of deps.store.list()) {
      if (live.has(saved.id)) continue;
      if (saved.leaseUntil > deps.now()) {
        wakeAt(saved.leaseUntil);
        continue;
      }
      if (tooOld(saved.oldestAt)) {
        deps.store.remove(saved.id);
        stale.push(saved);
        continue;
      }
      if (dueAt(saved) > deps.now()) {
        wakeAt(dueAt(saved));
        continue;
      }
      send(fromStorage(saved));
    }
    if (stale.length > 0) deps.onStale(stale);
  };

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
          replayPass();
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
    for (const batch of batchesOf(items)) send(batch);
  }

  return {
    add(event: OutboxEvent, { urgent = false, deferred = false }: { urgent?: boolean; deferred?: boolean } = {}): void {
      if (!remember(event.uuid)) return;
      event = fitEvent(event);
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

    flushForUnload(): void {
      cancelFlush();
      const items = queue.splice(0);
      queuedBytes = 0;
      let budget = UNLOAD_BUDGET_BYTES - keepaliveBytes - beaconBytes();
      const waiting = [...live.values()].filter((batch) => batch.inFlight === null);
      for (const batch of [...waiting, ...batchesOf(items)]) {
        const events = outgoing(batch);
        if (events.length === 0) {
          finish(batch);
          continue;
        }
        const body = bodyOf(events);
        const bytes = byteLength(body);
        if (dueAt(batch) <= deps.now() && !tooOld(batch.oldestAt) && bytes <= budget && deps.beacon(body)) {
          budget -= bytes;
          beacons.push({ bytes, at: deps.now() });
          batch.sent = true;
          batch.nextTry = Math.max(batch.nextTry, deps.now() + BEACON_CONFIRM_MS);
        }
        if (!toStorage(batch)) holdInMemory(batch);
      }
      for (const batch of live.values()) {
        if (batch.inFlight !== null && deps.store.save(stored(batch))) batch.saved = true;
      }
    },

    replaySaved,
  };
}

export type Outbox = ReturnType<typeof createOutbox>;

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
  nextTry: z.number().default(0),
  attempt: z.number().int().min(0).max(1000).default(0),
  sendId: z.string().max(64).default(""),
  leaseUntil: z.number().default(0),
});

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
        const total = others.reduce((sum, entry) => sum + entry.text.length, text.length);
        if (total > MAX_STORED_CHARS) return false;
        area.setItem(key, text);
        return true;
      } catch {
        return false;
      }
    },
    get(id) {
      try {
        const key = keyOf(id);
        const text = storage().getItem(key);
        return text === null ? null : parse(key, text);
      } catch {
        return null;
      }
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
