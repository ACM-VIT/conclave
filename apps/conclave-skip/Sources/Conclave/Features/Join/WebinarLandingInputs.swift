import Foundation

// ENT-9 (S10 12 j, 0.5, 0.6 L7; RECONCILE R41; S10 Q7): the webinar attendee landing's shared contract. Transpiled
// Swift: String raw-value enums, scalar structs, no associated values, no tuples (S1C 3.6). The premeeting presenter
// publishes one `WebinarLandingSnapshot` for the landing on top (`PremeetingPresenter.webinar`); the lookup and the
// join reach the network and the core only through `WebinarLandingHooks` (production: `WebinarLandingProductionHooks`,
// the L9 fixture: scripted answers). Watching always takes one deliberate tap on Start Watching (Q7): nothing here
// joins on link arrival, and no path requests media, publishes, asks for host or prompts for a permission
// (invariant 6). No display strings: each platform maps the status, tag and action to its own copy.

/// The landing's state (S10 12 f, j). `almostThere` follows the socket connecting while joining.
enum WebinarLandingStatus: String, CaseIterable, Equatable {
    case loading, early
    /// Raw value "open"; the case name avoids the Kotlin `open` modifier, which breaks the transpiled enum entry.
    case openNow = "open"
    case joining, almostThere, waitingForHost, locked, full, unavailable, ended, cancelled, failed
}

/// The status tag over the title (S10 12 c `StatusTag`): Live (functional color plus the word), Starts Soon and Ended
/// (neutral), or none.
enum WebinarLandingTag: String, CaseIterable, Equatable {
    case none, live, startsSoon, ended
}

/// The one action a state offers (S10 12 f "Primary"): Start Watching in the bottom bar; Try Again and Back to Home
/// inside the status message (C14).
enum WebinarLandingAction: String, CaseIterable, Equatable {
    case none, startWatching, tryAgain, backHome
}

/// What a `failed` status failed at: the lookup ("Couldn't load this webinar.") or the join after Start Watching.
enum WebinarLandingFailure: String, CaseIterable, Equatable {
    case none, lookup, join
}

/// The landing snapshot (S10 12 j). Times are epoch milliseconds (0 = unknown) instead of `Date?`, so the handwritten
/// Compose screen reads plain scalars. `title` and `hostName` are "" when unknown (the views show "Join the Audience"
/// and "Hosted by the organizer"). `nameLimit` is `DisplayNamePolicy.limit` (40): the landing name becomes the guest
/// identity and the SFU truncates at 40 (RECONCILE R41). The countdown never lives here: the leaf ticks on its own, so
/// this snapshot never changes once a second (S10 12 k).
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
    /// The link Share Link sends and the calendar event carries.
    let link: String

    func withRevision(_ value: Int) -> WebinarLandingSnapshot {
        WebinarLandingSnapshot(revision: value, routeId: routeId, slug: slug, status: status, tag: tag, title: title,
                               hostName: hostName, startsAtMillis: startsAtMillis, endsAtMillis: endsAtMillis,
                               earlyEntryMinutes: earlyEntryMinutes, needsName: needsName, nameLimit: nameLimit,
                               needsInviteCode: needsInviteCode, inviteCodeInvalid: inviteCodeInvalid,
                               isPrimaryEnabled: isPrimaryEnabled, action: action, failure: failure, link: link)
    }
}

// MARK: - Lookup and join (hooks)

/// The three lookup answers the landing tells apart: a scheduled webinar, a plain webinar link with no schedule (the
/// API answers `scheduledWebinar: null`; web parity: open at once), and a failed request.
enum WebinarLookupOutcome: String, CaseIterable, Equatable {
    case found, notScheduled, failed
}

/// One `GET /api/webinars/by-slug/<slug>` answer as scalars (`NativeWebinarLookupService.lookup`). `status` is the
/// server's raw value ("scheduled", "live", "ended", "cancelled"; "" when absent).
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

/// The attendee join Start Watching sends (S10 12 j `startWatching()`): the production hook joins with
/// `joinMode: .webinarAttendee`, `isHost: false`, no socket display name, no room creation, microphone and camera off
/// (the view model's attendee guard), and records `title` as the attendee capsule's webinar title first (S20 SC22).
struct WebinarJoinRequest: Equatable {
    let routeId: Int
    let slug: String
    let displayName: String
    let isGuest: Bool
    let webinarInviteCode: String?
    let clientId: String?
    let title: String
}

/// The landing's only ways out to the network and the core. Nil members do nothing (tests, a fixture without them).
/// Main-actor isolated like `LobbyCoreHooks`: the presenter calls them and the production members reach the view model.
@MainActor
final class WebinarLandingHooks {
    /// `NativeWebinarLookupService.lookup(slug:clientId:)`; the second argument is the link's client id ("" = the
    /// app's tenant).
    var lookup: ((String, String) async -> WebinarLookupAnswer)? = nil
    /// The attendee join (`WebinarLandingProductionHooks`).
    var join: ((WebinarJoinRequest) -> Void)? = nil

    init() {
    }
}

/// The countdown leaf's parts (hours may exceed 24, like the iOS system timer text).
struct WebinarCountdown: Equatable {
    let hours: Int
    let minutes: Int
    let seconds: Int
}

// MARK: - Policy

/// The pure landing rules (S10 12 c, f, k; web parity WEB PRE-51 to PRE-53). Every time input is epoch milliseconds
/// from the presenter's clock, so tests pin it.
enum WebinarLandingPolicy {
    /// Refetch while the landing is visible and the app is active (S10 0.5 task table; web `WebinarLandingClient` 20 s).
    static let refetchIntervalMillis: Double = 20000.0
    static let minuteMillis: Double = 60000.0
    /// The calendar event's length when the webinar has no end time.
    static let defaultEventMillis: Double = 3600000.0

    /// When attendees may enter: the start less the early entry window, or 0 when the webinar has no start time.
    static func opensAtMillis(_ answer: WebinarLookupAnswer) -> Double {
        guard answer.startsAtMillis > 0.0 else { return 0.0 }
        return answer.startsAtMillis - Double(max(0, answer.earlyEntryMinutes)) * minuteMillis
    }

    /// The web `isOpen` (and the legacy `NativeScheduledWebinar.isOpenForAttendee`): ended and cancelled never open,
    /// live always is, no start time is open, otherwise from the early entry time on.
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

    /// The status the lookup alone gives (no join under way): nil is still loading.
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

    /// The one open wake-up (S10 0.5 task table): the time left until the early entry opens, or nil when nothing waits.
    static func openWakeDelayMillis(_ answer: WebinarLookupAnswer?, nowMillis: Double) -> Double? {
        guard let answer, lookupStatus(answer, nowMillis: nowMillis) == .early else { return nil }
        let opensAt = opensAtMillis(answer)
        guard opensAt > 0.0 else { return nil }
        return max(0.0, opensAt - nowMillis)
    }

    /// The tag for a status. "Live" needs the webinar to be live or started (a plain link counts as live); the early
    /// entry window before the start and the wait for the host read "Starts Soon".
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

    /// An attendee join failure (the S1 `joinFailed` outcome after Start Watching), from the classifier's category,
    /// code and clean server text (S10 12 f; SFU `joinRoom.ts` attendee errors): "Webinar is not live." waits for the
    /// host, "Webinar is locked." and "Webinar is full." say so, "Webinar is not enabled.", a non-attendee link or a
    /// missing room are unavailable, an ended room is ended; anything else is a failed join with Try Again.
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

    /// The view model's recoverable attendee form errors ("Enter the webinar invite code to join.", "Invalid webinar
    /// invite code. Check it and try again.") reveal the invite field.
    static func isInviteCodeError(_ message: String) -> Bool {
        message.lowercased().contains("invite code")
    }

    static func isInviteCodeInvalid(_ message: String) -> Bool {
        let lowered = message.lowercased()
        return lowered.contains("invite code") && lowered.contains("invalid")
    }

    /// A guest without a stored name types one (web `needsAttendeeName`); a signed-in account or a stored guest name
    /// joins as is.
    static func needsName(isSignedIn: Bool, accountName: String) -> Bool {
        !isSignedIn && DisplayNamePolicy.normalized(accountName).isEmpty
    }

    /// The name the join sends: the account's, the stored guest name, or the typed one (normalized, at most 40).
    static func displayName(isSignedIn: Bool, accountName: String, nameDraft: String) -> String {
        if isSignedIn || !DisplayNamePolicy.normalized(accountName).isEmpty {
            return DisplayNamePolicy.normalized(accountName)
        }
        return DisplayNamePolicy.normalized(nameDraft)
    }

    /// Start Watching is enabled while open, once a needed name exists (S10 12 f, l5) and a needed invite code is
    /// typed (or carried by the link).
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

    /// Whether the 20 s refetch runs in a status (web: never once ended or cancelled; never while joining). Early,
    /// open and the wait for the host keep it running, so the landing updates on its own (S10 12 f).
    static func refetches(_ status: WebinarLandingStatus) -> Bool {
        switch status {
        case .loading, .early, .openNow, .waitingForHost:
            return true
        case .joining, .almostThere, .locked, .full, .unavailable, .ended, .cancelled, .failed:
            return false
        }
    }

    /// Joining shows Cancel instead of Back (iOS toolbar, Android Close icon and BackHandler).
    static func isJoining(_ status: WebinarLandingStatus) -> Bool {
        status == .joining || status == .almostThere
    }

    /// Status changes VoiceOver and TalkBack announce once (S10 12 i): opening, the wait for the host and the end.
    static func announces(_ status: WebinarLandingStatus) -> Bool {
        status == .openNow || status == .waitingForHost || status == .ended || status == .cancelled
    }

    /// The countdown range's end, clamped (S10 12 c, l6): a `ClosedRange` traps when its lower bound passes its upper
    /// bound, which happens when the app wakes after the start before the status flips.
    static func countdownEndMillis(startsAtMillis: Double, nowMillis: Double) -> Double {
        max(startsAtMillis, nowMillis)
    }

    static func countdown(remainingMillis: Double) -> WebinarCountdown {
        let totalSeconds = remainingMillis <= 0.0 ? 0 : Int(remainingMillis / 1000.0)
        return WebinarCountdown(hours: totalSeconds / 3600, minutes: (totalSeconds % 3600) / 60, seconds: totalSeconds % 60)
    }

    /// The calendar event's end: the webinar's end, else one hour after the start.
    static func eventEndMillis(startsAtMillis: Double, endsAtMillis: Double) -> Double {
        endsAtMillis > startsAtMillis ? endsAtMillis : startsAtMillis + defaultEventMillis
    }

    /// The link Share Link sends: the server's canonical webinar link, else the default-tenant `/w/` link.
    static func shareLink(slug: String, serverLink: String) -> String {
        let trimmed = serverLink.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("https://") {
            return trimmed
        }
        return EntryPolicies.recentLink(roomId: slug, isWebinar: true)
    }
}
