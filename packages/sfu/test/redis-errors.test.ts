import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AbortError,
  ClientClosedError,
  ClientOfflineError,
  CommandTimeoutDuringMaintenanceError,
  ConnectionTimeoutError,
  DisconnectsClientError,
  ReconnectStrategyError,
  SocketClosedUnexpectedlyError,
  SocketTimeoutDuringMaintenanceError,
  SocketTimeoutError,
  TimeoutError,
} from "redis";
import { isRedisTransientError } from "../server/redisErrors.js";

const nodeSocketError = (code: string, message: string): Error => {
  const error = new Error(message) as Error & { code: string; syscall: string };
  error.code = code;
  error.syscall = "read";
  // Node-internal stream stack: no @redis/client frames, so the code is the
  // only classification signal (this shape crashed a live SFU once).
  error.stack = `Error: ${message}\n    at TLSWrap.onStreamRead (node:internal/stream_base_commons:216:20)`;
  return error;
};

describe("isRedisTransientError", () => {
  it.each([
    new TimeoutError(),
    new AbortError(),
    new ClientClosedError(),
    new ClientOfflineError(),
    new ConnectionTimeoutError(),
    new DisconnectsClientError(),
    new ReconnectStrategyError(new Error("retry exhausted"), new Error("socket")),
    new SocketClosedUnexpectedlyError(),
    new SocketTimeoutError(1000),
    new CommandTimeoutDuringMaintenanceError(1000),
    new SocketTimeoutDuringMaintenanceError(1000),
  ])("classifies a real Redis $constructor.name despite its generic name", (error) => {
    expect(error.name).toBe("Error");
    expect(isRedisTransientError(error)).toBe(true);
  });

  it("recognizes Redis timeout subclasses without depending on their names", () => {
    class CommandDeadlineExceeded extends TimeoutError {}
    const error = new CommandDeadlineExceeded();
    error.name = "Custom deadline";
    expect(isRedisTransientError(error)).toBe(true);
  });

  it("does not trust a matching name on an unrelated error", () => {
    const UnrelatedTimeoutError = class TimeoutError extends Error {};
    expect(isRedisTransientError(new UnrelatedTimeoutError())).toBe(false);
    const error = new Error("programming bug");
    error.name = "TimeoutError";
    expect(isRedisTransientError(error)).toBe(false);
  });

  it("classifies interface-loss reads from the redis TLS socket as transient", () => {
    expect(
      isRedisTransientError(nodeSocketError("EADDRNOTAVAIL", "read EADDRNOTAVAIL")),
    ).toBe(true);
  });

  it("classifies DNS and reset errnos as transient", () => {
    expect(
      isRedisTransientError(
        nodeSocketError("ENOTFOUND", "getaddrinfo ENOTFOUND star-pig.upstash.io"),
      ),
    ).toBe(true);
    expect(
      isRedisTransientError(nodeSocketError("ECONNRESET", "read ECONNRESET")),
    ).toBe(true);
  });

  it("classifies redis command queue saturation as transient", () => {
    const error = new Error("The queue is full");
    error.stack = [
      "Error: The queue is full",
      "    at RedisCommandsQueue.addCommand (/app/node_modules/@redis/client/lib/client/commands-queue.ts:264:29)",
      "    at Class.publish (/app/node_modules/@redis/client/lib/client/index.ts:297:25)",
    ].join("\n");
    expect(isRedisTransientError(error)).toBe(true);
  });

  it("does not swallow unrelated programming errors", () => {
    expect(isRedisTransientError(new TypeError("x is not a function"))).toBe(false);
    expect(isRedisTransientError(new Error("boom"))).toBe(false);
    expect(isRedisTransientError(new Error())).toBe(false);
  });

  it("does not treat startup port conflicts as transient", () => {
    expect(
      isRedisTransientError(nodeSocketError("EADDRINUSE", "listen EADDRINUSE")),
    ).toBe(false);
  });
});

describe("Redis crash guards", () => {
  const runGuard = (
    event: "unhandledRejection" | "uncaughtException",
    errorExpression: string,
  ) => {
    const guardUrl = new URL("../server/redisErrors.ts", import.meta.url).href;
    const code = `
      import { TimeoutError, AbortError } from "redis";
      import { installRedisCrashGuards } from ${JSON.stringify(guardUrl)};
      installRedisCrashGuards();
      const error = ${errorExpression};
      ${event === "unhandledRejection"
        ? "void Promise.reject(error);"
        : "setImmediate(() => { throw error; });"}
      setTimeout(() => console.log("SFU_STILL_RUNNING"), 25);
    `;
    return spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, SFU_LOG_LEVEL: "warn" },
      },
    );
  };

  describe.each(["unhandledRejection", "uncaughtException"] as const)(
    "%s",
    (event) => {
      it.each(["TimeoutError", "AbortError"])(
        "keeps the process running after a real Redis %s",
        (errorClass) => {
          const result = runGuard(event, `new ${errorClass}()`);
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          expect(result.stdout).toContain("SFU_STILL_RUNNING");
          expect(result.stderr).toContain("Suppressed");
        },
      );

      it("still exits for an unrelated programming error", () => {
        const result = runGuard(event, 'new TypeError("programming bug")');
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).not.toContain("SFU_STILL_RUNNING");
        expect(result.stderr).toContain("programming bug");
      });
    },
  );
});
