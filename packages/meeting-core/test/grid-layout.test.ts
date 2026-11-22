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

// The most a tile may change width when its container grows 1 px and keeps
// its row split and tile height. A row easing back from the shared width moves
// 3 px per px of miss on top of its own growth, and its landscape tiles can
// take all of it, so a step can move a tile more than base's 2 px.
const MAX_RESIZE_STEP = 16;

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

// Rows may widen or narrow a tile by up to 1.25x to line up their edges.
const expectWithinStretch = (position: { width: number; height: number }, aspect: number) => {
  const natural = Math.floor(position.height * aspect);
  expect(position.width).toBeGreaterThanOrEqual(Math.ceil(natural / 1.25));
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

  it("lines up full rows even when a shorter row below can't reach them", () => {
    const aspects = [PORTRAIT, PORTRAIT, 9 / 16, LANDSCAPE, 9 / 16, 9 / 16, LANDSCAPE, LANDSCAPE];
    const r = computeGridLayout(aspects.length, 1416, 1000, { tileAspects: aspects });

    expect(rowsOf(r)).toEqual([[0, 1, 2], [3, 4, 5], [6, 7]]);
    const [first, second, short] = rowEdges(r);
    expect(second).toEqual(first);
    expect((first.left + first.right) / 2).toBe(1416 / 2);
    // The two laptops can't narrow that far, so they ease back toward their
    // own width and centre.
    expect(short.right - short.left).toBeGreaterThan(first.right - first.left + 200);
    expect((short.left + short.right) / 2).toBe(1416 / 2);
    expectEvenGaps(r);
    r.positions.forEach((position, index) => expectWithinStretch(position, aspects[index]));
  });

  it("never narrows a tile past 1.25x when rounding to whole pixels", () => {
    const aspects = [PORTRAIT, PORTRAIT, LANDSCAPE, PORTRAIT, PORTRAIT, PORTRAIT, LANDSCAPE];
    const r = computeGridLayout(aspects.length, 768, 864, { maxCols: 6, tileAspects: aspects });

    expectAlignedEdges(r, [0, 1]);
    r.positions.forEach((position, index) => expectWithinStretch(position, aspects[index]));
  });

  it("lines up three phones over two laptops, past 4:5 when that is the only way", () => {
    const aspects = [PORTRAIT, PORTRAIT, PORTRAIT, LANDSCAPE, LANDSCAPE];
    const r = computeGridLayout(5, 960, 540, { tileAspects: aspects });

    expect(rowsOf(r)).toEqual([[0, 1, 2], [3, 4]]);
    expectAlignedEdges(r, [0, 1]);
    expectEvenGaps(r);
    r.positions.forEach((position, index) => expectWithinStretch(position, aspects[index]));
  });

  it("meets at a row's shrink floor with a fractional gap", () => {
    const aspects = [0.6, LANDSCAPE, PORTRAIT, 0.8];
    const r = computeGridLayout(4, 960, 540, { gap: 11.3, tileAspects: aspects });
    const [first, second] = rowEdges(r);

    expect(rowsOf(r)).toEqual([[0, 1], [2, 3]]);
    expect(Math.abs(second.left - first.left)).toBeLessThan(1);
    expect(Math.abs(second.right - first.right)).toBeLessThan(1);
    r.positions.forEach((position, index) => expectWithinStretch(position, aspects[index]));
  });

  it("never rounds a row past the container with a fractional gap", () => {
    const aspects = [9 / 16, 9 / 16, 9 / 16, LANDSCAPE];
    const r = computeGridLayout(4, 887.2, 1000, { gap: 0.2, tileAspects: aspects });

    r.positions.forEach((position) => {
      expect(position.x).toBeGreaterThanOrEqual(0);
      expect(position.x + position.width).toBeLessThanOrEqual(887.2);
    });
  });

  it("keeps a row inside the container when the gap is far below a pixel", () => {
    const r = computeGridLayout(3, 100, 201, {
      maxCols: 2,
      gap: 0.0000005,
      tileAspects: [0.4, 0.59, 1],
    });

    r.positions.forEach((position) => {
      expect(position.x + position.width).toBeLessThanOrEqual(100);
    });
  });

  it("meets shorter rows at the full rows' own width when only that fits them", () => {
    const aspects = [0.5, 0.5, 0.8, 1.1];
    const r = computeGridLayout(4, 110.4, 300.8, { maxCols: 2, gap: 0.4, tileAspects: aspects });
    const edges = rowEdges(r);

    expect(rowsOf(r)).toEqual([[0, 1], [2], [3]]);
    edges.forEach((edge) => {
      expect(Math.abs(edge.left - edges[0].left)).toBeLessThan(1);
      expect(Math.abs(edge.right - edges[0].right)).toBeLessThan(1);
    });
    r.positions.forEach((position, index) => expectWithinStretch(position, aspects[index]));
  });

  it.each([
    // Astra: two laptops over three phones, 1210 to 1211 px in the meeting.
    ["two laptops over three phones", [LANDSCAPE, LANDSCAPE, PORTRAIT, PORTRAIT, PORTRAIT], [1178, 668], [1179, 668], [[0, 1], [2, 3, 4]]],
    // Sol: three phones over two laptops, 813 to 814 px tall in the meeting.
    ["three phones over two laptops", [PORTRAIT, PORTRAIT, PORTRAIT, LANDSCAPE, LANDSCAPE], [1440, 781], [1440, 782], [[0, 1, 2], [3, 4]]],
  ])("keeps %s lined up and steady across a 1 px resize", (_, aspects, before, after, rows) => {
    const [narrow, wide] = [before, after].map(([w, h]) =>
      computeGridLayout(5, w, h, { tileAspects: aspects }),
    );

    [narrow, wide].forEach((r) => {
      expect(rowsOf(r)).toEqual(rows);
      const [top, bottom] = rowEdges(r);
      // Rounding leaves a few px of miss at most, split across both edges.
      expect(Math.abs(top.left - bottom.left)).toBeLessThanOrEqual(2);
      expect(Math.abs(top.right - bottom.right)).toBeLessThanOrEqual(2);
      r.positions.forEach((position, index) => expectWithinStretch(position, aspects[index]));
    });
    narrow.positions.forEach((position, index) => {
      expect(Math.abs(wide.positions[index].width - position.width)).toBeLessThanOrEqual(4);
    });
  });

  it("brings a near miss within a pixel with a fractional gap", () => {
    const aspects = [0.59, 0.4, 1.5];
    const r = computeGridLayout(3, 108.4, 73.4, { maxCols: 2, gap: 0.4, tileAspects: aspects });
    const [full, short] = rowEdges(r);

    expect(rowsOf(r)).toEqual([[0, 1], [2]]);
    expect(Math.abs(short.left - full.left)).toBeLessThan(1);
    expect(Math.abs(short.right - full.right)).toBeLessThan(1);
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

// Deterministic so a failure names a reproducible case.
const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("computeGridLayout — mixed rows, random layouts", () => {
  // The shapes the web tile policy produces: full-video portrait snaps, the
  // cropped 3:4 portrait tile, and 16:9.
  const SHAPES = [9 / 16, 3 / 5, 2 / 3, PORTRAIT, 4 / 5, LANDSCAPE];
  const GAPS = [12, 12, 12, 0, 0.2, 11.3, 12.5];
  const random = seededRandom(266);
  const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const cases = Array.from({ length: 3000 }, () => {
    const count = between(2, 16);
    const fractional = random() < 0.2;
    return {
      count,
      width: between(320, 2560) + (fractional ? random() : 0),
      height: between(240, 1440) + (fractional ? random() : 0),
      maxCols: between(2, 7),
      gap: random() < 0.1 ? Math.round(random() * 1600) / 100 : GAPS[between(0, GAPS.length - 1)],
      aspects: Array.from({ length: count }, () => SHAPES[between(0, SHAPES.length - 1)]),
    };
  });
  const layout = ({ count, width, height, maxCols, gap, aspects }: (typeof cases)[number]) =>
    computeGridLayout(count, width, height, { maxCols, gap, tileAspects: aspects });
  // With a fractional gap, rows of different lengths can't all land on whole
  // pixels, so their edges may differ by less than a pixel.
  const edgeSlack = (gap: number) => (Number.isInteger(gap) ? 0 : 1);

  it("keeps every tile inside the caps, the gaps and the container", () => {
    const failures: string[] = [];
    cases.forEach((c) => {
      const r = layout(c);
      const fail = (what: string) => failures.push(`${what} ${JSON.stringify(c)}`);
      if (r.positions.length !== c.count) fail("tile count");
      rowsOf(r).forEach((row) => {
        row.slice(1).forEach((index) => {
          const left = r.positions[index - 1];
          if (Math.abs(r.positions[index].x - (left.x + left.width) - c.gap) > 1e-6) fail("gap");
        });
      });
      r.positions.forEach((position, index) => {
        const natural = Math.floor(position.height * c.aspects[index]);
        if (!Number.isInteger(position.width)) fail("fractional width");
        if (position.height !== r.tileHeight) fail("height");
        if (position.width < Math.ceil(natural / 1.25)) fail("past the shrink cap");
        if (position.width > Math.floor(natural * 1.25)) fail("past the stretch cap");
        if (position.x < 0 || position.x + position.width > c.width + 1e-9) fail("x overflow");
        if (position.y + position.height > c.height + 1e-9) fail("y overflow");
      });
    });
    expect(failures).toEqual([]);
  });

  // The widths a row can span with every tile inside the 1.25x caps.
  const rowRange = (r: ReturnType<typeof computeGridLayout>, row: number[], c: (typeof cases)[number]) => {
    const span = (scale: (natural: number) => number) =>
      row.reduce(
        (total, index) => total + scale(Math.floor(r.tileHeight * c.aspects[index])),
        (row.length - 1) * c.gap,
      );
    return {
      natural: span((natural) => natural),
      low: span((natural) => Math.ceil(natural / 1.25)),
      high: span((natural) => Math.floor(natural * 1.25)),
    };
  };
  const expectRowsMeet = (
    r: ReturnType<typeof computeGridLayout>,
    rows: number[],
    c: (typeof cases)[number],
  ) => {
    const edges = rowEdges(r);
    rows.forEach((row) => {
      const label = JSON.stringify(c);
      expect(Math.abs(edges[row].left - edges[rows[0]].left), label).toBeLessThanOrEqual(
        edgeSlack(c.gap) + 1e-9,
      );
      expect(Math.abs(edges[row].right - edges[rows[0]].right), label).toBeLessThanOrEqual(
        edgeSlack(c.gap) + 1e-9,
      );
    });
  };
  const canMeet = (ranges: { low: number; high: number }[]) =>
    Math.max(...ranges.map((range) => range.low)) <=
    Math.min(...ranges.map((range) => range.high)) + 1e-9;

  it("lines up every full row whenever the caps allow one shared width", () => {
    let checked = 0;
    cases.forEach((c) => {
      const r = layout(c);
      const rows = rowsOf(r);
      const full = rows.flatMap((row, index) => (row.length === r.cols ? [index] : []));
      if (full.length < 2 || !canMeet(full.map((index) => rowRange(r, rows[index], c)))) return;
      checked += 1;
      expectRowsMeet(r, full, c);
    });
    expect(checked).toBeGreaterThan(500);
  });

  it("lines up a shorter row whenever it can meet the full rows without narrowing them", () => {
    let checked = 0;
    cases.forEach((c) => {
      const r = layout(c);
      const rows = rowsOf(r);
      if (rows.length < 2 || rows.every((row) => row.length === r.cols)) return;
      // A shorter row may widen the full rows to meet it, never narrow them.
      const fullNatural = Math.max(
        ...rows
          .filter((row) => row.length === r.cols)
          .map((row) => rowRange(r, row, c).natural),
      );
      const ranges = rows.map((row) => rowRange(r, row, c));
      if (!canMeet([...ranges, { low: fullNatural, high: Number.POSITIVE_INFINITY }])) return;
      checked += 1;
      expectRowsMeet(
        r,
        rows.map((_, index) => index),
        c,
      );
    });
    expect(checked).toBeGreaterThan(200);
  });

  it("changes no tile by more than a few px when the container grows 1 px", () => {
    // A new row split or tile height reshapes the grid at base too, so this
    // compares neighbouring widths that keep both, at the web grid's 12 px gap.
    const sweep = seededRandom(1211);
    const pick = (min: number, max: number) => min + Math.floor(sweep() * (max - min + 1));
    let compared = 0;
    const jumps: string[] = [];
    for (let run = 0; run < 1500; run += 1) {
      const count = pick(2, 12);
      const start = pick(400, 2400);
      const height = pick(300, 1400);
      const maxCols = pick(2, 7);
      const aspects = Array.from({ length: count }, () => SHAPES[pick(0, SHAPES.length - 1)]);
      const at = (width: number) =>
        computeGridLayout(count, width, height, { maxCols, tileAspects: aspects });
      let previous = at(start);
      for (let width = start + 1; width <= start + 40; width += 1) {
        const next = at(width);
        const sameShape =
          next.positions.every((position, index) => position.row === previous.positions[index].row) &&
          Math.abs(next.tileHeight - previous.tileHeight) <= 1;
        if (sameShape) {
          compared += 1;
          const step = Math.max(
            ...next.positions.map((position, index) =>
              Math.abs(position.width - previous.positions[index].width),
            ),
          );
          if (step > MAX_RESIZE_STEP) {
            jumps.push(`${step} px at ${JSON.stringify({ width, height, maxCols, aspects })}`);
          }
        }
        previous = next;
      }
    }
    expect(jumps).toEqual([]);
    expect(compared).toBeGreaterThan(40000);
  }, 30_000);

  it("lays out all-16:9 pages exactly as the uniform grid", () => {
    cases.forEach(({ count, width, height, maxCols, gap }) => {
      expect(
        computeGridLayout(count, width, height, {
          maxCols,
          gap,
          tileAspects: Array.from({ length: count }, () => LANDSCAPE),
        }),
      ).toEqual(computeGridLayout(count, width, height, { maxCols, gap }));
    });
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
