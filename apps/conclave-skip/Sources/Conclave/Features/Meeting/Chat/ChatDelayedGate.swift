import Foundation

// T3 borrow P7 (R/t3-borrow/PLAN.md; S40 6 f): a status line that never flickers. A status shows only after it has
// been wanted for 400 ms and, once shown, stays at least 400 ms; a different value while shown replaces it at once and
// starts a new hold. Some statuses are immediate (shown and cleared at once, no hold): the chat uses that for the first
// apply after init or reset and for the locked and attendee gates. The pattern comes from T3 Code's delayed status
// (written fresh here; no T3 code is copied). Generic on purpose: `value` is a raw value, so the stage reconnect banner
// can reuse the policy later. Shared and transpiled: String raw-value enums and scalar structs only, no tuples, no
// timers here (the caller owns one cancellable task that sleeps to `deadline`).

/// Where a delayed status stands.
enum DelayedStatusPhase: String, CaseIterable {
    /// Nothing is shown and nothing is waiting.
    case idle
    /// A value is wanted but not shown yet; it shows at `deadline` unless it goes away first.
    case pending
    /// A value is shown; it may not hide before `deadline` (the minimum visible time).
    case shown
}

/// One delayed status: the phase, the raw value it waits for or shows ("" when idle), and the deadline in
/// milliseconds on the caller's clock (pending: when the value shows; shown: the earliest time it may hide; idle: 0).
struct DelayedStatus: Equatable {
    let phase: DelayedStatusPhase
    let value: String
    let deadline: Double

    static let idle = DelayedStatus(phase: DelayedStatusPhase.idle, value: "", deadline: 0.0)
}

/// P7: the pure step function. The caller passes the value it wants now ("" for none) every time that value may have
/// changed and once more when a deadline it slept to has passed; `visible` is what the view draws.
enum DelayedStatusPolicy {
    /// A wanted value shows after this long (T3: 400 ms).
    static let showDelayMillis = 400.0
    /// A shown value stays at least this long (T3: 400 ms).
    static let minimumVisibleMillis = 400.0

    /// The next status for `value` at `now`.
    /// - Immediate values show at once with no hold (the same value already shown is kept), and an immediate ""
    ///   clears at once.
    /// - "" while pending clears at once (a blip never shows); "" while shown clears when the hold ends.
    /// - A value while idle starts pending; while pending it shows once the show deadline passed (a different value
    ///   while pending keeps the original show time, because the outage started then).
    /// - While shown, the same value keeps the status; a different value replaces it at once with a new hold (so an
    ///   outage that an immediate value masked, like offline under a chat lock, shows at once when the lock lifts: it
    ///   is not a new blip).
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

    /// The value to draw: the shown value, else "".
    static func visible(_ status: DelayedStatus) -> String {
        status.phase == DelayedStatusPhase.shown ? status.value : ""
    }

    /// When the caller's task must wake next for `status` while `value` is wanted, or -1 when no wake is needed:
    /// pending wakes at the show time; a shown value that is no longer wanted wakes when its hold ends.
    static func wakeDeadline(_ status: DelayedStatus, value: String, now: Double) -> Double {
        if status.phase == DelayedStatusPhase.pending { return status.deadline }
        if status.phase == DelayedStatusPhase.shown && status.value != value && status.deadline > now {
            return status.deadline
        }
        return -1.0
    }
}

/// S40 6 f: which gates draw the composer's status line (the copy in ChatCopy.gateLine and ChatCopyAndroid.gateLine).
/// Open, locked (the placeholder says it) and attendee (no composer) draw none.
enum ChatGateLinePolicy {
    static func showsLine(_ gate: ChatSendGate) -> Bool {
        gate == ChatSendGate.notJoined || gate == ChatSendGate.reconnecting || gate == ChatSendGate.offline
    }

    /// The delayed status value for a gate: "" for open, else the raw value.
    static func statusValue(_ gate: ChatSendGate) -> String {
        gate == ChatSendGate.open ? "" : gate.rawValue
    }

    /// Locked and attendee are never delayed (P7).
    static func isImmediate(_ gate: ChatSendGate) -> Bool {
        gate == ChatSendGate.locked || gate == ChatSendGate.attendee
    }
}
