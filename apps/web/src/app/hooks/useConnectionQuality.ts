"use client";

import { useEffect, useRef, useState } from "react";
import {
  getBrowserNetworkSnapshot,
  type BrowserNetworkSnapshot,
} from "../lib/network-information";
import type { Transport } from "../lib/types";

export type ConnectionQuality = "good" | "fair" | "poor" | "unknown";

export interface MediaTrackQualityStats {
  /** Actual media bitrate over the most recent stats window, in bits/sec. */
  bitrateBps: number | null;
  /** Actual encoded/decoded frame rate over the most recent stats window. */
  framesPerSecond: number | null;
  /** Last observed video frame width, when this is video. */
  frameWidth: number | null;
  /** Last observed video frame height, when this is video. */
  frameHeight: number | null;
  /** Negotiated codec MIME type, or "mixed" when multiple codecs are present. */
  codecMimeType: string | null;
  /** Browser-reported send-side quality limitation reason, if available. */
  qualityLimitationReason: string | null;
  /** True when at least one send-side video RTP stream is bandwidth-limited. */
  bandwidthLimited: boolean;
  /** True when at least one send-side video RTP stream is CPU-limited. */
  cpuLimited: boolean;
}

interface DirectionMediaQualityStats {
  audio: MediaTrackQualityStats;
  video: MediaTrackQualityStats;
}

export interface ConnectionQualityStats {
  /** Worst observed tier across publishing and receiving. */
  quality: ConnectionQuality;
  /** Send-side quality, used for camera/screen-share adaptation. */
  publishQuality: ConnectionQuality;
  /** Receive-side quality, used for remote consumer layer selection. */
  receiveQuality: ConnectionQuality;
  /** Send-side quality from WebRTC stats before browser-network hinting. */
  rtcPublishQuality: ConnectionQuality;
  /** Receive-side quality from WebRTC stats before browser-network hinting. */
  rtcReceiveQuality: ConnectionQuality;
  /** True when either browser hints or WebRTC stats indicate an emergency-grade link. */
  emergencyMode: boolean;
  /** Send-side emergency signal from browser hints or WebRTC stats. */
  publishEmergencyMode: boolean;
  /** Receive-side emergency signal from browser hints or WebRTC stats. */
  receiveEmergencyMode: boolean;
  /** Worst observed round-trip time in milliseconds, if observable. */
  rttMs: number | null;
  /** Worst observed fraction of packets lost (0-1) over the most recent window. */
  packetLoss: number | null;
  /** Worst observed jitter in milliseconds, if observable. */
  jitterMs: number | null;
  /** Send-side round-trip time in milliseconds, if observable. */
  publishRttMs: number | null;
  /** Send-side packet loss fraction (0-1) over the most recent window. */
  publishPacketLoss: number | null;
  /** Send-side jitter in milliseconds, if observable from remote inbound stats. */
  publishJitterMs: number | null;
  /** Receive-side round-trip time in milliseconds, if observable. */
  receiveRttMs: number | null;
  /** Receive-side packet loss fraction (0-1) over the most recent window. */
  receivePacketLoss: number | null;
  /** Receive-side jitter in milliseconds, if observable. */
  receiveJitterMs: number | null;
  /** Estimated send-side available bitrate in bits/sec, if exposed. */
  availableOutgoingBitrate: number | null;
  /** Estimated receive-side available bitrate in bits/sec, if exposed. */
  availableIncomingBitrate: number | null;
  /** Browser Network Information API snapshot used as an early/fallback hint. */
  browserNetwork: BrowserNetworkSnapshot;
  /** Actual send-side audio/video media stats over the latest polling window. */
  publishMedia: DirectionMediaQualityStats;
  /** Actual receive-side audio/video media stats over the latest polling window. */
  receiveMedia: DirectionMediaQualityStats;
}

interface UseConnectionQualityOptions {
  /** Producer (send) transport ref from the media hook. Reused, not owned. */
  producerTransportRef: React.MutableRefObject<Transport | null>;
  /** Consumer (recv) transport ref from the media hook. Reused, not owned. */
  consumerTransportRef: React.MutableRefObject<Transport | null>;
  /** Only poll while truly in the meeting. */
  enabled: boolean;
  /** Poll cadence; defaults to ~2s. */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 2000;

// Thresholds tuned for conservative, non-alarmist reporting. A connection is
// only "poor" when at least one signal is clearly bad; "fair" is the early
// warning band; everything else is "good".
const RTT_FAIR_MS = 250;
const RTT_POOR_MS = 500;
const RTT_EMERGENCY_MS = 850;
const LOSS_FAIR = 0.05; // 5%
const LOSS_POOR = 0.08; // 8%
const LOSS_EMERGENCY = 0.15; // 15%
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
  receiveQuality: "unknown",
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

/**
 * Reads the relevant numeric fields off an RTCStats entry without forcing the
 * caller to depend on lib.dom's partial RTC stats typings (Safari/Chrome
 * diverge, and mediasoup forwards the raw browser report).
 */
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
  // Browsers normally expose 0-1 here, but tolerate the RFC3550 0-255 form.
  if (value > 1 && value <= 255) return value / 255;
  return Math.min(value, 1);
};

/**
 * Derives quality signals from a single transport's RTCStatsReport.
 * - RTT comes from the nominated candidate-pair or remote-inbound-rtp.
 * - Inbound RTP loss/jitter describes download health.
 * - Remote inbound RTP loss/jitter describes what the peer receives from us,
 *   so it is the most useful browser-visible uplink signal.
 */
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

  // Available bitrate estimates can remain low after we intentionally cap media.
  // Do not let our own low-bitrate profile prove that the link is still bad; only
  // treat the estimate as congestion when media is trying to use a meaningful
  // fraction of the fair/poor threshold itself.
  return mediaBitrate >= threshold * AVAILABLE_BITRATE_SATURATION_RATIO;
};

function windowedPacketLoss(
  current: LossSample,
  previous: LossSample | null,
): number | null {
  if (!previous) return null;
  const deltaLost = Math.max(0, current.packetsLost - previous.packetsLost);
  const deltaReceived = Math.max(
    0,
    current.packetsReceived - previous.packetsReceived,
  );
  const deltaTotal = deltaLost + deltaReceived;
  if (deltaTotal <= 0) return 0;
  return deltaLost / deltaTotal;
}

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

  // Some browsers report a sender-side bandwidth limitation but omit
  // availableOutgoingBitrate. Treat that as emergency only while media is near
  // the emergency threshold; otherwise our own survival cap can keep emergency
  // mode latched after the link recovers.
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

/**
 * Polls the mediasoup transports' RTCPeerConnection.getStats() every ~2s and
 * derives directional quality signals for local publishing and receiving.
 */
export function useConnectionQuality({
  producerTransportRef,
  consumerTransportRef,
  enabled,
  intervalMs = DEFAULT_INTERVAL_MS,
}: UseConnectionQualityOptions): ConnectionQualityStats {
  const [stats, setStats] = useState<ConnectionQualityStats>(UNKNOWN_STATS);
  const prevPublishLossRef = useRef<LossSample | null>(null);
  const prevReceiveLossRef = useRef<LossSample | null>(null);
  const prevPublishMediaRef = useRef<MediaCounterSample | null>(null);
  const prevReceiveMediaRef = useRef<MediaCounterSample | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      prevPublishLossRef.current = null;
      prevReceiveLossRef.current = null;
      prevPublishMediaRef.current = null;
      prevReceiveMediaRef.current = null;
      setStats(UNKNOWN_STATS);
      return;
    }

    let cancelled = false;

    const poll = async () => {
      const browserNetwork = getBrowserNetworkSnapshot();
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
        if (!cancelled) {
          prevPublishLossRef.current = null;
          prevReceiveLossRef.current = null;
          prevPublishMediaRef.current = null;
          prevReceiveMediaRef.current = null;
          setStats({
            ...UNKNOWN_STATS,
            quality: startupBrowserQualityHint,
            publishQuality: startupBrowserQualityHint,
            receiveQuality: startupBrowserQualityHint,
            rtcPublishQuality: "unknown",
            rtcReceiveQuality: "unknown",
            emergencyMode: browserNetwork.emergency,
            publishEmergencyMode: browserNetwork.emergency,
            receiveEmergencyMode: browserNetwork.emergency,
            browserNetwork,
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

      for (const { direction, transport } of transportEntries) {
        let report: RTCStatsReport;
        try {
          report = await transport.getStats();
        } catch {
          continue;
        }

        const parsed = readReport(report);
        if (direction === "publish") {
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

      if (cancelled) return;

      const publishWindowLoss = hasPublishTransport
        ? windowedPacketLoss(
            {
              packetsLost: publish.packetsLost,
              packetsReceived: publish.packetsReceived,
            },
            prevPublishLossRef.current,
          )
        : null;
      const receiveWindowLoss = hasReceiveTransport
        ? windowedPacketLoss(
            {
              packetsLost: receive.packetsLost,
              packetsReceived: receive.packetsReceived,
            },
            prevReceiveLossRef.current,
          )
        : null;
      if (hasPublishTransport) {
        prevPublishLossRef.current = {
          packetsLost: publish.packetsLost,
          packetsReceived: publish.packetsReceived,
        };
      }
      if (hasReceiveTransport) {
        prevReceiveLossRef.current = {
          packetsLost: receive.packetsLost,
          packetsReceived: receive.packetsReceived,
        };
      }
      const publishMediaStats = hasPublishTransport
        ? buildDirectionMediaStats(publishMedia, prevPublishMediaRef.current)
        : EMPTY_DIRECTION_MEDIA_STATS;
      const receiveMediaStats = hasReceiveTransport
        ? buildDirectionMediaStats(receiveMedia, prevReceiveMediaRef.current)
        : EMPTY_DIRECTION_MEDIA_STATS;
      if (hasPublishTransport) {
        prevPublishMediaRef.current = publishMedia;
      }
      if (hasReceiveTransport) {
        prevReceiveMediaRef.current = receiveMedia;
      }

      const publishLoss = publish.lossFraction ?? publishWindowLoss;
      const receiveLoss = receiveWindowLoss;
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
      const observedPublishEmergencyMode = deriveDirectionalEmergencyMode({
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
      const observedReceiveEmergencyMode = deriveDirectionalEmergencyMode({
        rttMs: receive.rttMs,
        packetLoss: receiveLoss,
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
      const publishEmergencyMode =
        browserNetwork.emergency || observedPublishEmergencyMode;
      const receiveEmergencyMode =
        browserNetwork.emergency || observedReceiveEmergencyMode;

      setStats({
        quality: worstQuality(publishQuality, receiveQuality),
        publishQuality,
        receiveQuality,
        rtcPublishQuality: observedPublishQuality,
        rtcReceiveQuality: observedReceiveQuality,
        emergencyMode: publishEmergencyMode || receiveEmergencyMode,
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
        publishMedia: publishMediaStats,
        receiveMedia: receiveMediaStats,
      });
    };

    void poll();
    const handle = window.setInterval(() => {
      void poll();
    }, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [enabled, intervalMs, producerTransportRef, consumerTransportRef]);

  return stats;
}
