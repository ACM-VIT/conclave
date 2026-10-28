import Foundation

enum WebinarFixtureJoin: String, CaseIterable, Equatable {

    case none

    case connecting

    case almostThere

    case call

    case notLive, locked, full, notEnabled
}

enum WebinarLandingFixtureScript {
    static let slug = "design-systems-week"
    static let title = "Design Systems Week"
    static let hostName = "ACM-VIT"
    static let link = "https://conclave.acmvit.in/w/design-systems-week"
    static let guestName = "Avery"

    static let tapIntervalMillis = 500
    static let tapAttempts = 10
    static let outcomeDelayMillis = 600
    static let callDelayMillis = 2000

    static let loadingDelayMillis: Double = 600000.0
    static let minuteMillis: Double = 60000.0
    static let hourMillis: Double = 3600000.0

    static let earlyStartOffsetMillis: Double = 761000.0

    static let shortStartOffsetMillis: Double = 20000.0

    static func isWebinarFixture(_ state: PremeetingFixtureState) -> Bool {
        state.rawValue.hasPrefix("webinar-")
    }

    static func guestName(for state: PremeetingFixtureState) -> String {
        state == .webinarNameNeeded ? "" : guestName
    }

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
