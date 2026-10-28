import Foundation

enum ProximityState: String, CaseIterable, Equatable {
    case off, armed, near
}

enum ProximityPolicy {

    static func armed(
        route: AudioRouteKind,
        isCameraOn: Bool,
        isPresenting: Bool,
        isInPip: Bool,
        isAppActive: Bool
    ) -> Bool {
        route == .receiver && !isCameraOn && !isPresenting && !isInPip && isAppActive
    }

    static func armedInCall(
        phase: CallPresencePhase,
        route: AudioRouteKind,
        isCameraOn: Bool,
        isPresenting: Bool,
        isInPip: Bool,
        isAppActive: Bool
    ) -> Bool {
        guard CallPresencePhasePolicy.isCallInProgress(phase) else { return false }
        return armed(route: route, isCameraOn: isCameraOn, isPresenting: isPresenting, isInPip: isInPip, isAppActive: isAppActive)
    }

    static func state(armed: Bool, monitoringActive: Bool, isNear: Bool) -> ProximityState {
        guard armed && monitoringActive else { return .off }
        return isNear ? .near : .armed
    }

    static func readout(_ state: ProximityState) -> String {
        state.rawValue
    }
}

enum KeepAwakePolicy {

    static func keepsScreenAwake(phase: CallPresencePhase) -> Bool {
        CallPresencePhasePolicy.isCallInProgress(phase)
    }

    static func idleTimerDisabled(legacyActive: Bool, presenceKeepsAwake: Bool, presenceDrivesIdleTimer: Bool) -> Bool {
        legacyActive || (presenceDrivesIdleTimer && presenceKeepsAwake)
    }

    static func readout(_ on: Bool) -> String {
        on ? "1" : "0"
    }
}
