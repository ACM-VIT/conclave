"use client";

import { useEffect, useState, type MutableRefObject } from "react";
import {
  createCallMetricsTracker,
  parseCallStats,
  type JoinMode,
} from "../lib/call-quality-metrics";
import { telemetry } from "../lib/telemetry";
import type {
  ConnectionState,
  MeetError,
  Transport,
  VideoQuality,
} from "../lib/types";

const IDLE_POLL_MS = 500;

const newCallId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const readReport = async (transport: Transport | null) => {
  if (!transport || transport.closed) return null;
  try {
    return await transport.getStats();
  } catch {
    return null;
  }
};

/** Feeds the call-quality tracker from connection state, roster size and getStats. */
export function useCallQualityMetrics({
  connectionState,
  meetError,
  participantCount,
  joinMode,
  consumerTransportRef,
  producerTransportRef,
  videoQualityRef,
}: {
  connectionState: ConnectionState;
  meetError: MeetError | null;
  participantCount: number;
  joinMode: JoinMode;
  consumerTransportRef: MutableRefObject<Transport | null>;
  producerTransportRef: MutableRefObject<Transport | null>;
  videoQualityRef: MutableRefObject<VideoQuality>;
}): void {
  const [tracker] = useState(() =>
    createCallMetricsTracker({
      newCallId,
      emit: ({ name, props, immediate }) =>
        telemetry.capture(name, props, { immediate }),
    }),
  );

  useEffect(() => {
    tracker.onConnectionState(
      connectionState,
      meetError,
      joinMode,
      performance.now(),
    );
  }, [tracker, connectionState, meetError, joinMode]);

  useEffect(() => {
    tracker.onParticipants(participantCount, performance.now());
  }, [tracker, participantCount]);

  const sampling = connectionState !== "disconnected";
  useEffect(() => {
    if (!sampling) return;
    let cancelled = false;
    let timer: number | undefined;
    const sample = async () => {
      const delay = tracker.nextSampleDelayMs(performance.now());
      if (delay !== null) {
        const receiveTransport = consumerTransportRef.current;
        const [receive, send] = await Promise.all([
          readReport(receiveTransport),
          readReport(producerTransportRef.current),
        ]);
        if (cancelled) return;
        tracker.onStats(
          parseCallStats({
            receive:
              receive && receiveTransport
                ? { transportId: receiveTransport.id, report: receive }
                : null,
            send,
            profile: videoQualityRef.current,
          }),
          performance.now(),
        );
      }
      timer = window.setTimeout(sample, delay ?? IDLE_POLL_MS);
    };
    timer = window.setTimeout(sample, IDLE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    tracker,
    sampling,
    consumerTransportRef,
    producerTransportRef,
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
