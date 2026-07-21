import { describe, expect, it } from "vitest";
import {
  decideWebcamStartupResetAttempt,
  decideWebcamStartupResetPoll,
  decideWebcamStartupResetVerification,
  enqueueWebcamStartupResetProducer,
  getConsumerMaximumSpatialLayer,
  getWebcamStartupResetQueueDelayMs,
  isCurrentConsumerGeneration,
  isProducerPauseSnapshotCurrent,
  isVp8SimulcastConsumerEligibleForStartupReset,
} from "../src/app/lib/webcam-consumer-generation-reset";

const poll = (
  overrides: Partial<Parameters<typeof decideWebcamStartupResetPoll>[0]> = {},
) =>
  decideWebcamStartupResetPoll({
    now: 5_000,
    deadlineAt: 15_000,
    stableForMs: 4_500,
    highLayerSince: 500,
    previousConsumerId: "consumer-1",
    currentConsumerId: "consumer-1",
    consumerClosed: false,
    trackReadyState: "live",
    trackMuted: false,
    producerPaused: false,
    adaptivelyPaused: false,
    observedSpatialLayer: 2,
    maximumSpatialLayer: 2,
    ...overrides,
  });

describe("webcam startup consumer generation reset", () => {
  it("derives the highest spatial layer from a multi-spatial consumer", () => {
    expect(
      getConsumerMaximumSpatialLayer([
        { scalabilityMode: "L2T1" },
        { scalabilityMode: "L3T3_KEY" },
      ]),
    ).toBe(2);
  });

  it("fails closed for true-single L1T1 consumers", () => {
    expect(getConsumerMaximumSpatialLayer([{ scalabilityMode: "L1T1" }])).toBe(
      null,
    );
    expect(poll({ maximumSpatialLayer: 0, observedSpatialLayer: 0 })).toEqual({
      action: "wait",
      highLayerSince: null,
    });
  });

  it("is eligible only for proven VP8 simulcast, not VP9 SVC", () => {
    expect(
      isVp8SimulcastConsumerEligibleForStartupReset({
        consumerType: "simulcast",
        codecs: [{ mimeType: "video/VP8" }],
        maximumSpatialLayer: 2,
      }),
    ).toBe(true);
    expect(
      isVp8SimulcastConsumerEligibleForStartupReset({
        consumerType: "svc",
        codecs: [{ mimeType: "video/VP9" }],
        maximumSpatialLayer: 2,
      }),
    ).toBe(false);
    expect(
      isVp8SimulcastConsumerEligibleForStartupReset({
        consumerType: "simulcast",
        codecs: [{ mimeType: "video/VP8" }],
        maximumSpatialLayer: 0,
      }),
    ).toBe(false);
    expect(
      isVp8SimulcastConsumerEligibleForStartupReset({
        consumerType: undefined,
        codecs: [{ mimeType: "video/VP8" }],
        maximumSpatialLayer: 2,
      }),
    ).toBe(false);
  });

  it("deduplicates and deterministically orders queued producers", () => {
    expect(enqueueWebcamStartupResetProducer(["producer-b"], "producer-a")).toEqual(
      ["producer-a", "producer-b"],
    );
    expect(
      enqueueWebcamStartupResetProducer(
        ["producer-a", "producer-b"],
        "producer-a",
      ),
    ).toEqual(["producer-a", "producer-b"]);
  });

  it("enforces a quiet interval after the previous replacement", () => {
    expect(
      getWebcamStartupResetQueueDelayMs({
        now: 1_500,
        lastFinishedAt: 1_000,
        minimumSpacingMs: 1_000,
      }),
    ).toBe(500);
    expect(
      getWebcamStartupResetQueueDelayMs({
        now: 2_000,
        lastFinishedAt: 1_000,
        minimumSpacingMs: 1_000,
      }),
    ).toBe(0);
    expect(
      getWebcamStartupResetQueueDelayMs({
        now: 100,
        lastFinishedAt: 0,
        minimumSpacingMs: 1_000,
      }),
    ).toBe(0);
  });

  it("queues only after the owned generation is playable on its high layer", () => {
    expect(poll()).toEqual({ action: "queue", highLayerSince: 500 });
    expect(poll({ trackMuted: true })).toEqual({
      action: "wait",
      highLayerSince: null,
    });
    expect(poll({ observedSpatialLayer: 1 })).toEqual({
      action: "wait",
      highLayerSince: null,
    });
  });

  it("requires sustained high-layer convergence and resets the window on a drop", () => {
    expect(
      poll({ now: 1_000, highLayerSince: null }),
    ).toEqual({ action: "wait", highLayerSince: 1_000 });
    expect(
      poll({ now: 5_499, highLayerSince: 1_000 }),
    ).toEqual({ action: "wait", highLayerSince: 1_000 });
    expect(
      poll({ now: 5_500, highLayerSince: 1_000 }),
    ).toEqual({ action: "queue", highLayerSince: 1_000 });
    expect(
      poll({
        now: 3_000,
        highLayerSince: 1_000,
        observedSpatialLayer: 1,
      }),
    ).toEqual({ action: "wait", highLayerSince: null });
  });

  it("cancels a poll owned by a displaced consumer generation", () => {
    expect(poll({ currentConsumerId: "consumer-2" })).toEqual({
      action: "cancel",
      reason: "consumer-generation-changed",
    });
  });

  it("preserves producer-scoped state when a displaced generation closes", () => {
    expect(
      isCurrentConsumerGeneration({
        currentConsumerId: "consumer-2",
        closingConsumerId: "consumer-1",
      }),
    ).toBe(false);
    expect(
      isCurrentConsumerGeneration({
        currentConsumerId: "consumer-2",
        closingConsumerId: "consumer-2",
      }),
    ).toBe(true);
  });

  it("does not apply an ACK pause snapshot after a newer ordered update", () => {
    expect(
      isProducerPauseSnapshotCurrent({
        requestRevision: 4,
        currentRevision: 4,
      }),
    ).toBe(true);
    expect(
      isProducerPauseSnapshotCurrent({
        requestRevision: 4,
        currentRevision: 5,
      }),
    ).toBe(false);
  });

  it("bounds the high-layer convergence wait", () => {
    expect(
      poll({
        now: 15_000,
        trackMuted: true,
      }),
    ).toEqual({
      action: "fail",
      reason: "high-layer-convergence-timeout",
    });
  });

  it("expires the absolute deadline even after a stable high-layer window", () => {
    expect(
      poll({
        now: 15_000,
        highLayerSince: 1_000,
      }),
    ).toEqual({
      action: "fail",
      reason: "high-layer-convergence-timeout",
    });
  });

  it("recognizes only a new attached generation as an attempt success", () => {
    expect(
      decideWebcamStartupResetAttempt({
        previousConsumerId: "consumer-1",
        currentConsumerId: "consumer-2",
        attempt: 1,
        maximumAttempts: 2,
      }),
    ).toEqual({
      action: "verify",
      replacementConsumerId: "consumer-2",
    });
    expect(
      decideWebcamStartupResetAttempt({
        previousConsumerId: "consumer-1",
        currentConsumerId: "consumer-1",
        attempt: 1,
        maximumAttempts: 2,
      }),
    ).toEqual({
      action: "retry",
      reason: "replacement-not-attached",
    });
  });

  it("stops retrying after the bounded attempt budget", () => {
    expect(
      decideWebcamStartupResetAttempt({
        previousConsumerId: "consumer-1",
        currentConsumerId: "consumer-1",
        attempt: 2,
        maximumAttempts: 2,
      }),
    ).toEqual({
      action: "fail",
      reason: "replacement-attempts-exhausted",
    });
  });

  it("marks completion only when the replacement is current and playable", () => {
    const base = {
      now: 1_100,
      verificationStartedAt: 1_000,
      verificationTimeoutMs: 4_000,
      replacementConsumerId: "consumer-2",
      currentConsumerId: "consumer-2",
      consumerClosed: false,
      trackReadyState: "live" as const,
      trackMuted: false,
      framesDecoded: 1,
      bytesReceived: 1,
    };
    expect(decideWebcamStartupResetVerification(base)).toEqual({
      action: "complete",
    });
    expect(
      decideWebcamStartupResetVerification({ ...base, trackMuted: true }),
    ).toEqual({ action: "wait" });
    expect(
      decideWebcamStartupResetVerification({ ...base, framesDecoded: 0 }),
    ).toEqual({ action: "wait" });
    expect(
      decideWebcamStartupResetVerification({ ...base, bytesReceived: 0 }),
    ).toEqual({ action: "wait" });
    expect(
      decideWebcamStartupResetVerification({
        ...base,
        currentConsumerId: "consumer-3",
      }),
    ).toEqual({
      action: "cancel",
      reason: "replacement-generation-changed",
    });
  });

  it("bounds replacement playability verification", () => {
    expect(
      decideWebcamStartupResetVerification({
        now: 5_000,
        verificationStartedAt: 1_000,
        verificationTimeoutMs: 4_000,
        replacementConsumerId: "consumer-2",
        currentConsumerId: "consumer-2",
        consumerClosed: false,
        trackReadyState: "live",
        trackMuted: true,
        framesDecoded: 0,
        bytesReceived: 0,
      }),
    ).toEqual({
      action: "fail",
      reason: "replacement-not-playable",
    });
  });
});
