import { getBoundsForElement, type Bounds } from "../model/geometry";
import type { WhiteboardElement } from "../model/types";

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

export type ResizeFrame = {
  startBounds: Bounds;
  handle: ResizeHandle;
  rotation: number;
  grabOffset: { x: number; y: number };
};

const isRotated = (rotation: number) => Math.abs(rotation) >= ROTATION_EPSILON;

const handleCorner = (bounds: Bounds, handle: ResizeHandle) => ({
  x: handle === "nw" || handle === "sw" ? bounds.x : bounds.x + bounds.width,
  y: handle === "nw" || handle === "ne" ? bounds.y : bounds.y + bounds.height,
});

const OPPOSITE: Record<ResizeHandle, ResizeHandle> = { nw: "se", ne: "sw", sw: "ne", se: "nw" };

export const startResizeFrame = (
  localBounds: Bounds,
  rotation: number,
  screenHandle: ResizeHandle,
  point: { x: number; y: number }
): ResizeFrame => {
  if (!isRotated(rotation)) {
    return { startBounds: localBounds, handle: screenHandle, rotation: 0, grabOffset: { x: 0, y: 0 } };
  }
  const center = boundsCenter(localBounds);
  const local = rotateAround(point, center, -rotation);
  const west = local.x < center.x;
  const north = local.y < center.y;
  const handle: ResizeHandle = north ? (west ? "nw" : "ne") : west ? "sw" : "se";
  const corner = handleCorner(localBounds, handle);
  return {
    startBounds: localBounds,
    handle,
    rotation,
    grabOffset: { x: corner.x - local.x, y: corner.y - local.y },
  };
};

export const getFrameResizePoint = (frame: ResizeFrame, point: { x: number; y: number }) => {
  if (!isRotated(frame.rotation)) return point;
  const local = rotateAround(point, boundsCenter(frame.startBounds), -frame.rotation);
  return { x: local.x + frame.grabOffset.x, y: local.y + frame.grabOffset.y };
};

export const translateElement = <T extends WhiteboardElement>(element: T, dx: number, dy: number): T => {
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return element;
  if (element.type === "stroke") {
    return {
      ...element,
      points: element.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })),
    };
  }
  return { ...element, x: element.x + dx, y: element.y + dy };
};

export const anchorResizedElement = <T extends WhiteboardElement>(element: T, frame: ResizeFrame): T => {
  if (!isRotated(frame.rotation)) return element;
  const actual = getBoundsForElement(element);
  const pivot = boundsCenter(frame.startBounds);
  const anchorWorld = rotateAround(handleCorner(frame.startBounds, OPPOSITE[frame.handle]), pivot, frame.rotation);
  const towardCenter = {
    x: (frame.handle === "ne" || frame.handle === "se" ? 1 : -1) * (actual.width / 2),
    y: (frame.handle === "sw" || frame.handle === "se" ? 1 : -1) * (actual.height / 2),
  };
  const center = rotateAround(
    { x: anchorWorld.x + towardCenter.x, y: anchorWorld.y + towardCenter.y },
    anchorWorld,
    frame.rotation
  );
  return translateElement(
    element,
    center.x - actual.width / 2 - actual.x,
    center.y - actual.height / 2 - actual.y
  );
};
