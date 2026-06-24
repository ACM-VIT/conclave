import type {
  ChatGifAttachment,
  ChatMessage,
  ChatReplyPreview,
  SendChatData,
} from "../../../types.js";
import { Admin } from "../../../config/classes/Admin.js";
import { Logger } from "../../../utilities/loggers.js";
import type Room from "../../../config/classes/Room.js";
import type { ConnectionContext } from "../context.js";
import { respond } from "./ack.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";

const AT_DIRECT_MESSAGE_PATTERN = /^@(\S+)\s+([\s\S]+)$/;
const DM_COMMAND_PATTERN = /^\/dm\s+(\S+)\s+([\s\S]+)$/i;
const TRAILING_MENTION_PUNCTUATION_PATTERN = /[,:;.!?]+$/;
const DIRECT_MESSAGE_USAGE_ERROR =
  "Use private messages as @username <message> or /dm <username> <message>.";
const MAX_GIF_TITLE_LENGTH = 140;
const MAX_GIF_URL_LENGTH = 2048;
const MAX_REPLY_CONTENT_LENGTH = 280;
const MAX_REPLY_NAME_LENGTH = 120;
const KLIPY_MEDIA_HOSTS = new Set(["static.klipy.com"]);
const KLIPY_PAGE_HOSTS = new Set(["klipy.com", "www.klipy.com"]);

const fallbackDisplayNameFromUserId = (userId: string): string =>
  userId.split("#")[0]?.split("@")[0] || userId;

const normalizeLookupToken = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");

const normalizeHttpsUrl = (
  value: unknown,
  allowedHosts: Set<string>,
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_GIF_URL_LENGTH) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
};

const normalizeGifDimension = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded > 0 && rounded <= 4096 ? rounded : undefined;
};

const normalizeChatGifAttachment = (
  value: unknown,
): ChatGifAttachment | { error: string } | null => {
  if (!value) return null;
  if (typeof value !== "object") {
    return { error: "Invalid GIF attachment." };
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.source !== "klipy") {
    return { error: "Unsupported GIF provider." };
  }

  const url = normalizeHttpsUrl(candidate.url, KLIPY_MEDIA_HOSTS);
  if (!url) {
    return { error: "Invalid GIF URL." };
  }

  const previewUrl =
    normalizeHttpsUrl(candidate.previewUrl, KLIPY_MEDIA_HOSTS) ?? undefined;
  const pageUrl =
    normalizeHttpsUrl(candidate.pageUrl, KLIPY_PAGE_HOSTS) ?? undefined;
  const rawId = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const id = rawId.slice(0, 120) || url;
  const rawTitle =
    typeof candidate.title === "string" ? candidate.title.trim() : "";
  const title = (rawTitle || "GIF").slice(0, MAX_GIF_TITLE_LENGTH);
  const width = normalizeGifDimension(candidate.width);
  const height = normalizeGifDimension(candidate.height);
  const kind =
    candidate.kind === "sticker" ||
    candidate.kind === "clip" ||
    candidate.kind === "gif"
      ? candidate.kind
      : undefined;
  // Clips carry an MP4 alongside the GIF fallback in `url`; only clips may
  // declare one, and it must live on the same trusted Klipy media host.
  const videoUrl =
    kind === "clip"
      ? (normalizeHttpsUrl(candidate.videoUrl, KLIPY_MEDIA_HOSTS) ?? undefined)
      : undefined;

  return {
    id,
    title,
    url,
    ...(previewUrl ? { previewUrl } : {}),
    ...(pageUrl ? { pageUrl } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(kind ? { kind } : {}),
    ...(videoUrl ? { videoUrl } : {}),
    source: "klipy",
  };
};

type ReplyNormalizeResult =
  | { replyTo?: ChatReplyPreview }
  | { error: string };

interface ReplyNormalizeOptions {
  allowDirectSnapshot: boolean;
  senderUserId: string;
  dmTargetUserId?: string | null;
}

// Resolve public quoted messages from broadcast history so a reply cannot put
// fabricated words in someone else's mouth. Direct messages are never retained
// in public room history, so client snapshots are accepted only for replies
// that remain in the same private thread.
const normalizeReplyTo = (
  value: unknown,
  room: Room,
  options: ReplyNormalizeOptions,
): ReplyNormalizeResult => {
  if (!value || typeof value !== "object") return {};

  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!id) return {};

  const original = room
    .getChatHistorySnapshot()
    .find((message) => message.id === id);
  if (original) {
    if (original.isDirect) {
      const staysInSamePrivateThread =
        options.allowDirectSnapshot &&
        options.dmTargetUserId &&
        (original.userId === options.dmTargetUserId ||
          (original.userId === options.senderUserId &&
            original.dmTargetUserId === options.dmTargetUserId));
      if (!staysInSamePrivateThread) return {};
    }

    return {
      replyTo: {
        id: original.id,
        userId: original.userId,
        displayName: original.displayName,
        content: original.gif
          ? original.gif.title || "GIF"
          : original.content.slice(0, MAX_REPLY_CONTENT_LENGTH),
        hasGif: Boolean(original.gif),
        isDirect: original.isDirect,
        dmTargetUserId: original.dmTargetUserId,
      },
    };
  }

  const isDirectSnapshot = candidate.isDirect === true;
  if (!isDirectSnapshot) {
    return { error: "Reply target is no longer available." };
  }

  if (!options.allowDirectSnapshot || !options.dmTargetUserId) {
    return {};
  }

  const userId =
    typeof candidate.userId === "string" ? candidate.userId.trim() : "";
  const dmTargetUserId =
    typeof candidate.dmTargetUserId === "string"
      ? candidate.dmTargetUserId.trim()
      : "";
  const staysInSamePrivateThread =
    userId === options.dmTargetUserId ||
    (userId === options.senderUserId &&
      dmTargetUserId === options.dmTargetUserId);
  if (!staysInSamePrivateThread) {
    return { error: "Private replies must stay in the same private thread." };
  }

  const displayName =
    typeof candidate.displayName === "string"
      ? candidate.displayName.trim()
      : "";
  const content =
    typeof candidate.content === "string" ? candidate.content.trim() : "";
  if (!userId || !displayName || !content) {
    return { error: "Invalid reply target." };
  }

  return {
    replyTo: {
      id,
      userId: userId.slice(0, MAX_REPLY_NAME_LENGTH),
      displayName: displayName.slice(0, MAX_REPLY_NAME_LENGTH),
      content: content.slice(0, MAX_REPLY_CONTENT_LENGTH),
      hasGif: Boolean(candidate.hasGif),
      isDirect: true,
      dmTargetUserId: options.dmTargetUserId,
    },
  };
};

interface DirectMessageTargetCandidate {
  userId: string;
  displayName: string;
  normalizedUserId: string;
  normalizedBaseUserId: string;
  normalizedHandle: string;
  normalizedDisplayName: string;
}

const parseDirectMessageIntent = (
  content: string,
):
  | { targetToken: string; messageBody: string }
  | { error: string }
  | null => {
  const trimmed = content.trim();
  const isAtDirectMessage = trimmed.startsWith("@");
  const isDmCommand = /^\/dm\b/i.test(trimmed);
  if (!isAtDirectMessage && !isDmCommand) {
    return null;
  }

  const match = isAtDirectMessage
    ? trimmed.match(AT_DIRECT_MESSAGE_PATTERN)
    : trimmed.match(DM_COMMAND_PATTERN);
  if (!match) {
    return {
      error: DIRECT_MESSAGE_USAGE_ERROR,
    };
  }

  const rawTarget = match[1]?.trim() || "";
  const messageBody = match[2]?.trim() || "";
  const targetToken = rawTarget
    .replace(/^@+/, "")
    .replace(TRAILING_MENTION_PUNCTUATION_PATTERN, "");

  if (!targetToken || !messageBody) {
    return {
      error: DIRECT_MESSAGE_USAGE_ERROR,
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
  const senderBaseUserId = normalizeLookupToken(
    senderUserId.split("#")[0] || senderUserId,
  );

  const candidates: DirectMessageTargetCandidate[] = [];
  for (const [candidateUserId] of room.clients.entries()) {
    const displayName =
      room.getDisplayNameForUser(candidateUserId) ||
      fallbackDisplayNameFromUserId(candidateUserId);
    const baseUserId = candidateUserId.split("#")[0] || candidateUserId;
    const handle = baseUserId.split("@")[0] || baseUserId;

    candidates.push({
      userId: candidateUserId,
      displayName,
      normalizedUserId: normalizeLookupToken(candidateUserId),
      normalizedBaseUserId: normalizeLookupToken(baseUserId),
      normalizedHandle: normalizeLookupToken(handle),
      normalizedDisplayName: normalizeLookupToken(displayName),
    });
  }

  const resolveUniqueMatch = (
    matcher: (candidate: DirectMessageTargetCandidate) => boolean,
  ): DirectMessageTargetCandidate | { error: string } | null => {
    const matches = candidates.filter(matcher);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      return {
        error: `Multiple users match "${targetToken}". Use a more specific username.`,
      };
    }
    return matches[0] ?? null;
  };

  const byFullUserId = resolveUniqueMatch(
    (candidate) => candidate.normalizedUserId === normalizedTargetToken,
  );
  if (byFullUserId && "error" in byFullUserId) return byFullUserId;
  if (byFullUserId) {
    if (byFullUserId.normalizedBaseUserId === senderBaseUserId) {
      return { error: "You cannot private message yourself." };
    }
    return {
      userId: byFullUserId.userId,
      displayName: byFullUserId.displayName,
    };
  }

  const byBaseUserId = resolveUniqueMatch(
    (candidate) => candidate.normalizedBaseUserId === normalizedTargetToken,
  );
  if (byBaseUserId && "error" in byBaseUserId) return byBaseUserId;
  if (byBaseUserId) {
    if (byBaseUserId.normalizedBaseUserId === senderBaseUserId) {
      return { error: "You cannot private message yourself." };
    }
    return {
      userId: byBaseUserId.userId,
      displayName: byBaseUserId.displayName,
    };
  }

  const byDisplayName = resolveUniqueMatch(
    (candidate) => candidate.normalizedDisplayName === normalizedTargetToken,
  );
  if (byDisplayName && "error" in byDisplayName) return byDisplayName;
  if (byDisplayName) {
    if (byDisplayName.normalizedBaseUserId === senderBaseUserId) {
      return { error: "You cannot private message yourself." };
    }
    return {
      userId: byDisplayName.userId,
      displayName: byDisplayName.displayName,
    };
  }

  const byHandle = resolveUniqueMatch(
    (candidate) => candidate.normalizedHandle === normalizedTargetToken,
  );
  if (byHandle && "error" in byHandle) return byHandle;
  if (byHandle) {
    if (byHandle.normalizedBaseUserId === senderBaseUserId) {
      return { error: "You cannot private message yourself." };
    }
    return {
      userId: byHandle.userId,
      displayName: byHandle.displayName,
    };
  }

  return { error: `User "${targetToken}" not found for private message.` };
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

        // Throttle: drop over-budget messages (ack an error, do not process).
        if (!takeToken(socket, "sendChat", RATE_LIMITS.chat)) {
          respond(callback, { error: "You are sending messages too quickly" });
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

        const normalizedGif = normalizeChatGifAttachment(data.gif);
        if (normalizedGif && "error" in normalizedGif) {
          respond(callback, { error: normalizedGif.error });
          return;
        }

        const gif = normalizedGif ?? undefined;
        const content =
          typeof data.content === "string" ? data.content.trim() : "";
        if (!content && !gif) {
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

        const normalizedReply = normalizeReplyTo(data.replyTo, room, {
          allowDirectSnapshot: Boolean(dmTarget),
          senderUserId: sender.id,
          dmTargetUserId: dmTarget?.userId,
        });
        if ("error" in normalizedReply) {
          respond(callback, { error: normalizedReply.error });
          return;
        }
        const replyTo = normalizedReply.replyTo;

        let messageContent = directMessageIntent
          ? directMessageIntent.messageBody
          : content;
        if (!messageContent && gif) {
          messageContent = gif.title;
        }

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
          ...(gif ? { gif } : {}),
          ...(replyTo ? { replyTo } : {}),
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
            `DM in room ${room.id}: ${displayName} -> ${dmTarget.displayName} (messageId=${message.id})`,
          );
        } else {
          socket.to(room.channelId).emit("chatMessage", message);
          room.recordChatMessage(message);
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
