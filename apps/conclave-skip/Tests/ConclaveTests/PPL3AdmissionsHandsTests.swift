#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct PPL3AdmissionsHandsTests {
    private let me = "u-ishaan"
    private let three = [PeopleWaitingInput(id: "p-lee", displayName: "Lee Park"),
                         PeopleWaitingInput(id: "p-sam", displayName: "Sam Ito"),
                         PeopleWaitingInput(id: "guest-71a2", displayName: "guest-71a2")]

    private final class CommandLog {
        var commands: [PeopleCommand] = []
        var tickets: [HostActionTicket] = []
    }

    private func makePeople() -> PeoplePresenter {
        let shell = MeetingShellPresenter()
        return PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
    }

    private func record(_ people: PeoplePresenter) -> CommandLog {
        let log = CommandLog()
        people.onCommand = { command, ticket in
            log.commands.append(command)
            log.tickets.append(ticket)
        }
        return log
    }

    private func inputs(_ waiting: [PeopleWaitingInput], phase: String = MeetingPhaseKind.inCall.rawValue,
                        isAdmin: Bool = true, isNetworkOffline: Bool = false, hands: Bool = false) -> PeopleInputs {
        PeopleInputs.make(
            callSession: 1, attempt: 1, phase: phase, isNetworkOffline: isNetworkOffline, localUserId: me,
            participants: [
                PeopleParticipantInput.make(userId: me, displayName: "Ishaan", isLocal: true),
                PeopleParticipantInput.make(userId: "u-avery", displayName: "Avery Lee", isHandRaised: hands, joinSerial: 1,
                                            raisedAtMillis: hands ? 1_000 : 0),
                PeopleParticipantInput.make(userId: "u-sam", displayName: "Sam Ito", isHandRaised: hands, joinSerial: 2,
                                            raisedAtMillis: hands ? 31_000 : 0),
            ],
            isRosterLoaded: true, isAdmin: isAdmin, hostUserId: isAdmin ? me : "u-avery",
            hostUserIds: isAdmin ? [me] : ["u-avery"], waiting: waiting)
    }

    private func alone() -> PeopleInputs {
        PeopleInputs.make(callSession: 1, attempt: 1, phase: MeetingPhaseKind.inCall.rawValue, localUserId: me,
                          participants: [PeopleParticipantInput.make(userId: me, displayName: "Ishaan", isLocal: true)],
                          isRosterLoaded: true, isAdmin: true, hostUserId: me, hostUserIds: [me])
    }

    private func rowIds(_ people: PeoplePresenter, _ section: PeopleSectionID) -> [String] {
        people.snapshot.section(section)?.rowIds ?? []
    }

    @Test func waitingRowsAdmitAndDenyWithOneCommandPerTap() throws {
        let people = makePeople()
        let log = record(people)
        people.apply(inputs(three))
        #expect(rowIds(people, .waiting) == ["waiting:guest-71a2", "waiting:p-lee", "waiting:p-sam"])
        let lee = people.waiting.entry(for: "waiting:p-lee").model
        #expect(lee.isEnabled && lee.pendingAction.isEmpty && lee.reason == PeopleActionReason.none)
        #expect(people.perform(.admit, rowId: "waiting:p-lee", source: PeopleActionSource.rowMenu) == .dispatched)
        #expect(people.perform(.admit, rowId: "waiting:p-lee", source: PeopleActionSource.rowMenu) == .ignored)
        #expect(people.perform(.deny, rowId: "waiting:p-lee", source: PeopleActionSource.swipe) == .ignored)
        try #require(log.commands.count == 1)

        #expect(log.commands[0].kind == .admit && log.commands[0].targetId == "p-lee")
        #expect(log.tickets[0].key == "admit:waiting:p-lee")
        let pending = people.waiting.entry(for: "waiting:p-lee").model
        #expect(pending.pendingAction == PersonActionID.admit.rawValue && !pending.isEnabled)
        #expect(pending.reason == PeopleActionReason.pending)
        #expect(people.waiting.entry(for: "waiting:p-sam").model.isEnabled, "the other rows stay available")

        #expect(people.perform(.mute, rowId: "waiting:p-sam", source: PeopleActionSource.rowMenu) == .ignored)
        #expect(people.perform(.admit, rowId: "u-sam", source: PeopleActionSource.rowMenu) == .ignored)

        let before = people.feedbackState.token.sequence
        people.apply(inputs([three[1], three[2]]))
        #expect(people.finish(log.tickets[0], HostActionResult.completed))
        #expect(people.feedbackState.token.kind == .hostAdmitted && people.feedbackState.token.sequence == before + 1)
        #expect(rowIds(people, .waiting) == ["waiting:guest-71a2", "waiting:p-sam"])
        #expect(!people.waiting.contains("waiting:p-lee"))

        #expect(people.perform(.deny, rowId: "waiting:p-sam", source: PeopleActionSource.rowMenu) == .dispatched)
        #expect(people.confirmation == nil)
        try #require(log.tickets.count > 1)
        #expect(log.commands[1].kind == .deny && log.commands[1].targetId == "p-sam" && log.tickets[1].key == "deny:waiting:p-sam")
        people.finish(log.tickets[1], HostActionResult.completed)
        #expect(people.feedbackState.token.kind == .hostDenied)
    }

    @Test func headerOffersAdmitAllAndDenyAllOnlyWhileSeveralWait() {
        let people = makePeople()
        people.apply(inputs(three))
        let header = people.headerActions
        #expect(header.showsAdmitAll && header.isAdmitAllEnabled && header.isDenyAllEnabled)
        #expect(header.hasActions(PeopleSectionID.waiting.rawValue) && header.reason == MeetingBlockedReason.none.rawValue)

        people.apply(inputs([three[0]]))
        #expect(!people.headerActions.showsAdmitAll && !people.headerActions.hasActions(PeopleSectionID.waiting.rawValue))
        people.requestDenyAll()
        #expect(people.confirmation == nil)

        people.apply(inputs([]))
        #expect(people.snapshot.section(.waiting) == nil && !people.headerActions.showsAdmitAll)
    }

    @Test func admitAllActsAtOnceDisablesRowsAndAnnouncesTheCount() throws {
        let people = makePeople()
        let log = record(people)
        people.apply(inputs(three))
        #expect(people.admitAll() == .dispatched)
        #expect(people.confirmation == nil, "Admit All never confirms (S50 4 c)")
        let command = try #require(log.commands.last)
        #expect(command.kind == .admitAll && command.number == 3)
        #expect(log.tickets.last?.key == PeopleAdmissionsPolicy.admitAllKey)
        let header = people.headerActions
        #expect(header.admitAllPending && !header.isAdmitAllEnabled && !header.isDenyAllEnabled)
        for key in rowIds(people, .waiting) {
            let row = people.waiting.entry(for: key).model
            #expect(!row.isEnabled && row.pendingAction.isEmpty && row.reason == PeopleActionReason.pending, "\(key)")
        }
        #expect(people.perform(.admit, rowId: "waiting:p-lee", source: PeopleActionSource.rowMenu) == .ignored)
        #expect(people.admitAll() == .ignored)
        #expect(log.commands.count == 1)
        people.apply(inputs([]))
        people.finish(try #require(log.tickets.last), HostActionResult.completed)
        #expect(people.feedbackState.token.kind == .hostAdmittedAll)
        #expect(people.stage.announcementLog.last == PeopleAnnouncementKind.admittedAll + ":3")
        #expect(people.snapshot.section(.waiting) == nil && !people.headerActions.admitAllPending)
    }

    @Test func denyAllConfirmsFirstAndTheDialogFollowsTheCount() throws {
        let people = makePeople()
        let log = record(people)
        people.apply(inputs(three))
        people.requestDenyAll()
        let dialog = try #require(people.confirmation)
        #expect(dialog.kind == .denyAll && dialog.count == 3 && dialog.source == PeopleActionSource.sectionHeader)
        #expect(log.commands.isEmpty, "Deny All asks first")

        people.apply(inputs([three[0], three[1]]))
        #expect(people.confirmation?.id == dialog.id && people.confirmation?.count == 2)
        people.confirm(id: dialog.id, block: false)
        #expect(log.commands.map { $0.kind } == [.denyAll] && log.commands[0].number == 2)
        try #require(log.tickets.count > 0)
        #expect(log.tickets[0].key == PeopleAdmissionsPolicy.denyAllKey)
        people.apply(inputs([]))
        people.finish(log.tickets[0], HostActionResult.completed)
        #expect(people.feedbackState.token.kind == .hostDenied && people.snapshot.section(.waiting) == nil)

        people.apply(inputs(three))
        people.requestDenyAll()
        #expect(people.confirmation != nil)
        people.apply(inputs([three[0]]))
        #expect(people.confirmation == nil)
    }

    @Test func recoveringAndOfflineDisableEveryButtonWithTheReason() {
        let people = makePeople()
        let log = record(people)
        people.apply(inputs(three, phase: MeetingPhaseKind.recovering.rawValue))
        for key in rowIds(people, .waiting) {
            let row = people.waiting.entry(for: key).model
            #expect(!row.isEnabled && row.reason == MeetingBlockedReason.reconnecting.rawValue, "\(key)")
        }
        let header = people.headerActions
        #expect(header.showsAdmitAll, "header actions stay visible and disabled")
        #expect(!header.isAdmitAllEnabled && !header.isDenyAllEnabled && header.reason == MeetingBlockedReason.reconnecting.rawValue)
        #expect(people.perform(.admit, rowId: "waiting:p-lee", source: PeopleActionSource.rowMenu) == .ignored)
        #expect(people.admitAll() == .ignored)
        people.requestDenyAll()
        #expect(people.confirmation == nil && log.commands.isEmpty)
        people.apply(inputs(three, isNetworkOffline: true))
        #expect(people.waiting.entry(for: "waiting:p-sam").model.reason == MeetingBlockedReason.offline.rawValue)
        #expect(people.headerActions.reason == MeetingBlockedReason.offline.rawValue)
    }

    @Test func aStaleWaitingEntryLeavesSilently() throws {
        let people = makePeople()
        let log = record(people)
        people.apply(inputs(three))
        people.perform(.admit, rowId: "waiting:p-lee", source: PeopleActionSource.rowMenu)
        let token = people.feedbackState.token
        people.finish(try #require(log.tickets.first), HostActionResult.failed(HostActionFailure.notFound))
        #expect(people.lastFailure == nil && people.feedbackState.token == token)
        #expect(!people.stage.noticesReadout().contains(PeopleFailurePlacementPolicy.stageNoticeKind))
        #expect(PeopleAdmissionsPolicy.isSilentFailure(kind: .deny, failure: HostActionFailure.notFound.rawValue))
        #expect(!PeopleAdmissionsPolicy.isSilentFailure(kind: .admitAll, failure: HostActionFailure.notFound.rawValue))
        #expect(!PeopleAdmissionsPolicy.isSilentFailure(kind: .admit, failure: HostActionFailure.rejectedByServer.rawValue))
    }

    @Test func admissionFailuresReportAtTheirSourceWithTheirOwnSentence() throws {
        let people = makePeople()
        let log = record(people)
        people.platform = NoticePlatform.ios
        people.apply(inputs(three))
        people.perform(.admit, rowId: "waiting:p-lee", source: PeopleActionSource.rowMenu)
        people.finish(try #require(log.tickets.first), HostActionResult.failed(HostActionFailure.rejectedByServer))
        let failure = try #require(people.lastFailure)
        #expect(failure.sourceKey == "waiting:p-lee" && failure.action == PeopleCommandKind.admit.rawValue)
        #expect(failure.targetName == "Lee Park" && failure.placement == HostFailurePlacement.panelInline.rawValue)
        #expect(PeopleFailureCopy.kind(action: failure.action, failure: failure.failure, sourceKey: failure.sourceKey)
                == PeopleFailureCopy.admit)

        people.retry(failureId: failure.id)
        #expect(log.commands.count == 2 && log.commands[1].targetId == "p-lee" && log.tickets[1].key == "admit:waiting:p-lee")
        let rejected = HostActionFailure.rejectedByServer.rawValue
        #expect(PeopleFailureCopy.kind(action: "admitAll", failure: rejected, sourceKey: "waiting") == PeopleFailureCopy.admitAll)
        #expect(PeopleFailureCopy.kind(action: "deny", failure: rejected, sourceKey: "waiting:p-sam") == PeopleFailureCopy.deny)
        #expect(PeopleFailureCopy.kind(action: "bulk", failure: rejected, sourceKey: "raisedHands") == PeopleFailureCopy.hands)
        #expect(PeopleFailureCopy.kind(action: "bulk", failure: rejected, sourceKey: "inMeeting") == PeopleFailureCopy.muteAll)
        #expect(PeopleFailureCopy.kind(action: "bulk", failure: rejected, sourceKey: "panelists") == PeopleFailureCopy.muteAll)
        #expect(PeopleFailureCopy.kind(action: "bulk", failure: rejected, sourceKey: HostBulkID.lowerAllHands.rawValue)
                == PeopleFailureCopy.hands)

        #expect(PeopleFailureCopy.kind(action: "admit", failure: HostActionFailure.rateLimited.rawValue, sourceKey: "waiting:p-lee")
                == PeopleFailureCopy.rateLimited)
        #expect(PeopleAdmissionsPolicy.isHeaderBulkSource("raisedHands") && PeopleAdmissionsPolicy.isHeaderBulkSource("inMeeting"))
        #expect(!PeopleAdmissionsPolicy.isHeaderBulkSource(HostBulkID.muteAll.rawValue))
    }

    @Test func aNewKnockWhileParticipantsIsOpenIsAnnouncedOnce() {
        let people = makePeople()
        people.apply(inputs([three[0]]))

        people.apply(inputs([three[0], three[1]]))
        #expect(!people.stage.announcementLog.contains { $0.hasPrefix(PeopleAnnouncementKind.knock) })
        people.panelDidOpen(destination: .none, presentationID: 7)
        people.apply(inputs(three))
        #expect(people.stage.announcementLog.last == PeopleAnnouncementKind.knock + ":guest-71a2")
        let count = people.stage.announcementLog.count

        people.apply(inputs(three))
        people.apply(inputs([three[0]]))
        #expect(people.stage.announcementLog.count == count)

        people.apply(inputs(three + [PeopleWaitingInput(id: "p-rae", displayName: "Rae")]))
        #expect(people.stage.announcementLog.last == PeopleAnnouncementKind.knockMany + ":3")
        #expect(PeopleAdmissionsPolicy.newRequests(previous: ["p-lee"], current: [three[0], three[1]]).map { $0.id } == ["p-sam"])
    }

    @Test func losingHostClearsHeadersAndTheKnockFlight() {
        let people = makePeople()
        _ = record(people)
        people.apply(inputs(three))
        people.admitAll()
        #expect(people.stage.notices.knockActionsPending)
        people.apply(inputs(three, isAdmin: false))
        #expect(people.headerActions == PeopleHeaderActions.none && people.snapshot.section(.waiting) == nil)
        #expect(!people.stage.notices.knockActionsPending)
    }

    @Test func headerActionsPolicyGatesOnRoleCountsAndFlights() {
        let none = MeetingBlockedReason.none.rawValue
        #expect(PeopleAdmissionsPolicy.headerActions(viewerIsHost: false, blockedReason: none, waitingCount: 3,
                                                     showsMeetingHands: true, rosterCount: 4, pendingKeys: [])
                == PeopleHeaderActions.none)
        let quiet = PeopleAdmissionsPolicy.headerActions(viewerIsHost: true, blockedReason: none, waitingCount: 1,
                                                         showsMeetingHands: false, rosterCount: 1, pendingKeys: [])
        #expect(!quiet.showsAdmitAll && !quiet.showsLowerAll && !quiet.showsMuteAll)
        let busy = PeopleAdmissionsPolicy.headerActions(viewerIsHost: true, blockedReason: none, waitingCount: 2,
                                                        showsMeetingHands: true, rosterCount: 3,
                                                        pendingKeys: [PeopleAdmissionsPolicy.denyAllKey, "bulk:lowerAllHands"])
        #expect(busy.showsAdmitAll && !busy.isAdmitAllEnabled && busy.denyAllPending && !busy.admitAllPending)
        #expect(busy.showsLowerAll && busy.lowerAllPending && !busy.isLowerAllEnabled)
        #expect(busy.showsMuteAll && busy.isMuteAllEnabled && !busy.muteAllPending)
        #expect(PeopleAdmissionsPolicy.lowerAllKey == HostControlsPolicy.bulkKey(.lowerAllHands))
        #expect(PeopleAdmissionsPolicy.muteAllKey == HostControlsPolicy.bulkKey(.muteAll))
        #expect(PeopleAdmissionsPolicy.hasAdmissionPending(["admit:waiting:p-1"]))
        #expect(PeopleAdmissionsPolicy.hasAdmissionPending(["deny:waiting:p-1"]))
        #expect(PeopleAdmissionsPolicy.hasAdmissionPending([PeopleAdmissionsPolicy.admitAllKey]))
        #expect(!PeopleAdmissionsPolicy.hasAdmissionPending(["mute:u-1", "bulk:lowerAllHands", "remove:u-2"]))
        let request = PeopleWaitingInput(id: "p-1", displayName: "  Pat  ")
        let offline = PeopleAdmissionsPolicy.waitingRow(request, pendingAction: "deny", blockedReason: MeetingBlockedReason.offline.rawValue,
                                                        bulkPending: false)
        #expect(offline.reason == MeetingBlockedReason.offline.rawValue && !offline.isEnabled && offline.pendingAction == "deny")
        let flying = PeopleAdmissionsPolicy.waitingRow(request, pendingAction: "", blockedReason: none, bulkPending: true)
        #expect(flying.reason == PeopleActionReason.pending && !flying.isEnabled && flying.name == "Pat" && flying.serverId == "p-1")
    }

    @Test func headerMuteAllConfirmsReportsAtItsSectionAndHidesWhenAlone() throws {
        let people = makePeople()
        let log = record(people)
        people.platform = NoticePlatform.ios
        people.apply(inputs([]))
        #expect(people.headerActions.showsMuteAll && people.headerActions.hasActions(PeopleSectionID.inMeeting.rawValue))
        people.requestMuteAll()
        let dialog = try #require(people.confirmation)
        #expect(dialog.kind == .muteAll && dialog.source == PeopleActionSource.sectionHeader)
        people.confirm(id: dialog.id, block: false)
        #expect(log.commands.last?.kind == .bulk && log.commands.last?.text == HostBulkID.muteAll.rawValue)
        #expect(log.tickets.last?.key == HostControlsPolicy.bulkKey(.muteAll))
        #expect(people.headerActions.muteAllPending)
        #expect(people.host.dispatchBulk(.muteAll) == .ignored, "Host Controls' Mute Everyone is the same flight")
        people.finish(try #require(log.tickets.first), HostActionResult.failed(HostActionFailure.rejectedByServer))
        let failure = try #require(people.lastFailure)
        #expect(failure.sourceKey == PeopleSectionID.inMeeting.rawValue)
        #expect(PeopleFailureCopy.kind(action: failure.action, failure: failure.failure, sourceKey: failure.sourceKey)
                == PeopleFailureCopy.muteAll)

        people.requestMuteAll()
        #expect(people.confirmation != nil)
        people.apply(alone())
        #expect(people.confirmation == nil && !people.headerActions.showsMuteAll)
        people.requestMuteAll()
        #expect(people.confirmation == nil)
    }

    @Test func lowerAllActsAtOnceForHostsAndSharesTheHostControlsFlight() throws {
        let people = makePeople()
        let log = record(people)
        people.apply(inputs([], hands: true))
        #expect(rowIds(people, .raisedHands) == ["u-avery", "u-sam"])
        let header = people.headerActions
        #expect(header.showsLowerAll && header.isLowerAllEnabled && header.hasActions(PeopleSectionID.raisedHands.rawValue))
        #expect(people.lowerAllHands() == .dispatched)
        #expect(people.confirmation == nil, "Lower All acts at once (Q9)")
        let command = try #require(log.commands.last)
        #expect(command.kind == .bulk && command.text == HostBulkID.lowerAllHands.rawValue)
        #expect(log.tickets.last?.key == HostControlsPolicy.bulkKey(.lowerAllHands))
        #expect(people.headerActions.lowerAllPending && !people.headerActions.isLowerAllEnabled)
        #expect(people.host.dispatchBulk(.lowerAllHands) == .ignored, "Host Controls' Lower All Hands is the same flight")
        #expect(people.lowerAllHands() == .ignored)
        #expect(log.commands.count == 1)

        let before = people.feedbackState.token.sequence
        people.apply(inputs([], hands: false))
        people.finish(log.tickets[0], HostActionResult.completed)
        #expect(people.feedbackState.token.kind == .hostBulkApplied && people.feedbackState.token.sequence == before + 1)
        #expect(people.snapshot.section(.raisedHands) == nil && !people.headerActions.showsLowerAll)
    }

    @Test func lowerAllFailureReportsOnTheRaisedHandsSection() throws {
        let people = makePeople()
        let log = record(people)
        people.platform = NoticePlatform.android
        people.apply(inputs([], hands: true))
        people.lowerAllHands()
        people.finish(try #require(log.tickets.first), HostActionResult.failed(HostActionFailure.rejectedByServer))
        let failure = try #require(people.lastFailure)
        #expect(failure.sourceKey == PeopleSectionID.raisedHands.rawValue)
        #expect(failure.placement == HostFailurePlacement.panelSnackbar.rawValue)
        #expect(PeopleFailureCopy.kind(action: failure.action, failure: failure.failure, sourceKey: failure.sourceKey)
                == PeopleFailureCopy.hands)
    }

    @Test func guestsAndWebinarHostsGetNoMeetingLowerAll() {
        let people = makePeople()
        people.apply(inputs([], isAdmin: false, hands: true))
        #expect(people.snapshot.section(.raisedHands) != nil, "everyone sees the queue")
        #expect(people.headerActions == PeopleHeaderActions.none)
        #expect(people.lowerAllHands() == .ignored)
        let webinar = PeopleInputs.make(
            callSession: 1, attempt: 1, phase: MeetingPhaseKind.inCall.rawValue, localUserId: me,
            participants: [PeopleParticipantInput.make(userId: me, displayName: "Ishaan", isLocal: true),
                           PeopleParticipantInput.make(userId: "u-avery", displayName: "Avery Lee", isHandRaised: true,
                                                       joinSerial: 1)],
            isRosterLoaded: true, isAdmin: true, hostUserId: me, hostUserIds: [me], isWebinarEnabled: true,
            webinarHandQueue: [PeopleWebinarHandInput.make(userId: "a-1", displayName: "Attendee One", raisedAtMillis: 5_000)],
            webinarQueueKnown: true)
        people.apply(webinar)
        #expect(!people.headerActions.showsLowerAll, "a webinar host's Raised Hands is the attendee queue (S50 10)")
    }

    @Test func aPendingUserAndAnAttendeeHandKeepDistinctKeys() {

        let people = makePeople()
        people.apply(PeopleInputs.make(
            callSession: 1, attempt: 1, phase: MeetingPhaseKind.inCall.rawValue, localUserId: me,
            participants: [PeopleParticipantInput.make(userId: me, displayName: "Ishaan", isLocal: true)],
            isRosterLoaded: true, isAdmin: true, hostUserId: me, hostUserIds: [me],
            waiting: [PeopleWaitingInput(id: "x-1", displayName: "Rae")], isWebinarEnabled: true,
            webinarHandQueue: [PeopleWebinarHandInput.make(userId: "x-1", displayName: "Rae", raisedAtMillis: 5_000)],
            webinarQueueKnown: true))
        #expect(rowIds(people, .waiting) == ["waiting:x-1"])
        #expect(rowIds(people, .raisedHands) == ["attendee:x-1"])
        #expect(people.waiting.entry(for: "waiting:x-1").model.serverId == "x-1")
    }

    @Test func theHandQueueKeepsItsOrderThroughSpeakerChanges() throws {
        let session = PeopleFixtureSession(state: .hostHands3)
        let order = rowIds(session.people, .raisedHands)
        #expect(order == ["u-avery", "u-sam", "u-lee"])

        let raised = session.inputs.participants.filter { $0.isHandRaised }.sorted { $0.raisedAtMillis < $1.raisedAtMillis }
        #expect(raised.map { $0.userId } == ["u-avery", "u-sam", "u-lee"])
        try #require(raised.count > 2)
        #expect(raised[1].raisedAtMillis - raised[0].raisedAtMillis == 30_000)
        #expect(raised[2].raisedAtMillis - raised[1].raisedAtMillis == 30_000)
        let revision = session.people.snapshot.revision
        session.runSpeakerScript()
        #expect(rowIds(session.people, .raisedHands) == order && session.people.snapshot.revision == revision)
    }

    @Test func serverRaiseTimesOrderTheCoreQueue() async {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        let ann = "ann@example.com#web-session"
        let bo = "bo@example.com#web-session"
        let cy = "cy@example.com#web-session"

        let raises: [(String, Double)] = [(ann, 3_000), (bo, 1_000), (cy, 2_000)]
        for (userId, time) in raises {
            viewModel.appendPendingPreAckRosterEvent(PendingPreAckRosterEvent.handRaised(HandRaisedNotification(
                userId: userId, raised: true, timestamp: time, roomId: "room-a")))
        }
        await viewModel.replayPendingPreAckRoomEvents(includeDeferredRoomState: true)
        func canonical(_ id: String) -> String { viewModel.state.canonicalStageUserId(id) ?? id }
        #expect(viewModel.people.snapshot.section(.raisedHands)?.rowIds == [canonical(bo), canonical(cy), canonical(ann)])
    }

    @Test func knockBannerActionsGoThroughPeopleOnTheStageOrigin() throws {
        let shell = MeetingShellPresenter()
        let stage = StagePresenter(shell: shell)
        let people = PeoplePresenter(shell: shell, stage: stage)
        let log = record(people)
        var core: [NoticeCommand] = []
        stage.onNoticeCommand = { command in core.append(command) }
        people.apply(inputs([three[0]]))
        stage.applyNotices(StageNoticeInputs.make(callSession: 1, isHost: true, localUserId: me, participantCount: 3,
                                                  pendingUserIds: ["p-lee"], pendingFirstName: "Lee Park"))
        let banner = try #require(stage.banner)
        #expect(banner.kind == NoticeKind.knock && banner.actions.map { $0.id } == [NoticeAction.view, NoticeAction.admit])
        stage.performNoticeAction(noticeId: banner.id, actionId: NoticeAction.admit)
        #expect(core.isEmpty, "People performs Admit, not the core's notice command")
        #expect(log.commands.map { $0.kind } == [.admit] && log.commands[0].targetId == "p-lee")
        #expect(stage.banner?.actions.last?.isEnabled == false, "Admit stays visible but disabled while in flight")
        #expect(stage.banner?.actions.first?.isEnabled == true, "View stays available")
        people.finish(try #require(log.tickets.first), HostActionResult.failed(HostActionFailure.rejectedByServer))
        #expect(people.lastFailure == nil, "stage origin: the toast lane, never the panel (PL14)")
        #expect(stage.noticesReadout().contains("toast=" + PeopleFailurePlacementPolicy.stageNoticeKind))
        #expect(stage.banner?.actions.last?.isEnabled == true)

        stage.performNoticeAction(noticeId: banner.id, actionId: NoticeAction.view)
        let current = try #require(shell.panels.snapshot.current)
        #expect(current.panel == .participants && current.destination == .peopleWaiting)

        people.apply(inputs(three))
        stage.applyNotices(StageNoticeInputs.make(callSession: 1, isHost: true, localUserId: me, participantCount: 3,
                                                  pendingUserIds: ["guest-71a2", "p-lee", "p-sam"]))
        let many = try #require(stage.banner)
        #expect(many.actions.map { $0.id } == [NoticeAction.view, NoticeAction.admitAll])
        stage.performNoticeAction(noticeId: many.id, actionId: NoticeAction.admitAll)
        #expect(log.commands.last?.kind == .admitAll && log.commands.last?.number == 3)
        #expect(people.headerActions.admitAllPending && core.isEmpty)
    }

    @Test func aBannerAheadOfPeopleStillAdmitsOnTheLedger() {
        let shell = MeetingShellPresenter()
        let stage = StagePresenter(shell: shell)
        let people = PeoplePresenter(shell: shell, stage: stage)
        let log = record(people)
        people.apply(inputs([]))
        stage.applyNotices(StageNoticeInputs.make(callSession: 1, isHost: true, localUserId: me, participantCount: 3,
                                                  pendingUserIds: ["p-new"], pendingFirstName: "Noor"))
        stage.performNoticeAction(noticeId: stage.banner?.id ?? "", actionId: NoticeAction.admit)
        #expect(log.commands.map { $0.targetId } == ["p-new"] && log.tickets.first?.key == "admit:waiting:p-new")
        #expect(people.admitFromStage(pendingId: "p-new") == .ignored, "single flight")
        #expect(people.admitFromStage(pendingId: "") == .ignored)
    }

    @Test func knockBannerStaysQuietWhileParticipantsIsCurrentAndDisablesItsAdmit() {
        let noticeInputs = StageNoticeInputs.make(callSession: 1, isHost: true, localUserId: me, pendingUserIds: ["p-lee", "p-sam"])
        func knock(_ panel: String, pending: Bool = false) -> MeetingNotice? {
            MeetingNoticePolicy.bannerCandidates(noticeInputs, hostNotice: nil, liveNotesEpisode: 0, currentPanel: panel,
                                                 platform: NoticePlatform.ios, knockPending: pending)
                .first { $0.kind == NoticeKind.knock }
        }
        #expect(knock("")?.announcement == NoticeAnnouncement.assertiveOnce)
        #expect(knock(MeetingPanel.chat.rawValue)?.announcement == NoticeAnnouncement.assertiveOnce)
        #expect(knock(MeetingPanel.participants.rawValue)?.announcement == NoticeAnnouncement.none,
                "People announces a new knock politely instead (S50 4 i)")
        #expect(knock("")?.actions == [NoticeAction.make(NoticeAction.view), NoticeAction.make(NoticeAction.admitAll)])
        #expect(knock("", pending: true)?.actions
                == [NoticeAction.make(NoticeAction.view), NoticeAction.make(NoticeAction.admitAll, isEnabled: false)])
    }

    @Test func waitingFixtureOpensThroughTheKnockBannerAndAdmitsAfterTheAck() throws {
        let session = PeopleFixtureSession(state: .hostWaiting3)
        session.holdsAcks = true
        let knock = try #require(session.stage.banner)
        #expect(knock.kind == NoticeKind.knock && knock.count == 3)
        #expect(knock.actions.map { $0.id } == [NoticeAction.view, NoticeAction.admitAll])
        #expect(session.noticesReadout().contains("knock=3:ready"))
        session.open(destination: .peopleWaiting)
        let current = try #require(session.shell.panels.snapshot.current)
        #expect(current.panel == .participants && current.destination == .peopleWaiting)
        session.people.panelDidOpen(destination: current.destination, presentationID: current.presentationID)
        #expect(session.people.focusRequest?.sectionId == PeopleSectionID.waiting.rawValue)
        #expect(session.people.headerActions.showsAdmitAll)

        #expect(session.people.perform(.admit, rowId: "waiting:p-lee", source: PeopleActionSource.rowMenu) == .dispatched)
        #expect(session.queuedAcks.count == 1 && session.noticesReadout().contains("knock=3:pending"))
        let before = session.people.feedbackState.token.sequence
        session.releaseAcks()
        #expect(rowIds(session.people, .waiting) == ["waiting:guest-71a2", "waiting:p-sam"])
        #expect(session.people.feedbackState.token.kind == .hostAdmitted && session.people.feedbackState.token.sequence == before + 1)
        #expect(session.noticesReadout().contains("knock=2:ready") && session.countersReadout().contains("acks=1"))
        #expect(session.actionsReadout().contains("token=hostAdmitted#"))

        session.people.requestDenyAll()
        let dialog = try #require(session.people.confirmation)
        #expect(session.queuedAcks.isEmpty)
        session.people.confirm(id: dialog.id, block: false)
        session.releaseAcks()
        #expect(session.people.snapshot.section(.waiting) == nil && session.noticesReadout().contains("knock=none"))
        #expect(session.people.feedbackState.token.kind == .hostDenied)
    }

    @Test func handsFixtureLowersEveryHandAfterTheAck() {
        let session = PeopleFixtureSession(state: .hostHands3)
        session.holdsAcks = true
        #expect(session.people.lowerAllHands() == .dispatched)
        #expect(session.queuedAcks.count == 1)
        let before = session.people.feedbackState.token.sequence
        session.releaseAcks()
        #expect(session.people.snapshot.section(.raisedHands) == nil)
        #expect(session.people.feedbackState.token.kind == .hostBulkApplied && session.people.feedbackState.token.sequence == before + 1)
        #expect(session.actionsReadout().contains("token=hostBulkApplied#"))

        let guest = PeopleFixtureSession(state: .guest4)
        #expect(!guest.people.headerActions.showsLowerAll && guest.noticesReadout().contains("knock=none"))
    }

    @Test func fixtureScriptsEditOnlyWhatTheServerWould() {
        let waiting = PeopleFixtureScript.waiting(for: .hostWaiting3)
        #expect(PeopleFixtureScript.withoutWaiting(waiting, id: "p-sam").map { $0.id } == ["p-lee", "guest-71a2"])
        #expect(PeopleFixtureScript.handsLowered(PeopleFixtureScript.roster(for: .hostHands3)).allSatisfy { !$0.isHandRaised })
        let muted = PeopleFixtureScript.everyoneMuted(PeopleFixtureScript.hostSix())
        #expect(muted.first { $0.userId == "u-avery" }?.isMuted == false, "co-hosts keep their microphone")
        #expect(muted.first { $0.userId == "u-priya" }?.isMuted == true)
        #expect(PeopleFixtureScript.showsKnock(.hostWaiting3) && !PeopleFixtureScript.showsKnock(.host6))
        #expect(PeopleFixtureScript.ackDelayMillis == 150)
    }

}

private func ppl3Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func ppl3Normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
#endif
