import { z } from "zod";
import type { ControlPlaneStore } from "./controlPlane/store.js";

// A backup hold drains active transactions and queues later commits. Reads
// never wait on the fence. Only the holder can renew or release its lease,
// and the hard deadline keeps a lost backup from blocking writes indefinitely.

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

export const fenceControlPlane = (
  store: ControlPlaneStore,
  fence: PersistenceFence,
): ControlPlaneStore => ({
  mode: store.mode,
  read: (query) => store.read(query),
  commit: (command) => fence.run(() => store.commit(command)),
  close: () => store.close(),
});
