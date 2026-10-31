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
