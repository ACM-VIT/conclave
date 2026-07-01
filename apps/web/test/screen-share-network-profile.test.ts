import { describe, expect, it } from "vitest";
import { selectScreenSharePublishNetworkProfile } from "../src/app/lib/screen-share-network-profile";
import type { BrowserNetworkSnapshot } from "../src/app/lib/network-information";

const browserNetwork = (
  overrides: Partial<BrowserNetworkSnapshot> = {},
): BrowserNetworkSnapshot => ({
  supported: false,
  quality: "unknown",
  startupQuality: "unknown",
  emergency: false,
  effectiveType: null,
  saveData: null,
  downlinkMbps: null,
  rttMs: null,
  ...overrides,
});

describe("selectScreenSharePublishNetworkProfile", () => {
  it("starts unsupported unknown links in a fair detail-first profile", () => {
    expect(
      selectScreenSharePublishNetworkProfile({
        baseProfile: "good",
        availableOutgoingBitrateBps: null,
        emergencyMode: false,
        browserNetwork: browserNetwork(),
        observedPublishQuality: "unknown",
      }),
    ).toBe("fair");
  });

  it("restores the base profile after WebRTC publish stats are observed", () => {
    expect(
      selectScreenSharePublishNetworkProfile({
        baseProfile: "good",
        availableOutgoingBitrateBps: null,
        emergencyMode: false,
        browserNetwork: browserNetwork(),
        observedPublishQuality: "good",
      }),
    ).toBe("good");
  });

  it("lets explicit outgoing bitrate prove a good screen-share profile", () => {
    expect(
      selectScreenSharePublishNetworkProfile({
        baseProfile: "good",
        availableOutgoingBitrateBps: 2_500_000,
        emergencyMode: false,
        browserNetwork: browserNetwork(),
        observedPublishQuality: "unknown",
      }),
    ).toBe("good");
  });

  it("keeps outgoing bitrate and browser save-data constraints when worse", () => {
    expect(
      selectScreenSharePublishNetworkProfile({
        baseProfile: "good",
        availableOutgoingBitrateBps: 500_000,
        emergencyMode: false,
        browserNetwork: browserNetwork({ quality: "good" }),
        observedPublishQuality: "good",
      }),
    ).toBe("poor");

    expect(
      selectScreenSharePublishNetworkProfile({
        baseProfile: "good",
        availableOutgoingBitrateBps: null,
        emergencyMode: false,
        browserNetwork: browserNetwork({ saveData: true }),
        observedPublishQuality: "unknown",
      }),
    ).toBe("poor");
  });

  it("uses emergency mode as the most constrained screen-share profile", () => {
    expect(
      selectScreenSharePublishNetworkProfile({
        baseProfile: "good",
        availableOutgoingBitrateBps: 2_500_000,
        emergencyMode: true,
        browserNetwork: browserNetwork({ emergency: true }),
        observedPublishQuality: "good",
      }),
    ).toBe("emergency");
  });
});
