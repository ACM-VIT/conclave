import * as Y from "yjs";
import type { Socket } from "socket.io";
import { Logger } from "../utilities/loggers.js";
import type { WriteRefusal } from "./roomApps.js";
import { RATE_LIMITS, msUntilToken, takeToken } from "./socket/rateLimit.js";

export const MAX_SLOT_UPDATES = 64;
export const MAX_SLOT_BYTES = 256 * 1024;
export const MAX_SLOT_MS = 1000;
export const BARRIER_DEADLINE_MS = 100;

const UPDATE_BUDGET = "apps:yjs:update";

export type WriteOutcome = WriteRefusal | null;

export type SlotWrite = {
  readonly sender: Socket;
  readonly appId: string;
  readonly key: string;
  readonly host: boolean;
  readonly update: Uint8Array;
  readonly run: (update: Uint8Array) => WriteOutcome;
  readonly finish: (outcome: WriteOutcome, update: Uint8Array | null) => void;
};

type Slot = { first: SlotWrite; updates: Uint8Array[]; bytes: number; admittedAt: number };

export type HeldCommand = {
  readonly changes: () => boolean;
  readonly run: () => void;
  readonly cancel: () => void;
};

type Barrier = { command: HeldCommand; senders: Set<Socket>; deadline: number };

const settle = (label: string, task: () => void): void => {
  try {
    task();
  } catch (error) {
    Logger.warn(`[Apps] ${label} failed`, error);
  }
};

export class RoomAppsScheduler {
  private slots = new Map<Socket, Slot>();
  private barriers: Barrier[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  slotSummaries(): { updates: number; bytes: number; age: number }[] {
    const now = Date.now();
    return [...this.slots.values()].map((slot) => ({
      updates: slot.updates.length,
      bytes: slot.bytes,
      age: now - slot.admittedAt,
    }));
  }

  submit(write: SlotWrite): void {
    if (this.closed) {
      settle("App update", () => write.finish("not-live", null));
      return;
    }
    const slot = this.slots.get(write.sender);
    if (!slot) {
      if (takeToken(write.sender, UPDATE_BUDGET, RATE_LIMITS.appsYjsUpdate)) {
        this.execute(write, [write.update]);
        return;
      }
      this.slots.set(write.sender, {
        first: write,
        updates: [write.update],
        bytes: write.update.length,
        admittedAt: Date.now(),
      });
      this.schedule();
      return;
    }
    if (
      slot.first.key !== write.key ||
      slot.updates.length >= MAX_SLOT_UPDATES ||
      slot.bytes + write.update.length > MAX_SLOT_BYTES ||
      Date.now() - slot.admittedAt >= MAX_SLOT_MS
    ) {
      settle("App update", () => write.finish("rate-limited", null));
      return;
    }
    slot.updates.push(write.update);
    slot.bytes += write.update.length;
  }

  purge(matches: (write: SlotWrite) => boolean, outcome: WriteRefusal): void {
    for (const [sender, slot] of [...this.slots]) {
      if (!matches(slot.first)) continue;
      this.slots.delete(sender);
      settle("App update", () => slot.first.finish(outcome, null));
    }
    this.pump();
  }

  afterHeld(appId: string | null, command: HeldCommand): void {
    if (this.closed) {
      settle("App stage command", command.cancel);
      return;
    }
    const senders = new Set<Socket>();
    for (const [sender, slot] of this.slots) if (appId !== null && slot.first.appId === appId) senders.add(sender);
    this.barriers.push({ command, senders, deadline: Date.now() + BARRIER_DEADLINE_MS });
    this.pump();
  }

  wake(): void {
    this.pump();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    const slots = [...this.slots.values()];
    const barriers = this.barriers;
    this.slots.clear();
    this.barriers = [];
    for (const slot of slots) settle("App update", () => slot.first.finish("not-live", null));
    for (const barrier of barriers) settle("App stage command", barrier.command.cancel);
  }

  private execute(first: SlotWrite, updates: Uint8Array[]): void {
    let update: Uint8Array;
    try {
      update = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
    } catch {
      settle("App update", () => first.finish("malformed", null));
      return;
    }
    let outcome: WriteOutcome = "invalid";
    settle("App update", () => {
      outcome = first.run(update);
    });
    settle("App update", () => first.finish(outcome, update));
  }

  private pump(): void {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      this.clearTimer();
      const now = Date.now();
      for (const [sender, slot] of [...this.slots]) {
        if (now - slot.admittedAt < MAX_SLOT_MS) continue;
        this.slots.delete(sender);
        settle("App update", () => slot.first.finish("rate-limited", null));
      }
      for (const [sender, slot] of [...this.slots]) {
        if (!takeToken(sender, UPDATE_BUDGET, RATE_LIMITS.appsYjsUpdate)) continue;
        this.slots.delete(sender);
        this.execute(slot.first, slot.updates);
      }
      while (this.barriers.length > 0 && !this.closed) {
        const [head] = this.barriers;
        let changes = false;
        settle("App stage command", () => {
          changes = head.command.changes();
        });
        if (changes) {
          for (const sender of [...head.senders]) if (!this.slots.has(sender)) head.senders.delete(sender);
          if (head.senders.size > 0 && Date.now() < head.deadline) break;
          for (const sender of head.senders) {
            const slot = this.slots.get(sender);
            if (!slot) continue;
            this.slots.delete(sender);
            settle("App update", () => slot.first.finish("rate-limited", null));
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
        now + msUntilToken(sender, UPDATE_BUDGET, RATE_LIMITS.appsYjsUpdate),
        slot.admittedAt + MAX_SLOT_MS,
      );
    }
    if (this.barriers.length > 0) next = Math.min(next, this.barriers[0].deadline);
    if (next === Number.POSITIVE_INFINITY) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, Math.ceil(next - now)));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
