import {
  AbortError,
  ClientClosedError,
  ClientOfflineError,
  ConnectionTimeoutError,
  DisconnectsClientError,
  ReconnectStrategyError,
  SocketClosedUnexpectedlyError,
  SocketTimeoutError,
  TimeoutError,
} from "redis";
import { Logger } from "../utilities/loggers.js";

const REDIS_TRANSIENT_ERROR_TYPES = [
  AbortError,
  ClientClosedError,
  ClientOfflineError,
  ConnectionTimeoutError,
  DisconnectsClientError,
  ReconnectStrategyError,
  SocketClosedUnexpectedlyError,
  SocketTimeoutError,
  TimeoutError,
];

const REDIS_TRANSIENT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "EAI_FAIL",
  // Local interface changed/went away mid-connection (sleep, VPN, Wi-Fi hop):
  // surfaces as `read EADDRNOTAVAIL` from the TLS socket with a node-internal
  // stack, so the code is the only reliable signal.
  "EADDRNOTAVAIL",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENETDOWN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

export const isRedisTransientError = (error: unknown): boolean => {
  // Redis subclasses inherit name="Error" and may have empty messages.
  // Use their real types; TimeoutError also covers maintenance subclasses.
  if (REDIS_TRANSIENT_ERROR_TYPES.some((ErrorType) => error instanceof ErrorType)) {
    return true;
  }

  const candidate =
    typeof error === "object" && error !== null
      ? (error as {
          code?: unknown;
          message?: unknown;
          stack?: unknown;
        })
      : null;
  const code = typeof candidate?.code === "string" ? candidate.code : null;
  const message =
    typeof candidate?.message === "string" ? candidate.message : "";
  const stack = typeof candidate?.stack === "string" ? candidate.stack : "";
  const redisStack = /(?:@redis\/client|node_modules\/(?:@redis|redis))/i.test(
    stack,
  );

  if (code && REDIS_TRANSIENT_ERROR_CODES.has(code)) {
    return true;
  }

  if (/redis/i.test(message) && /timeout|closed|offline|connect/i.test(message)) {
    return true;
  }

  if (
    redisStack &&
    /timeout|closed|offline|connect|queue is full|commands queue/i.test(message)
  ) {
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
