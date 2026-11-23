import { EMOJI_REACTIONS, type ReactionEmoji } from "./constants";
import { isMediaCaptureTimeoutError } from "./media-capture-timeout";
import type {
  MeetError,
  MeetMediaDevice,
  MeetMediaDeviceCause,
  ReactionOption,
} from "./types";

export const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

export const errorName = (value: unknown): string =>
  value instanceof Error ? value.name : "";

export const readResponseError = async (
  response: Response,
  fallback = "Request failed",
): Promise<string> => {
  const data: unknown = await response.json().catch(() => null);
  if (data && typeof data === "object" && "error" in data) {
    return String((data as { error?: unknown }).error || "") || fallback;
  }
  return response.statusText || fallback;
};

const ROOM_WORDS = [
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
const ROOM_WORD_SEPARATOR = "-";
export const ROOM_CODE_MAX_LENGTH = 64;
const WEBINAR_LINK_CODE_MAX_LENGTH = 32;

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
    .replace(/[^a-z0-9-]+/g, ROOM_WORD_SEPARATOR)
    .replace(/-+/g, ROOM_WORD_SEPARATOR)
    .replace(/^-|-$/g, "");
  if (!normalized) return "";
  return normalized.slice(0, ROOM_CODE_MAX_LENGTH);
}

export function sanitizeRoomCodeInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, ROOM_WORD_SEPARATOR)
    .replace(/-+/g, ROOM_WORD_SEPARATOR)
    .replace(/^-+/g, "")
    .slice(0, ROOM_CODE_MAX_LENGTH);
}

export function sanitizeWebinarLinkCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "")
    .slice(0, WEBINAR_LINK_CODE_MAX_LENGTH);
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

export type CodeFieldPaste =
  | { kind: "insert"; text: string }
  | { kind: "replace"; code: string };

const ROOM_CODE_TEXT = /^[a-z0-9-]+$/i;
const MEETING_LINK = new RegExp(
  String.raw`^(?:(?<scheme>https?:)?\/\/)?(?<authority>[^\/?#\\\s@]+)\/(?<segment>[^\/?#\\\s]+)\/?(?:[?#]\S*)?$`,
  "i",
);
const NOT_ROOM_CODES = new Set([
  "null",
  "undefined",
  "delete-account",
  "privacy",
  "schedule",
  "sfu-admin",
  "sign-in",
]);

const linkHostname = (authority: string) => {
  try {
    return new URL(`https://${authority}/`).hostname;
  } catch {
    return null;
  }
};

const fitsDns = (hostname: string) => {
  if (hostname.startsWith("[")) return true;
  const name = hostname.replace(/\.$/, "");
  return (
    name.length <= 253 &&
    name.split(".").every((label) => label.length >= 1 && label.length <= 63)
  );
};

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

const comparableHost = (host: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}/`);
  } catch {
    return null;
  }
  const typedLabels = host.toLowerCase().replace(/:\d*$/, "").split(".");
  const labels = parsed.hostname.split(".");
  const onlyCaseOrIdn =
    typedLabels.length === labels.length &&
    typedLabels.every(
      (label, index) =>
        label === labels[index] ||
        (!PRINTABLE_ASCII.test(label) && labels[index].startsWith("xn--")),
    );
  if (!onlyCaseOrIdn) return null;
  return parsed.port && parsed.port !== "80"
    ? `${parsed.hostname}:${parsed.port}`
    : parsed.hostname;
};

const linkRoomCode = (segment: string) => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (!ROOM_CODE_TEXT.test(decoded)) return null;
  const code = decoded.toLowerCase();
  return !NOT_ROOM_CODES.has(code) && sanitizeRoomCode(code) === code ? code : null;
};

export function parseCodeFieldPaste(
  text: string,
  conclaveHosts: readonly string[],
): CodeFieldPaste | null {
  const trimmed = text.trim();
  if (ROOM_CODE_TEXT.test(trimmed)) return { kind: "insert", text: trimmed.toLowerCase() };
  const { scheme, authority, segment } = MEETING_LINK.exec(trimmed)?.groups ?? {};
  if (!authority || !segment) return null;
  if (!scheme) {
    const typedHost = comparableHost(authority);
    if (!typedHost || !conclaveHosts.some((host) => comparableHost(host) === typedHost)) {
      return null;
    }
  }
  const hostname = linkHostname(authority);
  if (!hostname || !fitsDns(hostname)) return null;
  const code = linkRoomCode(segment);
  return code ? { kind: "replace", code } : null;
}

export function insertIntoField(input: HTMLInputElement, text: string, maxLength: number) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const fits = text.slice(0, Math.max(0, maxLength - (input.value.length - (end - start))));
  if (!fits) return;
  input.setSelectionRange(start, end, input.selectionDirection ?? "none");
  if (document.execCommand("insertText", false, fits)) {
    input.setSelectionRange(start + fits.length, start + fits.length);
    return;
  }
  input.setRangeText(fits, start, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

type MediaDevice = "camera" | "microphone";
type MediaCauses = NonNullable<MeetError["causes"]>;
type MediaFailureKind = Exclude<MeetMediaDeviceCause["kind"], "other">;
export type MediaDeviceFailures = Partial<Record<MediaDevice, unknown>>;

const MEDIA_ERROR_MESSAGES: Record<MediaFailureKind, Record<MeetMediaDevice, string>> = {
  blocked: {
    camera: "Camera is blocked",
    microphone: "Microphone is blocked",
    both: "Camera and microphone are blocked",
  },
  missing: {
    camera: "No camera found",
    microphone: "No microphone found",
    both: "No camera or microphone found",
  },
  busy: {
    camera: "Camera is in use",
    microphone: "Microphone is in use",
    both: "Camera and microphone are in use",
  },
  unresponsive: {
    camera: "Camera didn’t respond",
    microphone: "Microphone didn’t respond",
    both: "Camera and microphone didn’t respond",
  },
};

const MEDIA_ERROR_ADVICE: Record<MediaFailureKind, Record<MeetMediaDevice, string>> = {
  blocked: {
    camera: "allow camera access in your browser",
    microphone: "allow microphone access in your browser",
    both: "allow camera and microphone access in your browser",
  },
  missing: {
    camera: "connect or select a camera",
    microphone: "connect or select a microphone",
    both: "connect or select a camera and microphone",
  },
  busy: {
    camera: "close other apps that are using your camera",
    microphone: "close other apps that are using your microphone",
    both: "close other apps that are using your camera and microphone",
  },
  unresponsive: {
    camera: "check that your camera isn’t in use by another app",
    microphone: "check that your microphone isn’t in use by another app",
    both: "check that your camera and microphone aren’t in use by another app",
  },
};

const MEDIA_FAILURE_CODES: Record<MediaFailureKind, MeetError["code"]> = {
  blocked: "PERMISSION_DENIED",
  missing: "MEDIA_ERROR",
  busy: "MEDIA_ERROR",
  unresponsive: "MEDIA_ERROR",
};

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function classifyMediaFailure(error: unknown): MediaFailureKind | null {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const matches = (...names: string[]) =>
    names.some((candidate) => name === candidate || message.includes(candidate));
  if (matches("NotAllowedError", "PermissionDeniedError") || message.includes("Permission denied")) {
    return "blocked";
  }
  if (matches("NotFoundError", "DevicesNotFoundError", "OverconstrainedError")) return "missing";
  if (matches("NotReadableError", "TrackStartError")) return "busy";
  if (isMediaCaptureTimeoutError(error)) return "unresponsive";
  return null;
}

const isConnectionFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Connection") || message.includes("socket");
};

function mediaCause(
  error: unknown,
  device: MediaDevice,
  defaultCode: MeetError["code"],
): MeetMediaDeviceCause {
  const kind = classifyMediaFailure(error);
  if (kind) {
    return { code: MEDIA_FAILURE_CODES[kind], kind, message: MEDIA_ERROR_MESSAGES[kind][device] };
  }
  if (isConnectionFailure(error)) {
    return { code: "CONNECTION_FAILED", kind: "other", message: "Failed to connect to server" };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: defaultCode, kind: "other", message };
}

function mediaErrorFromCauses(causes: MediaCauses): MeetError | null {
  const { camera, microphone } = causes;
  if (camera && microphone) {
    const sharedKind = camera.kind === microphone.kind && camera.kind !== "other" ? camera.kind : null;
    return {
      code: [camera.code, microphone.code].includes("PERMISSION_DENIED")
        ? "PERMISSION_DENIED"
        : camera.code,
      message: sharedKind
        ? MEDIA_ERROR_MESSAGES[sharedKind].both
        : `${microphone.message} and ${lowerFirst(camera.message)}`,
      recoverable: true,
      device: "both",
      causes,
    };
  }
  const device: MediaDevice | null = camera ? "camera" : microphone ? "microphone" : null;
  const cause = camera ?? microphone;
  if (!device || !cause) return null;
  return { code: cause.code, message: cause.message, recoverable: true, device, causes };
}

export function createMediaDeviceError(
  failures: MediaDeviceFailures,
  defaultCode: MeetError["code"] = "MEDIA_ERROR",
): MeetError | null {
  const causes: MediaCauses = {};
  for (const device of ["microphone", "camera"] as const) {
    if (device in failures) causes[device] = mediaCause(failures[device], device, defaultCode);
  }
  return mediaErrorFromCauses(causes);
}

export function mediaErrorAdvice(error: MeetError): string | null {
  const camera = error.causes?.camera;
  const microphone = error.causes?.microphone;
  const adviceFor = (device: MeetMediaDevice, cause: MeetMediaDeviceCause | undefined) =>
    cause && cause.kind !== "other" ? MEDIA_ERROR_ADVICE[cause.kind][device] : null;
  const parts =
    camera && microphone && camera.kind === microphone.kind
      ? [adviceFor("both", camera)]
      : [adviceFor("microphone", microphone), adviceFor("camera", camera)];
  const sentence = parts.filter((part): part is string => Boolean(part)).join(", and ");
  return sentence ? `${upperFirst(sentence)}, then try again.` : null;
}

export function createMeetError(
  error: unknown,
  defaultCode: MeetError["code"] = "UNKNOWN",
  device?: MeetMediaDevice,
): MeetError {
  if (device) {
    const devices: MediaDevice[] = device === "both" ? ["microphone", "camera"] : [device];
    const deviceError = createMediaDeviceError(
      Object.fromEntries(devices.map((target) => [target, error])),
      defaultCode,
    );
    if (deviceError) return deviceError;
  }
  const kind = classifyMediaFailure(error);
  if (kind && kind !== "busy") {
    return { code: MEDIA_FAILURE_CODES[kind], message: MEDIA_ERROR_MESSAGES[kind].both, recoverable: true };
  }
  if (isConnectionFailure(error)) {
    return { code: "CONNECTION_FAILED", message: "Failed to connect to server", recoverable: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: defaultCode, message, recoverable: false };
}

export function clearMediaDeviceError(
  current: MeetError | null,
  recovered: MediaDevice,
): MeetError | null {
  if (!current?.device) return current;
  if (!current.causes) return current.device === recovered ? null : current;
  if (!current.causes[recovered]) return current;
  const { [recovered]: _cleared, ...remaining } = current.causes;
  return mediaErrorFromCauses(remaining);
}

export function mergeMediaDeviceError(
  current: MeetError | null,
  next: MeetError,
): MeetError {
  if (!current?.causes || !next.causes) return next;
  const covered = (Object.keys(current.causes) as MediaDevice[]).every(
    (device) => next.causes?.[device],
  );
  if (covered) return next;
  return mediaErrorFromCauses({ ...current.causes, ...next.causes }) ?? next;
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
    if (process.env.NODE_ENV === "development") {
      const override = new URL(window.location.href).searchParams.get("session");
      if (override) {
        return override;
      }
    }
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
  if (base.startsWith("guest-")) {
    return "Guest";
  }
  const handle = base.split("@")[0] || base;
  const tokens = handle.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const words = tokens
    .map((token) => token.match(/^[A-Za-z0-9]+/)?.[0] || "")
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
