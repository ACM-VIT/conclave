import Foundation

// S50 PH16 (PPL-2, core): one typed failure for every host action and the rename intent, mapped from the SFU's
// English error strings and the transport errors on both platforms, so no raw server or transport text ever reaches
// the People, Host Controls or Settings views (INM D: the Android event-name leaks). Shared (transpiled) Swift under
// the S1C 3.6 rules: String raw-value enums and scalar structs only.
//
// Evidence (packages/sfu/server): `socket/handlers/displayNameHandlers.ts:26-91` (rename refusals),
// `socket/handlers/adminHandlers.ts:139-151` (admin guard), `:385-427` (kick and producer), `:677-782` (promote and
// transfer), `:906-1211` (access lists and the waiting room), `admin/moderation.ts:5` (super admin).

/// PH16. Raw values cross into `HostActionResult.failure` and `HostActionFailureModel.failure`; "" means none.
enum HostActionFailure: String, CaseIterable, Equatable {
    case notJoined, notConnected, ackTimedOut, socketReplaced, rateLimited, notFound, superAdmin, notAllowed, invalidInput
    case rejectedByServer, renameRateLimited, renameDisabled, renameTooLong, unknown

    /// The three rename refusals the People alert and the Settings field show in place (S50 3 c, 3 d; S60 C6-10).
    var isRenameRefusal: Bool {
        self == HostActionFailure.renameRateLimited || self == HostActionFailure.renameDisabled
            || self == HostActionFailure.renameTooLong
    }
}

/// How a host action ended (S50 0.5). `cancelled` covers the core's inner-guard rejection (PH2) and a cancelled
/// task; `interrupted` a call context change after the dispatch. Neither publishes feedback.
enum HostActionResultKind: String, CaseIterable, Equatable {
    case completed, failed, interrupted, cancelled
}

/// The core's report for one ticket. `failure` is a `HostActionFailure` raw value or "": server text never crosses
/// into a presenter.
struct HostActionResult: Equatable {
    let kind: HostActionResultKind
    let failure: String

    static let completed = HostActionResult(kind: HostActionResultKind.completed, failure: "")
    static let interrupted = HostActionResult(kind: HostActionResultKind.interrupted, failure: "")
    static let cancelled = HostActionResult(kind: HostActionResultKind.cancelled, failure: "")

    static func failed(_ failure: HostActionFailure) -> HostActionResult {
        HostActionResult(kind: HostActionResultKind.failed, failure: failure.rawValue)
    }

    var typedFailure: HostActionFailure? { HostActionFailure(rawValue: failure) }
}

/// PH16: the one mapping table. Specific SFU sentences first (rename, super admin, rate limit, not found, refusals,
/// invalid input), then the shared classifier's typed evidence (timeouts, a replaced socket, offline). Pure.
enum HostActionFailurePolicy {
    /// The failure for an SFU or transport message (the text of `MeetingActionResponseError`, iOS `SocketError`,
    /// Kotlin `ErrorException`).
    static func failure(message: String) -> HostActionFailure {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.isEmpty { return HostActionFailure.unknown }
        // Rename refusals (displayNameHandlers.ts:40, :56, :67).
        if text.contains("changing your display name too quickly") { return HostActionFailure.renameRateLimited }
        if text.contains("display name updates are disabled") { return HostActionFailure.renameDisabled }
        if text.contains("display name too long") { return HostActionFailure.renameTooLong }
        // moderation.ts:5.
        if text.contains("super admin") { return HostActionFailure.superAdmin }
        // adminHandlers.ts:151, :679 and the generic rate limiter.
        if contains(text, ["too many admin requests", "too many requests", "rate limit", "too quickly", "retry shortly"]) {
            return HostActionFailure.rateLimited
        }
        if text.contains("socket changed before") { return HostActionFailure.socketReplaced }
        if contains(text, ["timed out", "timeout"]) { return HostActionFailure.ackTimedOut }
        if contains(text, ["not in a room", "room not found", "reconnect to use host controls", "reconnect before"]) {
            return HostActionFailure.notJoined
        }
        if contains(text, ["not connected", "socket is not connected", "no internet", "network is unreachable", "offline"]) {
            return HostActionFailure.notConnected
        }
        // adminHandlers.ts:404, :427, :703, :765, :1141, :1177, :1211.
        if contains(text, ["not found", "already left", "identity not found"]) { return HostActionFailure.notFound }
        // adminHandlers.ts:143, :389, :691, :707, :769; displayNameHandlers.ts:33.
        if contains(text, ["privileges required", "only hosts", "cannot be promoted", "cannot become host", "cannot kick yourself",
                           "watch-only attendees", "not allowed", "permission"]) {
            return HostActionFailure.notAllowed
        }
        if contains(text, ["invalid", "is required", "cannot be empty", "at least one"]) { return HostActionFailure.invalidInput }
        return HostActionFailure.rejectedByServer
    }

    /// The failure for a thrown error: the specific sentence table on the error text, then the classifier's typed
    /// categories for transport evidence the text does not name.
    static func failure(error: Error) -> HostActionFailure {
        let byMessage = failure(message: error.localizedDescription)
        if byMessage != HostActionFailure.rejectedByServer && byMessage != HostActionFailure.unknown {
            return byMessage
        }
        let classified = MeetingErrorClassifier.classify(error, context: MeetingErrorContext.hostAction)
        if classified.diagnosticCode == "socket.replaced" { return HostActionFailure.socketReplaced }
        switch classified.category {
        case .timedOut:
            return HostActionFailure.ackTimedOut
        case .offline, .serverUnreachable:
            return HostActionFailure.notConnected
        case .notJoined:
            return HostActionFailure.notJoined
        case .rateLimited:
            return HostActionFailure.rateLimited
        case .roleRequired, .attendeeOnly, .lockedByHost, .disabledByHost:
            return HostActionFailure.notAllowed
        case .invalidInput:
            return HostActionFailure.invalidInput
        default:
            return byMessage
        }
    }

    /// The ticket result for a thrown error: a cancellation is `cancelled` (no feedback), anything else a typed failure.
    static func result(for error: Error) -> HostActionResult {
        let classified = MeetingErrorClassifier.classify(error, context: MeetingErrorContext.hostAction)
        if classified.category == MeetingErrorCategory.cancelled { return HostActionResult.cancelled }
        return HostActionResult.failed(failure(error: error))
    }

    private static func contains(_ text: String, _ needles: [String]) -> Bool {
        for needle in needles {
            if text.contains(needle) { return true }
        }
        return false
    }
}
