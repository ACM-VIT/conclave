import { describe, expect, it } from "vitest";
import { Room } from "../config/classes/Room.js";
import type { ChatMessage } from "../types.js";
import { MAX_REACTIONS_PER_CHAT_MESSAGE } from "../types.js";

const message = (id: string): ChatMessage => ({
  id,
  userId: "author",
  displayName: "Author",
  content: `message ${id}`,
  timestamp: 1_000,
});

/**
 * Constructing a real Room needs a mediasoup router, so bind the reaction logic
 * to the only state it actually touches. This still exercises the shipped
 * implementation rather than a reimplementation of it.
 */
const roomWithHistory = (messages: ChatMessage[]): Room => {
  const room = Object.create(Room.prototype) as Room;
  (room as unknown as { recentChatMessages: ChatMessage[] }).recentChatMessages =
    messages;
  return room;
};

describe("Room.toggleChatMessageReaction", () => {
  it("adds, then removes, the same user's reaction", () => {
    const messages = [message("m1")];
    const room = roomWithHistory(messages);

    expect(room.toggleChatMessageReaction("m1", "u1", "👍")).toEqual({
      ok: true,
      reactions: [{ emoji: "👍", userIds: ["u1"] }],
    });

    // Toggling off must clear the emoji entirely rather than leave a zero
    // count, and must drop `reactions` so the field stays absent-when-empty.
    expect(room.toggleChatMessageReaction("m1", "u1", "👍")).toEqual({
      ok: true,
      reactions: [],
    });
    expect(messages[0].reactions).toBeUndefined();
  });

  it("accumulates distinct users under one emoji", () => {
    const room = roomWithHistory([message("m1")]);

    room.toggleChatMessageReaction("m1", "u1", "👍");
    const result = room.toggleChatMessageReaction("m1", "u2", "👍");

    expect(result).toEqual({
      ok: true,
      reactions: [{ emoji: "👍", userIds: ["u1", "u2"] }],
    });
  });

  it("removes only the toggling user, leaving other reactors intact", () => {
    const room = roomWithHistory([message("m1")]);

    room.toggleChatMessageReaction("m1", "u1", "👍");
    room.toggleChatMessageReaction("m1", "u2", "👍");
    const result = room.toggleChatMessageReaction("m1", "u1", "👍");

    expect(result).toEqual({
      ok: true,
      reactions: [{ emoji: "👍", userIds: ["u2"] }],
    });
  });

  it("keeps separate emoji independent on the same message", () => {
    const room = roomWithHistory([message("m1")]);

    room.toggleChatMessageReaction("m1", "u1", "👍");
    const result = room.toggleChatMessageReaction("m1", "u1", "🎉");

    expect(result).toEqual({
      ok: true,
      reactions: [
        { emoji: "👍", userIds: ["u1"] },
        { emoji: "🎉", userIds: ["u1"] },
      ],
    });
  });

  it("reports messages missing from history, which is how DMs are rejected", () => {
    const room = roomWithHistory([message("m1")]);

    expect(room.toggleChatMessageReaction("nope", "u1", "👍")).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("caps distinct emoji per message", () => {
    const room = roomWithHistory([message("m1")]);
    const emojis = ["👍", "👏", "😂", "❤️", "🎉", "😮", "😢", "🤔"];

    // Fill to the cap using distinct emoji, repeating reactors as needed.
    for (let i = 0; i < MAX_REACTIONS_PER_CHAT_MESSAGE; i += 1) {
      const result = room.toggleChatMessageReaction(
        "m1",
        `u${i}`,
        // Past the allowlist length, synthesize unique strings; the cap is
        // enforced by Room, and emoji validity is the handler's job.
        emojis[i] ?? `x${i}`,
      );
      expect(result.ok).toBe(true);
    }

    expect(room.toggleChatMessageReaction("m1", "u99", "🆕")).toEqual({
      ok: false,
      reason: "too-many-reactions",
    });

    // At the cap, toggling an *existing* emoji must still work — the limit is
    // on distinct emoji, not on participation.
    expect(room.toggleChatMessageReaction("m1", "u99", "👍")).toMatchObject({
      ok: true,
    });
  });

  it("stores reactions on the retained message so history replay carries them", () => {
    const messages = [message("m1"), message("m2")];
    const room = roomWithHistory(messages);

    room.toggleChatMessageReaction("m2", "u1", "❤️");

    expect(room.getChatHistorySnapshot()).toEqual([
      messages[0],
      expect.objectContaining({
        id: "m2",
        reactions: [{ emoji: "❤️", userIds: ["u1"] }],
      }),
    ]);
  });
});
