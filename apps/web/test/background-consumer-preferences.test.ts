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

describe("Data Saver focus", () => {
  const producer = { userId: "speaker", kind: "video" as const, type: "webcam" as const };
  const offStage = {
    primary: false,
    focus: false,
    visible: false,
    hidden: true,
    warm: false,
    rank: 0,
    renderedWidth: null,
    renderedHeight: null,
    renderedDevicePixelRatio: null,
    presentationSize: null,
  };

  it("parks a speaking camera that the published layout keeps off the stage", () => {
    const desired = getDesiredPreferences(producer, bounds, {
      ...options,
      dataSaverMode: true,
      layout: offStage,
    });
    expect(desired?.paused).toBe(true);
  });

  it("keeps a speaking camera that the published layout names as its focus", () => {
    const desired = getDesiredPreferences(producer, bounds, {
      ...options,
      dataSaverMode: true,
      layout: { ...offStage, focus: true },
    });
    expect(desired?.paused).toBe(false);
  });

  it("keeps a speaking camera when no layout has published", () => {
    const desired = getDesiredPreferences(producer, bounds, { ...options, dataSaverMode: true });
    expect(desired?.paused).toBe(false);
  });
});
