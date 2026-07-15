import { describe, expect, it } from "vitest";
import {
  advanceConsumerScoreAdaptation,
  getConsumerScoreSample,
  getEffectiveConsumerReceiveQuality,
} from "../src/app/lib/adaptive-consumer-score";

describe("getConsumerScoreSample", () => {
  it("uses the worst authoritative score for the selected producer layer", () => {
    expect(
      getConsumerScoreSample({
        score: {
          score: 9,
          producerScore: 8,
          producerScores: [10, 3, 10],
        },
        currentSpatialLayer: 1,
        receivedAtMs: 1_000,
        nowMs: 2_000,
      }),
    ).toEqual({ score: 3, quality: "poor" });
  });

  it("does not treat an unselected producer layer as receive degradation", () => {
    expect(
      getConsumerScoreSample({
        score: {
          score: 9,
          producerScore: 9,
          producerScores: [2, 9, 10],
        },
        currentSpatialLayer: 1,
        receivedAtMs: 1_000,
        nowMs: 2_000,
      }),
    ).toEqual({ score: 9, quality: "good" });
  });

  it("prefers selected-layer evidence over a stale aggregate stream score", () => {
    expect(
      getConsumerScoreSample({
        score: {
          score: 9,
          producerScore: 3,
          producerScores: [9, 9, 9],
        },
        currentSpatialLayer: 2,
        receivedAtMs: 1_000,
        nowMs: 2_000,
      }),
    ).toEqual({ score: 9, quality: "good" });
  });

  it("maps every SVC spatial layer to its sole producer RTP stream", () => {
    expect(
      getConsumerScoreSample({
        score: {
          score: 10,
          producerScore: 0,
          producerScores: [10],
        },
        currentSpatialLayer: 2,
        receivedAtMs: 1_000,
        nowMs: 2_000,
      }),
    ).toEqual({ score: 10, quality: "good" });
  });

  it("does not mistake an unselected healthy stream for degradation", () => {
    expect(
      getConsumerScoreSample({
        score: {
          score: 10,
          producerScore: 0,
          producerScores: [10],
        },
        currentSpatialLayer: null,
        receivedAtMs: 1_000,
        nowMs: 2_000,
      }),
    ).toEqual({ score: 10, quality: "good" });
  });

  it("degrades an unselected producer only when every stream is unhealthy", () => {
    expect(
      getConsumerScoreSample({
        score: {
          score: 10,
          producerScore: 0,
          producerScores: [0, 0, 0],
        },
        currentSpatialLayer: null,
        receivedAtMs: 1_000,
        nowMs: 2_000,
      }),
    ).toEqual({ score: 0, quality: "poor" });
  });

  it("falls back to the aggregate score when producer streams are absent", () => {
    expect(
      getConsumerScoreSample({
        score: {
          score: 10,
          producerScore: 3,
          producerScores: [],
        },
        currentSpatialLayer: null,
        receivedAtMs: 1_000,
        nowMs: 2_000,
      }),
    ).toEqual({ score: 3, quality: "poor" });
  });

  it("keeps the latest unchanged score for the same consumer generation", () => {
    expect(
      getConsumerScoreSample({
        score: { score: 2 },
        currentSpatialLayer: 0,
        receivedAtMs: 0,
        nowMs: 60_000,
      }),
    ).toEqual({ score: 2, quality: "poor" });
  });

  it("rejects malformed or future-dated score evidence", () => {
    expect(
      getConsumerScoreSample({
        score: { score: 2 },
        currentSpatialLayer: 0,
        receivedAtMs: 2_001,
        nowMs: 2_000,
      }),
    ).toEqual({ score: null, quality: "unknown" });
    expect(
      getConsumerScoreSample({
        score: { score: 12, producerScore: Number.NaN },
        currentSpatialLayer: 0,
        receivedAtMs: 1_000,
        nowMs: 2_000,
      }),
    ).toEqual({ score: null, quality: "unknown" });
  });
});

describe("advanceConsumerScoreAdaptation", () => {
  it("degrades immediately and requires sustained evidence to recover", () => {
    const good = advanceConsumerScoreAdaptation({
      consumerId: "consumer-a",
      sampleQuality: "good",
      nowMs: 0,
    });
    const poor = advanceConsumerScoreAdaptation({
      consumerId: "consumer-a",
      sampleQuality: "poor",
      previousState: good,
      nowMs: 1_000,
    });
    expect(poor.quality).toBe("poor");

    const recovering = advanceConsumerScoreAdaptation({
      consumerId: "consumer-a",
      sampleQuality: "good",
      previousState: poor,
      nowMs: 2_000,
    });
    expect(recovering).toMatchObject({
      quality: "poor",
      recoveryQuality: "good",
      recoveryStartedAtMs: 2_000,
      unknownStartedAtMs: null,
    });
    expect(
      advanceConsumerScoreAdaptation({
        consumerId: "consumer-a",
        sampleQuality: "good",
        previousState: recovering,
        nowMs: 9_499,
      }).quality,
    ).toBe("poor");
    expect(
      advanceConsumerScoreAdaptation({
        consumerId: "consumer-a",
        sampleQuality: "good",
        previousState: recovering,
        nowMs: 9_500,
      }),
    ).toMatchObject({
      quality: "good",
      recoveryQuality: null,
      recoveryStartedAtMs: null,
      unknownStartedAtMs: null,
    });
  });

  it("does not upgrade a degraded generation without a score-change event", () => {
    const poor = advanceConsumerScoreAdaptation({
      consumerId: "consumer-a",
      sampleQuality: "poor",
      nowMs: 0,
    });
    const stale = advanceConsumerScoreAdaptation({
      consumerId: "consumer-a",
      sampleQuality: "unknown",
      previousState: poor,
      nowMs: 10_000,
    });
    expect(stale).toMatchObject({
      quality: "poor",
      recoveryQuality: null,
      recoveryStartedAtMs: null,
      unknownStartedAtMs: 10_000,
    });
    expect(
      advanceConsumerScoreAdaptation({
        consumerId: "consumer-a",
        sampleQuality: "unknown",
        previousState: stale,
        nowMs: 60_000,
      }).quality,
    ).toBe("poor");
    expect(
      advanceConsumerScoreAdaptation({
        consumerId: "consumer-a",
        sampleQuality: "good",
        previousState: stale,
        nowMs: 60_001,
      }),
    ).toMatchObject({
      quality: "poor",
      recoveryQuality: "good",
      recoveryStartedAtMs: 60_001,
    });
  });

  it("does not carry score history into a replacement consumer generation", () => {
    const previous = advanceConsumerScoreAdaptation({
      consumerId: "consumer-old",
      sampleQuality: "poor",
      nowMs: 0,
    });
    expect(
      advanceConsumerScoreAdaptation({
        consumerId: "consumer-new",
        sampleQuality: "good",
        previousState: previous,
        nowMs: 1_000,
      }),
    ).toEqual({
      consumerId: "consumer-new",
      quality: "good",
      recoveryQuality: null,
      recoveryStartedAtMs: null,
      unknownStartedAtMs: null,
    });
  });
});

describe("getEffectiveConsumerReceiveQuality", () => {
  it("honors isolated consumer degradation on an otherwise good link", () => {
    expect(getEffectiveConsumerReceiveQuality("good", "poor")).toBe("poor");
    expect(getEffectiveConsumerReceiveQuality("fair", "poor")).toBe("poor");
    expect(getEffectiveConsumerReceiveQuality("good", "fair")).toBe("fair");
  });

  it("keeps the aggregate path as the upper quality bound", () => {
    expect(getEffectiveConsumerReceiveQuality("poor", "good")).toBe("poor");
    expect(getEffectiveConsumerReceiveQuality("fair", "unknown")).toBe(
      "fair",
    );
    expect(getEffectiveConsumerReceiveQuality("unknown", "unknown")).toBe(
      "good",
    );
  });
});
