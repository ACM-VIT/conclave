import type { ChatMessage, ChatMessageReaction } from "./types";
import { MAX_REACTIONS_PER_CHAT_MESSAGE } from "./types";

/**
 * Mirrors `Room.toggleChatMessageReaction` on the SFU so the optimistic update
 * matches what the server will echo back. The server stays authoritative — this
 * only has to be right often enough that the chip doesn't visibly flicker.
 */
export const applyLocalReactionToggle = (
  reactions: ChatMessageReaction[] | undefined,
  emoji: string,
  userId: string,
): ChatMessageReaction[] | undefined => {
  const current = reactions ?? [];
  const existing = current.find((reaction) => reaction.emoji === emoji);

  let next: ChatMessageReaction[];
  if (existing) {
    next = current.map((reaction) =>
      reaction.emoji === emoji
        ? {
            ...reaction,
            userIds: reaction.userIds.includes(userId)
              ? reaction.userIds.filter((id) => id !== userId)
              : [...reaction.userIds, userId],
          }
        : reaction,
    );
  } else {
    if (current.length >= MAX_REACTIONS_PER_CHAT_MESSAGE) {
      return reactions;
    }
    next = [...current, { emoji, userIds: [userId] }];
  }

  const remaining = next.filter((reaction) => reaction.userIds.length > 0);
  return remaining.length > 0 ? remaining : undefined;
};

export interface RenderableChatReaction {
  emoji: string;
  count: number;
  reactedByMe: boolean;
  /**
   * Everyone who reacted, in the order the server holds them. Kept alongside
   * the count so the chip tooltip and the reaction viewer can name people
   * without reaching back into the raw wire shape.
   */
  reactorIds: string[];
}

/** Collapse the wire shape into what a chip row needs to render. */
export const toRenderableReactions = (
  reactions: ChatMessageReaction[] | undefined,
  currentUserId: string,
): RenderableChatReaction[] =>
  (reactions ?? [])
    .filter((reaction) => reaction.userIds.length > 0)
    .map((reaction) => ({
      emoji: reaction.emoji,
      count: reaction.userIds.length,
      reactedByMe: reaction.userIds.includes(currentUserId),
      reactorIds: reaction.userIds,
    }));

/**
 * "Alice, Bob and 2 others reacted with 👍" — the chip tooltip line.
 *
 * Names the first few reactors and counts the rest. The current user is
 * rendered as "You" and sorted first, matching how chat labels own messages.
 */
export const formatReactorSummary = (
  reaction: RenderableChatReaction,
  currentUserId: string,
  resolveDisplayName: (userId: string) => string,
  maxNames = 3,
): string => {
  const ordered = [
    ...reaction.reactorIds.filter((id) => id === currentUserId),
    ...reaction.reactorIds.filter((id) => id !== currentUserId),
  ];
  const names = ordered.map((id) =>
    id === currentUserId ? "You" : resolveDisplayName(id),
  );

  if (names.length === 0) return `Reacted with ${reaction.emoji}`;

  const shown = names.slice(0, maxNames);
  const remaining = names.length - shown.length;

  let subject: string;
  if (remaining > 0) {
    subject = `${shown.join(", ")} and ${remaining} other${
      remaining === 1 ? "" : "s"
    }`;
  } else if (shown.length > 1) {
    subject = `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  } else {
    subject = shown[0] ?? "";
  }

  return `${subject} reacted with ${reaction.emoji}`;
};

/**
 * Direct messages are never retained in room chat history, so the SFU has no
 * object to hang a reaction on. Hide the affordance rather than letting the
 * click fail with "Message not found".
 */
export const canReactToChatMessage = (message: ChatMessage): boolean =>
  !message.isDirect;
