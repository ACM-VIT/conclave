import { describe, expect, it } from "vitest";
import {
  advanceWebcamReceiveRecoveryProbe,
  getGoodLinkWebcamSpatialAllocation,
  getWebcamContinuityLayerPreference,
  getWebcamRenderedPixelDemandHeight,
  getWebcamTargetSpatialLayer,
  isWebcamLayerConvergencePathHealthy,
  normalizeRenderDevicePixelRatio,
  shouldRetryWebcamLayerConvergenceKeyFrame,
  shouldParkWebcamForDataSaver,
  WEBCAM_RECEIVE_TEMPORAL_LAYER,
  WEBCAM_RECEIVE_RECOVERY_PROBE_COOLDOWN_MS,
  WEBCAM_RECEIVE_RECOVERY_PROBE_DURATION_MS,
} from "../src/app/lib/adaptive-video-receive";
import { buildCameraVideoConstraints } from "../src/app/lib/constants";

const threeLayerBounds = {
  maxSpatialLayer: 2,
  maxTemporalLayer: 2,
};

describe("getWebcamTargetSpatialLayer", () => {
  it("uses physical pixels so a DPR 2 tile can request the full layer", () => {
    expect(
      getWebcamTargetSpatialLayer({
        bounds: threeLayerBounds,
        width: 640,
        height: 360,
        devicePixelRatio: 1,
      }),
    ).toBe(1);

    expect(
      getWebcamTargetSpatialLayer({
        bounds: threeLayerBounds,
        width: 640,
        height: 360,
        devicePixelRatio: 2,
      }),
    ).toBe(2);
  });

  it("accounts for wide tiles instead of considering rendered height alone", () => {
    expect(
      getWebcamRenderedPixelDemandHeight({
        width: 960,
        height: 300,
        devicePixelRatio: 1,
      }),
    ).toBe(540);
    expect(
      getWebcamTargetSpatialLayer({
        bounds: threeLayerBounds,
        width: 960,
        height: 300,
        devicePixelRatio: 1,
      }),
    ).toBe(2);
  });

  it("uses a deadband when upgrading and downgrading near a layer boundary", () => {
    expect(
      getWebcamTargetSpatialLayer({
        bounds: threeLayerBounds,
        width: 0,
        height: 530,
        devicePixelRatio: 1,
        previousSpatialLayer: 1,
      }),
    ).toBe(1);
    expect(
      getWebcamTargetSpatialLayer({
        bounds: threeLayerBounds,
        width: 0,
        height: 550,
        devicePixelRatio: 1,
        previousSpatialLayer: 1,
      }),
    ).toBe(2);
    expect(
      getWebcamTargetSpatialLayer({
        bounds: threeLayerBounds,
        width: 0,
        height: 500,
        devicePixelRatio: 1,
        previousSpatialLayer: 2,
      }),
    ).toBe(2);
    expect(
      getWebcamTargetSpatialLayer({
        bounds: threeLayerBounds,
        width: 0,
        height: 470,
        devicePixelRatio: 1,
        previousSpatialLayer: 2,
      }),
    ).toBe(1);
  });

  it("never requests a spatial layer the producer does not expose", () => {
    expect(
      getWebcamTargetSpatialLayer({
        bounds: { maxSpatialLayer: 1, maxTemporalLayer: 2 },
        width: 1280,
        height: 720,
        devicePixelRatio: 2,
      }),
    ).toBe(1);
  });
});

describe("getGoodLinkWebcamSpatialAllocation", () => {
  it("grants a physically demanded full layer to an eligible visible tile", () => {
    expect(
      getGoodLinkWebcamSpatialAllocation({
        bounds: threeLayerBounds,
        demandedSpatialLayer: 2,
        isVisible: true,
        isFocus: false,
        hasRenderedTile: true,
        screenShareVideoActive: false,
        fullResolutionEligible: true,
      }),
    ).toEqual({ spatialLayer: 2, keepFullResolution: true });
  });

  it("preserves the bounded allocation for non-eligible and screen-share tiles", () => {
    expect(
      getGoodLinkWebcamSpatialAllocation({
        bounds: threeLayerBounds,
        demandedSpatialLayer: 2,
        isVisible: true,
        isFocus: false,
        hasRenderedTile: true,
        screenShareVideoActive: false,
        fullResolutionEligible: false,
      }),
    ).toEqual({ spatialLayer: 1, keepFullResolution: false });
    expect(
      getGoodLinkWebcamSpatialAllocation({
        bounds: threeLayerBounds,
        demandedSpatialLayer: 2,
        isVisible: true,
        isFocus: false,
        hasRenderedTile: true,
        screenShareVideoActive: true,
        fullResolutionEligible: true,
      }),
    ).toEqual({ spatialLayer: 1, keepFullResolution: false });
  });

  it("still grants full resolution to a rendered focus tile during screen share", () => {
    expect(
      getGoodLinkWebcamSpatialAllocation({
        bounds: threeLayerBounds,
        demandedSpatialLayer: 2,
        isVisible: true,
        isFocus: true,
        hasRenderedTile: true,
        screenShareVideoActive: true,
        fullResolutionEligible: true,
      }),
    ).toEqual({ spatialLayer: 2, keepFullResolution: true });
  });

  it("does not let a focus exception exceed the full-resolution budget", () => {
    expect(
      getGoodLinkWebcamSpatialAllocation({
        bounds: threeLayerBounds,
        demandedSpatialLayer: 2,
        isVisible: true,
        isFocus: true,
        hasRenderedTile: true,
        screenShareVideoActive: false,
        fullResolutionEligible: false,
      }),
    ).toEqual({ spatialLayer: 1, keepFullResolution: false });
  });
});

describe("normalizeRenderDevicePixelRatio", () => {
  it("falls back to one and bounds pathological browser zoom values", () => {
    expect(normalizeRenderDevicePixelRatio(Number.NaN)).toBe(1);
    expect(normalizeRenderDevicePixelRatio(0)).toBe(1);
    expect(normalizeRenderDevicePixelRatio(2.5)).toBe(2.5);
    expect(normalizeRenderDevicePixelRatio(8)).toBe(4);
  });
});

describe("getWebcamContinuityLayerPreference", () => {
  it("keeps the focused or primary camera at middle spatial and the only temporal layer", () => {
    expect(
      getWebcamContinuityLayerPreference({
        bounds: threeLayerBounds,
        isFocusOrPrimary: true,
        availableIncomingBitrateBps: null,
      }),
    ).toEqual({
      spatialLayer: 1,
      temporalLayer: WEBCAM_RECEIVE_TEMPORAL_LAYER,
    });
  });

  it("keeps non-focus cameras on the base spatial and temporal layer", () => {
    expect(
      getWebcamContinuityLayerPreference({
        bounds: threeLayerBounds,
        isFocusOrPrimary: false,
        availableIncomingBitrateBps: 2_000_000,
      }),
    ).toEqual({
      spatialLayer: 0,
      temporalLayer: WEBCAM_RECEIVE_TEMPORAL_LAYER,
    });
  });

  it("forces the focus camera to base when incoming bitrate is at most 240kbps", () => {
    expect(
      getWebcamContinuityLayerPreference({
        bounds: threeLayerBounds,
        isFocusOrPrimary: true,
        availableIncomingBitrateBps: 240_000,
      }),
    ).toEqual({
      spatialLayer: 0,
      temporalLayer: WEBCAM_RECEIVE_TEMPORAL_LAYER,
    });
    expect(
      getWebcamContinuityLayerPreference({
        bounds: threeLayerBounds,
        isFocusOrPrimary: true,
        availableIncomingBitrateBps: 240_001,
      }),
    ).toEqual({
      spatialLayer: 1,
      temporalLayer: WEBCAM_RECEIVE_TEMPORAL_LAYER,
    });
  });

  it("never requests layers outside the producer bounds", () => {
    expect(
      getWebcamContinuityLayerPreference({
        bounds: { maxSpatialLayer: 0, maxTemporalLayer: 0 },
        isFocusOrPrimary: true,
        availableIncomingBitrateBps: null,
      }),
    ).toEqual({ spatialLayer: 0, temporalLayer: 0 });
  });
});

describe("webcam layer convergence key-frame retry", () => {
  const baseline = {
    consumerId: "consumer-a",
    preferredSpatialLayer: 2,
    currentSpatialLayer: 1,
    healthyPath: true,
    visiblePriority: true,
    nowMs: 10_000,
    previousAttempt: null,
  };

  it("retries a healthy visible webcam that remains below its preferred RID", () => {
    expect(shouldRetryWebcamLayerConvergenceKeyFrame(baseline)).toBe(true);
    expect(
      shouldRetryWebcamLayerConvergenceKeyFrame({
        ...baseline,
        previousAttempt: {
          consumerId: "consumer-a",
          targetSignature: "2",
          requestedAtMs: 6_000,
          attemptCount: 1,
        },
      }),
    ).toBe(true);
  });

  it("enforces the four-second cadence and three-attempt ceiling", () => {
    expect(
      shouldRetryWebcamLayerConvergenceKeyFrame({
        ...baseline,
        previousAttempt: {
          consumerId: "consumer-a",
          targetSignature: "2",
          requestedAtMs: 6_001,
          attemptCount: 1,
        },
      }),
    ).toBe(false);
    expect(
      shouldRetryWebcamLayerConvergenceKeyFrame({
        ...baseline,
        previousAttempt: {
          consumerId: "consumer-a",
          targetSignature: "2",
          requestedAtMs: 0,
          attemptCount: 3,
        },
      }),
    ).toBe(false);
  });

  it("stops on convergence or any evidence of receive pressure", () => {
    expect(
      shouldRetryWebcamLayerConvergenceKeyFrame({
        ...baseline,
        currentSpatialLayer: 2,
      }),
    ).toBe(false);
    expect(
      shouldRetryWebcamLayerConvergenceKeyFrame({
        ...baseline,
        healthyPath: false,
      }),
    ).toBe(false);
    expect(
      shouldRetryWebcamLayerConvergenceKeyFrame({
        ...baseline,
        visiblePriority: false,
      }),
    ).toBe(false);
  });
});

describe("webcam layer convergence path evidence", () => {
  const baseline = {
    connectionQuality: "fair" as const,
    consumerScoreQuality: "good" as const,
    emergencyMode: false,
    receiveContinuityRisk: false,
    dataSaverMode: false,
  };

  it("admits fair aggregate history only with a good per-consumer score", () => {
    expect(isWebcamLayerConvergencePathHealthy(baseline)).toBe(true);
    expect(
      isWebcamLayerConvergencePathHealthy({
        ...baseline,
        consumerScoreQuality: "fair",
      }),
    ).toBe(false);
  });

  it("rejects poor, emergency, continuity-risk, and data-saver paths", () => {
    expect(
      isWebcamLayerConvergencePathHealthy({
        ...baseline,
        connectionQuality: "poor",
      }),
    ).toBe(false);
    expect(
      isWebcamLayerConvergencePathHealthy({
        ...baseline,
        emergencyMode: true,
      }),
    ).toBe(false);
    expect(
      isWebcamLayerConvergencePathHealthy({
        ...baseline,
        receiveContinuityRisk: true,
      }),
    ).toBe(false);
    expect(
      isWebcamLayerConvergencePathHealthy({
        ...baseline,
        dataSaverMode: true,
      }),
    ).toBe(false);
  });
});

describe("bounded webcam receive recovery probe", () => {
  const baseline = {
    previousState: null,
    consumerId: "consumer-a",
    nowMs: 10_000,
    connectionQuality: "fair" as const,
    consumerScoreQuality: "good" as const,
    browserAllowsRecovery: true,
    emergencyMode: false,
    receiveContinuityRisk: false,
    dataSaverMode: false,
    isDocumentVisible: true,
    isVisible: true,
  };

  it("arms only from independent browser and consumer evidence on a constrained path", () => {
    expect(advanceWebcamReceiveRecoveryProbe(baseline)).toEqual({
      phase: "active",
      consumerId: "consumer-a",
      startedAtMs: 10_000,
      expiresAtMs: 10_000 + WEBCAM_RECEIVE_RECOVERY_PROBE_DURATION_MS,
    });
    expect(
      advanceWebcamReceiveRecoveryProbe({
        ...baseline,
        browserAllowsRecovery: false,
      }),
    ).toEqual({ phase: "idle", consumerId: "consumer-a" });
    expect(
      advanceWebcamReceiveRecoveryProbe({
        ...baseline,
        consumerScoreQuality: "fair",
      }),
    ).toEqual({ phase: "idle", consumerId: "consumer-a" });
    expect(
      advanceWebcamReceiveRecoveryProbe({
        ...baseline,
        connectionQuality: "poor",
        receiveContinuityRisk: true,
      }),
    ).toEqual({
      phase: "active",
      consumerId: "consumer-a",
      startedAtMs: 10_000,
      expiresAtMs: 10_000 + WEBCAM_RECEIVE_RECOVERY_PROBE_DURATION_MS,
    });
    expect(
      advanceWebcamReceiveRecoveryProbe({
        ...baseline,
        connectionQuality: "poor",
      }),
    ).toEqual({ phase: "idle", consumerId: "consumer-a" });
  });

  it("holds through the aggregate poor/risk feedback loop but ends on good", () => {
    const active = advanceWebcamReceiveRecoveryProbe(baseline);
    expect(
      advanceWebcamReceiveRecoveryProbe({
        ...baseline,
        previousState: active,
        nowMs: 12_000,
        connectionQuality: "poor",
        receiveContinuityRisk: true,
      }),
    ).toBe(active);
    expect(
      advanceWebcamReceiveRecoveryProbe({
        ...baseline,
        previousState: active,
        nowMs: 12_000,
        connectionQuality: "good",
      }),
    ).toEqual({ phase: "idle", consumerId: "consumer-a" });
  });

  it("aborts on fresh pressure and enforces a cooldown before another probe", () => {
    const active = advanceWebcamReceiveRecoveryProbe(baseline);
    const abortedAtMs = 12_000;
    const cooldown = advanceWebcamReceiveRecoveryProbe({
      ...baseline,
      previousState: active,
      nowMs: abortedAtMs,
      browserAllowsRecovery: false,
    });
    expect(cooldown).toEqual({
      phase: "cooldown",
      consumerId: "consumer-a",
      cooldownUntilMs:
        abortedAtMs + WEBCAM_RECEIVE_RECOVERY_PROBE_COOLDOWN_MS,
    });
    expect(
      advanceWebcamReceiveRecoveryProbe({
        ...baseline,
        previousState: cooldown,
        nowMs:
          abortedAtMs + WEBCAM_RECEIVE_RECOVERY_PROBE_COOLDOWN_MS - 1,
      }),
    ).toBe(cooldown);
    expect(
      advanceWebcamReceiveRecoveryProbe({
        ...baseline,
        previousState: cooldown,
        nowMs: abortedAtMs + WEBCAM_RECEIVE_RECOVERY_PROBE_COOLDOWN_MS,
      }),
    ).toMatchObject({ phase: "active", consumerId: "consumer-a" });
  });

  it("expires into cooldown instead of permanently overriding bandwidth policy", () => {
    const active = advanceWebcamReceiveRecoveryProbe(baseline);
    const expiresAtMs =
      10_000 + WEBCAM_RECEIVE_RECOVERY_PROBE_DURATION_MS;
    expect(
      advanceWebcamReceiveRecoveryProbe({
        ...baseline,
        previousState: active,
        nowMs: expiresAtMs,
        connectionQuality: "fair",
      }),
    ).toEqual({
      phase: "cooldown",
      consumerId: "consumer-a",
      cooldownUntilMs:
        expiresAtMs + WEBCAM_RECEIVE_RECOVERY_PROBE_COOLDOWN_MS,
    });
  });

  it.each([
    { emergencyMode: true },
    { dataSaverMode: true },
    { isDocumentVisible: false },
    { isVisible: false },
  ])("does not arm under independent $emergencyMode$ data/visibility pressure", (override) => {
    expect(
      advanceWebcamReceiveRecoveryProbe({ ...baseline, ...override }),
    ).toEqual({ phase: "idle", consumerId: "consumer-a" });
  });
});

describe("data-saver webcam continuity", () => {
  it("keeps visible, focused, and primary webcams alive", () => {
    expect(
      shouldParkWebcamForDataSaver({
        isVisible: true,
        isFocusOrPrimary: false,
      }),
    ).toBe(false);
    expect(
      shouldParkWebcamForDataSaver({
        isVisible: false,
        isFocusOrPrimary: true,
      }),
    ).toBe(false);
  });

  it("parks only webcams that are both offscreen and unfocused", () => {
    expect(
      shouldParkWebcamForDataSaver({
        isVisible: false,
        isFocusOrPrimary: false,
      }),
    ).toBe(true);
  });

  it("captures poor-network video at the delivered 12 fps cadence", () => {
    expect(buildCameraVideoConstraints("standard", "poor")).toMatchObject({
      width: { ideal: 426, max: 426 },
      height: { ideal: 240, max: 240 },
      frameRate: { ideal: 12, max: 12 },
    });
  });
});
