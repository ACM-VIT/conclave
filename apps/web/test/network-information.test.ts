import { describe, expect, it } from "vitest";
import {
  buildBrowserNetworkPolicyObservation,
  createBrowserNetworkPollAuthority,
  shouldStartLowBandwidthVideo,
} from "../src/app/lib/network-information";

describe("createBrowserNetworkPollAuthority", () => {
  it("rejects a stale async completion after a newer poll begins", () => {
    const authority = createBrowserNetworkPollAuthority();
    const staleGeneration = authority.begin();
    const currentGeneration = authority.begin();

    expect(authority.isCurrent(staleGeneration)).toBe(false);
    expect(authority.isCurrent(currentGeneration)).toBe(true);

    authority.invalidate();
    expect(authority.isCurrent(currentGeneration)).toBe(false);
  });
});

describe("shouldStartLowBandwidthVideo", () => {
  it("does not lower startup capture for RTT alone", () => {
    expect(
      shouldStartLowBandwidthVideo({
        effectiveType: "4g",
        downlink: 20,
        rtt: 1_200,
        saveData: false,
      }),
    ).toBe(false);
  });

  it("starts conservatively from actual capacity or user intent", () => {
    expect(shouldStartLowBandwidthVideo({ downlink: 0.8 })).toBe(true);
    expect(shouldStartLowBandwidthVideo({ effectiveType: "3g" })).toBe(true);
    expect(shouldStartLowBandwidthVideo({ saveData: true })).toBe(true);
  });
});

describe("buildBrowserNetworkPolicyObservation", () => {
  it("emits immutable product-owned network-policy evidence", () => {
    const browserNetwork = {
      supported: true,
      quality: "poor" as const,
      startupQuality: "poor" as const,
      emergency: false,
      effectiveType: "3g",
      saveData: true,
      downlinkMbps: 0.38,
      rttMs: 140,
    };
    const observation = buildBrowserNetworkPolicyObservation(
      browserNetwork,
      123_456,
    );

    expect(observation).toEqual({
      version: 1,
      source: "useConnectionQuality",
      observedAtEpochMs: 123_456,
      browserNetwork,
    });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.browserNetwork)).toBe(true);
  });
});
