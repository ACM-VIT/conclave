export type ProducerTransportNetworkProfile =
  | "good"
  | "fair"
  | "poor"
  | "emergency";

export const PRODUCER_TRANSPORT_FAIR_MAX_INCOMING_BITRATE_BPS = 1_100_000;
export const PRODUCER_TRANSPORT_POOR_MAX_INCOMING_BITRATE_BPS = 180_000;
// Keep enough aggregate headroom for the 80 kbps survival RID, a live Opus
// microphone, RTP/RTCP, and retransmissions. The former 105 kbps ceiling was
// only the sum of nominal video + emergency Opus payload caps; in a real
// transport it starved protocol overhead, collapsed sender BWE to ~60 kbps,
// and made recovery pause every simulcast encoder.
export const PRODUCER_TRANSPORT_EMERGENCY_MAX_INCOMING_BITRATE_BPS = 160_000;

export const isProducerTransportNetworkProfile = (
  value: unknown,
): value is ProducerTransportNetworkProfile =>
  value === "good" ||
  value === "fair" ||
  value === "poor" ||
  value === "emergency";

/**
 * Resolve the aggregate publisher upload ceiling for one transport. The
 * constrained profiles include audio headroom; mediasoup's transport-wide BWE
 * then decides which VP8 RID can fit without asking Chromium to transact a
 * live RTCRtpSender.setParameters() update.
 */
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
