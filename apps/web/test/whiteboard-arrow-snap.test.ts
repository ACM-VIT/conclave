import { describe, expect, it } from "vitest";
import {
  ARROW_SNAP_GAP,
  snapArrowEndpoint,
} from "../../../packages/apps-sdk/src/apps/whiteboard/core/tools/arrowSnap";
import type { WhiteboardElement } from "../../../packages/apps-sdk/src/apps/whiteboard/core/model/types";

const shape = (
  id: string,
  kind: "rect" | "ellipse" | "line",
  x: number,
  y: number,
  width: number,
  height: number,
  rotation?: number,
): WhiteboardElement => ({
  id,
  type: "shape",
  shape: kind,
  x,
  y,
  width,
  height,
  strokeColor: "#fff",
  strokeWidth: 2,
  ...(rotation === undefined ? {} : { rotation }),
});

describe("whiteboard arrow snapping", () => {
  const box = shape("box", "rect", 100, 100, 100, 50);

  it("snaps an end inside or near a rectangle to its outline, aimed at the center", () => {
    const snap = snapArrowEndpoint({ x: 140, y: 120 }, { x: 0, y: 125 }, [box]);
    expect(snap?.targetId).toBe("box");
    expect(snap?.point.x).toBeCloseTo(100 - ARROW_SNAP_GAP);
    expect(snap?.point.y).toBeCloseTo(125);

    const near = snapArrowEndpoint({ x: 150, y: 90 }, { x: 150, y: 0 }, [box]);
    expect(near?.point.x).toBeCloseTo(150);
    expect(near?.point.y).toBeCloseTo(100 - ARROW_SNAP_GAP);
  });

  it("snaps to an ellipse's curved outline", () => {
    const circle = shape("circle", "ellipse", 0, 0, 100, 100);
    const snap = snapArrowEndpoint({ x: 60, y: 60 }, { x: 200, y: 200 }, [circle]);
    const radius = Math.hypot(snap!.point.x - 50, snap!.point.y - 50);
    expect(snap?.targetId).toBe("circle");
    expect(radius).toBeCloseTo(50 + ARROW_SNAP_GAP);
  });

  it("leaves ends alone when nothing is close, or when both ends are in one shape", () => {
    expect(snapArrowEndpoint({ x: 400, y: 400 }, { x: 0, y: 0 }, [box])).toBeNull();
    expect(snapArrowEndpoint({ x: 150, y: 120 }, { x: 110, y: 110 }, [box])).toBeNull();
  });

  it("ignores lines, rotated shapes and excluded elements, and prefers the topmost", () => {
    const line = shape("line", "line", 100, 100, 100, 50);
    const rotated = shape("rotated", "rect", 100, 100, 100, 50, 0.5);
    const point = { x: 150, y: 125 };
    const from = { x: 0, y: 0 };
    expect(snapArrowEndpoint(point, from, [line, rotated])).toBeNull();
    expect(snapArrowEndpoint(point, from, [box], { excludeIds: ["box"] })).toBeNull();

    const top = shape("top", "rect", 120, 110, 60, 30);
    expect(snapArrowEndpoint(point, from, [box, top])?.targetId).toBe("top");
  });
});
