// Participant grid layout shared by SwiftUI and Skip/Compose.
// Keep the objective and tie-breaks in lockstep with the web grid layout.

import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

struct GridLayoutOptions {
    var gap: CGFloat = 12
    var maxCols: Int = 7
    var maxTilesPerPage: Int = 49
    var targetAspect: CGFloat = 16.0 / 9.0
}

struct GridTilePosition {
    let index: Int
    let row: Int
    let col: CGFloat
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}

struct GridLayoutResult {
    let cols: Int
    let rows: Int
    let tileWidth: CGFloat
    let tileHeight: CGFloat
    let lastRowCount: Int
    let pages: Int
    let perPage: Int
    let contentWidth: CGFloat
    let contentHeight: CGFloat
    let offsetX: CGFloat
    let offsetY: CGFloat
    let positions: [GridTilePosition]
}

private struct GridCandidate {
    let cols: Int
    let rows: Int
    let tileWidth: CGFloat
    let empty: Int
    let aspectDist: CGFloat
}

private struct GridTilePlacement {
    let contentWidth: CGFloat
    let contentHeight: CGFloat
    let offsetX: CGFloat
    let offsetY: CGFloat
    let positions: [GridTilePosition]
}

private func buildGridTilePositions(
    cols: Int,
    rows: Int,
    perPage: Int,
    tileWidth: CGFloat,
    tileHeight: CGFloat,
    gap: CGFloat,
    width: CGFloat,
    height: CGFloat
) -> GridTilePlacement {
    let contentWidth = max(0.0, CGFloat(cols) * tileWidth + CGFloat(max(0, cols - 1)) * gap)
    let contentHeight = max(0.0, CGFloat(rows) * tileHeight + CGFloat(max(0, rows - 1)) * gap)
    let offsetX = max(0.0, (width - contentWidth) / 2.0)
    let offsetY = max(0.0, (height - contentHeight) / 2.0)
    var positions: [GridTilePosition] = []

    var index = 0
    while index < perPage {
        let row = index / cols
        let rowStartIndex = row * cols
        let rowCount = min(cols, perPage - rowStartIndex)
        let rowWidth = CGFloat(rowCount) * tileWidth + CGFloat(max(0, rowCount - 1)) * gap
        let rowOffsetX = offsetX + max(0.0, (contentWidth - rowWidth) / 2.0)
        let col = index - rowStartIndex

        positions.append(GridTilePosition(
            index: index,
            row: row,
            col: CGFloat(col) + CGFloat(max(0, cols - rowCount)) / 2.0,
            x: rowOffsetX + CGFloat(col) * (tileWidth + gap),
            y: offsetY + CGFloat(row) * (tileHeight + gap),
            width: tileWidth,
            height: tileHeight
        ))
        index += 1
    }

    return GridTilePlacement(
        contentWidth: contentWidth,
        contentHeight: contentHeight,
        offsetX: offsetX,
        offsetY: offsetY,
        positions: positions
    )
}

/// Find the arrangement of `count` aspect-locked tiles that fits the largest
/// tile inside a `width` × `height` container. Objective: maximise the displayed
/// video area; ties break toward the grid whose bounding box best matches the
/// container aspect (so 2 people sit side-by-side in landscape), then fewer
/// empty cells.
func computeGridLayout(
    count: Int,
    width: CGFloat,
    height: CGFloat,
    options: GridLayoutOptions = GridLayoutOptions()
) -> GridLayoutResult {
    let gap = options.gap.isFinite && options.gap > 0.0 ? options.gap : 0.0
    let targetAspect = options.targetAspect.isFinite && options.targetAspect > 0.0
        ? options.targetAspect
        : 16.0 / 9.0
    let maxTilesPerPage = max(1, options.maxTilesPerPage)

    let total = max(1, count)
    let pages = Int(ceil(Double(total) / Double(maxTilesPerPage)))
    let perPage = min(total, maxTilesPerPage)

    // Degenerate container — return a single column so the caller still renders.
    if !width.isFinite || !height.isFinite || width <= 0 || height <= 0 {
        let placement = buildGridTilePositions(
            cols: 1, rows: perPage, perPage: perPage,
            tileWidth: 0.0, tileHeight: 0.0, gap: gap, width: 0.0, height: 0.0
        )
        return GridLayoutResult(
            cols: 1, rows: perPage, tileWidth: 0.0, tileHeight: 0.0,
            lastRowCount: 1, pages: pages, perPage: perPage,
            contentWidth: placement.contentWidth,
            contentHeight: placement.contentHeight,
            offsetX: placement.offsetX,
            offsetY: placement.offsetY,
            positions: placement.positions
        )
    }

    let colCap = min(perPage, max(1, options.maxCols))
    let containerAspect = width / height

    var best: GridCandidate? = nil

    var cols = 1
    while cols <= colCap {
        let rows = Int(ceil(Double(perPage) / Double(cols)))
        let cellW = (width - CGFloat(cols - 1) * gap) / CGFloat(cols)
        let cellH = (height - CGFloat(rows - 1) * gap) / CGFloat(rows)
        if cellW > 0 && cellH > 0 {
            // Largest aspect-locked tile that fits the cell (letterbox-fit).
            let tileWidth = min(cellW, cellH * targetAspect)
            let tileHeight = tileWidth / targetAspect
            let empty = cols * rows - perPage
            let boxW = CGFloat(cols) * tileWidth + CGFloat(cols - 1) * gap
            let boxH = CGFloat(rows) * tileHeight + CGFloat(rows - 1) * gap
            let aspectDist = abs(boxW / boxH - containerAspect)

            var better = best == nil
            if let b = best {
                if tileWidth > b.tileWidth + 0.5 {
                    better = true
                } else if abs(tileWidth - b.tileWidth) <= 0.5 {
                    if aspectDist < b.aspectDist - 0.01 {
                        better = true
                    } else if abs(aspectDist - b.aspectDist) <= 0.01 && empty < b.empty {
                        better = true
                    }
                }
            }
            if better {
                best = GridCandidate(cols: cols, rows: rows, tileWidth: tileWidth, empty: empty, aspectDist: aspectDist)
            }
        }
        cols += 1
    }

    let chosen = best ?? GridCandidate(cols: 1, rows: perPage, tileWidth: width, empty: 0, aspectDist: 0.0)
    let tileWidth = max(0.0, floor(chosen.tileWidth))
    let tileHeight = max(0.0, floor(tileWidth / targetAspect))
    let lastRowCount = perPage - (chosen.rows - 1) * chosen.cols
    let placement = buildGridTilePositions(
        cols: chosen.cols, rows: chosen.rows, perPage: perPage,
        tileWidth: tileWidth, tileHeight: tileHeight, gap: gap, width: width, height: height
    )

    return GridLayoutResult(
        cols: chosen.cols,
        rows: chosen.rows,
        tileWidth: tileWidth,
        tileHeight: tileHeight,
        lastRowCount: max(1, lastRowCount),
        pages: pages,
        perPage: perPage,
        contentWidth: placement.contentWidth,
        contentHeight: placement.contentHeight,
        offsetX: placement.offsetX,
        offsetY: placement.offsetY,
        positions: placement.positions
    )
}

// MARK: - Stage mode (Meet "Auto" selection above the grid packer)

enum StageMode {
    case tiled
    case spotlight
    case sideBySide
    case sidebar
}

struct StageModeInput {
    let count: Int
    let presenting: Bool
    let pinned: Bool
    let hasActiveVideoSpeaker: Bool
    var tiledThreshold: Int = 12
}

/// Meet "Auto" mode selection that runs ABOVE the grid packer. The packer is the
/// engine for `tiled` and for the people rail in `sidebar`/`sideBySide`.
func chooseStageMode(_ input: StageModeInput) -> StageMode {
    if input.pinned || input.count <= 2 || (input.presenting && !input.hasActiveVideoSpeaker) {
        return .spotlight
    }
    if input.presenting {
        return .sideBySide
    }
    if input.count <= input.tiledThreshold {
        return .tiled
    }
    return .sidebar
}
