/**
 * Server error tracking for the SFU (PostHog error tracking).
 *
 * Every exception carries the instance id, region and version so a spike can
 * be tied to one box. Reporting never throws, never waits on the network
 * (except `reportFatal`, which is bounded), and is rate limited per error so a
 * client that keeps sending a malformed packet cannot flood the project.
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
  report(error: unknown, context: ServerErrorContext): void;
  /** Sends the exception and everything queued, waiting at most `timeoutMs`. Never rejects. */
  reportFatal(
    error: unknown,
    context: ServerErrorContext,
    timeoutMs: number,
  ): Promise<void>;
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

  const prepare = (
    error: unknown,
    { source, level = "error", properties = {} }: ServerErrorContext,
  ): { client: ExceptionClient; options: CaptureOptions } | null => {
    const client = getClient();
    if (!client) return null;
    if (!allow(errorFingerprint(error, source))) return null;
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
    report(error, context) {
      try {
        const prepared = prepare(error, context);
        prepared?.client.captureException(error, prepared.options);
      } catch (failure) {
        onReportFailure(failure);
      }
    },

    async reportFatal(error, context, timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const prepared = prepare(error, { level: "fatal", ...context });
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
        onReportFailure(failure);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
};

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const URL_QUERY_PATTERN = /(\bhttps?:\/\/[^\s?#"']+)[?#][^\s"']*/gi;

/** Removes emails, tokens and URL query strings from an error message. */
export const scrubErrorText = (value: string): string =>
  value
    .replace(JWT_PATTERN, "[token]")
    .replace(EMAIL_PATTERN, "[email]")
    .replace(URL_QUERY_PATTERN, "$1");

type ExceptionListEntry = { value?: unknown };

/** posthog-node `beforeSend` hook: scrubs exception messages, passes other events through. */
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
      $exception_list: list.map((entry: ExceptionListEntry) =>
        typeof entry?.value === "string"
          ? { ...entry, value: scrubErrorText(entry.value) }
          : entry,
      ),
    },
  };
};
