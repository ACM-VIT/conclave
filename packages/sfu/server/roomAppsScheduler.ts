import type { Socket } from "socket.io";
import { Logger } from "../utilities/loggers.js";
import type { WriteRefusal } from "./roomApps.js";
import { RATE_LIMITS, msUntilToken, takeToken } from "./socket/rateLimit.js";
import type { WireBytes } from "./socket/wireBytes.js";

export const MAX_SLOT_UPDATES = 64;
export const MAX_SLOT_BYTES = 256 * 1024;
export const MAX_SLOT_MS = 1000;
export const BARRIER_DEADLINE_MS = 100;

const UPDATE_BUDGET = "apps:yjs:update";
const SLOT_ADMISSION_BUDGET = "apps:slot-admission";
const SLOT_ADMISSION_LIMIT = { capacity: MAX_SLOT_BYTES, refillPerSec: MAX_SLOT_BYTES };

export type WriteOutcome = WriteRefusal | null;

export type Pending<T> = T | Promise<T>;

export type SlotWrite = {
  readonly sender: Socket;
  readonly appId: string;
  readonly key: string;
  readonly host: boolean;
  readonly run: (updates: Uint8Array[]) => Pending<WriteOutcome[]>;
  readonly finish: (outcome: WriteOutcome) => void;
};

type ReadyWrite = { work: SlotWrite; update: Uint8Array };
type Slot = { first: SlotWrite; writes: ReadyWrite[]; bytes: number; admittedAt: number };

type Job = { sender: Socket; appId: string; writes: SlotWrite[] };

export type HeldCommand = {
  readonly changes: () => boolean;
  readonly run: () => void;
  readonly cancel: () => void;
};

type Barrier = { command: HeldCommand; senders: Set<Socket>; deadline: number };

export type StageTransition = {
  readonly refuse?: { readonly matches: (write: SlotWrite) => boolean; readonly outcome: WriteRefusal };
  readonly apply: () => void;
  readonly notify: () => void;
};

const settle = (label: string, task: () => void): void => {
  try {
    task();
  } catch (error) {
    Logger.warn(`[Apps] ${label} failed`, error);
  }
};

export const isPending = <T>(value: Pending<T>): value is Promise<T> =>
  typeof (value as Promise<T> | null)?.then === "function";

export const whenSettled = <T, R>(value: Pending<T>, next: (settled: T) => R): Pending<R> =>
  isPending(value) ? value.then(next) : next(value);

export const afterSettled = <T>(label: string, value: Pending<T>, next: (settled: T) => void): void => {
  const run = (settled: T): void => settle(label, () => next(settled));
  if (isPending(value)) value.then(run, (error: unknown) => Logger.warn(`[Apps] ${label} failed`, error));
  else run(value);
};

export class RoomAppsScheduler {
  private slots = new Map<Socket, Slot>();
  private barriers: Barrier[] = [];
  private job: Job | null = null;
  private finished = new WeakSet<SlotWrite>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private holds = 0;
  private pumpOwed = false;
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  get running(): boolean {
    return this.job !== null;
  }

  slotSummaries(): { updates: number; bytes: number; age: number }[] {
    const now = Date.now();
    return [...this.slots.values()].map((slot) => ({
      updates: slot.writes.length,
      bytes: slot.bytes,
      age: now - slot.admittedAt,
    }));
  }

  submit(write: SlotWrite, wire: WireBytes): void {
    if (this.closed) {
      this.finish(write, "not-live");
      return;
    }
    const slot = this.slots.get(write.sender);
    if (!slot && !this.job && takeToken(write.sender, UPDATE_BUDGET, RATE_LIMITS.appsYjsUpdate)) {
      const update = this.read(write, wire);
      if (update) this.execute(write, [{ work: write, update }]);
      return;
    }
    if (
      !this.fits(slot, write.key, wire.length) ||
      !takeToken(write.sender, SLOT_ADMISSION_BUDGET, SLOT_ADMISSION_LIMIT, wire.length)
    ) {
      this.finish(write, "rate-limited");
      return;
    }
    const read = this.read(write, wire);
    if (!read) return;
    const update = new Uint8Array(read);
    const ready = { work: write, update };
    if (slot) {
      slot.writes.push(ready);
      slot.bytes += update.buffer.byteLength;
    } else {
      this.slots.set(write.sender, { first: write, writes: [ready], bytes: update.buffer.byteLength, admittedAt: Date.now() });
      this.schedule();
    }
  }

  hold(task: () => void): void {
    this.holds += 1;
    try {
      task();
    } finally {
      this.holds -= 1;
      if (this.holds === 0 && this.pumpOwed) {
        this.pumpOwed = false;
        this.pump();
      }
    }
  }

  transition(change: StageTransition): void {
    this.hold(() => {
      if (change.refuse) this.purge(change.refuse.matches, change.refuse.outcome);
      change.apply();
      change.notify();
      this.pumpOwed = true;
    });
  }

  purge(matches: (write: SlotWrite) => boolean, outcome: WriteRefusal): void {
    for (const [sender, slot] of [...this.slots]) {
      if (!matches(slot.first)) continue;
      this.slots.delete(sender);
      this.finishSlot(slot, outcome);
    }
    this.pump();
  }

  afterHeld(appId: string | null, command: HeldCommand): void {
    if (this.closed) {
      settle("App stage command", command.cancel);
      return;
    }
    const senders = new Set<Socket>();
    if (appId !== null) {
      for (const [sender, slot] of this.slots) if (slot.first.appId === appId) senders.add(sender);
      if (this.job?.appId === appId) senders.add(this.job.sender);
    }
    this.barriers.push({ command, senders, deadline: Date.now() + BARRIER_DEADLINE_MS });
    this.pump();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    const slots = [...this.slots.values()];
    const barriers = this.barriers;
    const job = this.job;
    this.slots.clear();
    this.barriers = [];
    this.job = null;
    for (const slot of slots) this.finishSlot(slot, "not-live");
    if (job) this.finishAll(job.writes, "not-live");
    for (const barrier of barriers) settle("App stage command", barrier.command.cancel);
  }

  private finish(write: SlotWrite, outcome: WriteOutcome): void {
    if (this.finished.has(write)) return;
    this.finished.add(write);
    settle("App update", () => write.finish(outcome));
  }

  private finishAll(writes: SlotWrite[], outcome: WriteOutcome): void {
    for (const write of writes) this.finish(write, outcome);
  }

  private finishSlot(slot: Slot, outcome: WriteOutcome): void {
    for (const { work } of slot.writes) this.finish(work, outcome);
  }

  private read(write: SlotWrite, wire: WireBytes): Uint8Array | null {
    try {
      const update = wire.read();
      if (update?.length === wire.length) return update;
    } catch (error) {
      Logger.warn("[Apps] Reading an app update failed", error);
    }
    this.finish(write, "invalid");
    return null;
  }

  private execute(first: SlotWrite, ready: ReadyWrite[]): void {
    const writes = ready.map(({ work }) => work);
    const updates = ready.map(({ update }) => update);
    let result: Pending<WriteOutcome[]> | null = null;
    settle("App update", () => {
      result = first.run(updates);
    });
    const ran = result as Pending<WriteOutcome[]> | null;
    if (!ran || !isPending(ran)) {
      this.complete(writes, ran);
      return;
    }
    const job: Job = { sender: first.sender, appId: first.appId, writes };
    this.job = job;
    ran.then(
      (outcomes) => this.completeJob(job, outcomes),
      (error: unknown) => {
        Logger.warn("[Apps] App update failed", error);
        this.completeJob(job, null);
      },
    );
  }

  private completeJob(job: Job, outcomes: WriteOutcome[] | null): void {
    this.complete(job.writes, outcomes);
    if (this.job !== job) return;
    this.job = null;
    this.pump();
  }

  private complete(writes: SlotWrite[], outcomes: WriteOutcome[] | null): void {
    writes.forEach((write, index) => this.finish(write, outcomes?.[index] === undefined ? "invalid" : outcomes[index]));
  }

  private fits(slot: Slot | undefined, key: string, bytes: number): boolean {
    if (!slot) return bytes <= MAX_SLOT_BYTES;
    return (
      slot.first.key === key &&
      slot.writes.length < MAX_SLOT_UPDATES &&
      slot.bytes + bytes <= MAX_SLOT_BYTES &&
      Date.now() - slot.admittedAt < MAX_SLOT_MS
    );
  }

  private waitsOn(barrier: Barrier): boolean {
    for (const sender of [...barrier.senders]) {
      if (!this.slots.has(sender) && this.job?.sender !== sender) barrier.senders.delete(sender);
    }
    return barrier.senders.size > 0 && Date.now() < barrier.deadline;
  }

  private pump(): void {
    if (this.closed) return;
    if (this.holds > 0) {
      this.pumpOwed = true;
      return;
    }
    if (this.pumping) return;
    this.pumping = true;
    try {
      this.clearTimer();
      const now = Date.now();
      for (const [sender, slot] of [...this.slots]) {
        if (now - slot.admittedAt < MAX_SLOT_MS) continue;
        this.slots.delete(sender);
        this.finishSlot(slot, "rate-limited");
      }
      for (const [sender, slot] of [...this.slots]) {
        if (this.job || this.closed) break;
        if (this.slots.get(sender) !== slot) continue;
        if (!takeToken(sender, UPDATE_BUDGET, RATE_LIMITS.appsYjsUpdate)) continue;
        this.slots.delete(sender);
        this.execute(slot.first, slot.writes);
      }
      while (this.barriers.length > 0 && !this.closed) {
        const [head] = this.barriers;
        let changes = false;
        settle("App stage command", () => {
          changes = head.command.changes();
        });
        if (changes) {
          if (this.waitsOn(head)) break;
          for (const sender of head.senders) {
            const slot = this.slots.get(sender);
            if (!slot) continue;
            this.slots.delete(sender);
            this.finishSlot(slot, "rate-limited");
          }
        }
        this.barriers.shift();
        settle("App stage command", head.command.run);
      }
    } finally {
      this.pumping = false;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.closed) return;
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const [sender, slot] of this.slots) {
      next = Math.min(
        next,
        this.job ? Number.POSITIVE_INFINITY : now + msUntilToken(sender, UPDATE_BUDGET, RATE_LIMITS.appsYjsUpdate),
        slot.admittedAt + MAX_SLOT_MS,
      );
    }
    if (this.barriers.length > 0) next = Math.min(next, this.barriers[0].deadline);
    if (next === Number.POSITIVE_INFINITY) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      settle("App scheduler", () => this.pump());
    }, Math.max(0, Math.ceil(next - now)));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
