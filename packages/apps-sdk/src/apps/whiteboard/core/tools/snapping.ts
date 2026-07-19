import type { Bounds } from "../model/geometry";

export type SnapEdge = "start" | "center" | "end";
export type SnapGuide = { axis: "x" | "y"; position: number; spanStart: number; spanEnd: number };
export type SnapAdjustment = { dx: number; dy: number; guides: SnapGuide[] };

const ALL_EDGES: SnapEdge[] = ["start", "center", "end"];

const edgeValue = (bounds: Bounds, axis: "x" | "y", edge: SnapEdge): number => {
  const start = axis === "x" ? bounds.x : bounds.y;
  const size = axis === "x" ? bounds.width : bounds.height;
  if (edge === "start") return start;
  if (edge === "end") return start + size;
  return start + size / 2;
};

type AxisSnap = { offset: number; guide: SnapGuide };

const computeAxisSnap = (
  movingBounds: Bounds,
  otherBounds: Bounds[],
  axis: "x" | "y",
  edges: SnapEdge[],
  threshold: number
): AxisSnap | null => {
  let best: { offset: number; distance: number; position: number; other: Bounds } | null = null;

  for (const edge of edges) {
    const value = edgeValue(movingBounds, axis, edge);
    for (const other of otherBounds) {
      for (const otherEdge of ALL_EDGES) {
        const target = edgeValue(other, axis, otherEdge);
        const distance = Math.abs(value - target);
        if (distance <= threshold && (!best || distance < best.distance)) {
          best = { offset: target - value, distance, position: target, other };
        }
      }
    }
  }

  if (!best) return null;

  const crossAxis = axis === "x" ? "y" : "x";
  const movingStart = crossAxis === "x" ? movingBounds.x : movingBounds.y;
  const movingSize = crossAxis === "x" ? movingBounds.width : movingBounds.height;
  const otherStart = crossAxis === "x" ? best.other.x : best.other.y;
  const otherSize = crossAxis === "x" ? best.other.width : best.other.height;

  return {
    offset: best.offset,
    guide: {
      axis,
      position: best.position,
      spanStart: Math.min(movingStart, otherStart),
      spanEnd: Math.max(movingStart + movingSize, otherStart + otherSize),
    },
  };
};

/**
 * Compares movingBounds' edges/centers against every bounds in otherBounds on
 * each axis independently, and returns the delta needed to align to the
 * closest match within threshold (0 if nothing is close enough to snap).
 */
export function computeSnapAdjustment(
  movingBounds: Bounds,
  otherBounds: Bounds[],
  thresholdCanvasUnits: number,
  options?: { xEdges?: SnapEdge[]; yEdges?: SnapEdge[] }
): SnapAdjustment {
  if (thresholdCanvasUnits <= 0 || otherBounds.length === 0) {
    return { dx: 0, dy: 0, guides: [] };
  }

  const xEdges = options?.xEdges ?? ALL_EDGES;
  const yEdges = options?.yEdges ?? ALL_EDGES;
  const guides: SnapGuide[] = [];
  let dx = 0;
  let dy = 0;

  const xSnap = computeAxisSnap(movingBounds, otherBounds, "x", xEdges, thresholdCanvasUnits);
  if (xSnap) {
    dx = xSnap.offset;
    guides.push(xSnap.guide);
  }

  const ySnap = computeAxisSnap(movingBounds, otherBounds, "y", yEdges, thresholdCanvasUnits);
  if (ySnap) {
    dy = ySnap.offset;
    guides.push(ySnap.guide);
  }

  return { dx, dy, guides };
}
