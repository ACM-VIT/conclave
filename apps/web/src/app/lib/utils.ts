import { resolveViewerUrl } from "../../lib/novnc-viewer";
import { EMOJI_REACTIONS, type ReactionEmoji } from "./constants";
import { isMediaCaptureTimeoutError } from "./media-capture-timeout";
import { linkOriginIsKnown } from "../../lib/meeting-origin";
import { canonicalizeSfuClientId } from "../../lib/sfu-client-id";
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
  | { kind: "replace"; code: string; clientId: string | null };

const ROOM_CODE_TEXT = /^[a-z0-9-]+$/i;
const ROOM_CODE_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEETING_LINK = new RegExp(
  String.raw`^(?:(?<scheme>https?:)?\/\/)?(?<authority>[^\/?#\\\s@]+)\/(?<segment>[^\/?#\\\s]+)\/?(?:[?#]\S*)?$`,
  "i",
);
export const APP_ROUTE_SEGMENTS = [
  "api",
  "book",
  "delete-account",
  "privacy",
  "schedule",
  "sfu-admin",
  "sign-in",
  "w",
] as const;
const NOT_ROOM_CODES = new Set<string>(["null", "undefined", ...APP_ROUTE_SEGMENTS]);

const isRoomCodeShaped = (code: string) => ROOM_CODE_SHAPE.test(code) && !NOT_ROOM_CODES.has(code);

const linkRoomCode = (segment: string) => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (!ROOM_CODE_TEXT.test(decoded)) return null;
  const code = decoded.toLowerCase();
  return isRoomCodeShaped(code) ? code : null;
};

const linkAsNavigated = (link: string, scheme: string | undefined) => {
  try {
    return new URL(scheme ? link : `https:${link.startsWith("//") ? "" : "//"}${link}`);
  } catch {
    return null;
  }
};

export function parseCodeFieldPaste(
  text: string,
  conclaveOrigins: readonly string[],
): CodeFieldPaste | null {
  const trimmed = text.trim();
  if (ROOM_CODE_TEXT.test(trimmed)) return { kind: "insert", text: trimmed.toLowerCase() };
  const { scheme, authority, segment } = MEETING_LINK.exec(trimmed)?.groups ?? {};
  if (!authority || !segment) return null;
  if (!linkOriginIsKnown(scheme, authority, conclaveOrigins)) return null;
  const code = linkRoomCode(segment);
  if (!code) return null;
  const url = linkAsNavigated(trimmed, scheme);
  if (!url) return null;
  return { kind: "replace", code, clientId: canonicalizeSfuClientId(url.searchParams.get("clientId")) };
}

const URL_PUNCTUATION = /[:/.?#@%=&+~\\]/;

export const normalizeCodeField = (value: string) =>
  URL_PUNCTUATION.test(value)
    ? value
    : value.toLowerCase().replace(/(\S)\s+(?=\S)/g, "$1-").replace(/-+/g, "-");

export type CodeFieldResolution = { code: string; clientId: string | null; tooLong: boolean };

export function resolveCodeField(
  value: string,
  conclaveOrigins: readonly string[],
): CodeFieldResolution {
  const paste = parseCodeFieldPaste(value, conclaveOrigins);
  const link = paste?.kind === "replace" ? paste : null;
  const candidate = link ? link.code : value.trim();
  const clientId = link?.clientId ?? null;
  if (!isRoomCodeShaped(candidate)) return { code: "", clientId: null, tooLong: false };
  return candidate.length > ROOM_CODE_MAX_LENGTH
    ? { code: "", clientId, tooLong: true }
    : { code: candidate, clientId, tooLong: false };
}

export const codeFieldTenant = (resolution: CodeFieldResolution, pageClientId: string) => {
  const clientId = resolution.clientId ?? pageClientId;
  return { clientId, onThisPage: clientId === pageClientId };
};

export const roomCodeFromField = (value: string, conclaveOrigins: readonly string[]) =>
  resolveCodeField(value, conclaveOrigins).code;

export type FieldEdit = { start: number; end: number; text: string };

export function planFieldEdit(
  value: string,
  start: number,
  end: number,
  text: string,
  normalize: (value: string) => string,
): FieldEdit {
  const next = normalize(value.slice(0, start) + text + value.slice(end));
  let head = 0;
  while (head < start && value[head] === next[head]) head += 1;
  let tail = 0;
  while (
    tail < value.length - end &&
    tail < next.length - head &&
    value[value.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { start: head, end: value.length - tail, text: next.slice(head, next.length - tail) };
}

const INSERT_INPUT = new Set([
  "insertText",
  "insertReplacementText",
  "insertFromPaste",
  "insertFromPasteAsQuotation",
  "insertFromDrop",
  "insertFromYank",
]);
const DELETE_INPUT = new Set([
  "deleteContent",
  "deleteContentBackward",
  "deleteContentForward",
  "deleteWordBackward",
  "deleteWordForward",
  "deleteSoftLineBackward",
  "deleteSoftLineForward",
  "deleteHardLineBackward",
  "deleteHardLineForward",
  "deleteEntireSoftLine",
  "deleteByCut",
  "deleteByDrag",
]);
export const PASTED_INPUT = new Set([
  "insertFromPaste",
  "insertFromPasteAsQuotation",
  "insertFromDrop",
  "insertFromYank",
]);
const WORD_CHAR = /[\p{L}\p{N}]/u;

const wordStartBefore = (value: string, at: number) => {
  let index = at;
  while (index > 0 && !WORD_CHAR.test(value[index - 1])) index -= 1;
  while (index > 0 && WORD_CHAR.test(value[index - 1])) index -= 1;
  return index;
};

const wordEndAfter = (value: string, at: number) => {
  let index = at;
  while (index < value.length && !WORD_CHAR.test(value[index])) index += 1;
  while (index < value.length && WORD_CHAR.test(value[index])) index += 1;
  return index;
};

export function inputEditRange(
  inputType: string,
  start: number,
  end: number,
  value: string,
): readonly [number, number] | null {
  if (INSERT_INPUT.has(inputType)) return [start, end];
  if (!DELETE_INPUT.has(inputType)) return null;
  if (start !== end) return [start, end];
  switch (inputType) {
    case "deleteContentBackward":
      return [Math.max(0, start - 1), start];
    case "deleteContentForward":
      return [start, Math.min(value.length, start + 1)];
    case "deleteWordBackward":
      return [wordStartBefore(value, start), start];
    case "deleteWordForward":
      return [start, wordEndAfter(value, start)];
    case "deleteSoftLineBackward":
    case "deleteHardLineBackward":
      return [0, start];
    case "deleteSoftLineForward":
    case "deleteHardLineForward":
      return [start, value.length];
    case "deleteEntireSoftLine":
      return [0, value.length];
    default:
      return [start, end];
  }
}

export type SelectionDirection = "forward" | "backward" | "none";
export type FieldState = {
  value: string;
  selection: readonly [number, number];
  direction?: SelectionDirection;
};
type FieldStep = { before: FieldState; after: FieldState };

const sameFieldState = (a: FieldState, b: FieldState) =>
  a.value === b.value && a.selection[0] === b.selection[0] && a.selection[1] === b.selection[1];

export class FieldHistory {
  private steps: FieldStep[] = [];
  private cursor = 0;
  private typingOpen = false;

  record(before: FieldState, after: FieldState, typing: boolean) {
    this.steps.length = this.cursor;
    const last = this.steps[this.cursor - 1];
    if (typing && this.typingOpen && last && sameFieldState(last.after, before)) {
      last.after = after;
    } else {
      this.steps.push({ before, after });
      this.cursor = this.steps.length;
    }
    this.typingOpen = typing;
  }

  undone(value: string): FieldState | null {
    const step = this.steps[this.cursor - 1];
    if (!step || step.before.value !== value) {
      this.clear();
      return null;
    }
    this.typingOpen = false;
    this.cursor -= 1;
    return step.before;
  }

  redone(value: string): FieldState | null {
    const step = this.steps[this.cursor];
    if (!step || step.after.value !== value) {
      this.clear();
      return null;
    }
    this.typingOpen = false;
    this.cursor += 1;
    return step.after;
  }

  seal() {
    this.typingOpen = false;
  }

  clear() {
    this.steps = [];
    this.cursor = 0;
    this.typingOpen = false;
  }
}

type FieldTracker = {
  history: FieldHistory;
  last: FieldState;
  pending: FieldState | null;
  applying: boolean;
};

const TYPING_INPUT = new Set(["insertText", "insertCompositionText"]);
const fieldTrackers = new WeakMap<HTMLInputElement, FieldTracker>();

const fieldStateOf = (input: HTMLInputElement): FieldState => ({
  value: input.value,
  selection: [
    input.selectionStart ?? input.value.length,
    input.selectionEnd ?? input.selectionStart ?? input.value.length,
  ],
  direction: input.selectionDirection ?? "none",
});

const fieldTrackerFor = (input: HTMLInputElement) => {
  let tracker = fieldTrackers.get(input);
  if (!tracker) {
    tracker = { history: new FieldHistory(), last: fieldStateOf(input), pending: null, applying: false };
    fieldTrackers.set(input, tracker);
  }
  if (!tracker.applying && tracker.last.value !== input.value) {
    tracker.history.clear();
    tracker.last = fieldStateOf(input);
    tracker.pending = null;
  }
  return tracker;
};

const writeField = (input: HTMLInputElement, tracker: FieldTracker, write: () => void) => {
  tracker.applying = true;
  try {
    write();
  } finally {
    tracker.applying = false;
  }
  tracker.last = fieldStateOf(input);
  tracker.pending = null;
};

export function applyFieldEdit(input: HTMLInputElement, edit: FieldEdit) {
  const caret = edit.start + edit.text.length;
  const tracker = fieldTrackerFor(input);
  if (edit.start === edit.end && !edit.text) {
    input.setSelectionRange(caret, caret);
    tracker.history.seal();
    return;
  }
  const before = fieldStateOf(input);
  writeField(input, tracker, () => {
    input.setSelectionRange(edit.start, edit.end);
    const applied =
      typeof document.execCommand === "function" &&
      (edit.text
        ? document.execCommand("insertText", false, edit.text)
        : document.execCommand("delete"));
    if (applied) {
      input.setSelectionRange(caret, caret);
    } else {
      input.setRangeText(edit.text, edit.start, edit.end, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  tracker.history.record(before, tracker.last, false);
}

export function trackFieldHistory(input: HTMLInputElement) {
  const onBeforeInput = (event: InputEvent) => {
    const tracker = fieldTrackerFor(input);
    if (tracker.applying || event.defaultPrevented) return;
    tracker.pending = fieldStateOf(input);
  };
  const onInput = (event: Event) => {
    const tracker = fieldTrackers.get(input);
    if (!tracker || tracker.applying || !(event instanceof InputEvent)) return;
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      const state =
        event.inputType === "historyUndo"
          ? tracker.history.undone(input.value)
          : tracker.history.redone(input.value);
      if (state) input.setSelectionRange(state.selection[0], state.selection[1], state.direction);
    } else {
      const before = tracker.pending ?? tracker.last;
      const after = fieldStateOf(input);
      if (after.value !== before.value) {
        tracker.history.record(before, after, TYPING_INPUT.has(event.inputType));
      }
    }
    tracker.last = fieldStateOf(input);
    tracker.pending = null;
  };
  fieldTrackerFor(input);
  input.addEventListener("beforeinput", onBeforeInput);
  input.addEventListener("input", onInput);
  return () => {
    input.removeEventListener("beforeinput", onBeforeInput);
    input.removeEventListener("input", onInput);
  };
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

export const isMediaDeviceBlocked = (
  error: MeetError | null | undefined,
  device: MediaDevice,
): boolean => error?.causes?.[device]?.kind === "blocked";

export const isCameraAccessBlocked = ({
  hasLiveCamera,
  permissionState,
  mediaError,
}: {
  hasLiveCamera: boolean;
  permissionState: PermissionState | "unknown";
  mediaError: MeetError | null | undefined;
}): boolean =>
  !hasLiveCamera &&
  (permissionState === "unknown"
    ? isMediaDeviceBlocked(mediaError, "camera")
    : permissionState !== "granted");

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
  if (!noVncUrl || typeof window === "undefined") return noVncUrl;
  return resolveViewerUrl(noVncUrl, window.location.hostname);
}
