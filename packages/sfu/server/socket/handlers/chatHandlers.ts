import jwt from "jsonwebtoken";
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChatGifAttachment,
  ChatImageAttachment,
  ChatMessage,
  ChatReplyPreview,
  SendChatData,
} from "../../../types.js";
import { Admin } from "../../../config/classes/Admin.js";
import { config } from "../../../config/config.js";
import { Logger } from "../../../utilities/loggers.js";
import {
  MAX_CHAT_IMAGE_BYTES,
  type Room,
} from "../../../config/classes/Room.js";
import type { ConnectionContext } from "../context.js";
import { trackConclaveAnswerPacket } from "../conclaveRelayLifecycle.js";
import { respond } from "./ack.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { createChatImageUploadToken } from "../../chatImages.js";

const AT_DIRECT_MESSAGE_PATTERN = /^@(\S+)\s+([\s\S]+)$/;
const DM_COMMAND_PATTERN = /^\/dm\s+(\S+)\s+([\s\S]+)$/i;
// "@Conclave …" summons the room AI. It must stay a public message (never a DM),
// so we detect it before direct-message parsing. The mention may appear anywhere
// ("Hey @Conclave …"); the (^|\s) boundary avoids matching emails like
// "foo@conclave.ai".
const CONCLAVE_MENTION_PATTERN = /(^|\s)@conclave\b/i;
const CONCLAVE_BOT_USER_ID = "conclave-assistant";
const CONCLAVE_BOT_DISPLAY_NAME = "Conclave";
const MAX_CONCLAVE_CONTENT_LENGTH = 6000;
// Caps for the assistant process state (reasoning trace + tool steps) relayed
// alongside the answer. Must stay in sync with the web assistant API route,
// which clamps to the same limits before signing.
const MAX_CONCLAVE_REASONING_LENGTH = 8000;
const MAX_CONCLAVE_TASKS = 32;
const MAX_CONCLAVE_TASK_ID_LENGTH = 120;
const MAX_CONCLAVE_TASK_QUERY_LENGTH = 600;
const CONCLAVE_TASK_KINDS = new Set([
  "reasoning",
  "web_search",
  "transcript",
  "github_issue",
  "answer",
]);
const CONCLAVE_AUTH_TOKEN_TTL_SECONDS = 5 * 60;

const isConclaveMention = (content: string): boolean =>
  CONCLAVE_MENTION_PATTERN.test(content.trim());
const TRAILING_MENTION_PUNCTUATION_PATTERN = /[,:;.!?]+$/;
const DIRECT_MESSAGE_USAGE_ERROR =
  "Use private messages as @username <message> or /dm <username> <message>.";
const MAX_GIF_TITLE_LENGTH = 140;
const MAX_GIF_URL_LENGTH = 2048;
const MAX_REPLY_CONTENT_LENGTH = 280;
const MAX_REPLY_NAME_LENGTH = 120;
const MAX_TTS_VOICE_TOKEN_LENGTH = 2048;
const TTS_VOICE_TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/;
const KLIPY_MEDIA_HOSTS = new Set(["static.klipy.com"]);
const KLIPY_PAGE_HOSTS = new Set(["klipy.com", "www.klipy.com"]);

const fallbackDisplayNameFromUserId = (userId: string): string =>
  userId.split("#")[0]?.split("@")[0] || userId;

const normalizeLookupToken = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");

const normalizeTtsVoiceToken = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  if (
    !token ||
    token.length > MAX_TTS_VOICE_TOKEN_LENGTH ||
    !TTS_VOICE_TOKEN_PATTERN.test(token)
  ) {
    return undefined;
  }
  return token;
};

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

const getChatImageAttachmentId = (value: unknown): string => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id.trim() : "";
};

const normalizeChatImageAttachment = (
  value: unknown,
  room: Room,
  senderUserId: string,
): ChatImageAttachment | { error: string } | null => {
  if (!value) return null;
  if (typeof value !== "object") {
    return { error: "Invalid image attachment." };
  }
  if (!room.areImageAttachmentsEnabled) {
    return { error: "Image attachments are disabled by the host." };
  }

  const candidate = value as Record<string, unknown>;
  const id = getChatImageAttachmentId(candidate);
  const asset = id ? room.getChatImageAsset(id) : undefined;
  if (!asset || asset.uploadedBy !== senderUserId) {
    return { error: "Image attachment is no longer available." };
  }
  return {
    id: asset.id,
    url: asset.url,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
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
          : original.image
            ? original.image.fileName || "Image"
            : original.content.slice(0, MAX_REPLY_CONTENT_LENGTH),
        hasGif: Boolean(original.gif),
        hasImage: Boolean(original.image),
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
      hasImage: Boolean(candidate.hasImage),
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

type ConclaveAuthorizeData = {
  id?: unknown;
  questionMessageId?: unknown;
};

type ConclaveAnswerData = {
  id?: unknown;
  roomId?: unknown;
  channelId?: unknown;
  requesterUserId?: unknown;
  questionMessageId?: unknown;
  content?: unknown;
  done?: unknown;
  reasoning?: unknown;
  reasoningDone?: unknown;
  tasks?: unknown;
  errored?: unknown;
  timestamp?: unknown;
  expiresAt?: unknown;
  signature?: unknown;
};

// One step of the assistant's process timeline (thinking, web search,
// transcript read, GitHub issue, answer writing) relayed to the room.
type ConclaveAnswerTask = {
  id: string;
  kind: string;
  status: "running" | "done";
  query?: string;
};

type ConclaveRelayPacketFields = {
  id: string;
  roomId: string;
  channelId: string;
  requesterUserId: string;
  questionMessageId: string;
  content: string;
  done: boolean;
  reasoning?: string;
  reasoningDone?: boolean;
  tasks?: ConclaveAnswerTask[];
  errored?: boolean;
  timestamp: number;
  expiresAt: number;
};

const relaySigningInput = (packet: ConclaveRelayPacketFields): string =>
  JSON.stringify({
    id: packet.id,
    roomId: packet.roomId,
    channelId: packet.channelId,
    requesterUserId: packet.requesterUserId,
    questionMessageId: packet.questionMessageId,
    content: packet.content,
    done: packet.done,
    timestamp: packet.timestamp,
    expiresAt: packet.expiresAt,
    // Optional process-state fields. `undefined` values are dropped by
    // JSON.stringify, so legacy packets without them keep the exact signing
    // input they were signed with. Must match the web assistant API route.
    reasoning: packet.reasoning || undefined,
    reasoningDone: packet.reasoningDone === true ? true : undefined,
    tasks: packet.tasks?.length
      ? packet.tasks.map((task) => ({
          id: task.id,
          kind: task.kind,
          status: task.status,
          query: task.query || undefined,
        }))
      : undefined,
    errored: packet.errored === true ? true : undefined,
  });

const signRelayPacket = (packet: ConclaveRelayPacketFields): string =>
  createHmac("sha256", config.sfuSecret)
    .update(relaySigningInput(packet))
    .digest("base64url");

const safeSignatureEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
};

// Validates the relayed task list without altering any value (a mutated value
// would fail the signature check anyway). Returns undefined when absent and
// null when malformed, in which case the whole packet is dropped.
const normalizeConclaveTasks = (
  value: unknown,
): ConclaveAnswerTask[] | null | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_CONCLAVE_TASKS) return null;
  const tasks: ConclaveAnswerTask[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const task = item as Record<string, unknown>;
    const id = typeof task.id === "string" ? task.id : "";
    const kind = typeof task.kind === "string" ? task.kind : "";
    const status =
      task.status === "running" || task.status === "done" ? task.status : null;
    const query = task.query === undefined ? undefined : task.query;
    if (
      !id ||
      id.length > MAX_CONCLAVE_TASK_ID_LENGTH ||
      !CONCLAVE_TASK_KINDS.has(kind) ||
      !status ||
      (query !== undefined &&
        (typeof query !== "string" ||
          query.length > MAX_CONCLAVE_TASK_QUERY_LENGTH))
    ) {
      return null;
    }
    tasks.push({
      id,
      kind,
      status,
      ...(query ? { query } : {}),
    });
  }
  return tasks;
};

const normalizeConclaveAnswer = (
  data: ConclaveAnswerData,
): (ConclaveRelayPacketFields & { signature: string }) | null => {
  const id = typeof data.id === "string" ? data.id.trim().slice(0, 120) : "";
  const roomId = typeof data.roomId === "string" ? data.roomId.trim() : "";
  const channelId =
    typeof data.channelId === "string" ? data.channelId.trim() : "";
  const requesterUserId =
    typeof data.requesterUserId === "string"
      ? data.requesterUserId.trim()
      : "";
  const questionMessageId =
    typeof data.questionMessageId === "string"
      ? data.questionMessageId.trim()
      : "";
  const content =
    typeof data.content === "string"
      ? data.content.slice(0, MAX_CONCLAVE_CONTENT_LENGTH)
      : "";
  const done = data.done === true;
  const reasoning =
    data.reasoning === undefined
      ? ""
      : typeof data.reasoning === "string"
        ? data.reasoning
        : null;
  const reasoningDone = data.reasoningDone === true;
  const tasks = normalizeConclaveTasks(data.tasks);
  const errored = data.errored === true;
  const timestamp = typeof data.timestamp === "number" ? data.timestamp : 0;
  const expiresAt = typeof data.expiresAt === "number" ? data.expiresAt : 0;
  const signature =
    typeof data.signature === "string" ? data.signature.trim() : "";

  if (
    !id ||
    !roomId ||
    !channelId ||
    !requesterUserId ||
    !questionMessageId ||
    reasoning === null ||
    reasoning.length > MAX_CONCLAVE_REASONING_LENGTH ||
    tasks === null ||
    !timestamp ||
    !expiresAt ||
    !signature
  ) {
    return null;
  }

  return {
    id,
    roomId,
    channelId,
    requesterUserId,
    questionMessageId,
    content,
    done,
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningDone ? { reasoningDone: true } : {}),
    ...(tasks?.length ? { tasks } : {}),
    ...(errored ? { errored: true } : {}),
    timestamp,
    expiresAt,
    signature,
  };
};

const createConclaveAuthorizationToken = (options: {
  answerId: string;
  questionMessageId: string;
  userId: string;
  room: Room;
}): string =>
  jwt.sign(
    {
      tokenUse: "conclave:assistant",
      answerId: options.answerId,
      questionMessageId: options.questionMessageId,
      userId: options.userId,
      roomId: options.room.id,
      clientId: options.room.clientId,
      channelId: options.room.channelId,
    },
    config.sfuSecret,
    {
      algorithm: "HS256",
      audience: "conclave-web",
      issuer: "conclave-sfu",
      expiresIn: CONCLAVE_AUTH_TOKEN_TTL_SECONDS,
    },
  );

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
  for (const [candidateUserId, candidateClient] of room.clients.entries()) {
    if (candidateClient.isObserver) continue;
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
    "chat:imageUploadAuthorize",
    (
      _data: unknown,
      callback: (
        response:
          | { token: string; uploadUrl: string; maxBytes: number }
          | { error: string },
      ) => void,
    ) => {
      if (!context.currentClient || !context.currentRoom) {
        respond(callback, { error: "Not in a room" });
        return;
      }
      if (!takeToken(socket, "chatImageUpload", RATE_LIMITS.chatImageUpload)) {
        respond(callback, {
          error: "Too many image uploads; please wait a moment.",
        });
        return;
      }

      const room = context.currentRoom;
      const sender = context.currentClient;
      if (sender.isObserver) {
        respond(callback, { error: "Watch-only attendees cannot upload images." });
        return;
      }
      if (room.isChatLocked && !(sender instanceof Admin)) {
        respond(callback, { error: "Chat is locked by the host." });
        return;
      }
      if (!room.areImageAttachmentsEnabled) {
        respond(callback, { error: "Image attachments are disabled by the host." });
        return;
      }

      const forwardedProtocol = socket.handshake.headers["x-forwarded-proto"];
      const forwardedHost = socket.handshake.headers["x-forwarded-host"];
      const protocol = Array.isArray(forwardedProtocol)
        ? forwardedProtocol[0]
        : forwardedProtocol?.split(",")[0]?.trim();
      const host = Array.isArray(forwardedHost)
        ? forwardedHost[0]
        : forwardedHost?.split(",")[0]?.trim() ||
          socket.handshake.headers.host;
      const origin =
        config.instancePublicUrl.replace(/\/$/, "") ||
        `${protocol || (socket.handshake.secure ? "https" : "http")}://${host}`;

      respond(callback, {
        token: createChatImageUploadToken(
          config.sfuSecret,
          room.channelId,
          sender.id,
        ),
        uploadUrl: `${origin}/chat-images`,
        maxBytes: MAX_CHAT_IMAGE_BYTES,
      });
    },
  );

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
        const pendingImageId = getChatImageAttachmentId(data?.image);
        const rejectMessage = (error: string): void => {
          if (pendingImageId) {
            room.removeUnattachedChatImageAsset(pendingImageId, sender.id);
          }
          respond(callback, { error });
        };

        // Throttle: drop over-budget messages (ack an error, do not process).
        if (!takeToken(socket, "sendChat", RATE_LIMITS.chat)) {
          rejectMessage("You are sending messages too quickly");
          return;
        }

        if (context.currentClient.isObserver) {
          rejectMessage("Watch-only attendees cannot send chat messages");
          return;
        }
        if (
          room.isChatLocked &&
          !(context.currentClient instanceof Admin)
        ) {
          rejectMessage("Chat is locked by the host");
          return;
        }

        const normalizedGif = normalizeChatGifAttachment(data.gif);
        if (normalizedGif && "error" in normalizedGif) {
          rejectMessage(normalizedGif.error);
          return;
        }

        const gif = normalizedGif ?? undefined;
        const normalizedImage = normalizeChatImageAttachment(
          data.image,
          room,
          sender.id,
        );
        if (normalizedImage && "error" in normalizedImage) {
          rejectMessage(normalizedImage.error);
          return;
        }
        const image = normalizedImage ?? undefined;
        if (gif && image) {
          rejectMessage("Send one attachment at a time.");
          return;
        }
        const content =
          typeof data.content === "string" ? data.content.trim() : "";
        if (!content && !gif && !image) {
          rejectMessage("Message cannot be empty");
          return;
        }

        // "@Conclave …" is always a public message so the whole room sees the
        // question; skip the direct-message path it would otherwise match.
        const directMessageIntent = isConclaveMention(content)
          ? null
          : parseDirectMessageIntent(content);
        if (directMessageIntent && "error" in directMessageIntent) {
          rejectMessage(directMessageIntent.error);
          return;
        }

        if (directMessageIntent && !room.isDmEnabled) {
          rejectMessage("Private messages are disabled by the host.");
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
            rejectMessage(resolvedTarget.error);
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
          rejectMessage(normalizedReply.error);
          return;
        }
        const replyTo = normalizedReply.replyTo;

        let messageContent = directMessageIntent
          ? directMessageIntent.messageBody
          : content;
        if (!messageContent && gif) {
          messageContent = gif.title;
        }
        if (!messageContent && image) {
          messageContent = image.fileName;
        }

        const isTtsMessage =
          !directMessageIntent &&
          (messageContent.toLowerCase().startsWith("/tts ") ||
            messageContent.toLowerCase() === "/tts");
        if (isTtsMessage) {
          if (room.isTtsDisabled) {
            rejectMessage("TTS is disabled by the host in this room.");
            return;
          }
        }

        if (messageContent.length > 1000) {
          rejectMessage("Message too long (max 1000 characters)");
          return;
        }

        const targetClient = dmTarget
          ? room.getClient(dmTarget.userId)
          : undefined;
        if (dmTarget && !targetClient) {
          rejectMessage("Private message target is no longer available.");
          return;
        }
        if (image && !room.markChatImageAssetAttached(image.id, sender.id)) {
          rejectMessage("Image attachment is no longer available.");
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
          ...(image ? { image } : {}),
          ...(replyTo ? { replyTo } : {}),
          ...(isTtsMessage
            ? { ttsVoiceToken: normalizeTtsVoiceToken(data.ttsVoiceToken) }
            : {}),
          isDirect: Boolean(dmTarget),
          dmTargetUserId: dmTarget?.userId,
          dmTargetDisplayName: dmTarget?.displayName,
        };

        if (dmTarget) {
          targetClient!.socket.emit("chatMessage", message);
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

  socket.on(
    "conclave:authorize",
    (
      data: ConclaveAuthorizeData,
      callback: (response: { token: string } | { error: string }) => void,
    ) => {
      try {
        if (!context.currentClient || !context.currentRoom) {
          respond(callback, { error: "Not in a room" });
          return;
        }
        if (
          !takeToken(
            socket,
            "conclaveAuthorize",
            RATE_LIMITS.conclaveAuthorize,
          )
        ) {
          respond(callback, { error: "Conclave is being asked too quickly" });
          return;
        }

        const room = context.currentRoom;
        const sender = context.currentClient;
        if (sender.isObserver) {
          respond(callback, {
            error: "Watch-only attendees cannot ask Conclave",
          });
          return;
        }
        if (room.isChatLocked && !(sender instanceof Admin)) {
          respond(callback, { error: "Chat is locked by the host" });
          return;
        }

        const answerId =
          typeof data.id === "string" ? data.id.trim().slice(0, 120) : "";
        const questionMessageId =
          typeof data.questionMessageId === "string"
            ? data.questionMessageId.trim()
            : "";
        if (!answerId || !questionMessageId) {
          respond(callback, { error: "Invalid Conclave request" });
          return;
        }

        const questionMessage = room
          .getChatHistorySnapshot()
          .find((message) => message.id === questionMessageId);
        const hasPublicQuestionMessage =
          questionMessage?.userId === sender.id &&
          isConclaveMention(questionMessage.content);
        if (!hasPublicQuestionMessage) {
          respond(callback, {
            error: "Conclave answers must be tied to a public @Conclave question",
          });
          return;
        }

        respond(callback, {
          token: createConclaveAuthorizationToken({
            answerId,
            questionMessageId,
            userId: sender.id,
            room,
          }),
        });
      } catch (error) {
        respond(callback, { error: (error as Error).message });
      }
    },
  );

  // The web app signs every streamed assistant packet after it has generated it
  // from an SFU-issued token. The SFU only fans out packets that match the
  // current room/client and have not been tampered with.
  socket.on(
    "conclaveAnswer",
    (data: ConclaveAnswerData) => {
      try {
        if (!context.currentClient || !context.currentRoom) return;
        if (!takeToken(socket, "conclaveAnswer", RATE_LIMITS.conclave)) return;

        const room = context.currentRoom;
        const sender = context.currentClient;
        if (sender.isObserver) return;
        if (room.isChatLocked && !(sender instanceof Admin)) return;

        const packet = normalizeConclaveAnswer(data);
        if (!packet) return;
        if (
          packet.roomId !== room.id ||
          packet.channelId !== room.channelId ||
          packet.requesterUserId !== sender.id ||
          packet.expiresAt < Date.now()
        ) {
          return;
        }

        const expectedSignature = signRelayPacket({
          id: packet.id,
          roomId: packet.roomId,
          channelId: packet.channelId,
          requesterUserId: packet.requesterUserId,
          questionMessageId: packet.questionMessageId,
          content: packet.content,
          done: packet.done,
          reasoning: packet.reasoning,
          reasoningDone: packet.reasoningDone,
          tasks: packet.tasks,
          errored: packet.errored,
          timestamp: packet.timestamp,
          expiresAt: packet.expiresAt,
        });
        if (!safeSignatureEquals(packet.signature, expectedSignature)) return;

        const message: ChatMessage = {
          id: packet.id,
          userId: CONCLAVE_BOT_USER_ID,
          displayName: CONCLAVE_BOT_DISPLAY_NAME,
          content: packet.content,
          timestamp: packet.timestamp,
        };

        // Fan out the process state too so every participant renders the same
        // thinking/actions flow the asker sees.
        socket.to(room.channelId).emit("conclaveMessage", {
          ...message,
          done: packet.done,
          ...(packet.reasoning ? { reasoning: packet.reasoning } : {}),
          ...(packet.reasoningDone ? { reasoningDone: true } : {}),
          ...(packet.tasks?.length ? { tasks: packet.tasks } : {}),
          ...(packet.errored ? { errored: true } : {}),
        });
        trackConclaveAnswerPacket(context.activeConclaveAnswers, packet);

        if (
          packet.done &&
          !packet.errored &&
          packet.content.trim() &&
          !room
            .getChatHistorySnapshot()
            .some((existingMessage) => existingMessage.id === packet.id)
        ) {
          room.recordChatMessage(message);
        }
      } catch (error) {
        Logger.warn(`conclaveAnswer relay failed: ${(error as Error).message}`);
      }
    },
  );
};
