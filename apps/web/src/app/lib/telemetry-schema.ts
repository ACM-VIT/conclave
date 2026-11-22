import { z } from "zod";
import { CALL_LOG_LABELS } from "./call-log-labels";

/**
 * The outbound schema for web telemetry: every event we send, every property
 * each may carry, and the form of its value. A value is an enum, a constant,
 * a bounded number or an id we generated; never free text. The browser's
 * before_send and the /ingest proxy both build each event from this schema
 * (telemetry-privacy.ts), so a property that is not listed here, or a value
 * that does not fit its form, is never sent.
 */

/** The host every web event names, in place of the site's own. */
export const TELEMETRY_HOST = "conclave-web";
/** The client_version of a build this deployment did not ship. */
export const UNKNOWN_BUILD = "unknown";
export const MESSAGE_WITHHELD = "[message withheld]";
export const TYPE_WITHHELD = "[type withheld]";
export const PATH_WITHHELD = "[path]";

const count = z.number().int().min(0).max(1_000_000);
const ms = z.number().int().min(0).max(7 * 24 * 3_600_000);
const percent = z.number().min(0).max(100);
const flag = z.boolean();
const spatialLayer = z.number().int().min(0).max(8);
const position = z.number().int().min(0).max(100_000_000);
const pixels = z.number().int().min(0).max(100_000);
const uuid = z.uuid();

export const STATIC_PAGES = ["schedule", "sfu-admin", "privacy", "delete-account", "sign-in"] as const;
/** Every path a URL is sent as: the route it belongs to, never the room code or slug. */
export const ROUTES = [
  "/",
  "/[code]",
  "/[path]",
  "/w/[code]",
  "/book/[username]/[eventSlug]",
  ...STATIC_PAGES.flatMap((page) => [`/${page}`, `/${page}/[path]`]),
] as const;

// ISO 639-1 codes: the browser's language is sent only as its primary subtag.
export const LANGUAGES = (
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy " +
  "da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu " +
  "hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb " +
  "lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om " +
  "or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw " +
  "ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu"
).split(" ");

// The names posthog-js gives browsers, operating systems and device types.
const BROWSERS = [
  "Android Mobile", "BlackBerry", "Brave", "ChatGPT", "Chrome", "Chrome iOS", "Claude", "Codex",
  "DuckDuckGo", "Facebook Mobile", "Firefox", "Firefox iOS", "Google Search App",
  "Internet Explorer", "Internet Explorer Mobile", "Konqueror", "Microsoft Edge", "Mobile Safari",
  "Oculus Browser", "Opera", "Opera Mini", "Pale Moon", "Safari", "Samsung Internet", "UC Browser",
  "Vivaldi", "Waterfox", "Whale", "Yandex",
] as const;
const OPERATING_SYSTEMS = [
  "Android", "BlackBerry", "Chrome OS", "iOS", "Linux", "Mac OS X", "Nintendo", "PlayStation",
  "watchOS", "Windows", "Windows Mobile", "Windows Phone", "Xbox",
] as const;
const DEVICE_TYPES = ["Console", "Desktop", "Mobile", "Tablet", "Wearable"] as const;
const EXCEPTION_LEVELS = ["fatal", "error", "warning", "log", "info", "debug"] as const;

// Type names that name a kind of failure, never data: built-in errors, DOM
// exceptions, posthog-js's own, libraries we call, and ours.
export const KNOWN_ERROR_TYPES = [
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
] as const;
// The mechanisms posthog-js reports: a caught or captured error, a cause in a
// chain, and console capture.
export const MECHANISM_TYPES = ["generic", "chained", "onconsole"] as const;
// What the browser names a frame with no file.
export const FRAME_PLACEHOLDERS = ["", "native", "<anonymous>", "<unknown>"] as const;

/** Our own script files under public/, exactly. A frame in one keeps its path. */
export const FIRST_PARTY_SCRIPTS: ReadonlySet<string> = new Set([
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

// A build's version is the git sha it was built from (next.config.ts).
export const BUILD_VERSION = /^[0-9a-f]{7,40}$/;

const JOIN_MODE = z.enum(["meeting", "webinar_attendee"]);
const MEET_FAILURE = z.enum([
  "rejected", "invite_code", "room_not_found", "room_unavailable", "auth", "timeout",
  "permission_denied", "media_error", "transport_error", "connection_failed", "unknown",
]);
const RECONNECT_FAILURE = z.enum([
  "no_reason", "timeout", "permission", "local_media", "missing_room", "network", "other",
]);
const MEDIA_KIND = z.enum(["audio", "video"]);
const PRODUCER_TYPE = z.enum(["webcam", "screen"]);
const AUDIO_KIND = z.enum(["participant", "screenShare", "system"]);
const CODEC = z.enum(["vp8", "h264", "vp9"]);
const WEBCAM_RESET_REASON = z.literal("startup-simulcast-jitter-reset");
export const WEBCAM_RESET_FAILURE = z.enum([
  "adaptively-paused", "consumer-generation-changed", "consumer-not-live",
  "high-layer-convergence-timeout", "producer-closed", "producer-paused",
  "replacement-attempts-exhausted", "replacement-deadline-exhausted",
  "replacement-generation-changed", "replacement-not-attached", "replacement-not-playable",
  "replacement-rollback-unconfirmed", "replacement-threw",
]);
export const TURN_FALLBACK_REASON = z.enum([
  "producer_ice_unrecovered", "producer_ice_failed", "consumer_ice_unrecovered", "consumer_ice_failed",
]);
export const RESUME_FAILURE = z.enum(["ack_timeout", "displaced", "rate_limited", "server_error"]);
export const STALE_CONSUMER_REASON = z.enum([
  "resume_retries_exhausted", "server_lost_consumer", "consumer_stayed_muted", "decoder_frozen",
  "muted_live_track",
]);
const STALE_CONSUMER_FAILURE = z.enum(["replacement-not-attached", "replacement-threw"]);
export type WebcamResetFailure = z.infer<typeof WEBCAM_RESET_FAILURE>;
export type TurnFallbackReason = z.infer<typeof TURN_FALLBACK_REASON>;
export type ResumeFailure = z.infer<typeof RESUME_FAILURE>;
export type StaleConsumerReason = z.infer<typeof STALE_CONSUMER_REASON>;

const webcamResetSettled = z.object({
  reason: WEBCAM_RESET_REASON,
  failureReason: WEBCAM_RESET_FAILURE.nullable(),
  attempts: count,
  durationMs: ms,
  maximumSpatialLayer: spatialLayer,
  observedSpatialLayer: spatialLayer.nullable(),
});
const staleConsumer = z.object({ kind: MEDIA_KIND, type: PRODUCER_TYPE, reason: STALE_CONSUMER_REASON });

/** Each event we send and the fields our code gives it. */
export const TELEMETRY_EVENTS = {
  $exception: z.object({
    source: z.enum(["react_error_boundary", "call_log"]),
    boundary: z.enum(["route", "root", "panel"]).optional(),
    // Next.js's digest of a server error: a hash of it, in digits.
    digest: z.string().regex(/^\d{1,12}$/).optional(),
    call_log: z.enum(CALL_LOG_LABELS).optional(),
  }),
  call_join: z.object({
    call_id: uuid,
    outcome: z.enum(["joined", "failed", "abandoned"]),
    failure_reason: MEET_FAILURE.nullable(),
    join_ms: ms,
    waited: flag,
    waiting_ms: ms.nullable(),
    join_mode: JOIN_MODE,
    prior_failed_attempts: count,
  }),
  call_first_media: z.object({
    call_id: uuid,
    first_remote_audio_ms: ms.nullable(),
    first_remote_video_ms: ms.nullable(),
    join_ms: ms,
    remote_present_at_join: flag,
    timed_out: flag,
    join_mode: JOIN_MODE,
  }),
  call_summary: z.object({
    call_id: uuid,
    join_mode: JOIN_MODE,
    end_reason: z.enum(["left", "error", "reconnect_failed", "reconnect_abandoned", "page_closed"]),
    duration_ms: ms,
    peak_participants: count,
    waited: flag,
    first_remote_audio_ms: ms.nullable(),
    first_remote_video_ms: ms.nullable(),
    reconnect_count: count,
    reconnect_total_ms: ms,
    reconnect_longest_ms: ms,
    reconnect_unrecovered: flag,
    remote_video_ms: ms,
    video_freeze_count: count,
    video_freeze_ms: ms,
    video_stall_count: count,
    video_stall_ms: ms,
    audio_concealed_pct: percent.nullable(),
    outbound_video_ms: ms,
    outbound_low_ms: ms,
    outbound_standard_ms: ms,
    outbound_profile_switches: count,
    outbound_video_kbps: z.number().int().min(0).max(1_000_000).nullable(),
    outbound_video_height: pixels.nullable(),
    outbound_cpu_limited_pct: percent.nullable(),
    outbound_bandwidth_limited_pct: percent.nullable(),
  }),
  meet_audio_playback_recovered: z.object({ kind: AUDIO_KIND }),
  meet_audio_playback_stalled: z.object({ kind: AUDIO_KIND, autoplayBlocked: flag }),
  meet_webcam_consumer_generation_reset_completed: webcamResetSettled,
  meet_webcam_consumer_generation_reset_failed: webcamResetSettled,
  meet_webcam_consumer_generation_reset_cancelled: webcamResetSettled,
  meet_webcam_consumer_generation_reset_attempt: z.object({
    reason: WEBCAM_RESET_REASON,
    attempt: count,
    maximumSpatialLayer: spatialLayer,
    observedSpatialLayer: spatialLayer.nullable(),
  }),
  meet_webcam_consumer_generation_reset_scheduled: z.object({
    reason: WEBCAM_RESET_REASON,
    maximumSpatialLayer: spatialLayer,
  }),
  meet_turn_relay_activated: z.object({ reason: TURN_FALLBACK_REASON }),
  meet_webcam_codec_policy_changed: z.object({ from: CODEC, to: CODEC, epoch: count }),
  meet_consumer_resume_exhausted: z.object({ kind: MEDIA_KIND, attempts: count, reason: RESUME_FAILURE }),
  meet_consumer_resume_recovered: z.object({ kind: MEDIA_KIND, attempts: count }),
  meet_stale_consumer_recovery_started: staleConsumer,
  meet_stale_consumer_recovered: staleConsumer,
  meet_stale_consumer_recovery_failed: staleConsumer.extend({ failureReason: STALE_CONSUMER_FAILURE }),
  meet_admin_notice_received: z.object({ level: z.enum(["info", "warning", "error"]) }),
  meet_audio_consumer_auto_resumed: z.object({ pausedForMs: ms.nullable() }),
  meet_participant_connection_state: z.object({
    state: z.enum(["reconnecting", "reconnected"]),
    downtimeMs: ms.optional(),
  }),
  meet_reconnect_attempt: z.object({ attempt: count, maxAttempts: count, usingTurnFallback: flag }),
  meet_reconnect_success: z.object({ attempt: count, usingTurnFallback: flag }),
  meet_reconnect_attempt_failure: z.object({
    attempt: count,
    maxAttempts: count,
    failure_reason: RECONNECT_FAILURE,
    usingTurnFallback: flag,
  }),
  meet_reconnect_give_up: z.object({ attempts: count, failure_reason: RECONNECT_FAILURE, usingTurnFallback: flag }),
  meet_join_attempt: z.object({ joinMode: JOIN_MODE, isAdmin: flag }),
  meet_join_success: z.object({ joinMode: JOIN_MODE, status: z.enum(["joined", "waiting"]) }),
  meet_join_failure: z.object({ joinMode: JOIN_MODE, failure_reason: MEET_FAILURE }),
} as const;

export type OutboundEventName = keyof typeof TELEMETRY_EVENTS;
/** The events our code captures with telemetry.capture; exceptions go through captureException. */
export type TelemetryEventName = Exclude<OutboundEventName, "$exception">;
export type TelemetryEventProps<N extends OutboundEventName> = z.input<(typeof TELEMETRY_EVENTS)[N]>;
export type ExceptionProps = TelemetryEventProps<"$exception">;

export const isOutboundEventName = (value: unknown): value is OutboundEventName =>
  typeof value === "string" && Object.hasOwn(TELEMETRY_EVENTS, value);

/** What the forms of an event's values depend on: the project and the build it came from. */
export type OutboundContext = {
  token: string;
  /** A build this deployment shipped, or UNKNOWN_BUILD. */
  clientVersion: string;
  /** That build's chunk ids and the file each was injected into. */
  chunkFiles: ReadonlyMap<string, string>;
};

/** A stack frame: its file only when it is one of ours, and no function name. */
const frameForm = (chunkFiles: ReadonlyMap<string, string>) => {
  const chunkPaths = new Set(chunkFiles.values());
  return z.object({
    platform: z.literal("web:javascript"),
    function: z.literal("?"),
    filename: z
      .string()
      .refine(
        (file) =>
          (FRAME_PLACEHOLDERS as readonly string[]).includes(file) ||
          file === PATH_WITHHELD ||
          FIRST_PARTY_SCRIPTS.has(file) ||
          chunkPaths.has(file),
      )
      .optional(),
    lineno: position.optional(),
    colno: position.optional(),
    in_app: flag.optional(),
    chunk_id: uuid.refine((id) => chunkFiles.has(id)).optional(),
  });
};

const exceptionListForm = (chunkFiles: ReadonlyMap<string, string>) =>
  z
    .array(
      z.object({
        type: z.enum([...KNOWN_ERROR_TYPES, TYPE_WITHHELD]),
        value: z.enum([...CALL_LOG_LABELS, MESSAGE_WITHHELD]),
        mechanism: z
          .object({
            type: z.enum(MECHANISM_TYPES),
            handled: flag.optional(),
            synthetic: flag.optional(),
            exception_id: position.optional(),
            parent_id: position.optional(),
          })
          .optional(),
        stacktrace: z.object({ type: z.literal("raw"), frames: z.array(frameForm(chunkFiles)).max(500) }).optional(),
      }),
    )
    .max(50);

/** The properties posthog-js gives every event that we send, and the ones we add. */
const SDK_PROPERTIES = {
  distinct_id: uuid,
  $device_id: uuid,
  $session_id: uuid,
  $window_id: uuid,
  $host: z.literal(TELEMETRY_HOST),
  $current_url: z.enum(ROUTES),
  $pathname: z.enum(ROUTES),
  $lib: z.literal("web"),
  $lib_version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/),
  $process_person_profile: z.literal(false),
  $browser: z.enum(BROWSERS),
  $browser_version: z.number().min(0).max(10_000),
  $browser_language: z.enum(LANGUAGES),
  $browser_language_prefix: z.enum(LANGUAGES),
  $os: z.enum(OPERATING_SYSTEMS),
  $os_version: z.string().regex(/^\d{1,5}(?:\.\d{1,5}){0,3}$/),
  $device_type: z.enum(DEVICE_TYPES),
  $screen_height: pixels,
  $screen_width: pixels,
  $viewport_height: pixels,
  $viewport_width: pixels,
  $timezone_offset: z.number().int().min(-1440).max(1440),
  $exception_level: z.enum(EXCEPTION_LEVELS),
};

/**
 * The schema of each event for one context: every property the event may
 * carry and the form of each value. Built once per context and kept per event.
 */
export const createOutboundSchemas = ({ token, clientVersion, chunkFiles }: OutboundContext) => {
  const contextual = {
    token: z.literal(token),
    client_version: z.literal(clientVersion),
    $exception_list: exceptionListForm(chunkFiles),
  };
  const schemas = new Map<OutboundEventName, z.ZodObject<Record<string, z.ZodType>>>();
  return (name: OutboundEventName): z.ZodObject<Record<string, z.ZodType>> => {
    let schema = schemas.get(name);
    if (!schema) {
      schema = z.object({ ...SDK_PROPERTIES, ...contextual, ...TELEMETRY_EVENTS[name].shape });
      schemas.set(name, schema);
    }
    return schema;
  };
};
