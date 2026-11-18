import type { ChatMessage, ChatMessageReaction } from "./types";
import { MAX_REACTIONS_PER_CHAT_MESSAGE } from "./types";

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
  reactorIds: string[];
}

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

export const canReactToChatMessage = (message: ChatMessage): boolean =>
  !message.isDirect &&
  !message.id.startsWith("local-") &&
  !message.id.startsWith("optimistic-");
