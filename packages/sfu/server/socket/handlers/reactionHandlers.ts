import type { ReactionNotification, SendReactionData } from "../../../types.js";
import { allowedEmojiReactions } from "../../constants.js";
import { isValidReactionAssetPath } from "../../reactions.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";

const MAX_REACTION_LABEL_LENGTH = 64;

const normalizeReactionLabel = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const label = value.trim();
  if (!label) {
    return undefined;
  }
  return label.slice(0, MAX_REACTION_LABEL_LENGTH);
};

export const registerReactionHandlers = (
  context: ConnectionContext,
): void => {
  const { socket } = context;

  socket.on(
    "sendReaction",
    (
      data: SendReactionData,
      callback: (response: { success: boolean } | { error: string }) => void,
    ) => {
      try {
        if (!context.currentClient || !context.currentRoom) {
          respond(callback, { error: "Not in a room" });
          return;
        }
        if (context.currentClient.isObserver) {
          respond(callback, {
            error: "Watch-only attendees cannot send reactions",
          });
          return;
        }

        // Throttle: drop over-budget reactions (ack an error, do not broadcast).
        if (!takeToken(socket, "sendReaction", RATE_LIMITS.reaction)) {
          respond(callback, { error: "You are reacting too quickly" });
          return;
        }

        if (data.kind === "asset" && typeof data.value === "string") {
          if (!isValidReactionAssetPath(data.value)) {
            respond(callback, { error: "Invalid reaction asset" });
            return;
          }

          const reaction: ReactionNotification = {
            userId: context.currentClient.id,
            kind: "asset",
            value: data.value,
            label: normalizeReactionLabel(data.label),
            timestamp: Date.now(),
            roomId: context.currentRoom.id,
          };

          socket.to(context.currentRoom.channelId).emit("reaction", reaction);
          respond(callback, { success: true });
          return;
        }

        const emoji =
          data.kind === "emoji" && typeof data.value === "string"
            ? data.value.trim()
            : data.emoji?.trim();

        if (!emoji || !allowedEmojiReactions.has(emoji)) {
          respond(callback, { error: "Invalid reaction" });
          return;
        }

        const reaction: ReactionNotification = {
          userId: context.currentClient.id,
          kind: "emoji",
          value: emoji,
          label: normalizeReactionLabel(data.label),
          timestamp: Date.now(),
          roomId: context.currentRoom.id,
        };

        socket.to(context.currentRoom.channelId).emit("reaction", reaction);
        respond(callback, { success: true });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};
