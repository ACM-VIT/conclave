import Foundation

enum DelayedStatusPhase: String, CaseIterable {

    case idle

    case pending

    case shown
}

struct DelayedStatus: Equatable {
    let phase: DelayedStatusPhase
    let value: String
    let deadline: Double

    static let idle = DelayedStatus(phase: DelayedStatusPhase.idle, value: "", deadline: 0.0)
}

enum DelayedStatusPolicy {

    static let showDelayMillis = 400.0

    static let minimumVisibleMillis = 400.0

    static func step(_ current: DelayedStatus, value: String, isImmediate: Bool, now: Double) -> DelayedStatus {
        if isImmediate {
            if value.isEmpty { return DelayedStatus.idle }
            if current.phase == DelayedStatusPhase.shown && current.value == value {
                return current
            }
            return DelayedStatus(phase: DelayedStatusPhase.shown, value: value, deadline: now)
        }
        if value.isEmpty {
            if current.phase == DelayedStatusPhase.shown && now < current.deadline {
                return current
            }
            return DelayedStatus.idle
        }
        if current.phase == DelayedStatusPhase.shown {
            if current.value == value { return current }
            return DelayedStatus(phase: DelayedStatusPhase.shown, value: value, deadline: now + minimumVisibleMillis)
        }
        if current.phase == DelayedStatusPhase.pending {
            if now >= current.deadline {
                return DelayedStatus(phase: DelayedStatusPhase.shown, value: value, deadline: now + minimumVisibleMillis)
            }
            return DelayedStatus(phase: DelayedStatusPhase.pending, value: value, deadline: current.deadline)
        }
        return DelayedStatus(phase: DelayedStatusPhase.pending, value: value, deadline: now + showDelayMillis)
    }

    static func visible(_ status: DelayedStatus) -> String {
        status.phase == DelayedStatusPhase.shown ? status.value : ""
    }

    static func wakeDeadline(_ status: DelayedStatus, value: String, now: Double) -> Double {
        if status.phase == DelayedStatusPhase.pending { return status.deadline }
        if status.phase == DelayedStatusPhase.shown && status.value != value && status.deadline > now {
            return status.deadline
        }
        return -1.0
    }
}

enum ChatGateLinePolicy {
    static func showsLine(_ gate: ChatSendGate) -> Bool {
        gate == ChatSendGate.notJoined || gate == ChatSendGate.reconnecting || gate == ChatSendGate.offline
    }

    static func statusValue(_ gate: ChatSendGate) -> String {
        gate == ChatSendGate.allowed ? "" : gate.rawValue
    }

    static func isImmediate(_ gate: ChatSendGate) -> Bool {
        gate == ChatSendGate.locked || gate == ChatSendGate.attendee
    }
}
