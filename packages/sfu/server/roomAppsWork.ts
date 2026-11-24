import * as Y from "yjs";
import type { Socket } from "socket.io";
import { Logger } from "../utilities/loggers.js";
import { RATE_LIMITS, takeToken } from "./socket/rateLimit.js";

export const MAX_HELD_UPDATE_BYTES = 256 * 1024;
const RETRY_MS = Math.ceil(1000 / RATE_LIMITS.appsYjsUpdate.refillPerSec);

export type HeldWrite = {
  sender: Socket;
  batch: readonly unknown[];
  update: Uint8Array;
  apply: (update: Uint8Array) => void;
};

type Work = { write: HeldWrite } | { step: () => void };

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
  private heldBytes = new Map<Socket, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;

  hold(write: HeldWrite): boolean {
    const held = this.heldBytes.get(write.sender) ?? 0;
    if (held + write.update.length > MAX_HELD_UPDATE_BYTES) return false;
    this.heldBytes.set(write.sender, held + write.update.length);
    this.work.push({ write });
    this.pump();
    return true;
  }

  after(step: () => void): void {
    this.work.push({ step });
    this.pump();
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
      let merged: Uint8Array | null = null;
      try {
        merged = batchItems.length === 1 ? item.write.update : Y.mergeUpdates(batchItems.map((each) => each.write.update));
      } catch {
        batchItems.splice(1);
        merged = item.write.update;
      }
      for (const each of batchItems) {
        done.add(each);
        const held = (this.heldBytes.get(sender) ?? 0) - each.write.update.length;
        if (held > 0) this.heldBytes.set(sender, held);
        else this.heldBytes.delete(sender);
      }
      const update = merged;
      run("App update", () => item.write.apply(update));
    });
    this.work = this.work.filter((item) => !done.has(item));
    return done.size > 0;
  }
}
