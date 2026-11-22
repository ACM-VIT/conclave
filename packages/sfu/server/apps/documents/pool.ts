import { Worker } from "node:worker_threads";
import { Logger } from "../../../utilities/loggers.js";
import type { FromWorker, Operation, ToWorker } from "./engine.js";

export const MAX_APP_DOCUMENT_BYTES = 1024 * 1024;

export type Refusal =
  | "too-large"
  | "invalid"
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

export type AppDocumentPoolOptions = {
  workers: number;
  deadlineMs: number;
  maxDocumentBytes: number;
  limits?: QueueLimits;
  workerUrl?: URL;
};

type Job =
  | { kind: "apply"; update: Uint8Array; settle: (result: ApplyResult) => void }
  | { kind: "sync"; stateVector: Uint8Array; settle: (result: SyncResult) => void };

type Entry = {
  id: number;
  slot: Slot;
  base: Uint8Array | null;
  tail: Uint8Array[];
  waiting: Job[];
  queued: Bound;
  loadedIn: number;
  status: "open" | "broken" | "closed";
  ready: boolean;
};

type Run = {
  entry: Entry;
  jobs: Job[];
  next: number;
  loading: boolean;
  timer?: NodeJS.Timeout;
};

type Slot = {
  worker: Worker | null;
  booted: boolean;
  bootTimer?: NodeJS.Timeout;
  generation: number;
  documents: number;
  ready: Entry[];
  run: Run | null;
};

const JOBS_PER_RUN = 64;
const LOAD_DEADLINE_FACTOR = 4;
const BOOT_DEADLINE_MS = 10_000;

const bytesOf = (job: Job): number =>
  job.kind === "apply" ? job.update.length : job.stateVector.length;

const operationOf = (job: Job): Operation =>
  job.kind === "apply"
    ? { kind: "apply", update: job.update }
    : { kind: "sync", stateVector: job.stateVector };

export const createAppDocumentPool = ({
  workers,
  deadlineMs,
  maxDocumentBytes,
  limits = DEFAULT_QUEUE_LIMITS,
  workerUrl = new URL("./worker.ts", import.meta.url),
}: AppDocumentPoolOptions): AppDocumentPool => {
  const slots: Slot[] = Array.from({ length: workers }, () => ({
    worker: null,
    booted: false,
    generation: 0,
    documents: 0,
    ready: [],
    run: null,
  }));
  const total: Bound = { jobs: 0, bytes: 0 };
  let nextId = 1;
  let closed = false;

  const refuse = (job: Job, reason: Refusal): void => job.settle({ ok: false, reason });

  const release = (entry: Entry, job: Job): void => {
    const bytes = bytesOf(job);
    entry.queued.jobs -= 1;
    entry.queued.bytes -= bytes;
    total.jobs -= 1;
    total.bytes -= bytes;
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
    clearTimeout(run.timer);
    run.timer = setTimeout(() => fail(slot, "timed-out"), ms);
  };

  const finish = (slot: Slot, run: Run): void => {
    clearTimeout(run.timer);
    slot.run = null;
    markReady(run.entry);
    pump(slot);
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
      } else {
        entry.tail.push(job.update);
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

  const startClock = (slot: Slot, run: Run): void =>
    arm(slot, run, run.loading ? deadlineMs * LOAD_DEADLINE_FACTOR : deadlineMs);

  const receive = (slot: Slot, reply: FromWorker): void => {
    if (reply.type === "ready") {
      slot.booted = true;
      clearTimeout(slot.bootTimer);
      if (slot.run) startClock(slot, slot.run);
      return;
    }
    const run = slot.run;
    if (!run) return;
    if (reply.type === "loaded") {
      run.loading = false;
      arm(slot, run, deadlineMs);
      return;
    }
    const { entry } = run;
    const job = run.jobs[run.next];
    run.next += 1;
    release(entry, job);
    settle(entry, job, reply);
    if (reply.type === "refused" && reply.evicted) {
      entry.loadedIn = -1;
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

  const fail = (slot: Slot, reason: "timed-out" | "crashed"): void => {
    const { worker, booted } = slot;
    slot.worker = null;
    slot.booted = false;
    clearTimeout(slot.bootTimer);
    slot.generation += 1;
    void worker?.terminate();
    const run = slot.run;
    slot.run = null;
    if (run) {
      clearTimeout(run.timer);
      const { entry } = run;
      const remaining = run.jobs.slice(run.next);
      if (!booted) {
        Logger.error("[Apps] App document worker did not start");
        drop(entry, remaining, refusalFor(entry, "crashed"));
      } else if (run.loading && entry.status === "open") {
        Logger.error(
          `[Apps] App document ${entry.id} could not be rebuilt within ${deadlineMs * LOAD_DEADLINE_FACTOR} ms; refusing it until the app is reopened`,
        );
        entry.status = "broken";
        drop(entry, [...remaining, ...entry.waiting], "unavailable");
        entry.waiting = [];
      } else {
        drop(entry, remaining.slice(0, 1), refusalFor(entry, reason));
        requeue(entry, remaining.slice(1));
        markReady(entry);
      }
    }
    if (booted && slot.documents > 0 && !closed) spawn(slot);
    pump(slot);
  };

  const spawn = (slot: Slot): Worker => {
    const worker = new Worker(workerUrl, { workerData: { maxDocumentBytes } });
    worker.unref();
    slot.bootTimer = setTimeout(() => {
      if (slot.worker === worker) fail(slot, "crashed");
    }, BOOT_DEADLINE_MS);
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
    slot.worker = worker;
    return worker;
  };

  const pump = (slot: Slot): void => {
    if (closed || slot.run) return;
    const entry = slot.ready.shift();
    if (!entry) return;
    entry.ready = false;
    const jobs = entry.waiting.splice(0, JOBS_PER_RUN);
    const worker = slot.worker ?? spawn(slot);
    const cold = entry.loadedIn !== slot.generation;
    const message: ToWorker = {
      type: "run",
      document: entry.id,
      load: cold ? { base: entry.base, tail: entry.tail } : null,
      operations: jobs.map(operationOf),
    };
    entry.loadedIn = slot.generation;
    const run: Run = { entry, jobs, next: 0, loading: cold };
    slot.run = run;
    if (slot.booted) startClock(slot, run);
    worker.postMessage(message);
  };

  const enqueue = (entry: Entry, job: Job): void => {
    if (closed || entry.status === "closed") {
      refuse(job, "closed");
      return;
    }
    if (entry.status === "broken") {
      refuse(job, "unavailable");
      return;
    }
    const bytes = bytesOf(job);
    if (
      entry.queued.jobs + 1 > limits.document.jobs ||
      entry.queued.bytes + bytes > limits.document.bytes ||
      total.jobs + 1 > limits.total.jobs ||
      total.bytes + bytes > limits.total.bytes
    ) {
      refuse(job, "queue-full");
      return;
    }
    entry.queued.jobs += 1;
    entry.queued.bytes += bytes;
    total.jobs += 1;
    total.bytes += bytes;
    entry.waiting.push(job);
    markReady(entry);
    pump(entry.slot);
  };

  const closeEntry = (entry: Entry): void => {
    if (entry.status === "closed") return;
    const { slot } = entry;
    const loaded = entry.loadedIn === slot.generation;
    entry.status = "closed";
    slot.documents -= 1;
    if (entry.ready) slot.ready.splice(slot.ready.indexOf(entry), 1);
    entry.ready = false;
    drop(entry, entry.waiting, "closed");
    entry.waiting = [];
    entry.base = null;
    entry.tail = [];
    if (loaded) slot.worker?.postMessage({ type: "drop", document: entry.id } satisfies ToWorker);
  };

  const open = (): AppDocument => {
    const slot = slots.reduce((least, candidate) =>
      candidate.documents < least.documents ? candidate : least,
    );
    slot.documents += 1;
    if (!slot.worker && !closed) spawn(slot);
    const entry: Entry = {
      id: nextId++,
      slot,
      base: null,
      tail: [],
      waiting: [],
      queued: { jobs: 0, bytes: 0 },
      loadedIn: -1,
      status: "open",
      ready: false,
    };
    return {
      apply: (update) =>
        new Promise((settle) => enqueue(entry, { kind: "apply", update, settle })),
      sync: (stateVector) =>
        new Promise((settle) => enqueue(entry, { kind: "sync", stateVector, settle })),
      close: () => closeEntry(entry),
    };
  };

  const close = async (): Promise<void> => {
    closed = true;
    const stopping = slots.flatMap((slot) => {
      const { run, worker } = slot;
      slot.run = null;
      slot.worker = null;
      clearTimeout(slot.bootTimer);
      if (run) {
        clearTimeout(run.timer);
        drop(run.entry, run.jobs.slice(run.next), "closed");
      }
      for (const entry of [...slot.ready, ...(run ? [run.entry] : [])]) {
        drop(entry, entry.waiting, "closed");
        entry.waiting = [];
        entry.ready = false;
      }
      slot.ready = [];
      return worker ? [worker.terminate()] : [];
    });
    await Promise.all(stopping);
  };

  return { open, close };
};
