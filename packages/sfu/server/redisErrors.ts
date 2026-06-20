import { Logger } from "../utilities/loggers.js";

const REDIS_TRANSIENT_ERROR_NAMES = new Set([
  "AbortError",
  "ClientClosedError",
  "ClientOfflineError",
  "ConnectionTimeoutError",
  "DisconnectsClientError",
  "ReconnectStrategyError",
  "SocketClosedUnexpectedlyError",
  "SocketTimeoutError",
  "TimeoutError",
]);

const REDIS_TRANSIENT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

export const isRedisTransientError = (error: unknown): boolean => {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as {
          name?: unknown;
          code?: unknown;
          message?: unknown;
          constructor?: { name?: unknown };
        })
      : null;
  const name =
    typeof candidate?.name === "string"
      ? candidate.name
      : typeof candidate?.constructor?.name === "string"
        ? candidate.constructor.name
        : null;
  const code = typeof candidate?.code === "string" ? candidate.code : null;
  const message =
    typeof candidate?.message === "string" ? candidate.message : "";

  if (name && REDIS_TRANSIENT_ERROR_NAMES.has(name)) {
    return true;
  }

  if (code && REDIS_TRANSIENT_ERROR_CODES.has(code)) {
    return true;
  }

  if (/redis/i.test(message) && /timeout|closed|offline|connect/i.test(message)) {
    return true;
  }

  return false;
};

export const installRedisCrashGuards = (): void => {
  process.on("unhandledRejection", (reason) => {
    if (isRedisTransientError(reason)) {
      Logger.warn(
        "[Redis] Suppressed unhandled transient Redis rejection; SFU remains online.",
        reason,
      );
      return;
    }

    Logger.error("[Process] Unhandled promise rejection", reason);
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    if (isRedisTransientError(error)) {
      Logger.warn(
        "[Redis] Suppressed uncaught transient Redis exception; SFU remains online.",
        error,
      );
      return;
    }

    Logger.error("[Process] Uncaught exception", error);
    process.exit(1);
  });
};
