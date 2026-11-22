import { createContext, useContext } from "react";

export interface LaneObstacle {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type NoticeLaneMode = "full" | "collapsed" | "compact";

export interface NoticeLanePlacement {
  mode: NoticeLaneMode;
  top: number;
}

interface NoticeLaneBounds {
  left: number;
  right: number;
  minTop: number;
  maxBottom: number;
}

interface NoticeLaneSizes extends NoticeLaneBounds {
  count: number;
  fullHeight: number;
  collapsedHeight: number;
  compactHeight: number;
}

const CLEARANCE_PX = 6;

function findGap(
  obstacles: LaneObstacle[],
  { left, right, minTop, maxBottom }: NoticeLaneBounds,
  height: number,
): number | null {
  const blocked = obstacles
    .filter((o) => o.right > left - CLEARANCE_PX && o.left < right + CLEARANCE_PX)
    .map((o) => ({ top: o.top - CLEARANCE_PX, bottom: o.bottom + CLEARANCE_PX }));
  let top = minTop;
  let moved = true;
  while (moved) {
    moved = false;
    for (const zone of blocked) {
      if (zone.top < top + height && zone.bottom > top) {
        top = zone.bottom;
        moved = true;
      }
    }
  }
  return top + height <= maxBottom ? top : null;
}

export function placeNoticeLane(
  obstacles: LaneObstacle[],
  { count, fullHeight, collapsedHeight, compactHeight, ...bounds }: NoticeLaneSizes,
): NoticeLanePlacement {
  const full = findGap(obstacles, bounds, fullHeight);
  if (full !== null) return { mode: "full", top: full };
  if (count > 1) {
    const collapsed = findGap(obstacles, bounds, collapsedHeight);
    if (collapsed !== null) return { mode: "collapsed", top: collapsed };
  }
  const compact = findGap(obstacles, bounds, compactHeight);
  return { mode: "compact", top: compact ?? bounds.minTop };
}

export interface InCallNoticeLane {
  compact: boolean;
  announce: (id: string, text: string | null) => void;
}

export const InCallNoticeLaneContext = createContext<InCallNoticeLane | null>(null);

export const useInCallNoticeLane = () => useContext(InCallNoticeLaneContext);
