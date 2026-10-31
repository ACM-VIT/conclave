import Foundation

enum AudioRouteChangeReason: String, CaseIterable, Equatable {
    case newDeviceAvailable, oldDeviceUnavailable, categoryChange, routeConfigurationChange, wakeFromSleep
    case noSuitableRouteForCategory, unknown

    case routeOverride = "override"

    static func fromIOSRawValue(_ rawValue: Int) -> AudioRouteChangeReason {
        switch rawValue {
        case 1: return .newDeviceAvailable
        case 2: return .oldDeviceUnavailable
        case 3: return .categoryChange
        case 4: return .routeOverride
        case 6: return .wakeFromSleep
        case 7: return .noSuitableRouteForCategory
        case 8: return .routeConfigurationChange
        default: return .unknown
        }
    }
}

struct AudioRouteIntentState: Equatable {
    let routeId: String
    let presentId: String
    let wasPresent: Bool
}

struct AudioRouteState: Equatable {
    let previousId: String
    let currentId: String
    let defaultId: String
}

enum AudioRouteChangeActionKind: String, CaseIterable, Equatable {

    case restoreIntent

    case adoptNewDevice

    case fallBack

    case adoptAsIntent

    case confirmOwnRequest

    case reapplyIntent

    case keep

    case ignore
}

struct AudioRouteChangeAction: Equatable {
    let kind: AudioRouteChangeActionKind

    let targetId: String

    let intentId: String

    let finalId: String

    let postsRouteChanged: Bool

    let restartsCapture: Bool
}

enum AudioRouteChangePolicy {

    static let systemPickerWindowMillis: Double = 2_000

    static let ownRequestWindowMillis: Double = 1_500

    static let requestTimeoutMillis: Double = 3_000

    static let androidReapplyThrottleMillis: Double = 700

    static func effectiveReason(_ reason: AudioRouteChangeReason, isWithinSystemPickerWindow: Bool) -> AudioRouteChangeReason {
        guard isWithinSystemPickerWindow else { return reason }
        switch reason {
        case .oldDeviceUnavailable, .categoryChange:
            return reason
        default:
            return .routeOverride
        }
    }

    static func action(
        reason: AudioRouteChangeReason,
        intent: AudioRouteIntentState,
        current: AudioRouteState,
        pendingOwnRequest: Bool
    ) -> AudioRouteChangeAction {
        let now = current.currentId
        switch reason {
        case .categoryChange:
            return make(.ignore, target: "", intent: intent.routeId, landing: now, current: current, posts: false, restarts: false)

        case .oldDeviceUnavailable:

            var fallback = intent.presentId
            if fallback.isEmpty {
                fallback = current.defaultId
            }
            let landing = fallback.isEmpty ? now : fallback
            return make(.fallBack, target: landing == now ? "" : landing, intent: intent.routeId, landing: landing,
                        current: current, posts: landing != current.previousId, restarts: landing != current.previousId)

        case .newDeviceAvailable:
            if pendingOwnRequest {
                return make(.confirmOwnRequest, target: "", intent: intent.routeId, landing: now, current: current,
                            posts: false, restarts: now != current.previousId)
            }
            if !intent.routeId.isEmpty && !intent.presentId.isEmpty && !intent.wasPresent {

                let target = intent.presentId
                return make(.restoreIntent, target: target == now ? "" : target, intent: intent.routeId, landing: target,
                            current: current, posts: target != current.previousId, restarts: target != current.previousId)
            }
            let followed = current.defaultId.isEmpty ? now : current.defaultId
            if !intent.routeId.isEmpty && intent.wasPresent && intent.presentId == followed {

                return make(.keep, target: followed == now ? "" : followed, intent: intent.routeId, landing: followed,
                            current: current, posts: followed != current.previousId, restarts: followed != current.previousId)
            }

            let nextIntent = (intent.wasPresent && !intent.presentId.isEmpty) ? "" : intent.routeId
            return make(.adoptNewDevice, target: followed == now ? "" : followed, intent: nextIntent, landing: followed,
                        current: current, posts: followed != current.previousId, restarts: followed != current.previousId)

        case .routeOverride:
            if pendingOwnRequest {
                return make(.confirmOwnRequest, target: "", intent: intent.routeId, landing: now, current: current,
                            posts: false, restarts: now != current.previousId)
            }

            return make(.adoptAsIntent, target: "", intent: now, landing: now, current: current,
                        posts: false, restarts: now != current.previousId)

        case .routeConfigurationChange, .wakeFromSleep, .noSuitableRouteForCategory, .unknown:
            if pendingOwnRequest {
                return make(.confirmOwnRequest, target: "", intent: intent.routeId, landing: now, current: current,
                            posts: false, restarts: now != current.previousId)
            }
            if !intent.routeId.isEmpty && !intent.presentId.isEmpty && intent.presentId != now {
                let target = intent.presentId
                return make(.reapplyIntent, target: target, intent: intent.routeId, landing: target, current: current,
                            posts: target != current.previousId, restarts: target != current.previousId)
            }
            return make(.keep, target: "", intent: intent.routeId, landing: now, current: current,
                        posts: now != current.previousId, restarts: now != current.previousId)
        }
    }

    static func classifyCommunicationDeviceChange(
        previousId: String,
        newId: String,
        previousAvailableIds: [String],
        currentAvailableIds: [String]
    ) -> AudioRouteChangeReason {
        if !previousId.isEmpty && !currentAvailableIds.contains(previousId) {
            return .oldDeviceUnavailable
        }
        if !newId.isEmpty && !previousAvailableIds.contains(newId) {
            return .newDeviceAvailable
        }
        if previousId == newId {
            return .routeConfigurationChange
        }
        return .routeOverride
    }

    static func isOwnRequest(requestMillis: Double, targetId: String, currentId: String, nowMillis: Double) -> Bool {
        guard requestMillis >= 0, nowMillis - requestMillis <= ownRequestWindowMillis else { return false }
        return targetId.isEmpty || targetId == currentId
    }

    private static func make(
        _ kind: AudioRouteChangeActionKind,
        target: String,
        intent: String,
        landing: String,
        current: AudioRouteState,
        posts: Bool,
        restarts: Bool
    ) -> AudioRouteChangeAction {
        AudioRouteChangeAction(
            kind: kind,
            targetId: target,
            intentId: intent,
            finalId: landing,
            postsRouteChanged: posts && !landing.isEmpty,
            restartsCapture: restarts
        )
    }
}

enum AudioInterruptionEvent: String, CaseIterable, Equatable {

    case began

    case beganBuiltInMicMuted

    case ended

    case servicesReset

    case servicesRecovered

    case focusLost

    case focusGained
}

enum AudioInterruptionPolicy {

    static let iosBuiltInMicMutedReason = 2

    static let servicesResetNoticeDelayMillis: Double = 2_000

    static func next(current: AudioInterruptionKind, event: AudioInterruptionEvent) -> AudioInterruptionKind {
        if current == .held {
            return .held
        }
        switch event {
        case .began, .focusLost:
            return .otherAudio
        case .beganBuiltInMicMuted:
            return .deviceMicMuted
        case .servicesReset:
            return .servicesReset
        case .ended, .focusGained, .servicesRecovered:
            return .none
        }
    }

    static func beganEvent(reasonRawValue: Int) -> AudioInterruptionEvent {
        reasonRawValue == iosBuiltInMicMutedReason ? .beganBuiltInMicMuted : .began
    }

    static func reappliesIntent(_ event: AudioInterruptionEvent) -> Bool {
        event == .ended || event == .focusGained || event == .servicesRecovered
    }
}
