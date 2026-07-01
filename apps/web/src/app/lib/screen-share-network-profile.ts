import type { WebcamProducerNetworkProfile } from "./webcam-codec";

export const SCREEN_SHARE_OUTGOING_FAIR_BPS = 1500000;
export const SCREEN_SHARE_OUTGOING_POOR_BPS = 550000;
export const SCREEN_SHARE_OUTGOING_EMERGENCY_BPS = 280000;
export const SCREEN_SHARE_RECEIVE_FAIR_BPS = 1500000;
export const SCREEN_SHARE_RECEIVE_POOR_BPS = 550000;
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
