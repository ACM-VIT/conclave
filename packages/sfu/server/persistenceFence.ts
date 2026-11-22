import { Logger } from "../utilities/loggers.js";
import type { ScheduledMeetingPersistence } from "./scheduledMeetings.js";
import type { ScheduledWebinarPersistence } from "./scheduledWebinars.js";
import type { SchedulingPersistence } from "./scheduling.js";

// A short write fence for backups. While a backup holds it, every durable
// persistence write (scheduled meetings, scheduling, webinars) waits, so the
// backup copies SQLite and Redis at one point in time. Writes queue in the
// order they were made and run when the backup releases the fence, or at its
// hard timeout if the backup never comes back. The services keep serving from
// memory meanwhile.
export type PersistenceFence = {
  hold: (holdMs: number) => Promise<{ until: number }>;
  release: () => void;
  held: () => boolean;
  defer: <T>(write: () => T) => T | undefined;
  whenOpen: () => Promise<void>;
  addFlusher: (flush: () => Promise<void>) => void;
};

export const MAX_PERSISTENCE_FENCE_MS = 30_000;

export const createPersistenceFence = (): PersistenceFence => {
  let until = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queue: Array<() => unknown> = [];
  let waiters: Array<() => void> = [];
  const flushers: Array<() => Promise<void>> = [];

  const runDeferred = (write: () => unknown): void => {
    try {
      const result = write();
      if (result instanceof Promise) {
        result.catch((error) => Logger.error("A write held by the persistence fence failed", error));
      }
    } catch (error) {
      Logger.error("A write held by the persistence fence failed", error);
    }
  };

  const open = (): void => {
    until = 0;
    if (timer) clearTimeout(timer);
    timer = null;
    const writes = queue;
    queue = [];
    writes.forEach(runDeferred);
    const ready = waiters;
    waiters = [];
    ready.forEach((resolve) => resolve());
  };

  return {
    async hold(holdMs) {
      until = Date.now() + holdMs;
      if (timer) clearTimeout(timer);
      timer = setTimeout(open, holdMs);
      timer.unref?.();
      // Writes that started before the hold land first, so the backup sees
      // all of them or none.
      await Promise.all(flushers.map((flush) => flush().catch(() => undefined)));
      return { until };
    },
    release: open,
    held: () => until > 0,
    defer(write) {
      if (until === 0) return write();
      queue.push(write);
      return undefined;
    },
    whenOpen: () => (until === 0 ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve))),
    addFlusher(flush) {
      flushers.push(flush);
    },
  };
};

export const fenceScheduledMeetingPersistence = (
  persistence: ScheduledMeetingPersistence,
  fence: PersistenceFence,
): ScheduledMeetingPersistence => {
  if (persistence.flush) fence.addFlusher(() => persistence.flush!());
  return {
    save: (snapshot) => fence.defer(() => persistence.save(snapshot)),
    saveChanged: persistence.saveChanged && ((meetings) => fence.defer(() => persistence.saveChanged!(meetings))),
    deleteIds: persistence.deleteIds && ((ids) => fence.defer(() => persistence.deleteIds!(ids))),
    // Booking locks are short-lived keys, not data a restore brings back.
    reserveBookingSlot: persistence.reserveBookingSlot && ((reservation) => persistence.reserveBookingSlot!(reservation)),
    claimEmailReminder:
      persistence.claimEmailReminder &&
      (async (claim) => {
        await fence.whenOpen();
        return persistence.claimEmailReminder!(claim);
      }),
    load: () => persistence.load(),
    close:
      persistence.close &&
      (() => {
        fence.release();
        return persistence.close!();
      }),
    flush: persistence.flush && (() => persistence.flush!()),
  };
};

export const fenceSchedulingPersistence = (
  persistence: SchedulingPersistence,
  fence: PersistenceFence,
): SchedulingPersistence => {
  if (persistence.flush) fence.addFlusher(() => persistence.flush!());
  return {
    save: (snapshot) => fence.defer(() => persistence.save(snapshot)),
    load: () => persistence.load(),
    close:
      persistence.close &&
      (() => {
        fence.release();
        return persistence.close!();
      }),
    flush: persistence.flush && (() => persistence.flush!()),
  };
};

export const fenceScheduledWebinarPersistence = (
  persistence: ScheduledWebinarPersistence,
  fence: PersistenceFence,
): ScheduledWebinarPersistence => ({
  save: (snapshot) => void fence.defer(() => persistence.save(snapshot)),
  saveChanged: persistence.saveChanged && ((webinars) => void fence.defer(() => persistence.saveChanged!(webinars))),
  deleteIds: persistence.deleteIds && ((ids) => void fence.defer(() => persistence.deleteIds!(ids))),
  load: () => persistence.load(),
  close:
    persistence.close &&
    (() => {
      fence.release();
      persistence.close!();
    }),
});
