import { describe, expect, it } from "vitest";
import { getDesiredPreferences } from "../src/app/hooks/useAdaptiveConsumerPreferences";

const options: Parameters<typeof getDesiredPreferences>[2] = {
  quality: "good",
  activeSpeakerId: "speaker",
  webcamVideoCount: 1,
  fallbackRank: 0,
  fullResolutionEligible: true,
  layout: null,
  emergencyMode: false,
  receiveContinuityRisk: false,
  receiveRecoveryProbeActive: false,
  emergencyKeepVideo: true,
  screenShareVideoActive: false,
  dataSaverMode: false,
  isDocumentVisible: true,
  availableIncomingBitrateBps: 10_000_000,
  consumerScoreQuality: "good",
  previousSpatialLayer: 2,
};

const bounds = { maxSpatialLayer: 2, maxTemporalLayer: 2 };

describe("background meeting media", () => {
  it.each(["webcam", "screen"] as const)("keeps %s layers, priority, and playback unchanged on tab switch", (type) => {
    const producer = { userId: "speaker", kind: "video" as const, type };
    const foreground = getDesiredPreferences(producer, bounds, options);
    const background = getDesiredPreferences(producer, bounds, { ...options, isDocumentVisible: false });
    expect(foreground?.paused).toBe(false);
    expect(background).toEqual(foreground);
  });

  it.each(["fair", "poor"] as const)("still responds to a real %s connection equally in either tab state", (quality) => {
    const producer = { userId: "speaker", kind: "video" as const, type: "webcam" as const };
    expect(getDesiredPreferences(producer, bounds, { ...options, quality, isDocumentVisible: false })).toEqual(
      getDesiredPreferences(producer, bounds, { ...options, quality }),
    );
  });
});
