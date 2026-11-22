import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCorsOrigins } from "../server/cors.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SFU_CORS_ORIGINS", () => {
  it("names the variable and entry, never the rejected value", () => {
    vi.stubEnv(
      "SFU_CORS_ORIGINS",
      "https://conclave.test,redis://:review-secret@127.0.0.1:6379/0",
    );

    expect(() => resolveCorsOrigins()).toThrow("Invalid SFU_CORS_ORIGINS entry at index 1");
    try {
      resolveCorsOrigins();
    } catch (error) {
      expect(String(error)).not.toMatch(/review-secret|redis|127\.0\.0\.1/);
    }
  });
});
