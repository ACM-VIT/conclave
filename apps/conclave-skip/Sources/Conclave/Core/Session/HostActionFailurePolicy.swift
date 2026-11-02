import Foundation

enum HostActionFailure: String, CaseIterable, Equatable {
    case notJoined, notConnected, ackTimedOut, socketReplaced, rateLimited, notFound, superAdmin, notAllowed, invalidInput
    case rejectedByServer, renameRateLimited, renameDisabled, renameTooLong, unknown

    var isRenameRefusal: Bool {
        self == HostActionFailure.renameRateLimited || self == HostActionFailure.renameDisabled
            || self == HostActionFailure.renameTooLong
    }
}

enum HostActionResultKind: String, CaseIterable, Equatable {
    case completed, failed, interrupted, cancelled
}

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

enum HostActionFailurePolicy {

    static func failure(message: String) -> HostActionFailure {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.isEmpty { return HostActionFailure.unknown }

        if text.contains("changing your display name too quickly") { return HostActionFailure.renameRateLimited }
        if text.contains("display name updates are disabled") { return HostActionFailure.renameDisabled }
        if text.contains("display name too long") { return HostActionFailure.renameTooLong }

        if text.contains("super admin") { return HostActionFailure.superAdmin }

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

        if contains(text, ["not found", "already left", "identity not found"]) { return HostActionFailure.notFound }

        if contains(text, ["privileges required", "only hosts", "cannot be promoted", "cannot become host", "cannot kick yourself",
                           "watch-only attendees", "not allowed", "permission"]) {
            return HostActionFailure.notAllowed
        }
        if contains(text, ["invalid", "is required", "cannot be empty", "at least one"]) { return HostActionFailure.invalidInput }
        return HostActionFailure.rejectedByServer
    }

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
