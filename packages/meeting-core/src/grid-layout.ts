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
  /** Size of each tile in px (already aspect-constrained to targetAspect). */
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

const DEFAULTS: Required<GridLayoutOptions> = {
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

/**
 * Find the arrangement of `count` aspect-locked tiles that fits the largest
 * tile inside a `width` × `height` container.
 *
 * The objective is "maximise the side of the largest tile that fits N copies"
 * (i.e. maximise the displayed-video area). For each candidate column count we
 * derive rows = ceil(N/cols), compute the largest tile that fits the cell while
 * respecting `targetAspect`, and keep the candidate whose tile is biggest;
 * ties break toward fewer empty cells (fuller grid).
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
