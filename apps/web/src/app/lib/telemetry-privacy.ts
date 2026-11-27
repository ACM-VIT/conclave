import { namesGuestPassIdentifier } from "@conclave/meeting-core/guest-pass-identifiers";
import type { CaptureResult, Properties } from "posthog-js";
import { z } from "zod";
import { isCallLogLabel } from "./call-log-labels";
import {
  BUILD_VERSION,
  chunkIdForm,
  chunkPathForm,
  createOutboundSchemas,
  FIRST_PARTY_SCRIPTS,
  FRAME_PLACEHOLDERS,
  isOutboundEventName,
  KNOWN_ERROR_TYPES,
  LANGUAGES,
  MAX_EXCEPTIONS,
  MAX_FRAMES,
  MAX_POSITION,
  MECHANISM_TYPES,
  MESSAGE_WITHHELD,
  type OutboundContext,
  type OutboundEventName,
  PATH_WITHHELD,
  REQUIRED_PROPERTIES,
  STATIC_PAGES,
  TELEMETRY_EVENTS,
  TELEMETRY_HOST,
  TYPE_WITHHELD,
} from "./telemetry-schema";

// The SDK's identity and session ids: the only values an event may carry out
// of storage. The SDK makes each one as a uuid.
const SDK_IDS = new Set(["distinct_id", "$device_id", "$session_id", "$window_id"]);

/** Whether posthog-js may keep a property in storage: only its own ids. */
export const isStoredProperty = (key: string): boolean => SDK_IDS.has(key);

/** Whether a value is a build's version, which names its chunk manifest. */
export const isBuildVersion = (value: unknown): value is string =>
  typeof value === "string" && BUILD_VERSION.test(value);

/**
 * Where a build serves its own chunk manifest (scripts/posthog-chunk-manifest.mjs),
 * or null for a version that is not a build's.
 */
export const chunkManifestUrl = (version: unknown): string | null =>
  isBuildVersion(version) ? `/_next/static/posthog-chunk-ids/${version}.json` : null;

const ChunkManifest = z.record(chunkIdForm, chunkPathForm);

/** The chunk manifest as a map, or null when it is not one. */
export const parseChunkManifest = (value: unknown): ReadonlyMap<string, string> | null => {
  const parsed = ChunkManifest.safeParse(value);
  return parsed.success ? new Map(Object.entries(parsed.data)) : null;
};

const STATIC = new Set<string>(STATIC_PAGES);

/**
 * Replaces room codes, invite slugs and booking handles in a path with the
 * route they belong to.
 */
export function templatePath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  const [first] = segments;
  if (!first) return "/";
  // Already templated, as when /ingest builds an event the browser built.
  if (segments.length === 1 && (first === "[code]" || first === "[path]")) return `/${first}`;
  if (first === "w") return "/w/[code]";
  if (first === "book") return "/book/[username]/[eventSlug]";
  if (segments.length === 1) return STATIC.has(first) ? `/${first}` : "/[code]";
  return STATIC.has(first) ? `/${first}/[path]` : "/[path]";
}

/** The route of a URL or path, with no origin, query or hash. */
const routeOf = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("/")) return templatePath(value.split(/[?#]/, 1)[0]);
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? templatePath(url.pathname) : undefined;
  } catch {
    return undefined;
  }
};

const ISO_639_1 = new Set(LANGUAGES);
const primaryLanguage = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const subtag = value.split(/[-_]/, 1)[0].toLowerCase();
  return ISO_639_1.has(subtag) ? subtag : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isPosition = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_POSITION;
const placeholders = new Set<string>(FRAME_PLACEHOLDERS);
const knownTypes = new Set<string>(KNOWN_ERROR_TYPES);
const mechanisms = new Set<string>(MECHANISM_TYPES);

/** Where an event came from, beyond what the schema's forms depend on. */
export type EventSource = OutboundContext & {
  /**
   * Our own fields: the payload of the capture in the browser, the event's
   * own at /ingest; null for an event the SDK raised itself.
   */
  payload: Properties | null;
  /** Keys posthog-js merged in from local and session storage. */
  storedKeys: ReadonlySet<string>;
  /** The origin our scripts are served from; a frame from any other names no file. */
  siteOrigin: string | null;
};

/**
 * A frame's file as its path, only for a script of ours served from our own
 * origin: an exact file under public/, or a chunk whose injected id the
 * build's manifest pairs with that very file, or, without that list, a chunk
 * file and id of their forms for /ingest to check. Never an origin.
 */
const framePath = (value: string, chunkId: string | null, source: EventSource): string => {
  if (placeholders.has(value) || value === PATH_WITHHELD) return value;
  let path: string;
  if (value.startsWith("/")) {
    path = value.split(/[?#]/, 1)[0];
  } else {
    try {
      const url = new URL(value);
      if (url.origin !== source.siteOrigin) return PATH_WITHHELD;
      path = url.pathname;
    } catch {
      return PATH_WITHHELD;
    }
  }
  const listed =
    chunkId !== null &&
    (source.chunkFiles ? source.chunkFiles.get(chunkId) === path : chunkPathForm.safeParse(path).success);
  const ours = FIRST_PARTY_SCRIPTS.has(path) || listed;
  return ours ? path : PATH_WITHHELD;
};

// A frame keeps its file, line, column, in-app flag and a chunk id the
// build's manifest lists. Its function name is dropped: source maps restore
// it in PostHog.
const shapeFrame = (frame: Record<string, unknown>, source: EventSource) => {
  const id = chunkIdForm.safeParse(frame.chunk_id);
  const chunkId = id.success && (!source.chunkFiles || source.chunkFiles.has(id.data)) ? id.data : null;
  return {
    platform: "web:javascript",
    function: "?",
    ...(typeof frame.filename === "string" ? { filename: framePath(frame.filename, chunkId, source) } : {}),
    ...(isPosition(frame.lineno) ? { lineno: frame.lineno } : {}),
    ...(isPosition(frame.colno) ? { colno: frame.colno } : {}),
    ...(typeof frame.in_app === "boolean" ? { in_app: frame.in_app } : {}),
    ...(chunkId !== null ? { chunk_id: chunkId } : {}),
  };
};

const shapeMechanism = (mechanism: unknown) => {
  if (!isRecord(mechanism)) return undefined;
  const { type, handled, synthetic, exception_id, parent_id } = mechanism;
  return {
    type: typeof type === "string" && mechanisms.has(type) ? type : "generic",
    ...(typeof handled === "boolean" ? { handled } : {}),
    ...(typeof synthetic === "boolean" ? { synthetic } : {}),
    ...(isPosition(exception_id) ? { exception_id } : {}),
    ...(isPosition(parent_id) ? { parent_id } : {}),
  };
};

/**
 * An exception keeps its message only when we wrote it: a registered `[Meets]`
 * label that call-error-capture set. Every other message, from an engine, a
 * library, the server or a rejected value, is withheld, and a type that is
 * not a known kind of failure too.
 */
const shapeExceptionList = (value: unknown, trustedMessage: string | null, source: EventSource) => {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).slice(0, MAX_EXCEPTIONS).map((entry) => {
    const mechanism = shapeMechanism(entry.mechanism);
    const frames = isRecord(entry.stacktrace) ? entry.stacktrace.frames : undefined;
    return {
      type: typeof entry.type === "string" && knownTypes.has(entry.type) ? entry.type : TYPE_WITHHELD,
      value: trustedMessage ?? MESSAGE_WITHHELD,
      ...(mechanism ? { mechanism } : {}),
      ...(Array.isArray(frames)
        ? {
            stacktrace: {
              type: "raw",
              frames: frames.filter(isRecord).slice(0, MAX_FRAMES).map((frame) => shapeFrame(frame, source)),
            },
          }
        : {}),
    };
  });
};

// Values we set ourselves, whatever the event says.
const GENERATED: Record<string, unknown> = {
  $host: TELEMETRY_HOST,
  $lib: "web",
  $process_person_profile: false,
};

/** One property's value, shaped for its form, from where that property may come. */
const shapeValue = (
  key: string,
  name: OutboundEventName,
  properties: Properties,
  source: EventSource,
): unknown => {
  if (key === "token") return source.token;
  if (key === "client_version") return source.clientVersion;
  if (Object.hasOwn(GENERATED, key)) return GENERATED[key];
  // Our fields come only from the capture that set them, never from the
  // event, so nothing in storage can supply one.
  if (Object.hasOwn(TELEMETRY_EVENTS[name].shape, key)) return source.payload?.[key];
  if (!SDK_IDS.has(key) && source.storedKeys.has(key)) return undefined;
  const value: unknown = properties[key];
  switch (key) {
    case "$browser_language":
    case "$browser_language_prefix":
      return primaryLanguage(value);
    case "$current_url":
    case "$pathname":
      return routeOf(value);
    case "$exception_list": {
      const label: unknown = source.payload?.call_log;
      const trusted = source.payload?.source === "call_log" && isCallLogLabel(label) ? label : null;
      return shapeExceptionList(value, trusted, source);
    }
    default:
      return value;
  }
};

export type OutboundEvent = {
  uuid: string;
  event: OutboundEventName;
  properties: Properties;
};

/**
 * Builds the event we send from scratch: only an event on the list, only the
 * properties its schema lists, each shaped for its form and kept only when it
 * fits, and only when it has every property it needs. Anything else in the
 * event is never read. Person properties are never sent.
 */
export function buildOutboundEvent(
  event: { uuid: string; event: string; properties: Properties },
  source: EventSource,
  schemas = createOutboundSchemas(source),
): OutboundEvent | null {
  if (!isOutboundEventName(event.event)) return null;
  const name = event.event;
  const properties: Properties = {};
  for (const [key, form] of Object.entries(schemas(name).shape)) {
    const parsed = form.safeParse(shapeValue(key, name, event.properties, source));
    if (parsed.success && parsed.data !== undefined) properties[key] = parsed.data;
  }
  if ((REQUIRED_PROPERTIES[name] ?? []).some((key) => !Object.hasOwn(properties, key))) return null;
  const built = { uuid: event.uuid, event: name, properties };
  return namesGuestPassIdentifier(built) ? null : built;
}

/** The posthog-js `before_send` hook: the event rebuilt from the schema, or null to drop it. */
export const beforeSend = (event: CaptureResult, source: EventSource): CaptureResult | null => {
  const built = buildOutboundEvent(event, source);
  return built && { ...built, ...(event.timestamp ? { timestamp: event.timestamp } : {}) };
};
