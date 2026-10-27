import Foundation

/// S20 SL1: pure stage geometry, shared by the presenter and both canvases so slots and frames always agree. The
/// presenter calls `capacity` and `railCapacity` to build `slots` and `overflowCount`; the canvas calls `frames` with the
/// same viewport. Points on iOS, dp on Android. Allocates only its results (S20 2 k).
enum StageLayoutPolicy {
    // S20 2 c grid table.
    static let compactPadding = 8.0
    static let compactGap = 8.0
    static let regularPadding = 16.0
    static let regularGap = 12.0
    /// Compact portrait rows never shrink below max(100, 0.75 x tile width) (web STG-05).
    static let rowFloorMinimum = 100.0
    static let rowFloorRatio = 0.75
    /// Tile height never exceeds 1.5 x tile width (web STG-05).
    static let tileHeightMaxRatio = 1.5
    /// Phones never show more than 8 grid slots (S20 Q1).
    static let compactSlotLimit = 8
    /// Packer cells never shrink below 176 x 99 (16:9).
    static let packerMinimumWidth = 176.0
    static let packerMinimumHeight = 99.0
    static let compactHeightMaxColumns = 4
    static let tileAspect = 16.0 / 9.0
    /// Rails (S20 4 c, d): `SpotlightRailPolicy` (STG-2) owns the strip and column geometry and the capacity.
    /// Floating self view (S20 6 owns the full rules; STG-3 refines the sizes).
    static let selfViewMargin = 12.0
    static let selfViewMinimumWidth = 96.0
    static let selfViewMaximumWidth = 140.0
    static let selfViewWidthRatio = 0.28
    static let selfMinimizedWidth = 72.0
    static let selfMinimizedHeight = 44.0

    // MARK: Classes

    /// Phones in portrait: compact width and taller than wide.
    static func isCompactPortrait(_ viewport: StageViewport) -> Bool {
        StageSizeClass.isCompact(viewport.widthClass) && !viewport.isLandscape
    }

    /// Phones in landscape: compact height.
    static func isCompactHeight(_ viewport: StageViewport) -> Bool {
        StageSizeClass.isCompact(viewport.heightClass)
    }

    static func padding(_ viewport: StageViewport) -> Double {
        usesRegularSpacing(viewport) ? regularPadding : compactPadding
    }

    static func gap(_ viewport: StageViewport) -> Double {
        usesRegularSpacing(viewport) ? regularGap : compactGap
    }

    /// iPad and Android 600 dp and wider (S20 2 c third column).
    static func usesRegularSpacing(_ viewport: StageViewport) -> Bool {
        !StageSizeClass.isCompact(viewport.widthClass) && !StageSizeClass.isCompact(viewport.heightClass)
    }

    /// The reserved content rectangle (S20 1 c): the canvas minus the reserved insets and the padding.
    static func contentFrame(_ viewport: StageViewport) -> StageFrame {
        let pad = padding(viewport)
        let width = max(0.0, viewport.width - viewport.insetLeading - viewport.insetTrailing - 2.0 * pad)
        let height = max(0.0, viewport.height - viewport.insetTop - viewport.insetBottom - 2.0 * pad)
        return StageFrame(slotId: "", x: viewport.insetLeading + pad, y: viewport.insetTop + pad, width: width, height: height)
    }

    // MARK: Kind (web parity with chooseStageMode; precedence D17)

    static func kind(_ inputs: StageInputs, showsVideoOverActivity: Bool) -> StageKind {
        if inputs.isWebinarAttendee {
            return inputs.webinarSpeakerUserId.isEmpty ? StageKind.attendeeWaiting : StageKind.attendeeLive
        }
        if !showsVideoOverActivity {
            if !inputs.activeAppId.isEmpty { return StageKind.app }
            if inputs.isBrowserActive { return StageKind.browser }
            if inputs.isGameActive { return StageKind.game }
        }
        let count = inputs.presentParticipants.count
        if !inputs.pinnedUserId.isEmpty && inputs.participant(inputs.pinnedUserId) != nil && count > 1 {
            return StageKind.spotlight
        }
        if !inputs.screenShareUserId.isEmpty { return StageKind.presentation }
        if count <= 1 { return StageKind.solo }
        if inputs.viewMode == "spotlight" { return StageKind.spotlight }
        if count == 2 && inputs.viewMode == "auto" && inputs.selfViewMode != "tile" { return StageKind.oneOnOne }
        if inputs.viewMode == "sidebar" || (inputs.viewMode == "auto" && count > MeetingViewConstants.autoTiledThreshold) {
            return StageKind.sidebar
        }
        return StageKind.grid
    }

    // MARK: Capacity

    static func capacity(viewport: StageViewport, kind: StageKind, count: Int, viewMaxTiles: Int) -> StageCapacity {
        if viewport.isEmpty { return StageCapacity.zero }
        switch kind {
        case .grid:
            return StageCapacity(gridSlots: gridCap(viewport: viewport, viewMaxTiles: viewMaxTiles), railSlots: 0)
        case .spotlight, .sidebar, .presentation, .game, .app, .browser:
            return StageCapacity(gridSlots: 0, railSlots: railCapacity(viewport: viewport))
        case .solo, .oneOnOne, .attendeeWaiting, .attendeeLive:
            return StageCapacity(gridSlots: 0, railSlots: 0)
        }
    }

    /// The grid cap (S20 2 c "Cap" row). Compact portrait: the largest even n at most min(viewMaxTiles, 8) whose rows
    /// at the row floor fit the reserved height; compact height: min(viewMaxTiles, 8, fit at 176 x 99, 4 columns);
    /// regular: min(viewMaxTiles, fit at 176 x 99).
    static func gridCap(viewport: StageViewport, viewMaxTiles: Int) -> Int {
        let limit = MeetingViewConstants.clampTiles(viewMaxTiles)
        let area = contentFrame(viewport)
        let gap = StageLayoutPolicy.gap(viewport)
        if isCompactPortrait(viewport) {
            let tileWidth = (area.width - gap) / 2.0
            let rowFloor = max(rowFloorMinimum, tileWidth * rowFloorRatio)
            var n = min(limit, compactSlotLimit)
            if n % 2 == 1 { n -= 1 }
            while n > 2 {
                let rows = n / 2
                let needed = Double(rows) * rowFloor + Double(rows - 1) * gap
                if needed <= area.height { break }
                n -= 2
            }
            return max(2, n)
        }
        if isCompactHeight(viewport) {
            let fit = packerFit(area: area, gap: gap, maxColumns: compactHeightMaxColumns)
            return max(2, min(min(limit, compactSlotLimit), fit))
        }
        return max(2, min(limit, packerFit(area: area, gap: gap, maxColumns: 0)))
    }

    /// How many 176 x 99 cells fit; `maxColumns` 0 means unbounded.
    static func packerFit(area: StageFrame, gap: Double, maxColumns: Int) -> Int {
        var columns = max(1, Int((area.width + gap) / (packerMinimumWidth + gap)))
        if maxColumns > 0 { columns = min(columns, maxColumns) }
        let rows = max(1, Int((area.height + gap) / (packerMinimumHeight + gap)))
        return columns * rows
    }

    /// Rail slots for spotlight, sidebar, presentation and activity strips (capped at the legacy 8,
    /// `MeetingViewConstants.stageRailMaxTiles`).
    static func railCapacity(viewport: StageViewport) -> Int {
        SpotlightRailPolicy.capacity(viewport: viewport)
    }

    // MARK: Frames

    /// One frame per slot, in slot order (later frames draw above earlier ones). `selfCorner` is the
    /// `MeetingSelfViewCorner` raw value.
    static func frames(viewport: StageViewport, kind: StageKind, slots: [StageSlot], selfCorner: String) -> [StageFrame] {
        if viewport.isEmpty || slots.isEmpty { return [] }
        var result: [StageFrame] = []
        var gridSlots: [StageSlot] = []
        var railSlots: [StageSlot] = []
        for slot in slots {
            switch slot.role {
            case .grid, .gridWide:
                gridSlots.append(slot)
            case .rail:
                railSlots.append(slot)
            case .overflow:
                if kind == StageKind.grid { gridSlots.append(slot) } else { railSlots.append(slot) }
            default:
                break
            }
        }
        let gridFrames = kind == StageKind.grid ? gridFramesFor(viewport: viewport, slots: gridSlots) : []
        let railFrames = railFramesFor(viewport: viewport, slots: railSlots)
        let mainFrame = mainFrameFor(viewport: viewport, kind: kind, hasRail: !railSlots.isEmpty)
        for slot in slots {
            switch slot.role {
            case .spotlightMain, .share, .activity, .programFeed:
                result.append(StageFrame(slotId: slot.id, x: mainFrame.x, y: mainFrame.y, width: mainFrame.width, height: mainFrame.height))
            case .selfFloating, .selfMinimized:
                result.append(selfFrame(viewport: viewport, role: slot.role, corner: selfCorner, slotId: slot.id))
            case .speakerInset:
                result.append(selfFrame(viewport: viewport, role: StageSlotRole.selfFloating, corner: "bottom-right", slotId: slot.id))
            case .grid, .gridWide, .rail, .overflow:
                if let frame = find(slot.id, in: gridFrames) ?? find(slot.id, in: railFrames) {
                    result.append(frame)
                }
            }
        }
        return result
    }

    static func find(_ slotId: String, in frames: [StageFrame]) -> StageFrame? {
        for frame in frames {
            if frame.slotId == slotId { return frame }
        }
        return nil
    }

    /// Full-bleed for 1:1, spotlight, share and the program feed (S20 1 c); the content area minus the rail band for
    /// sidebar and activity cards.
    static func mainFrameFor(viewport: StageViewport, kind: StageKind, hasRail: Bool) -> StageFrame {
        switch kind {
        case .sidebar, .game, .app, .browser:
            let area = contentFrame(viewport)
            if !hasRail { return area }
            let gap = StageLayoutPolicy.gap(viewport)
            if isCompactPortrait(viewport) {
                return StageFrame(slotId: "", x: area.x, y: area.y, width: area.width,
                                  height: max(0.0, area.height - SpotlightRailPolicy.tileHeight(viewport) - gap))
            }
            return StageFrame(slotId: "", x: area.x, y: area.y, width: max(0.0, area.width - SpotlightRailPolicy.tileWidth(viewport) - gap),
                              height: area.height)
        default:
            return StageFrame(slotId: "", x: 0, y: 0, width: viewport.width, height: viewport.height)
        }
    }

    /// Compact portrait: two columns (one for a chosen two-person grid), a wide first tile for odd counts, rows of
    /// min((H - gaps) / rows, 1.5 x width) never below the row floor, centered vertically. Elsewhere: the packer.
    static func gridFramesFor(viewport: StageViewport, slots: [StageSlot]) -> [StageFrame] {
        let area = contentFrame(viewport)
        let gap = StageLayoutPolicy.gap(viewport)
        let n = slots.count
        if n == 0 { return [] }
        if !isCompactPortrait(viewport) {
            let maxColumns = isCompactHeight(viewport) ? compactHeightMaxColumns : n
            return packedFrames(area: area, gap: gap, slots: slots, maxColumns: maxColumns)
        }
        if n == 1 {
            return [StageFrame(slotId: slots[0].id, x: area.x, y: area.y, width: area.width, height: area.height)]
        }
        if n == 2 {
            let height = min((area.height - gap) / 2.0, area.width * tileHeightMaxRatio)
            let top = area.y + (area.height - (2.0 * height + gap)) / 2.0
            return [
                StageFrame(slotId: slots[0].id, x: area.x, y: top, width: area.width, height: height),
                StageFrame(slotId: slots[1].id, x: area.x, y: top + height + gap, width: area.width, height: height),
            ]
        }
        var cells = 0
        for slot in slots {
            cells += slot.role == StageSlotRole.gridWide ? 2 : 1
        }
        let rows = (cells + 1) / 2
        let tileWidth = (area.width - gap) / 2.0
        let rowFloor = max(rowFloorMinimum, tileWidth * rowFloorRatio)
        let fitted = (area.height - Double(rows - 1) * gap) / Double(rows)
        let tileHeight = max(rowFloor, min(fitted, tileWidth * tileHeightMaxRatio))
        let blockHeight = Double(rows) * tileHeight + Double(rows - 1) * gap
        let top = area.y + max(0.0, (area.height - blockHeight) / 2.0)
        var result: [StageFrame] = []
        var row = 0
        var column = 0
        for slot in slots {
            let y = top + Double(row) * (tileHeight + gap)
            if slot.role == StageSlotRole.gridWide {
                if column == 1 {
                    row += 1
                    column = 0
                }
                result.append(StageFrame(slotId: slot.id, x: area.x, y: top + Double(row) * (tileHeight + gap),
                                         width: area.width, height: tileHeight))
                row += 1
                continue
            }
            result.append(StageFrame(slotId: slot.id, x: area.x + Double(column) * (tileWidth + gap), y: y, width: tileWidth,
                                     height: tileHeight))
            column += 1
            if column == 2 {
                column = 0
                row += 1
            }
        }
        return result
    }

    /// The tile packer (port of `S/Core/Layout/GridLayout.swift`): the column count with the largest 16:9 tile, ties
    /// to fewer empty cells; rows centered, the last row centered.
    static func packedFrames(area: StageFrame, gap: Double, slots: [StageSlot], maxColumns: Int) -> [StageFrame] {
        let n = slots.count
        if n == 0 || area.width <= 0 || area.height <= 0 { return [] }
        var bestColumns = 1
        var bestArea = -1.0
        var bestEmpty = Int.max
        var bestWidth = 0.0
        var bestHeight = 0.0
        let limit = max(1, min(n, maxColumns))
        var columns = 1
        while columns <= limit {
            let rows = (n + columns - 1) / columns
            let cellWidth = (area.width - Double(columns - 1) * gap) / Double(columns)
            let cellHeight = (area.height - Double(rows - 1) * gap) / Double(rows)
            if cellWidth > 0 && cellHeight > 0 {
                let tileWidth = min(cellWidth, cellHeight * tileAspect)
                let tileHeight = tileWidth / tileAspect
                let tileArea = tileWidth * tileHeight
                let empty = columns * rows - n
                if tileArea > bestArea + 0.5 || (abs(tileArea - bestArea) <= 0.5 && empty < bestEmpty) {
                    bestColumns = columns
                    bestArea = tileArea
                    bestEmpty = empty
                    bestWidth = tileWidth
                    bestHeight = tileHeight
                }
            }
            columns += 1
        }
        let rows = (n + bestColumns - 1) / bestColumns
        let blockHeight = Double(rows) * bestHeight + Double(rows - 1) * gap
        let top = area.y + max(0.0, (area.height - blockHeight) / 2.0)
        var result: [StageFrame] = []
        var index = 0
        var row = 0
        while row < rows {
            let inRow = min(bestColumns, n - row * bestColumns)
            let rowWidth = Double(inRow) * bestWidth + Double(inRow - 1) * gap
            let left = area.x + max(0.0, (area.width - rowWidth) / 2.0)
            var column = 0
            while column < inRow {
                result.append(StageFrame(slotId: slots[index].id, x: left + Double(column) * (bestWidth + gap),
                                         y: top + Double(row) * (bestHeight + gap), width: bestWidth, height: bestHeight))
                index += 1
                column += 1
            }
            row += 1
        }
        return result
    }

    /// A bottom strip on compact portrait (leading aligned, above the bar slot), a trailing column elsewhere.
    static func railFramesFor(viewport: StageViewport, slots: [StageSlot]) -> [StageFrame] {
        if slots.isEmpty { return [] }
        let area = contentFrame(viewport)
        let gap = StageLayoutPolicy.gap(viewport)
        var result: [StageFrame] = []
        var index = 0
        let tileWidth = SpotlightRailPolicy.tileWidth(viewport)
        let tileHeight = SpotlightRailPolicy.tileHeight(viewport)
        if isCompactPortrait(viewport) {
            let y = area.y + area.height - tileHeight
            for slot in slots {
                result.append(StageFrame(slotId: slot.id, x: area.x + Double(index) * (tileWidth + gap), y: y,
                                         width: tileWidth, height: tileHeight))
                index += 1
            }
            return result
        }
        let x = area.x + area.width - tileWidth
        for slot in slots {
            result.append(StageFrame(slotId: slot.id, x: x, y: area.y + Double(index) * (tileHeight + gap),
                                     width: tileWidth, height: tileHeight))
            index += 1
        }
        return result
    }

    /// The floating self view: a portrait 3:4 tile (landscape 4:3) in its corner inside the reserved insets; the
    /// minimized chip sits in the same corner.
    static func selfFrame(viewport: StageViewport, role: StageSlotRole, corner: String, slotId: String) -> StageFrame {
        let width: Double
        let height: Double
        if role == StageSlotRole.selfMinimized {
            width = selfMinimizedWidth
            height = selfMinimizedHeight
        } else if viewport.isLandscape {
            height = min(max(viewport.height * selfViewWidthRatio, 72.0), 120.0)
            width = height * 4.0 / 3.0
        } else {
            width = min(max(viewport.width * selfViewWidthRatio, selfViewMinimumWidth), selfViewMaximumWidth)
            height = width * 4.0 / 3.0
        }
        let leading = corner == "top-left" || corner == "bottom-left"
        let top = corner == "top-left" || corner == "top-right"
        let x = leading ? viewport.insetLeading + selfViewMargin : viewport.width - viewport.insetTrailing - selfViewMargin - width
        let y = top ? viewport.insetTop + selfViewMargin : viewport.height - viewport.insetBottom - selfViewMargin - height
        return StageFrame(slotId: slotId, x: x, y: y, width: width, height: height)
    }

    // MARK: Readout

    /// A deterministic hash of the laid-out frames for the `stage.layout` readout (identical on both platforms).
    static func frameHash(_ frames: [StageFrame]) -> Int {
        var hash = 17
        for frame in frames {
            let part = Int(frame.x) * 31 + Int(frame.y) * 17 + Int(frame.width) * 13 + Int(frame.height) * 7
            hash = (hash * 131 + part + frame.slotId.count) % 1_000_003
        }
        return hash
    }

    /// Two frames overlap with positive area.
    static func overlaps(_ a: StageFrame, _ b: StageFrame) -> Bool {
        a.x < b.maxX - 0.001 && b.x < a.maxX - 0.001 && a.y < b.maxY - 0.001 && b.y < a.maxY - 0.001
    }
}
