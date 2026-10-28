// Native embed bridge, protocol v1 (S60 0.8 C6-19, S60R 25, PLAN WP9). One scoped, versioned channel between a bundled
// SDK renderer running in the native app's web view and the native app host:
//
//   { "v": 1, "type": "<type>", "callSessionId": "<id>", "appSessionId": "<id>", "requestId": "<id>", "payload": {...} }
//
// Embed to native: ready, sync, update, awareness, status, ack, resize.
// Native to embed: snapshot, update, awareness, status, resync, close and the host commands (setTool, setColor,
// setStrokeWidth, setFill, undo, redo, setPage, addPage, renamePage, deletePage, zoomToFit, export).
//
// The embed has no socket and no network (its page CSP sets connect-src 'none'); the native session relays the room's
// Yjs bytes (base64 in the payload) and nothing else. Never put auth tokens, personal API keys or native method names on
// this channel. Every message is size-bounded, versioned and scoped to one call session and one app session; the native
// side also checks the sender's origin and frame. The Swift twin of these rules is
// apps/conclave-skip/Sources/Conclave/Core/Models/AppBridgeProtocol.swift; contract-fixtures.json pins both sides and
// scripts/native-embed-contract-test.mjs runs it (pnpm -C packages/apps-sdk run test:native-embed).
//
// This file has no imports and only erasable TypeScript, so Node runs it directly for the contract test.

export const NATIVE_EMBED_PROTOCOL_VERSION = 1;
/** The embed bundle's version; native accepts major 1. Bump the major only with a native release that understands it. */
export const NATIVE_EMBED_BUNDLE_VERSION = "1.0.0";
export const NATIVE_EMBED_HANDLER_NAME = "conclaveApp";

export const NATIVE_EMBED_ORIGINS = {
  ios: "conclave-embed://app",
  android: "https://appassets.androidplatform.net",
} as const;

/** Bounds shared with native (the SFU limits in packages/sfu/server/socket/handlers/appsHandlers.ts bound the bytes). */
export const NATIVE_EMBED_LIMITS = {
  envelopeCharacters: 1_572_864,
  updateBytes: 262_144,
  awarenessBytes: 65_536,
  stateVectorBytes: 65_536,
  snapshotBytes: 1_048_576,
  exportBytes: 1_048_576,
  identifier: 64,
  pages: 50,
  pageName: 40,
  requestMemory: 64,
} as const;

export const EMBED_TO_NATIVE_TYPES = ["ready", "sync", "update", "awareness", "status", "ack", "resize"] as const;
export const NATIVE_TO_EMBED_TYPES = [
  "snapshot",
  "update",
  "awareness",
  "status",
  "resync",
  "close",
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
] as const;

export type EmbedToNativeType = (typeof EMBED_TO_NATIVE_TYPES)[number];
export type NativeToEmbedType = (typeof NATIVE_TO_EMBED_TYPES)[number];

/** The whiteboard tools the native toolbar drives (the SDK `ToolKind`). */
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

/** The native Color menu (the SDK TOOL_COLORS palette, in order). */
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

/** Why a message was dropped; the same strings as Swift `AppBridgeRejection`. Logged by reason only, never content. */
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

/** The largest base64 text for `bytes` decoded bytes (4 characters per 3 bytes, padded). */
export const base64CharacterLimit = (bytes: number): number => Math.ceil(bytes / 3) * 4;

/** "1.2.3" -> 1; -1 when the version does not start with digits. */
export const bundleMajor = (version: string): number => {
  const head = version.split(".")[0] ?? "";
  if (!/^[0-9]{1,4}$/.test(head)) return -1;
  return Number(head);
};

/** The scope the native host put in the page fragment: "#v=1&callSessionId=...&appSessionId=...&appId=...". */
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

export const encodeEnvelope = (
  type: EmbedToNativeType | NativeToEmbedType,
  scope: SessionScope,
  requestId: string,
  payload: Record<string, unknown>,
): string =>
  JSON.stringify({
    v: NATIVE_EMBED_PROTOCOL_VERSION,
    type,
    callSessionId: scope.callSessionId,
    appSessionId: scope.appSessionId,
    requestId,
    payload,
  });

// Base64 without Node or DOM globals beyond btoa and atob (both exist in browsers and in Node 16 and later).

export const base64FromBytes = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

export type BytesResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: RejectionReason };

/** An optional base64 field with the bound checked before decoding. Missing or "" is empty. */
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

const checkEnvelope = (raw: unknown, scope: SessionScope, allowedTypes: readonly string[], allowOtherVersionFor: string): EnvelopeCheck => {
  if (typeof raw !== "string") return { ok: false, reason: "malformed" };
  if (raw.length > NATIVE_EMBED_LIMITS.envelopeCharacters) return { ok: false, reason: "oversized" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "malformed" };
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

/** The status payload rules (Swift `AppBridgeCodec.parseStatus`). */
export const isValidStatusPayload = (payload: Record<string, unknown>): boolean => {
  const tool = payload.tool ?? "pen";
  if (!isWhiteboardTool(tool)) return false;
  if (!isValidColor(payload.color ?? "#e3e3e8")) return false;
  const width = payload.strokeWidth ?? 3;
  if (typeof width !== "number" || width < 1 || width > 64) return false;
  const pageId = payload.pageId ?? "";
  if (pageId !== "" && !isValidIdentifier(pageId)) return false;
  return true;
};

/**
 * The native side's acceptance rules for one embed message (Swift `AppBridgeCodec.decode`), kept here so the contract
 * test pins both implementations to the same fixtures. Replay detection (`duplicateRequest`) is the session's job.
 */
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
  const check = checkEnvelope(raw, scope, EMBED_TO_NATIVE_TYPES, "ready");
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
      const vector = bytesFromBase64(payload.stateVector, NATIVE_EMBED_LIMITS.stateVectorBytes);
      if (!vector.ok) return vector;
      return { ok: true, envelope };
    }
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

/**
 * The embed's acceptance rules for one host message. Only native code can reach the page (the iOS
 * `callAsyncJavaScript` path and the Android reply proxy), so the origin is implicit; the scope, version, type and
 * request id are still checked, and a stale app session (a replaced app) is ignored.
 */
export const decodeHostMessage = (raw: unknown, scope: SessionScope): Decoded<NativeToEmbedType> => {
  const check = checkEnvelope(raw, scope, NATIVE_TO_EMBED_TYPES, "");
  if (!check.ok) return check;
  if (!isNativeToEmbedType(check.type)) return { ok: false, reason: "unknownType" };
  return { ok: true, envelope: envelopeFrom(check.record, check.type) };
};
