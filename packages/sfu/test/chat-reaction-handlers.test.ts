import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
import type { Room } from "../config/classes/Room.js";
import type { ConnectionContext } from "../server/socket/context.js";
import type { SfuState } from "../server/state.js";
import { registerChatReactionHandlers } from "../server/socket/handlers/chatReactionHandlers.js";
import type { ChatMessageReaction } from "../types.js";

type SocketHandler = (...args: never[]) => unknown;

type ReactResponse =
  | { success: true; reactions: ChatMessageReaction[] }
  | { error: string };

type ToggleResult =
  | { ok: true; reactions: ChatMessageReaction[] }
  | { ok: false; reason: "not-found" | "too-many-reactions" };

/**
 * Binds registerChatReactionHandlers to a mock socket/context so the gating and
 * validation — the security-relevant half of the feature — is exercised end to
 * end, not just Room.toggleChatMessageReaction (covered separately).
 *
 * The client is a plain object, deliberately NOT an Admin instance, so the
 * host bypass for chat-lock / kill-switch never applies: this is the ordinary
 * participant path that must be gated.
 */
const makeHarness = (
  options: {
    isObserver?: boolean;
    isChatLocked?: boolean;
    isReactionsDisabled?: boolean;
    toggleResult?: ToggleResult;
  } = {},
) => {
  const handlers = new Map<string, SocketHandler>();
  const roomBroadcast = { emit: vi.fn() };
  const socket = {
    on: vi.fn((event: string, handler: SocketHandler) => {
      handlers.set(event, handler);
      return socket;
    }),
    emit: vi.fn(),
    to: vi.fn().mockReturnValue(roomBroadcast),
    connected: true,
  } as unknown as Socket;

  const toggleChatMessageReaction = vi
    .fn<(...args: unknown[]) => ToggleResult>()
    .mockReturnValue(
      options.toggleResult ?? {
        ok: true,
        reactions: [{ emoji: "👍", userIds: ["me"] }],
      },
    );

  const room = {
    id: "room",
    channelId: "instance:room",
    isChatLocked: options.isChatLocked ?? false,
    isReactionsDisabled: options.isReactionsDisabled ?? false,
    toggleChatMessageReaction,
  } as unknown as Room;

  const currentClient = {
    id: "me",
    isObserver: options.isObserver ?? false,
  };

  const context = {
    socket,
    io: {} as ConnectionContext["io"],
    state: { rooms: new Map() } as unknown as SfuState,
    currentRoom: room,
    currentClient,
    pendingRoomId: null,
    pendingRoomChannelId: null,
    pendingUserKey: null,
    currentUserKey: null,
    activeConclaveAnswers: new Map(),
    adminHandlersRegistered: false,
  } as unknown as ConnectionContext;

  registerChatReactionHandlers(context);
  const react = handlers.get("chat:react") as unknown as (
    data: unknown,
    callback: (response: ReactResponse) => void,
  ) => void;

  return { react, toggleChatMessageReaction, roomBroadcast, socket };
};

const call = (
  react: (data: unknown, cb: (r: ReactResponse) => void) => void,
  data: unknown,
): ReactResponse => {
  let response: ReactResponse | undefined;
  react(data, (r) => {
    response = r;
  });
  if (!response) throw new Error("handler did not respond");
  return response;
};

describe("registerChatReactionHandlers", () => {
  it("toggles, acks the authoritative set, and broadcasts to the room", () => {
    const { react, toggleChatMessageReaction, roomBroadcast } = makeHarness();

    const response = call(react, { messageId: "m1", emoji: "👍" });

    expect(response).toEqual({
      success: true,
      reactions: [{ emoji: "👍", userIds: ["me"] }],
    });
    expect(toggleChatMessageReaction).toHaveBeenCalledWith("m1", "me", "👍");
    expect(roomBroadcast.emit).toHaveBeenCalledWith("chat:reactionChanged", {
      messageId: "m1",
      reactions: [{ emoji: "👍", userIds: ["me"] }],
      roomId: "room",
    });
  });

  it("rejects watch-only observers before any mutation", () => {
    const { react, toggleChatMessageReaction, roomBroadcast } = makeHarness({
      isObserver: true,
    });

    const response = call(react, { messageId: "m1", emoji: "👍" });

    expect(response).toEqual({
      error: "Watch-only attendees cannot send reactions",
    });
    expect(toggleChatMessageReaction).not.toHaveBeenCalled();
    expect(roomBroadcast.emit).not.toHaveBeenCalled();
  });

  it("rejects a non-admin while chat is locked", () => {
    const { react, toggleChatMessageReaction } = makeHarness({
      isChatLocked: true,
    });

    const response = call(react, { messageId: "m1", emoji: "👍" });

    expect(response).toEqual({ error: "Chat is locked by the host" });
    expect(toggleChatMessageReaction).not.toHaveBeenCalled();
  });

  it("rejects a non-admin while reactions are disabled", () => {
    const { react, toggleChatMessageReaction } = makeHarness({
      isReactionsDisabled: true,
    });

    const response = call(react, { messageId: "m1", emoji: "👍" });

    expect(response).toEqual({ error: "Reactions disabled by host" });
    expect(toggleChatMessageReaction).not.toHaveBeenCalled();
  });

  it("rejects an empty or whitespace message id", () => {
    const { react, toggleChatMessageReaction } = makeHarness();

    expect(call(react, { messageId: "   ", emoji: "👍" })).toEqual({
      error: "Invalid message",
    });
    expect(call(react, { emoji: "👍" })).toEqual({ error: "Invalid message" });
    expect(toggleChatMessageReaction).not.toHaveBeenCalled();
  });

  it("rejects an emoji outside the allowlist", () => {
    const { react, toggleChatMessageReaction } = makeHarness();

    expect(call(react, { messageId: "m1", emoji: "🚀" })).toEqual({
      error: "Invalid reaction",
    });
    expect(call(react, { messageId: "m1", emoji: 42 })).toEqual({
      error: "Invalid reaction",
    });
    expect(toggleChatMessageReaction).not.toHaveBeenCalled();
  });

  it("surfaces a friendly error when the message is gone", () => {
    const { react } = makeHarness({
      toggleResult: { ok: false, reason: "not-found" },
    });

    expect(call(react, { messageId: "missing", emoji: "👍" })).toEqual({
      error: "Message not found",
    });
  });

  it("surfaces a friendly error when the message is saturated", () => {
    const { react } = makeHarness({
      toggleResult: { ok: false, reason: "too-many-reactions" },
    });

    expect(call(react, { messageId: "m1", emoji: "👍" })).toEqual({
      error: "This message has too many reactions",
    });
  });

  it("rate-limits a burst once the bucket is drained", () => {
    const { react } = makeHarness();

    // Bucket starts full at capacity 10; the 11th call in a tight loop (no
    // meaningful refill) must be turned away.
    const responses = Array.from({ length: 11 }, () =>
      call(react, { messageId: "m1", emoji: "👍" }),
    );

    expect(responses.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, () => ({
        success: true,
        reactions: [{ emoji: "👍", userIds: ["me"] }],
      })),
    );
    expect(responses[10]).toEqual({ error: "You are reacting too quickly" });
  });
});
