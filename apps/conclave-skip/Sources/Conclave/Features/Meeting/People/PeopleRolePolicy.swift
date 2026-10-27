import Foundation

/// The role facts before or after one People inputs change (S50 12 f, PL13). Scalars only, built from `PeopleInputs`.
struct PeopleRoleState: Equatable {
    let callSession: Int
    let attempt: Int
    let viewerRole: PersonRole
    /// The primary host's canonical id, "" when unknown.
    let hostUserId: String
    /// The primary host's display name, "" when unknown (the "%@ is now the host." announcement).
    let hostName: String
    let isWebinarEnabled: Bool
    let isWebinarQaEnabled: Bool
    /// A `MeetingBlockedReason` raw value.
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

/// The changes of S50 12 f, in table order. String raw values (S1C 3.6).
enum PeopleRoleChangeKind: String, CaseIterable, Equatable {
    case becameHost, lostHost, hostMoved, becameAttendee, sessionChanged, attemptChanged, recoveryStarted
    case webinarOff, qaOff
}

/// What one change closes, pops, clears or announces (S50 12 f). The presenter applies it; the views follow the
/// snapshot (a pushed host page pops when `isHostViewer` turns false, a webinar page when `webinarEnabled` does).
struct PeopleRoleEffects: Equatable {
    /// `PeopleRoleChangeKind` raw values in table order.
    let kinds: [String]
    /// Participants, Host Controls and Q&A close (you were moved to the audience; S1 ROLE).
    let dismissesPanels: Bool
    /// Pushed host pages pop; a root Host Controls shows the unavailable state.
    let popsHostPages: Bool
    /// The "You're no longer a host." banner, until the panel closes (only while a People panel is open).
    let showsLostHostNotice: Bool
    /// Every host dialog (People, Host Controls and the S1 End confirmation) closes.
    let clearsHostConfirmations: Bool
    /// An open Make Host dialog closes (the role moved to someone else).
    let closesMakeHostDialog: Bool
    /// Pending host tickets finish silently as interrupted (PH2).
    let interruptsHostTickets: Bool
    /// Every pending ticket, rename and Q&A included, is interrupted (attempt or session change).
    let interruptsAllTickets: Bool
    /// Drafts clear (a new call session).
    let clearsDrafts: Bool
    /// Open confirmations stay with their confirm disabled, with the reason (recovery).
    let disablesConfirmations: Bool
    /// The Webinar Settings pages pop.
    let popsWebinarPages: Bool
    /// The Q&A panel closes.
    let closesQaPanel: Bool
    /// "Q&A is off." is announced (Attendee Q&A or webinar mode turned off).
    let announcesQaOff: Bool
    /// PH14: the core refreshes the meeting and webinar config once.
    let refreshesHostConfig: Bool
    /// A `PeopleAnnouncementKind` value for this change, or "" (S20 owns "You're now a host.").
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

/// S50 PL13 (shared, pure): the 12 f rules as a table-tested function of the previous and next role facts. The first
/// apply of a session (previous call session 0) is never a change.
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
        // A host move you caused or saw: announced by name when the new host is known and is not you.
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

    /// S50 12 f "target leaves" and "target becomes host": a person dialog stays only while its target is still shown
    /// and still offers the action; any other host dialog stays only while you are a host or co-host.
    static func keepsConfirmation(kind: PeopleConfirmationKind, targetShown: Bool, actionOffered: Bool, viewerIsHost: Bool) -> Bool {
        switch kind {
        case .remove, .makeCoHost, .makeHost, .moveToAudience:
            return targetShown && actionOffered
        default:
            return viewerIsHost
        }
    }

    /// Host commands finish silently when the role is lost; your own rename, Q&A questions and votes and a stage decline
    /// are not host actions (S50 13).
    static func isHostCommand(_ kind: PeopleCommandKind) -> Bool {
        switch kind {
        case .changeName, .qaSubmit, .qaUpvote, .declineStage:
            return false
        default:
            return true
        }
    }

    /// S50 12 c: one stage invitation at a time; a second one replaces the first. Accept is offered only while you are
    /// still an attendee in the session the invitation arrived in.
    static func acceptsInvitation(invitationSession: Int, currentSession: Int, viewerRole: PersonRole) -> Bool {
        invitationSession == currentSession && viewerRole == PersonRole.attendee
    }

    /// PH9 and Q12: after `webinar:demoted` the core rejoins in place through the webinar link slug when the server sent
    /// one; otherwise the session ends quietly with the Home notice "A host moved you to the audience." (R47).
    static func demotionOutcome(slug: String) -> PeopleDemotionOutcome {
        slug.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? PeopleDemotionOutcome.homeNotice
            : PeopleDemotionOutcome.rejoinAsAttendee
    }
}

/// What the core does after a demotion (PH9, Q12; RECONCILE R47).
enum PeopleDemotionOutcome: String, CaseIterable, Equatable {
    case rejoinAsAttendee, homeNotice
}
