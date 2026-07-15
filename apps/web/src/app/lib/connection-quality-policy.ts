export type NetworkQuality = "good" | "fair" | "poor" | "unknown";

export const hasBrowserMediaEmergencyEvidence = ({
  effectiveType,
  saveData,
  downlinkMbps,
}: {
  effectiveType: string | null;
  saveData: boolean | null;
  downlinkMbps: number | null;
}): boolean =>
  effectiveType?.toLowerCase() === "slow-2g" ||
  (downlinkMbps !== null && downlinkMbps <= 0.3) ||
  (saveData === true && downlinkMbps !== null && downlinkMbps <= 0.35);

export const getBrowserMediaAdaptationQuality = ({
  effectiveType,
  saveData,
  downlinkMbps,
}: {
  effectiveType: string | null;
  saveData: boolean | null;
  downlinkMbps: number | null;
}): NetworkQuality => {
  if (saveData === true) return "poor";
  if (downlinkMbps !== null) {
    if (downlinkMbps <= 0.8) return "poor";
    if (downlinkMbps <= 1.5) return "fair";
    return "good";
  }
  const normalizedType = effectiveType?.toLowerCase();
  if (normalizedType === "slow-2g" || normalizedType === "2g") return "poor";
  if (normalizedType === "3g") return "fair";
  if (normalizedType === "4g") return "good";
  return "unknown";
};

export const RECEIVE_LOSS_ROLLING_WINDOW_MS = 6_000;
export const RECEIVE_CONTINUITY_RTT_MS = 300;
export const RECEIVE_CONTINUITY_LOSS = 0.05;
export const RECEIVE_CONTINUITY_LOSS_WITHOUT_RTT = 0.08;
export const RECEIVE_EMERGENCY_LOSS = 0.15;
export const RECEIVE_EMERGENCY_MIN_SAMPLES = 2;

const PUBLISH_ADAPTATION_MAX_LOSS = 0.03;
const PUBLISH_ADAPTATION_MAX_JITTER_MS = 30;
const PUBLISH_ADAPTATION_MIN_OUTGOING_BITRATE_BPS = 1_000_000;

export const hasBlockingPublishRecoveryTelemetry = ({
  packetLoss,
  jitterMs,
}: {
  packetLoss: number | null;
  jitterMs: number | null;
}): boolean =>
  (packetLoss !== null && packetLoss >= PUBLISH_ADAPTATION_MAX_LOSS) ||
  (jitterMs !== null && jitterMs >= PUBLISH_ADAPTATION_MAX_JITTER_MS);

export type PacketLossWindowSample = {
  timestampMs: number;
  packetsLost: number;
  packetsReceived: number;
};

export type RollingPacketLossSnapshot = {
  samples: PacketLossWindowSample[];
  fraction: number | null;
  sampleCount: number;
  packetCount: number;
};

const isValidPacketCount = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;

/**
 * Keeps a short packet-count window and derives loss from the combined packet
 * counts. A missing/empty stats interval contributes no synthetic zero-loss
 * sample, so unsupported or temporarily absent stats cannot prove recovery.
 */
export const updateRollingPacketLoss = ({
  samples,
  sample,
  nowMs,
  windowMs = RECEIVE_LOSS_ROLLING_WINDOW_MS,
}: {
  samples: readonly PacketLossWindowSample[];
  sample: Omit<PacketLossWindowSample, "timestampMs"> | null;
  nowMs: number;
  windowMs?: number;
}): RollingPacketLossSnapshot => {
  const cutoffMs = nowMs - windowMs;
  const nextSamples = samples.filter(
    (candidate) => candidate.timestampMs > cutoffMs,
  );

  if (
    sample &&
    isValidPacketCount(sample.packetsLost) &&
    isValidPacketCount(sample.packetsReceived) &&
    sample.packetsLost + sample.packetsReceived > 0
  ) {
    nextSamples.push({ ...sample, timestampMs: nowMs });
  }

  const totals = nextSamples.reduce(
    (result, candidate) => ({
      packetsLost: result.packetsLost + candidate.packetsLost,
      packetsReceived: result.packetsReceived + candidate.packetsReceived,
    }),
    { packetsLost: 0, packetsReceived: 0 },
  );
  const packetCount = totals.packetsLost + totals.packetsReceived;

  return {
    samples: nextSamples,
    fraction: packetCount > 0 ? totals.packetsLost / packetCount : null,
    sampleCount: nextSamples.length,
    packetCount,
  };
};

export const hasReceiveContinuityRisk = ({
  rttMs,
  rollingLoss,
}: {
  rttMs: number | null;
  rollingLoss: number | null;
}): boolean => {
  if (rollingLoss === null) return false;
  if (rollingLoss >= RECEIVE_CONTINUITY_LOSS_WITHOUT_RTT) return true;
  return (
    rttMs !== null &&
    rttMs >= RECEIVE_CONTINUITY_RTT_MS &&
    rollingLoss >= RECEIVE_CONTINUITY_LOSS
  );
};

export const getSustainedReceiveEmergencyLoss = (
  snapshot: Pick<RollingPacketLossSnapshot, "fraction" | "sampleCount">,
): number | null =>
  snapshot.sampleCount >= RECEIVE_EMERGENCY_MIN_SAMPLES &&
  snapshot.fraction !== null &&
  snapshot.fraction >= RECEIVE_EMERGENCY_LOSS
    ? snapshot.fraction
    : null;

/**
 * RTT remains useful to the user-facing quality label, but high latency alone
 * is not evidence that a healthy sender should discard resolution. Only relax
 * a fair label when every congestion signal needed for that decision exists.
 */
export const getPublishAdaptationQuality = ({
  publishQuality,
  packetLoss,
  jitterMs,
  availableOutgoingBitrate,
  bandwidthLimited,
}: {
  publishQuality: NetworkQuality;
  packetLoss: number | null;
  jitterMs: number | null;
  availableOutgoingBitrate: number | null;
  bandwidthLimited: boolean;
}): NetworkQuality => {
  if (publishQuality === "good" || publishQuality === "unknown") {
    return publishQuality;
  }

  const hasHealthyObservedPath =
    packetLoss !== null &&
    packetLoss < PUBLISH_ADAPTATION_MAX_LOSS &&
    jitterMs !== null &&
    jitterMs < PUBLISH_ADAPTATION_MAX_JITTER_MS &&
    !bandwidthLimited &&
    availableOutgoingBitrate !== null &&
    availableOutgoingBitrate >=
      PUBLISH_ADAPTATION_MIN_OUTGOING_BITRATE_BPS;

  return hasHealthyObservedPath ? "good" : publishQuality;
};

export const getReceiveAdaptationQuality = ({
  receiveQuality,
  packetLoss,
  jitterMs,
  availableIncomingBitrate,
}: {
  receiveQuality: NetworkQuality;
  packetLoss: number | null;
  jitterMs: number | null;
  availableIncomingBitrate: number | null;
}): NetworkQuality =>
  getPublishAdaptationQuality({
    publishQuality: receiveQuality,
    packetLoss,
    jitterMs,
    availableOutgoingBitrate: availableIncomingBitrate,
    bandwidthLimited: false,
  });
