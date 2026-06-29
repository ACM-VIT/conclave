import { describe, expect, it } from "vitest";
import {
  takeTranscriptRateLimit,
  type TranscriptRateLimitState,
} from "../transcript-worker/src/rate-limit";

describe("takeTranscriptRateLimit", () => {
  it("allows requests up to the bucket max", () => {
    const state: TranscriptRateLimitState = {};
    const now = 1_000;

    for (let index = 0; index < 10; index += 1) {
      expect(takeTranscriptRateLimit(state, "qa", now)).toBe(true);
    }
    expect(takeTranscriptRateLimit(state, "qa", now)).toBe(false);
  });

  it("resets the bucket after its window", () => {
    const state: TranscriptRateLimitState = {};
    const now = 1_000;

    for (let index = 0; index < 8; index += 1) {
      expect(takeTranscriptRateLimit(state, "session", now)).toBe(true);
    }
    expect(takeTranscriptRateLimit(state, "session", now)).toBe(false);
    expect(takeTranscriptRateLimit(state, "session", now + 60_001)).toBe(true);
  });

  it("tracks buckets independently", () => {
    const state: TranscriptRateLimitState = {};

    for (let index = 0; index < 10; index += 1) {
      expect(takeTranscriptRateLimit(state, "qa", 2_000)).toBe(true);
    }

    expect(takeTranscriptRateLimit(state, "qa", 2_000)).toBe(false);
    expect(takeTranscriptRateLimit(state, "minutes", 2_000)).toBe(true);
  });
});
