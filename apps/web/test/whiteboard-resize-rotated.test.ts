import { describe, expect, it } from "vitest";
import {
  getLocalResizeHandle,
  getRotatedResizedBounds,
  rotateAround,
} from "../../../packages/apps-sdk/src/apps/whiteboard/core/tools/resizeGeometry";

const rect = { x: 0, y: 0, width: 100, height: 60 };
const center = { x: 50, y: 30 };
const quarter = Math.PI / 2;
const worldCorner = (local: { x: number; y: number }) => rotateAround(local, center, quarter);

describe("resizing a rotated whiteboard element", () => {
  it("keeps its own size when the pointer has not moved", () => {
    const grab = worldCorner({ x: 100, y: 60 });
    const handle = getLocalResizeHandle(rect, quarter, grab);
    expect(handle).toBe("se");
    const bounds = getRotatedResizedBounds({ startBounds: rect, handle, rotation: quarter }, grab, 12, 12);
    expect(bounds.width).toBeCloseTo(100);
    expect(bounds.height).toBeCloseTo(60);
    expect(bounds.x).toBeCloseTo(0);
    expect(bounds.y).toBeCloseTo(0);
  });

  it("follows the drag and keeps the opposite corner in place", () => {
    const handle = getLocalResizeHandle(rect, quarter, worldCorner({ x: 100, y: 60 }));
    const pointer = worldCorner({ x: 120, y: 70 });
    const bounds = getRotatedResizedBounds({ startBounds: rect, handle, rotation: quarter }, pointer, 12, 12);
    expect(bounds.width).toBeCloseTo(120);
    expect(bounds.height).toBeCloseTo(70);
    const nextCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const anchor = rotateAround({ x: bounds.x, y: bounds.y }, nextCenter, quarter);
    const startAnchor = worldCorner({ x: 0, y: 0 });
    expect(anchor.x).toBeCloseTo(startAnchor.x);
    expect(anchor.y).toBeCloseTo(startAnchor.y);
  });

  it("leaves unrotated elements on the plain path", () => {
    const bounds = getRotatedResizedBounds({ startBounds: rect, handle: "se", rotation: 0 }, { x: 130, y: 90 }, 12, 12);
    expect(bounds).toEqual({ x: 0, y: 0, width: 130, height: 90 });
  });
});
