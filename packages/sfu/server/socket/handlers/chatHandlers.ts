import type { ChatMessage, SendChatData } from "../../../types.js";
import { Admin } from "../../../config/classes/Admin.js";
import { Logger } from "../../../utilities/loggers.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";

export const registerChatHandlers = (context: ConnectionContext): void => {
  const { socket } = context;

  socket.on(
    "sendChat",
    (
      data: SendChatData,
      callback: (
        response:
          | { success: boolean; message?: ChatMessage }
          | { error: string },
      ) => void,
    ) => {
      try {
        if (!context.currentClient || !context.currentRoom) {
          respond(callback, { error: "Not in a room" });
          return;
        }
        if (context.currentClient.isObserver) {
          respond(callback, {
            error: "Watch-only attendees cannot send chat messages",
          });
          return;
        }
        if (
          context.currentRoom.isChatLocked &&
          !(context.currentClient instanceof Admin)
        ) {
          respond(callback, { error: "Chat is locked by the host" });
          return;
        }

        const content = data.content?.trim();
        if (!content || content.length === 0) {
          respond(callback, { error: "Message cannot be empty" });
          return;
        }

        if (
          content.toLowerCase().startsWith("/tts ") ||
          content.toLowerCase() === "/tts"
        ) {
          if (context.currentRoom.isTtsDisabled) {
            respond(callback, {
              error: "TTS is disabled by the host in this room.",
            });
            return;
          }
        }

        if (content.length > 1000) {
          respond(callback, {
            error: "Message too long (max 1000 characters)",
          });
          return;
        }

        const displayName =
          context.currentRoom.getDisplayNameForUser(context.currentClient.id) ||
          context.currentClient.id.split("#")[0]?.split("@")[0] ||
          "Anonymous";

        const message: ChatMessage = {
          id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          userId: context.currentClient.id,
          displayName,
          content,
          timestamp: Date.now(),
        };

        socket.to(context.currentRoom.channelId).emit("chatMessage", message);
        Logger.info(
          `Chat in room ${context.currentRoom.id}: ${displayName}: ${content.substring(
            0,
            50,
          )}`,
        );

        respond(callback, { success: true, message });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};
