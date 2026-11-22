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
  left?: number;
  right?: number;
  blocked?: boolean;
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
const MIN_LANE_WIDTH_PX = 240;

function narrowerLanes(obstacles: LaneObstacle[], { left, right }: NoticeLaneBounds) {
  const lanes: { left: number; right: number }[] = [];
  for (const o of obstacles) {
    if (o.right <= left || o.left >= right) continue;
    lanes.push({ left, right: o.left - CLEARANCE_PX });
    lanes.push({ left: o.right + CLEARANCE_PX, right });
  }
  return lanes
    .filter((lane) => lane.right - lane.left >= MIN_LANE_WIDTH_PX)
    .sort((a, b) => b.right - b.left - (a.right - a.left));
}

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
  if (compact !== null) return { mode: "compact", top: compact };
  for (const lane of narrowerLanes(obstacles, bounds)) {
    const top = findGap(obstacles, { ...bounds, ...lane }, compactHeight);
    if (top !== null) return { mode: "compact", top, ...lane };
  }
  return { mode: "compact", top: bounds.minTop, blocked: true };
}

export function findLaneGap(
  obstacles: LaneObstacle[],
  { left, right, minTop, maxBottom }: NoticeLaneBounds,
  desired: number,
  minimum: number,
): { top: number; height: number } | null {
  const zones = obstacles
    .filter((o) => o.right > left - CLEARANCE_PX && o.left < right + CLEARANCE_PX)
    .map((o) => ({ top: o.top - CLEARANCE_PX, bottom: o.bottom + CLEARANCE_PX }));
  const tops = [minTop, ...zones.map((zone) => zone.bottom)]
    .filter((top) => top >= minTop && top < maxBottom)
    .sort((a, b) => a - b);
  const gaps: { top: number; height: number }[] = [];
  for (const top of tops) {
    if (zones.some((zone) => zone.top <= top && zone.bottom > top)) continue;
    const end = Math.min(
      maxBottom,
      ...zones.filter((zone) => zone.top > top).map((zone) => zone.top),
    );
    gaps.push({ top, height: end - top });
  }
  const whole = gaps.find((gap) => gap.height >= desired);
  if (whole) return whole;
  const usable = gaps.filter((gap) => gap.height >= minimum);
  if (usable.length === 0) return null;
  return usable.reduce((best, gap) => (gap.height > best.height ? gap : best));
}

export interface InCallNoticeLane {
  compact: boolean;
  expanded: boolean;
  announce: (id: string, text: string | null, urgent: boolean) => void;
}

export const InCallNoticeLaneContext = createContext<InCallNoticeLane | null>(null);

export const useInCallNoticeLane = () => useContext(InCallNoticeLaneContext);
