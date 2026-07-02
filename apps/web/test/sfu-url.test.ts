import { afterEach, describe, expect, it } from "vitest";
import { resolveSfuUrls } from "../src/lib/sfu-url";

const sfuEnvKeys = [
  "SFU_URLS",
  "SFU_POOL_URLS",
  "SFU_POOL",
  "NEXT_PUBLIC_SFU_URLS",
  "SFU_URL",
  "NEXT_PUBLIC_SFU_URL",
] as const;

const originalEnv = Object.fromEntries(
  sfuEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof sfuEnvKeys)[number], string | undefined>;

const clearSfuEnv = (): void => {
  for (const key of sfuEnvKeys) {
    delete process.env[key];
  }
};

afterEach(() => {
  clearSfuEnv();
  for (const key of sfuEnvKeys) {
    if (originalEnv[key] !== undefined) {
      process.env[key] = originalEnv[key];
    }
  }
});

describe("resolveSfuUrls", () => {
  it("uses explicit pool urls without appending singleton fallback urls", () => {
    clearSfuEnv();
    process.env.SFU_URLS = "https://sfu-a.acmvit.in,https://sfu-b.acmvit.in";
    process.env.NEXT_PUBLIC_SFU_URL = "https://sfu.acmvit.in";

    expect(resolveSfuUrls()).toEqual([
      "https://sfu-a.acmvit.in",
      "https://sfu-b.acmvit.in",
    ]);
  });

  it("uses singleton urls when no pool is configured", () => {
    clearSfuEnv();
    process.env.NEXT_PUBLIC_SFU_URL = "https://sfu.acmvit.in";

    expect(resolveSfuUrls()).toEqual(["https://sfu.acmvit.in"]);
  });

  it("normalizes labeled pool entries and removes exact duplicate urls", () => {
    clearSfuEnv();
    process.env.SFU_POOL =
      "sfu-a=https://sfu-a.acmvit.in/,sfu-b=https://sfu-b.acmvit.in,duplicate=https://sfu-a.acmvit.in";

    expect(resolveSfuUrls()).toEqual([
      "https://sfu-a.acmvit.in",
      "https://sfu-b.acmvit.in",
    ]);
  });
});
