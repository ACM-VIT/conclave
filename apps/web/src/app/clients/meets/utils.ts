import { EMOJI_REACTIONS, type ReactionEmoji } from "./constants";
import type { MeetError, ReactionOption } from "./types";

export const ROOM_WORDS = [
  "aloe",
  "aster",
  "bloom",
  "canna",
  "cedar",
  "clove",
  "dahl",
  "daisy",
  "erica",
  "flora",
  "hazel",
  "iris",
  "lilac",
  "lily",
  "lotus",
  "maple",
  "myrrh",
  "olive",
  "pansy",
  "peony",
  "poppy",
  "rose",
  "sorel",
  "tansy",
  "thyme",
  "tulip",
  "yucca",
  "zinn",
  "akane",
  "akira",
  "asuna",
  "eren",
  "gohan",
  "goku",
  "gojo",
  "kanao",
  "kira",
  "levi",
  "luffy",
  "maki",
  "misa",
  "nami",
  "riku",
  "sokka",
  "saber",
  "senku",
  "shoto",
  "soma",
  "sora",
  "tanji",
  "taki",
  "toji",
  "todo",
  "toph",
  "yami",
  "yuki",
  "yato",
  "zoro",
];

const ROOM_WORDS_PER_CODE = 3;
const ROOM_WORD_MAX_LENGTH = ROOM_WORDS.reduce(
  (max, word) => Math.max(max, word.length),
  0
);
const ROOM_WORD_SEPARATOR = "-";
export const ROOM_CODE_MAX_LENGTH =
  ROOM_WORDS_PER_CODE * ROOM_WORD_MAX_LENGTH + (ROOM_WORDS_PER_CODE - 1);

export function generateRoomCode(): string {
  const words: string[] = [];
  for (let i = 0; i < ROOM_WORDS_PER_CODE; i += 1) {
    const pick = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];
    words.push(pick);
  }
  return words.join(ROOM_WORD_SEPARATOR);
}

export function sanitizeRoomCode(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z]+/g, ROOM_WORD_SEPARATOR)
    .replace(/-+/g, ROOM_WORD_SEPARATOR)
    .replace(/^-|-$/g, "");
  if (!normalized) return "";
  const words = normalized
    .split(ROOM_WORD_SEPARATOR)
    .filter(Boolean)
    .slice(0, ROOM_WORDS_PER_CODE)
    .map((word) => word.slice(0, ROOM_WORD_MAX_LENGTH));
  return words.join(ROOM_WORD_SEPARATOR);
}

export function sanitizeRoomCodeInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z]+/g, ROOM_WORD_SEPARATOR)
    .replace(/-+/g, ROOM_WORD_SEPARATOR)
    .replace(/^-+/g, "");
}

export function getRoomWordSuggestions(
  prefix: string,
  exclude: string[] = [],
  limit = 5
): string[] {
  const normalized = prefix.trim().toLowerCase();
  if (!normalized) return [];
  const excludeSet = new Set(exclude);
  return ROOM_WORDS.filter(
    (word) => !excludeSet.has(word) && word.startsWith(normalized)
  ).slice(0, limit);
}

export function extractRoomCode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const lastSegment = parts[parts.length - 1] || "";
    return sanitizeRoomCode(lastSegment);
  } catch {
    if (trimmed.includes("/")) {
      const parts = trimmed.split("/").filter(Boolean);
      const lastSegment = parts[parts.length - 1] || "";
      return sanitizeRoomCode(lastSegment);
    }
  }

  return sanitizeRoomCode(trimmed);
}

export function createMeetError(
  error: unknown,
  defaultCode: MeetError["code"] = "UNKNOWN"
): MeetError {
  const message = error instanceof Error ? error.message : String(error);

  if (
    message.includes("Permission denied") ||
    message.includes("NotAllowedError")
  ) {
    return {
      code: "PERMISSION_DENIED",
      message: "Camera/microphone permission denied",
      recoverable: true,
    };
  }
  if (
    message.includes("NotFoundError") ||
    message.includes("DevicesNotFoundError")
  ) {
    return {
      code: "MEDIA_ERROR",
      message: "Camera or microphone not found",
      recoverable: true,
    };
  }
  if (message.includes("Connection") || message.includes("socket")) {
    return {
      code: "CONNECTION_FAILED",
      message: "Failed to connect to server",
      recoverable: true,
    };
  }

  return { code: defaultCode, message, recoverable: false };
}

export function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

export function formatDisplayName(raw: string): string {
  const base = raw.split("#")[0] || raw;
  const handle = base.split("@")[0] || base;
  const tokens = handle.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const words = tokens
    .map((token) => token.match(/^[A-Za-z]+/)?.[0] || "")
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase());

  return words.length > 0 ? words.join(" ") : handle || raw;
}

export function normalizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isReactionEmoji(value: string): value is ReactionEmoji {
  return EMOJI_REACTIONS.includes(value as ReactionEmoji);
}

function formatReactionLabel(fileName: string): string {
  const baseName = fileName.replace(/\.[^/.]+$/, "");
  const words = baseName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase());

  return words.length ? words.slice(0, 2).join(" ") : baseName || "Reaction";
}

export function buildAssetReaction(fileName: string): ReactionOption {
  return {
    id: `asset-${fileName}`,
    kind: "asset",
    value: `/reactions/${encodeURIComponent(fileName)}`,
    label: formatReactionLabel(fileName),
  };
}

export function isValidAssetPath(value: string): boolean {
  return value.startsWith("/reactions/") && !value.includes("..");
}

export function getSpeakerHighlightClasses(isActive: boolean): string {
  return isActive
    ? "border-emerald-300/90 ring-4 ring-emerald-400/45 shadow-[0_0_26px_rgba(16,185,129,0.28)]"
    : "";
}

export function normalizeBrowserUrl(
  raw: string
): { url?: string; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: "Enter a URL to continue." };
  }
  if (/\s/.test(trimmed)) {
    return { error: "URLs cannot contain spaces." };
  }

  const hasScheme = /^[a-zA-Z][a-zA-Z\d+-.]*:/.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: "Enter a valid URL." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "Only http and https URLs are supported." };
  }

  return { url: parsed.toString() };
}

const SYSTEM_USER_AUDIO_PREFIX = "shared-browser:";
const SYSTEM_USER_VIDEO_PREFIX = "shared-browser-video:";

export function isSystemUserId(userId: string): boolean {
  return userId.startsWith(SYSTEM_USER_AUDIO_PREFIX) || userId.startsWith(SYSTEM_USER_VIDEO_PREFIX);
}

export function isBrowserVideoUserId(userId: string): boolean {
  return userId.startsWith(SYSTEM_USER_VIDEO_PREFIX);
}

export function isBrowserAudioUserId(userId: string): boolean {
  return userId.startsWith(SYSTEM_USER_AUDIO_PREFIX);
}

export function resolveNoVncUrl(noVncUrl: string): string {
  if (!noVncUrl) return noVncUrl;
  if (typeof window === "undefined") return noVncUrl;

  try {
    const parsed = new URL(noVncUrl);
    const isLocalHost =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "0.0.0.0";
    if (isLocalHost) {
      parsed.hostname = window.location.hostname;
    }
    return parsed.toString();
  } catch {
    return noVncUrl;
  }
}
