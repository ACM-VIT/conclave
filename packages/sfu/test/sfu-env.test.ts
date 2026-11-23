import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSfuEnv, readSfuEnv } from "../config/env.js";
import { retryInBackground } from "../server/persistThenApply.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

const loadConfig = (extra: Record<string, string>) =>
  spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "await import('./config/config.ts')"], {
    cwd: packageDir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SFU_DEBUG_SECRET: "0", ...extra },
    encoding: "utf8",
  });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SFU_FOLLOW_UP_RETRY_DELAYS_MS", () => {
  it("uses the default delays when it is unset or blank", () => {
    for (const value of [undefined, "", " , "]) {
      expect(readSfuEnv("SFU_FOLLOW_UP_RETRY_DELAYS_MS", { SFU_FOLLOW_UP_RETRY_DELAYS_MS: value })).toEqual([5_000, 30_000, 120_000]);
    }
  });

  it("drops blank entries from a set list", () => {
    expect(readSfuEnv("SFU_FOLLOW_UP_RETRY_DELAYS_MS", { SFU_FOLLOW_UP_RETRY_DELAYS_MS: " 20, ,40 " })).toEqual([20, 40]);
  });

  it("names the setting and the entry when a value is invalid", () => {
    for (const [value, message] of [
      ["abc", /SFU_FOLLOW_UP_RETRY_DELAYS_MS entry 1: must be a whole number of milliseconds/],
      ["20,-5", /SFU_FOLLOW_UP_RETRY_DELAYS_MS entry 2: must not be negative/],
      ["1.5", /SFU_FOLLOW_UP_RETRY_DELAYS_MS entry 1: must be a whole number of milliseconds/],
    ] as const) {
      expect(() => readSfuEnv("SFU_FOLLOW_UP_RETRY_DELAYS_MS", { SFU_FOLLOW_UP_RETRY_DELAYS_MS: value })).toThrow(message);
      expect(() => parseSfuEnv({ SFU_FOLLOW_UP_RETRY_DELAYS_MS: value })).toThrow(message);
    }
  });

  it("retries a failed follow-up at 5s, 30s and 2min when it is unset, then gives up", async () => {
    vi.stubEnv("SFU_FOLLOW_UP_RETRY_DELAYS_MS", undefined);
    for (const method of ["warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
    vi.useFakeTimers();
    const attempt = vi.fn(() => Promise.reject(new Error("database is locked")));

    retryInBackground("saving a follow-up", attempt);
    const callsAt = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      return attempt.mock.calls.length;
    };

    expect(await callsAt(4_999)).toBe(0);
    expect(await callsAt(1)).toBe(1);
    expect(await callsAt(29_999)).toBe(1);
    expect(await callsAt(1)).toBe(2);
    expect(await callsAt(120_000)).toBe(3);
    expect(await callsAt(600_000)).toBe(3);
  });
});

describe("the SFU environment at startup", () => {
  it("fails with a message naming each invalid setting", () => {
    const result = loadConfig({ SFU_FOLLOW_UP_RETRY_DELAYS_MS: "5000,soon" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Invalid SFU environment:\s+SFU_FOLLOW_UP_RETRY_DELAYS_MS entry 2: must be a whole number of milliseconds/);
  });

  it("starts with every setting unset", () => {
    const result = loadConfig({});
    expect(result.status, result.stderr).toBe(0);
  });
});
