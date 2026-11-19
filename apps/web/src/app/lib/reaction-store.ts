import type { ReactionEvent } from "./types";

export interface ReactionStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ReactionEvent[];
  setVisibleLimit: (limit: number) => void;
  add: (event: ReactionEvent) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const getReactionRenderLimit = (participantCount: number) => {
  if (participantCount >= 36) return 8;
  if (participantCount >= 20) return 12;
  return 20;
};

type ScheduleReactionStoreFlush = (flush: () => void) => void;

const scheduleReactionStoreFlush: ScheduleReactionStoreFlush = (flush) => {
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    window.requestAnimationFrame(() => flush());
    return;
  }
  queueMicrotask(flush);
};

export function createReactionStore(
  maxReactions: number,
  scheduleFlush: ScheduleReactionStoreFlush = scheduleReactionStoreFlush,
): ReactionStore {
  let snapshot: ReactionEvent[] = [];
  let visibleLimit = maxReactions;
  const listeners = new Set<() => void>();
  let flushScheduled = false;

  const emit = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    scheduleFlush(() => {
      flushScheduled = false;
      for (const listener of listeners) listener();
    });
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    setVisibleLimit(limit) {
      const nextLimit = Math.min(
        maxReactions,
        Math.max(0, Math.floor(Number.isFinite(limit) ? limit : maxReactions)),
      );
      if (nextLimit === visibleLimit) return;
      visibleLimit = nextLimit;
      if (snapshot.length <= visibleLimit) return;
      snapshot = visibleLimit === 0 ? [] : snapshot.slice(-visibleLimit);
      emit();
    },
    add(event) {
      if (visibleLimit === 0) return;
      const next = [...snapshot, event];
      snapshot =
        next.length > visibleLimit ? next.slice(-visibleLimit) : next;
      emit();
    },
    remove(id) {
      if (!snapshot.some((item) => item.id === id)) return;
      snapshot = snapshot.filter((item) => item.id !== id);
      emit();
    },
    clear() {
      if (snapshot.length === 0) return;
      snapshot = [];
      emit();
    },
  };
}
