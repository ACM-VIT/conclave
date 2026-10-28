import Foundation

// ENT-9 (S10 12 l, 0.6 L9): the webinar landing's Debug fixtures on the premeeting fixture route
// (`CONCLAVE_PREMEETING_FIXTURE=webinar-<state>`, Android `conclave.premeetingFixture`). Each opens the landing through
// the production link intake with a scripted lookup stub (no network) and, where a state is reached only after Start
// Watching, a scripted tap answered by a scripted join (no view model, no media, no call). Silent-testing rules hold:
// nothing joins, plays a sound or requests a permission. `PremeetingFixtureSession` applies the steps.

/// What the scripted join answers after Start Watching.
enum WebinarFixtureJoin: String, CaseIterable, Equatable {
    /// No scripted tap (the landing waits for a real one; a real tap shows Getting You In and stays).
    case none
    /// Getting You In, held.
    case connecting
    /// Almost There (the socket connected), held.
    case almostThere
    /// Getting You In, then the attendee call after 2 s (the call stand-in cross-fades in).
    case call
    /// The SFU attendee errors (`joinRoom.ts`): the wait for the host, locked, full, not enabled.
    case notLive, locked, full, notEnabled
}

enum WebinarLandingFixtureScript {
    static let slug = "design-systems-week"
    static let title = "Design Systems Week"
    static let hostName = "ACM-VIT"
    static let link = "https://conclave.acmvit.in/w/design-systems-week"
    static let guestName = "Avery"
    /// The scripted tap retries every half second until the landing is open (the lookup answers asynchronously).
    static let tapIntervalMillis = 500
    static let tapAttempts = 10
    static let outcomeDelayMillis = 600
    static let callDelayMillis = 2000
    /// The loading fixture's lookup never answers within a session.
    static let loadingDelayMillis: Double = 600000.0
    static let minuteMillis: Double = 60000.0
    static let hourMillis: Double = 3600000.0
    /// The early wireframe (S10 12 b): "Starts in 12:41", the lobby opening 10 minutes before.
    static let earlyStartOffsetMillis: Double = 761000.0
    /// S10 12 l6: an early landing that opens 20 s after launch (background the app past it, then return).
    static let shortStartOffsetMillis: Double = 20000.0

    static func isWebinarFixture(_ state: PremeetingFixtureState) -> Bool {
        state.rawValue.hasPrefix("webinar-")
    }

    /// The stored guest name the identity carries: none for the name fixture, so the landing asks for one.
    static func guestName(for state: PremeetingFixtureState) -> String {
        state == .webinarNameNeeded ? "" : guestName
    }

    /// S10 12 l7 (Android): Add to calendar behaves as if no calendar app resolves.
    static func disablesCalendarResolver(_ state: PremeetingFixtureState) -> Bool {
        state == .webinarNoCalendar
    }

    static func lookupDelayMillis(for state: PremeetingFixtureState) -> Double {
        state == .webinarLoading ? loadingDelayMillis : 0.0
    }

    static func join(for state: PremeetingFixtureState) -> WebinarFixtureJoin {
        switch state {
        case .webinarJoining:
            return .connecting
        case .webinarAlmostThere:
            return .almostThere
        case .webinarToCall:
            return .call
        case .webinarWaitingHost:
            return .notLive
        case .webinarLocked:
            return .locked
        case .webinarFull:
            return .full
        case .webinarUnavailable:
            return .notEnabled
        default:
            return .none
        }
    }

    /// The scripted lookup answer, relative to the session's start (so a refetch never moves the start time).
    static func answer(for state: PremeetingFixtureState, startedAtMillis t0: Double) -> WebinarLookupAnswer {
        switch state {
        case .webinarFailed:
            return WebinarLookupAnswer.lookupFailed
        case .webinarEarly, .webinarNoCalendar:
            return found(status: "scheduled", startsAt: t0 + earlyStartOffsetMillis,
                         endsAt: t0 + earlyStartOffsetMillis + hourMillis, earlyMinutes: 10, requiresInviteCode: false)
        case .webinarEarlyOneMinute:
            return found(status: "scheduled", startsAt: t0 + earlyStartOffsetMillis,
                         endsAt: t0 + earlyStartOffsetMillis + hourMillis, earlyMinutes: 1, requiresInviteCode: false)
        case .webinarEarlyShort:
            return found(status: "scheduled", startsAt: t0 + shortStartOffsetMillis,
                         endsAt: t0 + shortStartOffsetMillis + hourMillis, earlyMinutes: 0, requiresInviteCode: false)
        case .webinarEnded:
            return found(status: "ended", startsAt: t0 - 2.0 * hourMillis, endsAt: t0 - hourMillis, earlyMinutes: 10,
                         requiresInviteCode: false)
        case .webinarCancelled:
            return found(status: "cancelled", startsAt: t0 + 24.0 * hourMillis, endsAt: t0 + 25.0 * hourMillis,
                         earlyMinutes: 10, requiresInviteCode: false)
        case .webinarInviteCode:
            return found(status: "live", startsAt: t0 - 5.0 * minuteMillis, endsAt: t0 + 55.0 * minuteMillis,
                         earlyMinutes: 10, requiresInviteCode: true)
        default:
            return found(status: "live", startsAt: t0 - 5.0 * minuteMillis, endsAt: t0 + 55.0 * minuteMillis,
                         earlyMinutes: 10, requiresInviteCode: false)
        }
    }

    static func found(status: String, startsAt: Double, endsAt: Double, earlyMinutes: Int,
                      requiresInviteCode: Bool) -> WebinarLookupAnswer {
        WebinarLookupAnswer(outcome: WebinarLookupOutcome.found, title: title, hostName: hostName, status: status,
                            startsAtMillis: startsAt, endsAtMillis: endsAt, earlyEntryMinutes: earlyMinutes,
                            requiresInviteCode: requiresInviteCode, link: link)
    }

    /// The landing fixtures' premeeting inputs: the attendee join mode and the guest name; `socketConnected` is the
    /// Almost There input, the failure class the scripted join failure's.
    static func base(guestName: String, socketConnected: Bool = false, joinFailureCategory: String = "",
                     joinFailureCode: String = "") -> PremeetingInputs {
        PremeetingInputs.make(
            currentRoomId: slug,
            currentJoinMode: JoinMode.webinarAttendee,
            accountName: guestName,
            isAppActive: true,
            joinFailureCategory: joinFailureCategory,
            joinFailureCode: joinFailureCode,
            entrySocketConnected: socketConnected
        )
    }

    static func connecting(guestName: String) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: PremeetingFixtureScript.identity, connectionState: ConnectionState.connecting,
                                roomId: slug, displayName: guestName, isWebinarAttendee: true, isMuted: true,
                                isCameraOff: true)
    }

    static func joined(guestName: String) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: PremeetingFixtureScript.identity, connectionState: ConnectionState.joined,
                                roomId: slug, displayName: guestName, isWebinarAttendee: true, isMuted: true,
                                isCameraOff: true)
    }

    /// An initial join failure with the SFU's sentence (the classifier keeps clean sentences as the server text).
    static func failed(guestName: String, serverText: String, outcomeId: Int) -> MeetingShellInputs {
        let outcome = MeetingTerminalOutcome(id: outcomeId, callSession: PremeetingFixtureScript.identity.callSession,
                                             kind: MeetingTerminalOutcomeKind.joinFailed, serverText: serverText)
        return MeetingShellInputs.make(identity: PremeetingFixtureScript.identity, connectionState: ConnectionState.error,
                                       roomId: slug, displayName: guestName, isWebinarAttendee: true,
                                       terminalOutcome: outcome)
    }

    static func serverText(_ join: WebinarFixtureJoin) -> String {
        switch join {
        case .notLive:
            return "Webinar is not live."
        case .locked:
            return "Webinar is locked."
        case .full:
            return "Webinar is full."
        case .notEnabled:
            return "Webinar is not enabled."
        case .none, .connecting, .almostThere, .call:
            return ""
        }
    }

    /// The classifier's category for each sentence (`MeetingErrorClassifier.classify(serverMessage:context:)`: "locked"
    /// is its own row; a clean sentence no row knows becomes `rejectedByServer` and keeps its text).
    static func failureCategory(_ join: WebinarFixtureJoin) -> String {
        join == .locked ? MeetingErrorCategory.lockedByHost.rawValue : MeetingErrorCategory.rejectedByServer.rawValue
    }

    static func failureCode(_ join: WebinarFixtureJoin) -> String {
        join == .locked ? "message.locked" : "message.unrecognized"
    }

    static func endsInFailure(_ join: WebinarFixtureJoin) -> Bool {
        join == .notLive || join == .locked || join == .full || join == .notEnabled
    }
}
