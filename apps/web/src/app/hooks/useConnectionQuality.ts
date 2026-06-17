"use client";

import { useEffect, useRef, useState } from "react";
import type { Transport } from "../lib/types";

export type ConnectionQuality = "good" | "fair" | "poor" | "unknown";

export interface ConnectionQualityStats {
  /** Derived 3-tier quality. `unknown` until the first successful poll. */
  quality: ConnectionQuality;
  /** Round-trip time in milliseconds, if observable. */
  rttMs: number | null;
  /** Fraction of packets lost (0–1) over the most recent window. */
  packetLoss: number | null;
  /** Jitter in milliseconds, if observable. */
  jitterMs: number | null;
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
const LOSS_FAIR = 0.03; // 3%
const LOSS_POOR = 0.08; // 8%
const JITTER_FAIR_MS = 30;
const JITTER_POOR_MS = 60;

const UNKNOWN_STATS: ConnectionQualityStats = {
  quality: "unknown",
  rttMs: null,
  packetLoss: null,
  jitterMs: null,
};

interface LossSample {
  packetsLost: number;
  packetsReceived: number;
}

/**
 * Reads the relevant numeric fields off an RTCStats entry without forcing the
 * caller to depend on lib.dom's partial RTC stats typings (Safari/Chrome
 * diverge, and mediasoup forwards the raw browser report).
 */
function num(stat: Record<string, unknown>, key: string): number | null {
  const value = stat[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Derives quality signals from a single transport's RTCStatsReport.
 * - RTT comes from the nominated candidate-pair (most reliable) or, failing
 *   that, remote-inbound-rtp.
 * - Jitter + cumulative packet loss come from inbound-rtp (what we receive)
 *   and remote-inbound-rtp (what the remote reports about what we send).
 */
function readReport(report: RTCStatsReport): {
  rttMs: number | null;
  jitterMs: number | null;
  loss: LossSample;
} {
  let rttMs: number | null = null;
  let candidatePairRtt: number | null = null;
  let jitterMs: number | null = null;
  let packetsLost = 0;
  let packetsReceived = 0;

  report.forEach((raw) => {
    const stat = raw as unknown as Record<string, unknown>;
    const type = stat.type;

    if (type === "candidate-pair") {
      const nominated = stat.nominated === true || stat.state === "succeeded";
      const rtt = num(stat, "currentRoundTripTime");
      if (nominated && rtt != null) {
        candidatePairRtt = rtt * 1000;
      }
    } else if (type === "inbound-rtp") {
      const jitter = num(stat, "jitter");
      if (jitter != null) {
        jitterMs = Math.max(jitterMs ?? 0, jitter * 1000);
      }
      const lost = num(stat, "packetsLost");
      const received = num(stat, "packetsReceived");
      if (lost != null) packetsLost += Math.max(0, lost);
      if (received != null) packetsReceived += Math.max(0, received);
    } else if (type === "remote-inbound-rtp") {
      const rtt = num(stat, "roundTripTime");
      if (rtt != null) {
        rttMs = Math.max(rttMs ?? 0, rtt * 1000);
      }
      const jitter = num(stat, "jitter");
      if (jitter != null) {
        jitterMs = Math.max(jitterMs ?? 0, jitter * 1000);
      }
    }
  });

  // Prefer the candidate-pair RTT (path-level) when present.
  if (candidatePairRtt != null) {
    rttMs = rttMs == null ? candidatePairRtt : Math.max(rttMs, candidatePairRtt);
  }

  return {
    rttMs,
    jitterMs,
    loss: { packetsLost, packetsReceived },
  };
}

function deriveQuality(
  rttMs: number | null,
  packetLoss: number | null,
  jitterMs: number | null,
): ConnectionQuality {
  if (rttMs == null && packetLoss == null && jitterMs == null) {
    return "unknown";
  }

  const isPoor =
    (rttMs != null && rttMs >= RTT_POOR_MS) ||
    (packetLoss != null && packetLoss >= LOSS_POOR) ||
    (jitterMs != null && jitterMs >= JITTER_POOR_MS);
  if (isPoor) return "poor";

  const isFair =
    (rttMs != null && rttMs >= RTT_FAIR_MS) ||
    (packetLoss != null && packetLoss >= LOSS_FAIR) ||
    (jitterMs != null && jitterMs >= JITTER_FAIR_MS);
  if (isFair) return "fair";

  return "good";
}

/**
 * Polls the mediasoup transports' RTCPeerConnection.getStats() every ~2s and
 * derives a 3-tier (good/fair/poor) quality signal for the local participant.
 *
 * Reuses the existing producer/consumer transport refs from the media hook —
 * it does not create or own any peer connection.
 */
export function useConnectionQuality({
  producerTransportRef,
  consumerTransportRef,
  enabled,
  intervalMs = DEFAULT_INTERVAL_MS,
}: UseConnectionQualityOptions): ConnectionQualityStats {
  const [stats, setStats] = useState<ConnectionQualityStats>(UNKNOWN_STATS);
  // Cumulative loss counters are monotonic; track previous sample to compute the
  // loss rate over just the most recent window (not since the call started).
  const prevLossRef = useRef<LossSample | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      prevLossRef.current = null;
      setStats(UNKNOWN_STATS);
      return;
    }

    let cancelled = false;

    const poll = async () => {
      const transports = [
        producerTransportRef.current,
        consumerTransportRef.current,
      ].filter(
        (transport): transport is Transport =>
          !!transport && !transport.closed,
      );

      if (transports.length === 0) {
        if (!cancelled) {
          prevLossRef.current = null;
          setStats(UNKNOWN_STATS);
        }
        return;
      }

      let rttMs: number | null = null;
      let jitterMs: number | null = null;
      let packetsLost = 0;
      let packetsReceived = 0;

      for (const transport of transports) {
        let report: RTCStatsReport;
        try {
          report = await transport.getStats();
        } catch {
          continue;
        }
        const parsed = readReport(report);
        if (parsed.rttMs != null) {
          rttMs = rttMs == null ? parsed.rttMs : Math.max(rttMs, parsed.rttMs);
        }
        if (parsed.jitterMs != null) {
          jitterMs =
            jitterMs == null
              ? parsed.jitterMs
              : Math.max(jitterMs, parsed.jitterMs);
        }
        packetsLost += parsed.loss.packetsLost;
        packetsReceived += parsed.loss.packetsReceived;
      }

      if (cancelled) return;

      // Windowed packet-loss rate from the delta between samples.
      let packetLoss: number | null = null;
      const prev = prevLossRef.current;
      if (prev) {
        const deltaLost = Math.max(0, packetsLost - prev.packetsLost);
        const deltaReceived = Math.max(
          0,
          packetsReceived - prev.packetsReceived,
        );
        const deltaTotal = deltaLost + deltaReceived;
        if (deltaTotal > 0) {
          packetLoss = deltaLost / deltaTotal;
        } else {
          packetLoss = 0;
        }
      }
      prevLossRef.current = { packetsLost, packetsReceived };

      setStats({
        quality: deriveQuality(rttMs, packetLoss, jitterMs),
        rttMs,
        packetLoss,
        jitterMs,
      });
    };

    // Prime immediately so the indicator isn't stuck on "unknown" for 2s.
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
