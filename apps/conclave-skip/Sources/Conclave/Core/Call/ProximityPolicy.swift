import Foundation

// S70 4 (SYS-5), 0.6 SX5 and SX11, 0.7 SY8: the keep-awake and proximity rules. Pure and transpiled (String raw-value
// enums and scalar functions, no platform import), host-tested on macOS in T/SYS5ProximityTests.swift. CallPresence
// computes `keepsScreenAwake` and `proximityArmed` for the snapshot with these; the edge writer in
// CallScreenAwake.swift turns them into platform calls only on change.

/// S70 0.5: the proximity controller's private state. The Debug readout `sys.proximity` shows it; the presence
/// snapshot never carries it, so a phone moving to the ear invalidates no view (0.5 Observation).
enum ProximityState: String, CaseIterable, Equatable {
    case off, armed, near
}

/// S70 4 a and SX11: whether the screen blanks when the phone is held to the ear.
enum ProximityPolicy {
    /// SX11 `ProximityPolicy.armed(route:isCameraOn:isPresenting:isInPip:isAppActive:)`: the route is the receiver,
    /// the local camera is off, you are not presenting, Picture in Picture is not showing and the app is active.
    /// Video calls on the speaker never pay for the sensor (4 k).
    static func armed(
        route: AudioRouteKind,
        isCameraOn: Bool,
        isPresenting: Bool,
        isInPip: Bool,
        isAppActive: Bool
    ) -> Bool {
        route == .receiver && !isCameraOn && !isPresenting && !isInPip && isAppActive
    }

    /// The snapshot rule: the arming rule while a call is being joined or held. Exits (4 a): phase `idle` or
    /// `ending`, or any arming condition ending.
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

    /// The controller-private state (4 c, 4 f). `monitoringActive` is what the platform reports after the write:
    /// iOS `isProximityMonitoringEnabled` reads back false on a device without a sensor (iPad), Android holds the
    /// `PROXIMITY_SCREEN_OFF_WAKE_LOCK` only where the level is supported and the activity is resumed. Without
    /// active monitoring the state stays `off`; near and far move it between `armed` and `near`.
    static func state(armed: Bool, monitoringActive: Bool, isNear: Bool) -> ProximityState {
        guard armed && monitoringActive else { return .off }
        return isNear ? .near : .armed
    }

    /// `sys.proximity` (S70 SX1): `off`, `armed` or `near`.
    static func readout(_ state: ProximityState) -> String {
        state.rawValue
    }
}

/// S70 4 a: keep the screen on while a meeting is on screen.
enum KeepAwakePolicy {
    /// True for `waiting`, `connecting`, `live`, `recovering` and `onHold` (waiting added with O3); false for `idle`
    /// and `ending`.
    static func keepsScreenAwake(phase: CallPresencePhase) -> Bool {
        CallPresencePhasePolicy.isCallInProgress(phase)
    }

    /// The value written to the idle timer (iOS `isIdleTimerDisabled`; SkipUI maps it to `FLAG_KEEP_SCREEN_ON` on
    /// Android). The legacy joined-call gate (`CallScreenAwake.setActive(_:)` from the view model's presence gate)
    /// still writes it on both platforms; on iOS the presence rule writes it too, so waiting keeps the screen awake
    /// on every route. On Android the presence rule is Compose-scoped instead (`KeepScreenOnEffect` in the native
    /// roots, 4 d), so `presenceDrivesIdleTimer` is false there and the legacy route keeps SkipUI's window flag.
    static func idleTimerDisabled(legacyActive: Bool, presenceKeepsAwake: Bool, presenceDrivesIdleTimer: Bool) -> Bool {
        legacyActive || (presenceDrivesIdleTimer && presenceKeepsAwake)
    }

    /// `sys.awake` (S70 SX1): `1` while a writer keeps the screen on, else `0`.
    static func readout(_ on: Bool) -> String {
        on ? "1" : "0"
    }
}
