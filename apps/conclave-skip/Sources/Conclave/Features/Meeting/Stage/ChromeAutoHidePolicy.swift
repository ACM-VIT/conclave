import Foundation

enum ChromeVisibilityEvent: String, CaseIterable, Equatable {

    case tap

    case interaction

    case timerFired

    case muteChanged, rotation, pipRestore, panelClosed, actionBanner, screenReaderOn

    case blockerChanged
}

struct ChromeVisibilityState: Equatable {
    let isHidden: Bool
    let armSerial: Int

    static let initial = ChromeVisibilityState(isHidden: false, armSerial: 1)
}

enum ChromeAutoHidePolicy {

    static let baseTimeoutMillis = SystemAccessibilityDefaults.autoHideBaseMillis

    static let recentJoinHoldMillis = 8000.0

    static let moreSheet = "more.sheet"
    static let routeSheet = "route.sheet"
    static let routePicker = "route.picker"
    static let cameraMenu = "camera.menu"
    static let leaveMenu = "leave.menu"
    static let endDialog = "end.dialog"
    static let reactionsTray = "reactions.tray"
    static let barHold = "bar.hold"
    static let transientIds = [ChromeAutoHidePolicy.moreSheet, ChromeAutoHidePolicy.routeSheet, ChromeAutoHidePolicy.routePicker,
                               ChromeAutoHidePolicy.cameraMenu, ChromeAutoHidePolicy.leaveMenu, ChromeAutoHidePolicy.endDialog,
                               ChromeAutoHidePolicy.reactionsTray, ChromeAutoHidePolicy.barHold]

    static func effectiveBlocker(presenter: AutoHideBlocker, screenReader: Bool, focusInChrome: Bool) -> AutoHideBlocker {
        if screenReader { return AutoHideBlocker.screenReader }
        if focusInChrome { return AutoHideBlocker.focusInChrome }
        return presenter
    }

    static func canAutoHide(blocker: AutoHideBlocker, voiceOver: Bool, switchControl: Bool, focusInChrome: Bool) -> Bool {
        blocker == AutoHideBlocker.none && !voiceOver && !switchControl && !focusInChrome
    }

    static func canAutoHideHeader(blocker: AutoHideBlocker, voiceOver: Bool, switchControl: Bool, focusInChrome: Bool) -> Bool {
        (blocker == .none || blocker == .noRemoteVideo) && !voiceOver && !switchControl && !focusInChrome
    }

    static func controlsHidden(_ state: ChromeVisibilityState, canAutoHide: Bool) -> Bool {
        state.isHidden && canAutoHide
    }

    static func hideDelayMillis(timeoutMillis: Double, holdUntilMillis: Double, nowMillis: Double) -> Double {
        let timeout = timeoutMillis > 0 ? timeoutMillis : baseTimeoutMillis
        return max(timeout, holdUntilMillis - nowMillis)
    }

    static func isRevealTrigger(_ event: ChromeVisibilityEvent) -> Bool {
        switch event {
        case .muteChanged, .rotation, .pipRestore, .panelClosed, .actionBanner, .screenReaderOn:
            return true
        case .tap, .interaction, .timerFired, .blockerChanged:
            return false
        }
    }

    static func reduce(_ state: ChromeVisibilityState, event: ChromeVisibilityEvent, canAutoHide: Bool) -> ChromeVisibilityState {
        switch event {
        case .tap:
            if state.isHidden {
                return ChromeVisibilityState(isHidden: false, armSerial: state.armSerial + 1)
            }
            if canAutoHide {
                return ChromeVisibilityState(isHidden: true, armSerial: state.armSerial + 1)
            }
            return ChromeVisibilityState(isHidden: false, armSerial: state.armSerial + 1)
        case .interaction:
            if state.isHidden { return state }
            return ChromeVisibilityState(isHidden: false, armSerial: state.armSerial + 1)
        case .timerFired:
            if state.isHidden || !canAutoHide { return state }
            return ChromeVisibilityState(isHidden: true, armSerial: state.armSerial)
        case .blockerChanged:
            return ChromeVisibilityState(isHidden: canAutoHide ? state.isHidden : false, armSerial: state.armSerial + 1)
        case .muteChanged, .rotation, .pipRestore, .panelClosed, .actionBanner, .screenReaderOn:
            return ChromeVisibilityState(isHidden: false, armSerial: state.armSerial + 1)
        }
    }

    static func shouldArm(_ state: ChromeVisibilityState, canAutoHide: Bool) -> Bool {
        !state.isHidden && canAutoHide
    }

    static func chromeOpacity(_ state: ChromeVisibilityState) -> Double {
        state.isHidden ? 0.0 : 1.0
    }
}

struct StageReactionSlotMetrics: Equatable {
    let defaultBottomInset: Double
    let layerLeading: Double
    let layerBottom: Double
    let slotHeight: Double
    let labelBand: Double
    let barMaxWidth: Double
}

enum StageReactionSlotShape: String, CaseIterable, Equatable {
    case row, column, block
}

struct StageReactionSlotPlacement: Equatable {
    let bottomInset: Double
    let shape: StageReactionSlotShape
}

enum StageReactionPolicy {

    static let lifetimeMillis = 3800.0

    static let riseDistance = 160.0
    static let riseMillis = 3450.0
    static let fadeStartFraction = 0.6

    static let reducedFadeInMillis = 150.0
    static let reducedFadeOutMillis = 300.0

    static let popMillis = 160.0
    static let popFromScale = 0.85
    static let driftDistance = 10.0

    static let laneCount = 3
    static let laneOffset = 20.0
    static let bubbleDiameter = 48.0
    static let reducedLaneOffset = 72.0
    static let reducedSlotWidth = 64.0
    static let reducedPillMaxFontScale = 1.5
    static let leadingInset = 12.0
    static let layerLift = 64.0

    static func layerBottomInset(barReserve: Double, labelLineHeight: Double, defaultLabelLineHeight: Double) -> Double {
        barReserve + layerLift + max(0.0, labelLineHeight - defaultLabelLineHeight)
    }

    static let reducedSlotGap = 8.0
    static let bubbleSpacing = 4.0
    static let pillVerticalPadding = 2.0
    static let tileLabelInset = 8.0
    static let tileLabelPadding = 4.0
    static let tileLabelIconFloor = 16.0
    static let labelClearance = 8.0

    static func reducedSlotHeight(pillLineHeight: Double) -> Double {
        bubbleDiameter + bubbleSpacing + pillLineHeight + 2.0 * pillVerticalPadding
    }

    static func tileLabelBand(lineHeight: Double) -> Double {
        tileLabelInset + 2.0 * tileLabelPadding + max(tileLabelIconFloor, lineHeight)
    }

    static let reducedShapes: [StageReactionSlotShape] = [StageReactionSlotShape.row, StageReactionSlotShape.column,
                                                          StageReactionSlotShape.block]

    static func slotOffsetX(lane: Int, reduceMotion: Bool, shape: StageReactionSlotShape) -> Double {
        if !reduceMotion { return Double(lane) * laneOffset }
        switch shape {
        case .row:
            return Double(lane) * reducedLaneOffset
        case .column:
            return 0.0
        case .block:
            return lane == 1 ? reducedLaneOffset : 0.0
        }
    }

    static func slotOffsetY(lane: Int, shape: StageReactionSlotShape, slotHeight: Double) -> Double {
        switch shape {
        case .row:
            return 0.0
        case .column:
            return Double(lane) * (slotHeight + reducedSlotGap)
        case .block:
            return lane == 2 ? slotHeight + reducedSlotGap : 0.0
        }
    }

    static func shapeWidth(_ shape: StageReactionSlotShape) -> Double {
        var width = 0.0
        for lane in 0..<laneCount {
            width = max(width, slotOffsetX(lane: lane, reduceMotion: true, shape: shape) + reducedSlotWidth)
        }
        return width
    }

    static func shapeHeight(_ shape: StageReactionSlotShape, slotHeight: Double) -> Double {
        var height = 0.0
        for lane in 0..<laneCount {
            height = max(height, slotOffsetY(lane: lane, shape: shape, slotHeight: slotHeight) + slotHeight)
        }
        return height
    }

    static func slotFrames(shape: StageReactionSlotShape, bottomY: Double, minX: Double, slotHeight: Double) -> [StageFrame] {
        var result: [StageFrame] = []
        for lane in 0..<laneCount {
            let bottom = bottomY - slotOffsetY(lane: lane, shape: shape, slotHeight: slotHeight)
            result.append(StageFrame(slotId: "lane" + String(lane), x: minX + slotOffsetX(lane: lane, reduceMotion: true, shape: shape),
                                     y: bottom - slotHeight, width: reducedSlotWidth, height: slotHeight))
        }
        return result
    }

    static func reducedPlacement(viewport: StageViewport, kind: StageKind, slots: [StageSlot], frames: [StageFrame],
                                 metrics: StageReactionSlotMetrics) -> StageReactionSlotPlacement {
        let resting = StageReactionSlotPlacement(bottomInset: metrics.defaultBottomInset, shape: StageReactionSlotShape.row)
        if viewport.isEmpty || !viewport.isLandscape { return resting }
        let bands = labelBands(viewport: viewport, kind: kind, slots: slots, frames: frames, band: metrics.labelBand)
        let layerBottomY = viewport.height - metrics.layerBottom
        let restingY = layerBottomY - metrics.defaultBottomInset
        let minX = metrics.layerLeading + leadingInset
        let restingFrames = slotFrames(shape: StageReactionSlotShape.row, bottomY: restingY, minX: minX, slotHeight: metrics.slotHeight)
        if !slotsCollide(restingFrames, bands: bands) { return resting }
        var fallback = resting
        var fallbackOverlap = -1.0
        var fallbackDistance = 0.0
        for shape in reducedShapes {
            let height = shapeHeight(shape, slotHeight: metrics.slotHeight)
            let floorY = shapeFloor(viewport: viewport, metrics: metrics, minX: minX, width: shapeWidth(shape))
            let candidates = shapeCandidates(shape: shape, bands: bands, restingY: restingY, floorY: floorY, topY: viewport.insetTop,
                                             minX: minX, slotHeight: metrics.slotHeight)
            var clearY = -1.0
            var clearDistance = 0.0
            for candidate in candidates {
                if candidate - height < viewport.insetTop - 0.001 || candidate > floorY + 0.001 { continue }
                let placed = slotFrames(shape: shape, bottomY: candidate, minX: minX, slotHeight: metrics.slotHeight)
                let distance = abs(candidate - restingY)
                if slotsCollide(placed, bands: bands) {
                    let overlap = overlapArea(placed, bands: bands)
                    if fallbackOverlap < 0.0 || overlap < fallbackOverlap - 0.001 || (abs(overlap - fallbackOverlap) <= 0.001 && distance < fallbackDistance - 0.001) {
                        fallback = StageReactionSlotPlacement(bottomInset: layerBottomY - candidate, shape: shape)
                        fallbackOverlap = overlap
                        fallbackDistance = distance
                    }
                    continue
                }
                if clearY < 0.0 || distance < clearDistance - 0.001 || (abs(distance - clearDistance) <= 0.001 && candidate < clearY) {
                    clearY = candidate
                    clearDistance = distance
                }
            }
            if clearY >= 0.0 { return StageReactionSlotPlacement(bottomInset: layerBottomY - clearY, shape: shape) }
        }
        return fallback
    }

    static func labelBands(viewport: StageViewport, kind: StageKind, slots: [StageSlot], frames: [StageFrame],
                           band: Double) -> [StageFrame] {
        var result: [StageFrame] = []
        for slot in slots {
            if !StageViewportPolicy.carriesNameTag(slot.role) { continue }
            guard let frame = StageLayoutPolicy.find(slot.id, in: frames) else { continue }
            let insets = StageViewportPolicy.tileInsets(kind: kind, role: slot.role, viewport: viewport)
            let bottom = frame.maxY - insets.bottom
            result.append(StageFrame(slotId: slot.id, x: frame.x + insets.leading, y: bottom - band,
                                     width: max(0.0, frame.width - insets.leading - insets.trailing), height: band))
        }
        return result
    }

    static func shapeFloor(viewport: StageViewport, metrics: StageReactionSlotMetrics, minX: Double, width: Double) -> Double {
        let layerBottomY = viewport.height - metrics.layerBottom
        let barLeft = (viewport.width + viewport.insetLeading - viewport.insetTrailing - metrics.barMaxWidth) / 2.0
        let barRight = barLeft + metrics.barMaxWidth
        let maxX = minX + width
        let clearsBar = metrics.barMaxWidth <= 0.0 || maxX <= barLeft || minX >= barRight
        return clearsBar ? layerBottomY : min(layerBottomY, viewport.height - viewport.insetBottom)
    }

    static func shapeCandidates(shape: StageReactionSlotShape, bands: [StageFrame], restingY: Double, floorY: Double, topY: Double,
                                minX: Double, slotHeight: Double) -> [Double] {
        var result: [Double] = [restingY, floorY, topY + shapeHeight(shape, slotHeight: slotHeight)]
        for lane in 0..<laneCount {
            let x = minX + slotOffsetX(lane: lane, reduceMotion: true, shape: shape)
            let lift = slotOffsetY(lane: lane, shape: shape, slotHeight: slotHeight)
            for band in bands {
                if band.x >= x + reducedSlotWidth || band.maxX <= x { continue }
                result.append(band.y - labelClearance + lift)
                result.append(band.maxY + labelClearance + slotHeight + lift)
            }
        }
        return result
    }

    static func slotsCollide(_ placed: [StageFrame], bands: [StageFrame]) -> Bool {
        for slot in placed {
            for band in bands {
                if band.x >= slot.maxX || band.maxX <= slot.x { continue }
                if slot.y < band.maxY + labelClearance - 0.001 && slot.maxY > band.y - labelClearance + 0.001 { return true }
            }
        }
        return false
    }

    static func overlapArea(_ placed: [StageFrame], bands: [StageFrame]) -> Double {
        var total = 0.0
        for slot in placed {
            for band in bands {
                let width = min(slot.maxX, band.maxX) - max(slot.x, band.x)
                let height = min(slot.maxY, band.maxY) - max(slot.y, band.y)
                if width > 0.0 && height > 0.0 { total += width * height }
            }
        }
        return total
    }

    static func renderLimit(participantCount: Int) -> Int {
        if participantCount >= 36 { return 8 }
        if participantCount >= 20 { return 12 }
        return 20
    }

    static func visibleEvents(_ snapshot: StageReactionsSnapshot) -> [ReactionEvent] {
        let count = snapshot.events.count
        let limit = max(0, snapshot.renderLimit)
        if count <= limit { return snapshot.events }
        var result: [ReactionEvent] = []
        var index = count - limit
        while index < count {
            result.append(snapshot.events[index])
            index += 1
        }
        return result
    }

    static func visibleEvents(_ snapshot: StageReactionsSnapshot, reduceMotion: Bool) -> [ReactionEvent] {
        let limited = visibleEvents(snapshot)
        if !reduceMotion { return limited }
        var takenLanes: [Int] = []
        var picked: [Int] = []
        var index = limited.count - 1
        while index >= 0 && picked.count < laneCount {
            let eventLane = lane(for: limited[index].id)
            if !takenLanes.contains(eventLane) {
                takenLanes.append(eventLane)
                picked.append(index)
            }
            index -= 1
        }
        var result: [ReactionEvent] = []
        var position = picked.count - 1
        while position >= 0 {
            result.append(limited[picked[position]])
            position -= 1
        }
        return result
    }

    static func lane(for eventId: Int) -> Int {
        let value = eventId % laneCount
        return value < 0 ? value + laneCount : value
    }

    static func driftDirection(eventId: Int) -> Double {
        switch ((eventId % 4) + 4) % 4 {
        case 0: return -1.0
        case 1: return -0.5
        case 2: return 0.5
        default: return 1.0
        }
    }

    static func opacity(progress: Double) -> Double {
        if progress <= fadeStartFraction { return 1.0 }
        let fade = (progress - fadeStartFraction) / (1.0 - fadeStartFraction)
        return max(0.0, 1.0 - fade)
    }
}
