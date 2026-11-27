import Foundation

struct NativeRoomRecoveryPass {
    struct Scope: Equatable {
        let roomId: String
        let clientId: String
        let userId: String
        let sessionId: String
    }

    private struct Membership {
        let scope: Scope
        let resolvedRoomId: String
        let attempt: UUID
        let pass: String?
    }

    private var membership: Membership?

    mutating func clear() {
        membership = nil
    }

    mutating func beginJoin(scope: Scope?, isRecovery: Bool) -> String? {
        guard isRecovery, let scope, membership?.scope == scope else {
            clear()
            return nil
        }
        return membership?.pass
    }

    mutating func accept(_ response: JoinRoomResponse, scope: Scope?, attempt: UUID) {
        guard response.status == "joined", response.webinarRole != "attendee",
              let scope, let roomId = NativeRoomIdNormalizer.normalize(response.roomId) else {
            clear()
            return
        }
        membership = Membership(scope: scope, resolvedRoomId: roomId, attempt: attempt,
                                pass: Self.validated(response.roomRecoveryPass))
    }

    mutating func renew(_ notification: RoomRecoveryPassNotification, attempt: UUID) {
        guard let current = membership, current.attempt == attempt,
              NativeRoomIdNormalizer.matches(notification.roomId, current.resolvedRoomId),
              let pass = Self.validated(notification.roomRecoveryPass) else { return }
        membership = Membership(scope: current.scope, resolvedRoomId: current.resolvedRoomId, attempt: attempt, pass: pass)
    }

    private static func validated(_ pass: String?) -> String? {
        guard let pass, !pass.isEmpty, pass.utf8.count <= 2048,
              pass == pass.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        return pass
    }
}
