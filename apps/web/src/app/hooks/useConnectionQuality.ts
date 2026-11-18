"use client";

import { useEffect, useRef, useState } from "react";
import {
  buildBrowserNetworkPolicyObservation,
  createBrowserNetworkPollAuthority,
  getBrowserNetworkSnapshot,
  getBrowserNetworkInformation,
  type BrowserNetworkSnapshot,
  type BrowserNetworkPolicyObservation,
} from "../lib/network-information";
import {
  getPublishAdaptationQuality,
  getReceiveAdaptationQuality,
  getSustainedReceiveEmergencyLoss,
  hasBrowserMediaEmergencyEvidence,
  hasReceiveContinuityRisk,
  updateRollingPacketLoss,
  type NetworkQuality,
  type PacketLossWindowSample,
} from "../lib/connection-quality-policy";
import type { Transport } from "../lib/types";

export type ConnectionQuality = NetworkQuality;

export interface MediaTrackQualityStats {
  bitrateBps: number | null;
  framesPerSecond: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  codecMimeType: string | null;
  qualityLimitationReason: string | null;
  bandwidthLimited: boolean;
  cpuLimited: boolean;
}

interface DirectionMediaQualityStats {
  audio: MediaTrackQualityStats;
  video: MediaTrackQualityStats;
}

export interface ConnectionQualityStats {
  quality: ConnectionQuality;
  publishQuality: ConnectionQuality;
  publishAdaptationQuality: ConnectionQuality;
  receiveQuality: ConnectionQuality;
  receiveAdaptationQuality: ConnectionQuality;
  receiveContinuityRisk: boolean;
  rtcPublishQuality: ConnectionQuality;
  rtcReceiveQuality: ConnectionQuality;
  emergencyMode: boolean;
  publishEmergencyMode: boolean;
  receiveEmergencyMode: boolean;
  rttMs: number | null;
  packetLoss: number | null;
  jitterMs: number | null;
  publishRttMs: number | null;
  publishPacketLoss: number | null;
  publishJitterMs: number | null;
  receiveRttMs: number | null;
  receivePacketLoss: number | null;
  receiveJitterMs: number | null;
  availableOutgoingBitrate: number | null;
  availableIncomingBitrate: number | null;
  browserNetwork: BrowserNetworkSnapshot;
  browserNetworkObservation: Readonly<BrowserNetworkPolicyObservation> | null;
  publishMedia: DirectionMediaQualityStats;
  receiveMedia: DirectionMediaQualityStats;
}

interface UseConnectionQualityOptions {
  producerTransportRef: React.MutableRefObject<Transport | null>;
  consumerTransportRef: React.MutableRefObject<Transport | null>;
  enabled: boolean;
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 2000;

const RTT_FAIR_MS = 250;
const RTT_POOR_MS = 500;
const RTT_EMERGENCY_MS = 850;
const LOSS_FAIR = 0.05;
const LOSS_POOR = 0.08;
const LOSS_EMERGENCY = 0.15;
const JITTER_FAIR_MS = 30;
const JITTER_POOR_MS = 60;
const JITTER_EMERGENCY_MS = 120;
const OUTGOING_BW_FAIR_BPS = 500000;
const OUTGOING_BW_POOR_BPS = 240000;
const OUTGOING_BW_EMERGENCY_BPS = 200000;
const INCOMING_BW_FAIR_BPS = 500000;
const INCOMING_BW_POOR_BPS = 240000;
const INCOMING_BW_EMERGENCY_BPS = 200000;
const AVAILABLE_BITRATE_SATURATION_RATIO = 0.7;

const EMPTY_MEDIA_TRACK_STATS: MediaTrackQualityStats = {
  bitrateBps: null,
  framesPerSecond: null,
  frameWidth: null,
  frameHeight: null,
  codecMimeType: null,
  qualityLimitationReason: null,
  bandwidthLimited: false,
  cpuLimited: false,
};

const EMPTY_DIRECTION_MEDIA_STATS: DirectionMediaQualityStats = {
  audio: EMPTY_MEDIA_TRACK_STATS,
  video: EMPTY_MEDIA_TRACK_STATS,
};

const UNKNOWN_BROWSER_NETWORK_SNAPSHOT: BrowserNetworkSnapshot = {
  supported: false,
  quality: "unknown",
  startupQuality: "unknown",
  emergency: false,
  effectiveType: null,
  saveData: null,
  downlinkMbps: null,
  rttMs: null,
};

const UNKNOWN_STATS: ConnectionQualityStats = {
  quality: "unknown",
  publishQuality: "unknown",
  publishAdaptationQuality: "unknown",
  receiveQuality: "unknown",
  receiveAdaptationQuality: "unknown",
  receiveContinuityRisk: false,
  rtcPublishQuality: "unknown",
  rtcReceiveQuality: "unknown",
  emergencyMode: false,
  publishEmergencyMode: false,
  receiveEmergencyMode: false,
  rttMs: null,
  packetLoss: null,
  jitterMs: null,
  publishRttMs: null,
  publishPacketLoss: null,
  publishJitterMs: null,
  receiveRttMs: null,
  receivePacketLoss: null,
  receiveJitterMs: null,
  availableOutgoingBitrate: null,
  availableIncomingBitrate: null,
  browserNetwork: UNKNOWN_BROWSER_NETWORK_SNAPSHOT,
  browserNetworkObservation: null,
  publishMedia: EMPTY_DIRECTION_MEDIA_STATS,
  receiveMedia: EMPTY_DIRECTION_MEDIA_STATS,
};

interface LossSample {
  packetsLost: number;
  packetsReceived: number;
}

interface ReportSignals {
  rttMs: number | null;
  inboundJitterMs: number | null;
  remoteInboundJitterMs: number | null;
  availableOutgoingBitrate: number | null;
  availableIncomingBitrate: number | null;
  inboundLoss: LossSample;
  remoteInboundLoss: LossSample;
  remoteInboundLossFraction: number | null;
  outboundMedia: MediaCounterSample;
  inboundMedia: MediaCounterSample;
}

type DirectionState = {
  rttMs: number | null;
  jitterMs: number | null;
  packetsLost: number;
  packetsReceived: number;
  lossFraction: number | null;
  availableBitrate: number | null;
};

type MediaCounterSample = {
  timestampMs: number;
  audioBytes: number | null;
  videoBytes: number | null;
  videoFrames: number | null;
  videoFramesPerSecond: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  audioCodecMimeType: string | null;
  videoCodecMimeType: string | null;
  videoQualityLimitationReason: string | null;
  videoBandwidthLimited: boolean;
  videoCpuLimited: boolean;
};

function num(stat: Record<string, unknown>, key: string): number | null {
  const value = stat[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const maxNullable = (
  current: number | null,
  next: number | null,
): number | null => {
  if (next == null) return current;
  return current == null ? next : Math.max(current, next);
};

const minPositive = (
  current: number | null,
  next: number | null,
): number | null => {
  if (next == null || next <= 0) return current;
  return current == null ? next : Math.min(current, next);
};

const addNullable = (
  current: number | null,
  next: number | null,
): number | null => {
  if (next == null) return current;
  return (current ?? 0) + Math.max(0, next);
};

const selectObservedString = (
  current: string | null,
  next: unknown,
): string | null => {
  if (typeof next !== "string" || next.length === 0) return current;
  if (!current) return next;
  return current === next ? current : "mixed";
};

const normalizeQualityLimitationReason = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  return value === "none" ? null : value;
};

const qualityLimitationReasonRank = (reason: string | null): number => {
  if (reason === "bandwidth") return 3;
  if (reason === "cpu") return 2;
  if (reason) return 1;
  return 0;
};

const selectQualityLimitationReason = (
  current: string | null,
  next: unknown,
): string | null => {
  const normalized = normalizeQualityLimitationReason(next);
  if (!normalized) return current;
  if (!current) return normalized;
  return qualityLimitationReasonRank(normalized) >
    qualityLimitationReasonRank(current)
    ? normalized
    : current;
};

const getMediaKind = (
  stat: Record<string, unknown>,
): "audio" | "video" | null => {
  const kind = stat.kind ?? stat.mediaType;
  return kind === "audio" || kind === "video" ? kind : null;
};

const createEmptyMediaCounterSample = (
  timestampMs: number,
): MediaCounterSample => ({
  timestampMs,
  audioBytes: null,
  videoBytes: null,
  videoFrames: null,
  videoFramesPerSecond: null,
  frameWidth: null,
  frameHeight: null,
  audioCodecMimeType: null,
  videoCodecMimeType: null,
  videoQualityLimitationReason: null,
  videoBandwidthLimited: false,
  videoCpuLimited: false,
});

const normalizeFractionLost = (value: number | null): number | null => {
  if (value == null || value < 0) return null;
  if (value > 1 && value <= 255) return value / 255;
  return Math.min(value, 1);
};

function readReport(report: RTCStatsReport): ReportSignals {
  const timestampMs = Date.now();
  let rttMs: number | null = null;
  let candidatePairRtt: number | null = null;
  let inboundJitterMs: number | null = null;
  let remoteInboundJitterMs: number | null = null;
  let inboundJitterWeightedMs = 0;
  let inboundJitterWeight = 0;
  let remoteInboundJitterWeightedMs = 0;
  let remoteInboundJitterWeight = 0;
  let availableOutgoingBitrate: number | null = null;
  let availableIncomingBitrate: number | null = null;
  let inboundPacketsLost = 0;
  let inboundPacketsReceived = 0;
  let remotePacketsLost = 0;
  let remotePacketsReceived = 0;
  let remoteInboundLossFraction: number | null = null;
  const outboundMedia = createEmptyMediaCounterSample(timestampMs);
  const inboundMedia = createEmptyMediaCounterSample(timestampMs);
  const codecMimeTypes = new Map<string, string>();

  report.forEach((raw) => {
    const stat = raw as unknown as Record<string, unknown>;
    if (stat.type !== "codec") return;
    const id = typeof stat.id === "string" ? stat.id : null;
    const mimeType = typeof stat.mimeType === "string" ? stat.mimeType : null;
    if (id && mimeType) {
      codecMimeTypes.set(id, mimeType);
    }
  });

  report.forEach((raw) => {
    const stat = raw as unknown as Record<string, unknown>;
    const type = stat.type;

    if (type === "candidate-pair") {
      const nominated = stat.nominated === true || stat.state === "succeeded";
      const rtt = num(stat, "currentRoundTripTime");
      if (nominated && rtt != null) {
        candidatePairRtt = rtt * 1000;
      }
      const outgoing = num(stat, "availableOutgoingBitrate");
      if (nominated && outgoing != null && outgoing > 0) {
        availableOutgoingBitrate = outgoing;
      }
      const incoming = num(stat, "availableIncomingBitrate");
      if (nominated && incoming != null && incoming > 0) {
        availableIncomingBitrate = incoming;
      }
    } else if (type === "inbound-rtp") {
      const jitter = num(stat, "jitter");
      const lost = num(stat, "packetsLost");
      const received = num(stat, "packetsReceived");
      if (lost != null) inboundPacketsLost += Math.max(0, lost);
      if (received != null) {
        inboundPacketsReceived += Math.max(0, received);
      }
      if (jitter != null) {
        const jitterWeight =
          received != null && received > 0 ? Math.max(1, received) : 1;
        inboundJitterWeightedMs += jitter * 1000 * jitterWeight;
        inboundJitterWeight += jitterWeight;
      }
      const kind = getMediaKind(stat);
      if (kind === "audio") {
        inboundMedia.audioBytes = addNullable(
          inboundMedia.audioBytes,
          num(stat, "bytesReceived"),
        );
        inboundMedia.audioCodecMimeType = selectObservedString(
          inboundMedia.audioCodecMimeType,
          codecMimeTypes.get(String(stat.codecId ?? "")),
        );
      } else if (kind === "video") {
        inboundMedia.videoBytes = addNullable(
          inboundMedia.videoBytes,
          num(stat, "bytesReceived"),
        );
        inboundMedia.videoFrames = addNullable(
          inboundMedia.videoFrames,
          num(stat, "framesDecoded"),
        );
        inboundMedia.videoFramesPerSecond = addNullable(
          inboundMedia.videoFramesPerSecond,
          num(stat, "framesPerSecond"),
        );
        inboundMedia.frameWidth = maxNullable(
          inboundMedia.frameWidth,
          num(stat, "frameWidth"),
        );
        inboundMedia.frameHeight = maxNullable(
          inboundMedia.frameHeight,
          num(stat, "frameHeight"),
        );
        inboundMedia.videoCodecMimeType = selectObservedString(
          inboundMedia.videoCodecMimeType,
          codecMimeTypes.get(String(stat.codecId ?? "")),
        );
      }
    } else if (type === "remote-inbound-rtp") {
      const rtt = num(stat, "roundTripTime");
      if (rtt != null) {
        rttMs = maxNullable(rttMs, rtt * 1000);
      }
      const jitter = num(stat, "jitter");
      const lost = num(stat, "packetsLost");
      const received = num(stat, "packetsReceived");
      const fractionLost = normalizeFractionLost(num(stat, "fractionLost"));
      if (jitter != null) {
        const jitterWeight =
          received != null && received > 0 ? Math.max(1, received) : 1;
        remoteInboundJitterWeightedMs += jitter * 1000 * jitterWeight;
        remoteInboundJitterWeight += jitterWeight;
      }
      if (lost != null) remotePacketsLost += Math.max(0, lost);
      if (received != null) {
        remotePacketsReceived += Math.max(0, received);
      }
      remoteInboundLossFraction = maxNullable(
        remoteInboundLossFraction,
        fractionLost,
      );
    } else if (type === "outbound-rtp") {
      const kind = getMediaKind(stat);
      if (kind === "audio") {
        outboundMedia.audioBytes = addNullable(
          outboundMedia.audioBytes,
          num(stat, "bytesSent"),
        );
        outboundMedia.audioCodecMimeType = selectObservedString(
          outboundMedia.audioCodecMimeType,
          codecMimeTypes.get(String(stat.codecId ?? "")),
        );
      } else if (kind === "video") {
        outboundMedia.videoBytes = addNullable(
          outboundMedia.videoBytes,
          num(stat, "bytesSent"),
        );
        outboundMedia.videoFrames = addNullable(
          outboundMedia.videoFrames,
          num(stat, "framesEncoded"),
        );
        outboundMedia.videoFramesPerSecond = addNullable(
          outboundMedia.videoFramesPerSecond,
          num(stat, "framesPerSecond"),
        );
        outboundMedia.frameWidth = maxNullable(
          outboundMedia.frameWidth,
          num(stat, "frameWidth"),
        );
        outboundMedia.frameHeight = maxNullable(
          outboundMedia.frameHeight,
          num(stat, "frameHeight"),
        );
        outboundMedia.videoCodecMimeType = selectObservedString(
          outboundMedia.videoCodecMimeType,
          codecMimeTypes.get(String(stat.codecId ?? "")),
        );
        const qualityLimitationReason = normalizeQualityLimitationReason(
          stat.qualityLimitationReason,
        );
        outboundMedia.videoQualityLimitationReason =
          selectQualityLimitationReason(
            outboundMedia.videoQualityLimitationReason,
            qualityLimitationReason,
          );
        outboundMedia.videoBandwidthLimited =
          outboundMedia.videoBandwidthLimited ||
          qualityLimitationReason === "bandwidth";
        outboundMedia.videoCpuLimited =
          outboundMedia.videoCpuLimited ||
          qualityLimitationReason === "cpu";
      }
    }
  });

  if (candidatePairRtt != null) {
    rttMs = maxNullable(rttMs, candidatePairRtt);
  }
  if (inboundJitterWeight > 0) {
    inboundJitterMs = inboundJitterWeightedMs / inboundJitterWeight;
  }
  if (remoteInboundJitterWeight > 0) {
    remoteInboundJitterMs =
      remoteInboundJitterWeightedMs / remoteInboundJitterWeight;
  }

  return {
    rttMs,
    inboundJitterMs,
    remoteInboundJitterMs,
    availableOutgoingBitrate,
    availableIncomingBitrate,
    inboundLoss: {
      packetsLost: inboundPacketsLost,
      packetsReceived: inboundPacketsReceived,
    },
    remoteInboundLoss: {
      packetsLost: remotePacketsLost,
      packetsReceived: remotePacketsReceived,
    },
    remoteInboundLossFraction,
    outboundMedia,
    inboundMedia,
  };
}

const isLowAvailableBitrate = (
  value: number | null,
  threshold: number,
  mediaBitrate: number | null,
  encoderLimited: boolean,
): boolean => {
  if (value == null || value <= 0 || value > threshold) return false;
  if (encoderLimited || mediaBitrate == null) return true;

  return mediaBitrate >= threshold * AVAILABLE_BITRATE_SATURATION_RATIO;
};

function windowedPacketLossSample(
  current: LossSample,
  previous: LossSample | null,
): LossSample | null {
  if (!previous) return null;
  const deltaLost = Math.max(0, current.packetsLost - previous.packetsLost);
  const deltaReceived = Math.max(
    0,
    current.packetsReceived - previous.packetsReceived,
  );
  const deltaTotal = deltaLost + deltaReceived;
  if (deltaTotal <= 0) return null;
  return {
    packetsLost: deltaLost,
    packetsReceived: deltaReceived,
  };
}

const getPacketLossFraction = (sample: LossSample | null): number | null => {
  if (!sample) return null;
  const packetCount = sample.packetsLost + sample.packetsReceived;
  return packetCount > 0 ? sample.packetsLost / packetCount : null;
};

const windowedBitrate = (
  currentBytes: number | null,
  previousBytes: number | null | undefined,
  elapsedMs: number,
): number | null => {
  if (
    currentBytes == null ||
    previousBytes == null ||
    elapsedMs <= 0 ||
    currentBytes < previousBytes
  ) {
    return null;
  }
  return Math.round(((currentBytes - previousBytes) * 8 * 1000) / elapsedMs);
};

const windowedFramesPerSecond = (
  currentFrames: number | null,
  previousFrames: number | null | undefined,
  elapsedMs: number,
): number | null => {
  if (
    currentFrames == null ||
    previousFrames == null ||
    elapsedMs <= 0 ||
    currentFrames < previousFrames
  ) {
    return null;
  }
  return Number(
    (((currentFrames - previousFrames) * 1000) / elapsedMs).toFixed(1),
  );
};

const buildMediaTrackStats = ({
  kind,
  current,
  previous,
}: {
  kind: "audio" | "video";
  current: MediaCounterSample;
  previous: MediaCounterSample | null;
}): MediaTrackQualityStats => {
  const elapsedMs = previous
    ? current.timestampMs - previous.timestampMs
    : 0;
  const bitrateBps =
    kind === "audio"
      ? windowedBitrate(
          current.audioBytes,
          previous?.audioBytes,
          elapsedMs,
        )
      : windowedBitrate(
          current.videoBytes,
          previous?.videoBytes,
          elapsedMs,
        );
  const derivedFramesPerSecond =
    kind === "video"
      ? windowedFramesPerSecond(
          current.videoFrames,
          previous?.videoFrames,
          elapsedMs,
        )
      : null;

  return {
    bitrateBps,
    framesPerSecond:
      kind === "video"
        ? current.videoFramesPerSecond ?? derivedFramesPerSecond
        : null,
    frameWidth: kind === "video" ? current.frameWidth : null,
    frameHeight: kind === "video" ? current.frameHeight : null,
    codecMimeType:
      kind === "audio"
        ? current.audioCodecMimeType
        : current.videoCodecMimeType,
    qualityLimitationReason:
      kind === "video" ? current.videoQualityLimitationReason : null,
    bandwidthLimited: kind === "video" ? current.videoBandwidthLimited : false,
    cpuLimited: kind === "video" ? current.videoCpuLimited : false,
  };
};

const buildDirectionMediaStats = (
  current: MediaCounterSample,
  previous: MediaCounterSample | null,
): DirectionMediaQualityStats => ({
  audio: buildMediaTrackStats({ kind: "audio", current, previous }),
  video: buildMediaTrackStats({ kind: "video", current, previous }),
});

const hasBandwidthQualityLimitation = (reason: string | null): boolean =>
  reason === "bandwidth";

const getDirectionMediaBitrate = (
  stats: DirectionMediaQualityStats,
): number | null => {
  const audioBitrate = stats.audio.bitrateBps;
  const videoBitrate = stats.video.bitrateBps;
  if (audioBitrate == null && videoBitrate == null) return null;
  return Math.max(0, audioBitrate ?? 0) + Math.max(0, videoBitrate ?? 0);
};

function deriveDirectionalQuality({
  rttMs,
  packetLoss,
  jitterMs,
  availableBitrate,
  mediaBitrate,
  fairBitrate,
  poorBitrate,
  qualityLimitationReason,
  bandwidthLimited: explicitBandwidthLimited,
}: {
  rttMs: number | null;
  packetLoss: number | null;
  jitterMs: number | null;
  availableBitrate: number | null;
  mediaBitrate: number | null;
  fairBitrate: number;
  poorBitrate: number;
  qualityLimitationReason?: string | null;
  bandwidthLimited?: boolean;
}): ConnectionQuality {
  const bandwidthLimited =
    explicitBandwidthLimited === true ||
    hasBandwidthQualityLimitation(qualityLimitationReason ?? null);
  if (
    rttMs == null &&
    packetLoss == null &&
    jitterMs == null &&
    availableBitrate == null &&
    !bandwidthLimited
  ) {
    return "unknown";
  }

  const isPoor =
    (rttMs != null && rttMs >= RTT_POOR_MS) ||
    (packetLoss != null && packetLoss >= LOSS_POOR) ||
    (jitterMs != null && jitterMs >= JITTER_POOR_MS) ||
    isLowAvailableBitrate(
      availableBitrate,
      poorBitrate,
      mediaBitrate,
      bandwidthLimited,
    );
  if (isPoor) return "poor";

  const isFair =
    (rttMs != null && rttMs >= RTT_FAIR_MS) ||
    (packetLoss != null && packetLoss >= LOSS_FAIR) ||
    (jitterMs != null && jitterMs >= JITTER_FAIR_MS) ||
    isLowAvailableBitrate(
      availableBitrate,
      fairBitrate,
      mediaBitrate,
      bandwidthLimited,
    ) ||
    bandwidthLimited;
  if (isFair) return "fair";

  return "good";
}

function deriveDirectionalEmergencyMode({
  rttMs,
  packetLoss,
  jitterMs,
  availableBitrate,
  mediaBitrate,
  emergencyBitrate,
  qualityLimitationReason,
  bandwidthLimited: explicitBandwidthLimited,
}: {
  rttMs: number | null;
  packetLoss: number | null;
  jitterMs: number | null;
  availableBitrate: number | null;
  mediaBitrate: number | null;
  emergencyBitrate: number;
  qualityLimitationReason?: string | null;
  bandwidthLimited?: boolean;
}): boolean {
  const bandwidthLimited =
    explicitBandwidthLimited === true ||
    hasBandwidthQualityLimitation(qualityLimitationReason ?? null);

  if (rttMs != null && rttMs >= RTT_EMERGENCY_MS) return true;
  if (packetLoss != null && packetLoss >= LOSS_EMERGENCY) return true;
  if (jitterMs != null && jitterMs >= JITTER_EMERGENCY_MS) return true;
  if (
    isLowAvailableBitrate(
      availableBitrate,
      emergencyBitrate,
      mediaBitrate,
      bandwidthLimited,
    )
  ) {
    return true;
  }

  return (
    bandwidthLimited &&
    mediaBitrate != null &&
    mediaBitrate >= emergencyBitrate * AVAILABLE_BITRATE_SATURATION_RATIO &&
    mediaBitrate <= emergencyBitrate
  );
}

const qualityRank: Record<ConnectionQuality, number> = {
  unknown: 0,
  good: 1,
  fair: 2,
  poor: 3,
};

const worstQuality = (
  left: ConnectionQuality,
  right: ConnectionQuality,
): ConnectionQuality => {
  if (left === "unknown") return right;
  if (right === "unknown") return left;
  return qualityRank[left] >= qualityRank[right] ? left : right;
};

const applyBrowserQualityHint = (
  observed: ConnectionQuality,
  browserNetwork: BrowserNetworkSnapshot,
): ConnectionQuality => {
  const browserHint = browserNetwork.quality;
  if (browserHint === "unknown") return observed;
  if (observed === "unknown") return browserHint;
  if (browserNetwork.emergency || browserNetwork.saveData === true) {
    return worstQuality(observed, browserHint);
  }
  return observed;
};

export function useConnectionQuality({
  producerTransportRef,
  consumerTransportRef,
  enabled,
  intervalMs = DEFAULT_INTERVAL_MS,
}: UseConnectionQualityOptions): ConnectionQualityStats {
  const [stats, setStats] = useState<ConnectionQualityStats>(UNKNOWN_STATS);
  const prevPublishLossRef = useRef<LossSample | null>(null);
  const prevReceiveLossRef = useRef<LossSample | null>(null);
  const receiveLossWindowRef = useRef<PacketLossWindowSample[]>([]);
  const prevPublishMediaRef = useRef<MediaCounterSample | null>(null);
  const prevReceiveMediaRef = useRef<MediaCounterSample | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      prevPublishLossRef.current = null;
      prevReceiveLossRef.current = null;
      receiveLossWindowRef.current = [];
      prevPublishMediaRef.current = null;
      prevReceiveMediaRef.current = null;
      setStats(UNKNOWN_STATS);
      return;
    }

    let cancelled = false;
    const pollAuthority = createBrowserNetworkPollAuthority();

    const poll = async () => {
      const pollGeneration = pollAuthority.begin();
      const browserNetwork = getBrowserNetworkSnapshot();
      const browserNetworkObservation = buildBrowserNetworkPolicyObservation(
        browserNetwork,
      );
      const startupBrowserQualityHint =
        browserNetwork.quality === "unknown"
          ? browserNetwork.startupQuality
          : browserNetwork.quality;
      const producerTransport = producerTransportRef.current;
      const consumerTransport = consumerTransportRef.current;
      const transportEntries = [
        producerTransport && !producerTransport.closed
          ? ({ direction: "publish", transport: producerTransport } as const)
          : null,
        consumerTransport && !consumerTransport.closed
          ? ({ direction: "receive", transport: consumerTransport } as const)
          : null,
      ].filter(
        (
          entry,
        ): entry is {
          direction: "publish" | "receive";
          transport: Transport;
        } => !!entry,
      );
      const hasPublishTransport = transportEntries.some(
        (entry) => entry.direction === "publish",
      );
      const hasReceiveTransport = transportEntries.some(
        (entry) => entry.direction === "receive",
      );

      if (transportEntries.length === 0) {
        if (!cancelled && pollAuthority.isCurrent(pollGeneration)) {
          const browserMediaEmergency = hasBrowserMediaEmergencyEvidence({
            effectiveType: browserNetwork.effectiveType,
            saveData: browserNetwork.saveData,
            downlinkMbps: browserNetwork.downlinkMbps,
          });
          prevPublishLossRef.current = null;
          prevReceiveLossRef.current = null;
          receiveLossWindowRef.current = [];
          prevPublishMediaRef.current = null;
          prevReceiveMediaRef.current = null;
          setStats({
            ...UNKNOWN_STATS,
            quality: startupBrowserQualityHint,
            publishQuality: startupBrowserQualityHint,
            publishAdaptationQuality: startupBrowserQualityHint,
            receiveQuality: startupBrowserQualityHint,
            receiveAdaptationQuality: startupBrowserQualityHint,
            rtcPublishQuality: "unknown",
            rtcReceiveQuality: "unknown",
            emergencyMode: browserNetwork.emergency,
            publishEmergencyMode: browserMediaEmergency,
            receiveEmergencyMode: browserMediaEmergency,
            browserNetwork,
            browserNetworkObservation,
          });
        }
        return;
      }
      if (!hasPublishTransport) {
        prevPublishLossRef.current = null;
        prevPublishMediaRef.current = null;
      }
      if (!hasReceiveTransport) {
        prevReceiveLossRef.current = null;
        receiveLossWindowRef.current = [];
        prevReceiveMediaRef.current = null;
      }

      const publish: DirectionState = {
        rttMs: null,
        jitterMs: null,
        packetsLost: 0,
        packetsReceived: 0,
        lossFraction: null,
        availableBitrate: null,
      };
      const receive: DirectionState = {
        rttMs: null,
        jitterMs: null,
        packetsLost: 0,
        packetsReceived: 0,
        lossFraction: null,
        availableBitrate: null,
      };
      let publishMedia = createEmptyMediaCounterSample(Date.now());
      let receiveMedia = createEmptyMediaCounterSample(Date.now());
      let observedPublishReport = false;
      let observedReceiveReport = false;

      for (const { direction, transport } of transportEntries) {
        let report: RTCStatsReport;
        try {
          report = await transport.getStats();
        } catch {
          continue;
        }
        if (cancelled || !pollAuthority.isCurrent(pollGeneration)) return;

        const parsed = readReport(report);
        if (direction === "publish") {
          observedPublishReport = true;
          publish.rttMs = maxNullable(publish.rttMs, parsed.rttMs);
          publish.jitterMs = maxNullable(
            publish.jitterMs,
            parsed.remoteInboundJitterMs,
          );
          publish.packetsLost += parsed.remoteInboundLoss.packetsLost;
          publish.packetsReceived += parsed.remoteInboundLoss.packetsReceived;
          publish.lossFraction = maxNullable(
            publish.lossFraction,
            parsed.remoteInboundLossFraction,
          );
          publish.availableBitrate = minPositive(
            publish.availableBitrate,
            parsed.availableOutgoingBitrate,
          );
          publishMedia = parsed.outboundMedia;
        } else {
          observedReceiveReport = true;
          receive.rttMs = maxNullable(receive.rttMs, parsed.rttMs);
          receive.jitterMs = maxNullable(
            receive.jitterMs,
            parsed.inboundJitterMs,
          );
          receive.packetsLost += parsed.inboundLoss.packetsLost;
          receive.packetsReceived += parsed.inboundLoss.packetsReceived;
          receive.availableBitrate = minPositive(
            receive.availableBitrate,
            parsed.availableIncomingBitrate,
          );
          receiveMedia = parsed.inboundMedia;
        }
      }

      if (cancelled || !pollAuthority.isCurrent(pollGeneration)) return;

      const publishWindowLossSample =
        hasPublishTransport && observedPublishReport
          ? windowedPacketLossSample(
            {
              packetsLost: publish.packetsLost,
              packetsReceived: publish.packetsReceived,
            },
            prevPublishLossRef.current,
          )
          : null;
      const receiveWindowLossSample =
        hasReceiveTransport && observedReceiveReport
          ? windowedPacketLossSample(
            {
              packetsLost: receive.packetsLost,
              packetsReceived: receive.packetsReceived,
            },
            prevReceiveLossRef.current,
          )
          : null;
      if (hasPublishTransport && observedPublishReport) {
        prevPublishLossRef.current = {
          packetsLost: publish.packetsLost,
          packetsReceived: publish.packetsReceived,
        };
      }
      if (hasReceiveTransport && observedReceiveReport) {
        prevReceiveLossRef.current = {
          packetsLost: receive.packetsLost,
          packetsReceived: receive.packetsReceived,
        };
      }
      const receiveLossSnapshot = updateRollingPacketLoss({
        samples: receiveLossWindowRef.current,
        sample: receiveWindowLossSample,
        nowMs: Date.now(),
      });
      receiveLossWindowRef.current = receiveLossSnapshot.samples;

      const publishMediaStats = observedPublishReport
        ? buildDirectionMediaStats(publishMedia, prevPublishMediaRef.current)
        : EMPTY_DIRECTION_MEDIA_STATS;
      const receiveMediaStats = observedReceiveReport
        ? buildDirectionMediaStats(receiveMedia, prevReceiveMediaRef.current)
        : EMPTY_DIRECTION_MEDIA_STATS;
      if (hasPublishTransport && observedPublishReport) {
        prevPublishMediaRef.current = publishMedia;
      }
      if (hasReceiveTransport && observedReceiveReport) {
        prevReceiveMediaRef.current = receiveMedia;
      }

      const publishLoss =
        publish.lossFraction ?? getPacketLossFraction(publishWindowLossSample);
      const receiveLoss = receiveLossSnapshot.fraction;
      const publishMediaBitrate = getDirectionMediaBitrate(publishMediaStats);
      const receiveMediaBitrate = getDirectionMediaBitrate(receiveMediaStats);
      const observedPublishQuality = deriveDirectionalQuality({
        rttMs: publish.rttMs,
        packetLoss: publishLoss,
        jitterMs: publish.jitterMs,
        availableBitrate: publish.availableBitrate,
        mediaBitrate: publishMediaBitrate,
        fairBitrate: OUTGOING_BW_FAIR_BPS,
        poorBitrate: OUTGOING_BW_POOR_BPS,
        qualityLimitationReason:
          publishMediaStats.video.qualityLimitationReason,
        bandwidthLimited: publishMediaStats.video.bandwidthLimited,
      });
      const observedReceiveQuality = deriveDirectionalQuality({
        rttMs: receive.rttMs,
        packetLoss: receiveLoss,
        jitterMs: receive.jitterMs,
        availableBitrate: receive.availableBitrate,
        mediaBitrate: receiveMediaBitrate,
        fairBitrate: INCOMING_BW_FAIR_BPS,
        poorBitrate: INCOMING_BW_POOR_BPS,
      });
      const observedPublishTransportEmergencyMode = deriveDirectionalEmergencyMode({
        rttMs: publish.rttMs,
        packetLoss: publishLoss,
        jitterMs: publish.jitterMs,
        availableBitrate: publish.availableBitrate,
        mediaBitrate: publishMediaBitrate,
        emergencyBitrate: OUTGOING_BW_EMERGENCY_BPS,
        qualityLimitationReason:
          publishMediaStats.video.qualityLimitationReason,
        bandwidthLimited: publishMediaStats.video.bandwidthLimited,
      });
      const observedReceiveTransportEmergencyMode = deriveDirectionalEmergencyMode({
        rttMs: receive.rttMs,
        packetLoss: getSustainedReceiveEmergencyLoss(receiveLossSnapshot),
        jitterMs: receive.jitterMs,
        availableBitrate: receive.availableBitrate,
        mediaBitrate: receiveMediaBitrate,
        emergencyBitrate: INCOMING_BW_EMERGENCY_BPS,
      });
      const publishQuality = applyBrowserQualityHint(
        observedPublishQuality,
        browserNetwork,
      );
      const receiveQuality = applyBrowserQualityHint(
        observedReceiveQuality,
        browserNetwork,
      );
      const publishAdaptationQuality = getPublishAdaptationQuality({
        publishQuality,
        packetLoss: publishLoss,
        jitterMs: publish.jitterMs,
        availableOutgoingBitrate: publish.availableBitrate,
        bandwidthLimited: publishMediaStats.video.bandwidthLimited,
      });
      const receiveAdaptationQuality = getReceiveAdaptationQuality({
        receiveQuality,
        packetLoss: receiveLoss,
        jitterMs: receive.jitterMs,
        availableIncomingBitrate: receive.availableBitrate,
      });
      const receiveContinuityRisk = hasReceiveContinuityRisk({
        rttMs: receive.rttMs,
        rollingLoss: receiveLoss,
      });
      const browserMediaEmergency = hasBrowserMediaEmergencyEvidence({
        effectiveType: browserNetwork.effectiveType,
        saveData: browserNetwork.saveData,
        downlinkMbps: browserNetwork.downlinkMbps,
      });
      const publishEmergencyMode =
        browserMediaEmergency ||
        deriveDirectionalEmergencyMode({
          rttMs: null,
          packetLoss: publishLoss,
          jitterMs: publish.jitterMs,
          availableBitrate: publish.availableBitrate,
          mediaBitrate: publishMediaBitrate,
          emergencyBitrate: OUTGOING_BW_EMERGENCY_BPS,
          qualityLimitationReason:
            publishMediaStats.video.qualityLimitationReason,
          bandwidthLimited: publishMediaStats.video.bandwidthLimited,
        });
      const receiveEmergencyMode =
        browserMediaEmergency ||
        deriveDirectionalEmergencyMode({
          rttMs: null,
          packetLoss: getSustainedReceiveEmergencyLoss(receiveLossSnapshot),
          jitterMs: receive.jitterMs,
          availableBitrate: receive.availableBitrate,
          mediaBitrate: receiveMediaBitrate,
          emergencyBitrate: INCOMING_BW_EMERGENCY_BPS,
        });

      setStats({
        quality: worstQuality(publishQuality, receiveQuality),
        publishQuality,
        publishAdaptationQuality,
        receiveQuality,
        receiveAdaptationQuality,
        receiveContinuityRisk,
        rtcPublishQuality: observedPublishQuality,
        rtcReceiveQuality: observedReceiveQuality,
        emergencyMode:
          browserNetwork.emergency ||
          observedPublishTransportEmergencyMode ||
          observedReceiveTransportEmergencyMode,
        publishEmergencyMode,
        receiveEmergencyMode,
        rttMs: maxNullable(publish.rttMs, receive.rttMs),
        packetLoss: maxNullable(publishLoss, receiveLoss),
        jitterMs: maxNullable(publish.jitterMs, receive.jitterMs),
        publishRttMs: publish.rttMs,
        publishPacketLoss: publishLoss,
        publishJitterMs: publish.jitterMs,
        receiveRttMs: receive.rttMs,
        receivePacketLoss: receiveLoss,
        receiveJitterMs: receive.jitterMs,
        availableOutgoingBitrate: publish.availableBitrate,
        availableIncomingBitrate: receive.availableBitrate,
        browserNetwork,
        browserNetworkObservation,
        publishMedia: publishMediaStats,
        receiveMedia: receiveMediaStats,
      });
    };

    void poll();
    const browserNetworkInformation = getBrowserNetworkInformation();
    const handleBrowserNetworkChange = () => {
      void poll();
    };
    browserNetworkInformation?.addEventListener?.(
      "change",
      handleBrowserNetworkChange,
    );
    const handle = window.setInterval(() => {
      void poll();
    }, intervalMs);

    return () => {
      cancelled = true;
      pollAuthority.invalidate();
      window.clearInterval(handle);
      browserNetworkInformation?.removeEventListener?.(
        "change",
        handleBrowserNetworkChange,
      );
    };
  }, [enabled, intervalMs, producerTransportRef, consumerTransportRef]);

  return stats;
}
