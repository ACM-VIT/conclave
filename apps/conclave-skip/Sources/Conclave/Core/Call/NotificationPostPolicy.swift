import Foundation

/// The status line of the Android call notification (S70 1 f, g). `none` lets CallStyle show its own "Ongoing call".
enum CallNotificationStatusKind: String, CaseIterable, Equatable {
    case none, waiting, joining, reconnecting, onHold
}

/// The one custom action next to the system Hang up. Absolute, never a toggle (S70 0.5): a stale tap after the state
/// changed elsewhere is a no-op instead of an inversion.
enum CallNotificationActionKind: String, CaseIterable, Equatable {
    case none, mute, unmute
}

enum CallNotificationServiceCommand: String, CaseIterable, Equatable {
    case none, start, update, stop
}

/// S70 1 d: what the Android call service posts and when (SX11). The notification is re-posted only when a visible
/// field changes, not on every sync.
enum NotificationPostPolicy {
    static let notificationId = 1

    /// The `sys_` string resource name for a status kind, or "" for the CallStyle default.
    static func statusResourceName(_ kind: CallNotificationStatusKind) -> String {
        switch kind {
        case .none: return ""
        case .waiting: return "sys_call_waiting"
        case .joining: return "sys_call_joining"
        case .reconnecting: return "sys_call_reconnecting"
        case .onHold: return "sys_call_on_hold"
        }
    }

    static func actionResourceName(_ kind: CallNotificationActionKind) -> String {
        switch kind {
        case .none: return ""
        case .mute: return "sys_call_mute"
        case .unmute: return "sys_call_unmute"
        }
    }

    /// The drawable a mute action shows: the glyph of what the tap does (SX8).
    static func actionDrawableName(_ kind: CallNotificationActionKind) -> String {
        switch kind {
        case .none: return ""
        case .mute: return "conclave_mic_fill1"
        case .unmute: return "conclave_mic_off_fill1"
        }
    }

    static func statusKind(_ snapshot: CallPresenceSnapshot) -> CallNotificationStatusKind {
        switch snapshot.phase {
        case .waiting: return .waiting
        case .connecting: return .joining
        case .recovering: return .reconnecting
        case .onHold: return .onHold
        case .live, .idle, .ending: return .none
        }
    }

    /// Attendees get Hang up only (S70 1 f).
    static func primaryAction(_ snapshot: CallPresenceSnapshot) -> CallNotificationActionKind {
        if snapshot.isAttendee { return .none }
        return snapshot.isMuted ? .unmute : .mute
    }

    static func showsChronometer(_ snapshot: CallPresenceSnapshot) -> Bool {
        snapshot.joinedAtMillis > 0 && snapshot.phase != .waiting && snapshot.phase != .connecting
    }

    /// Fields the person can see in the shade, or that change the foreground-service types.
    static func visibleFieldsChanged(old: CallPresenceSnapshot, new: CallPresenceSnapshot) -> Bool {
        old.presenceSession != new.presenceSession
            || old.title != new.title
            || old.isMuted != new.isMuted
            || old.isCameraOn != new.isCameraOn
            || old.isPresenting != new.isPresenting
            || old.isAttendee != new.isAttendee
            || statusKind(old) != statusKind(new)
            || showsChronometer(old) != showsChronometer(new)
            || old.joinedAtMillis != new.joinedAtMillis
    }

    /// The service starts when the phase leaves idle while Conclave is in the foreground (while-in-use types cannot
    /// start from the background, AND 15.3); a start the system refused is retried on the next foreground change.
    static func command(
        old: CallPresenceSnapshot,
        new: CallPresenceSnapshot,
        isAppActive: Bool,
        isRunning: Bool
    ) -> CallNotificationServiceCommand {
        // Phase A has no end reason: the service stops and the notification goes as the call starts ending.
        let wasActive = CallPresencePhasePolicy.isCallInProgress(old.phase)
        let isActive = CallPresencePhasePolicy.isCallInProgress(new.phase)
        if !isActive {
            // One stop per call end; later changes while the call tears down post nothing.
            return wasActive ? .stop : .none
        }
        if !isRunning {
            return isAppActive ? .start : .none
        }
        if !wasActive || visibleFieldsChanged(old: old, new: new) {
            return .update
        }
        return .none
    }
}
