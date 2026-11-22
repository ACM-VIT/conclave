import { describe, expect, it } from "vitest";
import { findClearSpot, findLaneGap, placeNoticeLane, placeNoticeList } from "../src/app/lib/in-call-notice-lane";

const lane = { left: 12, right: 378, minTop: 12, maxBottom: 700 };
const pin = { left: 311, right: 345, top: 45, bottom: 79 };

describe("notice lane placement", () => {
  it("keeps the stack at the top when nothing is in the way", () => {
    expect(
      placeNoticeLane([], { ...lane, fullHeight: 160, compactHeight: 40 }),
    ).toEqual({ mode: "full", top: 12 });
  });

  it("moves the stack below a tile control it would cover", () => {
    const placement = placeNoticeLane([pin], { ...lane, fullHeight: 112, compactHeight: 40 });
    expect(placement?.mode).toBe("full");
    expect(placement!.top).toBeGreaterThanOrEqual(pin.bottom);
  });

  it("ignores controls outside the lane", () => {
    const aside = { left: 400, right: 440, top: 20, bottom: 60 };
    expect(
      placeNoticeLane([aside], { ...lane, fullHeight: 112, compactHeight: 40 }),
    ).toEqual({ mode: "full", top: 12 });
  });

  it("falls back to a compact one-line notice when only a thin gap is free", () => {
    const zoom = { left: 263, right: 295, top: 80, bottom: 112 };
    const placement = placeNoticeLane([zoom], { ...lane, maxBottom: 200, fullHeight: 260, compactHeight: 40 });
    expect(placement?.mode).toBe("compact");
    const top = placement!.top;
    const coversZoom = top < zoom.bottom && top + 40 > zoom.top;
    expect(coversZoom).toBe(false);
  });
});

describe("finding a clear gap for an expanded list", () => {
  const bounds = { left: 12, right: 378, minTop: 12, maxBottom: 300 };

  it("uses the first gap tall enough for the whole list", () => {
    expect(findLaneGap([], bounds, 200, 44)).toEqual({ top: 12, height: 288 });
  });

  it("picks a clear gap below a control instead of a blocked top, capped to that gap", () => {
    const pin = { left: 311, right: 345, top: 20, bottom: 54 };
    const zoom = { left: 263, right: 295, top: 180, bottom: 212 };
    const gap = findLaneGap([pin, zoom], bounds, 400, 44);
    expect(gap).not.toBeNull();
    const { top, height } = gap!;
    for (const o of [pin, zoom]) expect(top < o.bottom && top + height > o.top).toBe(false);
    expect(height).toBeGreaterThanOrEqual(44);
  });

  it("reports no gap when nothing clear is tall enough", () => {
    const wall = { left: 0, right: 400, top: 40, bottom: 290 };
    expect(findLaneGap([wall], bounds, 200, 44)).toBeNull();
  });
});

describe("narrowing the lane when no full-width gap is free", () => {
  it("slides the compact card beside a corner control instead of over it", () => {
    const pin = { left: 323, right: 351, top: 39, bottom: 67 };
    const selfView = { left: 186, right: 358, top: 121, bottom: 164 };
    const placement = placeNoticeLane([pin, selfView], {
      left: 12, right: 378, minTop: 12, maxBottom: 174,
      fullHeight: 200, compactHeight: 56,
    });
    expect(placement?.mode).toBe("compact");
    const right = placement?.right ?? 378;
    const left = placement?.left ?? 12;
    expect(right - left).toBeGreaterThanOrEqual(240);
    for (const o of [pin, selfView]) {
      const overlapsX = o.right > left && o.left < right;
      const overlapsY = o.bottom > placement!.top && o.top < placement!.top + 56;
      expect(overlapsX && overlapsY).toBe(false);
    }
  });
});


const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const intersects = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe("placement over random stages", () => {
  const random = mulberry32(276);
  const stages = Array.from({ length: 400 }, () => {
    const width = 300 + Math.round(random() * 1200);
    const height = 120 + Math.round(random() * 800);
    const obstacles = Array.from({ length: Math.round(random() * 14) }, () => {
      const w = 24 + random() * 160;
      const h = 24 + random() * 60;
      const left = random() * (width - w);
      const top = random() * (height - h);
      return { left, right: left + w, top, bottom: top + h };
    });
    const laneWidth = Math.min(560, width - 24);
    const laneLeft = (width - laneWidth) / 2;
    return { width, height, obstacles, bounds: { left: laneLeft, right: laneLeft + laneWidth, minTop: 12, maxBottom: height } };
  });

  it("puts a collapsed stack in a clear rect or reports no room", () => {
    for (const { obstacles, bounds } of stages) {
      const placement = placeNoticeLane(obstacles, { ...bounds, fullHeight: 120, compactHeight: 56 });
      if (!placement) continue;
      const rect = {
        left: placement.left ?? bounds.left,
        right: placement.right ?? bounds.right,
        top: placement.top,
        bottom: placement.top + (placement.mode === "full" ? 120 : 56),
      };
      expect(rect.bottom).toBeLessThanOrEqual(bounds.maxBottom);
      for (const o of obstacles) expect(intersects(rect, o)).toBe(false);
    }
  });

  it("puts an expanded list in a clear rect or reports no room", () => {
    for (const { obstacles, bounds } of stages) {
      const spot = placeNoticeList(obstacles, bounds, 300, 80);
      if (!spot) continue;
      const rect = { left: spot.left ?? bounds.left, right: spot.right ?? bounds.right, top: spot.top, bottom: spot.top + Math.min(spot.height, 300) };
      expect(rect.bottom - rect.top).toBeGreaterThanOrEqual(80);
      for (const o of obstacles) expect(intersects(rect, o)).toBe(false);
    }
  });

  it("finds the no-room chip a clear spot inside the stage", () => {
    for (const { width, obstacles, bounds } of stages) {
      const spot = findClearSpot(obstacles, { ...bounds, left: 12, right: width - 12 }, 56, 40);
      if (!spot) continue;
      const rect = { left: spot.left, right: spot.left + 56, top: spot.top, bottom: spot.top + 40 };
      expect(rect.left).toBeGreaterThanOrEqual(12);
      expect(rect.right).toBeLessThanOrEqual(width - 12);
      for (const o of obstacles) expect(intersects(rect, o)).toBe(false);
    }
  });
});
