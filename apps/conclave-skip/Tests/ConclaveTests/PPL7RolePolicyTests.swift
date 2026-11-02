#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct PPL7RolePolicyTests {
    private let me = "u-ishaan"

    private final class CommandLog {
        var commands: [PeopleCommand] = []
        var tickets: [HostActionTicket] = []
    }

    private func state(_ role: PersonRole, host: String = "u-ishaan", name: String = "Ishaan", attempt: Int = 1,
                       webinar: Bool = false, qa: Bool = false, blocked: MeetingBlockedReason = .none,
                       session: Int = 1) -> PeopleRoleState {
        PeopleRoleState.make(callSession: session, attempt: attempt, viewerRole: role, hostUserId: host, hostName: name,
                             isWebinarEnabled: webinar, isWebinarQaEnabled: qa, blockedReason: blocked.rawValue)
    }

    @Test func becomingHostRefreshesTheConfigAndClosesNothing() {
        let effects = PeopleRolePolicy.effects(previous: state(.participant), next: state(.coHost))
        #expect(effects.has(.becameHost))
        #expect(effects.refreshesHostConfig)
        #expect(!effects.clearsHostConfirmations && !effects.popsHostPages && !effects.dismissesPanels)
        #expect(effects.announcement.isEmpty, "S20 owns \"You're now a host.\"")
    }

    @Test func losingHostCollapsesPopsClearsAndInterruptsHostTicketsSilently() {
        let effects = PeopleRolePolicy.effects(previous: state(.coHost), next: state(.participant))
        #expect(effects.has(.lostHost))
        #expect(effects.popsHostPages && effects.showsLostHostNotice && effects.clearsHostConfirmations)
        #expect(effects.interruptsHostTickets && !effects.interruptsAllTickets)
        #expect(effects.popsWebinarPages)
        #expect(!effects.dismissesPanels)
    }

    @Test func aHostMoveAnnouncesTheNewHostAndClosesMakeHost() {
        let effects = PeopleRolePolicy.effects(previous: state(.host, host: "u-ishaan", name: "Ishaan"),
                                               next: state(.coHost, host: "u-avery", name: "Avery Lee"))
        #expect(effects.has(.hostMoved))
        #expect(effects.closesMakeHostDialog)
        #expect(effects.announcement == PeopleAnnouncementKind.newHost && effects.announcementName == "Avery Lee")
        #expect(!effects.has(.lostHost), "the former host stays a co-host")

        let mine = PeopleRolePolicy.effects(previous: state(.coHost, host: "u-avery"), next: state(.host, host: "u-ishaan"))
        #expect(mine.has(.hostMoved) && mine.announcement.isEmpty)
    }

    @Test func movedToTheAudienceDismissesThePanels() {
        let effects = PeopleRolePolicy.effects(previous: state(.participant, webinar: true), next: state(.attendee, webinar: true))
        #expect(effects.has(.becameAttendee))
        #expect(effects.dismissesPanels && effects.closesQaPanel)
    }

    @Test func sessionAndAttemptChanges() {
        let session = PeopleRolePolicy.effects(previous: state(.host, session: 1), next: state(.host, session: 2))
        #expect(session.kinds == [PeopleRoleChangeKind.sessionChanged.rawValue])
        #expect(session.interruptsAllTickets && session.clearsDrafts)
        let attempt = PeopleRolePolicy.effects(previous: state(.host, attempt: 1), next: state(.host, attempt: 2))
        #expect(attempt.has(.attemptChanged) && attempt.interruptsAllTickets)
        #expect(PeopleRolePolicy.effects(previous: state(.host, session: 0), next: state(.host)) == PeopleRoleEffects.none)
        #expect(PeopleRolePolicy.effects(previous: state(.host), next: state(.host)) == PeopleRoleEffects.none)
    }

    @Test func recoveryKeepsDialogsWithTheirConfirmDisabled() {
        let effects = PeopleRolePolicy.effects(previous: state(.host), next: state(.host, blocked: .reconnecting))
        #expect(effects.has(.recoveryStarted) && effects.disablesConfirmations)
        #expect(!effects.clearsHostConfirmations)
    }

    @Test func webinarAndQaOffCloseQaWithTheAnnouncement() {
        let webinarOff = PeopleRolePolicy.effects(previous: state(.host, webinar: true, qa: true), next: state(.host))
        #expect(webinarOff.has(.webinarOff) && webinarOff.popsWebinarPages && webinarOff.closesQaPanel && webinarOff.announcesQaOff)
        let qaOff = PeopleRolePolicy.effects(previous: state(.attendee, webinar: true, qa: true), next: state(.attendee, webinar: true))
        #expect(qaOff.has(.qaOff) && qaOff.closesQaPanel && qaOff.announcesQaOff && !qaOff.popsWebinarPages)
    }

    @Test func confirmationsInvitationsAndDemotionRules() {
        #expect(!PeopleRolePolicy.keepsConfirmation(kind: .remove, targetShown: false, actionOffered: true, viewerIsHost: true))
        #expect(!PeopleRolePolicy.keepsConfirmation(kind: .makeCoHost, targetShown: true, actionOffered: false, viewerIsHost: true))
        #expect(PeopleRolePolicy.keepsConfirmation(kind: .remove, targetShown: true, actionOffered: true, viewerIsHost: true))
        #expect(!PeopleRolePolicy.keepsConfirmation(kind: .muteAll, targetShown: false, actionOffered: false, viewerIsHost: false))
        #expect(!PeopleRolePolicy.isHostCommand(.changeName) && !PeopleRolePolicy.isHostCommand(.qaSubmit))
        #expect(!PeopleRolePolicy.isHostCommand(.declineStage) && PeopleRolePolicy.isHostCommand(.mute))
        #expect(PeopleRolePolicy.acceptsInvitation(invitationSession: 2, currentSession: 2, viewerRole: .attendee))
        #expect(!PeopleRolePolicy.acceptsInvitation(invitationSession: 1, currentSession: 2, viewerRole: .attendee))
        #expect(PeopleRolePolicy.demotionOutcome(slug: "design-week") == .rejoinAsAttendee)
        #expect(PeopleRolePolicy.demotionOutcome(slug: "  ") == .homeNotice)
    }

    private func hostPeople() -> (PeoplePresenter, CommandLog) {
        let shell = MeetingShellPresenter()
        let people = PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
        let log = CommandLog()
        people.onCommand = { command, ticket in
            log.commands.append(command)
            log.tickets.append(ticket)
        }
        people.platform = NoticePlatform.ios
        people.apply(hostInputs(isAdmin: true, hostId: me))
        return (people, log)
    }

    private func hostInputs(isAdmin: Bool, hostId: String, phase: String = MeetingPhaseKind.inCall.rawValue) -> PeopleInputs {
        PeopleInputs.make(
            callSession: 1, attempt: 1, phase: phase, localUserId: me,
            participants: [
                PeopleParticipantInput.make(userId: me, displayName: "Ishaan", isLocal: true),
                PeopleParticipantInput.make(userId: "u-avery", displayName: "Avery Lee", joinSerial: 1),
                PeopleParticipantInput.make(userId: "u-lee", displayName: "Lee Park", isMuted: false, joinSerial: 2),
            ],
            isRosterLoaded: true, isAdmin: isAdmin, hostUserId: hostId,
            hostUserIds: isAdmin ? [me, "u-avery"] : [hostId])
    }

    @Test func losingHostFinishesPendingHostTicketsSilentlyAndKeepsTheRename() throws {
        let (people, log) = hostPeople()
        people.perform(.mute, rowId: "u-lee", source: PeopleActionSource.rowMenu)
        people.beginRename()
        people.submitRename("Ishaan K")
        #expect(log.commands.map(\.kind) == [.mute, .changeName])

        #expect(people.perform(.remove, rowId: "u-lee", source: PeopleActionSource.rowMenu) == .ignored)
        people.perform(.remove, rowId: "u-avery", source: PeopleActionSource.rowMenu)
        #expect(people.confirmation?.kind == .remove)
        people.apply(hostInputs(isAdmin: false, hostId: "u-avery"))
        #expect(people.lastRoleChange.contains(PeopleRoleChangeKind.lostHost.rawValue))
        #expect(people.confirmation == nil)

        try #require(log.tickets.count > 1)
        #expect(!people.finish(log.tickets[0], HostActionResult.failed(.rejectedByServer)))
        #expect(people.lastFailure == nil)

        #expect(people.finish(log.tickets[1], HostActionResult.completed))
    }

    @Test func aHostMoveClosesAnOpenMakeHostDialog() {
        let (people, _) = hostPeople()
        people.perform(.makeHost, rowId: "u-lee", source: PeopleActionSource.rowMenu)
        #expect(people.confirmation?.kind == .makeHost)
        var moved = hostInputs(isAdmin: true, hostId: "u-avery")
        moved = PeopleInputs.make(callSession: 1, attempt: 1, phase: moved.phase, localUserId: me, participants: moved.participants,
                                  isRosterLoaded: true, isAdmin: true, hostUserId: "u-avery", hostUserIds: [me, "u-avery"])
        people.apply(moved)
        #expect(people.confirmation == nil)
        #expect(people.stage.announcement?.kind == PeopleAnnouncementKind.newHost)
        #expect(people.stage.announcement?.name == "Avery Lee")
    }

    @Test func recoveryDisablesAnOpenConfirmInsteadOfClosingIt() {
        let (people, log) = hostPeople()
        people.perform(.remove, rowId: "u-lee", source: PeopleActionSource.rowMenu)
        let id = people.confirmation?.id ?? 0
        people.apply(hostInputs(isAdmin: true, hostId: me, phase: MeetingPhaseKind.recovering.rawValue))
        #expect(people.confirmation?.id == id)
        #expect(people.confirmation?.isConfirmEnabled == false)
        #expect(people.confirmation?.reason == MeetingBlockedReason.reconnecting.rawValue)
        people.confirm(id: id, block: false)
        #expect(log.commands.isEmpty)
        people.apply(hostInputs(isAdmin: true, hostId: me))
        #expect(people.confirmation?.isConfirmEnabled == true)
    }

    private func attendeePeople() -> (PeoplePresenter, CommandLog) {
        let shell = MeetingShellPresenter()
        let people = PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
        let log = CommandLog()
        people.onCommand = { command, ticket in
            log.commands.append(command)
            log.tickets.append(ticket)
        }
        people.apply(PeopleInputs.make(callSession: 3, attempt: 1, phase: MeetingPhaseKind.inCall.rawValue, localUserId: "a-priya#s1",
                                       participants: [PeopleParticipantInput.make(userId: "a-priya#s1", displayName: "Priya N.",
                                                                                  isLocal: true)],
                                       isRosterLoaded: true, isWebinarAttendee: true, isWebinarEnabled: true))
        return (people, log)
    }

    @Test func theInvitationIsOneAtATimeAndAcceptStartsThePromotion() {
        let (people, log) = attendeePeople()
        var accepted: [StageInvitationModel] = []
        people.onAcceptStageInvitation = { accepted.append($0) }
        people.presentStageInvitation(promotedByName: "Ishaan", rejoinRoomId: "design-week")
        let first = people.stageInvitation
        #expect(first?.promotedByName == "Ishaan" && first?.session == 3)
        people.presentStageInvitation(promotedByName: "Avery Lee", rejoinRoomId: "design-week")
        let second = people.stageInvitation
        #expect(second?.id != first?.id && second?.promotedByName == "Avery Lee")

        people.acceptStageInvitation(id: first?.id ?? 0)
        #expect(people.stageInvitation != nil && accepted.isEmpty)
        people.acceptStageInvitation(id: second?.id ?? 0)
        #expect(people.stageInvitation == nil)
        #expect(accepted.map(\.rejoinRoomId) == ["design-week"])
        #expect(log.commands.isEmpty, "Accept sends nothing; the lobby's Join or Cancel does")
    }

    @Test func notNowAndBackDeclineOnceThroughTheLedger() {
        let (people, log) = attendeePeople()
        people.presentStageInvitation(promotedByName: "", rejoinRoomId: "r")
        let id = people.stageInvitation?.id ?? 0
        people.declineStageInvitation(id: id)
        people.declineStageInvitation(id: id)
        #expect(log.commands.map(\.kind) == [.declineStage])
        #expect(people.stageInvitation == nil)

        let (host, _) = hostPeople()
        host.presentStageInvitation(promotedByName: "Ishaan", rejoinRoomId: "r")
        #expect(host.stageInvitation == nil)
    }

    @Test func thePromotionLobbyJoinsAsASpeakerOrDeclines() {
        let premeeting = PremeetingPresenter()
        var commands: [PremeetingCommand] = []
        premeeting.onCommand = { commands.append($0) }
        premeeting.apply(PremeetingInputs.make(callSession: 1, phase: .inCall, roomLabel: "Design Week", isWebinarAttendee: true,
                                               hasBeenAdmittedThisSession: true))
        premeeting.openPromotionLobby(roomId: "design-week", title: "Design Week")
        let route = premeeting.promotionRoute
        #expect(route?.kind == .lobby)
        #expect(premeeting.lobbyStatus?.intent == .promotion)
        #expect(premeeting.lobbyLink?.canShare == false, "no Share in the promotion lobby")
        #expect(premeeting.path.isEmpty, "never part of the premeeting stack")
        premeeting.startOrJoin()
        #expect(commands == [.joinAsSpeaker])
        premeeting.cancelPromotion()
        #expect(commands == [.joinAsSpeaker, .cancelPromotion])
        premeeting.closePromotionLobby()
        #expect(premeeting.promotionRoute == nil)
        premeeting.cancelPromotion()
        #expect(commands.count == 2, "Cancel after the close sends nothing")
    }

    @Test func theWebinarFixturesBuildOnTheSharedScripts() {
        for state in PeopleWebinarFixtureState.allCases {
            let session = PeopleWebinarFixtureSession(state: state)
            #expect(session.people.snapshot.webinarEnabled, "\(state.rawValue)")
            if PeopleWebinarFixtureScript.isQa(state) {
                #expect(session.people.qa.snapshot.isEnabled, "\(state.rawValue)")
            }
        }
        let hands = PeopleWebinarFixtureSession(state: .webinarHostHands4)
        #expect(hands.people.snapshot.section(.raisedHands)?.count == 4)
        let invited = PeopleWebinarFixtureSession(state: .webinarHostInvited)
        #expect(invited.people.snapshot.section(.attendees)?.rowIds == ["attendee:a-mina"])
        let promoted = PeopleWebinarFixtureSession(state: .qaHostPromotedMidcall)
        #expect(promoted.people.qa.snapshot.availability == QaAvailability.needsRejoin)
        let invite = PeopleWebinarFixtureSession(state: .stageInvite)
        invite.deliverPromotion()
        #expect(invite.people.stageInvitation?.promotedByName == "Ishaan")
    }
}

private func ppl7Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}
#endif
