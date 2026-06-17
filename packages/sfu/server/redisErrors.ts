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
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

export const isRedisTransientError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithCode = error as Error & { code?: string };
  if (REDIS_TRANSIENT_ERROR_NAMES.has(error.name)) {
    return true;
  }

  if (errorWithCode.code && REDIS_TRANSIENT_ERROR_CODES.has(errorWithCode.code)) {
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
