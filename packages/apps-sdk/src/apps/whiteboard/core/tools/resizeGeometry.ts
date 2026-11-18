import type { Bounds } from "../model/geometry";

export type ResizeHandle = "nw" | "ne" | "sw" | "se";

const ROTATION_EPSILON = 0.0001;

export const getResizedBounds = (
  startBounds: Bounds,
  handle: ResizeHandle,
  point: { x: number; y: number },
  minWidth: number,
  minHeight: number
): Bounds => {
  const left = startBounds.x;
  const top = startBounds.y;
  const right = startBounds.x + startBounds.width;
  const bottom = startBounds.y + startBounds.height;

  if (handle === "nw") {
    const x = Math.min(point.x, right - minWidth);
    const y = Math.min(point.y, bottom - minHeight);
    return { x, y, width: right - x, height: bottom - y };
  }

  if (handle === "ne") {
    const x = Math.max(point.x, left + minWidth);
    const y = Math.min(point.y, bottom - minHeight);
    return { x: left, y, width: x - left, height: bottom - y };
  }

  if (handle === "sw") {
    const x = Math.min(point.x, right - minWidth);
    const y = Math.max(point.y, top + minHeight);
    return { x, y: top, width: right - x, height: y - top };
  }

  const x = Math.max(point.x, left + minWidth);
  const y = Math.max(point.y, top + minHeight);
  return { x: left, y: top, width: x - left, height: y - top };
};

export const rotateAround = (
  point: { x: number; y: number },
  center: { x: number; y: number },
  rotation: number
) => {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * Math.cos(rotation) - dy * Math.sin(rotation),
    y: center.y + dx * Math.sin(rotation) + dy * Math.cos(rotation),
  };
};

const boundsCenter = (bounds: Bounds) => ({
  x: bounds.x + bounds.width / 2,
  y: bounds.y + bounds.height / 2,
});

export const getLocalResizeHandle = (
  localBounds: Bounds,
  rotation: number,
  point: { x: number; y: number }
): ResizeHandle => {
  const center = boundsCenter(localBounds);
  const local = rotateAround(point, center, -rotation);
  const west = local.x < center.x;
  const north = local.y < center.y;
  return north ? (west ? "nw" : "ne") : west ? "sw" : "se";
};

export const getRotatedResizedBounds = (
  session: { startBounds: Bounds; handle: ResizeHandle; rotation: number },
  point: { x: number; y: number },
  minWidth: number,
  minHeight: number
): Bounds => {
  if (Math.abs(session.rotation) < ROTATION_EPSILON) {
    return getResizedBounds(session.startBounds, session.handle, point, minWidth, minHeight);
  }
  const pivot = boundsCenter(session.startBounds);
  const local = rotateAround(point, pivot, -session.rotation);
  const resized = getResizedBounds(session.startBounds, session.handle, local, minWidth, minHeight);
  const center = rotateAround(boundsCenter(resized), pivot, session.rotation);
  return {
    x: center.x - resized.width / 2,
    y: center.y - resized.height / 2,
    width: resized.width,
    height: resized.height,
  };
};
