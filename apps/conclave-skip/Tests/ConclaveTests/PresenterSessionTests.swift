#if !SKIP
import Foundation
import Observation
import Testing
@testable import Conclave

@MainActor
struct PresenterSessionTests {

    private func identity(_ callSession: Int, _ attempt: Int = 1, _ token: String = "attempt") -> MeetingSessionIdentity {
        MeetingSessionIdentity(callSession: callSession, attempt: attempt, attemptToken: "\(token)-\(callSession)-\(attempt)")
    }

    private func joined(
        _ callSession: Int = 1,
        attempt: Int = 1,
        isAdmin: Bool = false,
        isWebinarAttendee: Bool = false,
        isMuted: Bool = true,
        isCameraOff: Bool = true,
        isHandRaised: Bool = false,
        isRecoveringConnection: Bool = false,
        connectionState: ConnectionState = .joined,
        unreadChatCount: Int = 0,
        micToggleInFlight: Bool = false,
        cameraToggleInFlight: Bool = false,
        terminalOutcome: MeetingTerminalOutcome? = nil
    ) -> MeetingShellInputs {
        MeetingShellInputs.make(
            identity: identity(callSession, attempt),
            connectionState: connectionState,
            isRecoveringConnection: isRecoveringConnection,
            roomId: "lily-zoro-iris",
            displayName: "Avery",
            isAdmin: isAdmin,
            isWebinarAttendee: isWebinarAttendee,
            isMuted: isMuted,
            isCameraOff: isCameraOff,
            isHandRaised: isHandRaised,
            unreadChatCount: unreadChatCount,
            terminalOutcome: terminalOutcome,
            micToggleInFlight: micToggleInFlight,
            cameraToggleInFlight: cameraToggleInFlight
        )
    }

    private final class CommandLog {
        var commands: [MeetingShellCommand] = []
        var tickets: [MeetingActionTicket] = []
    }

    private func presenter(_ log: CommandLog, _ inputs: MeetingShellInputs) -> MeetingShellPresenter {
        let presenter = MeetingShellPresenter()
        presenter.onCommand = { command, ticket in
            log.commands.append(command)
            if let ticket { log.tickets.append(ticket) }
        }
        presenter.apply(inputs)
        return presenter
    }

    private func row(_ presenter: MeetingShellPresenter, _ id: MeetingControlID) -> MeetingControlRow {
        presenterSessionRow(presenter.controls.rows, id)
    }

    @Test func staleCallbacks() throws {

        let log = CommandLog()
        let shell = presenter(log, joined())
        #expect(shell.toggleHand() == .dispatched)
        let ticket = try #require(log.tickets.first)
        shell.apply(joined(attempt: 2))
        #expect(shell.ledger.result(of: ticket.id)?.kind == .interrupted)
        let publishes = shell.snapshotPublishCount
        #expect(!shell.finish(ticket, MeetingActionResult.completed))
        #expect(shell.snapshotPublishCount == publishes)

        #expect(shell.toggleHand() == .dispatched)
        try #require(log.tickets.count > 1)
        let second = log.tickets[1]
        #expect(shell.finish(second, MeetingActionResult.completed))
        #expect(!shell.finish(second, MeetingActionResult.completed))
        #expect(!row(shell, .hand).isPending)
    }

    @Test func roomSwitch() throws {

        let log = CommandLog()
        let shell = presenter(log, joined(isAdmin: true))
        #expect(shell.toggleHand() == .dispatched)
        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.more)
        shell.panels.present(.chat, from: .call)
        #expect(shell.session.confirmation != nil && shell.panels.snapshot.current != nil)
        var publishes: [(MeetingSessionSnapshot, MeetingControlRowsState, MeetingShellFeedbackState)] = []
        shell.onPublish = { session, controls, feedback in publishes.append((session, controls, feedback)) }
        shell.apply(joined(2, isAdmin: true))
        try #require(publishes.count == 1)
        let published = publishes[0]
        #expect(published.0.identity.callSession == 2)
        #expect(published.0.confirmation == nil)
        #expect(published.2 == MeetingShellFeedbackState(session: 2, token: FeedbackToken.baseline))
        #expect(!published.1.rows.contains { $0.isPending })
        #expect(shell.panels.snapshot.session == 2 && shell.panels.snapshot.current == nil)
        try #require(log.tickets.count > 0)
        #expect(shell.ledger.result(of: log.tickets[0].id)?.kind == .cancelled)

        #expect(!shell.finish(log.tickets[0], MeetingActionResult.failed(.ackTimedOut)))
        #expect(row(shell, .hand).failure == .none)

        #expect(!MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin: true, reuseExistingSocket: false, previousConnectionState: .reconnecting))
        #expect(!MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin: false, reuseExistingSocket: true, previousConnectionState: .waiting))
        #expect(!MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin: false, reuseExistingSocket: true, previousConnectionState: .joining))
        #expect(MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin: false, reuseExistingSocket: false, previousConnectionState: .disconnected))
        #expect(shell.toggleHand() == .dispatched)
        shell.apply(joined(2, attempt: 2, isAdmin: true, isRecoveringConnection: false))
        try #require(log.tickets.count > 1)
        #expect(shell.ledger.result(of: log.tickets[1].id)?.kind == .interrupted)
    }

    @Test func lostAcknowledgment() throws {

        #expect(MeetingActionFailurePolicy.classify(PresenterHostError("Timed out waiting for the SFU")) == .ackTimedOut)

        let kotlinTimeout = NSError(domain: "skip.lib.ErrorException", code: 0, userInfo: [
            NSLocalizedDescriptionKey: "Timed out waiting for setHandRaised acknowledgement"
        ])
        #expect(MeetingActionFailurePolicy.classify(kotlinTimeout) == .ackTimedOut)

        let log = CommandLog()
        let shell = presenter(log, joined())
        #expect(shell.toggleHand() == .dispatched)
        try #require(log.tickets.count > 0)
        #expect(shell.finish(log.tickets[0], MeetingActionResult.failed(.ackTimedOut)))
        #expect(row(shell, .hand).failure == .ackTimedOut && !row(shell, .hand).isOn)
        shell.apply(joined(isHandRaised: true))
        #expect(row(shell, .hand).isOn)

        let recovery = presenter(CommandLog(), joined())
        let recoveryLog = CommandLog()
        recovery.onCommand = { _, ticket in if let ticket { recoveryLog.tickets.append(ticket) } }
        #expect(recovery.toggleHand() == .dispatched)
        recovery.apply(joined(isRecoveringConnection: true, connectionState: .reconnecting))
        #expect(!row(recovery, .hand).isPending)
        try #require(recoveryLog.tickets.count > 0)
        #expect(recovery.ledger.result(of: recoveryLog.tickets[0].id)?.kind == .interrupted)
        #expect(!recovery.finish(recoveryLog.tickets[0], MeetingActionResult.completed))
    }

    @Test func duplicateAction() throws {

        let log = CommandLog()
        let shell = presenter(log, joined(isAdmin: true))
        #expect(shell.toggleHand() == .dispatched)
        let publishes = shell.snapshotPublishCount
        #expect(shell.toggleHand() == .duplicate)
        #expect(log.commands == [.toggleHand])
        #expect(shell.snapshotPublishCount == publishes)

        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.more)
        let confirmation = try #require(shell.session.confirmation)
        #expect(confirmation.invoker == MeetingConfirmationInvoker.more)
        #expect(shell.confirmEndForEveryone(id: confirmation.id) == .dispatched)
        #expect(shell.confirmEndForEveryone(id: confirmation.id) == .duplicate)
        #expect(log.commands.filter { $0 == .endForEveryone }.count == 1)

        let media = CommandLog()
        let unmutePending = presenter(media, joined(isMuted: false, micToggleInFlight: true))
        #expect(row(unmutePending, .microphone).isPending)
        #expect(unmutePending.toggleMicrophone() == .dispatched)
        #expect(media.commands == [.toggleMicrophone])
        let mutePending = presenter(media, joined(isMuted: true, micToggleInFlight: true))
        #expect(mutePending.toggleMicrophone() == .duplicate)
        #expect(media.commands == [.toggleMicrophone])
        let cameraOnPending = presenter(media, joined(isCameraOff: false, cameraToggleInFlight: true))
        #expect(cameraOnPending.toggleCamera() == .dispatched)
        let cameraOffPending = presenter(media, joined(isCameraOff: true, cameraToggleInFlight: true))
        #expect(cameraOffPending.toggleCamera() == .duplicate)
        #expect(media.commands == [.toggleMicrophone, .toggleCamera])
    }

    @Test func roleChange() throws {

        let log = CommandLog()
        let shell = presenter(log, joined(isAdmin: true))
        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.call)
        #expect(shell.session.confirmation != nil)
        shell.apply(joined(isAdmin: false))
        #expect(shell.session.confirmation == nil)
        #expect(!row(shell, .endForEveryone).isVisible)
        #expect(row(shell, .endForEveryone).blockedReason == .hostOnly)
        #expect(!shell.session.canEndForEveryone)

        shell.apply(joined(isWebinarAttendee: true))
        for id in [MeetingControlID.microphone, .camera, .screenShare, .hand] {
            #expect(row(shell, id).blockedReason == .attendee, "\(id)")
            #expect(!row(shell, id).isEnabled, "\(id)")
        }
        #expect(shell.toggleMicrophone() == .unavailable)

        let ending = CommandLog()
        let host = presenter(ending, joined(isAdmin: true))
        host.requestEndForEveryone(from: MeetingConfirmationInvoker.more)
        let endConfirmation = try #require(host.session.confirmation)
        #expect(host.confirmEndForEveryone(id: endConfirmation.id) == .dispatched)
        host.apply(joined(isAdmin: false))
        #expect(host.ledger.isPending(.endForEveryone))
        try #require(ending.tickets.count > 0)
        #expect(host.finish(ending.tickets[0], MeetingActionResult.completed))
    }

    @Test func oneRowUpdates() {
        let log = CommandLog()
        let shell = presenter(log, joined())

        let before = shell.controls
        shell.apply(joined(isHandRaised: true))
        let after = shell.controls
        #expect(after.revision == before.revision + 1)
        for (old, new) in zip(before.rows, after.rows) where old.id != MeetingControlID.hand.rawValue {
            #expect(old == new, "\(old.id)")
        }
        #expect(after.rows.first { $0.id == "hand" }?.isOn == true)

        shell.apply(joined(isHandRaised: true, unreadChatCount: 3))
        let chat = shell.controls
        #expect(chat.revision == after.revision + 1)
        for (old, new) in zip(after.rows, chat.rows) where old.id != MeetingControlID.chat.rawValue {
            #expect(old == new, "\(old.id)")
        }
        #expect(row(shell, .chat).badgeCount == 3)

        shell.apply(joined(isHandRaised: true, isRecoveringConnection: true, connectionState: .reconnecting, unreadChatCount: 3))
        #expect(shell.controls.rows.map { $0.id } == MeetingControlID.allCases.map { $0.rawValue })
        #expect(row(shell, .hand).blockedReason == .reconnecting)
        #expect(row(shell, .microphone).isEnabled && row(shell, .microphone).hint == .appliesAfterReconnect)
        #expect(row(shell, .screenShare).blockedReason == .reconnecting)

        let revision = shell.controls.revision
        let publishes = shell.snapshotPublishCount
        shell.apply(joined(isHandRaised: true, isRecoveringConnection: true, connectionState: .reconnecting, unreadChatCount: 3))
        #expect(shell.controls.revision == revision)
        #expect(shell.snapshotPublishCount == publishes)
    }

    @Test func ledgerIdsNeverReuseAcrossSessions() throws {
        let ledger = MeetingActionLedger()
        let first = try #require(ledger.begin(.hand, identity: identity(1)))
        #expect(ledger.begin(.hand, identity: identity(1)) == nil)
        ledger.cancelAll()
        let second = try #require(ledger.begin(.hand, identity: identity(2)))
        #expect(second.id > first.id)
        #expect(!ledger.finish(first, result: MeetingActionResult.completed, currentIdentity: identity(2)))
        #expect(!ledger.finish(second, result: MeetingActionResult.completed, currentIdentity: identity(1)))
        #expect(ledger.finish(second, result: MeetingActionResult.completed, currentIdentity: identity(2)))
    }

    @Test func failureClassifierTable() {
        #expect(MeetingActionFailurePolicy.classify(PresenterHostError("Timed out waiting for the SFU")) == .ackTimedOut)
        #expect(MeetingActionFailurePolicy.classify(message: "Timed out waiting for setHandRaised acknowledgement") == .ackTimedOut)
        #expect(MeetingActionFailurePolicy.classify(message: "Socket changed before setHandRaised acknowledgement") == .socketReplaced)
        #expect(MeetingActionFailurePolicy.classify(message: "Socket is not connected") == .notConnected)
        #expect(MeetingActionFailurePolicy.classify(PresenterHostError("Socket is not connected")) == .notConnected)
        #expect(MeetingActionFailurePolicy.classify(message: "Socket not connected") == .notConnected)
        #expect(MeetingActionFailurePolicy.classify(message: "Room is locked") == .rejectedByServer)
        #expect(MeetingActionFailurePolicy.classify(message: "Microphone permission denied") == .permissionDenied)
        #expect(MeetingActionFailurePolicy.classify(message: "Only the host can end the meeting") == .roleRequired)
        #expect(MeetingActionFailurePolicy.classify(message: "  ") == .unknown)
        let result = MeetingActionFailurePolicy.result(for: PresenterHostError("Room is locked"))
        #expect(result == MeetingActionResult.failed(.rejectedByServer, serverText: "Room is locked"))
    }

    @Test func phasePolicyMatchesR08Table() {
        func phase(_ inputs: MeetingShellInputs) -> MeetingPhaseResolution { MeetingPhasePolicy.resolve(inputs) }
        let session = identity(1)
        func outcome(_ kind: MeetingTerminalOutcomeKind, _ text: String = "server text") -> MeetingTerminalOutcome {
            MeetingTerminalOutcome(id: 1, callSession: 1, kind: kind, serverText: text)
        }
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .joined, terminalOutcome: outcome(.left), isTearingDown: true)).phase == .leaving)
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .joined)) == MeetingPhaseResolution(phase: .inCall, notice: .none, noticeText: nil))
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .joined, isNetworkOffline: true)).notice == .offline)
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .joined, serverRestartNotice: "Restarting")) == MeetingPhaseResolution(phase: .inCall, notice: .serverRestarting, noticeText: "Restarting"))
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .reconnecting)) == MeetingPhaseResolution(phase: .recovering, notice: .reconnecting, noticeText: nil))
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .joining, isRecoveringConnection: true)).phase == .recovering)
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .reconnecting, isResumingFromBackground: true)).notice == .resuming)
        for state in [ConnectionState.connecting, .connected, .joining] {
            #expect(phase(MeetingShellInputs.make(identity: session, connectionState: state)).phase == .entering, "\(state)")
        }
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .waiting, waitingMessage: "Waiting")) == MeetingPhaseResolution(phase: .waiting, notice: .none, noticeText: "Waiting"))
        for kind in [MeetingTerminalOutcomeKind.removed, .denied, .joinFailed, .connectionLost] {
            #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .error, terminalOutcome: outcome(kind))).phase == .outcome, "\(kind)")
        }
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .error, terminalOutcome: outcome(.roomClosed, "Room closed"))) == MeetingPhaseResolution(phase: .home, notice: .roomClosed, noticeText: "Room closed"))
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .disconnected, meetingEndedNoticeMessage: "Ended", terminalOutcome: outcome(.endedByHost))) == MeetingPhaseResolution(phase: .home, notice: .endedByHost, noticeText: "Ended"))
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .disconnected, meetingEndedNoticeMessage: "Ended")).notice == .endedByHost)
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .disconnected, joinFormErrorMessage: "No room found")) == MeetingPhaseResolution(phase: .home, notice: .formError, noticeText: "No room found"))
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .disconnected, terminalOutcome: outcome(.endedByYou))) == MeetingPhaseResolution(phase: .home, notice: .none, noticeText: nil))
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .disconnected)) == MeetingPhaseResolution(phase: .home, notice: .none, noticeText: nil))

        #expect(phase(MeetingShellInputs.make(identity: identity(2), connectionState: .error, terminalOutcome: outcome(.removed))).phase == .home)
    }

    @Test func availabilityMatchesLegacyControlsBarTable() {
        let states: [ConnectionState] = [.disconnected, .connecting, .connected, .joining, .joined, .reconnecting, .waiting, .error]
        for state in states {
            for recovering in [false, true] {
                for attendee in [false, true] {
                    for audioOnly in [false, true] {
                        for remoteShare in [false, true] {
                            for reactionsDisabled in [false, true] {
                                for admin in [false, true] {
                                    let inputs = MeetingShellInputs.make(
                                        identity: identity(1), connectionState: state, isRecoveringConnection: recovering,
                                        isAdmin: admin, isWebinarAttendee: attendee, isAudioOnlyMode: audioOnly,
                                        hasActiveRemoteScreenShare: remoteShare, isReactionsDisabled: reactionsDisabled
                                    )
                                    let context = MeetingControlRowContext.make(phase: MeetingPhasePolicy.resolve(inputs).phase)
                                    let rows = MeetingControlAvailabilityPolicy.rows(inputs, context: context)
                                    func find(_ id: MeetingControlID) -> MeetingControlRow { presenterSessionRow(rows, id) }

                                    let isJoined = state == .joined
                                    let canChange = MeetingMediaControlAvailabilityPolicy.canChangeLocalMediaIntent(
                                        connectionState: state, isRecoveringConnection: recovering, mediaPublishingDisabled: attendee
                                    )
                                    let participantActions = isJoined && !attendee
                                    let label = "\(state) r\(recovering) a\(attendee) ao\(audioOnly) rs\(remoteShare) rd\(reactionsDisabled) h\(admin)"
                                    #expect(find(.microphone).isVisible == !attendee, "\(label)")
                                    #expect(find(.microphone).isEnabled == canChange, "\(label)")
                                    #expect(find(.camera).isEnabled == (canChange && !audioOnly), "\(label)")
                                    #expect(find(.screenShare).isEnabled == !(!isJoined || attendee || remoteShare || audioOnly), "\(label)")
                                    #expect(find(.hand).isEnabled == participantActions, "\(label)")
                                    #expect(find(.reactions).isVisible == (!attendee && (!reactionsDisabled || admin)), "\(label)")
                                    if find(.reactions).isVisible {
                                        #expect(find(.reactions).isEnabled == participantActions, "\(label)")
                                    }
                                    #expect(find(.endForEveryone).isVisible == (admin && !attendee), "\(label)")
                                    #expect(find(.endForEveryone).isEnabled == (admin && !attendee && isJoined && !recovering), "\(label)")
                                    #expect(rows.map { $0.id } == MeetingControlID.allCases.map { $0.rawValue })
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    @Test func everyPublishedSnapshotIsSessionCoherent() {
        let log = CommandLog()
        let shell = presenter(log, joined(isAdmin: true))
        var publishes: [(MeetingSessionSnapshot, MeetingControlRowsState, MeetingShellFeedbackState)] = []
        shell.onPublish = { session, controls, feedback in publishes.append((session, controls, feedback)) }
        #expect(shell.toggleHand() == .dispatched)
        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.more)

        shell.apply(joined(isAdmin: true, isRecoveringConnection: true, connectionState: .reconnecting))
        shell.apply(joined(isAdmin: true))
        let removed = MeetingTerminalOutcome(id: 7, callSession: 1, kind: .removed, serverText: "Removed")
        shell.apply(joined(isAdmin: true, connectionState: .error, terminalOutcome: removed))
        shell.apply(joined(2, isAdmin: true, connectionState: .connecting, terminalOutcome: removed))
        shell.apply(joined(2, isAdmin: true, terminalOutcome: removed))
        #expect(publishes.count > 3)
        for (session, controls, feedback) in publishes {
            if let outcome = session.outcome {
                #expect(outcome.callSession == session.identity.callSession)
            }
            #expect(feedback.session == session.identity.callSession)
            if session.identity.callSession == 2 {
                #expect(session.confirmation == nil)
                #expect(!controls.rows.contains { $0.isPending })
            }
        }
    }

    @Test func leaveStaysEnabledWhileEndPendingOrFailed() throws {
        let log = CommandLog()
        let shell = presenter(log, joined(isAdmin: true))
        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.more)
        let confirmation = try #require(shell.session.confirmation)
        #expect(shell.confirmEndForEveryone(id: confirmation.id) == .dispatched)
        #expect(row(shell, .endForEveryone).isPending)
        #expect(row(shell, .leave).isEnabled)
        try #require(log.tickets.count > 0)
        #expect(shell.finish(log.tickets[0], MeetingActionResult.failed(.rejectedByServer, serverText: "No")))
        #expect(row(shell, .endForEveryone).failure == .rejectedByServer)
        #expect(row(shell, .leave).isEnabled)
        #expect(shell.leave() == .dispatched)
        #expect(log.commands.last == .leave)
    }

    @Test func terminalTeardownLeavesNoPendingWork() {
        let log = CommandLog()
        let shell = presenter(log, joined(isAdmin: true))
        #expect(shell.toggleHand() == .dispatched)
        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.more)
        shell.panels.present(.participants, from: .call)
        let removed = MeetingTerminalOutcome(id: 3, callSession: 1, kind: .removed, serverText: "You were removed from the meeting")
        shell.apply(joined(isAdmin: true, connectionState: .error, terminalOutcome: removed))
        #expect(shell.ledger.pending.isEmpty)
        #expect(shell.session.confirmation == nil)
        #expect(shell.panels.snapshot.current == nil)
        #expect(shell.session.phase == .outcome)
        #expect(shell.session.outcome == removed)
    }

    @Test func feedbackTokensAdvanceOnlyForAcceptedAsyncOutcomes() throws {
        let log = CommandLog()
        let shell = presenter(log, MeetingShellInputs.make(identity: identity(1), connectionState: .waiting))
        shell.apply(MeetingShellInputs.make(identity: identity(1, 2), connectionState: .joining))
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 1, kind: .admitted))

        shell.apply(joined(attempt: 2))
        #expect(shell.feedbackState.token.sequence == 1)
        shell.apply(joined(attempt: 2, isRecoveringConnection: true, connectionState: .reconnecting))
        shell.apply(joined(attempt: 3))
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 2, kind: .connectionRestored))
        #expect(shell.toggleHand() == .dispatched)
        try #require(log.tickets.count > 0)
        #expect(shell.finish(log.tickets[0], MeetingActionResult.failed(.ackTimedOut)))
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 3, kind: .actionRejected))
        #expect(!shell.finish(log.tickets[0], MeetingActionResult.failed(.ackTimedOut)))
        #expect(shell.feedbackState.token.sequence == 3)
        let removed = MeetingTerminalOutcome(id: 9, callSession: 1, kind: .removed, serverText: "")
        shell.apply(joined(attempt: 3, connectionState: .error, terminalOutcome: removed))
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 4, kind: .removed))
        shell.apply(joined(attempt: 4, connectionState: .error, terminalOutcome: removed))
        #expect(shell.feedbackState.token.sequence == 4)

        shell.apply(MeetingShellInputs.make(identity: identity(2), connectionState: .connecting))
        #expect(shell.feedbackState == MeetingShellFeedbackState(session: 2, token: FeedbackToken.baseline))
        shell.apply(joined(2))
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 1, kind: .joined))
        shell.apply(joined(2, attempt: 2, connectionState: .joining))
        shell.apply(joined(2, attempt: 2))
        #expect(shell.feedbackState.token.sequence == 1)
    }

    @Test func applyNeverDispatchesCommands() {
        let log = CommandLog()
        let shell = presenter(log, joined())
        for inputs in [joined(isAdmin: true), joined(isMuted: false), joined(connectionState: .reconnecting), joined(2), joined(2, connectionState: .error)] {
            shell.apply(inputs)
        }
        #expect(log.commands.isEmpty)
    }

    @Test func presenterOwnersAreIndependent() throws {
        let firstLog = CommandLog()
        let secondLog = CommandLog()
        let first = presenter(firstLog, joined())
        let second = presenter(secondLog, joined())
        #expect(first.toggleHand() == .dispatched)
        #expect(second.toggleHand() == .dispatched)

        try #require(firstLog.tickets.count > 0 && secondLog.tickets.count > 0)
        #expect(firstLog.tickets[0].id == 1 && secondLog.tickets[0].id == 1)
        #expect(first.finish(firstLog.tickets[0], MeetingActionResult.completed))
        #expect(second.ledger.isPending(.hand))
        first.panels.present(.chat, from: .call)
        #expect(second.panels.snapshot.current == nil)
        #expect(first.ledger !== second.ledger)
    }

    @Test func kotlinFixturesCoverEverySwiftScenario() throws {
        let cases: [(id: String, test: String, swift: String, kotlin: String)] = [
            ("S1-STALE-01", "staleCallbacks", "#expect(!shell.finish(ticket, MeetingActionResult.completed))", "assertFalse(shell.finish(ticket, MeetingActionResult.completed))"),
            ("S1-STALE-02", "staleCallbacks", "#expect(!shell.finish(second, MeetingActionResult.completed))", "assertFalse(shell.finish(second, MeetingActionResult.completed))"),
            ("S1-ROOM-01", "roomSwitch", "#expect(published.2 == MeetingShellFeedbackState(session: 2, token: FeedbackToken.baseline))", "assertEquals(MeetingShellFeedbackState(session = 2, token = FeedbackToken.baseline), feedback)"),
            ("S1-ROOM-02", "roomSwitch", "#expect(!shell.finish(log.tickets[0], MeetingActionResult.failed(.ackTimedOut)))", "assertFalse(shell.finish(recorder.tickets[0], MeetingActionResult.failed(MeetingActionFailure.ackTimedOut)))"),
            ("S1-ROOM-03", "roomSwitch", "#expect(!MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin: true, reuseExistingSocket: false, previousConnectionState: .reconnecting))", "assertFalse(MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin = true, reuseExistingSocket = false, previousConnectionState = ConnectionState.reconnecting))"),
            ("S1-ACK-01", "lostAcknowledgment", "#expect(MeetingActionFailurePolicy.classify(PresenterHostError(\"Timed out waiting for the SFU\")) == .ackTimedOut)", "assertEquals(MeetingActionFailure.ackTimedOut, MeetingActionFailurePolicy.classify(message = \"Timed out waiting for the SFU\"))"),
            ("S1-ACK-02", "lostAcknowledgment", "#expect(MeetingActionFailurePolicy.classify(kotlinTimeout) == .ackTimedOut)", "assertEquals(MeetingActionFailure.ackTimedOut, MeetingActionFailurePolicy.classify(kotlinTimeout))"),
            ("S1-ACK-03", "lostAcknowledgment", "shell.apply(joined(isHandRaised: true)) #expect(row(shell, .hand).isOn)", "shell.apply(joined(isHandRaised = true)) assertTrue(row(shell, MeetingControlID.hand).isOn)"),
            ("S1-ACK-04", "lostAcknowledgment", "#expect(!recovery.finish(recoveryLog.tickets[0], MeetingActionResult.completed))", "assertFalse(recovering.finish(recovery.tickets[0], MeetingActionResult.completed))"),
            ("S1-DUP-01", "duplicateAction", "#expect(shell.toggleHand() == .duplicate)", "assertEquals(MeetingDispatch.duplicate, shell.toggleHand())"),
            ("S1-DUP-02", "duplicateAction", "#expect(log.commands.filter { $0 == .endForEveryone }.count == 1)", "assertEquals(1, recorder.commands.count { it == MeetingShellCommand.endForEveryone })"),
            ("S1-DUP-03", "duplicateAction", "#expect(media.commands == [.toggleMicrophone, .toggleCamera])", "assertEquals(listOf(MeetingShellCommand.toggleMicrophone, MeetingShellCommand.toggleCamera), media.commands)"),
            ("S1-ROLE-01", "roleChange", "#expect(row(shell, .endForEveryone).blockedReason == .hostOnly)", "assertEquals(MeetingBlockedReason.hostOnly, row(shell, MeetingControlID.endForEveryone).blockedReason)"),
            ("S1-ROLE-02", "roleChange", "#expect(row(shell, id).blockedReason == .attendee, \"\\(id)\")", "assertEquals(\"$id\", MeetingBlockedReason.attendee, row(shell, id).blockedReason)"),
            ("S1-ROLE-03", "roleChange", "#expect(host.ledger.isPending(.endForEveryone))", "assertTrue(host.ledger.isPending(MeetingActionKind.endForEveryone))"),
            ("S1-ROW-01", "oneRowUpdates", "#expect(after.rows.first { $0.id == \"hand\" }?.isOn == true)", "assertNotSame(before[index], after[index]) assertTrue(after[index].isOn)"),
            ("S1-ROW-02", "oneRowUpdates", "#expect(row(shell, .chat).badgeCount == 3)", "assertEquals(3, chat[index].badgeCount)"),
            ("S1-ROW-03", "oneRowUpdates", "#expect(shell.controls.rows.map { $0.id } == MeetingControlID.allCases.map { $0.rawValue })", "assertEquals(MeetingControlID.values().map { it.rawValue }, ids)"),
            ("S1-ROW-04", "oneRowUpdates", "#expect(shell.controls.revision == revision)", "assertEquals(revision, shell.controls.revision)"),
        ]
        #expect(cases.count == 19 && Set(cases.map { $0.id }).count == 19)
        func fixture(_ source: String, declaration: String) throws -> String {
            let start = try #require(source.range(of: declaration))
            let end = try #require(source.range(of: "\n    @Test", range: start.upperBound..<source.endIndex))
            return source[start.lowerBound..<end.lowerBound].split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        }
    }

    @Test func phaseTableCoversTheS2aRows() {
        func phase(_ inputs: MeetingShellInputs) -> MeetingPhaseResolution { MeetingPhasePolicy.resolve(inputs) }
        let session = identity(1)
        let disconnected = MeetingTerminalOutcome(id: 4, callSession: 1, kind: .serverDisconnected, serverText: "")

        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .disconnected, terminalOutcome: disconnected)) == MeetingPhaseResolution(phase: .outcome, notice: .none, noticeText: nil))
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .error, terminalOutcome: disconnected)).phase == .outcome)

        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .joined, audioInterruption: .held)) == MeetingPhaseResolution(phase: .inCall, notice: .onHold, noticeText: nil))
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .joined, isNetworkOffline: true, audioInterruption: .held)).notice == .offline)
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .joined, audioInterruption: .otherAudio)).notice == .none)

        for state in [ConnectionState.connecting, .connected, .joining] {
            #expect(phase(MeetingShellInputs.make(identity: session, connectionState: state, isRedirectContinuation: true)) == MeetingPhaseResolution(phase: .recovering, notice: .reconnecting, noticeText: nil), "\(state)")
        }

        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .reconnecting)).phase == .recovering)
    }

    @Test func admissionAndEntryOriginFollowTheSession() {

        let log = CommandLog()
        let shell = presenter(log, MeetingShellInputs.make(identity: identity(1), connectionState: .connecting))
        #expect(!shell.session.hasBeenAdmittedThisSession)
        #expect(shell.session.entryOrigin == .initial)

        shell.apply(MeetingShellInputs.make(identity: identity(1), connectionState: .reconnecting, isRecoveringConnection: true))
        #expect(shell.session.phase == .recovering)
        #expect(!shell.session.hasBeenAdmittedThisSession)
        #expect(shell.session.entryOrigin == .initial)

        shell.apply(joined(attempt: 2))
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 1, kind: .joined))
        #expect(shell.session.hasBeenAdmittedThisSession)
        #expect(shell.session.entryOrigin == .initial)

        shell.apply(joined(attempt: 2, isRecoveringConnection: true, connectionState: .reconnecting))
        #expect(shell.session.entryOrigin == .recovery)
        #expect(shell.session.hasBeenAdmittedThisSession)
        shell.apply(joined(attempt: 3))
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 2, kind: .connectionRestored))

        shell.apply(MeetingShellInputs.make(identity: identity(2), connectionState: .joining, roomId: "lily-zoro-iris", isRedirectContinuation: true))
        #expect(shell.session.phase == .recovering)
        #expect(shell.session.hasBeenAdmittedThisSession)
        #expect(shell.session.entryOrigin == .recovery)
        shell.apply(joined(2))
        #expect(shell.feedbackState.token.kind != .joined)

        shell.apply(MeetingShellInputs.make(identity: identity(3), connectionState: .connecting))
        #expect(!shell.session.hasBeenAdmittedThisSession)
        #expect(shell.session.entryOrigin == .initial)
    }

    @Test func serverDisconnectedPlaysTheConnectionLostTokenOnce() {
        let log = CommandLog()
        let shell = presenter(log, joined())
        let outcome = MeetingTerminalOutcome(id: 11, callSession: 1, kind: .serverDisconnected, serverText: "")
        shell.apply(joined(connectionState: .disconnected, terminalOutcome: outcome))
        #expect(shell.session.phase == .outcome)
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 1, kind: .connectionLost))
        shell.apply(joined(attempt: 2, connectionState: .disconnected, terminalOutcome: outcome))
        #expect(shell.feedbackState.token.sequence == 1)
        #expect(MeetingFeedbackTokenPolicy.outcomeKind(.serverDisconnected) == .connectionLost)
    }

    @Test func blockedReasonsCoverOfflinePermissionInterruptionAndEnding() {

        let offline = MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isNetworkOffline: true, isAdmin: true)
        let context = MeetingControlRowContext.make(phase: .inCall)
        func availability(_ id: MeetingControlID, _ inputs: MeetingShellInputs, _ rowContext: MeetingControlRowContext = MeetingControlRowContext.make(phase: .inCall)) -> MeetingControlRow {
            MeetingControlAvailabilityPolicy.row(id, inputs: inputs, context: rowContext)
        }
        for id in [MeetingControlID.screenShare, .hand, .reactions, .endForEveryone] {
            #expect(availability(id, offline, context).blockedReason == .offline, "\(id)")
            #expect(!availability(id, offline, context).isEnabled, "\(id)")
        }
        #expect(availability(.microphone, offline).isEnabled)
        #expect(availability(.microphone, offline).hint == .appliesAfterReconnect)
        #expect(availability(.camera, offline).isEnabled)
        #expect(availability(.leave, offline).isEnabled)
        #expect(availability(.chat, offline).isEnabled)

        let both = MeetingShellInputs.make(identity: identity(1), connectionState: .reconnecting, isRecoveringConnection: true, isNetworkOffline: true)
        #expect(availability(.hand, both, MeetingControlRowContext.make(phase: .recovering)).blockedReason == .reconnecting)

        let micDenied = MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isMuted: true, microphonePermission: .denied)
        #expect(availability(.microphone, micDenied).blockedReason == .permissionDenied)
        #expect(!availability(.microphone, micDenied).isEnabled)
        let micDeniedLive = MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isMuted: false, microphonePermission: .denied)
        #expect(availability(.microphone, micDeniedLive).isEnabled)
        let cameraAsk = MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isCameraOff: true, cameraPermission: .undetermined)
        #expect(availability(.camera, cameraAsk).blockedReason == .permissionUndetermined)
        #expect(!availability(.camera, cameraAsk).isEnabled)

        let held = MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isMuted: true, audioInterruption: .held)
        #expect(availability(.microphone, held).blockedReason == .onHold)
        #expect(!availability(.microphone, held).isEnabled)
        #expect(availability(.camera, held).blockedReason == .none)
        let paused = MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isMuted: false, audioInterruption: .otherAudio)
        #expect(availability(.microphone, paused).blockedReason == .audioInterrupted)
        #expect(availability(.microphone, paused).isEnabled, "a tap toward muted still applies")

        let host = MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isAdmin: true)
        let pending = MeetingControlRowContext.make(phase: .inCall, endTicketPending: true)
        #expect(availability(.endForEveryone, host, pending).blockedReason == .ending)
        #expect(availability(.endForEveryone, host, pending).isPending)
        #expect(availability(.leave, host, pending).blockedReason == .none)
        #expect(availability(.leave, host, pending).isEnabled)
        for reason in [MeetingBlockedReason.permissionDenied, .permissionUndetermined, .audioInterrupted, .onHold] {
            #expect(MeetingControlAvailabilityPolicy.blocksOnlyTowardOn(reason))
        }
        #expect(!MeetingControlAvailabilityPolicy.blocksOnlyTowardOn(.offline))
    }

    @Test func heldMicrophoneRefusesAnUnmuteButTakesAMute() {
        let log = CommandLog()
        let shell = presenter(log, MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isMuted: true, audioInterruption: .held))
        #expect(shell.toggleMicrophone() == .unavailable)
        shell.apply(MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isMuted: false, audioInterruption: .held))
        #expect(shell.toggleMicrophone() == .dispatched)
        #expect(log.commands == [.toggleMicrophone])
    }

    @Test func handFailuresCarryTheirDirection() throws {

        let log = CommandLog()
        let shell = presenter(log, joined(isHandRaised: true))
        #expect(shell.toggleHand() == .dispatched)
        try #require(log.tickets.count > 0)
        #expect(shell.finish(log.tickets[0], MeetingActionResult.failed(.ackTimedOut)))
        #expect(row(shell, .hand).failure == .ackTimedOut)
        #expect(row(shell, .hand).failureDirection == .lower)

        shell.apply(joined(isHandRaised: false))
        #expect(shell.toggleHand() == .dispatched)
        #expect(row(shell, .hand).failure == .none)
        #expect(row(shell, .hand).failureDirection == .none)
        try #require(log.tickets.count > 1)
        #expect(shell.finish(log.tickets[1], MeetingActionResult.failed(.rejectedByServer, direction: .raise)))
        #expect(row(shell, .hand).failureDirection == .raise)
        #expect(row(shell, .microphone).failureDirection == .none)
    }

    @Test func typedMediaFailuresPublishOnTheRowAndClear() {

        let log = CommandLog()
        let shell = presenter(log, joined(isMuted: true, isCameraOff: true))
        let sequence = shell.feedbackState.token.sequence
        let denied = MeetingErrorClassifier.actionResult(MeetingErrorClassifier.classify(serverMessage: "Microphone permission not granted", context: .media))
        #expect(shell.reportFailure(.microphone, denied))
        #expect(row(shell, .microphone).failure == .permissionDenied)
        #expect(shell.feedbackState.token.sequence == sequence)

        shell.apply(joined(isMuted: false, isCameraOff: true))
        #expect(row(shell, .microphone).failure == .none)

        #expect(shell.reportFailure(.camera, MeetingActionResult.failed(.deviceUnavailable)))
        #expect(row(shell, .camera).failure == .deviceUnavailable)
        #expect(shell.toggleCamera() == .dispatched)
        #expect(row(shell, .camera).failure == .none)

        #expect(!shell.reportFailure(.microphone, MeetingActionResult.completed))
        #expect(!shell.reportFailure(.hand, MeetingActionResult.failed(.unknown)))
        #expect(shell.reportFailure(.screenShare, MeetingActionResult.failed(.permissionDenied)))
        shell.apply(joined(2))
        #expect(row(shell, .screenShare).failure == .none)
    }

    @Test func confirmationInvokerIsTheAskingSurface() {

        let log = CommandLog()
        let shell = presenter(log, joined(isAdmin: true))
        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.hostControls)
        #expect(shell.session.confirmation?.invoker == "hostControls")
        #expect(MeetingConfirmationInvoker.call == "call")
        #expect(MeetingConfirmationInvoker.more == "more")
    }
}

#if os(macOS)

@MainActor
@Suite(.serialized)
struct PresenterSessionViewModelTests {
    private func makeJoinedViewModel(room: String = "room-a") -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.roomId = room
        viewModel.state.connectionState = ConnectionState.joined
        return viewModel
    }

    @Test func everyHookedStateFieldRefreshesShellInputs() {
        let viewModel = makeJoinedViewModel()
        func refreshes(_ name: String, _ change: () -> Void) {
            let before = viewModel.shell.currentInputs
            change()
            #expect(viewModel.shell.currentInputs != before, "\(name) did not refresh the shell inputs")
            #expect(viewModel.shell.currentInputs == viewModel.makeShellInputs(), "\(name) left stale inputs")
        }
        let state = viewModel.state
        refreshes("connectionState") { state.connectionState = .reconnecting }
        refreshes("isRecoveringConnection") { state.isRecoveringConnection = true }
        refreshes("isResumingFromBackground") { state.isResumingFromBackground = true }
        refreshes("isNetworkOffline") { state.isNetworkOffline = true }
        refreshes("serverRestartNotice") { state.serverRestartNotice = "Restarting" }
        refreshes("waitingMessage") { state.waitingMessage = "Waiting" }
        refreshes("joinFormErrorMessage") { state.joinFormErrorMessage = "Invalid" }
        refreshes("meetingEndedNoticeMessage") { state.meetingEndedNoticeMessage = "Ended" }
        refreshes("isEnteringMeeting") { state.isEnteringMeeting = true }
        refreshes("meetingEntryAction") { state.meetingEntryAction = .join }
        refreshes("roomId") { state.roomId = "room-b" }
        refreshes("displayName") { state.displayName = "Robin" }
        refreshes("isAdmin") { state.isAdmin = true }
        refreshes("webinarRole") { state.webinarRole = "attendee" }
        refreshes("isMuted") { state.isMuted = false }
        refreshes("isCameraOff") { state.isCameraOff = false }
        refreshes("isAudioOnlyMode") { state.isAudioOnlyMode = true }
        refreshes("isScreenSharing") { state.isScreenSharing = true }
        refreshes("isHandRaised") { state.isHandRaised = true }
        refreshes("unreadChatCount") { state.unreadChatCount = 4 }
        refreshes("isChatOpen") { state.isChatOpen = true }
        refreshes("pendingUsers") { state.pendingUsers = ["guest#1": "Guest"] }
        refreshes("isReactionsDisabled") { state.isReactionsDisabled = true }
        refreshes("terminalOutcome") {
            state.terminalOutcome = MeetingTerminalOutcome(id: 1, callSession: 0, kind: .removed, serverText: "")
        }

        state.isScreenSharing = false
        state.participants = ["remote@example.com#web": Participant(id: "remote@example.com#web", isScreenSharing: true)]
        refreshes("activeScreenShareUserId") { state.activeScreenShareUserId = "remote@example.com#web" }
    }

    @Test func nonHookedHighFrequencyFieldsDoNotRefresh() {
        let viewModel = makeJoinedViewModel()
        var publishes = 0
        viewModel.shell.onPublish = { _, _, _ in publishes += 1 }
        let before = viewModel.shell.currentInputs
        viewModel.state.activeSpeakerId = "remote#1"
        viewModel.state.connectionQuality = .poor
        viewModel.state.errorMessage = "Banner"
        viewModel.state.isTranscriptOpen = true
        #expect(viewModel.shell.currentInputs == before)
        #expect(publishes == 0)
    }

    @Test func replacingStateRebindsTheHookOnce() {
        let viewModel = makeJoinedViewModel()
        let old = viewModel.state
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        #expect(old.onShellInputChanged == nil)
        #expect(viewModel.state.onShellInputChanged != nil)
        old.roomId = "detached"
        #expect(viewModel.shell.currentInputs.roomId == "")
        viewModel.state.roomId = "room-c"
        #expect(viewModel.shell.session.roomLabel == "room-c")
    }

    @Test func kickedEventRecordsRemovedOutcomeAndKeepsLegacyText() async {
        let viewModel = makeJoinedViewModel()
        viewModel.socketManager.onKicked?(KickedNotification(reason: nil, roomId: "room-a"))
        #expect(await presenterSettle { viewModel.shell.session.phase == .outcome })
        #expect(viewModel.shell.session.outcome?.kind == .removed)
        #expect(viewModel.state.errorMessage == "You were removed from the meeting")
        #expect(viewModel.state.connectionState == .error)
    }

    @Test func roomEndedByHostMapsToHomeNotice() async {
        let viewModel = makeJoinedViewModel()
        viewModel.socketManager.onRoomEnded?(RoomEndedNotification(roomId: "room-a", message: nil, endedBy: "host@example.com"))
        #expect(await presenterSettle { viewModel.shell.session.outcome?.kind == .endedByHost })
        #expect(viewModel.shell.session.phase == .home)
        #expect(viewModel.shell.session.notice == .endedByHost)
        #expect(viewModel.state.meetingEndedNoticeMessage == "This meeting has been ended by the host.")
    }

    @Test func roomEndedByLocalUserHasNoNotice() async {
        let viewModel = makeJoinedViewModel()
        viewModel.socketManager.onRoomEnded?(RoomEndedNotification(roomId: "room-a", message: nil, endedBy: "local@example.com"))
        #expect(await presenterSettle { viewModel.shell.session.outcome?.kind == .endedByYou })
        #expect(viewModel.shell.session.phase == .home)
        #expect(viewModel.shell.session.notice == .none)
    }

    @Test func joinRejectedMapsToDenied() async {
        let viewModel = makeJoinedViewModel()
        viewModel.state.connectionState = .waiting
        viewModel.socketManager.onJoinRejected?(JoinDecisionNotification(roomId: "room-a"))
        #expect(await presenterSettle { viewModel.shell.session.outcome?.kind == .denied })
        #expect(viewModel.shell.session.phase == .outcome)
        #expect(viewModel.state.errorMessage == "The host has denied your request to join.")
    }

    @Test func staleOldRoomKickIsIgnoredByShell() async {

        let viewModel = makeJoinedViewModel()
        #expect(viewModel.shell.session.phase == .inCall)
        viewModel.socketManager.onKicked?(KickedNotification(reason: "Bye", roomId: "old-room"))
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(viewModel.shell.session.phase == .inCall)
        #expect(viewModel.shell.session.outcome == nil)
        #expect(viewModel.state.terminalOutcome == nil)
    }

    @Test func handToggleWhileDisconnectedReportsNotConnectedAndClearsPending() {
        let viewModel = makeJoinedViewModel()
        viewModel.state.connectionState = .disconnected
        var results: [MeetingActionResult] = []
        viewModel.toggleHandRaise { results.append($0) }

        #expect(results == [MeetingActionResult.failed(.notConnected, direction: .raise)])
        #expect(viewModel.shell.toggleHand() == .unavailable)
        #expect(!viewModel.shell.ledger.isPending(.hand))
    }

    @Test func handFlagDoesNotStrandAcrossAttemptChange() {

        #expect(MeetingHandToggleTokenPolicy.completionReleasesGuard(completionToken: "a", currentToken: "a"))
        #expect(!MeetingHandToggleTokenPolicy.completionReleasesGuard(completionToken: "a", currentToken: nil))
        #expect(!MeetingHandToggleTokenPolicy.completionReleasesGuard(completionToken: "a", currentToken: "b"))
        #expect(MeetingHandToggleTokenPolicy.ticketResult(applied: true, stillCurrentAttempt: false) == MeetingActionResult.interrupted)
        #expect(MeetingHandToggleTokenPolicy.ticketResult(applied: true, stillCurrentAttempt: true) == MeetingActionResult.completed)
        #expect(MeetingHandToggleTokenPolicy.ticketResult(applied: false, stillCurrentAttempt: true) == MeetingActionResult.cancelled)
    }

    @Test func endWrapperStillReturnsBool() async throws {
        let viewModel = makeJoinedViewModel()
        viewModel.state.connectionState = .disconnected
        let ended: Bool = await viewModel.endMeetingForEveryone()
        #expect(!ended)
        let result = await viewModel.endMeetingForEveryoneResult()
        #expect(result == MeetingActionResult.failed(.notJoined))
    }

    @Test func audioInterruptionAndHoldReachTheMicrophoneRow() {

        let viewModel = makeJoinedViewModel()
        viewModel.state.isMuted = true
        viewModel.reportAudioInterruption(.otherAudio)
        #expect(viewModel.makeShellInputs().audioInterruption == .otherAudio)
        #expect(viewModel.shell.controls.rows.first { $0.id == "microphone" }?.blockedReason == .audioInterrupted)
        viewModel.reportAudioInterruption(.none)
        #expect(viewModel.shell.controls.rows.first { $0.id == "microphone" }?.blockedReason == MeetingBlockedReason.none)

        #expect(viewModel.makeShellInputs().microphonePermission == .granted)
        #expect(viewModel.makeShellInputs().cameraPermission == .granted)
    }

}

@MainActor
private func presenterSettle(timeout: Duration = .seconds(5), _ condition: () -> Bool) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return condition()
}
#endif

private struct PresenterHostError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

private func presenterSessionRow(_ rows: [MeetingControlRow], _ id: MeetingControlID) -> MeetingControlRow {
    if let found = rows.first(where: { $0.id == id.rawValue }) {
        return found
    }
    Issue.record("no \(id.rawValue) control row")
    return MeetingControlRow(id: "missing:" + id.rawValue, isVisible: false, isOn: false, isEnabled: false, isPending: false,
                             blockedReason: MeetingBlockedReason.none, hint: MeetingControlHint.none, badgeCount: 0,
                             failure: MeetingActionFailure.none, failureDirection: MeetingActionDirection.none)
}

private func presenterSessionSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}
#endif
