export const NATIVE_EMBED_PROTOCOL_VERSION = 1;
export const NATIVE_EMBED_BUNDLE_VERSION = "1.1.0";
export const NATIVE_EMBED_HANDLER_NAME = "conclaveApp";

export const NATIVE_EMBED_ORIGINS = {
  ios: "conclave-embed://app",
  android: "https://appassets.androidplatform.net",
} as const;

export const NATIVE_EMBED_LIMITS = {
  envelopeCharacters: 1_572_864,
  updateBytes: 262_144,
  remoteUpdateBytes: 1_048_576,
  awarenessBytes: 65_536,
  stateVectorBytes: 65_536,
  snapshotBytes: 1_048_576,
  exportBytes: 1_048_576,
  identifier: 64,
  pages: 50,
  pageName: 40,
  requestMemory: 64,
  executedCommands: 4_096,
} as const;

export const EMBED_TO_NATIVE_TYPES = ["ready", "sync", "verifySaved", "editsPending", "update", "awareness", "status", "ack", "resize"] as const;
export const NATIVE_TO_EMBED_TYPES = [
  "snapshot",
  "update",
  "awareness",
  "status",
  "resync",
  "close",
  "prepareToLeave",
  "savedSnapshot",
  "setTool",
  "setColor",
  "setStrokeWidth",
  "setFill",
  "undo",
  "redo",
  "setPage",
  "addPage",
  "renamePage",
  "deletePage",
  "zoomToFit",
  "export",
  "addEntries",
  "removeEntry",
  "shuffle",
  "sort",
  "clearEntries",
  "spin",
  "setRemoveWinner",
  "setSounds",
  "clearResults",
  "addOutcome",
  "playNow",
  "enqueue",
  "request",
  "approve",
  "decline",
  "cancelRequest",
  "move",
  "remove",
] as const;

export const HOST_COMMAND_TYPES = [
  "setTool",
  "setColor",
  "setStrokeWidth",
  "setFill",
  "undo",
  "redo",
  "setPage",
  "addPage",
  "renamePage",
  "deletePage",
  "zoomToFit",
  "export",
  "addEntries",
  "removeEntry",
  "shuffle",
  "sort",
  "clearEntries",
  "spin",
  "setRemoveWinner",
  "setSounds",
  "clearResults",
  "addOutcome",
  "playNow",
  "enqueue",
  "request",
  "approve",
  "decline",
  "cancelRequest",
  "move",
  "remove",
] as const;

export const APP_EDIT_COMMANDS = [
  "addEntries",
  "removeEntry",
  "shuffle",
  "sort",
  "clearEntries",
  "spin",
  "setRemoveWinner",
  "clearResults",
  "playNow",
  "enqueue",
  "approve",
  "decline",
  "move",
  "remove",
] as const;

export type EmbedToNativeType = (typeof EMBED_TO_NATIVE_TYPES)[number];
export type NativeToEmbedType = (typeof NATIVE_TO_EMBED_TYPES)[number];

export const WHITEBOARD_TOOLS = [
  "select",
  "pan",
  "pen",
  "highlighter",
  "eraser",
  "rect",
  "ellipse",
  "line",
  "arrow",
  "text",
  "sticky",
  "laser",
] as const;
export type WhiteboardTool = (typeof WHITEBOARD_TOOLS)[number];

export const INK_COLORS = [
  "#ffffff",
  "#e3e3e8",
  "#71717a",
  "#1e1e1e",
  "#f87171",
  "#ef4444",
  "#fb7185",
  "#ec4899",
  "#fb923c",
  "#f97316",
  "#facc15",
  "#fbbf24",
  "#4ade80",
  "#22c55e",
  "#2dd4bf",
  "#14b8a6",
  "#60a5fa",
  "#3b82f6",
  "#a8a5ff",
  "#c084fc",
] as const;

export const STROKE_WIDTHS = [2, 3, 5, 8, 12] as const;

export const COMMAND_TIMEOUT_MS = 10_000;

export const DOC_ANSWERED_COMMANDS: readonly string[] = ["addEntries", "addOutcome"];

export const WHEEL_ADD_RECOVERY = {
  asks: 4,
  windowMs: 60_000,
  unknown: "outcomeUnknown",
} as const;

const ROOM_ADDS_PER_SECOND = 2;

export const WHEEL_RECEIPT_LIMITS = {
  count: (WHEEL_ADD_RECOVERY.windowMs / 1_000) * ROOM_ADDS_PER_SECOND,
  bytes: 32_768,
} as const;

export const WHEEL_LIMITS = {
  entries: 64,
  label: 48,
  results: 25,
  name: 64,
  pasteLines: 256,
  waiting: 999,
} as const;

export const WATCH_LIMITS = {
  queue: 50,
  requests: 50,
  title: 120,
  name: 64,
  userId: 128,
} as const;

export const WATCH_FRAME_ORIGIN = "https://www.youtube-nocookie.com";
export const WATCH_PLAYBACK_STATES = ["playing", "paused", "none"] as const;

export type RejectionReason =
  | "none"
  | "wrongOrigin"
  | "notMainFrame"
  | "oversized"
  | "malformed"
  | "versionMismatch"
  | "unknownType"
  | "wrongCallSession"
  | "staleAppSession"
  | "badRequestId"
  | "duplicateRequest"
  | "badPayload"
  | "payloadTooLarge"
  | "notAttached";

export type SessionScope = {
  callSessionId: string;
  appSessionId: string;
  appId: string;
};

export type Envelope<T extends string> = {
  v: number;
  type: T;
  callSessionId: string;
  appSessionId: string;
  requestId: string;
  payload: Record<string, unknown>;
};

export type Decoded<T extends string> =
  | { ok: true; envelope: Envelope<T> }
  | { ok: false; reason: RejectionReason };

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isValidIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= NATIVE_EMBED_LIMITS.identifier &&
  IDENTIFIER_PATTERN.test(value);

export const isValidColor = (value: unknown): value is string =>
  value === "transparent" || (typeof value === "string" && COLOR_PATTERN.test(value));

export const isWhiteboardTool = (value: unknown): value is WhiteboardTool =>
  typeof value === "string" && (WHITEBOARD_TOOLS as readonly string[]).includes(value);

export const base64CharacterLimit = (bytes: number): number => Math.ceil(bytes / 3) * 4;

export const bundleMajor = (version: string): number => {
  const head = version.split(".")[0] ?? "";
  if (!/^[0-9]{1,4}$/.test(head)) return -1;
  return Number(head);
};

export const parseScope = (fragment: string): SessionScope | null => {
  const params = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment);
  const version = Number(params.get("v"));
  const callSessionId = params.get("callSessionId");
  const appSessionId = params.get("appSessionId");
  const appId = params.get("appId");
  if (version !== NATIVE_EMBED_PROTOCOL_VERSION) return null;
  if (!isValidIdentifier(callSessionId) || !isValidIdentifier(appSessionId)) return null;
  if (typeof appId !== "string" || appId.length === 0 || appId.length > 128) return null;
  return { callSessionId, appSessionId, appId };
};

const LONE_SURROGATES = /[\uD800-\uDFFF]/gu;

export const withoutLoneSurrogates = (text: string): string => text.replace(LONE_SURROGATES, "");

const wellFormedStrings = (_key: string, value: unknown): unknown =>
  typeof value === "string" ? withoutLoneSurrogates(value) : value;

export const encodeEnvelope = (
  type: EmbedToNativeType | NativeToEmbedType,
  scope: SessionScope,
  requestId: string,
  payload: Record<string, unknown>,
): string =>
  JSON.stringify(
    {
      v: NATIVE_EMBED_PROTOCOL_VERSION,
      type,
      callSessionId: scope.callSessionId,
      appSessionId: scope.appSessionId,
      requestId,
      payload,
    },
    wellFormedStrings,
  );

export const base64FromBytes = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

export type BytesResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: RejectionReason };

export const bytesFromBase64 = (value: unknown, limit: number): BytesResult => {
  if (value === undefined || value === "") return { ok: true, bytes: new Uint8Array(0) };
  if (typeof value !== "string") return { ok: false, reason: "badPayload" };
  if (value.length > base64CharacterLimit(limit)) return { ok: false, reason: "payloadTooLarge" };
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return { ok: false, reason: "badPayload" };
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return { ok: false, reason: "badPayload" };
  }
  if (binary.length > limit) return { ok: false, reason: "payloadTooLarge" };
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { ok: true, bytes };
};

type EnvelopeCheck = { ok: true; record: Record<string, unknown>; type: string } | { ok: false; reason: RejectionReason };

type LoneSurrogates = "reject" | "strip";

const checkEnvelope = (
  raw: unknown,
  scope: SessionScope,
  allowedTypes: readonly string[],
  allowOtherVersionFor: string,
  loneSurrogates: LoneSurrogates,
): EnvelopeCheck => {
  if (typeof raw !== "string") return { ok: false, reason: "malformed" };
  if (raw.length > NATIVE_EMBED_LIMITS.envelopeCharacters) return { ok: false, reason: "oversized" };
  let parsed: unknown;
  let torn = false;
  try {
    parsed = JSON.parse(raw, (key: string, value: unknown): unknown => {
      if (withoutLoneSurrogates(key) !== key) torn = true;
      if (typeof value !== "string") return value;
      const kept = withoutLoneSurrogates(value);
      if (kept !== value) torn = true;
      return kept;
    });
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isRecord(parsed) || (torn && loneSurrogates === "reject")) return { ok: false, reason: "malformed" };
  const version = parsed.v;
  const type = parsed.type;
  if (typeof version !== "number" || typeof type !== "string") return { ok: false, reason: "malformed" };
  if (!allowedTypes.includes(type)) return { ok: false, reason: "unknownType" };
  if (version !== NATIVE_EMBED_PROTOCOL_VERSION && type !== allowOtherVersionFor) return { ok: false, reason: "versionMismatch" };
  if (typeof parsed.callSessionId !== "string" || parsed.callSessionId === "" || parsed.callSessionId !== scope.callSessionId) {
    return { ok: false, reason: "wrongCallSession" };
  }
  if (typeof parsed.appSessionId !== "string" || parsed.appSessionId === "" || parsed.appSessionId !== scope.appSessionId) {
    return { ok: false, reason: "staleAppSession" };
  }
  if (!isValidIdentifier(parsed.requestId)) return { ok: false, reason: "badRequestId" };
  if (parsed.payload !== undefined && !isRecord(parsed.payload)) return { ok: false, reason: "badPayload" };
  return { ok: true, record: parsed, type };
};

const envelopeFrom = <T extends string>(record: Record<string, unknown>, type: T): Envelope<T> => ({
  v: typeof record.v === "number" ? record.v : NATIVE_EMBED_PROTOCOL_VERSION,
  type,
  callSessionId: typeof record.callSessionId === "string" ? record.callSessionId : "",
  appSessionId: typeof record.appSessionId === "string" ? record.appSessionId : "",
  requestId: typeof record.requestId === "string" ? record.requestId : "",
  payload: isRecord(record.payload) ? record.payload : {},
});

const isEmbedToNativeType = (value: string): value is EmbedToNativeType =>
  (EMBED_TO_NATIVE_TYPES as readonly string[]).includes(value);

const isNativeToEmbedType = (value: string): value is NativeToEmbedType =>
  (NATIVE_TO_EMBED_TYPES as readonly string[]).includes(value);

export const isValidStatusPayload = (payload: Record<string, unknown>): boolean => {
  const tool = payload.tool ?? "pen";
  if (!isWhiteboardTool(tool)) return false;
  if (!isValidColor(payload.color ?? "#e3e3e8")) return false;
  const width = payload.strokeWidth ?? 3;
  if (typeof width !== "number" || width < 1 || width > 64) return false;
  const pageId = payload.pageId ?? "";
  if (pageId !== "" && !isValidIdentifier(pageId)) return false;
  return isValidAppStatus(payload.app);
};

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export const isValidVideoId = (value: unknown): value is string => typeof value === "string" && VIDEO_ID_PATTERN.test(value);

const isBoundedText = (value: unknown, limit: number, allowEmpty: boolean): boolean =>
  typeof value === "string" && value.length <= limit && (allowEmpty || value.trim().length > 0);

const isOptionalBoolean = (value: unknown): boolean => value === undefined || typeof value === "boolean";

const isOptionalCount = (value: unknown, limit: number): boolean =>
  value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= limit);

const isBoundedList = (value: unknown, limit: number, item: (entry: unknown) => boolean): boolean =>
  value === undefined || (Array.isArray(value) && value.length <= limit && value.every(item));

const isWheelEntry = (value: unknown): boolean =>
  isRecord(value) && isValidIdentifier(value.id) && isBoundedText(value.label, WHEEL_LIMITS.label, false);

const isWheelResult = (value: unknown): boolean =>
  isRecord(value) &&
  isValidIdentifier(value.id) &&
  isBoundedText(value.label, WHEEL_LIMITS.label, false) &&
  isBoundedText(value.byName ?? "", WHEEL_LIMITS.name, true);

const isWatchItem = (value: unknown): boolean =>
  isRecord(value) &&
  isValidIdentifier(value.id) &&
  isValidVideoId(value.videoId) &&
  isBoundedText(value.title ?? "", WATCH_LIMITS.title, true) &&
  isBoundedText(value.byName ?? "", WATCH_LIMITS.name, true);

const isWatchRequest = (value: unknown): boolean =>
  isWatchItem(value) && isRecord(value) && isBoundedText(value.byId ?? "", WATCH_LIMITS.userId, true);

export const isAddedList = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length <= WHEEL_LIMITS.entries &&
  value.every((index) => typeof index === "number" && Number.isSafeInteger(index) && index >= 0);

export const isValidAppStatus = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.kind === "wheel") {
    return (
      isBoundedList(value.entries, WHEEL_LIMITS.entries, isWheelEntry) &&
      isOptionalCount(value.waiting, WHEEL_LIMITS.waiting) &&
      isBoundedList(value.results, WHEEL_LIMITS.results, isWheelResult) &&
      isOptionalBoolean(value.removeWinner) &&
      isOptionalBoolean(value.sounds) &&
      isOptionalBoolean(value.spinning) &&
      (value.winnerSpinId === undefined || value.winnerSpinId === "" || isValidIdentifier(value.winnerSpinId)) &&
      isBoundedText(value.winnerLabel ?? "", WHEEL_LIMITS.label, true)
    );
  }
  if (value.kind === "watch") {
    const playback = value.playback ?? "none";
    return (
      (value.videoId === undefined || value.videoId === "" || isValidVideoId(value.videoId)) &&
      isBoundedText(value.title ?? "", WATCH_LIMITS.title, true) &&
      typeof playback === "string" &&
      (WATCH_PLAYBACK_STATES as readonly string[]).includes(playback) &&
      isBoundedList(value.queue, WATCH_LIMITS.queue, isWatchItem) &&
      isBoundedList(value.requests, WATCH_LIMITS.requests, isWatchRequest) &&
      (value.myRequestId === undefined || value.myRequestId === "" || isValidIdentifier(value.myRequestId)) &&
      isOptionalBoolean(value.requestDeclined)
    );
  }
  return false;
};

export const decodeEmbedMessage = (
  raw: unknown,
  scope: SessionScope,
  origin: string,
  expectedOrigin: string,
  isMainFrame: boolean,
): Decoded<EmbedToNativeType> => {
  const actual = origin.toLowerCase();
  const wanted = expectedOrigin.toLowerCase();
  if (wanted === "" || (actual !== wanted && actual !== `${wanted}/`)) return { ok: false, reason: "wrongOrigin" };
  if (!isMainFrame) return { ok: false, reason: "notMainFrame" };
  const check = checkEnvelope(raw, scope, EMBED_TO_NATIVE_TYPES, "ready", "reject");
  if (!check.ok) return check;
  if (!isEmbedToNativeType(check.type)) return { ok: false, reason: "unknownType" };
  const envelope = envelopeFrom(check.record, check.type);
  const payload = envelope.payload;
  switch (envelope.type) {
    case "ready": {
      const bundleVersion = payload.bundleVersion;
      const appId = payload.appId;
      if (typeof bundleVersion !== "string" || bundleVersion === "" || bundleVersion.length > 32) return { ok: false, reason: "badPayload" };
      if (typeof appId !== "string" || appId === "" || appId.length > 128) return { ok: false, reason: "badPayload" };
      const vector = bytesFromBase64(payload.stateVector, NATIVE_EMBED_LIMITS.stateVectorBytes);
      if (!vector.ok) return vector;
      return { ok: true, envelope };
    }
    case "sync": {
      if (payload.purpose !== undefined && payload.purpose !== "wheel-add-confirmation") {
        return { ok: false, reason: "badPayload" };
      }
      const vector = bytesFromBase64(payload.stateVector, NATIVE_EMBED_LIMITS.stateVectorBytes);
      if (!vector.ok) return vector;
      return { ok: true, envelope };
    }
    case "verifySaved":
    case "editsPending":
      return { ok: true, envelope };
    case "update":
    case "awareness": {
      const limit = envelope.type === "update" ? NATIVE_EMBED_LIMITS.updateBytes : NATIVE_EMBED_LIMITS.awarenessBytes;
      const update = bytesFromBase64(payload.update, limit);
      if (!update.ok) return update;
      if (update.bytes.length === 0) return { ok: false, reason: "badPayload" };
      if (envelope.type === "awareness" && payload.clientId !== undefined) {
        const clientId = payload.clientId;
        if (typeof clientId !== "number" || clientId < 0 || clientId > 4_294_967_295) return { ok: false, reason: "badPayload" };
      }
      return { ok: true, envelope };
    }
    case "status":
      return isValidStatusPayload(payload) ? { ok: true, envelope } : { ok: false, reason: "badPayload" };
    case "ack": {
      const png = payload.pngBase64;
      if (typeof png === "string" && png.length > base64CharacterLimit(NATIVE_EMBED_LIMITS.exportBytes)) {
        return { ok: false, reason: "payloadTooLarge" };
      }
      if (payload.added !== undefined && !isAddedList(payload.added)) return { ok: false, reason: "badPayload" };
      return { ok: true, envelope };
    }
    case "resize": {
      const width = payload.width ?? 0;
      const height = payload.height ?? 0;
      if (typeof width !== "number" || typeof height !== "number") return { ok: false, reason: "badPayload" };
      if (width < 0 || height < 0 || width > 100000 || height > 100000) return { ok: false, reason: "badPayload" };
      return { ok: true, envelope };
    }
  }
};

export const decodeHostMessage = (raw: unknown, scope: SessionScope): Decoded<NativeToEmbedType> => {
  const check = checkEnvelope(raw, scope, NATIVE_TO_EMBED_TYPES, "", "strip");
  if (!check.ok) return check;
  if (!isNativeToEmbedType(check.type)) return { ok: false, reason: "unknownType" };
  return { ok: true, envelope: envelopeFrom(check.record, check.type) };
};
