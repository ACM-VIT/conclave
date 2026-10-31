import Foundation

enum StageLayoutPolicy {

    static let compactPadding = 8.0
    static let compactGap = 8.0
    static let regularPadding = 16.0
    static let regularGap = 12.0

    static let rowFloorMinimum = 100.0
    static let rowFloorRatio = 0.75

    static let tileHeightMaxRatio = 1.5

    static let compactSlotLimit = 8

    static let packerMinimumWidth = 176.0
    static let packerMinimumHeight = 99.0
    static let compactHeightMaxColumns = 4
    static let tileAspect = 16.0 / 9.0

    static let selfViewMargin = 12.0
    static let selfViewMinimumWidth = 96.0
    static let selfViewMaximumWidth = 140.0
    static let selfViewWidthRatio = 0.28
    static let selfMinimizedWidth = 72.0
    static let selfMinimizedHeight = 44.0

    static func isCompactPortrait(_ viewport: StageViewport) -> Bool {
        StageSizeClass.isCompact(viewport.widthClass) && !viewport.isLandscape
    }

    static func isCompactHeight(_ viewport: StageViewport) -> Bool {
        StageSizeClass.isCompact(viewport.heightClass)
    }

    static func padding(_ viewport: StageViewport) -> Double {
        usesRegularSpacing(viewport) ? regularPadding : compactPadding
    }

    static func gap(_ viewport: StageViewport) -> Double {
        usesRegularSpacing(viewport) ? regularGap : compactGap
    }

    static func usesRegularSpacing(_ viewport: StageViewport) -> Bool {
        !StageSizeClass.isCompact(viewport.widthClass) && !StageSizeClass.isCompact(viewport.heightClass)
    }

    static func contentFrame(_ viewport: StageViewport) -> StageFrame {
        let pad = padding(viewport)
        let width = max(0.0, viewport.width - viewport.insetLeading - viewport.insetTrailing - 2.0 * pad)
        let height = max(0.0, viewport.height - viewport.insetTop - viewport.insetBottom - 2.0 * pad)
        return StageFrame(slotId: "", x: viewport.insetLeading + pad, y: viewport.insetTop + pad, width: width, height: height)
    }

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
        if count == 2 && inputs.viewMode == "auto" {
            return inputs.selfViewMode == "tile" ? StageKind.spotlight : StageKind.oneOnOne
        }
        if inputs.viewMode == "sidebar" || (inputs.viewMode == "auto" && count > MeetingViewConstants.autoTiledThreshold) {
            return StageKind.sidebar
        }
        return StageKind.grid
    }

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

    static func packerFit(area: StageFrame, gap: Double, maxColumns: Int) -> Int {
        var columns = max(1, Int((area.width + gap) / (packerMinimumWidth + gap)))
        if maxColumns > 0 { columns = min(columns, maxColumns) }
        let rows = max(1, Int((area.height + gap) / (packerMinimumHeight + gap)))
        return columns * rows
    }

    static func railCapacity(viewport: StageViewport) -> Int {
        SpotlightRailPolicy.capacity(viewport: viewport)
    }

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
        let selfLift = selfNameTagLift(viewport: viewport, kind: kind, slots: slots, corner: selfCorner)
        for slot in slots {
            switch slot.role {
            case .spotlightMain, .share, .activity, .programFeed:
                result.append(StageFrame(slotId: slot.id, x: mainFrame.x, y: mainFrame.y, width: mainFrame.width, height: mainFrame.height))
            case .selfFloating, .selfMinimized:
                result.append(selfFrame(viewport: viewport, role: slot.role, corner: selfCorner, slotId: slot.id, lift: selfLift))
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

    static func selfNameTagLift(viewport: StageViewport, kind: StageKind, slots: [StageSlot], corner: String) -> Double {
        if corner != SelfViewSnapPolicy.bottomLeft { return 0.0 }
        for slot in slots {
            let insets = StageViewportPolicy.tileInsets(kind: kind, role: slot.role, viewport: viewport)
            if insets.bottom <= 0.0 { continue }
            let clearance = insets.bottom + StageViewportPolicy.nameTagBand + StageViewportPolicy.tileControlGap
            return max(0.0, clearance - viewport.insetBottom - selfViewMargin)
        }
        return 0.0
    }

    static func selfFrame(viewport: StageViewport, role: StageSlotRole, corner: String, slotId: String, lift: Double = 0.0) -> StageFrame {
        let width: Double
        let height: Double
        if role == StageSlotRole.selfMinimized {
            width = selfMinimizedWidth
            height = selfMinimizedHeight
        } else {

            width = SelfViewSnapPolicy.floatingWidth(viewport)
            height = SelfViewSnapPolicy.floatingHeight(viewport)
        }
        let leading = corner == "top-left" || corner == "bottom-left"
        let top = corner == "top-left" || corner == "top-right"
        let x = leading ? viewport.insetLeading + selfViewMargin : viewport.width - viewport.insetTrailing - selfViewMargin - width
        let resting = top ? viewport.insetTop + selfViewMargin : viewport.height - viewport.insetBottom - selfViewMargin - height
        let y = lift > 0.0 ? max(viewport.insetTop + selfViewMargin, resting - lift) : resting
        return StageFrame(slotId: slotId, x: x, y: y, width: width, height: height)
    }

    static func frameHash(_ frames: [StageFrame]) -> Int {
        var hash = 17
        for frame in frames {
            let part = Int(frame.x) * 31 + Int(frame.y) * 17 + Int(frame.width) * 13 + Int(frame.height) * 7
            hash = (hash * 131 + part + frame.slotId.count) % 1_000_003
        }
        return hash
    }

    static func overlaps(_ a: StageFrame, _ b: StageFrame) -> Bool {
        a.x < b.maxX - 0.001 && b.x < a.maxX - 0.001 && a.y < b.maxY - 0.001 && b.y < a.maxY - 0.001
    }
}

enum StageAlonePolicy {
    static let avatarDiameter = 72.0
    static let compactAvatarDiameter = 40.0
    static let edgeInset = 24.0
    static let avatarSpacing = 12.0
    static let lineSpacing = 4.0
    static let toastClearance = 52.0
    static let titleLineHeight = 28.0
    static let statusLineHeight = 20.0
    static let maxTitleLines = 2

    static func bottomPadding(_ viewport: StageViewport) -> Double {
        viewport.insetBottom + toastClearance + edgeInset
    }

    static func topPadding(_ viewport: StageViewport) -> Double {
        viewport.insetTop
    }

    static func bandHeight(_ viewport: StageViewport) -> Double {
        max(0.0, viewport.height - topPadding(viewport) - bottomPadding(viewport))
    }

    static func compositionHeight(compact: Bool, titleLines: Int, titleLine: Double, statusLine: Double) -> Double {
        let text = titleLine * Double(titleLines) + lineSpacing + statusLine
        return compact ? max(compactAvatarDiameter, text) : avatarDiameter + avatarSpacing + text
    }

    static func usesCompactLayout(_ viewport: StageViewport, titleLine: Double, statusLine: Double) -> Bool {
        compositionHeight(compact: false, titleLines: 1, titleLine: titleLine, statusLine: statusLine) > bandHeight(viewport)
    }

    static func titleLineLimit(_ viewport: StageViewport, titleLine: Double, statusLine: Double) -> Int {
        let compact = usesCompactLayout(viewport, titleLine: titleLine, statusLine: statusLine)
        let full = compositionHeight(compact: compact, titleLines: maxTitleLines, titleLine: titleLine, statusLine: statusLine)
        return full <= bandHeight(viewport) ? maxTitleLines : 1
    }

    static func snapshot(_ inputs: StageInputs, kind: StageKind) -> StageAloneSnapshot? {
        if kind != StageKind.solo || !inputs.isAloneConfirmed || inputs.isWebinarAttendee { return nil }
        if inputs.roomLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        guard let local = inputs.participant(inputs.localUserId) else { return nil }
        if !local.isCameraOff { return nil }
        return StageAloneSnapshot(slotId: StageSlot.participantId(inputs.localUserId), roomLabel: inputs.roomLabel,
                                  seed: inputs.roomLabel)
    }
}
