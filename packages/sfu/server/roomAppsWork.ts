import * as Y from "yjs";
import type { Socket } from "socket.io";
import { Logger } from "../utilities/loggers.js";
import { RATE_LIMITS, takeToken } from "./socket/rateLimit.js";

export const MAX_HELD_UPDATE_BYTES = 256 * 1024;
export const MAX_HELD_BATCHES = 4;
export const MAX_HELD_MS = 1000;
const RETRY_MS = Math.ceil(1000 / RATE_LIMITS.appsYjsUpdate.refillPerSec);

export type HeldWrite = {
  sender: Socket;
  batch: readonly unknown[];
  update: Uint8Array;
  apply: (update: Uint8Array) => void;
};

type Work = { write: HeldWrite } | { step: () => void };

type SenderHeld = {
  bytes: number;
  batches: number;
  admittedAt: number[];
  lastBatch: readonly unknown[] | null;
  lastStep: number;
};

const sameBatch = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const run = (label: string, task: () => void): void => {
  try {
    task();
  } catch (error) {
    Logger.warn(`[Apps] ${label} failed`, error);
  }
};

export class RoomAppsWork {
  private work: Work[] = [];
  private held = new Map<Socket, SenderHeld>();
  private steps = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;

  hold(write: HeldWrite): boolean {
    const now = Date.now();
    const held = this.held.get(write.sender) ?? {
      bytes: 0,
      batches: 0,
      admittedAt: [],
      lastBatch: null,
      lastStep: -1,
    };
    const joins =
      held.lastBatch !== null && held.lastStep === this.steps && sameBatch(held.lastBatch, write.batch);
    if (
      held.bytes + write.update.length > MAX_HELD_UPDATE_BYTES ||
      (held.admittedAt.length > 0 && now - held.admittedAt[0] >= MAX_HELD_MS) ||
      (!joins && held.batches >= MAX_HELD_BATCHES)
    ) {
      return false;
    }
    held.bytes += write.update.length;
    if (!joins) held.batches += 1;
    held.admittedAt.push(now);
    held.lastBatch = write.batch;
    held.lastStep = this.steps;
    this.held.set(write.sender, held);
    this.work.push({ write });
    this.pump();
    return true;
  }

  after(step: () => void): void {
    this.steps += 1;
    this.work.push({ step });
    this.pump();
  }

  private settle(sender: Socket, applied: HeldWrite[], batchDone: boolean): void {
    const held = this.held.get(sender);
    if (!held) return;
    for (const write of applied) held.bytes -= write.update.length;
    held.admittedAt.splice(0, applied.length);
    if (batchDone) held.batches -= 1;
    if (held.admittedAt.length === 0) this.held.delete(sender);
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.work.length > 0) {
        const [head] = this.work;
        if ("step" in head) {
          this.work.shift();
          run("App step", head.step);
        } else if (!this.applyWrites()) {
          this.timer ??= setTimeout(() => {
            this.timer = null;
            this.pump();
          }, RETRY_MS);
          return;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private applyWrites(): boolean {
    const end = this.work.findIndex((item) => "step" in item);
    const writes = (end === -1 ? this.work : this.work.slice(0, end)) as { write: HeldWrite }[];
    const done = new Set<Work>();
    const tried = new Set<Socket>();
    writes.forEach((item, index) => {
      const { sender, batch } = item.write;
      if (tried.has(sender)) return;
      tried.add(sender);
      if (!takeToken(sender, "apps:yjs:update", RATE_LIMITS.appsYjsUpdate)) return;
      const batchItems = [item];
      for (const next of writes.slice(index + 1)) {
        if (next.write.sender !== sender) continue;
        if (!sameBatch(next.write.batch, batch)) break;
        batchItems.push(next);
      }
      const whole = batchItems.length;
      let merged: Uint8Array | null = null;
      try {
        merged = batchItems.length === 1 ? item.write.update : Y.mergeUpdates(batchItems.map((each) => each.write.update));
      } catch {
        batchItems.splice(1);
        merged = item.write.update;
      }
      for (const each of batchItems) done.add(each);
      this.settle(sender, batchItems.map((each) => each.write), batchItems.length === whole);
      const update = merged;
      run("App update", () => item.write.apply(update));
    });
    this.work = this.work.filter((item) => !done.has(item));
    return done.size > 0;
  }
}
