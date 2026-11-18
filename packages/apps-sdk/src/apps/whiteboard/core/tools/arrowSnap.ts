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

/**
 * Finds the shape an arrow end at `point` should attach to and the point on
 * its outline to attach at. `otherEnd` is the arrow's other end, which sets the
 * direction the arrow approaches from. Returns null when nothing is close.
 */
export function snapArrowEndpoint(
  point: Point,
  otherEnd: Point,
  elements: readonly WhiteboardElement[],
  options: { excludeIds?: readonly string[]; distance?: number; gap?: number } = {},
): ArrowSnap | null {
  const distance = options.distance ?? ARROW_SNAP_DISTANCE;
  const gap = options.gap ?? ARROW_SNAP_GAP;
  const exclude = new Set(options.excludeIds ?? []);
  // Topmost element wins, matching what the user sees under the pointer.
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (!element || exclude.has(element.id)) continue;
    const target = toSnapTarget(element);
    if (!target || target.bounds.width <= 0 || target.bounds.height <= 0) continue;
    if (!containsPoint(target.bounds, point, distance)) continue;
    // An arrow drawn entirely inside one shape is a mark on it, not a link.
    if (containsPoint(target.bounds, otherEnd)) continue;
    return { point: outlinePointToward(target, otherEnd, gap), targetId: target.id };
  }
  return null;
}
