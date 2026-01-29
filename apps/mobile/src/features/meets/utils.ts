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
  const message = (() => {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const errObj = error as { message?: unknown; error?: unknown };
      if (typeof errObj.message === "string") return errObj.message;
      if (typeof errObj.error === "string") return errObj.error;
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    }
    return String(error);
  })();

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

export function truncateDisplayName(value: string, maxLength = 16): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0];
    const firstTwo = parts.slice(0, 2).join(" ");
    if (firstTwo.length <= maxLength) return firstTwo;
    const lastAlphaToken = [...parts]
      .reverse()
      .find((part) => /[A-Za-z]/.test(part));
    const lastInitial = lastAlphaToken?.match(/[A-Za-z]/)?.[0];
    const combined = lastInitial ? `${first} ${lastInitial}.` : first;
    if (combined.length <= maxLength) return combined;
  }
  const sliceLength = Math.max(0, maxLength - 3);
  return `${trimmed.slice(0, sliceLength).trimEnd()}...`;
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
    value: fileName,
    label: formatReactionLabel(fileName),
  };
}

export function isValidAssetPath(value: string): boolean {
  return value.endsWith(".gif") || value.endsWith(".png");
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

  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) return { error: "Invalid URL." };
    return { url: parsed.toString() };
  } catch {
    return { error: "Invalid URL." };
  }
}

const SYSTEM_USER_AUDIO_PREFIX = "shared-browser:";
const SYSTEM_USER_VIDEO_PREFIX = "shared-browser-video:";

export function isSystemUserId(userId: string): boolean {
  return (
    userId.startsWith(SYSTEM_USER_AUDIO_PREFIX) ||
    userId.startsWith(SYSTEM_USER_VIDEO_PREFIX)
  );
}

export function isBrowserVideoUserId(userId: string): boolean {
  return userId.startsWith(SYSTEM_USER_VIDEO_PREFIX);
}

export function isBrowserAudioUserId(userId: string): boolean {
  return userId.startsWith(SYSTEM_USER_AUDIO_PREFIX);
}
