import type { ChatMessage, SendChatData } from "../../../types.js";
import { Admin } from "../../../config/classes/Admin.js";
import { Logger } from "../../../utilities/loggers.js";
import type Room from "../../../config/classes/Room.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";

const DIRECT_MESSAGE_PATTERN = /^@(\S+)\s+([\s\S]+)$/;
const TRAILING_MENTION_PUNCTUATION_PATTERN = /[,:;.!?]+$/;

const fallbackDisplayNameFromUserId = (userId: string): string =>
  userId.split("#")[0]?.split("@")[0] || userId;

const normalizeLookupToken = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");

const parseDirectMessageIntent = (
  content: string,
):
  | { targetToken: string; messageBody: string }
  | { error: string }
  | null => {
  const trimmed = content.trim();
  if (!trimmed.startsWith("@")) {
    return null;
  }

  const match = trimmed.match(DIRECT_MESSAGE_PATTERN);
  if (!match) {
    return {
      error: "Use private messages as @username <message>.",
    };
  }

  const rawTarget = match[1]?.trim() || "";
  const messageBody = match[2]?.trim() || "";
  const targetToken = rawTarget.replace(TRAILING_MENTION_PUNCTUATION_PATTERN, "");

  if (!targetToken || !messageBody) {
    return {
      error: "Use private messages as @username <message>.",
    };
  }

  return { targetToken, messageBody };
};

const resolveDirectMessageTarget = (
  room: Room,
  senderUserId: string,
  targetToken: string,
): { userId: string; displayName: string } | { error: string } => {
  const normalizedTargetToken = normalizeLookupToken(targetToken);
  if (!normalizedTargetToken) {
    return { error: "Invalid private message target." };
  }

  const senderAliases = [
    senderUserId,
    senderUserId.split("#")[0] || senderUserId,
    (senderUserId.split("#")[0] || senderUserId).split("@")[0] || senderUserId,
    room.getDisplayNameForUser(senderUserId) || fallbackDisplayNameFromUserId(senderUserId),
  ].map(normalizeLookupToken);

  if (senderAliases.includes(normalizedTargetToken)) {
    return { error: "You cannot private message yourself." };
  }

  const matches: { userId: string; displayName: string }[] = [];

  for (const [candidateUserId] of room.clients.entries()) {
    if (candidateUserId === senderUserId) continue;

    const displayName =
      room.getDisplayNameForUser(candidateUserId) ||
      fallbackDisplayNameFromUserId(candidateUserId);
    const userIdWithoutSession = candidateUserId.split("#")[0] || candidateUserId;
    const handle = userIdWithoutSession.split("@")[0] || userIdWithoutSession;

    const aliases = [
      candidateUserId,
      userIdWithoutSession,
      handle,
      displayName,
    ].map(normalizeLookupToken);

    if (aliases.includes(normalizedTargetToken)) {
      matches.push({
        userId: candidateUserId,
        displayName,
      });
    }
  }

  if (matches.length === 0) {
    return { error: `User "${targetToken}" not found for private message.` };
  }

  if (matches.length > 1) {
    return {
      error: `Multiple users match "${targetToken}". Use a more specific username.`,
    };
  }

  return matches[0];
};

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

        const room = context.currentRoom;
        const sender = context.currentClient;

        if (context.currentClient.isObserver) {
          respond(callback, {
            error: "Watch-only attendees cannot send chat messages",
          });
          return;
        }
        if (
          room.isChatLocked &&
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

        const directMessageIntent = parseDirectMessageIntent(content);
        if (directMessageIntent && "error" in directMessageIntent) {
          respond(callback, { error: directMessageIntent.error });
          return;
        }

        if (directMessageIntent && !room.isDmEnabled) {
          respond(callback, {
            error: "Private messages are disabled by the host.",
          });
          return;
        }

        let dmTarget: { userId: string; displayName: string } | null = null;
        if (directMessageIntent) {
          const resolvedTarget = resolveDirectMessageTarget(
            room,
            sender.id,
            directMessageIntent.targetToken,
          );
          if ("error" in resolvedTarget) {
            respond(callback, { error: resolvedTarget.error });
            return;
          }
          dmTarget = resolvedTarget;
        }

        const messageContent = directMessageIntent
          ? directMessageIntent.messageBody
          : content;

        if (
          !directMessageIntent &&
          (messageContent.toLowerCase().startsWith("/tts ") ||
            messageContent.toLowerCase() === "/tts")
        ) {
          if (room.isTtsDisabled) {
            respond(callback, {
              error: "TTS is disabled by the host in this room.",
            });
            return;
          }
        }

        if (messageContent.length > 1000) {
          respond(callback, {
            error: "Message too long (max 1000 characters)",
          });
          return;
        }

        const displayName =
          room.getDisplayNameForUser(sender.id) ||
          sender.id.split("#")[0]?.split("@")[0] ||
          "Anonymous";

        const message: ChatMessage = {
          id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          userId: sender.id,
          displayName,
          content: messageContent,
          timestamp: Date.now(),
          isDirect: Boolean(dmTarget),
          dmTargetUserId: dmTarget?.userId,
          dmTargetDisplayName: dmTarget?.displayName,
        };

        if (dmTarget) {
          const targetClient = room.getClient(dmTarget.userId);
          if (!targetClient) {
            respond(callback, { error: "Private message target is no longer available." });
            return;
          }

          targetClient.socket.emit("chatMessage", message);
          Logger.info(
            `DM in room ${room.id}: ${displayName} -> ${dmTarget.displayName}: ${messageContent.substring(
              0,
              50,
            )}`,
          );
        } else {
          socket.to(room.channelId).emit("chatMessage", message);
          Logger.info(
            `Chat in room ${room.id}: ${displayName}: ${messageContent.substring(
              0,
              50,
            )}`,
          );
        }

        respond(callback, { success: true, message });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );
};
