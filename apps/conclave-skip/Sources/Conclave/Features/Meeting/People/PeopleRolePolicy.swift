import Foundation

struct PeopleRoleState: Equatable {
    let callSession: Int
    let attempt: Int
    let viewerRole: PersonRole

    let hostUserId: String

    let hostName: String
    let isWebinarEnabled: Bool
    let isWebinarQaEnabled: Bool

    let blockedReason: String

    static func make(callSession: Int = 1, attempt: Int = 1, viewerRole: PersonRole = PersonRole.participant,
                     hostUserId: String = "", hostName: String = "", isWebinarEnabled: Bool = false,
                     isWebinarQaEnabled: Bool = false,
                     blockedReason: String = MeetingBlockedReason.none.rawValue) -> PeopleRoleState {
        PeopleRoleState(callSession: callSession, attempt: attempt, viewerRole: viewerRole, hostUserId: hostUserId,
                        hostName: hostName, isWebinarEnabled: isWebinarEnabled, isWebinarQaEnabled: isWebinarQaEnabled,
                        blockedReason: blockedReason)
    }

    static func from(_ inputs: PeopleInputs) -> PeopleRoleState {
        let name = inputs.participant(inputs.hostUserId)?.displayName ?? ""
        return PeopleRoleState(
            callSession: inputs.callSession,
            attempt: inputs.attempt,
            viewerRole: PeopleOrderPolicy.viewerRole(inputs),
            hostUserId: inputs.hostUserId,
            hostName: name.trimmingCharacters(in: .whitespacesAndNewlines),
            isWebinarEnabled: inputs.isWebinarEnabled,
            isWebinarQaEnabled: inputs.isWebinarQaEnabled,
            blockedReason: PeopleRowPolicy.blockedReason(phase: inputs.phase, isNetworkOffline: inputs.isNetworkOffline).rawValue
        )
    }

    var isRecovering: Bool { blockedReason != MeetingBlockedReason.none.rawValue }
}

enum PeopleRoleChangeKind: String, CaseIterable, Equatable {
    case becameHost, lostHost, hostMoved, becameAttendee, sessionChanged, attemptChanged, recoveryStarted
    case webinarOff, qaOff
}

struct PeopleRoleEffects: Equatable {

    let kinds: [String]

    let dismissesPanels: Bool

    let popsHostPages: Bool

    let showsLostHostNotice: Bool

    let clearsHostConfirmations: Bool

    let closesMakeHostDialog: Bool

    let interruptsHostTickets: Bool

    let interruptsAllTickets: Bool

    let clearsDrafts: Bool

    let disablesConfirmations: Bool

    let popsWebinarPages: Bool

    let closesQaPanel: Bool

    let announcesQaOff: Bool

    let refreshesHostConfig: Bool

    let announcement: String
    let announcementName: String

    static let none = PeopleRoleEffects(kinds: [], dismissesPanels: false, popsHostPages: false, showsLostHostNotice: false,
                                        clearsHostConfirmations: false, closesMakeHostDialog: false,
                                        interruptsHostTickets: false, interruptsAllTickets: false, clearsDrafts: false,
                                        disablesConfirmations: false, popsWebinarPages: false, closesQaPanel: false,
                                        announcesQaOff: false, refreshesHostConfig: false, announcement: "",
                                        announcementName: "")

    func has(_ kind: PeopleRoleChangeKind) -> Bool { kinds.contains(kind.rawValue) }
}

enum PeopleRolePolicy {
    static func effects(previous: PeopleRoleState, next: PeopleRoleState) -> PeopleRoleEffects {
        if previous.callSession == 0 { return PeopleRoleEffects.none }
        if next.callSession != previous.callSession {
            return PeopleRoleEffects(kinds: [PeopleRoleChangeKind.sessionChanged.rawValue], dismissesPanels: false,
                                     popsHostPages: true, showsLostHostNotice: false, clearsHostConfirmations: true,
                                     closesMakeHostDialog: true, interruptsHostTickets: true, interruptsAllTickets: true,
                                     clearsDrafts: true, disablesConfirmations: false, popsWebinarPages: true,
                                     closesQaPanel: false, announcesQaOff: false, refreshesHostConfig: false,
                                     announcement: "", announcementName: "")
        }
        var kinds: [String] = []
        let wasHost = previous.viewerRole.isHostRole
        let isHost = next.viewerRole.isHostRole
        let becameAttendee = previous.viewerRole != PersonRole.attendee && next.viewerRole == PersonRole.attendee
        let lostHost = wasHost && !isHost
        if !wasHost && isHost { kinds.append(PeopleRoleChangeKind.becameHost.rawValue) }
        if lostHost { kinds.append(PeopleRoleChangeKind.lostHost.rawValue) }
        let hostMoved = !previous.hostUserId.isEmpty && !next.hostUserId.isEmpty && previous.hostUserId != next.hostUserId
        if hostMoved { kinds.append(PeopleRoleChangeKind.hostMoved.rawValue) }
        if becameAttendee { kinds.append(PeopleRoleChangeKind.becameAttendee.rawValue) }
        let attemptChanged = previous.attempt != 0 && next.attempt != previous.attempt
        if attemptChanged { kinds.append(PeopleRoleChangeKind.attemptChanged.rawValue) }
        let recoveryStarted = !previous.isRecovering && next.isRecovering
        if recoveryStarted { kinds.append(PeopleRoleChangeKind.recoveryStarted.rawValue) }
        let webinarOff = previous.isWebinarEnabled && !next.isWebinarEnabled
        if webinarOff { kinds.append(PeopleRoleChangeKind.webinarOff.rawValue) }
        let qaOff = previous.isWebinarEnabled && next.isWebinarEnabled && previous.isWebinarQaEnabled && !next.isWebinarQaEnabled
        if qaOff { kinds.append(PeopleRoleChangeKind.qaOff.rawValue) }
        if kinds.isEmpty { return PeopleRoleEffects.none }

        let announcesHost = hostMoved && !next.hostName.isEmpty && next.viewerRole != PersonRole.host
            && next.viewerRole != PersonRole.attendee
        return PeopleRoleEffects(
            kinds: kinds,
            dismissesPanels: becameAttendee,
            popsHostPages: lostHost || becameAttendee,
            showsLostHostNotice: lostHost && !becameAttendee,
            clearsHostConfirmations: lostHost || becameAttendee,
            closesMakeHostDialog: hostMoved || lostHost || becameAttendee,
            interruptsHostTickets: lostHost || becameAttendee,
            interruptsAllTickets: attemptChanged,
            clearsDrafts: false,
            disablesConfirmations: next.isRecovering,
            popsWebinarPages: webinarOff || lostHost,
            closesQaPanel: webinarOff || qaOff || becameAttendee,
            announcesQaOff: webinarOff || qaOff,
            refreshesHostConfig: !wasHost && isHost,
            announcement: announcesHost ? PeopleAnnouncementKind.newHost : "",
            announcementName: announcesHost ? next.hostName : ""
        )
    }

    static func keepsConfirmation(kind: PeopleConfirmationKind, targetShown: Bool, actionOffered: Bool, viewerIsHost: Bool) -> Bool {
        switch kind {
        case .remove, .makeCoHost, .makeHost, .moveToAudience:
            return targetShown && actionOffered
        default:
            return viewerIsHost
        }
    }

    static func isHostCommand(_ kind: PeopleCommandKind) -> Bool {
        switch kind {
        case .changeName, .qaSubmit, .qaUpvote, .declineStage:
            return false
        default:
            return true
        }
    }

    static func acceptsInvitation(invitationSession: Int, currentSession: Int, viewerRole: PersonRole) -> Bool {
        invitationSession == currentSession && viewerRole == PersonRole.attendee
    }

    static func demotionOutcome(slug: String) -> PeopleDemotionOutcome {
        slug.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? PeopleDemotionOutcome.homeNotice
            : PeopleDemotionOutcome.rejoinAsAttendee
    }
}

enum PeopleDemotionOutcome: String, CaseIterable, Equatable {
    case rejoinAsAttendee, homeNotice
}
