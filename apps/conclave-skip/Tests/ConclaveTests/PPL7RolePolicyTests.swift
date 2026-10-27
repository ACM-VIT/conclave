#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// PPL-7 (OUT/PLAN-screens.md section 5): role-change safety, stage promotion and demotion. PeopleRolePolicy (PL13: the
/// S50 12 f table of what closes, pops, clears or announces on each role, target or session change) as table tests,
/// the presenter applying it (lost host interrupts host tickets silently and keeps your rename; a host move announces
/// the new host and closes Make Host; recovery keeps a dialog open with its confirm disabled), the attendee stage
/// invitation (PH9: one at a time, Accept starts the PH20 promotion lobby, Not Now and Back decline), the premeeting
/// promotion lobby (R30), the demotion outcome (Q12, R47), and source pins for the view model handoff and the
/// platform layers.
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

    // MARK: PL13 table (S50 12 f)

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
        // Becoming the host yourself announces nothing here.
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

    // MARK: The presenter applies the table

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

    @Test func losingHostFinishesPendingHostTicketsSilentlyAndKeepsTheRename() {
        let (people, log) = hostPeople()
        people.perform(.mute, rowId: "u-lee", source: PeopleActionSource.rowMenu)
        people.beginRename()
        people.submitRename("Ishaan K")
        #expect(log.commands.map(\.kind) == [.mute, .changeName])
        people.perform(.remove, rowId: "u-lee", source: PeopleActionSource.rowMenu)
        #expect(people.confirmation?.kind == .remove)
        people.apply(hostInputs(isAdmin: false, hostId: "u-avery"))
        #expect(people.lastRoleChange.contains(PeopleRoleChangeKind.lostHost.rawValue))
        #expect(people.confirmation == nil)
        // The mute ticket finished as interrupted: its late result is refused and posts nothing.
        #expect(!people.finish(log.tickets[0], HostActionResult.failed(.rejectedByServer)))
        #expect(people.lastFailure == nil)
        // The rename is yours, not a host action: it still completes.
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

    // MARK: PH9 stage invitation (attendee side)

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
        // A stale id does nothing.
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
        // Hosts never get an invitation.
        let (host, _) = hostPeople()
        host.presentStageInvitation(promotedByName: "Ishaan", rejoinRoomId: "r")
        #expect(host.stageInvitation == nil)
    }

    // MARK: PH20 promotion lobby (S10 6, RECONCILE R30)

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

    // MARK: Source pins

    @Test func theViewModelHandsOffDemotionAndPromotionQuietly() throws {
        let vm = try ppl7Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        // PH9: the flag is set synchronously in the socket callback, before the server-side disconnect.
        #expect(vm.contains("self.beginDemotionHandoff(notification)\n            Task { @MainActor in"))
        #expect(vm.contains("premeeting.showHomeNotice(HomeNoticeKind.movedToAudience)"))
        #expect(vm.contains("joinMode: JoinMode.webinarAttendee,"))
        #expect(vm.contains("people.presentStageInvitation(promotedByName: notification.promotedByName ?? \"\","))
        #expect(vm.contains("case .joinAsSpeaker:") && vm.contains("case .cancelPromotion:"))
        #expect(vm.contains("stage.announce(kind: AttendeeViewerPolicy.demotedAnnouncement, name: \"\")"))
        let sheet = try ppl7Source("Sources/Conclave/Features/Lobby/PromotionLobby+iOS.swift")
        #expect(sheet.contains(".presentationDetents([.large])") && !sheet.contains("fullScreenCover(isPresented"))
        let overlay = try ppl7Source("Sources/Conclave/Skip/ui/lobby/PromotionLobbyOverlay.kt")
        #expect(overlay.contains("BackHandler(enabled = true) { premeeting.cancelPromotion() }"))
        let iosViewer = try ppl7Source("Sources/Conclave/Features/Meeting/Stage/AttendeeViewer+iOS.swift")
        #expect(iosViewer.contains(".alert(ConclaveStrings.text(\"You\\u{2019}re Invited on Stage\")"))
        let kotlinViewer = try ppl7Source("Sources/Conclave/Skip/ui/call/stage/AttendeeViewer.kt")
        #expect(kotlinViewer.contains("DialogProperties(dismissOnClickOutside = false, dismissOnBackPress = true)"))
        #expect(kotlinViewer.contains("onDismissRequest = { people.declineStageInvitation(id = invitation.id) }"))
        for path in ["Sources/Conclave/Features/Meeting/People/PeopleRolePolicy.swift",
                     "Sources/Conclave/Features/Lobby/PromotionLobby+iOS.swift",
                     "Sources/Conclave/Skip/ui/lobby/PromotionLobbyOverlay.kt",
                     "Sources/Conclave/Features/Meeting/People/Debug/PeopleWebinarFixtures.swift"] {
            let source = try ppl7Source(path)
            #expect(!source.lowercased().contains("gradient"), "\(path) draws a gradient")
            #expect(!source.contains("\u{2014}") && !source.contains("\u{2013}"), "\(path) has a long dash")
        }
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
#endif

private func ppl7Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}
