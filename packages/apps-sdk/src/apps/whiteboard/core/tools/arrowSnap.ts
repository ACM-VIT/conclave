import { containsPoint, getBoundsForElement, type Bounds } from "../model/geometry";
import type { Point, WhiteboardElement } from "../model/types";

/** How close (in canvas units) an arrow end must be to a shape to snap. */
export const ARROW_SNAP_DISTANCE = 16;
/** Space left between a snapped arrow end and the shape's outline. */
export const ARROW_SNAP_GAP = 6;

export type ArrowSnap = { point: Point; targetId: string };

type SnapTarget = { id: string; bounds: Bounds; ellipse: boolean };

const ROTATION_EPSILON = 0.0001;

function toSnapTarget(element: WhiteboardElement): SnapTarget | null {
  if ("rotation" in element && Math.abs(element.rotation ?? 0) > ROTATION_EPSILON) {
    return null;
  }
  if (element.type === "shape") {
    if (element.shape !== "rect" && element.shape !== "ellipse") return null;
    return {
      id: element.id,
      bounds: getBoundsForElement(element),
      ellipse: element.shape === "ellipse",
    };
  }
  if (element.type === "sticky" || element.type === "image" || element.type === "text") {
    return { id: element.id, bounds: getBoundsForElement(element), ellipse: false };
  }
  return null;
}

/**
 * Point on the target's outline (pushed out by `gap`) along the line from its
 * center toward `toward`, so a snapped arrow points at the middle of the shape
 * and stops just short of its edge.
 */
function outlinePointToward(target: SnapTarget, toward: Point, gap: number): Point {
  const { bounds } = target;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const hw = bounds.width / 2;
  const hh = bounds.height / 2;
  let dx = toward.x - cx;
  let dy = toward.y - cy;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    // The other end sits on the center; aim straight up.
    dx = 0;
    dy = -1;
  } else {
    dx /= length;
    dy /= length;
  }
  let distance: number;
  if (target.ellipse) {
    const denom = Math.sqrt(
      (hw > 0 ? (dx * dx) / (hw * hw) : Infinity) +
        (hh > 0 ? (dy * dy) / (hh * hh) : Infinity),
    );
    distance = Number.isFinite(denom) && denom > 0 ? 1 / denom : 0;
  } else {
    const tx = Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity;
    const ty = Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity;
    distance = Math.min(tx, ty);
    if (!Number.isFinite(distance)) distance = 0;
  }
  return { x: cx + dx * (distance + gap), y: cy + dy * (distance + gap) };
}

function isWithin(target: SnapTarget, point: Point, padding: number): boolean {
  if (!target.ellipse) return containsPoint(target.bounds, point, padding);
  const { bounds } = target;
  const rx = bounds.width / 2 + padding;
  const ry = bounds.height / 2 + padding;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (point.x - (bounds.x + bounds.width / 2)) / rx;
  const dy = (point.y - (bounds.y + bounds.height / 2)) / ry;
  return dx * dx + dy * dy <= 1;
}

function centerOf(target: SnapTarget): Point {
  return {
    x: target.bounds.x + target.bounds.width / 2,
    y: target.bounds.y + target.bounds.height / 2,
  };
}

type SnapOptions = { excludeIds?: readonly string[]; distance?: number; gap?: number };

/**
 * The element an arrow end at `point` should attach to: the topmost snap
 * target within `distance` of the point, unless `otherEnd` is inside that same
 * element (an arrow drawn within one shape is a mark on it, not a link).
 */
function findSnapTarget(
  point: Point,
  otherEnd: Point,
  elements: readonly WhiteboardElement[],
  options: SnapOptions,
): SnapTarget | null {
  const distance = options.distance ?? ARROW_SNAP_DISTANCE;
  const exclude = new Set(options.excludeIds ?? []);
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (!element || exclude.has(element.id)) continue;
    const target = toSnapTarget(element);
    if (!target || target.bounds.width <= 0 || target.bounds.height <= 0) continue;
    if (!isWithin(target, point, distance)) continue;
    if (isWithin(target, otherEnd, 0)) continue;
    return target;
  }
  return null;
}

/**
 * Finds the shape an arrow end at `point` should attach to and the point on
 * its outline to attach at, aimed from `otherEnd`. Returns null when nothing
 * is close.
 */
export function snapArrowEndpoint(
  point: Point,
  otherEnd: Point,
  elements: readonly WhiteboardElement[],
  options: SnapOptions = {},
): ArrowSnap | null {
  const target = findSnapTarget(point, otherEnd, elements, options);
  if (!target) return null;
  return {
    point: outlinePointToward(target, otherEnd, options.gap ?? ARROW_SNAP_GAP),
    targetId: target.id,
  };
}

/**
 * Snaps both ends of an arrow drawn from `start` to `end`. Targets are found
 * first; then each snapped end is placed on the line toward the other end's
 * target center (or the other raw end), so with two targets both ends sit on
 * one center-to-center line and the arrow never cuts through either shape.
 */
export function snapArrow(
  start: Point,
  end: Point,
  elements: readonly WhiteboardElement[],
  options: SnapOptions = {},
): { start: Point; end: Point; startTargetId?: string; endTargetId?: string } {
  const gap = options.gap ?? ARROW_SNAP_GAP;
  const endTarget = findSnapTarget(end, start, elements, options);
  const startTarget = findSnapTarget(start, end, elements, options);
  // Both ends on the same element is not a link; leave the arrow as drawn.
  if (startTarget && endTarget && startTarget.id === endTarget.id) {
    return { start, end };
  }
  const startAnchor = startTarget ? centerOf(startTarget) : start;
  const endAnchor = endTarget ? centerOf(endTarget) : end;
  const paired = {
    start: startTarget ? outlinePointToward(startTarget, endAnchor, gap) : start,
    end: endTarget ? outlinePointToward(endTarget, startAnchor, gap) : end,
  };
  if (pointsForward(paired.start, paired.end, start, end)) {
    return {
      ...paired,
      ...(startTarget ? { startTargetId: startTarget.id } : {}),
      ...(endTarget ? { endTargetId: endTarget.id } : {}),
    };
  }
  // Shapes that touch or nearly touch leave no room for both gaps, and the
  // paired ends would cross. Keep the head attached and the tail as drawn.
  if (endTarget) {
    const headOnly = outlinePointToward(endTarget, start, gap);
    if (pointsForward(start, headOnly, start, end)) {
      return { start, end: headOnly, endTargetId: endTarget.id };
    }
  }
  return { start, end };
}

/** Shortest snapped arrow kept; anything shorter is left as drawn. */
const MIN_SNAPPED_ARROW_LENGTH = 4;

/**
 * True when the arrow from `from` to `to` is long enough and still points the
 * same way as the arrow as drawn, so snapping never reverses it.
 */
function pointsForward(from: Point, to: Point, drawnFrom: Point, drawnTo: Point): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < MIN_SNAPPED_ARROW_LENGTH) return false;
  return dx * (drawnTo.x - drawnFrom.x) + dy * (drawnTo.y - drawnFrom.y) > 0;
}
