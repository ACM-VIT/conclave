/**
 * Server error tracking for the SFU (PostHog error tracking).
 *
 * Every exception carries the instance id, region and version so a spike can
 * be tied to one box. Reporting never throws, never waits on the network
 * (except `reportFatal`, which is bounded), and is rate limited per error so a
 * client that keeps sending a malformed packet cannot flood the project. The
 * fatal report sits outside that budget: the process sends it once, then exits.
 */

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
    report: (error, context) => {
      try {
        const prepared = prepare(error, context, { budgeted: true });
        prepared?.client.captureException(error, prepared.options);
      } catch (failure) {
        failed(failure);
      }
    },

    reportFatal: async (error, context, timeoutMs) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const prepared = prepare(
          error,
          { level: "fatal", ...context },
          { budgeted: false },
        );
        if (!prepared) return;
        const delivery = Promise.allSettled([
          prepared.client.captureExceptionImmediate(error, prepared.options),
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
// The account name in a home folder: /Users/<name>, /home/<name>, C:\Users\<name>.
const HOME_FOLDER_PATTERN = /(?:\/Users|\/home)\/[^/\s"'`]+|[A-Za-z]:\\Users\\[^\\\s"'`]+/g;

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
  value.replace(HOME_FOLDER_PATTERN, "~");

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
  value?: unknown;
  stacktrace?: { frames?: unknown } & Record<string, unknown>;
};

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

const scrubEntry = (entry: ExceptionListEntry): ExceptionListEntry => ({
  ...entry,
  ...(typeof entry?.value === "string" ? { value: scrubErrorText(entry.value) } : {}),
  ...(entry?.stacktrace && Array.isArray(entry.stacktrace.frames)
    ? {
        stacktrace: {
          ...entry.stacktrace,
          frames: (entry.stacktrace.frames as ExceptionFrame[]).map(scrubFrame),
        },
      }
    : {}),
});

/**
 * posthog-node `beforeSend` hook: scrubs exception messages and drops source
 * context from stack frames; passes other events through.
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
