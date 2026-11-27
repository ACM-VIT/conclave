"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { StageHints, StagePlacement } from "../lib/meeting-stage-layout";

export const ROOM_TILING_METADATA_INTERVAL_MS = 200;
const HISTORY_LIMIT = 24;

declare const publishedStagePlacement: unique symbol;

export type PublishedStagePlacement<P extends StagePlacement = StagePlacement> = P & {
  readonly [publishedStagePlacement]: true;
};

export interface StagePlacementDetails {
  focusIds: string[];
  warmIds: string[];
  orderedRemoteIds: string[];
  presentation: {
    presenterId: string | null;
    producerId: string | null;
    focus: boolean;
  };
}

export type StagePlacementMetadata<D extends StagePlacementDetails = StagePlacementDetails> =
  Omit<D, "presentation"> &
    Omit<StageHints, "presentation"> & {
      source: "client";
      intervalMs: number;
      presentation: D["presentation"] & StageHints["presentation"];
      sequence: number;
      timestamp: number;
      performanceTime: number;
      signature: string;
    };

interface StagePlacementSnapshot {
  current: StagePlacementMetadata | null;
  history: StagePlacementMetadata[];
  sequence: number;
  intervalMs: number;
}

declare global {
  interface Window {
    __conclaveGetMeetRoomTilingDebug?: () => StagePlacementSnapshot;
    __conclaveMeetRoomTilingDebug?: StagePlacementSnapshot;
  }
}

export function usePublishStagePlacement<
  P extends StagePlacement,
  D extends StagePlacementDetails,
>(placement: P, details: D): PublishedStagePlacement<P> {
  const { hints } = placement;
  const metadata = useMemo(() => {
    const placed = new Set([...hints.visibleRemoteIds, ...hints.primaryIds]);
    return {
      ...details,
      source: "client" as const,
      intervalMs: ROOM_TILING_METADATA_INTERVAL_MS,
      primaryIds: hints.primaryIds,
      visibleRemoteIds: hints.visibleRemoteIds,
      hiddenIds: hints.hiddenIds,
      focusIds: details.focusIds.filter((id) => placed.has(id)),
      presentation: { ...details.presentation, ...hints.presentation },
    };
  }, [details, hints]);
  const signature = useMemo(() => JSON.stringify(metadata), [metadata]);
  const currentRef = useRef<StagePlacementMetadata | null>(null);
  const historyRef = useRef<StagePlacementMetadata[]>([]);

  const readSnapshot = useCallback(
    (): StagePlacementSnapshot => ({
      current: currentRef.current,
      history: historyRef.current,
      sequence: currentRef.current?.sequence ?? 0,
      intervalMs: ROOM_TILING_METADATA_INTERVAL_MS,
    }),
    [],
  );

  const publish = useEffectEvent((heartbeat = false) => {
    const previous = currentRef.current;
    if (!heartbeat && previous?.signature === signature) return;
    const current: StagePlacementMetadata = {
      ...metadata,
      sequence: (previous?.sequence ?? 0) + 1,
      timestamp: Date.now(),
      performanceTime: Math.round(performance.now()),
      signature,
    };
    currentRef.current = current;
    historyRef.current = [...historyRef.current, current].slice(-HISTORY_LIMIT);
    window.__conclaveMeetRoomTilingDebug = readSnapshot();
    window.dispatchEvent(new CustomEvent("conclave:meet-room-tiling", { detail: current }));
  });

  useLayoutEffect(() => {
    window.__conclaveGetMeetRoomTilingDebug = readSnapshot;
    window.__conclaveMeetRoomTilingDebug = readSnapshot();
    return () => {
      if (window.__conclaveGetMeetRoomTilingDebug === readSnapshot) {
        delete window.__conclaveGetMeetRoomTilingDebug;
        delete window.__conclaveMeetRoomTilingDebug;
      }
    };
  }, [readSnapshot]);

  useLayoutEffect(() => {
    publish();
  }, [signature]);

  useEffect(() => {
    let interval: number | undefined;
    try {
      if (window.localStorage.getItem("conclave:debug-video-effects") === "1") {
        interval = window.setInterval(() => publish(true), ROOM_TILING_METADATA_INTERVAL_MS);
      }
    } catch {}
    return () => window.clearInterval(interval);
  }, []);

  return placement as PublishedStagePlacement<P>;
}
