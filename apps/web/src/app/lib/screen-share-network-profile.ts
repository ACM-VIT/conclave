import type { WebcamProducerNetworkProfile } from "./webcam-codec";
import type { BrowserNetworkSnapshot } from "./network-information";

const SCREEN_SHARE_OUTGOING_FAIR_BPS = 1500000;
const SCREEN_SHARE_OUTGOING_POOR_BPS = 550000;
const SCREEN_SHARE_OUTGOING_EMERGENCY_BPS = 280000;
const SCREEN_SHARE_RECEIVE_FAIR_BPS = 1500000;
const SCREEN_SHARE_RECEIVE_POOR_BPS = 550000;
export const SCREEN_SHARE_RECEIVE_EMERGENCY_BPS = 300000;

const networkProfileRank: Record<WebcamProducerNetworkProfile, number> = {
  good: 1,
  fair: 2,
  poor: 3,
  emergency: 4,
};

export const getMostConstrainedWebcamProducerNetworkProfile = (
  profiles: Array<WebcamProducerNetworkProfile | null>,
): WebcamProducerNetworkProfile | null =>
  profiles.reduce<WebcamProducerNetworkProfile | null>((selected, profile) => {
    if (!profile) return selected;
    if (!selected) return profile;
    return networkProfileRank[profile] > networkProfileRank[selected]
      ? profile
      : selected;
  }, null);

export const getScreenSharePublishNetworkProfileForAvailableOutgoingBitrate = (
  availableOutgoingBitrateBps: number | null | undefined,
  emergencyMode: boolean,
): WebcamProducerNetworkProfile | null => {
  if (emergencyMode) return "emergency";
  if (
    typeof availableOutgoingBitrateBps !== "number" ||
    !Number.isFinite(availableOutgoingBitrateBps) ||
    availableOutgoingBitrateBps <= 0
  ) {
    return null;
  }
  if (availableOutgoingBitrateBps <= SCREEN_SHARE_OUTGOING_EMERGENCY_BPS) {
    return "emergency";
  }
  if (availableOutgoingBitrateBps <= SCREEN_SHARE_OUTGOING_POOR_BPS) {
    return "poor";
  }
  if (availableOutgoingBitrateBps <= SCREEN_SHARE_OUTGOING_FAIR_BPS) {
    return "fair";
  }
  return "good";
};

type ScreenShareObservedPublishQuality =
  | WebcamProducerNetworkProfile
  | "unknown";

type ScreenShareBrowserNetworkHint = Pick<
  BrowserNetworkSnapshot,
  "supported" | "quality" | "startupQuality" | "emergency" | "saveData"
>;

type ScreenSharePublishProfileOptions = {
  baseProfile: WebcamProducerNetworkProfile;
  availableOutgoingBitrateBps: number | null | undefined;
  emergencyMode: boolean;
  browserNetwork: ScreenShareBrowserNetworkHint;
  observedPublishQuality?: ScreenShareObservedPublishQuality | null;
};

const hasAvailableOutgoingBitrate = (
  availableOutgoingBitrateBps: number | null | undefined,
): boolean =>
  typeof availableOutgoingBitrateBps === "number" &&
  Number.isFinite(availableOutgoingBitrateBps) &&
  availableOutgoingBitrateBps > 0;

const getScreenShareStartupNetworkProfile = (
  browserNetwork: ScreenShareBrowserNetworkHint,
  observedPublishQuality?: ScreenShareObservedPublishQuality | null,
): WebcamProducerNetworkProfile | null => {
  if (observedPublishQuality && observedPublishQuality !== "unknown") {
    return null;
  }
  if (browserNetwork.emergency) return "emergency";
  if (browserNetwork.saveData === true) return "poor";

  const browserQuality =
    browserNetwork.quality === "unknown"
      ? browserNetwork.startupQuality
      : browserNetwork.quality;

  if (browserQuality === "poor" || browserQuality === "fair") {
    return browserQuality;
  }
  if (browserQuality === "good") return null;

  // Jitsi defaults desktop sharing to low FPS because static text needs
  // pixels more than motion. Use that bias only before WebRTC stats can prove
  // the publish path is healthy, so fast unsupported browsers can recover.
  return browserNetwork.supported ? null : "fair";
};

export const selectScreenSharePublishNetworkProfile = ({
  baseProfile,
  availableOutgoingBitrateBps,
  emergencyMode,
  browserNetwork,
  observedPublishQuality,
}: ScreenSharePublishProfileOptions): WebcamProducerNetworkProfile => {
  const outgoingBitrateProfile =
    getScreenSharePublishNetworkProfileForAvailableOutgoingBitrate(
      availableOutgoingBitrateBps,
      emergencyMode,
    );
  const startupProfile = hasAvailableOutgoingBitrate(availableOutgoingBitrateBps)
    ? null
    : getScreenShareStartupNetworkProfile(
        browserNetwork,
        observedPublishQuality,
      );

  return (
    getMostConstrainedWebcamProducerNetworkProfile([
      baseProfile,
      outgoingBitrateProfile,
      startupProfile,
    ]) ?? baseProfile
  );
};

export const getScreenShareReceiveNetworkProfileForAvailableIncomingBitrate = (
  availableIncomingBitrateBps: number | null | undefined,
): WebcamProducerNetworkProfile | null => {
  if (
    typeof availableIncomingBitrateBps !== "number" ||
    !Number.isFinite(availableIncomingBitrateBps) ||
    availableIncomingBitrateBps <= 0
  ) {
    return null;
  }
  if (availableIncomingBitrateBps <= SCREEN_SHARE_RECEIVE_EMERGENCY_BPS) {
    return "emergency";
  }
  if (availableIncomingBitrateBps <= SCREEN_SHARE_RECEIVE_POOR_BPS) {
    return "poor";
  }
  if (availableIncomingBitrateBps <= SCREEN_SHARE_RECEIVE_FAIR_BPS) {
    return "fair";
  }
  return "good";
};
