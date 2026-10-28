import Foundation

enum CallNotificationStatusKind: String, CaseIterable, Equatable {
    case none, waiting, joining, reconnecting, onHold
}

enum CallNotificationActionKind: String, CaseIterable, Equatable {
    case none, mute, unmute
}

enum CallNotificationServiceCommand: String, CaseIterable, Equatable {
    case none, start, update, stop
}

enum NotificationPostPolicy {
    static let notificationId = 1

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

    static func primaryAction(_ snapshot: CallPresenceSnapshot) -> CallNotificationActionKind {
        if snapshot.isAttendee { return .none }
        return snapshot.isMuted ? .unmute : .mute
    }

    static func showsChronometer(_ snapshot: CallPresenceSnapshot) -> Bool {
        snapshot.joinedAtMillis > 0 && snapshot.phase != .waiting && snapshot.phase != .connecting
    }

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

    static func command(
        old: CallPresenceSnapshot,
        new: CallPresenceSnapshot,
        isAppActive: Bool,
        isRunning: Bool
    ) -> CallNotificationServiceCommand {

        let wasActive = CallPresencePhasePolicy.isCallInProgress(old.phase)
        let isActive = CallPresencePhasePolicy.isCallInProgress(new.phase)
        if !isActive {

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
