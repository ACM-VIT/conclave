import { describe, expect, it } from "vitest";
import {
  getBrowserMediaAdaptationQuality,
  getPublishAdaptationQuality,
  getReceiveAdaptationQuality,
  getSustainedReceiveEmergencyLoss,
  hasBlockingPublishRecoveryTelemetry,
  hasBrowserMediaEmergencyEvidence,
  hasReceiveContinuityRisk,
  updateRollingPacketLoss,
} from "../src/app/lib/connection-quality-policy";

describe("hasBrowserMediaEmergencyEvidence", () => {
  it("ignores RTT-only browser hints but retains capacity emergencies", () => {
    expect(
      hasBrowserMediaEmergencyEvidence({
        effectiveType: "4g",
        saveData: false,
        downlinkMbps: 20,
      }),
    ).toBe(false);
    expect(
      hasBrowserMediaEmergencyEvidence({
        effectiveType: "slow-2g",
        saveData: false,
        downlinkMbps: null,
      }),
    ).toBe(true);
    expect(
      hasBrowserMediaEmergencyEvidence({
        effectiveType: "4g",
        saveData: false,
        downlinkMbps: 0.25,
      }),
    ).toBe(true);
  });
});

describe("getBrowserMediaAdaptationQuality", () => {
  it("uses capacity hints and ignores RTT-derived labels", () => {
    expect(
      getBrowserMediaAdaptationQuality({
        effectiveType: "4g",
        saveData: false,
        downlinkMbps: 20,
      }),
    ).toBe("good");
    expect(
      getBrowserMediaAdaptationQuality({
        effectiveType: null,
        saveData: false,
        downlinkMbps: 0.7,
      }),
    ).toBe("poor");
  });
});

describe("updateRollingPacketLoss", () => {
  it("weights loss by packet counts instead of averaging percentages", () => {
    const first = updateRollingPacketLoss({
      samples: [],
      sample: { packetsLost: 8, packetsReceived: 40 },
      nowMs: 2_000,
    });
    const second = updateRollingPacketLoss({
      samples: first.samples,
      sample: { packetsLost: 0, packetsReceived: 200 },
      nowMs: 4_000,
    });

    expect(second.fraction).toBeCloseTo(8 / 248);
    expect(second.sampleCount).toBe(2);
    expect(second.packetCount).toBe(248);
  });

  it("does not turn a missing or empty stats interval into zero loss", () => {
    const missing = updateRollingPacketLoss({
      samples: [],
      sample: null,
      nowMs: 2_000,
    });
    const empty = updateRollingPacketLoss({
      samples: missing.samples,
      sample: { packetsLost: 0, packetsReceived: 0 },
      nowMs: 4_000,
    });

    expect(missing.fraction).toBeNull();
    expect(empty).toMatchObject({
      fraction: null,
      sampleCount: 0,
      packetCount: 0,
    });
  });

  it("expires observations outside the rolling window", () => {
    const observed = updateRollingPacketLoss({
      samples: [],
      sample: { packetsLost: 4, packetsReceived: 48 },
      nowMs: 2_000,
    });
    const expired = updateRollingPacketLoss({
      samples: observed.samples,
      sample: null,
      nowMs: 8_001,
    });

    expect(expired.fraction).toBeNull();
    expect(expired.sampleCount).toBe(0);
  });
});

describe("receive continuity policy", () => {
  it("recognizes compound latency and loss without requiring 8% loss", () => {
    expect(
      hasReceiveContinuityRisk({ rttMs: 366, rollingLoss: 0.076 }),
    ).toBe(true);
    expect(
      hasReceiveContinuityRisk({ rttMs: 120, rollingLoss: 0.076 }),
    ).toBe(false);
    expect(
      hasReceiveContinuityRisk({ rttMs: null, rollingLoss: 0.08 }),
    ).toBe(true);
  });

  it("does not infer risk from an unknown loss sample", () => {
    expect(
      hasReceiveContinuityRisk({ rttMs: 500, rollingLoss: null }),
    ).toBe(false);
  });

  it("requires more than one valid interval before loss asserts emergency", () => {
    expect(
      getSustainedReceiveEmergencyLoss({
        fraction: 1 / 6,
        sampleCount: 1,
      }),
    ).toBeNull();
    expect(
      getSustainedReceiveEmergencyLoss({
        fraction: 0.16,
        sampleCount: 2,
      }),
    ).toBe(0.16);
  });
});

describe("getPublishAdaptationQuality", () => {
  it("blocks fast cap recovery at the normal fair loss and jitter thresholds", () => {
    expect(
      hasBlockingPublishRecoveryTelemetry({
        packetLoss: 0.03,
        jitterMs: null,
      }),
    ).toBe(true);
    expect(
      hasBlockingPublishRecoveryTelemetry({
        packetLoss: null,
        jitterMs: 30,
      }),
    ).toBe(true);
    expect(
      hasBlockingPublishRecoveryTelemetry({
        packetLoss: 0.029,
        jitterMs: 29,
      }),
    ).toBe(false);
    expect(
      hasBlockingPublishRecoveryTelemetry({
        packetLoss: null,
        jitterMs: null,
      }),
    ).toBe(false);
  });

  it("keeps the user-facing fair label out of healthy RTT-only adaptation", () => {
    expect(
      getPublishAdaptationQuality({
        publishQuality: "fair",
        packetLoss: 0,
        jitterMs: 15.7,
        availableOutgoingBitrate: 3_900_000,
        bandwidthLimited: false,
      }),
    ).toBe("good");
  });

  it("stays conservative when a required observation is unknown", () => {
    expect(
      getPublishAdaptationQuality({
        publishQuality: "fair",
        packetLoss: null,
        jitterMs: 15,
        availableOutgoingBitrate: 3_900_000,
        bandwidthLimited: false,
      }),
    ).toBe("fair");
  });

  it.each([
    { packetLoss: 0.03, jitterMs: 15, bitrate: 3_900_000, limited: false },
    { packetLoss: 0, jitterMs: 30, bitrate: 3_900_000, limited: false },
    { packetLoss: 0, jitterMs: 15, bitrate: 999_999, limited: false },
    { packetLoss: 0, jitterMs: 15, bitrate: 3_900_000, limited: true },
  ])("does not mask fair congestion signals: %o", (signals) => {
    expect(
      getPublishAdaptationQuality({
        publishQuality: "fair",
        packetLoss: signals.packetLoss,
        jitterMs: signals.jitterMs,
        availableOutgoingBitrate: signals.bitrate,
        bandwidthLimited: signals.limited,
      }),
    ).toBe("fair");
  });

  it("relaxes a poor RTT-only label when congestion evidence is healthy", () => {
    expect(
      getPublishAdaptationQuality({
        publishQuality: "poor",
        packetLoss: 0,
        jitterMs: 0,
        availableOutgoingBitrate: 10_000_000,
        bandwidthLimited: false,
      }),
    ).toBe("good");
  });

  it("keeps poor quality when loss, jitter, or bandwidth corroborates it", () => {
    expect(
      getPublishAdaptationQuality({
        publishQuality: "poor",
        packetLoss: 0.08,
        jitterMs: 10,
        availableOutgoingBitrate: 10_000_000,
        bandwidthLimited: false,
      }),
    ).toBe("poor");
  });

  it("separates receive adaptation from a clean high-latency label", () => {
    expect(
      getReceiveAdaptationQuality({
        receiveQuality: "poor",
        packetLoss: 0,
        jitterMs: 4,
        availableIncomingBitrate: 8_000_000,
      }),
    ).toBe("good");
  });
});
