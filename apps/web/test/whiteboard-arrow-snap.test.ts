import { describe, expect, it } from "vitest";
import {
  ARROW_SNAP_GAP,
  snapArrow,
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

  it("does not snap from an ellipse's empty bounding-box corner", () => {
    const circle = shape("circle", "ellipse", 0, 0, 1000, 1000);
    expect(snapArrowEndpoint({ x: 10, y: 10 }, { x: -200, y: -200 }, [circle])).toBeNull();
  });

  it("puts both snapped ends on the line between the two shapes' centers", () => {
    const tall = shape("tall", "rect", 0, 0, 100, 600);
    const small = shape("small", "rect", 300, 500, 80, 80);
    const { start, end, startTargetId, endTargetId } = snapArrow(
      { x: 50, y: 20 },
      { x: 340, y: 540 },
      [tall, small],
    );
    expect([startTargetId, endTargetId]).toEqual(["tall", "small"]);
    const centerA = { x: 50, y: 300 };
    const centerB = { x: 340, y: 540 };
    const cross = (p: { x: number; y: number }) =>
      (centerB.x - centerA.x) * (p.y - centerA.y) - (centerB.y - centerA.y) * (p.x - centerA.x);
    expect(Math.abs(cross(start))).toBeLessThan(1e-6);
    expect(Math.abs(cross(end))).toBeLessThan(1e-6);
    expect(start.x).toBeCloseTo(100 + ARROW_SNAP_GAP * Math.cos(Math.atan2(240, 290)), 5);
    expect(end.x).toBeLessThan(300);
  });

  it("leaves an arrow drawn between two points on one shape unsnapped", () => {
    const wide = shape("wide", "rect", 0, 0, 400, 100);
    expect(snapArrow({ x: 10, y: 50 }, { x: 390, y: 50 }, [wide])).toEqual({
      start: { x: 10, y: 50 },
      end: { x: 390, y: 50 },
    });
  });

  it("never reverses an arrow between touching shapes", () => {
    const left = shape("left", "rect", 0, 0, 100, 100);
    const right = shape("right", "rect", 100, 0, 100, 100);
    const result = snapArrow({ x: 20, y: 50 }, { x: 180, y: 50 }, [left, right]);
    expect(result.end.x - result.start.x).toBeGreaterThan(0);
    expect(result).toEqual({
      start: { x: 20, y: 50 },
      end: { x: 100 - ARROW_SNAP_GAP, y: 50 },
      endTargetId: "right",
    });
  });
});
