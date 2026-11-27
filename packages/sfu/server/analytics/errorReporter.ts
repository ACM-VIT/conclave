/**
 * Server error tracking for the SFU (PostHog error tracking).
 *
 * Every exception carries the instance, region and version so a spike can
 * be tied to one box. Reporting never throws, never waits on the network
 * (except `reportFatal`, which is bounded), and is rate limited per error so a
 * client that keeps sending a malformed packet cannot flood the project. The
 * fatal report sits outside that budget: the process sends it once, then exits.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { getSystemErrorMap } from "node:util";
import { z } from "zod";
import { ConfigError } from "../configError.js";

export const SERVER_ERROR_SOURCES = [
  "uncaught_exception",
  "unhandled_rejection",
  "startup_failed",
  "socket_handler",
  "worker_died",
  "worker_respawn_failed",
  "redis_transient",
] as const;
export type ServerErrorSource = (typeof SERVER_ERROR_SOURCES)[number];

export const SERVER_ERROR_LEVELS = ["fatal", "error", "warning"] as const;
export type ServerErrorLevel = (typeof SERVER_ERROR_LEVELS)[number];

/**
 * The SFU's release: the version its own package declares, never text an
 * operator configured. "unknown" when the package cannot be read.
 */
export const SFU_RELEASE = ((): string => {
  try {
    const parsed = z
      .object({ version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/) })
      .safeParse(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")));
    return parsed.success ? parsed.data.version : "unknown";
  } catch {
    return "unknown";
  }
})();

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
  /** The configured instance name; only its keyed hash is sent. */
  instanceId: string;
  /** The key for that hash: the real SFU_SECRET, or one that lives only in this process. */
  hashKey: string | Uint8Array;
  region: string | null;
  /** The SFU's release, SFU_RELEASE. */
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
export const MESSAGE_WITHHELD = "[message withheld]";
export const TYPE_WITHHELD = "[type withheld]";
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

const headerEnd = (stack: string, message: string): number => {
  if (message === "") {
    const lineEnd = stack.indexOf("\n");
    return lineEnd < 0 ? stack.length : lineEnd;
  }
  const separator = stack.indexOf(": ");
  if (separator < 0 || stack.slice(0, separator).includes("\n")) return -1;
  return stack.startsWith(message, separator + 2) ? separator + 2 + message.length : -1;
};

const framesOf = (error: Error): string => {
  const { stack } = error;
  if (!stack) return "";
  const end = headerEnd(stack, typeof error.message === "string" ? error.message : "");
  if (end < 0) return "";
  const firstFrame = stack.indexOf("\n    at ", end);
  return firstFrame === end ? stack.slice(firstFrame) : "";
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
  reported.stack = `${name}: ${message}${framesOf(error)}`;
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

// The configured instance and region are operator text, so each goes out
// only in a form we can vouch for: the instance as a keyed hash (also the
// distinct id), and the region from this list.
const hashedInstance = (instanceId: string, key: string | Uint8Array): string =>
  `sfu_${createHmac("sha256", key).update(`instance:${instanceId}`).digest("hex").slice(0, 16)}`;

const REGIONS = new Set([
  "local",
  // AWS.
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1",
  "eu-south-1", "eu-south-2", "me-central-1", "me-south-1", "af-south-1", "il-central-1",
  "ap-south-1", "ap-south-2", "ap-southeast-1", "ap-southeast-2", "ap-southeast-3",
  "ap-southeast-4", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-east-1",
  // Azure.
  "centralindia", "southindia", "westindia", "eastus", "eastus2", "centralus", "westus",
  "westus2", "westus3", "canadacentral", "brazilsouth", "northeurope", "westeurope",
  "uksouth", "ukwest", "francecentral", "germanywestcentral", "swedencentral",
  "uaenorth", "southafricanorth", "southeastasia", "eastasia", "japaneast", "japanwest",
  "koreacentral", "australiaeast", "australiasoutheast",
]);
const listedRegion = (region: string | null): string =>
  region === null ? "unset" : REGIONS.has(region) ? region : "other";
/** Every value sfu_region takes. */
export const SENT_REGIONS: readonly string[] = [...REGIONS, "unset", "other"];

export const createErrorReporter = ({
  getClient,
  instanceId,
  hashKey,
  region,
  version,
  now = Date.now,
  onReportFailure = () => {},
}: ErrorReporterOptions): ErrorReporter => {
  const allow = createRateLimiter(now);
  const distinctId = hashedInstance(instanceId, hashKey);
  const sentRegion = listedRegion(region);
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
          sfu_instance_id: distinctId,
          sfu_region: sentRegion,
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

/**
 * Whether an exception's message is one the capture chose (see
 * reportedError), an errno code, or withheld: the only messages sent.
 */
export const isSentMessage = (value: string): boolean => {
  if (value === MESSAGE_WITHHELD || chosenMessages.has(value)) return true;
  const code = ERRNO_MESSAGE.exec(value)?.[1];
  return code !== undefined && ERRNO_CODES.has(code);
};

/** Every type an exception is sent with: known kinds, and our own classes by the names reportedError gives only to real instances. */
export const SENT_ERROR_TYPES: readonly string[] = [...KNOWN_ERROR_TYPES, "ConfigError", "NonErrorValue", TYPE_WITHHELD];
