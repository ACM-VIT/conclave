import { Worker } from "node:worker_threads";
import { Logger } from "../../../utilities/loggers.js";
import type { FromWorker, Operation, ToWorker } from "./engine.js";

export const MAX_APP_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_APP_UPDATE_BYTES = 256 * 1024;

export type Refusal =
  | "too-large"
  | "invalid"
  | "missing-dependency"
  | "timed-out"
  | "crashed"
  | "queue-full"
  | "closed"
  | "unavailable";

export type Refused = { ok: false; reason: Refusal };
export type ApplyResult = { ok: true } | Refused;
export type SyncResult = { ok: true; update: Uint8Array; stateVector: Uint8Array } | Refused;

export type AppDocument = {
  apply: (update: Uint8Array) => Promise<ApplyResult>;
  sync: (stateVector: Uint8Array) => Promise<SyncResult>;
  close: () => void;
};

export type AppDocumentPool = {
  open: () => AppDocument;
  close: () => Promise<void>;
};

type Bound = { jobs: number; bytes: number };
export type QueueLimits = { document: Bound; total: Bound };

export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
  document: { jobs: 256, bytes: 8 * 1024 * 1024 },
  total: { jobs: 4096, bytes: 64 * 1024 * 1024 },
};

export type Clock = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const systemClock: Clock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout | undefined),
};

export type AppDocumentPoolOptions = {
  workers: number;
  deadlineMs: number;
  maxDocumentBytes: number;
  maxUpdateBytes?: number;
  heap?: { oldMb: number; youngMb: number };
  residentBytes?: number;
  limits?: QueueLimits;
  workerUrl?: URL;
  workerData?: Record<string, unknown>;
  clock?: Clock;
};

type Job = { bytes: number } & (
  | { kind: "apply"; update: Uint8Array; settle: (result: ApplyResult) => void }
  | { kind: "sync"; stateVector: Uint8Array; settle: (result: SyncResult) => void }
);

type Entry = {
  id: number;
  slot: Slot;
  base: Uint8Array | null;
  tail: Uint8Array[];
  waiting: Job[];
  queued: Bound;
  loadedIn: number;
  loadFailures: number;
  committedBytes: number;
  status: "open" | "broken" | "closed";
  ready: boolean;
};

type Run = {
  entry: Entry;
  jobs: Job[];
  next: number;
  loading: boolean;
  timer?: unknown;
};

type Slot = {
  worker: Worker | null;
  booted: boolean;
  bootTimer?: unknown;
  generation: number;
  documents: number;
  ready: Entry[];
  resident: Set<Entry>;
  run: Run | null;
};

const JOBS_PER_RUN = 64;
const LOAD_DEADLINE_FACTOR = 4;
const LOAD_ATTEMPTS = 3;
const BOOT_DEADLINE_MS = 10_000;
const HEAP_OVERHEAD_MB = 64;
const HEAP_PER_RESIDENT_BYTE = 16;
export const RESIDENT_OVERHEAD_BYTES = 64 * 1024;
const MIB = 1024 * 1024;

const residentCost = (entry: Entry): number => entry.committedBytes + RESIDENT_OVERHEAD_BYTES;

const operationOf = (job: Job): Operation =>
  job.kind === "apply"
    ? { kind: "apply", update: job.update }
    : { kind: "sync", stateVector: job.stateVector };

export const createAppDocumentPool = ({
  workers,
  deadlineMs,
  maxDocumentBytes,
  maxUpdateBytes = MAX_APP_UPDATE_BYTES,
  heap,
  residentBytes = heap === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(2 * maxDocumentBytes, ((heap.oldMb - HEAP_OVERHEAD_MB) * MIB) / HEAP_PER_RESIDENT_BYTE),
  limits = DEFAULT_QUEUE_LIMITS,
  workerUrl = new URL("./worker.ts", import.meta.url),
  workerData = {},
  clock = systemClock,
}: AppDocumentPoolOptions): AppDocumentPool => {
  const loadDeadlineMs = deadlineMs * LOAD_DEADLINE_FACTOR;
  const slots: Slot[] = Array.from({ length: workers }, () => ({
    worker: null,
    booted: false,
    generation: 0,
    documents: 0,
    ready: [],
    resident: new Set(),
    run: null,
  }));
  const entries = new Set<Entry>();
  const terminating = new Set<Promise<number>>();
  const total: Bound = { jobs: 0, bytes: 0 };
  let nextId = 1;
  let closed = false;
  let closing: Promise<void> | null = null;

  const refuse = (job: Job, reason: Refusal): void => job.settle({ ok: false, reason });

  const release = (entry: Entry, job: Job): void => {
    entry.queued.jobs -= 1;
    entry.queued.bytes -= job.bytes;
    total.jobs -= 1;
    total.bytes -= job.bytes;
  };

  const drop = (entry: Entry, jobs: Job[], reason: Refusal): void => {
    for (const job of jobs) {
      release(entry, job);
      refuse(job, reason);
    }
  };

  const refusalFor = (entry: Entry, reason: Refusal): Refusal => {
    if (entry.status === "closed") return "closed";
    if (entry.status === "broken") return "unavailable";
    return reason;
  };

  const requeue = (entry: Entry, jobs: Job[]): void => {
    if (entry.status === "open") entry.waiting.unshift(...jobs);
    else drop(entry, jobs, refusalFor(entry, "closed"));
  };

  const markReady = (entry: Entry): void => {
    if (entry.ready || entry.status !== "open" || entry.waiting.length === 0) return;
    if (entry.slot.run?.entry === entry) return;
    entry.ready = true;
    entry.slot.ready.push(entry);
  };

  const arm = (slot: Slot, run: Run, ms: number): void => {
    clock.clearTimeout(run.timer);
    run.timer = clock.setTimeout(() => fail(slot, "timed-out"), ms);
  };

  const startClock = (slot: Slot, run: Run): void =>
    arm(slot, run, run.loading ? loadDeadlineMs : deadlineMs);

  const putAside = (slot: Slot, entry: Entry): void => {
    slot.resident.delete(entry);
    entry.loadedIn = -1;
    slot.worker?.postMessage({ type: "drop", document: entry.id } satisfies ToWorker);
  };

  const fit = (slot: Slot, keep: Entry): void => {
    let used = 0;
    for (const entry of slot.resident) used += residentCost(entry);
    for (const other of slot.resident) {
      if (used <= residentBytes) return;
      if (other === keep) continue;
      putAside(slot, other);
      used -= residentCost(other);
    }
  };

  const finish = (slot: Slot, run: Run): void => {
    clock.clearTimeout(run.timer);
    slot.run = null;
    fit(slot, run.entry);
    if (slot.resident.has(run.entry) && residentCost(run.entry) > residentBytes) putAside(slot, run.entry);
    markReady(run.entry);
    pump(slot);
  };

  const retire = (slot: Slot): void => {
    const { worker } = slot;
    slot.worker = null;
    slot.booted = false;
    clock.clearTimeout(slot.bootTimer);
    slot.generation += 1;
    slot.resident.clear();
    if (!worker) return;
    const stopped = worker.terminate();
    terminating.add(stopped);
    void stopped.finally(() => terminating.delete(stopped));
  };

  const settle = (entry: Entry, job: Job, reply: FromWorker): void => {
    if (entry.status !== "open") {
      refuse(job, refusalFor(entry, "closed"));
      return;
    }
    if (reply.type === "refused") {
      refuse(job, reply.reason);
      return;
    }
    if (job.kind === "apply" && reply.type === "applied") {
      if (reply.compacted) {
        entry.base = reply.compacted;
        entry.tail = [];
        entry.committedBytes = reply.compacted.length;
      } else {
        entry.tail.push(job.update);
        entry.committedBytes += job.update.length;
      }
      job.settle({ ok: true });
      return;
    }
    if (job.kind === "sync" && reply.type === "synced") {
      job.settle({ ok: true, update: reply.update, stateVector: reply.stateVector });
      return;
    }
    Logger.error(`[Apps] App document worker answered ${job.kind} with ${reply.type}`);
    refuse(job, "crashed");
  };

  const receive = (slot: Slot, reply: FromWorker): void => {
    if (reply.type === "ready") {
      slot.booted = true;
      clock.clearTimeout(slot.bootTimer);
      if (slot.run) startClock(slot, slot.run);
      return;
    }
    const run = slot.run;
    if (!run) return;
    const { entry } = run;
    if (reply.type === "yielded") {
      requeue(entry, run.jobs.slice(run.next));
      finish(slot, run);
      return;
    }
    if (reply.elapsedMs > (run.loading ? loadDeadlineMs : deadlineMs)) {
      fail(slot, "timed-out");
      return;
    }
    if (reply.type === "loaded") {
      run.loading = false;
      entry.loadFailures = 0;
      arm(slot, run, deadlineMs);
      return;
    }
    const job = run.jobs[run.next];
    run.next += 1;
    release(entry, job);
    settle(entry, job, reply);
    if (reply.type === "refused" && reply.evicted) {
      entry.loadedIn = -1;
      slot.resident.delete(entry);
      requeue(entry, run.jobs.slice(run.next));
      finish(slot, run);
      return;
    }
    if (run.next === run.jobs.length) {
      finish(slot, run);
      return;
    }
    arm(slot, run, deadlineMs);
  };

  const failRun = (run: Run, booted: boolean, reason: "timed-out" | "crashed"): void => {
    clock.clearTimeout(run.timer);
    const { entry } = run;
    const remaining = run.jobs.slice(run.next);
    if (!booted) {
      Logger.error("[Apps] App document worker did not start");
      drop(entry, remaining, refusalFor(entry, "crashed"));
    } else if (run.loading) {
      entry.loadFailures += 1;
      if (entry.status === "open" && entry.loadFailures >= LOAD_ATTEMPTS) {
        Logger.error(
          `[Apps] App document ${entry.id} could not be rebuilt in ${LOAD_ATTEMPTS} attempts; refusing it until the app is reopened`,
        );
        entry.status = "broken";
        drop(entry, [...remaining, ...entry.waiting], "unavailable");
        entry.waiting = [];
      } else {
        requeue(entry, remaining);
      }
    } else {
      drop(entry, remaining.slice(0, 1), refusalFor(entry, reason));
      requeue(entry, remaining.slice(1));
    }
    markReady(entry);
  };

  const fail = (slot: Slot, reason: "timed-out" | "crashed"): void => {
    const { booted, run } = slot;
    retire(slot);
    slot.run = null;
    if (run) failRun(run, booted, reason);
    if (closed) return;
    if (!booted) {
      setImmediate(() => pump(slot));
      return;
    }
    if (slot.documents > 0) start(slot);
    pump(slot);
  };

  const start = (slot: Slot): Worker | null => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, {
        workerData: { ...workerData, maxDocumentBytes, maxUpdateBytes },
        resourceLimits:
          heap === undefined
            ? undefined
            : { maxOldGenerationSizeMb: heap.oldMb, maxYoungGenerationSizeMb: heap.youngMb },
      });
    } catch (error) {
      Logger.error("[Apps] Could not start an app document worker", error);
      return null;
    }
    worker.on("message", (reply: FromWorker) => {
      if (slot.worker === worker) receive(slot, reply);
    });
    worker.on("error", (error) => {
      if (slot.worker !== worker) return;
      Logger.error("[Apps] App document worker failed", error);
      fail(slot, "crashed");
    });
    worker.on("exit", () => {
      if (slot.worker === worker) fail(slot, "crashed");
    });
    worker.unref();
    slot.worker = worker;
    slot.bootTimer = clock.setTimeout(() => {
      if (slot.worker === worker) fail(slot, "crashed");
    }, BOOT_DEADLINE_MS);
    return worker;
  };

  const pump = (slot: Slot): void => {
    if (closed || slot.run) return;
    const entry = slot.ready.shift();
    if (!entry) return;
    entry.ready = false;
    const jobs = entry.waiting.splice(0, JOBS_PER_RUN);
    const cold = entry.loadedIn !== slot.generation;
    const message: ToWorker = {
      type: "run",
      document: entry.id,
      load: cold ? { base: entry.base, tail: entry.tail } : null,
      operations: jobs.map(operationOf),
    };
    const run: Run = { entry, jobs, next: 0, loading: cold };
    slot.run = run;
    const worker = slot.worker ?? start(slot);
    if (!worker) {
      fail(slot, "crashed");
      return;
    }
    entry.loadedIn = slot.generation;
    slot.resident.delete(entry);
    slot.resident.add(entry);
    fit(slot, entry);
    if (slot.booted) startClock(slot, run);
    try {
      worker.postMessage(message);
    } catch (error) {
      Logger.error("[Apps] Could not send work to an app document worker", error);
      fail(slot, "crashed");
    }
  };

  const admit = (entry: Entry, bytes: number): Refusal | null => {
    if (closed || entry.status === "closed") return "closed";
    if (entry.status === "broken") return "unavailable";
    if (
      entry.queued.jobs + 1 > limits.document.jobs ||
      entry.queued.bytes + bytes > limits.document.bytes ||
      total.jobs + 1 > limits.total.jobs ||
      total.bytes + bytes > limits.total.bytes
    ) {
      return "queue-full";
    }
    return null;
  };

  const enqueue = (entry: Entry, job: Job): void => {
    entry.queued.jobs += 1;
    entry.queued.bytes += job.bytes;
    total.jobs += 1;
    total.bytes += job.bytes;
    entry.waiting.push(job);
    markReady(entry);
    pump(entry.slot);
  };

  const forget = (entry: Entry): void => {
    entry.status = "closed";
    entries.delete(entry);
    entry.slot.documents -= 1;
    entry.slot.resident.delete(entry);
    entry.ready = false;
    drop(entry, entry.waiting, "closed");
    entry.waiting = [];
    entry.base = null;
    entry.tail = [];
  };

  const closeEntry = (entry: Entry): void => {
    if (entry.status === "closed") return;
    const { slot } = entry;
    const loaded = entry.loadedIn === slot.generation;
    if (entry.ready) slot.ready.splice(slot.ready.indexOf(entry), 1);
    forget(entry);
    if (loaded) slot.worker?.postMessage({ type: "drop", document: entry.id } satisfies ToWorker);
  };

  const open = (): AppDocument => {
    const slot = slots.reduce((least, candidate) =>
      candidate.documents < least.documents ? candidate : least,
    );
    const entry: Entry = {
      id: nextId++,
      slot,
      base: null,
      tail: [],
      waiting: [],
      queued: { jobs: 0, bytes: 0 },
      loadedIn: -1,
      loadFailures: 0,
      committedBytes: 0,
      status: closed ? "closed" : "open",
      ready: false,
    };
    if (!closed) {
      entries.add(entry);
      slot.documents += 1;
      if (!slot.worker) start(slot);
    }
    return {
      apply: (update) =>
        new Promise((settle) => {
          const refusal = admit(entry, update.length);
          if (refusal) settle({ ok: false, reason: refusal });
          else enqueue(entry, { kind: "apply", update: new Uint8Array(update), bytes: update.length, settle });
        }),
      sync: (stateVector) =>
        new Promise((settle) => {
          const refusal = admit(entry, stateVector.length);
          if (refusal) settle({ ok: false, reason: refusal });
          else enqueue(entry, { kind: "sync", stateVector: new Uint8Array(stateVector), bytes: stateVector.length, settle });
        }),
      close: () => closeEntry(entry),
    };
  };

  const shutDown = async (): Promise<void> => {
    closed = true;
    for (const slot of slots) {
      const { run } = slot;
      slot.run = null;
      if (run) {
        clock.clearTimeout(run.timer);
        drop(run.entry, run.jobs.slice(run.next), "closed");
      }
      slot.ready = [];
      retire(slot);
    }
    for (const entry of entries) forget(entry);
    await Promise.all(terminating);
  };

  return { open, close: () => (closing ??= shutDown()) };
};
