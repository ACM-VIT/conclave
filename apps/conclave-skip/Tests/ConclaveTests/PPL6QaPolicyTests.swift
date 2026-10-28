#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// PPL-6 (OUT/PLAN-screens.md section 5): the Webinar Q&A panel. QaOrderingPolicy (PL9: Top, Recent, Mine; host sorts
/// Top and Recent only; attendees never see dismissed questions; the host filter), the one unseen counter (PH7, D12,
/// RECONCILE R18: zero while open, arrivals after close only, never a lifetime total), WebinarQAPresenter's dispatch
/// through the one People ledger (submit, upvote, moderate, written answers), its failure placement and copy, the Q&A
/// off close with the announcement, the needsRejoin state, the composer rules, and source pins for the iOS panel (OQ2
/// composer, PL15 answer page) and the Kotlin page. The Kotlin half is T/Skip/PPL6QaBridgeTests.kt.
@MainActor
struct PPL6QaPolicyTests {
    private final class CommandLog {
        var commands: [PeopleCommand] = []
        var tickets: [HostActionTicket] = []
    }

    private func model(_ id: String, status: QaStatus = .pending, upvotes: Int = 0, asked: Double = 0.0,
                       mine: Bool = false) -> QaQuestionModel {
        QaQuestionModel(id: id, askerName: "A", isMine: mine, text: id, status: status, askedAtMillis: asked, upvotes: upvotes,
                        hasUpvoted: false, answerText: "", answeredByName: "", pendingAction: "",
                        blockedReason: MeetingBlockedReason.none.rawValue)
    }

    private static let me = "a-priya#s1"

    private static func entries() -> [QaEntryInput] {
        [
            QaEntryInput.make(id: "q1", userId: "a-omar#s1", askerName: "Omar K.", question: "Rotate?", status: "answering",
                              askedAtMillis: 1000.0, upvotes: 12),
            QaEntryInput.make(id: "q2", userId: "a-mina#s1", askerName: "Mina T.", question: "Slides?", status: "pending",
                              askedAtMillis: 2000.0, upvotes: 4),
            QaEntryInput.make(id: "q3", userId: me, askerName: "Priya N.", question: "Recording?", status: "pending",
                              askedAtMillis: 3000.0, upvotes: 4),
            QaEntryInput.make(id: "q4", userId: "a-jo#s1", askerName: "Jo B.", question: "Notes?", status: "answered",
                              askedAtMillis: 500.0, upvotes: 6, answerText: "In the chat.", answeredByName: "Ishaan"),
            QaEntryInput.make(id: "q5", userId: me, askerName: "Priya N.", question: "Share?", status: "dismissed",
                              askedAtMillis: 4000.0),
        ]
    }

    private func qaPeople(role: String, qaEnabled: Bool = true, snapshot: Bool = true, becameHost: Bool = false,
                          blocked: String = MeetingBlockedReason.none.rawValue) -> (PeoplePresenter, CommandLog) {
        let shell = MeetingShellPresenter()
        let people = PeoplePresenter(shell: shell, stage: StagePresenter(shell: shell))
        let log = CommandLog()
        people.onCommand = { command, ticket in
            log.commands.append(command)
            log.tickets.append(ticket)
        }
        people.platform = NoticePlatform.ios
        let attendee = role == QaRole.attendee
        people.apply(PeopleInputs.make(
            callSession: 1, attempt: 1, phase: MeetingPhaseKind.inCall.rawValue, localUserId: attendee ? Self.me : "u-ishaan",
            participants: [PeopleParticipantInput.make(userId: attendee ? Self.me : "u-ishaan", displayName: "Me", isLocal: true)],
            isRosterLoaded: true, isAdmin: !attendee, hostUserId: attendee ? "u-ishaan" : "u-ishaan", hostUserIds: ["u-ishaan"],
            isWebinarAttendee: attendee, isWebinarEnabled: true, isWebinarQaEnabled: qaEnabled))
        people.qa.apply(QaInputs.make(callSession: 1, attempt: 1, localUserId: attendee ? Self.me : "u-ishaan", role: role,
                                      isWebinarEnabled: true, isQaEnabled: qaEnabled, isSnapshotReceived: snapshot,
                                      becameHostAfterJoin: becameHost, blockedReason: blocked, entries: Self.entries()))
        return (people, log)
    }

    // MARK: PL9 ordering

    @Test func topPutsTheLiveQuestionFirstThenVotesThenAskedTime() {
        let questions = [model("a", upvotes: 4, asked: 2), model("b", status: .answering, upvotes: 1, asked: 5),
                         model("c", upvotes: 9, asked: 3), model("d", upvotes: 4, asked: 1)]
        #expect(QaOrderingPolicy.orderedIds(questions, role: QaRole.attendee, sort: .top, filter: .openQuestions) == ["b", "c", "d", "a"])
        // Recent: the live question first, then the newest asked.
        #expect(QaOrderingPolicy.orderedIds(questions, role: QaRole.attendee, sort: .recent, filter: .openQuestions) == ["b", "c", "a", "d"])
    }

    @Test func attendeesNeverSeeDismissedAndMineIsOwnOnly() {
        let questions = [model("x", status: .dismissed, mine: true), model("y", asked: 2, mine: true), model("z", asked: 3)]
        // Equal votes order by asked time; your dismissed question never shows (web parity).
        #expect(QaOrderingPolicy.orderedIds(questions, role: QaRole.attendee, sort: .top, filter: .openQuestions) == ["y", "z"])
        #expect(QaOrderingPolicy.orderedIds(questions, role: QaRole.attendee, sort: .mine, filter: .openQuestions) == ["y"])
    }

    @Test func hostsGetTopAndRecentOnlyAndTheFilter() {
        #expect(QaOrderingPolicy.availableSorts(role: QaRole.host) == [.top, .recent])
        #expect(QaOrderingPolicy.availableSorts(role: QaRole.attendee) == [.top, .recent, .mine])
        #expect(QaOrderingPolicy.effectiveSort(.mine, role: QaRole.host) == .top)
        let questions = [model("p"), model("l", status: .answering), model("a", status: .answered), model("d", status: .dismissed)]
        #expect(Set(QaOrderingPolicy.orderedIds(questions, role: QaRole.host, sort: .top, filter: .openQuestions)) == ["p", "l"])
        #expect(QaOrderingPolicy.orderedIds(questions, role: QaRole.host, sort: .top, filter: .answered) == ["a"])
        #expect(QaOrderingPolicy.orderedIds(questions, role: QaRole.host, sort: .top, filter: .dismissed) == ["d"])
        #expect(QaOrderingPolicy.counts(questions) == [2, 1, 1])
        #expect(QaOrderingPolicy.hostActions(.pending) == ["answering", "answered", "answerText", "dismissed"])
        #expect(QaOrderingPolicy.hostActions(.answered) == ["reopen"])
        #expect(QaOrderingPolicy.leadingSwipe(.answering) == "answered")
    }

    // MARK: R18 one unseen counter

    @Test func theUnseenCounterCountsOnlyArrivalsAfterTheMarker() {
        // Attendee: a question counts the first time it is published; answering then answered is one.
        #expect(QaUnseenPolicy.counts(role: QaRole.attendee, previousStatus: "pending", nextStatus: "answering", isMine: false,
                                      isPanelOpen: false))
        #expect(!QaUnseenPolicy.counts(role: QaRole.attendee, previousStatus: "answering", nextStatus: "answered", isMine: false,
                                       isPanelOpen: false))
        #expect(!QaUnseenPolicy.counts(role: QaRole.attendee, previousStatus: "", nextStatus: "pending", isMine: true,
                                       isPanelOpen: false))
        // Host: a new pending question counts; a status change does not.
        #expect(QaUnseenPolicy.counts(role: QaRole.host, previousStatus: "", nextStatus: "pending", isMine: false, isPanelOpen: false))
        #expect(!QaUnseenPolicy.counts(role: QaRole.host, previousStatus: "pending", nextStatus: "answering", isMine: false,
                                       isPanelOpen: false))
        // While the panel is open nothing counts (D12, web PPL-34).
        #expect(!QaUnseenPolicy.counts(role: QaRole.host, previousStatus: "", nextStatus: "pending", isMine: false, isPanelOpen: true))
        var ids = QaUnseenPolicy.counted([], id: "q1", counts: true)
        ids = QaUnseenPolicy.counted(ids, id: "q1", counts: true)
        #expect(ids == ["q1"])
        #expect(QaUnseenPolicy.derived(role: QaRole.attendee, isQaEnabled: true, attendeeCount: 2, hostCount: 5) == 2)
        #expect(QaUnseenPolicy.derived(role: QaRole.host, isQaEnabled: true, attendeeCount: 2, hostCount: 5) == 5)
        #expect(QaUnseenPolicy.derived(role: QaRole.host, isQaEnabled: false, attendeeCount: 2, hostCount: 5) == 0)
        #expect(QaUnseenPolicy.role(isWebinarAttendee: false, isAdmin: false) == QaRole.none)
    }

    // MARK: WebinarQAPresenter

    @Test func theAttendeeSnapshotOrdersAndHidesDismissed() {
        let (people, _) = qaPeople(role: QaRole.attendee)
        let snapshot = people.qa.snapshot
        #expect(snapshot.isAttendee && snapshot.isEnabled && snapshot.isLoaded)
        #expect(snapshot.availableSorts == ["top", "recent", "mine"])
        #expect(snapshot.questionIds.first == "q1")
        #expect(!snapshot.questionIds.contains("q5"))
        #expect(people.qa.questions.entry(for: "q3").model.isMine)
        people.qa.setSort(.mine)
        #expect(people.qa.snapshot.questionIds == ["q3"])
        #expect(snapshot.composerEnabled)
    }

    @Test func submitIsOneTicketAndClearsTheDraftOnTheAcknowledgement() throws {
        let (people, log) = qaPeople(role: QaRole.attendee)
        let qa = people.qa
        #expect(qa.submit("?") == .ignored)
        #expect(QaComposerPolicy.isTooShort("?"))
        qa.drafts.question = "Will there be a recording?"
        #expect(qa.submit("Will there be a recording?") == .dispatched)
        #expect(log.commands.last?.kind == .qaSubmit)
        #expect(qa.snapshot.submitPhase == QaSubmitPhase.sending)
        #expect(qa.submit("Again?") == .ignored)
        let serial = qa.snapshot.submitSerial
        people.finish(try #require(log.tickets.first), HostActionResult.completed)
        #expect(qa.snapshot.submitSerial == serial + 1 && qa.drafts.question.isEmpty)
        #expect(people.feedbackState.token.kind == .questionSent)
    }

    @Test func anAttendeeSubmitFailureReportsInlineWithTheQaSentence() throws {
        let (people, log) = qaPeople(role: QaRole.attendee)
        people.qa.submit("A longer question")
        people.finish(try #require(log.tickets.first), HostActionResult.failed(.rateLimited))
        let failure = people.lastFailure
        // Not swallowed for a non-host viewer (Q&A is not a host action).
        #expect(failure?.sourceKey == QaFieldID.composer)
        #expect(failure?.placement == HostFailurePlacement.panelInline.rawValue)
        #expect(PeopleFailureCopy.kind(action: failure?.action ?? "", failure: failure?.failure ?? "",
                                       sourceKey: failure?.sourceKey ?? "") == PeopleFailureCopy.qaRateLimited)
        #expect(people.feedbackState.token.kind == .questionFailed)
        #expect(people.qa.snapshot.submitPhase == QaSubmitPhase.failed)
    }

    @Test func upvoteTogglesAndStaysDisabledUntilTheAcknowledgement() {
        let (people, log) = qaPeople(role: QaRole.attendee)
        #expect(people.qa.toggleUpvote(id: "q2") == .dispatched)
        #expect(log.commands.last?.kind == .qaUpvote && log.commands.last?.flag == true)
        #expect(people.qa.questions.entry(for: "q2").model.pendingAction == "upvote")
        #expect(!people.qa.questions.entry(for: "q2").model.isEnabled)
        #expect(people.qa.toggleUpvote(id: "q2") == .ignored)
    }

    @Test func hostsModerateByStatusAndPostWrittenAnswers() {
        let (people, log) = qaPeople(role: QaRole.host)
        let qa = people.qa
        #expect(qa.snapshot.availableSorts == ["top", "recent"])
        // Open is pending or answering (S50 11 c, QaStatus.isOpen): q1 answering plus q2 and q3 pending; q4 answered;
        // q5 dismissed.
        #expect(qa.snapshot.counts == [3, 1, 1])
        #expect(qa.toggleUpvote(id: "q2") == .ignored)
        #expect(qa.perform(hostAction: QaModerationAction.answering, id: "q2") == .dispatched)
        #expect(log.commands.last?.kind == .qaModerate && log.commands.last?.detail == "answering")
        // One action per question at a time.
        #expect(qa.perform(hostAction: QaModerationAction.dismissed, id: "q2") == .ignored)
        // Reopen is not offered for an open question.
        #expect(qa.perform(hostAction: QaModerationAction.reopen, id: "q1") == .ignored)
        #expect(qa.moderate(id: "q1", action: .answered, reopen: false, answerText: String(repeating: "a", count: 1001)) == .ignored)
        qa.drafts.answers["q1"] = "In the chat after the session."
        #expect(qa.moderate(id: "q1", action: .answered, reopen: false, answerText: "In the chat after the session.") == .dispatched)
        #expect(log.commands.last?.text == "In the chat after the session.")
        #expect(qa.questions.entry(for: "q1").model.pendingAction == QaHostAction.answerText)
        let serial = qa.snapshot.answerSerial
        people.finish(log.tickets[log.tickets.count - 1], HostActionResult.completed)
        #expect(qa.snapshot.answerSerial == serial + 1 && qa.snapshot.answeredQuestionId == "q1")
        #expect(qa.drafts.answers["q1"] == nil)
    }

    @Test func turningQaOffClosesTheOpenPanelWithTheAnnouncement() {
        let (people, _) = qaPeople(role: QaRole.attendee)
        people.shell.panels.present(.webinarQA, from: .call)
        let presentation = people.shell.panels.snapshot.current?.presentationID ?? 0
        people.qa.panelDidOpen(presentationID: presentation)
        #expect(people.qa.isPanelOpen)
        people.qa.apply(QaInputs.make(callSession: 1, attempt: 1, localUserId: Self.me, role: QaRole.attendee,
                                      isWebinarEnabled: true, isQaEnabled: false, isSnapshotReceived: true,
                                      blockedReason: MeetingBlockedReason.none.rawValue, entries: Self.entries()))
        #expect(people.shell.panels.snapshot.isDismissing)
        #expect(people.stage.announcement?.kind == PeopleAnnouncementKind.qaOff)
        #expect(people.qa.snapshot.composerReason == QaComposerReason.qaOff)
    }

    @Test func aHostPromotedMidWebinarSeesQuestionsUnavailable() {
        let (people, _) = qaPeople(role: QaRole.host, snapshot: false, becameHost: true)
        #expect(people.qa.snapshot.availability == QaAvailability.needsRejoin)
        let (joined, _) = qaPeople(role: QaRole.host, snapshot: false, becameHost: false)
        #expect(joined.qa.snapshot.availability == QaAvailability.available && !joined.qa.snapshot.isLoaded)
    }

    @Test func recoveryDisablesTheComposerVotesAndModeration() {
        let (people, _) = qaPeople(role: QaRole.attendee, blocked: MeetingBlockedReason.reconnecting.rawValue)
        #expect(!people.qa.snapshot.composerEnabled && people.qa.snapshot.composerReason == QaComposerReason.reconnecting)
        #expect(!people.qa.questions.entry(for: "q2").model.isEnabled)
        #expect(people.qa.toggleUpvote(id: "q2") == .ignored)
    }

    @Test func theUnseenValueFeedsTheParticipantsRowForHostsOnly() {
        let (people, _) = qaPeople(role: QaRole.host)
        people.qa.apply(QaInputs.make(callSession: 1, attempt: 1, localUserId: "u-ishaan", role: QaRole.host, isWebinarEnabled: true,
                                      isQaEnabled: true, isSnapshotReceived: true,
                                      blockedReason: MeetingBlockedReason.none.rawValue, entries: Self.entries(), unseen: 3))
        #expect(people.qa.unseen == 3 && people.qaUnseen == 3)
        #expect(QaComposerPolicy.canPostAnswer(String(repeating: "a", count: 1000), isPending: false))
        #expect(!QaComposerPolicy.canPostAnswer(String(repeating: "a", count: 1001), isPending: false))
        #expect(QaComposerPolicy.showsQuestionCounter(450) && !QaComposerPolicy.showsQuestionCounter(449))
    }

    // MARK: Source pins

    @Test func thePlatformPanelsFollowTheSpec() throws {
        let panel = try ppl6Source("Sources/Conclave/Features/Meeting/Webinar/QaPanel+iOS.swift")
        #expect(panel.contains("ConclaveComposerField(identifier: \"qa.composer.cluster\")"), "OQ2: the one composer glass file")
        #expect(panel.contains(".navigationDestination(for: QaRoute.self)"))
        #expect(panel.contains("people.qa.panelDidOpen(presentationID: presentation.request.presentationID)"))
        #expect(panel.contains("if dynamicTypeSize.isAccessibilitySize {\n                    sortPicker.pickerStyle(.menu)\n                } else {\n                    sortPicker.pickerStyle(.segmented)"))
        let answer = try ppl6Source("Sources/Conclave/Features/Meeting/Webinar/QaAnswerPage+iOS.swift")
        #expect(answer.contains(".lineLimit(4...12)") && answer.contains("ToolbarItem(placement: .confirmationAction)"))
        let row = try ppl6Source("Sources/Conclave/Features/Meeting/Webinar/QuestionRow+iOS.swift")
        #expect(row.contains(".accessibilityAddTraits(model.hasUpvoted ? .isSelected : [])"))
        #expect(row.contains(".conclaveGestureFeedback(.upvoteChanged, trigger: upvoteTicks)"))
        let page = try ppl6Source("Sources/Conclave/Skip/ui/qa/QaPage.kt")
        #expect(page.contains("contentMode = InCallPageContent.lazyList"))
        #expect(page.contains("ConclaveTextEntryKind.multiline"))
        let kotlinRow = try ppl6Source("Sources/Conclave/Skip/ui/qa/QuestionRow.kt")
        #expect(kotlinRow.contains("haptics.gesture(FeedbackKind.upvoteChanged)"))
        #expect(kotlinRow.contains("FilterChip("))
        let vm = try ppl6Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(vm.contains("self.syncWebinarQaPanelOpenState()"))
        #expect(vm.contains("socketManager.onWebinarQaChanged = {"))
        for path in ["Sources/Conclave/Features/Meeting/Webinar/WebinarQAModels.swift",
                     "Sources/Conclave/Features/Meeting/Webinar/WebinarQAPresenter.swift",
                     "Sources/Conclave/Features/Meeting/Webinar/QaOrderingPolicy.swift",
                     "Sources/Conclave/Features/Meeting/Webinar/QaUnseenPolicy.swift",
                     "Sources/Conclave/Features/Meeting/Webinar/QaPanel+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Webinar/QuestionRow+iOS.swift",
                     "Sources/Conclave/Features/Meeting/Webinar/QaAnswerPage+iOS.swift",
                     "Sources/Conclave/Skip/ui/qa/QaPage.kt",
                     "Sources/Conclave/Skip/ui/qa/QuestionRow.kt"] {
            let source = try ppl6Source(path)
            #expect(!source.lowercased().contains("gradient"), "\(path) draws a gradient")
            #expect(!source.contains("\u{2014}") && !source.contains("\u{2013}"), "\(path) has a long dash")
            #expect(!source.contains("Color(red:") && !source.contains("Color(0x"), "\(path) has a color literal")
            #expect(!source.contains("Image(systemName: \""), "\(path) names a raw symbol")
        }
    }
}

private func ppl6Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}
#endif
