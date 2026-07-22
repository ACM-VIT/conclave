import { describe, expect, it } from "vitest";
import {
  applyLocalReactionToggle,
  canReactToChatMessage,
  formatReactorSummary,
  toRenderableReactions,
} from "../src/app/lib/chat-reactions";
import type { ChatMessage } from "../src/app/lib/types";

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  userId: "author",
  displayName: "Author",
  content: "hello",
  timestamp: 1_000,
  ...overrides,
});

describe("applyLocalReactionToggle", () => {
  it("adds a reaction to a message that has none", () => {
    expect(applyLocalReactionToggle(undefined, "👍", "me")).toEqual([
      { emoji: "👍", userIds: ["me"] },
    ]);
  });

  it("removes our reaction and drops the emoji when we were the only reactor", () => {
    const reactions = [{ emoji: "👍", userIds: ["me"] }];
    expect(applyLocalReactionToggle(reactions, "👍", "me")).toBeUndefined();
  });

  it("leaves other reactors in place when we un-react", () => {
    const reactions = [{ emoji: "👍", userIds: ["me", "them"] }];
    expect(applyLocalReactionToggle(reactions, "👍", "me")).toEqual([
      { emoji: "👍", userIds: ["them"] },
    ]);
  });

  it("does not mutate the input array or its entries", () => {
    const reactions = [{ emoji: "👍", userIds: ["them"] }];
    const snapshot = structuredClone(reactions);

    applyLocalReactionToggle(reactions, "👍", "me");

    // React state updates are shallow-compared, so mutating here would make
    // the optimistic update invisible until the server echo landed.
    expect(reactions).toEqual(snapshot);
  });
});

describe("toRenderableReactions", () => {
  it("derives counts and flags our own participation", () => {
    const reactions = [
      { emoji: "👍", userIds: ["me", "them"] },
      { emoji: "🎉", userIds: ["them"] },
    ];

    expect(toRenderableReactions(reactions, "me")).toEqual([
      {
        emoji: "👍",
        count: 2,
        reactedByMe: true,
        reactorIds: ["me", "them"],
      },
      { emoji: "🎉", count: 1, reactedByMe: false, reactorIds: ["them"] },
    ]);
  });

  it("drops emoji nobody is reacting with so no chip renders a zero", () => {
    const reactions = [{ emoji: "👍", userIds: [] }];
    expect(toRenderableReactions(reactions, "me")).toEqual([]);
  });

  it("treats a message with no reactions as an empty row", () => {
    expect(toRenderableReactions(undefined, "me")).toEqual([]);
  });
});

describe("formatReactorSummary", () => {
  const names: Record<string, string> = {
    u1: "Alice",
    u2: "Bob",
    u3: "Carol",
    u4: "Dave",
    u5: "Erin",
  };
  const resolve = (userId: string) => names[userId] ?? "Someone";
  const reaction = (reactorIds: string[]) => ({
    emoji: "👍",
    count: reactorIds.length,
    reactedByMe: reactorIds.includes("me"),
    reactorIds,
  });

  it("names a single reactor", () => {
    expect(formatReactorSummary(reaction(["u1"]), "me", resolve)).toBe(
      "Alice reacted with 👍",
    );
  });

  it("joins two reactors with 'and' rather than a trailing comma", () => {
    expect(formatReactorSummary(reaction(["u1", "u2"]), "me", resolve)).toBe(
      "Alice and Bob reacted with 👍",
    );
  });

  it("counts the overflow past the name limit", () => {
    expect(
      formatReactorSummary(reaction(["u1", "u2", "u3", "u4", "u5"]), "me", resolve),
    ).toBe("Alice, Bob, Carol and 2 others reacted with 👍");
  });

  it("uses the singular for exactly one extra reactor", () => {
    expect(
      formatReactorSummary(reaction(["u1", "u2", "u3", "u4"]), "me", resolve),
    ).toBe("Alice, Bob, Carol and 1 other reacted with 👍");
  });

  it("renders the current user as 'You' and sorts them first", () => {
    expect(formatReactorSummary(reaction(["u1", "me"]), "me", resolve)).toBe(
      "You and Alice reacted with 👍",
    );
  });

  it("falls back for reactors who have left the room", () => {
    expect(formatReactorSummary(reaction(["gone"]), "me", resolve)).toBe(
      "Someone reacted with 👍",
    );
  });

  it("does not render a leading space when there are no reactors", () => {
    expect(formatReactorSummary(reaction([]), "me", resolve)).toBe(
      "Reacted with 👍",
    );
  });
});

describe("canReactToChatMessage", () => {
  it("allows broadcast messages, which are the ones kept in room history", () => {
    expect(canReactToChatMessage(message())).toBe(true);
  });

  it("blocks direct messages, which the SFU never retains", () => {
    expect(canReactToChatMessage(message({ isDirect: true }))).toBe(false);
  });

  it("blocks locally generated notices (local-* ids), which have no server object", () => {
    expect(
      canReactToChatMessage(
        message({ id: "local-123-abc", userId: "system" }),
      ),
    ).toBe(false);
  });

  it("blocks still-unacked optimistic sends (optimistic-* ids)", () => {
    expect(
      canReactToChatMessage(message({ id: "optimistic-123-abc" })),
    ).toBe(false);
  });
});
