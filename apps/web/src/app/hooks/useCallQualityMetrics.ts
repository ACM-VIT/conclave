"use client";

import { useEffect, useState, type MutableRefObject } from "react";
import {
  createCallMetricsTracker,
  parseCallStats,
  type JoinMode,
  type StatsRead,
} from "../lib/call-quality-metrics";
import { telemetry, telemetryEnabled } from "../lib/telemetry";
import type {
  ConnectionState,
  MeetError,
  Producer,
  ReconnectRecoveryStatus,
  Transport,
  VideoQuality,
} from "../lib/types";

const IDLE_POLL_MS = 500;

const newCallId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

type StatsSource = Pick<Transport | Producer, "id" | "closed" | "getStats">;

// A missing or closed source has nothing flowing through it, which is a
// reading of zero streams. Only a getStats that fails is unreadable.
const NOTHING_FLOWING: StatsRead = { sourceId: "none", report: new Map() };

const readReport = async (
  source: StatsSource | null,
): Promise<StatsRead | null> => {
  if (!source || source.closed) return NOTHING_FLOWING;
  try {
    return { sourceId: source.id, report: await source.getStats() };
  } catch {
    return null;
  }
};

/**
 * Feeds the call-quality tracker from connection state, roster size and
 * getStats. Outbound numbers come from the camera producer alone, so a screen
 * share on the same send transport never counts as camera video.
 */
export function useCallQualityMetrics({
  connectionState,
  meetError,
  reconnectRecoveryStatus,
  admittedAt,
  participantCount,
  joinMode,
  consumerTransportRef,
  cameraProducerRef,
  videoQualityRef,
}: {
  connectionState: ConnectionState;
  meetError: MeetError | null;
  reconnectRecoveryStatus: ReconnectRecoveryStatus | null;
  /** performance.now() when the host let the user in from the waiting room. */
  admittedAt: number | null;
  participantCount: number;
  joinMode: JoinMode;
  consumerTransportRef: MutableRefObject<Transport | null>;
  cameraProducerRef: MutableRefObject<Producer | null>;
  videoQualityRef: MutableRefObject<VideoQuality>;
}): void {
  const [tracker] = useState(() =>
    createCallMetricsTracker({
      newCallId,
      emit: ({ name, props, immediate }) =>
        telemetry.capture(name, props, { immediate }),
    }),
  );

  const reconnectGaveUp = reconnectRecoveryStatus?.phase === "failed";
  useEffect(() => {
    tracker.onConnectionState(
      { state: connectionState, error: meetError, joinMode, reconnectGaveUp },
      performance.now(),
    );
  }, [tracker, connectionState, meetError, joinMode, reconnectGaveUp]);

  useEffect(() => {
    if (admittedAt !== null) tracker.onAdmitted(admittedAt);
  }, [tracker, admittedAt]);

  useEffect(() => {
    tracker.onParticipants(participantCount, performance.now());
  }, [tracker, participantCount]);

  const sampling = telemetryEnabled && connectionState !== "disconnected";
  useEffect(() => {
    if (!sampling) return;
    let cancelled = false;
    let timer: number | undefined;
    const sample = async () => {
      const delay = tracker.nextSampleDelayMs(performance.now());
      if (delay !== null) {
        const [receive, camera] = await Promise.all([
          readReport(consumerTransportRef.current),
          readReport(cameraProducerRef.current),
        ]);
        if (cancelled) return;
        tracker.onStats(
          parseCallStats({ receive, camera, profile: videoQualityRef.current }),
          performance.now(),
        );
      }
      schedule(delay ?? IDLE_POLL_MS);
    };
    const schedule = (ms: number) => {
      timer = window.setTimeout(() => void sample(), ms);
    };
    schedule(IDLE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    tracker,
    sampling,
    consumerTransportRef,
    cameraProducerRef,
    videoQualityRef,
  ]);

  useEffect(() => {
    const finish = () => tracker.onPageHidden(performance.now());
    window.addEventListener("pagehide", finish);
    return () => {
      window.removeEventListener("pagehide", finish);
      finish();
    };
  }, [tracker]);
}
