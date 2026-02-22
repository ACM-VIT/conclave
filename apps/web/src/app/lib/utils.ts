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
export const WEBINAR_LINK_CODE_MAX_LENGTH = 32;

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

export function sanitizeWebinarLinkCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "")
    .slice(0, WEBINAR_LINK_CODE_MAX_LENGTH);
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

const SESSION_ID_STORAGE_KEY = "conclave:session-id";

export function getOrCreateSessionId(): string {
  if (typeof window === "undefined") {
    return generateSessionId();
  }

  try {
    const existing = window.sessionStorage.getItem(SESSION_ID_STORAGE_KEY);
    if (existing) return existing;

    const next = generateSessionId();
    window.sessionStorage.setItem(SESSION_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return generateSessionId();
  }
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

const VIT_STUDENT_DOMAIN = "vitstudent.ac.in";
const VIT_REGISTRATION_NUMBER_PATTERN = /\s+\d{2}[A-Za-z]{3}\d{3,4}[A-Za-z]?\s*$/;

export function sanitizeInstitutionDisplayName(
  name: string,
  email?: string | null
): string {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.endsWith(`@${VIT_STUDENT_DOMAIN}`)) {
    return name;
  }
  const sanitized = name.replace(VIT_REGISTRATION_NUMBER_PATTERN, "").trim();
  return sanitized || name.trim();
}

const CHAT_URL_PATTERN =
  /((?:https?:\/\/|www\.)[^\s]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s]*)?)/gi;

//fancy single pass regex linkeifer codex gave me
// ts is actually agi holly fuck
export function getChatMessageSegments(
  content: string
): Array<{ text: string; href?: string }> {
  const segments: Array<{ text: string; href?: string }> = [];
  let lastIndex = 0;

  for (const match of content.matchAll(CHAT_URL_PATTERN)) {
    const matched = match[0];
    const index = match.index ?? -1;
    if (index < 0) continue;

    if (index > lastIndex) {
      segments.push({ text: content.slice(lastIndex, index) });
    }

    const display = matched.replace(/[),.!?;:]+$/, "");
    if (!display || display.includes("@")) {
      segments.push({ text: matched });
    } else {
      const href = /^https?:\/\//i.test(display) ? display : `https://${display}`;
      segments.push({ text: display, href });
      const trailing = matched.slice(display.length);
      if (trailing) segments.push({ text: trailing });
    }
    lastIndex = index + matched.length;
  }

  if (lastIndex < content.length) {
    segments.push({ text: content.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ text: content }];
}

export function truncateDisplayName(value: string, maxLength = 16): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0];
    const firstTwo = parts.slice(0, 2).join(" ");
    if (firstTwo.length <= maxLength) return firstTwo;
    const lastAlphaToken = [...parts].reverse().find((part) => /[A-Za-z]/.test(part));
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

export function prioritizeActiveSpeaker<T extends { userId: string }>(
  participants: readonly T[],
  activeSpeakerId: string | null
): T[] {
  if (!activeSpeakerId) return [...participants];
  const activeIndex = participants.findIndex(
    (participant) => participant.userId === activeSpeakerId
  );
  if (activeIndex <= 0) return [...participants];

  const ordered = [...participants];
  const [activeParticipant] = ordered.splice(activeIndex, 1);
  if (activeParticipant) {
    ordered.unshift(activeParticipant);
  }
  return ordered;
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
