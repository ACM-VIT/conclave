import type { Point, WhiteboardElement } from "./types";

export type Bounds = { x: number; y: number; width: number; height: number };
const ROTATION_EPSILON = 0.0001;

export const getBoundsForElement = (element: WhiteboardElement): Bounds => {
  switch (element.type) {
    case "stroke": {
      if (element.points.length === 0) {
        return { x: 0, y: 0, width: 0, height: 0 };
      }
      const xs = element.points.map((p) => p.x);
      const ys = element.points.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };
    }
    case "shape":
      return normalizeBounds(element.x, element.y, element.width, element.height);
    case "text": {
      const lines = element.text.split("\n");
      const longestLineLength = lines.reduce(
        (max, line) => Math.max(max, line.length),
        0
      );
      const width =
        element.width ??
        Math.max(40, longestLineLength * element.fontSize * 0.6);
      const height =
        element.height ??
        Math.max(element.fontSize * 1.4, lines.length * element.fontSize * 1.25);
      return normalizeBounds(element.x, element.y, width, height);
    }
    case "sticky":
      return normalizeBounds(element.x, element.y, element.width, element.height);
    case "image":
      return normalizeBounds(element.x, element.y, element.width, element.height);
  }
};

const normalizeBounds = (
  x: number,
  y: number,
  width: number,
  height: number
): Bounds => {
  const normalizedX = width < 0 ? x + width : x;
  const normalizedY = height < 0 ? y + height : y;
  return {
    x: normalizedX,
    y: normalizedY,
    width: Math.abs(width),
    height: Math.abs(height),
  };
};

const getRotatedBounds = (bounds: Bounds, rotation: number): Bounds => {
  if (Math.abs(rotation) < ROTATION_EPSILON) return bounds;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x, y: bounds.y + bounds.height },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ].map((corner) => {
    const dx = corner.x - centerX;
    const dy = corner.y - centerY;
    return {
      x: centerX + dx * Math.cos(rotation) - dy * Math.sin(rotation),
      y: centerY + dx * Math.sin(rotation) + dy * Math.cos(rotation),
    };
  });

  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
};

const getElementRotation = (element: WhiteboardElement) => {
  if (!("rotation" in element)) return 0;
  return element.rotation ?? 0;
};

export const containsPoint = (bounds: Bounds, point: Point, padding = 0) => {
  return (
    point.x >= bounds.x - padding &&
    point.x <= bounds.x + bounds.width + padding &&
    point.y >= bounds.y - padding &&
    point.y <= bounds.y + bounds.height + padding
  );
};

export const hitTestElement = (
  element: WhiteboardElement,
  point: Point,
  padding = 8
): boolean => {
  const bounds = getBoundsForElement(element);
  const rotation = getElementRotation(element);
  const hitBounds = getRotatedBounds(bounds, rotation);
  return containsPoint(hitBounds, point, padding);
};

export const translateElement = (
  element: WhiteboardElement,
  dx: number,
  dy: number
): WhiteboardElement => {
  switch (element.type) {
    case "stroke":
      return {
        ...element,
        points: element.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
      };
    case "shape":
      return { ...element, x: element.x + dx, y: element.y + dy };
    case "text":
      return { ...element, x: element.x + dx, y: element.y + dy };
    case "sticky":
      return { ...element, x: element.x + dx, y: element.y + dy };
    case "image":
      return { ...element, x: element.x + dx, y: element.y + dy };
  }
};
