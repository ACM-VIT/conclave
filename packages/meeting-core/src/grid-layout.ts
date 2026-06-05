/**
 * Google-Meet-style participant grid arrangement — shared, pure, dependency-free.
 *
 * This is the client-side "tiled / auto" layout engine: given a visible tile
 * count, a measured container, and a target tile aspect ratio, it finds the
 * column/row arrangement that MAXIMISES tile size (the canonical optimal-grid
 * packing that Meet/Jitsi/Daily all use), then reports last-row centering and
 * paging so the renderer can lay it out exactly like Meet.
 *
 * One source of truth: web (apps/web) and React-Native (apps/mobile) import
 * this; the Skip/SwiftUI app mirrors it 1:1 in Swift (GridLayout.swift).
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
}

const DEFAULTS: Required<GridLayoutOptions> = {
  gap: 12,
  maxCols: 7,
  maxTilesPerPage: 49,
  targetAspect: 16 / 9,
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
    return { cols: 1, rows: perPage, tileWidth: 0, tileHeight: 0, lastRowCount: 1, pages, perPage };
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

  return {
    cols: chosen.cols,
    rows: chosen.rows,
    tileWidth,
    tileHeight,
    lastRowCount: Math.max(1, lastRowCount),
    pages,
    perPage,
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
