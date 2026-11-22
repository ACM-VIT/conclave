import { describe, expect, it } from "vitest";
import { placeNoticeLane } from "../src/app/lib/in-call-notice-lane";

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
