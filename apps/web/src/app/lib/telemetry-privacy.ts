import type { CaptureResult, Properties } from "posthog-js";

const STATIC_PAGES = new Set([
  "schedule",
  "sfu-admin",
  "privacy",
  "delete-account",
  "sign-in",
]);
// What posthog-js works out for each event from the page and its own config,
// checked against real traffic. Fields it keeps in storage, such as the
// referrer and the session's entry page, are not here.
const SDK_PROPERTIES = new Set([
  "token", "$browser", "$browser_language", "$browser_language_prefix", "$browser_version",
  "$config_defaults", "$configured_session_timeout_ms", "$current_url", "$device_type",
  "$exception_level", "$exception_list", "$host", "$insert_id", "$is_identified", "$lib",
  "$lib_custom_api_host", "$lib_version", "$os", "$os_version", "$pathname",
  "$process_person_profile", "$raw_user_agent", "$recording_status", "$screen_height",
  "$screen_width", "$sdk_debug_extensions_init_method", "$sdk_debug_extensions_init_time_ms",
  "$sdk_dist_channel", "$search_engine", "$time", "$timezone", "$timezone_offset",
  "$viewport_height", "$viewport_width",
]);
// The SDK's identity and session ids: the only values an event may carry out
// of storage. The SDK makes each one as a uuid.
const SDK_IDS = new Set(["distinct_id", "$device_id", "$session_id", "$window_id"]);
const SDK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Our own event fields. Each is read from the payload of the capture that
// sent it, never from the event, so nothing in storage can supply one. A new
// event field must be added here to be sent.
const APP_PROPERTIES = new Set([
  // Exceptions.
  "source", "call_log", "boundary", "digest",
  // call_join, call_first_media, call_summary.
  "call_id", "outcome", "failure_reason", "join_ms", "waited", "waiting_ms", "join_mode",
  "prior_failed_attempts", "first_remote_audio_ms", "first_remote_video_ms",
  "remote_present_at_join", "timed_out", "end_reason", "duration_ms", "peak_participants",
  "reconnect_count", "reconnect_total_ms", "reconnect_longest_ms", "reconnect_unrecovered",
  "remote_video_ms", "video_freeze_count", "video_freeze_ms", "video_stall_count",
  "video_stall_ms", "audio_concealed_pct", "outbound_video_ms", "outbound_low_ms",
  "outbound_standard_ms", "outbound_profile_switches", "outbound_video_kbps",
  "outbound_video_height", "outbound_cpu_limited_pct", "outbound_bandwidth_limited_pct",
  // meet_* events.
  "attempt", "attempts", "maxAttempts", "usingTurnFallback", "joinMode", "isAdmin", "status",
  "reason", "failureReason", "durationMs", "maximumSpatialLayer", "observedSpatialLayer",
  "from", "to", "epoch", "kind", "type", "level", "pausedForMs", "state", "downtimeMs",
  "autoplayBlocked",
]);

/** Whether posthog-js may keep a property in storage: only its own ids. */
export const isStoredProperty = (key: string): boolean => SDK_IDS.has(key);

/** Where the fields of the event in `before_send` came from. */
export type EventOrigin = {
  /** What our code passed to capture; null for an event the SDK raised itself. */
  payload: Properties | null;
  /** Keys posthog-js merged in from local and session storage. */
  storedKeys: ReadonlySet<string>;
  /** The build's git sha. */
  clientVersion?: string;
};

const URL_PROPERTY = /url|referrer|pathname|href/i;
const MAX_TEXT_LENGTH = 1000;

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{40,}\b/g;
const URL_IN_TEXT_PATTERN = /\bhttps?:\/\/[^\s"'<>)]+/gi;
// Headers whose whole value is a credential: everything to the end of the line.
const CREDENTIAL_HEADER_PATTERN =
  /\b(cookie|set-cookie|authorization|proxy-authorization)(\s*:)[^\r\n]*/gi;
const AUTH_SCHEME_PATTERN = /\b(bearer|basic)\s+[^\s,;"']+/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|session)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi;
// Our own script files, exactly. A stack frame in one keeps its path so
// PostHog can match it to a source map; any other path is templated.
const FIRST_PARTY_SCRIPTS = new Set([
  "/transcript-pcm-processor.js",
  "/effects/video-effects-output-writer.js",
  "/noise-suppressor/0.3.5/rnnoise-worklet.js",
  "/noise-suppressor/0.4.0/rnnoise-worklet.js",
  "/noise-suppressor/0.4.1/rnnoise-worklet.js",
  ...["0.10.35", "1.0.1", "1.1.0"].flatMap((version) =>
    ["vision_wasm_internal.js", "vision_wasm_module_internal.js", "vision_wasm_nosimd_internal.js"].map(
      (file) => `/mediapipe/tasks-vision/${version}/wasm/${file}`,
    ),
  ),
  ...["async_processor_worker_bundle.js", "audio_processing_worker_bundle.js", "render_worker_bundle.js", "timer_worker.js", "videopipe_bundle.js"].map(
    (file) => `/_/rtcvidproc/release/929503300/${file}`,
  ),
]);
// Build chunks have hashed names, so they are matched by shape instead.
const NEXT_STATIC_SCRIPT = /^\/_next\/static\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.m?js$/;
const isFirstPartyScript = (pathname: string): boolean =>
  FIRST_PARTY_SCRIPTS.has(pathname) || NEXT_STATIC_SCRIPT.test(pathname);
// Frame names the browser gives code with no file, such as <anonymous>.
const PLACEHOLDER_FRAME = /^(?:<[a-z ]+>|native|)$/;

/**
 * Replaces room codes, invite slugs and booking handles in a path with the
 * route they belong to.
 */
export function templatePath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  const [first] = segments;
  if (!first) return "/";
  if (first === "w") return "/w/[code]";
  if (first === "book") return "/book/[username]/[eventSlug]";
  if (segments.length === 1) {
    return STATIC_PAGES.has(first) ? `/${first}` : "/[code]";
  }
  return STATIC_PAGES.has(first) ? `/${first}/[path]` : "/[path]";
}

/** The origin and route of an http(s) URL, or null when it is not one. */
const scrubHttpUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${templatePath(url.pathname)}`;
  } catch {
    return null;
  }
};

/** Keeps the origin and route of a URL and drops its query and hash. */
export function scrubUrl(value: string): string {
  if (value.startsWith("/")) return templatePath(value.split(/[?#]/, 1)[0]);
  return scrubHttpUrl(value) ?? scrubText(value);
}

/** Removes credentials, emails, tokens and URL details from free text. */
export function scrubText(value: string): string {
  return value
    .slice(0, MAX_TEXT_LENGTH)
    .replace(URL_IN_TEXT_PATTERN, (url) => scrubHttpUrl(url) ?? "[url]")
    .replace(CREDENTIAL_HEADER_PATTERN, "$1$2 [redacted]")
    .replace(AUTH_SCHEME_PATTERN, "$1 [redacted]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1$2[redacted]")
    .replace(JWT_PATTERN, "[token]")
    .replace(EMAIL_PATTERN, "[email]")
    .replace(LONG_TOKEN_PATTERN, "[token]");
}

type ExceptionFrame = Record<string, unknown>;
type ExceptionEntry = {
  value?: unknown;
  stacktrace?: { frames?: ExceptionFrame[] } & Record<string, unknown>;
} & Record<string, unknown>;

const originOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const scrubFrameUrl = (value: string, pageOrigin: string | null): string => {
  if (PLACEHOLDER_FRAME.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol}//[path]`;
    if (url.origin === pageOrigin && isFirstPartyScript(url.pathname)) {
      return `${url.origin}${url.pathname}`;
    }
    return `${url.origin}${templatePath(url.pathname)}`;
  } catch {
    return "[path]";
  }
};

const scrubFrame = (frame: ExceptionFrame, pageOrigin: string | null): ExceptionFrame => {
  const next = { ...frame };
  for (const key of ["filename", "abs_path"]) {
    const value = next[key];
    if (typeof value === "string") next[key] = scrubFrameUrl(value, pageOrigin);
  }
  return next;
};

// Type names that name a kind of failure, never data: built-in errors, DOM
// exceptions, posthog-js's own, libraries we call, and ours. A rejected
// object's `name` becomes its type, so any other type is withheld too.
const KNOWN_ERROR_TYPES = new Set([
  "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError",
  "URIError", "AggregateError", "InternalError", "DOMException", "AbortError",
  "ConstraintError", "DataCloneError", "DataError", "EncodingError",
  "HierarchyRequestError", "IndexSizeError", "InvalidAccessError",
  "InvalidCharacterError", "InvalidModificationError", "InvalidNodeTypeError",
  "InvalidStateError", "NamespaceError", "NetworkError", "NoModificationAllowedError",
  "NotAllowedError", "NotFoundError", "NotReadableError", "NotSupportedError",
  "OperationError", "OverconstrainedError", "QuotaExceededError", "ReadOnlyError",
  "SecurityError", "TimeoutError", "TransactionInactiveError", "TypeMismatchError",
  "UnknownError", "URLMismatchError", "VersionError", "WrongDocumentError",
  "ChunkLoadError", "UnhandledRejection", "UnsupportedError", "CallError",
  "ServerError", "JoinRoomRedirectError", "MeetFailure",
]);
const MESSAGE_WITHHELD = "[message withheld]";
const TYPE_WITHHELD = "[type withheld]";

const knownType = (type: unknown): string =>
  typeof type === "string" && KNOWN_ERROR_TYPES.has(type) ? type : TYPE_WITHHELD;

/**
 * An exception keeps its message only when we wrote it: the `[Meets]` label
 * that call-error-capture sets. Every other message, from an engine, a
 * library, the server or a rejected value, is withheld.
 */
const scrubExceptionEntry = (
  entry: ExceptionEntry,
  trustedMessage: string | null,
  pageOrigin: string | null,
): ExceptionEntry => ({
  ...entry,
  type: knownType(entry.type),
  value: trustedMessage ?? MESSAGE_WITHHELD,
  ...(entry.stacktrace && Array.isArray(entry.stacktrace.frames)
    ? {
        stacktrace: {
          ...entry.stacktrace,
          frames: entry.stacktrace.frames.map((frame) => scrubFrame(frame, pageOrigin)),
        },
      }
    : {}),
});

const isPrimitive = (value: unknown): boolean => value === null || typeof value !== "object";

const scrubAppValue = (key: string, value: unknown): unknown => {
  if (typeof value !== "string") return value;
  return URL_PROPERTY.test(key) ? scrubUrl(value) : scrubText(value);
};

function scrubProperties(
  properties: Properties,
  { payload, storedKeys, clientVersion }: EventOrigin,
  pageOrigin: string | null,
): Properties {
  const trustedMessage =
    payload?.source === "call_log" && typeof payload.call_log === "string"
      ? scrubText(payload.call_log)
      : null;
  const scrubbed: Properties = {};
  const sdkEntries: Array<[string, unknown]> = Object.entries(properties);
  const appEntries: Array<[string, unknown]> = Object.entries(payload ?? {});
  for (const [key, value] of sdkEntries) {
    if (SDK_IDS.has(key)) {
      if (typeof value === "string" && SDK_ID_PATTERN.test(value)) scrubbed[key] = value;
    } else if (!SDK_PROPERTIES.has(key) || storedKeys.has(key)) {
      continue;
    } else if (key === "$exception_list" && Array.isArray(value)) {
      scrubbed[key] = (value as ExceptionEntry[]).map((entry) =>
        scrubExceptionEntry(entry, trustedMessage, pageOrigin),
      );
    } else if (typeof value === "string" && URL_PROPERTY.test(key)) {
      scrubbed[key] = scrubUrl(value);
    } else if (isPrimitive(value)) {
      scrubbed[key] = value;
    }
  }
  for (const [key, value] of appEntries) {
    if (APP_PROPERTIES.has(key) && isPrimitive(value)) scrubbed[key] = scrubAppValue(key, value);
  }
  if (clientVersion) scrubbed.client_version = clientVersion;
  return scrubbed;
}

/**
 * posthog-js `before_send` hook, on "send only what we trust": the SDK's own
 * fields unless they came from storage, its ids only as uuids, our fields only
 * from the capture's payload, known error types, call-log labels as the only
 * messages, and paths only for exact first-party scripts. Person properties
 * are never sent.
 */
export function scrubTelemetryEvent(event: CaptureResult, origin: EventOrigin): CaptureResult {
  // Stack frames keep a path only for scripts the page itself served.
  const pageOrigin = originOf(event.properties.$current_url);
  const { $set: _set, $set_once: _setOnce, ...rest } = event;
  return { ...rest, properties: scrubProperties(event.properties, origin, pageOrigin) };
}
