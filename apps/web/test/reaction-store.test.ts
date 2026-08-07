import { describe, expect, it, vi } from "vitest";
import {
  createReactionStore,
  getReactionRenderLimit,
} from "../src/app/lib/reaction-store";
import type { ReactionEvent } from "../src/app/lib/types";

const makeReaction = (id: string): ReactionEvent => ({
  id,
  userId: `user-${id}`,
  kind: "emoji",
  value: "👍",
  label: "Thumbs up",
  timestamp: 1,
  lane: 50,
});

describe("reaction store", () => {
  it("reduces composited reactions as the call gets larger", () => {
    expect(getReactionRenderLimit(12)).toBe(20);
    expect(getReactionRenderLimit(24)).toBe(12);
    expect(getReactionRenderLimit(48)).toBe(8);
  });

  it("coalesces a burst into one subscriber notification", () => {
    const pendingFlushes: Array<() => void> = [];
    const store = createReactionStore(30, (flush) => {
      pendingFlushes.push(flush);
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.add(makeReaction("one"));
    store.add(makeReaction("two"));
    store.add(makeReaction("three"));

    expect(store.getSnapshot()).toHaveLength(3);
    expect(pendingFlushes).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();

    pendingFlushes.shift()?.();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps only the newest reactions while a notification is pending", () => {
    const pendingFlushes: Array<() => void> = [];
    const store = createReactionStore(2, (flush) => {
      pendingFlushes.push(flush);
    });

    store.add(makeReaction("one"));
    store.add(makeReaction("two"));
    store.add(makeReaction("three"));

    expect(store.getSnapshot().map((reaction) => reaction.id)).toEqual([
      "two",
      "three",
    ]);
    expect(pendingFlushes).toHaveLength(1);
  });

  it("permanently drops reactions excluded by the visible limit", () => {
    const store = createReactionStore(30, () => {});
    store.setVisibleLimit(2);

    store.add(makeReaction("one"));
    store.add(makeReaction("two"));
    store.add(makeReaction("three"));
    store.remove("three");

    expect(store.getSnapshot().map((reaction) => reaction.id)).toEqual(["two"]);
  });

  it("prunes stored reactions when the visible limit shrinks", () => {
    const store = createReactionStore(30, () => {});
    store.add(makeReaction("one"));
    store.add(makeReaction("two"));
    store.add(makeReaction("three"));

    store.setVisibleLimit(2);

    expect(store.getSnapshot().map((reaction) => reaction.id)).toEqual([
      "two",
      "three",
    ]);
  });
});
