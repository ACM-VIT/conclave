import Foundation

/// What can change chrome visibility (S20 8 f). Reveal triggers bring chrome back and re-arm the one-shot timer.
enum ChromeVisibilityEvent: String, CaseIterable, Equatable {
    /// A tap on the stage background (outside a control): toggles.
    case tap
    /// Any interaction with visible chrome: re-arms the timer.
    case interaction
    /// The view-local one-shot timer fired.
    case timerFired
    /// Reveal triggers.
    case muteChanged, rotation, pipRestore, panelClosed, actionBanner, screenReaderOn
    /// A blocker appeared or cleared: chrome is revealed while blocked and the timer re-arms either way.
    case blockerChanged
}

/// View-local chrome visibility (S20 8 c, d). `armSerial` changes whenever the one-shot timer must (re)arm; the
/// platform timer is keyed on it, so a newer arm cancels an older one and nothing ticks while hidden or blocked.
struct ChromeVisibilityState: Equatable {
    let isHidden: Bool
    let armSerial: Int

    static let initial = ChromeVisibilityState(isHidden: false, armSerial: 1)
}

/// S20 SL8 (STG-4): when stage chrome (top row, control bar, self-view flip control, landscape share strip) may hide.
/// Pure and shared; the platform keeps one view-local one-shot timer. Time-boxed UI is disabled for assistive
/// technology (HIG H-04, AX11): a screen reader, Switch Control or keyboard focus in chrome always keeps chrome.
enum ChromeAutoHidePolicy {
    /// S20 Q7: 5 s; Android stretches it through `getRecommendedTimeoutMillis` (passed in as `timeoutMillis`).
    static let baseTimeoutMillis = SystemAccessibilityDefaults.autoHideBaseMillis
    /// Chrome stays at least 8 s after joining (S20 8 f "within 8 s of joining").
    static let recentJoinHoldMillis = 8000.0

    /// S30 CC16 transient ids: menus, sheets and dialogs SwiftUI and Compose do not report on their own.
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

    /// The presenter blocker with the view facts folded in: a screen reader first, then keyboard focus in chrome.
    static func effectiveBlocker(presenter: AutoHideBlocker, screenReader: Bool, focusInChrome: Bool) -> AutoHideBlocker {
        if screenReader { return AutoHideBlocker.screenReader }
        if focusInChrome { return AutoHideBlocker.focusInChrome }
        return presenter
    }

    /// The S20 8 c gate: the timer arms only when nothing blocks.
    static func canAutoHide(blocker: AutoHideBlocker, voiceOver: Bool, switchControl: Bool, focusInChrome: Bool) -> Bool {
        blocker == AutoHideBlocker.none && !voiceOver && !switchControl && !focusInChrome
    }

    /// The one-shot delay: the platform timeout (5 s, or Android's recommendation), never before the recent-join
    /// hold ends. A non-positive timeout falls back to 5 s.
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

    /// The pure state machine both platforms run. Chrome never hides while blocked; a tap hides only when it could
    /// auto-hide; the timer fires only while visible and eligible.
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

    /// Whether the platform timer should be running for this state.
    static func shouldArm(_ state: ChromeVisibilityState, canAutoHide: Bool) -> Bool {
        !state.isHidden && canAutoHide
    }

    /// Hidden chrome leaves hit testing and the accessibility tree together, never one without the other (S20 8 i).
    static func chromeOpacity(_ state: ChromeVisibilityState) -> Double {
        state.isHidden ? 0.0 : 1.0
    }
}

/// S20 9: the reaction burst layer rules, shared so both platforms cap and time bubbles the same way.
enum StageReactionPolicy {
    /// Each bubble is gone 3.8 s after it appears (web STG-30).
    static let lifetimeMillis = 3800.0
    /// Rise 160 pt or dp over 3.45 s, ease out, fading over the last 40%.
    static let riseDistance = 160.0
    static let riseMillis = 3450.0
    static let fadeStartFraction = 0.6
    /// Reduce Motion: fade in 150 ms in place, hold, fade out 300 ms.
    static let reducedFadeInMillis = 150.0
    static let reducedFadeOutMillis = 300.0
    /// Three sub-lanes 20 pt apart, round robin by event id.
    static let laneCount = 3
    static let laneOffset = 20.0
    static let bubbleDiameter = 48.0
    static let leadingInset = 12.0

    /// 20 bubbles, 12 at 20 or more people, 8 at 36 or more (web STG-30).
    static func renderLimit(participantCount: Int) -> Int {
        if participantCount >= 36 { return 8 }
        if participantCount >= 20 { return 12 }
        return 20
    }

    /// The newest `renderLimit` events; older ones beyond the limit are not drawn.
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

    static func lane(for eventId: Int) -> Int {
        let value = eventId % laneCount
        return value < 0 ? value + laneCount : value
    }

    /// Opacity at `progress` (0 to 1 of the rise): 1, then fading to 0 over the last 40%.
    static func opacity(progress: Double) -> Double {
        if progress <= fadeStartFraction { return 1.0 }
        let fade = (progress - fadeStartFraction) / (1.0 - fadeStartFraction)
        return max(0.0, 1.0 - fade)
    }
}
