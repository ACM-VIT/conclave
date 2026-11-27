export type ProducerTransportNetworkProfile =
  | "good"
  | "fair"
  | "poor"
  | "emergency";

export const PRODUCER_TRANSPORT_FAIR_MAX_INCOMING_BITRATE_BPS = 1_100_000;
export const PRODUCER_TRANSPORT_POOR_MAX_INCOMING_BITRATE_BPS = 180_000;
export const PRODUCER_TRANSPORT_EMERGENCY_MAX_INCOMING_BITRATE_BPS = 160_000;

export const isProducerTransportNetworkProfile = (
  value: unknown,
): value is ProducerTransportNetworkProfile =>
  value === "good" ||
  value === "fair" ||
  value === "poor" ||
  value === "emergency";

export const getProducerTransportMaxIncomingBitrate = (
  profile: ProducerTransportNetworkProfile,
  configuredGoodMaxIncomingBitrateBps: number,
): number => {
  const configuredMaximum = Math.max(
    1,
    Math.floor(configuredGoodMaxIncomingBitrateBps),
  );
  if (profile === "good") return configuredMaximum;

  const profileMaximum =
    profile === "fair"
      ? PRODUCER_TRANSPORT_FAIR_MAX_INCOMING_BITRATE_BPS
      : profile === "poor"
        ? PRODUCER_TRANSPORT_POOR_MAX_INCOMING_BITRATE_BPS
        : PRODUCER_TRANSPORT_EMERGENCY_MAX_INCOMING_BITRATE_BPS;
  return Math.min(configuredMaximum, profileMaximum);
};
