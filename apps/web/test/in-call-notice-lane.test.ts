import { describe, expect, it } from "vitest";
import { findLaneGap, placeNoticeLane } from "../src/app/lib/in-call-notice-lane";

const lane = { left: 12, right: 378, minTop: 12, maxBottom: 700 };
const pin = { left: 311, right: 345, top: 45, bottom: 79 };

describe("notice lane placement", () => {
  it("keeps the stack at the top when nothing is in the way", () => {
    expect(
      placeNoticeLane([], { ...lane, count: 2, fullHeight: 160, collapsedHeight: 120, compactHeight: 40 }),
    ).toEqual({ mode: "full", top: 12 });
  });

  it("moves the stack below a tile control it would cover", () => {
    const placement = placeNoticeLane([pin], { ...lane, count: 1, fullHeight: 112, collapsedHeight: 112, compactHeight: 40 });
    expect(placement.mode).toBe("full");
    expect(placement.top).toBeGreaterThanOrEqual(pin.bottom);
  });

  it("ignores controls outside the lane", () => {
    const aside = { left: 400, right: 440, top: 20, bottom: 60 };
    expect(
      placeNoticeLane([aside], { ...lane, count: 1, fullHeight: 112, collapsedHeight: 112, compactHeight: 40 }),
    ).toEqual({ mode: "full", top: 12 });
  });

  it("collapses to the first notice when the whole stack does not fit a gap", () => {
    const zoom = { left: 263, right: 295, top: 156, bottom: 188 };
    const placement = placeNoticeLane([zoom], { ...lane, maxBottom: 250, count: 3, fullHeight: 260, collapsedHeight: 120, compactHeight: 40 });
    expect(placement).toEqual({ mode: "collapsed", top: 12 });
  });

  it("falls back to a compact one-line notice when only a thin gap is free", () => {
    const zoom = { left: 263, right: 295, top: 80, bottom: 112 };
    const placement = placeNoticeLane([zoom], { ...lane, maxBottom: 200, count: 3, fullHeight: 260, collapsedHeight: 150, compactHeight: 40 });
    expect(placement.mode).toBe("compact");
    const top = placement.top;
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
      count: 3, fullHeight: 200, collapsedHeight: 200, compactHeight: 56,
    });
    expect(placement.mode).toBe("compact");
    const right = placement.right ?? 378;
    const left = placement.left ?? 12;
    expect(right - left).toBeGreaterThanOrEqual(240);
    for (const o of [pin, selfView]) {
      const overlapsX = o.right > left && o.left < right;
      const overlapsY = o.bottom > placement.top && o.top < placement.top + 56;
      expect(overlapsX && overlapsY).toBe(false);
    }
  });
});

