import type {
  ChatMessageReaction,
  ChatReactData,
  ChatReactionChangedNotification,
} from "../../../types.js";
import { allowedEmojiReactions } from "../../constants.js";
import { Admin } from "../../../config/classes/Admin.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";

type ChatReactResponse =
  | { success: true; reactions: ChatMessageReaction[] }
  | { error: string };

export const registerChatReactionHandlers = (
  context: ConnectionContext,
): void => {
  const { socket } = context;

  socket.on(
    "chat:react",
    (
      data: ChatReactData,
      callback: (response: ChatReactResponse) => void,
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

        const isAdmin = context.currentClient instanceof Admin;

        // Reacting is a chat write, so it honours the chat lock like every
        // other write in chatHandlers...
        if (context.currentRoom.isChatLocked && !isAdmin) {
          respond(callback, { error: "Chat is locked by the host" });
          return;
        }

        // ...and it rides the same kill-switch as floating reactions, so hosts
        // have one mental model for "reactions off".
        if (context.currentRoom.isReactionsDisabled && !isAdmin) {
          respond(callback, { error: "Reactions disabled by host" });
          return;
        }

        if (!takeToken(socket, "chat:react", RATE_LIMITS.chatReaction)) {
          respond(callback, { error: "You are reacting too quickly" });
          return;
        }

        const messageId =
          typeof data?.messageId === "string" ? data.messageId.trim() : "";
        if (!messageId) {
          respond(callback, { error: "Invalid message" });
          return;
        }

        const emoji = typeof data?.emoji === "string" ? data.emoji.trim() : "";
        if (!emoji || !allowedEmojiReactions.has(emoji)) {
          respond(callback, { error: "Invalid reaction" });
          return;
        }

        const result = context.currentRoom.toggleChatMessageReaction(
          messageId,
          context.currentClient.id,
          emoji,
        );

        if (!result.ok) {
          respond(callback, {
            error:
              result.reason === "too-many-reactions"
                ? "This message has too many reactions"
                : "Message not found",
          });
          return;
        }

        const notification: ChatReactionChangedNotification = {
          messageId,
          reactions: result.reactions,
          roomId: context.currentRoom.id,
        };

        // Everyone else gets the broadcast; the reactor gets the same
        // authoritative set back through the ack, so both paths agree.
        socket
          .to(context.currentRoom.channelId)
          .emit("chat:reactionChanged", notification);
        respond(callback, { success: true, reactions: result.reactions });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};
