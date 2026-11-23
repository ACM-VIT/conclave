import { z } from "zod";
import type { ScheduledMeetingPersistence } from "./scheduledMeetings.js";
import type { ScheduledWebinarPersistence } from "./scheduledWebinars.js";
import type { SchedulingPersistence } from "./scheduling.js";

// A write fence for backups, as a gate in front of every persistence call
// (scheduled meetings, scheduling, webinars, booking locks, reminder claims).
// While it is open, calls start the moment they are made and run side by
// side, each store keeping its own order, so a slow Redis never holds up a
// SQLite save. A backup's hold closes it: later calls queue in the order they
// were made, and the hold answers once every call already under way has
// finished, so the backup copies SQLite and Redis at one point in time. The
// release starts the queued calls in that order. Each caller gets its own
// call's result or error. Only persistence waits on the gate: media and
// signalling never await it, and the services serve from memory.
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

export const createPersistenceFence = (): PersistenceFence => {
  let owner: string | null = null;
  let heldSince = 0;
  let until = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;
  let queued: Array<() => void> = [];
  let drained: Array<() => void> = [];

  const start = <T>(call: () => MaybePromise<T>): Promise<T> => {
    inFlight += 1;
    // Runs the call now; a throw becomes its rejection.
    const running = (async () => call())();
    return running.finally(() => {
      inFlight -= 1;
      if (inFlight > 0) return;
      const idle = drained;
      drained = [];
      idle.forEach((resolve) => resolve());
    });
  };

  const open = (): void => {
    owner = null;
    heldSince = 0;
    until = 0;
    if (timer) clearTimeout(timer);
    timer = null;
    const ready = queued;
    queued = [];
    ready.forEach((begin) => begin());
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
      if (owner === null) heldSince = Date.now();
      owner = who;
      arm(holdMs);
      while (inFlight > 0) await new Promise<void>((resolve) => drained.push(resolve));
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
      if (owner === null && queued.length === 0) return start(call);
      return new Promise((resolve, reject) => {
        queued.push(() => void start(call).then(resolve, reject));
      });
    },
    open,
  };
};

const atCall = <A extends unknown[]>(args: A): A => structuredClone(args);

export const fenceScheduledMeetingPersistence = (
  persistence: ScheduledMeetingPersistence,
  fence: PersistenceFence,
): ScheduledMeetingPersistence => {
  // Each write's promise is that write's own: Redis resolves it once the
  // write landed, so the caller gets its result or error, never another's.
  return {
    save: (...args) => {
      const [snapshot] = atCall(args);
      return fence.run(() => persistence.save(snapshot));
    },
    saveChanged:
      persistence.saveChanged &&
      ((...args) => {
        const [meetings] = atCall(args);
        return fence.run(() => persistence.saveChanged!(meetings));
      }),
    deleteIds:
      persistence.deleteIds &&
      ((...args) => {
        const [ids] = atCall(args);
        return fence.run(() => persistence.deleteIds!(ids));
      }),
    reserveBookingSlot:
      persistence.reserveBookingSlot &&
      ((...args) => {
        const [reservation] = atCall(args);
        return fence.run(() => persistence.reserveBookingSlot!(reservation));
      }),
    // A claim reads what the meeting writes made before it left, so it waits
    // for them to land, failed or not.
    claimEmailReminder:
      persistence.claimEmailReminder &&
      ((...args) => {
        const [claim] = atCall(args);
        return fence.run(async () => {
          if (persistence.flush) await persistence.flush().catch(() => undefined);
          return persistence.claimEmailReminder!(claim);
        });
      }),
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
  save: (...args) => {
    const [snapshot] = atCall(args);
    return fence.run(() => persistence.save(snapshot));
  },
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
  save: (...args) => {
    const [snapshot] = atCall(args);
    return fence.run(() => persistence.save(snapshot));
  },
  saveChanged:
    persistence.saveChanged &&
    ((...args) => {
      const [webinars] = atCall(args);
      return fence.run(() => persistence.saveChanged!(webinars));
    }),
  deleteIds:
    persistence.deleteIds &&
    ((...args) => {
      const [ids] = atCall(args);
      return fence.run(() => persistence.deleteIds!(ids));
    }),
  load: () => persistence.load(),
  close:
    persistence.close &&
    (() => {
      fence.open();
      return fence.run(() => persistence.close!());
    }),
});
