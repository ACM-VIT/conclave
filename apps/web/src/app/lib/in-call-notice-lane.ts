import { createContext, useContext } from "react";

export interface LaneObstacle {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface NoticeLaneBounds {
  left: number;
  right: number;
  minTop: number;
  maxBottom: number;
}

interface LaneSpan {
  left: number;
  right: number;
}

export interface NoticeLanePlacement extends Partial<LaneSpan> {
  mode: "full" | "compact";
  top: number;
}

export interface NoticeListPlacement extends Partial<LaneSpan> {
  top: number;
  height: number;
}

const CLEARANCE_PX = 6;
const MIN_LANE_WIDTH_PX = 240;

const padded = (o: LaneObstacle): LaneObstacle => ({
  left: o.left - CLEARANCE_PX,
  right: o.right + CLEARANCE_PX,
  top: o.top - CLEARANCE_PX,
  bottom: o.bottom + CLEARANCE_PX,
});

function narrowerLanes(obstacles: LaneObstacle[], { left, right }: NoticeLaneBounds): LaneSpan[] {
  const lanes: LaneSpan[] = [];
  for (const o of obstacles) {
    if (o.right <= left || o.left >= right) continue;
    lanes.push({ left, right: o.left - CLEARANCE_PX });
    lanes.push({ left: o.right + CLEARANCE_PX, right });
  }
  return lanes
    .filter((lane) => lane.right - lane.left >= MIN_LANE_WIDTH_PX)
    .sort((a, b) => b.right - b.left - (a.right - a.left));
}

function laneZones(obstacles: LaneObstacle[], { left, right }: NoticeLaneBounds) {
  return obstacles
    .map(padded)
    .filter((zone) => zone.right > left && zone.left < right);
}

function findGap(obstacles: LaneObstacle[], bounds: NoticeLaneBounds, height: number): number | null {
  const zones = laneZones(obstacles, bounds);
  let top = bounds.minTop;
  let moved = true;
  while (moved) {
    moved = false;
    for (const zone of zones) {
      if (zone.top < top + height && zone.bottom > top) {
        top = zone.bottom;
        moved = true;
      }
    }
  }
  return top + height <= bounds.maxBottom ? top : null;
}

export function placeNoticeLane(
  obstacles: LaneObstacle[],
  { fullHeight, compactHeight, ...bounds }: NoticeLaneBounds & { fullHeight: number; compactHeight: number },
): NoticeLanePlacement | null {
  const full = findGap(obstacles, bounds, fullHeight);
  if (full !== null) return { mode: "full", top: full };
  const compact = findGap(obstacles, bounds, compactHeight);
  if (compact !== null) return { mode: "compact", top: compact };
  for (const lane of narrowerLanes(obstacles, bounds)) {
    const top = findGap(obstacles, { ...bounds, ...lane }, compactHeight);
    if (top !== null) return { mode: "compact", top, ...lane };
  }
  return null;
}

export function findLaneGap(
  obstacles: LaneObstacle[],
  bounds: NoticeLaneBounds,
  desired: number,
  minimum: number,
): { top: number; height: number } | null {
  const zones = laneZones(obstacles, bounds);
  const tops = [bounds.minTop, ...zones.map((zone) => zone.bottom)]
    .filter((top) => top >= bounds.minTop && top < bounds.maxBottom)
    .sort((a, b) => a - b);
  const gaps: { top: number; height: number }[] = [];
  for (const top of tops) {
    if (zones.some((zone) => zone.top <= top && zone.bottom > top)) continue;
    const end = Math.min(
      bounds.maxBottom,
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

export function placeNoticeList(
  obstacles: LaneObstacle[],
  bounds: NoticeLaneBounds,
  desired: number,
  minimum: number,
): NoticeListPlacement | null {
  const gap = findLaneGap(obstacles, bounds, desired, minimum);
  if (gap) return gap;
  for (const lane of narrowerLanes(obstacles, bounds)) {
    const narrowGap = findLaneGap(obstacles, { ...bounds, ...lane }, desired, minimum);
    if (narrowGap) return { ...narrowGap, ...lane };
  }
  return null;
}

export function findClearSpot(
  obstacles: LaneObstacle[],
  { left, right, minTop, maxBottom }: NoticeLaneBounds,
  width: number,
  height: number,
): { left: number; top: number } | null {
  const zones = obstacles.map(padded);
  const xs = [left, right - width, ...zones.flatMap((zone) => [zone.right, zone.left - width])]
    .filter((x) => x >= left && x + width <= right);
  const ys = [minTop, ...zones.map((zone) => zone.bottom)]
    .filter((y) => y >= minTop && y + height <= maxBottom);
  const centre = (left + right - width) / 2;
  const clear = ys
    .flatMap((top) => xs.map((x) => ({ left: x, top })))
    .filter(
      (spot) =>
        !zones.some(
          (zone) =>
            zone.left < spot.left + width &&
            zone.right > spot.left &&
            zone.top < spot.top + height &&
            zone.bottom > spot.top,
        ),
    )
    .sort((a, b) => a.top - b.top || Math.abs(a.left - centre) - Math.abs(b.left - centre));
  return clear[0] ?? null;
}

export interface InCallNoticeLane {
  compact: boolean;
  expanded: boolean;
  announce: (text: string, tone: "error" | "warning" | "neutral") => () => void;
}

export const InCallNoticeLaneContext = createContext<InCallNoticeLane | null>(null);

export const useInCallNoticeLane = () => useContext(InCallNoticeLaneContext);
