import { describe, expect, it } from "vitest";
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
  });

  it("does not treat startup port conflicts as transient", () => {
    expect(
      isRedisTransientError(nodeSocketError("EADDRINUSE", "listen EADDRINUSE")),
    ).toBe(false);
  });
});
