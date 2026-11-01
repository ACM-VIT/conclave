import Foundation

enum WebinarLandingStatus: String, CaseIterable, Equatable {
    case loading, early

    case openNow = "open"
    case joining, almostThere, waitingForHost, locked, full, unavailable, ended, cancelled, failed
}

enum WebinarLandingTag: String, CaseIterable, Equatable {
    case none, live, startsSoon, ended
}

enum WebinarLandingAction: String, CaseIterable, Equatable {
    case none, startWatching, tryAgain, backHome
}

enum WebinarLandingFailure: String, CaseIterable, Equatable {
    case none, lookup, join
}

struct WebinarLandingSnapshot: Equatable {
    let revision: Int
    let routeId: Int
    let slug: String
    let status: WebinarLandingStatus
    let tag: WebinarLandingTag
    let title: String
    let hostName: String
    let startsAtMillis: Double
    let endsAtMillis: Double
    let earlyEntryMinutes: Int
    let needsName: Bool
    let nameLimit: Int
    let needsInviteCode: Bool
    let inviteCodeInvalid: Bool
    let isPrimaryEnabled: Bool
    let action: WebinarLandingAction
    let failure: WebinarLandingFailure

    let link: String

    func withRevision(_ value: Int) -> WebinarLandingSnapshot {
        WebinarLandingSnapshot(revision: value, routeId: routeId, slug: slug, status: status, tag: tag, title: title,
                               hostName: hostName, startsAtMillis: startsAtMillis, endsAtMillis: endsAtMillis,
                               earlyEntryMinutes: earlyEntryMinutes, needsName: needsName, nameLimit: nameLimit,
                               needsInviteCode: needsInviteCode, inviteCodeInvalid: inviteCodeInvalid,
                               isPrimaryEnabled: isPrimaryEnabled, action: action, failure: failure, link: link)
    }
}

enum WebinarLookupOutcome: String, CaseIterable, Equatable {
    case found, notScheduled, failed
}

struct WebinarLookupAnswer: Equatable {
    let outcome: WebinarLookupOutcome
    let title: String
    let hostName: String
    let status: String
    let startsAtMillis: Double
    let endsAtMillis: Double
    let earlyEntryMinutes: Int
    let requiresInviteCode: Bool
    let link: String

    static let lookupFailed = WebinarLookupAnswer(outcome: WebinarLookupOutcome.failed, title: "", hostName: "", status: "",
                                                  startsAtMillis: 0.0, endsAtMillis: 0.0, earlyEntryMinutes: 0,
                                                  requiresInviteCode: false, link: "")
    static let unscheduled = WebinarLookupAnswer(outcome: WebinarLookupOutcome.notScheduled, title: "", hostName: "",
                                                 status: "", startsAtMillis: 0.0, endsAtMillis: 0.0, earlyEntryMinutes: 0,
                                                 requiresInviteCode: false, link: "")
}

struct WebinarJoinRequest: Equatable {
    let routeId: Int
    let slug: String
    let displayName: String
    let isGuest: Bool
    let webinarInviteCode: String?
    let clientId: String?
    let title: String
}

@MainActor
final class WebinarLandingHooks {

    var lookup: ((String, String) async -> WebinarLookupAnswer)? = nil

    var join: ((WebinarJoinRequest) -> Void)? = nil

    init() {
    }
}

struct WebinarCountdown: Equatable {
    let hours: Int
    let minutes: Int
    let seconds: Int
}

enum WebinarLandingPolicy {

    static let refetchIntervalMillis: Double = 20000.0
    static let minuteMillis: Double = 60000.0

    static let defaultEventMillis: Double = 3600000.0

    static func opensAtMillis(_ answer: WebinarLookupAnswer) -> Double {
        guard answer.startsAtMillis > 0.0 else { return 0.0 }
        return answer.startsAtMillis - Double(max(0, answer.earlyEntryMinutes)) * minuteMillis
    }

    static func isOpen(_ answer: WebinarLookupAnswer, nowMillis: Double) -> Bool {
        let status = answer.status.lowercased()
        if status == "ended" || status == "cancelled" {
            return false
        }
        if status == "live" {
            return true
        }
        guard answer.startsAtMillis > 0.0 else { return true }
        return nowMillis >= opensAtMillis(answer)
    }

    static func lookupStatus(_ answer: WebinarLookupAnswer?, nowMillis: Double) -> WebinarLandingStatus {
        guard let answer else { return .loading }
        switch answer.outcome {
        case .failed:
            return .failed
        case .notScheduled:
            return .openNow
        case .found:
            let status = answer.status.lowercased()
            if status == "ended" {
                return .ended
            }
            if status == "cancelled" {
                return .cancelled
            }
            return isOpen(answer, nowMillis: nowMillis) ? WebinarLandingStatus.openNow : WebinarLandingStatus.early
        }
    }

    static func openWakeDelayMillis(_ answer: WebinarLookupAnswer?, nowMillis: Double) -> Double? {
        guard let answer, lookupStatus(answer, nowMillis: nowMillis) == .early else { return nil }
        let opensAt = opensAtMillis(answer)
        guard opensAt > 0.0 else { return nil }
        return max(0.0, opensAt - nowMillis)
    }

    static func tag(status: WebinarLandingStatus, answer: WebinarLookupAnswer?, nowMillis: Double) -> WebinarLandingTag {
        switch status {
        case .loading, .failed, .locked, .full, .unavailable:
            return .none
        case .ended, .cancelled:
            return .ended
        case .early, .waitingForHost:
            return .startsSoon
        case .openNow, .joining, .almostThere:
            guard let answer, answer.outcome == .found else { return .live }
            if answer.status.lowercased() == "live" || answer.startsAtMillis <= 0.0 || nowMillis >= answer.startsAtMillis {
                return .live
            }
            return .startsSoon
        }
    }

    static func joinFailureStatus(category: String, diagnosticCode: String, serverText: String) -> WebinarLandingStatus {
        let text = serverText.lowercased()
        if text.contains("not live") {
            return .waitingForHost
        }
        if category == MeetingErrorCategory.lockedByHost.rawValue || text.contains("locked") {
            return .locked
        }
        if text.contains("is full") {
            return .full
        }
        if text.contains("not enabled") || category == MeetingErrorCategory.attendeeOnly.rawValue
            || category == MeetingErrorCategory.roomNotFound.rawValue {
            return .unavailable
        }
        if category == MeetingErrorCategory.roomEnded.rawValue {
            return .ended
        }
        return .failed
    }

    static func isInviteCodeError(_ message: String) -> Bool {
        message.lowercased().contains("invite code")
    }

    static func isInviteCodeInvalid(_ message: String) -> Bool {
        let lowered = message.lowercased()
        return lowered.contains("invite code") && lowered.contains("invalid")
    }

    static func needsName(isSignedIn: Bool, accountName: String) -> Bool {
        !isSignedIn && DisplayNamePolicy.normalized(accountName).isEmpty
    }

    static func displayName(isSignedIn: Bool, accountName: String, nameDraft: String) -> String {
        if isSignedIn || !DisplayNamePolicy.normalized(accountName).isEmpty {
            return DisplayNamePolicy.normalized(accountName)
        }
        return DisplayNamePolicy.normalized(nameDraft)
    }

    static func isPrimaryEnabled(status: WebinarLandingStatus, needsName: Bool, nameDraft: String, needsInviteCode: Bool,
                                 inviteDraft: String, linkHasInviteCode: Bool) -> Bool {
        guard status == .openNow else { return false }
        if needsName && DisplayNamePolicy.normalized(nameDraft).isEmpty {
            return false
        }
        if needsInviteCode && !linkHasInviteCode && inviteDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return false
        }
        return true
    }

    static func action(_ status: WebinarLandingStatus) -> WebinarLandingAction {
        switch status {
        case .openNow:
            return .startWatching
        case .failed:
            return .tryAgain
        case .locked, .full, .unavailable, .ended, .cancelled:
            return .backHome
        case .loading, .early, .joining, .almostThere, .waitingForHost:
            return .none
        }
    }

    static func refetches(_ status: WebinarLandingStatus) -> Bool {
        switch status {
        case .loading, .early, .openNow, .waitingForHost:
            return true
        case .joining, .almostThere, .locked, .full, .unavailable, .ended, .cancelled, .failed:
            return false
        }
    }

    static func isJoining(_ status: WebinarLandingStatus) -> Bool {
        status == .joining || status == .almostThere
    }

    static func announces(_ status: WebinarLandingStatus) -> Bool {
        status == .openNow || status == .waitingForHost || status == .ended || status == .cancelled
    }

    static func countdownEndMillis(startsAtMillis: Double, nowMillis: Double) -> Double {
        max(startsAtMillis, nowMillis)
    }

    static func countdown(remainingMillis: Double) -> WebinarCountdown {
        let totalSeconds = remainingMillis <= 0.0 ? 0 : Int(remainingMillis / 1000.0)
        return WebinarCountdown(hours: totalSeconds / 3600, minutes: (totalSeconds % 3600) / 60, seconds: totalSeconds % 60)
    }

    static func eventEndMillis(startsAtMillis: Double, endsAtMillis: Double) -> Double {
        endsAtMillis > startsAtMillis ? endsAtMillis : startsAtMillis + defaultEventMillis
    }

    static func shareLink(slug: String, serverLink: String) -> String {
        let trimmed = serverLink.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("https://") {
            return trimmed
        }
        return EntryPolicies.recentLink(roomId: slug, isWebinar: true)
    }
}
