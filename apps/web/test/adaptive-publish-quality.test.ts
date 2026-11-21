import { describe, expect, it, vi } from "vitest";
import {
  createLatestWinsAsyncQueue,
  getPublishProducerEncodingDebugSnapshot,
  getCameraCaptureRestoreMinimums,
  getStandardCaptureRestoreRetryAfter,
  hasUsableWebcamSingleLayerReplacementOffer,
  isReceiverCapacityProofUsableForProducer,
  isVp8SingleReceiverTopologyApplied,
  isStandardCaptureRestoreRetryDue,
  needsConfiguredCameraCaptureRestore,
  shouldOptimizeVp8ForSingleReceiver,
  shouldRequestProducerTransportRecoveryKeyFrame,
  shouldReleaseProducerTransportProfileBeforeSenderFallback,
  shouldUseProducerTransportNetworkProfile,
} from "../src/app/hooks/useAdaptivePublishQuality";

describe("adaptive publish debug evidence", () => {
  it("reports the applied sender scalability mode", () => {
    expect(
      getPublishProducerEncodingDebugSnapshot({
        rid: "f",
        active: true,
        maxBitrate: 1_650_000,
        scalabilityMode: "L1T1",
      } as RTCRtpEncodingParameters & { scalabilityMode: string }),
    ).toMatchObject({
      rid: "f",
      active: true,
      maxBitrate: 1_650_000,
      scalabilityMode: "L1T1",
    });
  });
});

describe("adaptive live-profile application", () => {
  it("collapses same-turn decisions to the one authoritative target", async () => {
    const apply = vi
      .fn<(profile: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const queue = createLatestWinsAsyncQueue(apply);

    const idle = queue.request("good");
    void queue.request("fair");
    void queue.request("poor");
    await idle;

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("poor");
  });

  it("serializes mutations and skips superseded in-flight targets", async () => {
    let releaseGood: (() => void) | null = null;
    const apply = vi.fn(async (profile: string) => {
      if (profile === "good") {
        await new Promise<void>((resolve) => {
          releaseGood = resolve;
        });
      }
    });
    const queue = createLatestWinsAsyncQueue(apply);

    const idle = queue.request("good");
    await Promise.resolve();
    expect(apply).toHaveBeenCalledWith("good");

    void queue.request("fair");
    void queue.request("poor");
    expect(apply).toHaveBeenCalledTimes(1);

    releaseGood?.();
    await idle;

    expect(apply.mock.calls.map(([profile]) => profile)).toEqual([
      "good",
      "poor",
    ]);
  });

});

describe("producer transport profile authority", () => {
  const baseline = {
    producerTopology: "vp8-simulcast",
    screenShareVideoActive: false,
    publishCpuLimited: false,
    transportControlAvailable: true,
    transportControlUnsupported: false,
    senderParametersPreviouslyMutated: false,
  };

  it("uses SFU transport BWE for an ordinary VP8 simulcast transition", () => {
    expect(shouldUseProducerTransportNetworkProfile(baseline)).toBe(true);
  });

  it.each([
    { producerTopology: "vp8-single-layer" },
    { producerTopology: "other" },
    { screenShareVideoActive: true },
    { publishCpuLimited: true },
    { transportControlAvailable: false },
    { transportControlUnsupported: true },
    { senderParametersPreviouslyMutated: true },
  ])("keeps the sender fallback for source-specific or unsupported paths", (override) => {
    expect(
      shouldUseProducerTransportNetworkProfile({ ...baseline, ...override }),
    ).toBe(false);
  });

  it("requests a key frame only after the same transport budget relaxes", () => {
    const emergency = {
      transportId: "transport-a",
      profile: "emergency" as const,
      maxIncomingBitrate: 160_000,
    };
    const good = {
      transportId: "transport-a",
      profile: "good" as const,
      maxIncomingBitrate: 6_000_000,
    };
    expect(
      shouldRequestProducerTransportRecoveryKeyFrame({
        previous: emergency,
        next: good,
      }),
    ).toBe(true);
    expect(
      shouldRequestProducerTransportRecoveryKeyFrame({
        previous: good,
        next: emergency,
      }),
    ).toBe(false);
    expect(
      shouldRequestProducerTransportRecoveryKeyFrame({
        previous: emergency,
        next: { ...good, transportId: "transport-b" },
      }),
    ).toBe(false);
  });

  it("releases a constrained aggregate budget before sender-owned fallback", () => {
    const applied = {
      transportId: "transport-a",
      profile: "poor" as const,
      maxIncomingBitrate: 180_000,
    };

    expect(
      shouldReleaseProducerTransportProfileBeforeSenderFallback({
        applied,
        transportId: "transport-a",
        useTransportAuthority: false,
      }),
    ).toBe(true);
    expect(
      shouldReleaseProducerTransportProfileBeforeSenderFallback({
        applied,
        transportId: "transport-a",
        useTransportAuthority: true,
      }),
    ).toBe(false);
    expect(
      shouldReleaseProducerTransportProfileBeforeSenderFallback({
        applied: { ...applied, profile: "good" },
        transportId: "transport-a",
        useTransportAuthority: false,
      }),
    ).toBe(false);
    expect(
      shouldReleaseProducerTransportProfileBeforeSenderFallback({
        applied,
        transportId: "transport-b",
        useTransportAuthority: false,
      }),
    ).toBe(false);
  });
});

describe("standard capture restoration retries", () => {
  it("makes a failed restore eligible after 15 seconds, not 120 seconds", () => {
    const now = 1_000_000;
    const signature = "standard:good:640:360:15";
    const attempt = {
      signature,
      retryAfter: getStandardCaptureRestoreRetryAfter(now, true),
    };

    expect(attempt.retryAfter).toBe(now + 15_000);
    expect(
      isStandardCaptureRestoreRetryDue(attempt, signature, now + 14_999),
    ).toBe(false);
    expect(
      isStandardCaptureRestoreRetryDue(attempt, signature, now + 15_000),
    ).toBe(true);
    expect(getStandardCaptureRestoreRetryAfter(now, false)).toBe(
      now + 120_000,
    );
  });

  it("uses the configured cadence instead of a hard-coded 24 fps floor", () => {
    const customFifteenFps = {
      width: 1280,
      height: 720,
      frameRate: 15,
      maxBitrate: 1_000_000,
      contentHint: "motion" as const,
      degradationPreference: "balanced" as const,
    };

    expect(getCameraCaptureRestoreMinimums(customFifteenFps)).toEqual({
      width: 960,
      height: 540,
      frameRate: 15,
    });
    expect(
      needsConfiguredCameraCaptureRestore(
        { width: 1280, height: 720, frameRate: 15 },
        customFifteenFps,
      ),
    ).toBe(false);
  });

  it("restores a manually selected data-saver target after constrained startup", () => {
    const dataSaver = {
      width: 640,
      height: 360,
      frameRate: 20,
      maxBitrate: 260_000,
      contentHint: "motion" as const,
      degradationPreference: "maintain-framerate" as const,
    };

    expect(
      needsConfiguredCameraCaptureRestore(
        { width: 426, height: 240, frameRate: 12 },
        dataSaver,
      ),
    ).toBe(true);
    expect(
      needsConfiguredCameraCaptureRestore(
        { width: 640, height: 360, frameRate: 20 },
        dataSaver,
      ),
    ).toBe(false);
  });
});

describe("single-receiver webcam optimization", () => {
  const baseline = {
    participantCount: 2,
    quality: "standard" as const,
    profile: "good" as const,
    dataSaverMode: false,
    publishCpuLimited: false,
    screenShareVideoActive: false,
    soleReceiverFullLayerCapacityProven: false,
  };

  it("keeps adaptive layers until the sole receiver proves full-layer capacity", () => {
    expect(shouldOptimizeVp8ForSingleReceiver(baseline)).toBe(false);
    expect(
      shouldOptimizeVp8ForSingleReceiver({
        ...baseline,
        soleReceiverFullLayerCapacityProven: true,
      }),
    ).toBe(true);
  });

  it.each([
    { participantCount: 3 },
    { quality: "low" as const },
    { profile: "fair" as const },
    { dataSaverMode: true },
    { publishCpuLimited: true },
    { screenShareVideoActive: true },
  ])("keeps adaptive layers when pressure or room shape requires them", (override) => {
    expect(
      shouldOptimizeVp8ForSingleReceiver({
        ...baseline,
        soleReceiverFullLayerCapacityProven: true,
        ...override,
      }),
    ).toBe(false);
  });

  it("recognizes only the live producer's applied single-receiver topology", () => {
    expect(
      isVp8SingleReceiverTopologyApplied(
        "producer-a:standard:good:single-receiver",
        "producer-a",
      ),
    ).toBe(true);
    expect(
      isVp8SingleReceiverTopologyApplied(
        "producer-old:standard:good:single-receiver",
        "producer-a",
      ),
    ).toBe(false);
    expect(
      isVp8SingleReceiverTopologyApplied(
        "producer-a:standard:good:adaptive-layers",
        "producer-a",
      ),
    ).toBe(false);
  });

  it("binds expiring capacity proof to the live producer", () => {
    const proof = {
      roomId: "room-a",
      producerId: "producer-a",
      revision: 4,
      basis: "simulcast-full-layer" as const,
      expiresAtMonotonicMs: 2_000,
    };
    expect(
      isReceiverCapacityProofUsableForProducer(proof, "producer-a", 1_999),
    ).toBe(true);
    expect(
      isReceiverCapacityProofUsableForProducer(proof, "producer-b", 1_999),
    ).toBe(false);
    expect(
      isReceiverCapacityProofUsableForProducer(proof, "producer-a", 2_000),
    ).toBe(false);
  });

  it("uses true republish only for an unexpired server replacement offer", () => {
    const proof = {
      roomId: "room-a",
      producerId: "producer-a",
      revision: 4,
      basis: "simulcast-full-layer" as const,
      expiresAtMonotonicMs: 5_000,
      replacementOffer: {
        nonce: "server-nonce",
        target: "vp8-single-layer" as const,
        expiresAtMonotonicMs: 4_000,
      },
    };
    expect(
      hasUsableWebcamSingleLayerReplacementOffer(
        proof,
        "producer-a",
        3_999,
      ),
    ).toBe(true);
    expect(
      hasUsableWebcamSingleLayerReplacementOffer(
        proof,
        "producer-a",
        4_000,
      ),
    ).toBe(false);
    expect(
      hasUsableWebcamSingleLayerReplacementOffer(
        { ...proof, replacementOffer: undefined },
        "producer-a",
        3_000,
      ),
    ).toBe(false);
  });
});
