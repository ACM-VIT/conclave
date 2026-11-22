import type { CaptureResult, Properties } from "posthog-js";

const STATIC_PAGES = new Set([
  "schedule",
  "sfu-admin",
  "privacy",
  "delete-account",
  "sign-in",
]);
// Room codes let anyone join, and user ids can embed an email.
const DROPPED_PROPERTIES = new Set(["$title", "roomId", "userId"]);
// Campaign and click-id parameters, plus the SDK's $initial_ and
// $session_entry_ copies. They can carry emails and ad ids.
const ATTRIBUTION_PROPERTY =
  /^(?:\$initial_|\$session_entry_)?(?:utm_\w+|gad_source|mc_cid|gclsrc|gbraid|wbraid|msclkid|li_fat_id|igshid|rdt_cid|epik|sccid|oppref|bfcid|_kx|\w*clid|\$fb[cp])$/;
// Values we set or the SDK needs as-is: the project key in `token` must
// survive for ingestion, and `client_version` is a git sha, not a secret.
const TRUSTED_PROPERTIES = new Set(["token", "distinct_id", "client_version"]);
const URL_PROPERTY = /url|referrer|pathname|href/i;
const MAX_TEXT_LENGTH = 1000;

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{40,}\b/g;
const URL_IN_TEXT_PATTERN = /\bhttps?:\/\/[^\s"'<>)]+/gi;
// Our own script folders. A stack frame in one keeps its path so PostHog can
// match it to a source map.
const ASSET_PATH_PREFIXES = [
  "/_next/static/",
  "/mediapipe/",
  "/effects/",
  "/noise-suppressor/",
  "/_/rtcvidproc/",
];

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

/** Removes emails, tokens and URL details from free text. */
export function scrubText(value: string): string {
  return value
    .slice(0, MAX_TEXT_LENGTH)
    .replace(URL_IN_TEXT_PATTERN, (url) => scrubHttpUrl(url) ?? "[url]")
    .replace(JWT_PATTERN, "[token]")
    .replace(EMAIL_PATTERN, "[email]")
    .replace(LONG_TOKEN_PATTERN, "[token]");
}

type ExceptionFrame = Record<string, unknown>;
type ExceptionEntry = {
  value?: unknown;
  stacktrace?: { frames?: ExceptionFrame[] } & Record<string, unknown>;
} & Record<string, unknown>;

const scrubFrameUrl = (value: string): string => {
  try {
    const url = new URL(value);
    const ownScript =
      (url.protocol === "http:" || url.protocol === "https:") &&
      ASSET_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
    if (ownScript) return `${url.origin}${url.pathname}`;
  } catch {
  }
  return scrubUrl(value);
};

const scrubFrame = (frame: ExceptionFrame): ExceptionFrame => {
  const next = { ...frame };
  for (const key of ["filename", "abs_path"]) {
    const value = next[key];
    if (typeof value === "string") next[key] = scrubFrameUrl(value);
  }
  return next;
};

// Thrown as ServerError (lib/server-error.ts): text the server wrote.
const SERVER_ERROR_TYPE = "ServerError";

const scrubExceptionValue = (entry: ExceptionEntry): unknown => {
  if (entry.type === SERVER_ERROR_TYPE) return "[server message]";
  return typeof entry.value === "string" ? scrubText(entry.value) : entry.value;
};

const scrubExceptionEntry = (entry: ExceptionEntry): ExceptionEntry => ({
  ...entry,
  value: scrubExceptionValue(entry),
  ...(entry.stacktrace && Array.isArray(entry.stacktrace.frames)
    ? {
        stacktrace: {
          ...entry.stacktrace,
          frames: entry.stacktrace.frames.map(scrubFrame),
        },
      }
    : {}),
});

function scrubProperties(properties: Properties): Properties {
  const scrubbed: Properties = {};
  const entries: Array<[string, unknown]> = Object.entries(properties);
  for (const [key, value] of entries) {
    if (DROPPED_PROPERTIES.has(key) || ATTRIBUTION_PROPERTY.test(key)) continue;
    if (key === "$exception_list" && Array.isArray(value)) {
      scrubbed[key] = (value as ExceptionEntry[]).map(scrubExceptionEntry);
    } else if (typeof value === "string" && URL_PROPERTY.test(key)) {
      scrubbed[key] = scrubUrl(value);
    } else if (
      typeof value === "string" &&
      !key.startsWith("$") &&
      !TRUSTED_PROPERTIES.has(key)
    ) {
      scrubbed[key] = scrubText(value);
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

/**
 * posthog-js `before_send` hook. Every event leaves the browser without room
 * codes, user ids, query strings, page titles, emails or tokens.
 */
export function scrubTelemetryEvent(event: CaptureResult): CaptureResult {
  return {
    ...event,
    properties: scrubProperties(event.properties),
    ...(event.$set ? { $set: scrubProperties(event.$set) } : {}),
    ...(event.$set_once ? { $set_once: scrubProperties(event.$set_once) } : {}),
  };
}
