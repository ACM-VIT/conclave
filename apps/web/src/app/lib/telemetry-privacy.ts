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
// Values we set or the SDK needs as-is: the project key in `token` must
// survive for ingestion, and `client_version` is a git sha, not a secret.
const TRUSTED_PROPERTIES = new Set(["token", "distinct_id", "client_version"]);
const URL_PROPERTY = /url|referrer|pathname|href/i;
const MAX_TEXT_LENGTH = 1000;

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{40,}\b/g;
const URL_IN_TEXT_PATTERN = /\bhttps?:\/\/[^\s"'<>)]+/gi;

/**
 * Replaces room codes, invite slugs and booking handles in a path with the
 * route they belong to. Static assets keep their path, because PostHog needs
 * it to find the source map for a stack frame.
 */
export function templatePath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  const [first] = segments;
  if (!first) return "/";
  if (first === "_next" || segments.at(-1)?.includes(".")) return pathname;
  if (first === "w") return "/w/[code]";
  if (first === "book") return "/book/[username]/[eventSlug]";
  if (segments.length === 1) {
    return STATIC_PAGES.has(first) ? `/${first}` : "/[code]";
  }
  return STATIC_PAGES.has(first) ? `/${first}/[path]` : "/[path]";
}

/** Keeps the origin and route of a URL and drops its query and hash. */
export function scrubUrl(value: string): string {
  if (value.startsWith("/")) return templatePath(value.split(/[?#]/, 1)[0]);
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return scrubText(value);
    }
    return `${url.origin}${templatePath(url.pathname)}`;
  } catch {
    return scrubText(value);
  }
}

/** Removes emails, tokens and URL details from free text. */
export function scrubText(value: string): string {
  return value
    .slice(0, MAX_TEXT_LENGTH)
    .replace(URL_IN_TEXT_PATTERN, (url) => scrubUrl(url))
    .replace(JWT_PATTERN, "[token]")
    .replace(EMAIL_PATTERN, "[email]")
    .replace(LONG_TOKEN_PATTERN, "[token]");
}

type ExceptionFrame = Record<string, unknown>;
type ExceptionEntry = {
  value?: unknown;
  stacktrace?: { frames?: ExceptionFrame[] } & Record<string, unknown>;
} & Record<string, unknown>;

const scrubFrame = (frame: ExceptionFrame): ExceptionFrame => {
  const next = { ...frame };
  for (const key of ["filename", "abs_path"]) {
    const value = next[key];
    if (typeof value === "string") next[key] = scrubUrl(value);
  }
  return next;
};

const scrubExceptionEntry = (entry: ExceptionEntry): ExceptionEntry => ({
  ...entry,
  ...(typeof entry.value === "string" ? { value: scrubText(entry.value) } : {}),
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
  for (const [key, value] of Object.entries(properties)) {
    if (DROPPED_PROPERTIES.has(key)) continue;
    if (key === "$exception_list" && Array.isArray(value)) {
      scrubbed[key] = value.map(scrubExceptionEntry);
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
