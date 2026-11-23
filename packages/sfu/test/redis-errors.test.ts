import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  type CrashGuardReporting,
  installRedisCrashGuards,
  isRedisTransientError,
} from "../server/redisErrors.js";
import { Logger } from "../utilities/loggers.js";

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
  // A process the guards listen on: the test raises its events and sees its
  // exits, and each report settles only when the test says so.
  const guarded = (reporting: CrashGuardReporting = {}) => {
    const target = Object.assign(new EventEmitter(), { exit: vi.fn((_code: number) => {}) });
    installRedisCrashGuards(reporting, target);
    return target;
  };
  const report = () => {
    let settle: (outcome: "sent" | "failed") => void = () => {};
    const sent = new Promise<void>((resolve, reject) => {
      settle = (outcome) => (outcome === "sent" ? resolve() : reject(new Error("report failed")));
    });
    return { onFatal: vi.fn((_error: unknown, _event: string) => sent), settle };
  };
  // Runs every promise callback already queued: the guard's chain is only those.
  const drain = () => new Promise((resolve) => setImmediate(resolve));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(["unhandledRejection", "uncaughtException"] as const)("%s", (event) => {
    it.each([
      ["TimeoutError", () => new TimeoutError()],
      ["AbortError", () => new AbortError()],
    ])("keeps the process running after a real Redis %s", async (_name, error) => {
      const warn = vi.spyOn(Logger, "warn").mockImplementation(() => {});
      const target = guarded();
      target.emit(event, error());
      await drain();

      expect(target.exit).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Suppressed"), expect.anything());
    });

    it("still exits for an unrelated programming error", () => {
      const logged = vi.spyOn(Logger, "error").mockImplementation(() => {});
      const target = guarded();
      const error = new TypeError("programming bug");
      target.emit(event, error);

      expect(target.exit).toHaveBeenCalledTimes(1);
      expect(target.exit).toHaveBeenCalledWith(1);
      expect(logged).toHaveBeenCalledWith(expect.any(String), error);
    });

    it("reports a fatal error before exiting", async () => {
      vi.spyOn(Logger, "error").mockImplementation(() => {});
      const fatal = report();
      const target = guarded({ onFatal: fatal.onFatal });
      target.emit(event, new TypeError("programming bug"));
      await drain();

      expect(fatal.onFatal).toHaveBeenCalledWith(expect.objectContaining({ message: "programming bug" }), event);
      expect(target.exit).not.toHaveBeenCalled();
      fatal.settle("sent");
      await drain();
      expect(target.exit).toHaveBeenCalledTimes(1);
      expect(target.exit).toHaveBeenCalledWith(1);
    });

    it("exits when the report fails", async () => {
      vi.spyOn(Logger, "error").mockImplementation(() => {});
      const fatal = report();
      const target = guarded({ onFatal: fatal.onFatal });
      target.emit(event, new TypeError("programming bug"));
      fatal.settle("failed");
      await drain();

      expect(target.exit).toHaveBeenCalledTimes(1);
      expect(target.exit).toHaveBeenCalledWith(1);
    });

    it("exits at once for a second fatal error while the first is reported", async () => {
      vi.spyOn(Logger, "error").mockImplementation(() => {});
      const fatal = report();
      const target = guarded({ onFatal: fatal.onFatal });
      target.emit(event, new TypeError("programming bug"));
      await drain();
      target.emit(event, new TypeError("another bug"));

      expect(fatal.onFatal).toHaveBeenCalledTimes(1);
      expect(target.exit).toHaveBeenCalledTimes(1);
      expect(target.exit).toHaveBeenCalledWith(1);
    });

    it("reports a suppressed Redis error and stays up", async () => {
      vi.spyOn(Logger, "warn").mockImplementation(() => {});
      const onSuppressed = vi.fn();
      const fatal = report();
      const target = guarded({ onSuppressed, onFatal: fatal.onFatal });
      const error = new TimeoutError();
      target.emit(event, error);
      await drain();

      expect(onSuppressed).toHaveBeenCalledWith(error, event);
      expect(fatal.onFatal).not.toHaveBeenCalled();
      expect(target.exit).not.toHaveBeenCalled();
    });
  });

  // The one check in a real process: with no process given, the guards
  // listen on this one and exit it. A cold start through tsx takes a few
  // seconds under load; the deadline is far past that.
  const SMOKE_DEADLINE_MS = 60_000;

  it(
    "guards the real process by default: stays up through a Redis rejection, then exits for a programming error",
    () => {
      const guardUrl = new URL("../server/redisErrors.ts", import.meta.url).href;
      const code = `
        import { TimeoutError } from "redis";
        import { installRedisCrashGuards } from ${JSON.stringify(guardUrl)};
        installRedisCrashGuards();
        void Promise.reject(new TimeoutError());
        setImmediate(() => {
          console.log("SFU_STILL_RUNNING");
          throw new TypeError("programming bug");
        });
      `;
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        timeout: SMOKE_DEADLINE_MS,
        env: { ...process.env, SFU_LOG_LEVEL: "warn" },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("SFU_STILL_RUNNING");
      expect(result.stderr).toContain("Suppressed");
      expect(result.stderr).toContain("programming bug");
    },
    SMOKE_DEADLINE_MS + 10_000,
  );
});
