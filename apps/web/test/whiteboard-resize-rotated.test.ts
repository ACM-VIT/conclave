import { describe, expect, it } from "vitest";
import { getBoundsForElement, type Bounds } from "../../../packages/apps-sdk/src/apps/whiteboard/core/model/geometry";
import type { ShapeElement, TextElement, WhiteboardElement } from "../../../packages/apps-sdk/src/apps/whiteboard/core/model/types";
import {
  anchorResizedElement,
  getFrameResizePoint,
  getResizedBounds,
  rotateAround,
  startResizeFrame,
  type ResizeFrame,
  type ResizeHandle,
} from "../../../packages/apps-sdk/src/apps/whiteboard/core/tools/resizeGeometry";

const centerOf = (bounds: Bounds) => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });

const screenBox = (bounds: Bounds, rotation: number): Bounds => {
  const center = centerOf(bounds);
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x, y: bounds.y + bounds.height },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ].map((corner) => rotateAround(corner, center, rotation));
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
};

const screenHandlePoint = (box: Bounds, handle: ResizeHandle) => ({
  x: handle.endsWith("w") ? box.x : box.x + box.width,
  y: handle.startsWith("n") ? box.y : box.y + box.height,
});

const shape = (width: number, height: number, rotation: number): ShapeElement =>
  ({ id: "s", type: "shape", shape: "rectangle", x: 0, y: 0, width, height, rotation }) as unknown as ShapeElement;

const resizeShape = (element: ShapeElement, frame: ResizeFrame, point: { x: number; y: number }) => {
  const bounds = getResizedBounds(frame.startBounds, frame.handle, getFrameResizePoint(frame, point), 12, 12);
  const resized = { ...element, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  return anchorResizedElement(resized, frame);
};

const OPPOSITE: Record<ResizeHandle, ResizeHandle> = { nw: "se", ne: "sw", sw: "ne", se: "nw" };

const worldCorner = (element: WhiteboardElement, rotation: number, corner: ResizeHandle) => {
  const bounds = getBoundsForElement(element);
  return rotateAround(screenHandlePoint(bounds, corner), centerOf(bounds), rotation);
};

describe("resizing a rotated whiteboard element", () => {
  for (const degrees of [30, 45, 90]) {
    it(`keeps its size when grabbed and not moved at ${degrees}°`, () => {
      const rotation = (degrees * Math.PI) / 180;
      const element = shape(100, 100, rotation);
      const start = getBoundsForElement(element);
      for (const handle of ["nw", "ne", "sw", "se"] as const) {
        const grab = screenHandlePoint(screenBox(start, rotation), handle);
        const frame = startResizeFrame(start, rotation, handle, grab);
        const next = getBoundsForElement(resizeShape(element, frame, grab));
        expect(next.width).toBeCloseTo(100);
        expect(next.height).toBeCloseTo(100);
        expect(next.x).toBeCloseTo(0);
        expect(next.y).toBeCloseTo(0);
      }
    });
  }

  it("grows with the drag and keeps the opposite corner in place", () => {
    const rotation = Math.PI / 6;
    const element = shape(100, 60, rotation);
    const start = getBoundsForElement(element);
    const grab = screenHandlePoint(screenBox(start, rotation), "se");
    const frame = startResizeFrame(start, rotation, "se", grab);
    const drag = rotateAround({ x: 20, y: 10 }, { x: 0, y: 0 }, rotation);
    const next = resizeShape(element, frame, { x: grab.x + drag.x, y: grab.y + drag.y });
    const bounds = getBoundsForElement(next);
    expect(bounds.width).toBeCloseTo(120);
    expect(bounds.height).toBeCloseTo(70);
    expect(frame.handle).toBe("se");
    const before = worldCorner(element, rotation, "nw");
    const after = worldCorner(next, rotation, "nw");
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("keeps the anchor when text measures to a different size than requested", () => {
    const rotation = Math.PI / 2;
    const text = {
      id: "t",
      type: "text",
      x: 0,
      y: 0,
      text: "Hello",
      fontSize: 20,
      width: 100,
      height: 28,
      rotation,
    } as unknown as TextElement;
    const start = getBoundsForElement(text);
    const frame = startResizeFrame(start, rotation, "se", screenHandlePoint(screenBox(start, rotation), "se"));
    const measured = { ...text, fontSize: 30, width: 150, height: 42 };
    const next = anchorResizedElement(measured, frame);
    const anchor = OPPOSITE[frame.handle];
    const before = worldCorner(text, rotation, anchor);
    const after = worldCorner(next, rotation, anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("leaves unrotated elements on the plain path", () => {
    const frame = startResizeFrame({ x: 0, y: 0, width: 100, height: 60 }, 0, "se", { x: 101, y: 59 });
    expect(frame.grabOffset).toEqual({ x: 0, y: 0 });
    expect(getFrameResizePoint(frame, { x: 130, y: 90 })).toEqual({ x: 130, y: 90 });
    const element = shape(130, 90, 0);
    expect(anchorResizedElement(element, frame)).toBe(element);
  });
});
