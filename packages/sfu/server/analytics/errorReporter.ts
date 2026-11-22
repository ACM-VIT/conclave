/**
 * Server error tracking for the SFU (PostHog error tracking).
 *
 * Every exception carries the instance id, region and version so a spike can
 * be tied to one box. Reporting never throws, never waits on the network
 * (except `reportFatal`, which is bounded), and is rate limited per error so a
 * client that keeps sending a malformed packet cannot flood the project. The
 * fatal report sits outside that budget: the process sends it once, then exits.
 */

import { getSystemErrorMap } from "node:util";
import { ConfigError } from "../configError.js";

export type ServerErrorSource =
  | "uncaught_exception"
  | "unhandled_rejection"
  | "startup_failed"
  | "socket_handler"
  | "worker_died"
  | "worker_respawn_failed"
  | "redis_transient";

export type ServerErrorLevel = "fatal" | "error" | "warning";

export type ServerErrorProperties = Record<string, string | number | boolean>;

type CaptureOptions = {
  distinctId: string;
  properties: Record<string, string | number | boolean>;
  level: ServerErrorLevel;
};

/** The slice of the posthog-node client this module uses. */
export type ExceptionClient = {
  captureException(error: unknown, options: CaptureOptions): void;
  captureExceptionImmediate(
    error: unknown,
    options: CaptureOptions,
  ): Promise<void>;
  flush(): Promise<void>;
};

export type ErrorReporterOptions = {
  getClient: () => ExceptionClient | null;
  instanceId: string;
  region: string | null;
  version: string;
  now?: () => number;
  onReportFailure?: (error: unknown) => void;
};

export type ServerErrorContext = {
  source: ServerErrorSource;
  level?: ServerErrorLevel;
  properties?: ServerErrorProperties;
};

export type ErrorReporter = {
  report: (error: unknown, context: ServerErrorContext) => void;
  /** Sends the exception and everything queued, waiting at most `timeoutMs`. Never rejects. */
  reportFatal: (
    error: unknown,
    context: ServerErrorContext,
    timeoutMs: number,
  ) => Promise<void>;
};

/** What a thrown or rejected value that is not an Error is reported as. */
class NonErrorValue extends Error {
  constructor(value: unknown) {
    super(`non-Error ${value === null ? "null" : typeof value} thrown or rejected`);
    this.name = "NonErrorValue";
  }
}

// A rejected string or object would otherwise reach PostHog as the message,
// or with its own `name` as the type.
const asError = (error: unknown): Error =>
  error instanceof Error ? error : new NonErrorValue(error);

// Type names that name a kind of failure, never data: built-in errors and the
// libraries the SFU calls (redis, mediasoup, jsonwebtoken). Our own classes
// are told apart with instanceof, never by name.
const KNOWN_ERROR_TYPES = new Set([
  "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError",
  "URIError", "AggregateError", "AbortError", "ClientClosedError", "ClientOfflineError",
  "ConnectionTimeoutError", "DisconnectsClientError", "ReconnectStrategyError",
  "SocketClosedUnexpectedlyError", "SocketTimeoutError", "TimeoutError", "ErrorReply",
  "WatchError", "UnsupportedError", "InvalidStateError", "JsonWebTokenError",
  "TokenExpiredError", "NotBeforeError",
]);
const ERRNO_CODES = new Set([...getSystemErrorMap().values()].map(([name]) => name));
const ERRNO_MESSAGE = /^([A-Z][A-Z0-9_]*): \[message withheld\]$/;
const MESSAGE_WITHHELD = "[message withheld]";
const TYPE_WITHHELD = "[type withheld]";
const MAX_CAUSE_DEPTH = 3;

// The messages of real ConfigError and NonErrorValue instances that were
// reported, which name a variable or a typeof and nothing else. beforeSend
// keeps a message only when it is one of these or an errno code.
const chosenMessages = new Set<string>();
const MAX_CHOSEN_MESSAGES = 200;

const chooseMessage = (error: Error, trusted: boolean): string => {
  if (trusted) {
    const message = scrubErrorText(error.message);
    if (chosenMessages.size < MAX_CHOSEN_MESSAGES) chosenMessages.add(message);
    if (chosenMessages.has(message)) return message;
  }
  const { code } = error as NodeJS.ErrnoException;
  return typeof code === "string" && ERRNO_CODES.has(code)
    ? `${code}: ${MESSAGE_WITHHELD}`
    : MESSAGE_WITHHELD;
};

// V8 writes "Name: message" above the frames.
const framesOf = (stack: string | undefined): string => {
  const firstFrame = stack?.indexOf("\n    at ") ?? -1;
  return stack && firstFrame >= 0 ? stack.slice(firstFrame) : "";
};

/**
 * The error that is sent, built while the original is at hand: a known type,
 * a message only from our constant-message classes (checked with instanceof)
 * or the errno code in `error.code`, the original frames, and its causes.
 */
const reportedError = (thrown: unknown, depth = 0): Error => {
  const error = asError(thrown);
  const trusted = error instanceof ConfigError || error instanceof NonErrorValue;
  const name = trusted
    ? error instanceof ConfigError ? "ConfigError" : "NonErrorValue"
    : KNOWN_ERROR_TYPES.has(error.name) ? error.name : TYPE_WITHHELD;
  const message = chooseMessage(error, trusted);
  const cause =
    error.cause !== undefined && depth < MAX_CAUSE_DEPTH
      ? { cause: reportedError(error.cause, depth + 1) }
      : undefined;
  const reported = new Error(message, cause);
  reported.name = name;
  reported.stack = `${name}: ${message}${framesOf(error.stack)}`;
  return reported;
};

const RATE_WINDOW_MS = 60_000;
const MAX_REPORTS_PER_KEY_PER_WINDOW = 5;
const MAX_REPORTS_PER_WINDOW = 60;
const MAX_TRACKED_KEYS = 500;

const errorFingerprint = (error: unknown, source: ServerErrorSource): string => {
  if (error instanceof Error) {
    const firstLine = (error.message || "").split("\n", 1)[0].slice(0, 160);
    return `${source}:${error.name}:${firstLine}`;
  }
  return `${source}:${typeof error}:${String(error).slice(0, 160)}`;
};

const createRateLimiter = (now: () => number) => {
  let windowStart = now();
  let totalInWindow = 0;
  const perKey = new Map<string, number>();
  return (key: string): boolean => {
    const at = now();
    if (at - windowStart >= RATE_WINDOW_MS) {
      windowStart = at;
      totalInWindow = 0;
      perKey.clear();
    }
    const used = perKey.get(key) ?? 0;
    if (used >= MAX_REPORTS_PER_KEY_PER_WINDOW) return false;
    if (totalInWindow >= MAX_REPORTS_PER_WINDOW) return false;
    if (!perKey.has(key) && perKey.size >= MAX_TRACKED_KEYS) return false;
    perKey.set(key, used + 1);
    totalInWindow += 1;
    return true;
  };
};

export const createErrorReporter = ({
  getClient,
  instanceId,
  region,
  version,
  now = Date.now,
  onReportFailure = () => {},
}: ErrorReporterOptions): ErrorReporter => {
  const allow = createRateLimiter(now);
  const distinctId = `sfu_${instanceId}`;
  const failed = (failure: unknown) => {
    try {
      onReportFailure(failure);
    } catch {}
  };

  const prepare = (
    error: unknown,
    { source, level = "error", properties = {} }: ServerErrorContext,
    { budgeted }: { budgeted: boolean },
  ): { client: ExceptionClient; options: CaptureOptions } | null => {
    const client = getClient();
    if (!client) return null;
    if (budgeted && !allow(errorFingerprint(error, source))) return null;
    return {
      client,
      options: {
        distinctId,
        level,
        properties: {
          ...properties,
          source,
          sfu_instance_id: instanceId,
          sfu_region: region ?? "unset",
          sfu_version: version,
          $process_person_profile: false,
        },
      },
    };
  };

  return {
    report: (thrown, context) => {
      try {
        const error = asError(thrown);
        const prepared = prepare(error, context, { budgeted: true });
        prepared?.client.captureException(reportedError(error), prepared.options);
      } catch (failure) {
        failed(failure);
      }
    },

    reportFatal: async (thrown, context, timeoutMs) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const error = asError(thrown);
        const prepared = prepare(
          error,
          { level: "fatal", ...context },
          { budgeted: false },
        );
        if (!prepared) return;
        const delivery = Promise.allSettled([
          prepared.client.captureExceptionImmediate(reportedError(error), prepared.options),
          prepared.client.flush(),
        ]);
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        await Promise.race([delivery, deadline]);
      } catch (failure) {
        failed(failure);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
};

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{40,}\b/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>)]+/gi;
// Any scheme with user info: redis://:pass@host, postgres://user:pass@host,
// https://token@host. The whole URI goes, host included.
const CREDENTIAL_URI_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@"'<>]*@[^\s"'<>)]*/gi;
// Headers whose whole value is a credential: everything to the end of the line.
const CREDENTIAL_HEADER_PATTERN =
  /\b(cookie|set-cookie|authorization|proxy-authorization)(\s*:)[^\r\n]*/gi;
const AUTH_SCHEME_PATTERN = /\b(bearer|basic)\s+[^\s,;"']+/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|session)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi;
// The account name in a home folder: /Users/<name>, /home/<name>,
// C:\Users\<name>. A name may hold spaces when the path goes on after it.
const HOME_FOLDER_PATTERNS = [
  /(?:\/Users|\/home)\/[^/"'`\r\n]+(?=\/)/g,
  /(?:\/Users|\/home)\/[^/\s"'`]+/g,
  /[A-Za-z]:\\Users\\[^\\"'`\r\n]+(?=\\)/g,
  /[A-Za-z]:\\Users\\[^\\\s"'`]+/g,
];

/** Replaces the meeting code or ids in a path, like the web scrubber does. */
const templatePath = (pathname: string): string => {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  if (segments[0] === "w") return "/w/[code]";
  return segments.length === 1 ? "/[code]" : "/[path]";
};

const scrubUrl = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.origin}${templatePath(url.pathname)}`;
  } catch {
    return "[url]";
  }
};

const scrubHomeFolders = (value: string): string =>
  HOME_FOLDER_PATTERNS.reduce((text, pattern) => text.replace(pattern, "~"), value);

/**
 * Removes credentials (URIs with user info, credential headers, auth tokens,
 * secret assignments), URL paths and queries, home folder names, emails and
 * tokens from an error message.
 */
export const scrubErrorText = (value: string): string =>
  scrubHomeFolders(
    value
      .replace(CREDENTIAL_URI_PATTERN, "[credentials]")
      .replace(URL_PATTERN, scrubUrl)
      .replace(CREDENTIAL_HEADER_PATTERN, "$1$2 [redacted]")
      .replace(AUTH_SCHEME_PATTERN, "$1 [redacted]")
      .replace(SECRET_ASSIGNMENT_PATTERN, "$1$2[redacted]"),
  )
    .replace(JWT_PATTERN, "[token]")
    .replace(EMAIL_PATTERN, "[email]")
    .replace(LONG_TOKEN_PATTERN, "[token]");

type ExceptionFrame = Record<string, unknown>;
type ExceptionListEntry = {
  type?: unknown;
  value?: unknown;
  stacktrace?: { frames?: unknown } & Record<string, unknown>;
};

/**
 * A message is sent only when the capture chose it (see reportedError), or it
 * is an errno code; any other text is withheld.
 */
const trustedMessage = (value: unknown): string => {
  if (typeof value !== "string") return MESSAGE_WITHHELD;
  if (chosenMessages.has(value)) return value;
  const code = ERRNO_MESSAGE.exec(value)?.[1];
  return code && ERRNO_CODES.has(code) ? value : MESSAGE_WITHHELD;
};

// Our own classes, by the names reportedError gives only to real instances.
const SENT_TYPES = new Set([...KNOWN_ERROR_TYPES, "ConfigError", "NonErrorValue"]);

// posthog-node reads the lines around each frame from disk. They are source,
// not data, but a literal in that source still leaves the box, so they go.
// Frame paths keep their shape minus any home folder's account name.
const scrubFrame = (frame: ExceptionFrame): ExceptionFrame => {
  const {
    pre_context: _before,
    context_line: _line,
    post_context: _after,
    ...rest
  } = frame;
  for (const key of ["filename", "abs_path"]) {
    const path = rest[key];
    if (typeof path === "string") rest[key] = scrubHomeFolders(path);
  }
  return rest;
};

const scrubEntry = (entry: ExceptionListEntry): ExceptionListEntry => {
  const type =
    typeof entry?.type === "string" && SENT_TYPES.has(entry.type) ? entry.type : TYPE_WITHHELD;
  return {
    ...entry,
    type,
    value: trustedMessage(entry?.value),
    ...(entry?.stacktrace && Array.isArray(entry.stacktrace.frames)
      ? {
          stacktrace: {
            ...entry.stacktrace,
            frames: (entry.stacktrace.frames as ExceptionFrame[]).map(scrubFrame),
          },
        }
      : {}),
  };
};

/**
 * posthog-node `beforeSend` hook: an exception keeps only a known type, a
 * message we wrote, and frames without source lines or account names; other
 * events pass through.
 */
export const scrubExceptionEvent = <
  T extends { event: string; properties?: Record<string, unknown> },
>(
  message: T,
): T => {
  if (message.event !== "$exception" || !message.properties) return message;
  const list = message.properties.$exception_list;
  if (!Array.isArray(list)) return message;
  return {
    ...message,
    properties: {
      ...message.properties,
      $exception_list: list.map(scrubEntry),
    },
  };
};
