/**
 * Google-Meet-style participant grid arrangement — shared, pure, dependency-free.
 *
 * This is the client-side "tiled / auto" layout engine: given a visible tile
 * count, a measured container, and a target tile aspect ratio, it finds the
 * column/row arrangement that MAXIMISES tile size (the canonical optimal-grid
 * packing that Meet/Jitsi/Daily all use), then reports last-row centering and
 * paging so the renderer can lay it out exactly like Meet.
 *
 * The web client imports this directly; the Skip/SwiftUI app mirrors it in
 * Swift (GridLayout.swift) and verifies the same behavior in native tests.
 */

export interface GridLayoutOptions {
  /** Gap between tiles in px. Subtracted from the container before dividing. */
  gap?: number;
  /** Hard cap on columns (device class: ~6–7 desktop, 2–3 narrow phone). */
  maxCols?: number;
  /** Tiles shown per page before paging/overflow kicks in. */
  maxTilesPerPage?: number;
  /** Target tile aspect ratio = width / height (16:9 = 1.7778 landscape). */
  targetAspect?: number;
  /**
   * Width / height of each tile on the page, in order. When any tile differs
   * from `targetAspect`, the page packs into justified rows: every tile shares
   * one height, and rows widen their tiles up to 1.25x so they line up with the
   * widest row. Missing or invalid entries count as
   * `targetAspect`.
   */
  tileAspects?: readonly number[];
}

export interface GridTilePosition {
  /** Zero-based tile order on the current page. */
  index: number;
  /** Zero-based visual row. */
  row: number;
  /** Zero-based visual column within the logical grid. Partial rows may be fractional. */
  col: number;
  /** Left offset inside the measured layout area, in px. */
  x: number;
  /** Top offset inside the measured layout area, in px. */
  y: number;
  /** Tile width in px. */
  width: number;
  /** Tile height in px. */
  height: number;
}

export interface GridLayoutResult {
  /** Columns and rows for a full page. */
  cols: number;
  rows: number;
  /**
   * Size of a `targetAspect` tile in px. With `tileAspects`, tiles share this
   * height but not this width, so read each tile's size from `positions`.
   */
  tileWidth: number;
  tileHeight: number;
  /** Tiles in the final (possibly partial) row — render centered. */
  lastRowCount: number;
  /** Number of pages when count exceeds maxTilesPerPage. */
  pages: number;
  /** Tiles laid out on a full page (<= maxTilesPerPage). */
  perPage: number;
  /** Width of the centered tile group, in px. */
  contentWidth: number;
  /** Height of the centered tile group, in px. */
  contentHeight: number;
  /** Left offset of the centered tile group inside the measured layout area. */
  offsetX: number;
  /** Top offset of the centered tile group inside the measured layout area. */
  offsetY: number;
  /** Exact tile positions for the current page, including centered partial rows. */
  positions: GridTilePosition[];
}

const DEFAULTS: Required<Omit<GridLayoutOptions, "tileAspects">> = {
  gap: 12,
  maxCols: 7,
  maxTilesPerPage: 49,
  targetAspect: 16 / 9,
};

const buildGridTilePositions = ({
  cols,
  rows,
  perPage,
  tileWidth,
  tileHeight,
  gap,
  width,
  height,
}: {
  cols: number;
  rows: number;
  perPage: number;
  tileWidth: number;
  tileHeight: number;
  gap: number;
  width: number;
  height: number;
}) => {
  const contentWidth = Math.max(0, cols * tileWidth + Math.max(0, cols - 1) * gap);
  const contentHeight = Math.max(0, rows * tileHeight + Math.max(0, rows - 1) * gap);
  const offsetX = Math.max(0, (width - contentWidth) / 2);
  const offsetY = Math.max(0, (height - contentHeight) / 2);
  const positions: GridTilePosition[] = [];

  for (let index = 0; index < perPage; index += 1) {
    const row = Math.floor(index / cols);
    const rowStartIndex = row * cols;
    const rowCount = Math.min(cols, perPage - rowStartIndex);
    const rowWidth = rowCount * tileWidth + Math.max(0, rowCount - 1) * gap;
    const rowOffsetX = offsetX + Math.max(0, (contentWidth - rowWidth) / 2);
    const col = index - rowStartIndex;

    positions.push({
      index,
      row,
      col: col + Math.max(0, cols - rowCount) / 2,
      x: rowOffsetX + col * (tileWidth + gap),
      y: offsetY + row * (tileHeight + gap),
      width: tileWidth,
      height: tileHeight,
    });
  }

  return {
    contentWidth,
    contentHeight,
    offsetX,
    offsetY,
    positions,
  };
};

const ASPECT_EPSILON = 1e-6;

const readTileAspects = (
  tileAspects: readonly number[] | undefined,
  perPage: number,
  targetAspect: number,
): number[] | null => {
  if (!tileAspects) return null;
  const aspects = Array.from({ length: perPage }, (_, index) => {
    const aspect = tileAspects[index];
    return aspect !== undefined && Number.isFinite(aspect) && aspect > 0
      ? aspect
      : targetAspect;
  });
  return aspects.some((aspect) => Math.abs(aspect - targetAspect) > ASPECT_EPSILON)
    ? aspects
    : null;
};

const MAX_ROW_STRETCH = 1.25;
const PORTRAIT_STRETCH_ASPECT = 4 / 5;

const sum = (values: readonly number[]) =>
  values.reduce((total, value) => total + value, 0);

const rowWidthOf = (widths: readonly number[], gap: number) =>
  sum(widths) + (widths.length - 1) * gap;

/** Floor each size, then give the pixels left over to the largest remainders. */
const roundToTotal = (sizes: number[], total: number) => {
  const floored = sizes.map(Math.floor);
  sizes
    .map((size, index) => ({ index, remainder: size - floored[index] }))
    .sort((a, b) => b.remainder - a.remainder)
    .slice(0, Math.round(total - sum(floored)))
    .forEach(({ index }) => {
      floored[index] += 1;
    });
  return floored;
};

/**
 * How far each tile may resize, in whole pixels, from its unrounded width
 * `exact`: `floor` and `hard` are the 1.25x caps either way, and `soft` holds
 * portrait tiles at 4:5, since a portrait tile crops a face sooner.
 */
const resizeLimits = (exact: number[], height: number) => {
  const floor = exact.map((width) => Math.ceil(width / MAX_ROW_STRETCH));
  const hard = exact.map((width) => Math.floor(width * MAX_ROW_STRETCH));
  const soft = exact.map((width, index) =>
    width < height
      ? Math.min(
          hard[index],
          Math.max(Math.floor(width), Math.floor(height * PORTRAIT_STRETCH_ASPECT)),
        )
      : hard[index],
  );
  return { floor, soft, hard };
};

/**
 * Move `sizes` by `amount` px in total, each tile in proportion to its natural
 * width, until it reaches its limit. Returns the px no tile could take.
 */
const fillToward = (widths: number[], sizes: number[], limits: number[], amount: number) => {
  const direction = Math.sign(amount);
  const room = (index: number) => (limits[index] - sizes[index]) * direction;
  let left = Math.abs(amount);
  let open = sizes.flatMap((_, index) => (room(index) > ASPECT_EPSILON ? [index] : []));
  while (left > ASPECT_EPSILON && open.length > 0) {
    const base = sum(open.map((index) => widths[index]));
    const step = Math.min(left / base, ...open.map((index) => room(index) / widths[index]));
    open.forEach((index) => {
      sizes[index] += direction * widths[index] * step;
      // Land exactly on a limit, so rounding can never cross it.
      if (room(index) <= ASPECT_EPSILON) sizes[index] = limits[index];
    });
    left -= base * step;
    open = open.filter((index) => room(index) > ASPECT_EPSILON);
  }
  return direction * left;
};

/**
 * The whole pixels `count` tiles can share in a row no wider than `rowWidth`.
 * Float error can leave `rowWidth - gaps` a hair under the integer it came
 * from, so that integer is accepted when it still fits.
 */
const tileBudget = (count: number, gap: number, rowWidth: number) => {
  const gaps = (count - 1) * gap;
  const budget = Math.floor(rowWidth - gaps);
  return budget + 1 + gaps <= rowWidth ? budget + 1 : budget;
};

/**
 * Resize a row's tiles so the row spans `rowWidth` at most, to the whole pixel
 * below when the gap is fractional. Tiles grow to their soft caps before their
 * hard caps, and shrink no further than their floors. Returns null when the
 * caps cannot reach `rowWidth`.
 */
const resizeRow = (
  widths: number[],
  { floor, soft, hard }: ReturnType<typeof resizeLimits>,
  gap: number,
  rowWidth: number,
) => {
  const total = tileBudget(widths.length, gap, rowWidth);
  if (total < sum(floor) || total > sum(hard)) return null;
  const sizes = [...widths];
  if (total < sum(widths)) {
    fillToward(widths, sizes, floor, total - sum(widths));
  } else {
    fillToward(widths, sizes, hard, fillToward(widths, sizes, soft, total - sum(widths)));
  }
  return roundToTotal(sizes, total);
};

// A row that misses the shared width by this much or less stays at its
// nearest legal width: 4 px at each edge, a third of the 12 px gap.
const ROW_MISS_TOLERANCE = 8;
// Past that, a row eases back to its own width this many px for every px it
// misses by, so a near miss stays nearly aligned and a far one sits at its own
// width.
const ROW_EASE_RATE = 3;

/**
 * Resize each row's tiles so the rows share one width and the grid's edges
 * line up, moving smoothly as the container resizes.
 *
 * Every width here is unrounded, `height * aspect` and its 1.25x caps, so it
 * moves in proportion to the tile height and the ease never multiplies a
 * pixel that rounding added or took away. Only the final widths go to whole
 * pixels: rows that met share one pixel width inside all their caps, and any
 * other row keeps its offset from its own whole-pixel width.
 *
 * The shared width minimises a convex cost: 1 per px from the full rows'
 * preferred width (nearest the widest row, portrait tiles held at 4:5), 4 per
 * px outside each shorter row's legal range, and, outweighing all of those,
 * the largest miss among the full rows, so full rows that can't quite meet
 * share the miss. Every slope is odd, so the minimum is one point that moves
 * continuously with the rows. It never falls below the full rows' own width,
 * so a shorter row can widen them, and take phones past 4:5, but never narrow
 * them.
 *
 * A row that can't reach the shared width takes its nearest legal width.
 * Past the tolerance, it eases back to its own width, so a lone last tile
 * centres at its own width.
 */
const alignRows = (rowAspects: number[][], height: number, gap: number, cols: number) => {
  const rows = rowAspects.map((aspects) => {
    const exact = aspects.map((aspect) => height * aspect);
    const tiles = exact.map(Math.floor);
    const limits = resizeLimits(exact, height);
    return {
      tiles,
      limits,
      full: aspects.length === cols,
      natural: rowWidthOf(exact, gap),
      rounding: sum(exact) - sum(tiles),
      low: rowWidthOf(exact.map((width) => width / MAX_ROW_STRETCH), gap),
      soft: rowWidthOf(
        exact.map((width) =>
          width < height
            ? Math.min(width * MAX_ROW_STRETCH, Math.max(width, height * PORTRAIT_STRETCH_ASPECT))
            : width * MAX_ROW_STRETCH,
        ),
        gap,
      ),
      high: rowWidthOf(exact.map((width) => width * MAX_ROW_STRETCH), gap),
      pixelLow: rowWidthOf(limits.floor, gap),
      pixelHigh: rowWidthOf(limits.hard, gap),
    };
  });
  const fullRows = rows.filter((row) => row.full);
  const widest = Math.max(...rows.map((row) => row.natural));
  const preferred = Math.min(
    Math.max(
      Math.min(widest, ...fullRows.map((row) => row.soft)),
      Math.max(...fullRows.map((row) => row.low)),
    ),
    Math.min(...fullRows.map((row) => row.high)),
  );
  const floor = Math.min(preferred, Math.max(...fullRows.map((row) => row.natural)));
  const fullWeight = 4 * (rows.length - fullRows.length) + 2;
  const miss = (row: (typeof rows)[number], width: number) =>
    Math.max(row.low - width, 0, width - row.high);
  const cost = (width: number) =>
    rows.reduce(
      (total, row) => (row.full ? total : total + 4 * miss(row, width)),
      Math.abs(width - preferred) +
        fullWeight * Math.max(...fullRows.map((row) => miss(row, width))),
    );
  const target = [
    ...rows.flatMap((row) => [row.low, row.high]),
    ...fullRows.flatMap((wide) => fullRows.map((narrow) => (wide.low + narrow.high) / 2)),
  ]
    .map((width) => Math.max(width, floor))
    .reduce((best, width) => (cost(width) < cost(best) ? width : best), preferred);

  const widths = rows.map((row) => {
    const nearest = Math.min(Math.max(target, row.low), row.high);
    const ease = Math.max(0, miss(row, target) - ROW_MISS_TOLERANCE) * ROW_EASE_RATE;
    return nearest > row.natural
      ? Math.max(row.natural, nearest - ease)
      : Math.min(row.natural, nearest + ease);
  });
  const met = rows.filter((_, index) => Math.abs(widths[index] - target) <= ASPECT_EPSILON);
  const metLow = Math.max(...met.map((row) => row.pixelLow));
  const metHigh = Math.min(...met.map((row) => row.pixelHigh));
  const metWidth = Math.min(
    Math.max(target - Math.max(...met.map((row) => row.rounding)), metLow),
    metHigh,
  );
  return rows.map((row, index) => {
    const pixelWidth =
      met.includes(row) && metLow <= metHigh
        ? metWidth
        : Math.min(Math.max(widths[index] - row.rounding, row.pixelLow), row.pixelHigh);
    return resizeRow(row.tiles, row.limits, gap, pixelWidth) ?? row.tiles;
  });
};

/**
 * Pack tiles of differing aspect into rows that share one height, keeping the
 * given order. For each row count, a DP splits the tiles into contiguous rows
 * so the row that runs out of width first allows the tallest tiles. Every
 * candidate holds the same tiles, so the tallest height is the most video
 * area. Returns null when no row count fits a tile at all.
 */
const computeJustifiedRows = ({
  aspects,
  width,
  height,
  gap,
  colCap,
  targetAspect,
}: {
  aspects: number[];
  width: number;
  height: number;
  gap: number;
  colCap: number;
  targetAspect: number;
}) => {
  const count = aspects.length;
  const prefix = [0];
  aspects.forEach((aspect, index) => prefix.push(prefix[index] + aspect));
  const rowHeightLimit = (start: number, end: number) => {
    const room = width - (end - start - 1) * gap;
    return room > 0 ? room / (prefix[end] - prefix[start]) : 0;
  };

  // limit[rows][end]: the tallest height the first `end` tiles reach in
  // `rows` rows. split[rows][end]: where the last of those rows starts.
  const limit = Array.from({ length: count + 1 }, () =>
    new Array<number>(count + 1).fill(Number.NEGATIVE_INFINITY),
  );
  const split = Array.from({ length: count + 1 }, () =>
    new Array<number>(count + 1).fill(0),
  );
  limit[0][0] = Number.POSITIVE_INFINITY;
  for (let rows = 1; rows <= count; rows += 1) {
    for (let end = rows; end <= count; end += 1) {
      for (let start = Math.max(rows - 1, end - colCap); start < end; start += 1) {
        const candidate = Math.min(limit[rows - 1][start], rowHeightLimit(start, end));
        // Ties go to the later start, which keeps earlier rows fuller.
        if (candidate >= limit[rows][end] - ASPECT_EPSILON) {
          limit[rows][end] = candidate;
          split[rows][end] = start;
        }
      }
    }
  }

  const rowCountsFor = (rows: number) => {
    const counts: number[] = [];
    let end = count;
    for (let row = rows; row > 0; row -= 1) {
      const start = split[row][end];
      counts.unshift(end - start);
      end = start;
    }
    return counts;
  };

  const containerAspect = width / height;
  let best: { rowCounts: number[]; tileHeight: number; aspectDist: number } | null =
    null;
  for (let rows = Math.ceil(count / colCap); rows <= count; rows += 1) {
    const tileHeight = Math.min(
      (height - (rows - 1) * gap) / rows,
      limit[rows][count],
    );
    if (!(tileHeight > 0)) continue;
    const rowCounts = rowCountsFor(rows);
    let start = 0;
    let boxW = 0;
    rowCounts.forEach((rowCount) => {
      const end = start + rowCount;
      boxW = Math.max(
        boxW,
        tileHeight * (prefix[end] - prefix[start]) + (rowCount - 1) * gap,
      );
      start = end;
    });
    const boxH = rows * tileHeight + (rows - 1) * gap;
    const aspectDist = Math.abs(boxW / boxH - containerAspect);

    // Same near-tie rule as the uniform packer, then fewer rows.
    const better =
      best === null ||
      tileHeight > best.tileHeight + 0.5 ||
      (Math.abs(tileHeight - best.tileHeight) <= 0.5 &&
        aspectDist < best.aspectDist - 0.01);
    if (better) best = { rowCounts, tileHeight, aspectDist };
  }
  if (!best) return null;

  const tileHeight = Math.floor(best.tileHeight);
  let start = 0;
  const rowAspects = best.rowCounts.map((rowCount) => {
    start += rowCount;
    return aspects.slice(start - rowCount, start);
  });
  const rows = best.rowCounts.length;
  const cols = Math.max(...best.rowCounts);
  const alignedRows = alignRows(rowAspects, tileHeight, gap, cols);
  const widths = alignedRows.flat();
  const rowWidths = alignedRows.map((tiles) => rowWidthOf(tiles, gap));
  const contentWidth = Math.max(...rowWidths);
  const contentHeight = rows * tileHeight + (rows - 1) * gap;
  const offsetX = Math.max(0, (width - contentWidth) / 2);
  const offsetY = Math.max(0, (height - contentHeight) / 2);

  const positions: GridTilePosition[] = [];
  let index = 0;
  best.rowCounts.forEach((rowCount, row) => {
    let x = offsetX + (contentWidth - rowWidths[row]) / 2;
    for (let col = 0; col < rowCount; col += 1) {
      positions.push({
        index,
        row,
        col: col + (cols - rowCount) / 2,
        x,
        y: offsetY + row * (tileHeight + gap),
        width: widths[index],
        height: tileHeight,
      });
      x += widths[index] + gap;
      index += 1;
    }
  });

  return {
    cols,
    rows,
    tileWidth: Math.floor(tileHeight * targetAspect),
    tileHeight,
    lastRowCount: best.rowCounts[rows - 1],
    contentWidth,
    contentHeight,
    offsetX,
    offsetY,
    positions,
  };
};

/**
 * Find the arrangement of `count` aspect-locked tiles that fits the largest
 * tile inside a `width` × `height` container.
 *
 * The objective is "maximise the side of the largest tile that fits N copies"
 * (i.e. maximise the displayed-video area). For each candidate column count we
 * derive rows = ceil(N/cols), compute the largest tile that fits the cell while
 * respecting `targetAspect`, and keep the candidate whose tile is biggest;
 * ties break toward fewer empty cells (fuller grid). With `tileAspects` that
 * differ from `targetAspect`, tiles pack into justified rows instead.
 */
export function computeGridLayout(
  count: number,
  width: number,
  height: number,
  options: GridLayoutOptions = {},
): GridLayoutResult {
  const { gap, maxCols, maxTilesPerPage, targetAspect } = { ...DEFAULTS, ...options };

  const total = Math.max(1, Math.floor(count));
  const pages = Math.ceil(total / maxTilesPerPage);
  const perPage = Math.min(total, maxTilesPerPage);

  // Degenerate container — return a single column so the caller still renders.
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      cols: 1,
      rows: perPage,
      tileWidth: 0,
      tileHeight: 0,
      lastRowCount: 1,
      pages,
      perPage,
      contentWidth: 0,
      contentHeight: 0,
      offsetX: 0,
      offsetY: 0,
      positions: buildGridTilePositions({
        cols: 1,
        rows: perPage,
        perPage,
        tileWidth: 0,
        tileHeight: 0,
        gap,
        width: 0,
        height: 0,
      }).positions,
    };
  }

  const colCap = Math.min(perPage, Math.max(1, Math.floor(maxCols)));
  const aspects = readTileAspects(options.tileAspects, perPage, targetAspect);
  const justified =
    aspects &&
    computeJustifiedRows({ aspects, width, height, gap, colCap, targetAspect });
  if (justified) return { ...justified, pages, perPage };

  const containerAspect = width / height;

  let best:
    | { cols: number; rows: number; tileWidth: number; empty: number; aspectDist: number }
    | null = null;

  for (let cols = 1; cols <= colCap; cols++) {
    const rows = Math.ceil(perPage / cols);
    const cellW = (width - (cols - 1) * gap) / cols;
    const cellH = (height - (rows - 1) * gap) / rows;
    if (cellW <= 0 || cellH <= 0) continue;

    // Largest aspect-locked tile that fits the cell (letterbox-fit).
    const tileWidth = Math.min(cellW, cellH * targetAspect);
    const tileHeight = tileWidth / targetAspect;
    const empty = cols * rows - perPage;
    // How well the grid's bounding box matches the container — this is the
    // tie-break that makes e.g. 2 people sit side-by-side in a landscape
    // container (both arrangements give the same tile size; the wider box wins).
    const boxW = cols * tileWidth + (cols - 1) * gap;
    const boxH = rows * tileHeight + (rows - 1) * gap;
    const aspectDist = Math.abs(boxW / boxH - containerAspect);

    let better = best === null;
    if (best !== null) {
      if (tileWidth > best.tileWidth + 0.5) better = true;
      else if (Math.abs(tileWidth - best.tileWidth) <= 0.5) {
        // Near-tie on tile size → best aspect match, then fuller grid.
        if (aspectDist < best.aspectDist - 0.01) better = true;
        else if (Math.abs(aspectDist - best.aspectDist) <= 0.01 && empty < best.empty)
          better = true;
      }
    }
    if (better) best = { cols, rows, tileWidth, empty, aspectDist };
  }

  // Fallback (shouldn't happen): one column.
  const chosen = best ?? { cols: 1, rows: perPage, tileWidth: width };

  const tileWidth = Math.max(0, Math.floor(chosen.tileWidth));
  const tileHeight = Math.max(0, Math.floor(tileWidth / targetAspect));
  const lastRowCount = perPage - (chosen.rows - 1) * chosen.cols;
  const placement = buildGridTilePositions({
    cols: chosen.cols,
    rows: chosen.rows,
    perPage,
    tileWidth,
    tileHeight,
    gap,
    width,
    height,
  });

  return {
    cols: chosen.cols,
    rows: chosen.rows,
    tileWidth,
    tileHeight,
    lastRowCount: Math.max(1, lastRowCount),
    pages,
    perPage,
    ...placement,
  };
}

export interface StageRailLayoutInput {
  /** Remote tiles competing for the stage rail, excluding the stage main tile. */
  candidateCount: number;
  /** Non-remote rail tiles that must remain visible, such as self-view/share. */
  fixedTileCount?: number;
  /** User/device tile budget for the whole stage layout. */
  maxTiles?: number;
  /** Measured rail viewport height in px. */
  railHeight: number;
  /** Compact rail tile height in px. */
  tileHeight?: number;
  /** Gap between rail tiles in px. */
  gap?: number;
}

export interface StageRailLayoutResult {
  /** Physical tile slots that fit in the measured rail viewport. */
  slotCount: number;
  /** Remote candidate tiles rendered as live video in the rail. */
  remoteCapacity: number;
  /** Whether a single overflow tile should reserve one visible rail slot. */
  overflowTile: boolean;
  /** Remote candidates hidden behind overflow. */
  hiddenCount: number;
  /** Fixed + remote + overflow tiles rendered in the rail. */
  renderedTileCount: number;
}

export function computeStageRailLayout(
  input: StageRailLayoutInput,
): StageRailLayoutResult {
  const candidateCount = Math.max(0, Math.floor(input.candidateCount));
  const fixedTileCount = Math.max(0, Math.floor(input.fixedTileCount ?? 0));
  const maxTiles = Number.isFinite(input.maxTiles ?? Number.POSITIVE_INFINITY)
    ? Math.max(0, Math.floor(input.maxTiles ?? 0))
    : Number.POSITIVE_INFINITY;
  const tileHeight = Math.max(1, Math.floor(input.tileHeight ?? 112));
  const gap = Math.max(0, Math.floor(input.gap ?? 12));
  const railHeight = Math.max(0, Math.floor(input.railHeight));

  const slotCount =
    railHeight > 0 ? Math.floor((railHeight + gap) / (tileHeight + gap)) : 0;
  const visibleSlots = Math.max(
    0,
    Math.min(slotCount - fixedTileCount, maxTiles - fixedTileCount),
  );
  const initialRemoteCapacity = Math.min(candidateCount, visibleSlots);
  const overflowTile =
    candidateCount > initialRemoteCapacity && visibleSlots > 0;
  const remoteCapacity = overflowTile
    ? Math.max(0, Math.min(candidateCount, visibleSlots - 1))
    : initialRemoteCapacity;
  const hiddenCount = Math.max(0, candidateCount - remoteCapacity);

  return {
    slotCount,
    remoteCapacity,
    overflowTile,
    hiddenCount,
    renderedTileCount:
      fixedTileCount + remoteCapacity + (overflowTile ? 1 : 0),
  };
}

export type StageMode = "tiled" | "spotlight" | "sideBySide" | "sidebar";

export interface StageModeInput {
  /** Visible participant count (incl. self). */
  count: number;
  /** Someone is screen-sharing / presenting. */
  presenting: boolean;
  /** A tile is explicitly pinned to the stage. */
  pinned: boolean;
  /** There is an active *video* speaker (not just the presentation). */
  hasActiveVideoSpeaker: boolean;
  /** Above this count (no presentation) Meet uses a sidebar instead of tiled. */
  tiledThreshold?: number;
}

/**
 * Meet "Auto" mode selection that runs ABOVE the grid packer. The packer is the
 * engine for the `tiled` mode and for the people rail in `sidebar`/`sideBySide`.
 */
export function chooseStageMode(input: StageModeInput): StageMode {
  const { count, presenting, pinned, hasActiveVideoSpeaker, tiledThreshold = 12 } = input;
  if (pinned || count <= 2 || (presenting && !hasActiveVideoSpeaker)) return "spotlight";
  if (presenting) return "sideBySide";
  if (count <= tiledThreshold) return "tiled";
  return "sidebar";
}
