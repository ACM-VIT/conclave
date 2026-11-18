import { describe, expect, it } from "vitest";
import {
  MAX_CONSUMER_PRIORITY,
  parseConsumerPriority,
  shouldExplicitlyRequestConsumerKeyFrame,
} from "../server/mediaPolicy.js";

describe("consumer priority policy", () => {
  it("accepts the mediasoup priority range", () => {
    expect(parseConsumerPriority(1)).toEqual({ ok: true, value: 1 });
    expect(parseConsumerPriority(MAX_CONSUMER_PRIORITY)).toEqual({
      ok: true,
      value: MAX_CONSUMER_PRIORITY,
    });
  });

  it("rejects zero before it reaches mediasoup", () => {
    expect(parseConsumerPriority(0)).toEqual({
      ok: false,
      error: "Invalid consumer priority",
    });
  });

  it("rejects non-integer and out-of-range priorities", () => {
    for (const value of [-1, 1.5, MAX_CONSUMER_PRIORITY + 1, NaN]) {
      expect(parseConsumerPriority(value)).toEqual({
        ok: false,
        error: "Invalid consumer priority",
      });
    }
  });

  it("preserves unset and explicit priority reset semantics", () => {
    expect(parseConsumerPriority(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(parseConsumerPriority(null, { allowNull: true })).toEqual({
      ok: true,
      value: null,
    });
  });
});

describe("producer keyframe request policy", () => {
  it("does not duplicate mediasoup's paused-video resume keyframe", () => {
    expect(
      shouldExplicitlyRequestConsumerKeyFrame({
        kind: "video",
        wasPaused: true,
        requested: true,
      }),
    ).toBe(false);
    expect(
      shouldExplicitlyRequestConsumerKeyFrame({
        kind: "video",
        wasPaused: true,
        requested: false,
      }),
    ).toBe(false);
  });

  it("retains explicit keyframes for flowing video stall recovery only", () => {
    expect(
      shouldExplicitlyRequestConsumerKeyFrame({
        kind: "video",
        wasPaused: false,
        requested: true,
      }),
    ).toBe(true);
    expect(
      shouldExplicitlyRequestConsumerKeyFrame({
        kind: "video",
        wasPaused: false,
        requested: false,
      }),
    ).toBe(false);
    expect(
      shouldExplicitlyRequestConsumerKeyFrame({
        kind: "audio",
        wasPaused: false,
        requested: true,
      }),
    ).toBe(false);
  });
});
