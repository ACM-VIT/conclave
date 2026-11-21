import { describe, expect, it } from "vitest";
import {
  chooseStageMode,
  computeGridLayout,
  computeStageRailLayout,
  type StageModeInput,
} from "../src/grid-layout";

describe("computeGridLayout — packing", () => {
  it("uses a single column for one tile", () => {
    const r = computeGridLayout(1, 1920, 1080);
    expect(r.cols).toBe(1);
    expect(r.rows).toBe(1);
    expect(r.tileWidth).toBeGreaterThan(0);
    expect(r.tileHeight).toBeGreaterThan(0);
  });

  it("places two tiles side-by-side in a landscape container", () => {
    const r = computeGridLayout(2, 1920, 1080);
    expect(r.cols).toBe(2);
    expect(r.rows).toBe(1);
  });

  it("keeps tiles aspect-locked to the target ratio (16:9)", () => {
    const r = computeGridLayout(4, 1600, 900);
    const ratio = r.tileWidth / r.tileHeight;
    expect(ratio).toBeGreaterThan(1.7);
    expect(ratio).toBeLessThan(1.85);
  });

  it("builds a balanced grid for four tiles in a square container", () => {
    const r = computeGridLayout(4, 1000, 1000);
    expect(r.cols).toBe(2);
    expect(r.rows).toBe(2);
    expect(r.lastRowCount).toBe(2);
  });

  it("reports a partial last row", () => {
    // 5 tiles, 3 cols → rows = 2, last row has 2.
    const r = computeGridLayout(5, 1800, 700, { maxCols: 3 });
    expect(r.cols).toBe(3);
    expect(r.rows).toBe(2);
    expect(r.lastRowCount).toBe(2);
  });

  it("returns centered x/y positions for partial rows", () => {
    const r = computeGridLayout(5, 1800, 700, { maxCols: 3 });
    const firstRow = r.positions.slice(0, 3);
    const lastRow = r.positions.slice(3);

    expect(r.positions).toHaveLength(5);
    expect(firstRow.map((position) => position.row)).toEqual([0, 0, 0]);
    expect(lastRow.map((position) => position.row)).toEqual([1, 1]);
    expect(lastRow[0].x).toBeCloseTo(
      firstRow[0].x + (r.tileWidth + 12) / 2,
    );
    expect(lastRow[1].x).toBeCloseTo(
      firstRow[1].x + (r.tileWidth + 12) / 2,
    );
    expect(lastRow[0].y).toBeCloseTo(firstRow[0].y + r.tileHeight + 12);
    expect(r.contentWidth).toBeCloseTo(r.cols * r.tileWidth + 2 * 12);
    expect(r.contentHeight).toBeCloseTo(r.rows * r.tileHeight + 12);
  });

  it("centers the whole tile group inside the measured area", () => {
    const r = computeGridLayout(2, 1920, 1080);

    expect(r.offsetX).toBeCloseTo(
      (1920 - (2 * r.tileWidth + 12)) / 2,
    );
    expect(r.offsetY).toBeCloseTo((1080 - r.tileHeight) / 2);
    expect(r.positions[0].x).toBeCloseTo(r.offsetX);
    expect(r.positions[0].y).toBeCloseTo(r.offsetY);
  });

  it("never reports a lastRowCount below 1", () => {
    const r = computeGridLayout(3, 1200, 800, { maxCols: 3 });
    expect(r.lastRowCount).toBeGreaterThanOrEqual(1);
  });

  it("respects the maxCols cap", () => {
    const r = computeGridLayout(20, 4000, 400, { maxCols: 4 });
    expect(r.cols).toBeLessThanOrEqual(4);
  });
});

describe("computeGridLayout — paging", () => {
  it("reports a single page below the per-page cap", () => {
    const r = computeGridLayout(10, 1920, 1080, { maxTilesPerPage: 49 });
    expect(r.pages).toBe(1);
    expect(r.perPage).toBe(10);
  });

  it("splits into multiple pages above the cap", () => {
    const r = computeGridLayout(60, 1920, 1080, { maxTilesPerPage: 49 });
    expect(r.pages).toBe(2);
    expect(r.perPage).toBe(49);
  });
});

describe("computeGridLayout — degenerate inputs", () => {
  it("floors counts and treats <1 as a single tile", () => {
    const r = computeGridLayout(0, 1920, 1080);
    expect(r.perPage).toBe(1);
    expect(r.cols).toBe(1);
  });

  it("returns a zero-size single column for a zero-area container", () => {
    const r = computeGridLayout(4, 0, 0);
    expect(r.cols).toBe(1);
    expect(r.tileWidth).toBe(0);
    expect(r.tileHeight).toBe(0);
    expect(r.rows).toBe(4);
    expect(r.positions).toHaveLength(4);
    expect(r.positions.every((position) => position.width === 0)).toBe(true);
  });

  it("returns a single column for a non-finite container", () => {
    const r = computeGridLayout(4, Number.NaN, 1080);
    expect(r.cols).toBe(1);
    expect(r.tileWidth).toBe(0);
  });

  it("floors a fractional count", () => {
    const r = computeGridLayout(3.9, 1920, 1080);
    expect(r.perPage).toBe(3);
  });
});

const PORTRAIT = 3 / 4;
const LANDSCAPE = 16 / 9;

const rowsOf = (r: ReturnType<typeof computeGridLayout>) =>
  r.positions.reduce<number[][]>((rows, position) => {
    (rows[position.row] ??= []).push(position.index);
    return rows;
  }, []);

const rowEdges = (r: ReturnType<typeof computeGridLayout>) =>
  rowsOf(r).map((row) => {
    const first = r.positions[row[0]];
    const last = r.positions[row[row.length - 1]];
    return { left: first.x, right: last.x + last.width };
  });

const expectAlignedEdges = (
  r: ReturnType<typeof computeGridLayout>,
  rows: number[],
) => {
  const edges = rowEdges(r);
  rows.forEach((row) => {
    expect(edges[row]).toEqual(edges[rows[0]]);
  });
  expect(edges[rows[0]].right - edges[rows[0]].left).toBe(r.contentWidth);
};

// Rows may widen or narrow a tile by up to 1.25x, in whole pixels, to line up
// their edges.
const expectWithinStretch = (position: { width: number; height: number }, aspect: number) => {
  const natural = Math.floor(position.height * aspect);
  expect(position.width).toBeGreaterThanOrEqual(Math.floor(natural / 1.25));
  expect(position.width).toBeLessThanOrEqual(Math.floor(natural * 1.25));
};

const expectEvenGaps = (r: ReturnType<typeof computeGridLayout>) => {
  rowsOf(r).forEach((row) => {
    row.slice(1).forEach((index) => {
      const left = r.positions[index - 1];
      expect(r.positions[index].x - (left.x + left.width)).toBe(12);
    });
  });
  r.positions.forEach((position) => {
    expect(Number.isInteger(position.width)).toBe(true);
    expect(Number.isInteger(position.height)).toBe(true);
  });
};

describe("computeGridLayout — mixed tile aspects", () => {
  it("puts a portrait and a landscape tile in one row at one height", () => {
    const r = computeGridLayout(2, 1280, 720, {
      tileAspects: [PORTRAIT, LANDSCAPE],
    });
    const [portrait, landscape] = r.positions;

    expect(r.rows).toBe(1);
    expect(portrait.height).toBe(landscape.height);
    expect(portrait.width).toBeLessThan(landscape.width);
    expect(portrait.width / portrait.height).toBeCloseTo(PORTRAIT, 2);
    expect(landscape.width / landscape.height).toBeCloseTo(LANDSCAPE, 2);
    // The narrow tile frees width, so both tiles grow past the uniform grid.
    expect(portrait.height).toBeGreaterThan(computeGridLayout(2, 1280, 720).tileHeight);
    expect(portrait.width + 12 + landscape.width).toBeLessThanOrEqual(1280);
  });

  it.each([
    [2, 1920, 1080, {}],
    [5, 1800, 700, { maxCols: 3 }],
    [9, 1280, 720, {}],
    [16, 1440, 800, { maxCols: 6 }],
  ])("lays out %i landscape tiles exactly as the uniform grid", (count, w, h, opts) => {
    expect(
      computeGridLayout(count, w, h, {
        ...opts,
        tileAspects: Array.from({ length: count }, () => LANDSCAPE),
      }),
    ).toEqual(computeGridLayout(count, w, h, opts));
  });

  it("keeps every tile's row and height when a phone turns portrait", () => {
    const before = computeGridLayout(4, 1920, 1080, {
      tileAspects: [PORTRAIT, LANDSCAPE, LANDSCAPE, LANDSCAPE],
    });
    const after = computeGridLayout(4, 1920, 1080, {
      tileAspects: [PORTRAIT, LANDSCAPE, LANDSCAPE, PORTRAIT],
    });

    expect(rowsOf(before)).toEqual([[0, 1], [2, 3]]);
    expect(rowsOf(after)).toEqual([[0, 1], [2, 3]]);
    expect(after.tileHeight).toBe(before.tileHeight);
    expect(after.positions[3].width).toBeLessThan(before.positions[3].width);
    expectAlignedEdges(after, [0, 1]);
  });

  it("never puts more than maxCols tiles in a row", () => {
    // Uncapped, the five narrow tiles would share one row.
    const r = computeGridLayout(6, 4000, 400, {
      maxCols: 3,
      tileAspects: [LANDSCAPE, PORTRAIT, PORTRAIT, PORTRAIT, PORTRAIT, PORTRAIT],
    });

    expect(r.positions).toHaveLength(6);
    expect(rowsOf(r).map((row) => row.length)).toEqual([3, 3]);
    expect(r.cols).toBe(3);
  });

  it("puts a partial row last, like the uniform grid", () => {
    const r = computeGridLayout(5, 1000, 900, {
      maxCols: 3,
      tileAspects: Array.from({ length: 5 }, () => PORTRAIT),
    });

    expect(rowsOf(r)).toEqual([[0, 1, 2], [3, 4]]);
    expect(r.lastRowCount).toBe(2);
  });

  it("keeps the given order in reading order with even gaps", () => {
    const aspects = [LANDSCAPE, PORTRAIT, LANDSCAPE, 9 / 16, PORTRAIT, LANDSCAPE];
    const r = computeGridLayout(aspects.length, 1440, 860, { tileAspects: aspects });
    const reading = [...r.positions].sort((a, b) => a.y - b.y || a.x - b.x);

    expect(reading.map((position) => position.index)).toEqual([0, 1, 2, 3, 4, 5]);
    r.positions.forEach((position, index) => {
      expect(position.index).toBe(index);
      expectWithinStretch(position, aspects[index]);
    });
    rowsOf(r).forEach((row) => {
      row.slice(1).forEach((index) => {
        const left = r.positions[index - 1];
        expect(r.positions[index].x - (left.x + left.width)).toBeCloseTo(12);
      });
    });
    expect(new Set(r.positions.map((position) => position.height)).size).toBe(1);
  });

  it("still returns a position for every tile in a degenerate container", () => {
    const aspects = [PORTRAIT, LANDSCAPE, PORTRAIT];
    expect(computeGridLayout(3, 0, 0, { tileAspects: aspects }).positions).toHaveLength(3);
    expect(
      computeGridLayout(3, Number.NaN, 720, { tileAspects: aspects }).positions,
    ).toHaveLength(3);
    expect(computeGridLayout(3, 20, 20, { tileAspects: aspects }).positions).toHaveLength(3);
  });

  it("treats missing and invalid aspects as the target aspect", () => {
    expect(
      computeGridLayout(3, 1280, 720, { tileAspects: [Number.NaN, -1] }),
    ).toEqual(computeGridLayout(3, 1280, 720));
  });
});

describe("computeGridLayout — mixed rows line up", () => {
  it("lines up 2 portrait and 3 landscape tiles, growing landscape tiles first", () => {
    const aspects = [PORTRAIT, LANDSCAPE, PORTRAIT, LANDSCAPE, LANDSCAPE];
    const r = computeGridLayout(5, 1416, 780, { tileAspects: aspects });

    expect(rowsOf(r)).toEqual([[0, 1, 2], [3, 4]]);
    expectAlignedEdges(r, [0, 1]);
    expectEvenGaps(r);
    expect(new Set(r.positions.map((position) => position.height)).size).toBe(1);
    // The two-laptop row sets the width and keeps its 16:9 tiles.
    expect(r.positions[3].width).toBe(Math.floor(r.tileHeight * LANDSCAPE));
    // Phones widen no further than 4:5, so the laptop takes the rest.
    const [phone, laptop] = r.positions;
    expect(phone.width).toBeGreaterThan(Math.floor(phone.height * PORTRAIT));
    expect(phone.width).toBeLessThanOrEqual(Math.floor(phone.height * 0.8));
    expect(laptop.width / Math.floor(laptop.height * LANDSCAPE)).toBeGreaterThan(
      phone.width / Math.floor(phone.height * PORTRAIT),
    );
    r.positions.forEach((position, index) => expectWithinStretch(position, aspects[index]));
  });

  it("lines up 1 portrait and 3 landscape tiles", () => {
    const aspects = [PORTRAIT, LANDSCAPE, LANDSCAPE, LANDSCAPE];
    const r = computeGridLayout(4, 1416, 780, { tileAspects: aspects });

    expect(rowsOf(r)).toEqual([[0, 1], [2, 3]]);
    expectAlignedEdges(r, [0, 1]);
    expectEvenGaps(r);
    expect(r.offsetX).toBe((1416 - r.contentWidth) / 2);
    expect(r.positions[0].width).toBeLessThanOrEqual(Math.floor(r.tileHeight * 0.8));
    r.positions.forEach((position, index) => expectWithinStretch(position, aspects[index]));
  });

  it.each([
    // Two phones reach the square row only past 4:5.
    [1025, 467, [PORTRAIT, PORTRAIT, 1, 1]],
    // A sliver of a tile narrows without dropping below its floor.
    [458, 498, [1.5, 0.1, PORTRAIT, 0.4]],
  ])("lines up two full rows in %ix%i within the 1.25x cap", (w, h, aspects) => {
    const r = computeGridLayout(4, w, h, { maxCols: 2, tileAspects: aspects });

    expect(rowsOf(r)).toEqual([[0, 1], [2, 3]]);
    expectAlignedEdges(r, [0, 1]);
    expectEvenGaps(r);
    r.positions.forEach((position, index) => expectWithinStretch(position, aspects[index]));
  });

  it.each([
    ["a lone last tile", [PORTRAIT, LANDSCAPE, LANDSCAPE], [[0, 1], [2]]],
    [
      "two tiles under four",
      [PORTRAIT, LANDSCAPE, PORTRAIT, LANDSCAPE, LANDSCAPE, LANDSCAPE],
      [[0, 1, 2, 3], [4, 5]],
    ],
  ])("centres %s at its own width when the cap can't stretch it", (_, aspects, rows) => {
    const r = computeGridLayout(aspects.length, 1416, 780, { tileAspects: aspects });

    expect(rowsOf(r)).toEqual(rows);
    const lastRow = rows[rows.length - 1];
    lastRow.forEach((index) => {
      expect(r.positions[index].width).toBe(Math.floor(r.tileHeight * aspects[index]));
    });
    // The full row above keeps its own tiles too.
    rows[0].forEach((index) => {
      expect(r.positions[index].width).toBe(Math.floor(r.tileHeight * aspects[index]));
    });
    const edges = rowEdges(r);
    const last = edges[edges.length - 1];
    expect((last.left + last.right) / 2).toBeCloseTo(1416 / 2);
    expect(last.right - last.left).toBeLessThan(r.contentWidth);
    expectEvenGaps(r);
  });
});

describe("chooseStageMode", () => {
  const input = (overrides: Partial<StageModeInput> = {}): StageModeInput => ({
    count: 5,
    presenting: false,
    pinned: false,
    hasActiveVideoSpeaker: false,
    ...overrides,
  });

  it("spotlights a pinned tile regardless of count", () => {
    expect(chooseStageMode(input({ pinned: true, count: 20 }))).toBe("spotlight");
  });

  it("spotlights when two or fewer participants", () => {
    expect(chooseStageMode(input({ count: 2 }))).toBe("spotlight");
    expect(chooseStageMode(input({ count: 1 }))).toBe("spotlight");
  });

  it("spotlights a presentation with no active video speaker", () => {
    expect(
      chooseStageMode(input({ presenting: true, hasActiveVideoSpeaker: false })),
    ).toBe("spotlight");
  });

  it("uses side-by-side when presenting with an active video speaker", () => {
    expect(
      chooseStageMode(input({ presenting: true, hasActiveVideoSpeaker: true })),
    ).toBe("sideBySide");
  });

  it("tiles a mid-size meeting", () => {
    expect(chooseStageMode(input({ count: 8 }))).toBe("tiled");
  });

  it("switches to the sidebar above the tiled threshold", () => {
    expect(chooseStageMode(input({ count: 13 }))).toBe("sidebar");
  });

  it("honors a custom tiled threshold", () => {
    expect(chooseStageMode(input({ count: 5, tiledThreshold: 4 }))).toBe(
      "sidebar",
    );
  });
});

describe("computeStageRailLayout", () => {
  it("caps remote rail videos to measured visible slots", () => {
    const r = computeStageRailLayout({
      candidateCount: 10,
      fixedTileCount: 1,
      maxTiles: 8,
      railHeight: 608,
      tileHeight: 112,
      gap: 12,
    });

    expect(r.slotCount).toBe(5);
    expect(r.remoteCapacity).toBe(3);
    expect(r.overflowTile).toBe(true);
    expect(r.hiddenCount).toBe(7);
    expect(r.renderedTileCount).toBe(5);
  });

  it("does not reserve overflow when every candidate fits", () => {
    const r = computeStageRailLayout({
      candidateCount: 2,
      fixedTileCount: 1,
      maxTiles: 8,
      railHeight: 608,
      tileHeight: 112,
      gap: 12,
    });

    expect(r.slotCount).toBe(5);
    expect(r.remoteCapacity).toBe(2);
    expect(r.overflowTile).toBe(false);
    expect(r.hiddenCount).toBe(0);
    expect(r.renderedTileCount).toBe(3);
  });

  it("honors the user tile budget even when the rail has more physical space", () => {
    const r = computeStageRailLayout({
      candidateCount: 8,
      fixedTileCount: 1,
      maxTiles: 4,
      railHeight: 1200,
      tileHeight: 112,
      gap: 12,
    });

    expect(r.slotCount).toBeGreaterThan(4);
    expect(r.remoteCapacity).toBe(2);
    expect(r.overflowTile).toBe(true);
    expect(r.renderedTileCount).toBe(4);
  });

  it("keeps fixed tiles and hides remotes when no remote slot is available", () => {
    const r = computeStageRailLayout({
      candidateCount: 3,
      fixedTileCount: 2,
      maxTiles: 2,
      railHeight: 256,
      tileHeight: 112,
      gap: 12,
    });

    expect(r.slotCount).toBe(2);
    expect(r.remoteCapacity).toBe(0);
    expect(r.overflowTile).toBe(false);
    expect(r.hiddenCount).toBe(3);
    expect(r.renderedTileCount).toBe(2);
  });
});
