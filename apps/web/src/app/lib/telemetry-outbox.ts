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
export const LOCK_RETRY_MS = 1000;
export const KEPT_ANSWER_RETRY_MS = 100;
const MAX_LOCK_RETRY_MS = 30_000;
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

export const MEMORY_ONLY_STORE: BatchStore = {
  save: () => false,
  get: () => null,
  remove: () => {},
  list: () => [],
};

type Written = "written" | "refused" | "lost";

type LockedStore = {
  write: (owned: string, next: StoredBatch) => Written;
  remove: (id: string, owned: string) => boolean;
  delay: (id: string, until: number) => boolean;
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
  post: (body: string, keepalive: boolean, signal?: AbortSignal) => Promise<Reply>;
  beacon: (body: string) => Promise<Reply | null> | null;
  newId: () => string;
  store: BatchStore;
  lock: (replay: () => Promise<void>) => Promise<void> | void;
  onStale: (dropped: readonly StoredBatch[]) => void;
  shape?: (event: OutboxEvent) => OutboxEvent | null;
};

type InFlight = { keepalive: boolean };

type KeptAnswer = { sendId: string; reply: Reply | null; at: number; leaseUntil: number; retry: boolean; apply: (current: StoredBatch, store: LockedStore) => void };

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

export type Reply = { status: number; retryAfter: string | null; rejected?: readonly number[] };

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

const withoutRefused = (kept: OutboxEvent[], sent: readonly OutboxEvent[], reply: Reply | null): OutboxEvent[] => {
  const refused = new Set((reply?.rejected ?? []).flatMap((index) => (sent[index] ? [sent[index].uuid] : [])));
  return refused.size === 0 ? kept : kept.filter((item) => !refused.has(item.uuid));
};

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
  const kept = new Map<string, KeptAnswer[]>();
  let lockRetryMs = LOCK_RETRY_MS;

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

  const create = (next: StoredBatch): Written => {
    if (deps.store.get(next.id) !== null) return "lost";
    return deps.store.save(next) ? "written" : "refused";
  };

  const locked = (run: (store: LockedStore) => void, refused: () => void = () => {}): void => {
    let ran = false;
    const requested = deps.lock(async () => {
      ran = true;
      lockRetryMs = LOCK_RETRY_MS;
      let open = true;
      const owns = (id: string, owned: string): boolean => open && deps.store.get(id)?.sendId === owned;
      try {
        run({
          write: (owned, next) => (!owns(next.id, owned) ? "lost" : deps.store.save(next) ? "written" : "refused"),
          remove: (id, owned) => {
            if (!owns(id, owned)) return false;
            deps.store.remove(id);
            return true;
          },
          delay: (id, until) => {
            const current = open ? deps.store.get(id) : null;
            if (!current) return false;
            return until <= current.notBefore || deps.store.save({ ...current, notBefore: until });
          },
        });
      } finally {
        open = false;
      }
    });
    Promise.resolve(requested).catch(() => {
      if (!ran) refused();
    });
  };

  const finish = (batch: Batch, store: LockedStore | null): void => {
    if (batch.timer !== null) deps.clearTimer(batch.timer);
    batch.timer = null;
    live.delete(batch.id);
    if (batch.saved) store?.remove(batch.id, batch.sendId);
  };

  const expire = (batch: Batch, store: LockedStore | null): void => {
    live.delete(batch.id);
    if (batch.saved && !store?.remove(batch.id, batch.sendId)) return;
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

  const retryLock = (): void => {
    const leased = [...kept.values()].flat().some((answer) => answer.leaseUntil > deps.now());
    if (leased) {
      wakeAt(deps.now() + KEPT_ANSWER_RETRY_MS);
      return;
    }
    wakeAt(deps.now() + lockRetryMs);
    lockRetryMs = Math.min(lockRetryMs * 2, MAX_LOCK_RETRY_MS);
  };

  const keepAnswer = (id: string, answer: KeptAnswer): void => {
    kept.set(id, [...(kept.get(id) ?? []), answer]);
    retryLock();
  };

  const isRetry = (reply: Reply | null): boolean => !reply || answerOf(reply.status, reply.retryAfter, deps.now()).outcome === "retry";

  const holdInMemory = (batch: Batch): void => {
    live.set(batch.id, batch);
    if (batch.timer !== null) deps.clearTimer(batch.timer);
    batch.timer = deps.setTimer(() => {
      batch.timer = null;
      send(batch, null);
    }, Math.max(dueAt(batch) - deps.now(), 0));
  };

  const saveOwn = (batch: Batch): boolean => {
    if (create(stored(batch)) !== "written") return false;
    batch.saved = true;
    if (batch.timer !== null) deps.clearTimer(batch.timer);
    batch.timer = null;
    live.delete(batch.id);
    wakeAt(dueAt(batch));
    return true;
  };

  const keepSaved = (batch: Batch, store: LockedStore): void => {
    live.delete(batch.id);
    const written = store.write(batch.sendId, stored(batch));
    if (written === "written") wakeAt(dueAt(batch));
    if (written !== "refused") return;
    store.remove(batch.id, batch.sendId);
    batch.saved = false;
    holdInMemory(batch);
  };

  const waitAsked = (reply: Reply | null, at = deps.now()): number => {
    const answer = reply ? answerOf(reply.status, reply.retryAfter, at) : null;
    return answer?.outcome === "retry" && answer.afterMs !== null ? at + answer.afterMs : 0;
  };

  const carryWait = (id: string, reply: Reply | null, store: LockedStore, at = deps.now()): void => {
    const until = waitAsked(reply, at);
    if (until > 0 && store.delay(id, until)) wakeAt(until);
  };

  const applyAnswer = (batch: Batch, events: OutboxEvent[], reply: Reply | null, store: LockedStore | null, at = deps.now()): void => {
    const answer = reply ? answerOf(reply.status, reply.retryAfter, at) : null;
    if (answer && answer.outcome !== "retry") {
      finish(batch, store);
      return;
    }
    batch.events = withoutRefused(batch.events, events, reply);
    if (batch.events.length === 0) {
      finish(batch, store);
      return;
    }
    batch.nextTry = at + retryDelay(batch.attempt);
    batch.attempt += 1;
    batch.notBefore = Math.max(batch.notBefore, waitAsked(reply, at));
    if (store) keepSaved(batch, store);
    else holdInMemory(batch);
  };

  const outgoing = (batch: Batch): OutboxEvent[] =>
    batch.events.flatMap((item) => {
      const built = deps.shape ? deps.shape(item) : item;
      return built ? [fitEvent(built)] : [];
    });

  const send = (batch: Batch, store: LockedStore | null): void => {
    if (tooOld(batch.oldestAt)) {
      expire(batch, store);
      return;
    }
    if (dueAt(batch) > deps.now()) {
      if (batch.saved) wakeAt(dueAt(batch));
      else holdInMemory(batch);
      return;
    }
    const events = outgoing(batch);
    if (events.length === 0) {
      finish(batch, store);
      return;
    }
    const body = bodyOf(events);
    const bytes = byteLength(body);
    const keepalive = bytes <= MAX_BATCH_BYTES && keepaliveBytes + beaconBytes() + bytes <= UNLOAD_BUDGET_BYTES;
    const owned = batch.sendId;
    batch.sendId = deps.newId();
    batch.leaseUntil = deps.now() + LEASE_MS;
    batch.inFlight = { keepalive };
    if (batch.saved) {
      const written = store?.write(owned, stored(batch)) ?? "lost";
      if (written === "lost") {
        live.delete(batch.id);
        return;
      }
      if (written === "refused") {
        store?.remove(batch.id, owned);
        batch.saved = false;
      }
    }
    const sendId = batch.sendId;
    live.set(batch.id, batch);
    if (keepalive) keepaliveBytes += bytes;
    const cancel = new AbortController();
    let settled = false;
    let deadline: unknown = null;
    const settle = (reply: Reply | null): void => {
      if (settled) return;
      settled = true;
      deps.clearTimer(deadline);
      if (keepalive) keepaliveBytes -= bytes;
      if (!batch.saved) {
        batch.inFlight = null;
        batch.leaseUntil = 0;
        applyAnswer(batch, events, reply, null);
        return;
      }
      locked(
        (held) => {
        batch.inFlight = null;
        batch.leaseUntil = 0;
        const current = deps.store.get(batch.id);
        if (current?.sendId !== sendId) {
          live.delete(batch.id);
          carryWait(batch.id, reply, held);
          return;
        }
        batch.notBefore = Math.max(batch.notBefore, current.notBefore);
        applyAnswer(batch, events, reply, held);
        },
        () => {
          const leaseUntil = batch.leaseUntil;
          batch.inFlight = null;
          live.delete(batch.id);
          const at = deps.now();
          keepAnswer(batch.id, {
            sendId,
            reply,
            at,
            leaseUntil,
            retry: isRetry(reply),
            apply: (current, store) => {
              const answered = fromStorage(current);
              answered.leaseUntil = 0;
              applyAnswer(answered, events, reply, store, at);
            },
          });
        },
      );
    };
    deadline = deps.setTimer(() => {
      cancel.abort();
      settle(null);
    }, SEND_DEADLINE_MS);
    deps.post(body, keepalive, cancel.signal).then(settle, () => settle(null));
  };

  const beaconAnswered = (batch: Batch, events: OutboxEvent[], reply: Reply | null, sentWith: string): void => {
    if (!reply) return;
    const at = deps.now();
    const final = answerOf(reply.status, reply.retryAfter, at).outcome !== "retry";
    const settleAnswered = (answered: Batch, store: LockedStore | null): void => {
      if (final) {
        finish(answered, store);
        return;
      }
      answered.notBefore = Math.max(answered.notBefore, waitAsked(reply, at));
      answered.events = withoutRefused(answered.events, events, reply);
      if (answered.events.length === 0) finish(answered, store);
      else if (store) keepSaved(answered, store);
      else holdInMemory(answered);
    };
    if (batch.saved) {
      locked(
        (store) => {
          const current = deps.store.get(batch.id);
          if (!current || current.sendId !== sentWith) {
            if (!final) carryWait(batch.id, reply, store);
            return;
          }
          settleAnswered(fromStorage(current), store);
        },
        () =>
          keepAnswer(batch.id, {
            sendId: sentWith,
            reply,
            at,
            leaseUntil: 0,
            retry: !final,
            apply: (current, store) => settleAnswered(fromStorage(current), store),
          }),
      );
      return;
    }
    if (live.get(batch.id) !== batch) return;
    if (!final) batch.notBefore = Math.max(batch.notBefore, waitAsked(reply, at));
    if (batch.sendId !== sentWith || batch.inFlight !== null) return;
    settleAnswered(batch, null);
  };

  const applyKept = (id: string, store: LockedStore): void => {
    const answers = kept.get(id) ?? [];
    kept.delete(id);
    for (const answer of answers) {
      const current = deps.store.get(id);
      if (!current) return;
      if (current.sendId === answer.sendId) answer.apply(current, store);
      else if (answer.retry) carryWait(id, answer.reply, store, answer.at);
    }
  };

  const replayPass = (store: LockedStore): void => {
    const stale: StoredBatch[] = [];
    const listed = deps.store.list();
    for (const id of [...kept.keys()]) {
      if (listed.some((saved) => saved.id === id)) applyKept(id, store);
      else kept.delete(id);
    }
    for (const listedCopy of listed) {
      const saved = deps.store.get(listedCopy.id);
      if (!saved) continue;
      if (live.has(saved.id)) continue;
      if (saved.leaseUntil > deps.now()) {
        wakeAt(saved.leaseUntil);
        continue;
      }
      if (tooOld(saved.oldestAt)) {
        if (store.remove(saved.id, saved.sendId)) stale.push(saved);
        continue;
      }
      if (dueAt(saved) > deps.now()) {
        wakeAt(dueAt(saved));
        continue;
      }
      send(fromStorage(saved), store);
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
    locked(
      (store) => {
        replay = "running";
        try {
          do {
            replayAgain = false;
            replayPass(store);
          } while (replayAgain);
        } finally {
          replay = "idle";
        }
      },
      () => {
        replay = "idle";
        retryLock();
      },
    );
  }

  function flush(): void {
    cancelFlush();
    if (queue.length === 0) return;
    const items = queue.splice(0);
    queuedBytes = 0;
    for (const batch of batchesOf(items)) send(batch, null);
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
          finish(batch, null);
          continue;
        }
        const body = bodyOf(events);
        const bytes = byteLength(body);
        const answer = dueAt(batch) <= deps.now() && !tooOld(batch.oldestAt) && bytes <= budget ? deps.beacon(body) : null;
        if (answer) {
          budget -= bytes;
          beacons.push({ bytes, at: deps.now() });
          batch.sent = true;
          batch.nextTry = Math.max(batch.nextTry, deps.now() + BEACON_CONFIRM_MS);
          const sentWith = batch.sendId;
          answer.then((reply) => beaconAnswered(batch, events, reply, sentWith), () => {});
        }
        if (!saveOwn(batch)) holdInMemory(batch);
      }
      for (const batch of live.values()) {
        if (batch.inFlight !== null && !batch.saved && create(stored(batch)) === "written") batch.saved = true;
      }
    },

    replaySaved,
  };
}

export type Outbox = ReturnType<typeof createOutbox>;

export const STORED_BATCH_PREFIX = "conclave:telemetry:batch:";
export const MAX_STORED_CHARS = 512 * 1024;

const StoredEvent = z.object({
  uuid: z.uuid(),
  event: z.string().min(1).max(200),
  timestamp: z.iso.datetime(),
  properties: z.record(z.string(), z.unknown()),
});

const StoredBatchSchema = z.object({
  id: z.string().min(1).max(64),
  events: z
    .array(z.unknown())
    .max(MAX_BATCH_EVENTS)
    .transform((items) => items.flatMap((item) => {
      const event = StoredEvent.safeParse(item);
      return event.success ? [event.data] : [];
    }))
    .pipe(z.array(StoredEvent).min(1)),
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
