import Foundation

@MainActor
final class CallKitMuteActionRouter {
    private var pending: [UUID: UUID] = [:]
    private var desired: [UUID: Bool] = [:]

    func register(actionId: UUID, callId: UUID, muted: Bool) {
        pending[actionId] = callId
        desired[callId] = muted
    }

    func discard(actionId: UUID) {
        pending.removeValue(forKey: actionId)
    }

    func end(callId: UUID) {
        pending = pending.filter { $0.value != callId }
        desired.removeValue(forKey: callId)
    }

    func reset() {
        pending = [:]
        desired = [:]
    }

    func desiredMute(callId: UUID) -> Bool? {
        desired[callId]
    }

    func handle(actionId: UUID, callId: UUID, muted: Bool, dispatch: (UUID, Bool) -> Bool) -> Bool {
        if pending.removeValue(forKey: actionId) == callId { return true }
        let previous = desired[callId]
        desired[callId] = muted
        let fulfilled = dispatch(callId, muted)
        if !fulfilled && desired[callId] == muted { desired[callId] = previous }
        return fulfilled
    }
}
