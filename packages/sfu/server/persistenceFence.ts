import { z } from "zod";
import type { ScheduledMeetingPersistence } from "./scheduledMeetings.js";
import type { ScheduledWebinarPersistence } from "./scheduledWebinars.js";
import type { SchedulingPersistence } from "./scheduling.js";

// A write fence for backups, as one gate in front of every persistence call
// (scheduled meetings, scheduling, webinars, booking locks, reminder claims).
// Calls pass it one at a time in the order they were made: each starts once
// the call before it has finished and the fence is open. While a backup holds
// the fence, calls wait their turn, so the backup copies SQLite and Redis at
// one point in time; afterwards they run in arrival order, and each caller
// gets its own call's result or error. Only persistence waits on the gate:
// media and signalling never await it, and the services serve from memory.
// A hold belongs to the owner token that took it. Only that token renews or
// releases it, it lifts itself at its deadline if the backup never comes
// back, and no renewal keeps it past MAX_PERSISTENCE_FENCE_MS from when it
// was taken, so writers never wait longer than that.

export const MAX_PERSISTENCE_FENCE_MS = 30_000;

const fenceOwner = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

export const persistenceFenceHoldRequest = z.object({
  owner: fenceOwner,
  holdMs: z.number().int().min(1_000).max(MAX_PERSISTENCE_FENCE_MS),
  renew: z.boolean().optional(),
});

export const persistenceFenceReleaseRequest = z.object({ owner: fenceOwner });

type MaybePromise<T> = T | Promise<T>;

export type PersistenceFence = {
  hold: (owner: string, holdMs: number) => Promise<{ until: number } | null>;
  renew: (owner: string, holdMs: number) => { until: number } | null;
  release: (owner: string) => boolean;
  holder: () => string | null;
  run: <T>(call: () => MaybePromise<T>) => Promise<T>;
  open: () => void;
};

const settle = (): void => undefined;

export const createPersistenceFence = (): PersistenceFence => {
  let owner: string | null = null;
  let heldSince = 0;
  let until = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiters: Array<() => void> = [];
  let tail: Promise<void> = Promise.resolve();
  // Calls are numbered as they are made. A hold marks a point: the calls
  // made before it run and land before the hold answers, and the calls from
  // heldFrom on wait until it lifts.
  let made = 0;
  let heldFrom = Infinity;

  const open = (): void => {
    owner = null;
    heldSince = 0;
    until = 0;
    heldFrom = Infinity;
    if (timer) clearTimeout(timer);
    timer = null;
    const ready = waiters;
    waiters = [];
    ready.forEach((resolve) => resolve());
  };

  const arm = (holdMs: number): { until: number } => {
    const now = Date.now();
    until = Math.min(now + holdMs, heldSince + MAX_PERSISTENCE_FENCE_MS);
    if (timer) clearTimeout(timer);
    timer = setTimeout(open, until - now);
    timer.unref?.();
    return { until };
  };

  return {
    async hold(who, holdMs) {
      if (owner !== null && owner !== who) return null;
      if (owner === null) {
        heldFrom = made;
        heldSince = Date.now();
      }
      owner = who;
      arm(holdMs);
      await tail;
      return owner === who ? { until } : null;
    },
    renew: (who, holdMs) => (owner === who ? arm(holdMs) : null),
    release(who) {
      if (owner !== who) return false;
      open();
      return true;
    },
    holder: () => owner,
    run(call) {
      const number = made++;
      const result = tail.then(async () => {
        while (owner !== null && number >= heldFrom) await new Promise<void>((resolve) => waiters.push(resolve));
        // Started in the same turn as the check above, so a hold cannot slip
        // in between them.
        return call();
      });
      tail = result.then(settle, settle);
      return result;
    },
    open,
  };
};

export const fenceScheduledMeetingPersistence = (
  persistence: ScheduledMeetingPersistence,
  fence: PersistenceFence,
): ScheduledMeetingPersistence => {
  // Redis queues its writes, so a write is done once flush() says it landed;
  // its error is the caller's.
  const write = (call: () => MaybePromise<void>) =>
    fence.run(async () => {
      await call();
      await persistence.flush?.();
    });
  return {
    save: (snapshot) => write(() => persistence.save(snapshot)),
    saveChanged: persistence.saveChanged && ((meetings) => write(() => persistence.saveChanged!(meetings))),
    deleteIds: persistence.deleteIds && ((ids) => write(() => persistence.deleteIds!(ids))),
    reserveBookingSlot:
      persistence.reserveBookingSlot && ((reservation) => fence.run(() => persistence.reserveBookingSlot!(reservation))),
    claimEmailReminder: persistence.claimEmailReminder && ((claim) => fence.run(() => persistence.claimEmailReminder!(claim))),
    // A load can write too: Redis migrates the fallback's meetings into itself.
    load: () => fence.run(() => persistence.load()),
    flush: persistence.flush && (() => fence.run(() => persistence.flush!())),
    close:
      persistence.close &&
      (() => {
        fence.open();
        return fence.run(() => persistence.close!());
      }),
  };
};

export const fenceSchedulingPersistence = (
  persistence: SchedulingPersistence,
  fence: PersistenceFence,
): SchedulingPersistence => ({
  save: (snapshot) =>
    fence.run(async () => {
      await persistence.save(snapshot);
      await persistence.flush?.();
    }),
  load: () => fence.run(() => persistence.load()),
  flush: persistence.flush && (() => fence.run(() => persistence.flush!())),
  close:
    persistence.close &&
    (() => {
      fence.open();
      return fence.run(() => persistence.close!());
    }),
});

export const fenceScheduledWebinarPersistence = (
  persistence: ScheduledWebinarPersistence,
  fence: PersistenceFence,
): ScheduledWebinarPersistence => ({
  save: (snapshot) => fence.run(() => persistence.save(snapshot)),
  saveChanged: persistence.saveChanged && ((webinars) => fence.run(() => persistence.saveChanged!(webinars))),
  deleteIds: persistence.deleteIds && ((ids) => fence.run(() => persistence.deleteIds!(ids))),
  load: () => persistence.load(),
  close:
    persistence.close &&
    (() => {
      fence.open();
      return fence.run(() => persistence.close!());
    }),
});
