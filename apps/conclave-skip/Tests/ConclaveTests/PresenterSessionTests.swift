#if !SKIP
import Foundation
import Observation
import Testing
@testable import Conclave

/// WP2-S1 (contract-wp2-first-slice 5.1 to 5.3): the meeting shell presenter, its ledger and policies. Every S1
/// scenario id appears in a test name comment as `S1-...`; `T/Skip/PresenterSessionBridgeTests.kt` covers the same
/// ids against the transpiled presenter (all but S1-STALE-03, which needs the view model).
@MainActor
struct PresenterSessionTests {
    // MARK: Helpers

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
        presenter.controls.rows.first { $0.id == id.rawValue }!
    }

    // MARK: Stale callbacks

    @Test func staleCallbacks() {
        // S1-STALE-01: a finish from an earlier attempt is dropped and quiet.
        let log = CommandLog()
        let shell = presenter(log, joined())
        #expect(shell.toggleHand() == .dispatched)
        let ticket = log.tickets[0]
        shell.apply(joined(attempt: 2))
        #expect(shell.ledger.result(of: ticket.id)?.kind == .interrupted)
        let publishes = shell.snapshotPublishCount
        #expect(!shell.finish(ticket, MeetingActionResult.completed))
        #expect(shell.snapshotPublishCount == publishes)

        // S1-STALE-02: a double finish of one ticket is accepted once.
        #expect(shell.toggleHand() == .dispatched)
        let second = log.tickets[1]
        #expect(shell.finish(second, MeetingActionResult.completed))
        #expect(!shell.finish(second, MeetingActionResult.completed))
        #expect(!row(shell, .hand).isPending)
    }

    // MARK: Room switch

    @Test func roomSwitch() {
        // S1-ROOM-01: a new call session cancels pending, resets panels to the new session and sets the feedback
        // baseline in one coherent publish.
        let log = CommandLog()
        let shell = presenter(log, joined(isAdmin: true))
        #expect(shell.toggleHand() == .dispatched)
        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.more)
        shell.panels.present(.chat, from: .call)
        #expect(shell.session.confirmation != nil && shell.panels.snapshot.current != nil)
        var publishes: [(MeetingSessionSnapshot, MeetingControlRowsState, MeetingShellFeedbackState)] = []
        shell.onPublish = { session, controls, feedback in publishes.append((session, controls, feedback)) }
        shell.apply(joined(2, isAdmin: true))
        #expect(publishes.count == 1)
        let published = publishes[0]
        #expect(published.0.identity.callSession == 2)
        #expect(published.0.confirmation == nil)
        #expect(published.2 == MeetingShellFeedbackState(session: 2, token: FeedbackToken.baseline))
        #expect(!published.1.rows.contains { $0.isPending })
        #expect(shell.panels.snapshot.session == 2 && shell.panels.snapshot.current == nil)
        #expect(shell.ledger.result(of: log.tickets[0].id)?.kind == .cancelled)

        // S1-ROOM-02: late callbacks from room A after B starts are dropped.
        #expect(!shell.finish(log.tickets[0], MeetingActionResult.failed(.ackTimedOut)))
        #expect(row(shell, .hand).failure == .none)

        // S1-ROOM-03: admission and recovery do not start a call session.
        #expect(!MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin: true, reuseExistingSocket: false, previousConnectionState: .reconnecting))
        #expect(!MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin: false, reuseExistingSocket: true, previousConnectionState: .waiting))
        #expect(!MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin: false, reuseExistingSocket: true, previousConnectionState: .joining))
        #expect(MeetingCallSessionPolicy.startsNewCallSession(isRecoveryJoin: false, reuseExistingSocket: false, previousConnectionState: .disconnected))
        #expect(shell.toggleHand() == .dispatched)
        shell.apply(joined(2, attempt: 2, isAdmin: true, isRecoveringConnection: false))
        #expect(shell.ledger.result(of: log.tickets[1].id)?.kind == .interrupted)
    }

    // MARK: Lost acknowledgment

    @Test func lostAcknowledgment() {
        // S1-ACK-01: the iOS timeout (the text of the iOS-only SocketError.timeout) classifies as ackTimedOut.
        #expect(MeetingActionFailurePolicy.classify(PresenterHostError("Timed out waiting for the SFU")) == .ackTimedOut)
        // S1-ACK-02: the Kotlin timeout text classifies as ackTimedOut too.
        let kotlinTimeout = NSError(domain: "skip.lib.ErrorException", code: 0, userInfo: [
            NSLocalizedDescriptionKey: "Timed out waiting for setHandRaised acknowledgement"
        ])
        #expect(MeetingActionFailurePolicy.classify(kotlinTimeout) == .ackTimedOut)

        // S1-ACK-03: after a failed ack the server event still drives isOn; there is no optimistic rollback.
        let log = CommandLog()
        let shell = presenter(log, joined())
        #expect(shell.toggleHand() == .dispatched)
        #expect(shell.finish(log.tickets[0], MeetingActionResult.failed(.ackTimedOut)))
        #expect(row(shell, .hand).failure == .ackTimedOut && !row(shell, .hand).isOn)
        shell.apply(joined(isHandRaised: true))
        #expect(row(shell, .hand).isOn)

        // S1-ACK-04: recovery start interrupts the pending hand ticket and the later ack is dropped.
        let recovery = presenter(CommandLog(), joined())
        let recoveryLog = CommandLog()
        recovery.onCommand = { _, ticket in if let ticket { recoveryLog.tickets.append(ticket) } }
        #expect(recovery.toggleHand() == .dispatched)
        recovery.apply(joined(isRecoveringConnection: true, connectionState: .reconnecting))
        #expect(!row(recovery, .hand).isPending)
        #expect(recovery.ledger.result(of: recoveryLog.tickets[0].id)?.kind == .interrupted)
        #expect(!recovery.finish(recoveryLog.tickets[0], MeetingActionResult.completed))
    }

    // MARK: Duplicate action

    @Test func duplicateAction() {
        // S1-DUP-01: a second hand tap while pending dispatches nothing and publishes nothing.
        let log = CommandLog()
        let shell = presenter(log, joined(isAdmin: true))
        #expect(shell.toggleHand() == .dispatched)
        let publishes = shell.snapshotPublishCount
        #expect(shell.toggleHand() == .duplicate)
        #expect(log.commands == [.toggleHand])
        #expect(shell.snapshotPublishCount == publishes)

        // S1-DUP-02: a double confirm dispatches end once.
        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.more)
        let confirmation = shell.session.confirmation!
        #expect(confirmation.invoker == MeetingConfirmationInvoker.more)
        #expect(shell.confirmEndForEveryone(id: confirmation.id) == .dispatched)
        #expect(shell.confirmEndForEveryone(id: confirmation.id) == .duplicate)
        #expect(log.commands.filter { $0 == .endForEveryone }.count == 1)

        // S1-DUP-03 (split by S30 CC21): a mic tap toward muted while an unmute is pending dispatches once; a tap
        // toward live while a mute is pending is a duplicate. The same pair for the camera.
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

    // MARK: Role change

    @Test func roleChange() {
        // S1-ROLE-01: host loss clears the end confirmation and hides host rows.
        let log = CommandLog()
        let shell = presenter(log, joined(isAdmin: true))
        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.call)
        #expect(shell.session.confirmation != nil)
        shell.apply(joined(isAdmin: false))
        #expect(shell.session.confirmation == nil)
        #expect(!row(shell, .endForEveryone).isVisible)
        #expect(row(shell, .endForEveryone).blockedReason == .hostOnly)
        #expect(!shell.session.canEndForEveryone)

        // S1-ROLE-02: an attendee blocks media rows with reason attendee.
        shell.apply(joined(isWebinarAttendee: true))
        for id in [MeetingControlID.microphone, .camera, .screenShare, .hand] {
            #expect(row(shell, id).blockedReason == .attendee, "\(id)")
            #expect(!row(shell, id).isEnabled, "\(id)")
        }
        #expect(shell.toggleMicrophone() == .unavailable)

        // S1-ROLE-03: a pending end survives host loss until its result.
        let ending = CommandLog()
        let host = presenter(ending, joined(isAdmin: true))
        host.requestEndForEveryone(from: MeetingConfirmationInvoker.more)
        #expect(host.confirmEndForEveryone(id: host.session.confirmation!.id) == .dispatched)
        host.apply(joined(isAdmin: false))
        #expect(host.ledger.isPending(.endForEveryone))
        #expect(host.finish(ending.tickets[0], MeetingActionResult.completed))
    }

    // MARK: One-row updates

    @Test func oneRowUpdates() {
        let log = CommandLog()
        let shell = presenter(log, joined())
        // S1-ROW-01: a hand toggle changes only the hand row.
        let before = shell.controls
        shell.apply(joined(isHandRaised: true))
        let after = shell.controls
        #expect(after.revision == before.revision + 1)
        for (old, new) in zip(before.rows, after.rows) where old.id != MeetingControlID.hand.rawValue {
            #expect(old == new, "\(old.id)")
        }
        #expect(after.rows.first { $0.id == "hand" }?.isOn == true)

        // S1-ROW-02: the unread count changes only the chat row.
        shell.apply(joined(isHandRaised: true, unreadChatCount: 3))
        let chat = shell.controls
        #expect(chat.revision == after.revision + 1)
        for (old, new) in zip(after.rows, chat.rows) where old.id != MeetingControlID.chat.rawValue {
            #expect(old == new, "\(old.id)")
        }
        #expect(row(shell, .chat).badgeCount == 3)

        // S1-ROW-03: recovery keeps ids and order and explains blocked rows.
        shell.apply(joined(isHandRaised: true, isRecoveringConnection: true, connectionState: .reconnecting, unreadChatCount: 3))
        #expect(shell.controls.rows.map { $0.id } == MeetingControlID.allCases.map { $0.rawValue })
        #expect(row(shell, .hand).blockedReason == .reconnecting)
        #expect(row(shell, .microphone).isEnabled && row(shell, .microphone).hint == .appliesAfterReconnect)
        #expect(row(shell, .screenShare).blockedReason == .reconnecting)

        // S1-ROW-04: duplicate inputs leave the revision unchanged.
        let revision = shell.controls.revision
        let publishes = shell.snapshotPublishCount
        shell.apply(joined(isHandRaised: true, isRecoveringConnection: true, connectionState: .reconnecting, unreadChatCount: 3))
        #expect(shell.controls.revision == revision)
        #expect(shell.snapshotPublishCount == publishes)
    }

    // MARK: Contract tables

    @Test func ledgerIdsNeverReuseAcrossSessions() {
        let ledger = MeetingActionLedger()
        let first = ledger.begin(.hand, identity: identity(1))!
        #expect(ledger.begin(.hand, identity: identity(1)) == nil)
        ledger.cancelAll()
        let second = ledger.begin(.hand, identity: identity(2))!
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
        // An outcome from an earlier call session never routes the new one.
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
                                    func find(_ id: MeetingControlID) -> MeetingControlRow { rows.first { $0.id == id.rawValue }! }
                                    // The ControlsBarView.swift:199-215 expressions, restated.
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
        // Recovery, then a terminal outcome, then a new call session that still carries the old outcome.
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

    @Test func leaveStaysEnabledWhileEndPendingOrFailed() {
        let log = CommandLog()
        let shell = presenter(log, joined(isAdmin: true))
        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.more)
        #expect(shell.confirmEndForEveryone(id: shell.session.confirmation!.id) == .dispatched)
        #expect(row(shell, .endForEveryone).isPending)
        #expect(row(shell, .leave).isEnabled)
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

    @Test func feedbackTokensAdvanceOnlyForAcceptedAsyncOutcomes() {
        let log = CommandLog()
        let shell = presenter(log, MeetingShellInputs.make(identity: identity(1), connectionState: .waiting))
        shell.apply(MeetingShellInputs.make(identity: identity(1, 2), connectionState: .joining))
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 1, kind: .admitted))
        // Joined after admitted in the same call session is suppressed (OWNER-DEFAULTS Q16).
        shell.apply(joined(attempt: 2))
        #expect(shell.feedbackState.token.sequence == 1)
        shell.apply(joined(attempt: 2, isRecoveringConnection: true, connectionState: .reconnecting))
        shell.apply(joined(attempt: 3))
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 2, kind: .connectionRestored))
        #expect(shell.toggleHand() == .dispatched)
        #expect(shell.finish(log.tickets[0], MeetingActionResult.failed(.ackTimedOut)))
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 3, kind: .actionRejected))
        #expect(!shell.finish(log.tickets[0], MeetingActionResult.failed(.ackTimedOut)))
        #expect(shell.feedbackState.token.sequence == 3)
        let removed = MeetingTerminalOutcome(id: 9, callSession: 1, kind: .removed, serverText: "")
        shell.apply(joined(attempt: 3, connectionState: .error, terminalOutcome: removed))
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 4, kind: .removed))
        shell.apply(joined(attempt: 4, connectionState: .error, terminalOutcome: removed))
        #expect(shell.feedbackState.token.sequence == 4)
        // A new call session: baseline, then joined once.
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

    @Test func presenterOwnersAreIndependent() {
        let firstLog = CommandLog()
        let secondLog = CommandLog()
        let first = presenter(firstLog, joined())
        let second = presenter(secondLog, joined())
        #expect(first.toggleHand() == .dispatched)
        #expect(second.toggleHand() == .dispatched)
        // Each presenter numbers its own tickets and owns its own ledger and panels.
        #expect(firstLog.tickets[0].id == 1 && secondLog.tickets[0].id == 1)
        #expect(first.finish(firstLog.tickets[0], MeetingActionResult.completed))
        #expect(second.ledger.isPending(.hand))
        first.panels.present(.chat, from: .call)
        #expect(second.panels.snapshot.current == nil)
        #expect(first.ledger !== second.ledger)
    }

    @Test func kotlinFixturesCoverEverySwiftScenario() throws {
        let ids = ["S1-STALE-01", "S1-STALE-02", "S1-ROOM-01", "S1-ROOM-02", "S1-ROOM-03", "S1-ACK-01", "S1-ACK-02",
                   "S1-ACK-03", "S1-ACK-04", "S1-DUP-01", "S1-DUP-02", "S1-DUP-03", "S1-ROLE-01", "S1-ROLE-02",
                   "S1-ROLE-03", "S1-ROW-01", "S1-ROW-02", "S1-ROW-03", "S1-ROW-04"]
        #expect(ids.count == 19)
        let kotlin = try presenterSessionSource("Tests/ConclaveTests/Skip/PresenterSessionBridgeTests.kt")
        let swift = try presenterSessionSource("Tests/ConclaveTests/PresenterSessionTests.swift")
        for id in ids {
            #expect(kotlin.contains(id), "Kotlin misses \(id)")
            #expect(swift.contains(id), "Swift misses \(id)")
        }
        #expect(swift.contains("S1-STALE-03"))
        #expect(!kotlin.contains("S1-STALE-03"))
    }

    // MARK: WP2-S2a contract amendments (S10 R6, S30 CC2 and CC3, S50 PH17, S70 R70-6 and R70-11)

    @Test func phaseTableCoversTheS2aRows() {
        func phase(_ inputs: MeetingShellInputs) -> MeetingPhaseResolution { MeetingPhasePolicy.resolve(inputs) }
        let session = identity(1)
        let disconnected = MeetingTerminalOutcome(id: 4, callSession: 1, kind: .serverDisconnected, serverText: "")
        // R6 d: serverDisconnected is an outcome whether the legacy route went home (disconnected) or errored.
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .disconnected, terminalOutcome: disconnected)) == MeetingPhaseResolution(phase: .outcome, notice: .none, noticeText: nil))
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .error, terminalOutcome: disconnected)).phase == .outcome)
        // R70-6: a CallKit hold is a notice in call; offline and a restart notice outrank it.
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .joined, audioInterruption: .held)) == MeetingPhaseResolution(phase: .inCall, notice: .onHold, noticeText: nil))
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .joined, isNetworkOffline: true, audioInterruption: .held)).notice == .offline)
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .joined, audioInterruption: .otherAudio)).notice == .none)
        // R70-11: a redirect continuation connects as a recovery (the stage stays), never as a fresh entry.
        for state in [ConnectionState.connecting, .connected, .joining] {
            #expect(phase(MeetingShellInputs.make(identity: session, connectionState: state, isRedirectContinuation: true)) == MeetingPhaseResolution(phase: .recovering, notice: .reconnecting, noticeText: nil), "\(state)")
        }
        // R6 a: a reconnect before the first admission stays recovering; the root reads hasBeenAdmittedThisSession.
        #expect(phase(MeetingShellInputs.make(identity: session, connectionState: .reconnecting)).phase == .recovering)
    }

    @Test func admissionAndEntryOriginFollowTheSession() {
        // R6 c: hasBeenAdmittedThisSession and entryOrigin are S1-owned session facts.
        let log = CommandLog()
        let shell = presenter(log, MeetingShellInputs.make(identity: identity(1), connectionState: .connecting))
        #expect(!shell.session.hasBeenAdmittedThisSession)
        #expect(shell.session.entryOrigin == .initial)
        // A drop before the first admission: still not admitted, still the initial entry (the root shows the lobby).
        shell.apply(MeetingShellInputs.make(identity: identity(1), connectionState: .reconnecting, isRecoveringConnection: true))
        #expect(shell.session.phase == .recovering)
        #expect(!shell.session.hasBeenAdmittedThisSession)
        #expect(shell.session.entryOrigin == .initial)
        // The first join after that drop is a join, not a restore (R6 a).
        shell.apply(joined(attempt: 2))
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 1, kind: .joined))
        #expect(shell.session.hasBeenAdmittedThisSession)
        #expect(shell.session.entryOrigin == .initial)
        // A recovery after the call was live makes the entry a recovery and keeps the admission.
        shell.apply(joined(attempt: 2, isRecoveringConnection: true, connectionState: .reconnecting))
        #expect(shell.session.entryOrigin == .recovery)
        #expect(shell.session.hasBeenAdmittedThisSession)
        shell.apply(joined(attempt: 3))
        #expect(shell.feedbackState.token == FeedbackToken(sequence: 2, kind: .connectionRestored))
        // A same-meeting redirect starts a new call session but keeps the admission and plays no second joined.
        shell.apply(MeetingShellInputs.make(identity: identity(2), connectionState: .joining, roomId: "lily-zoro-iris", isRedirectContinuation: true))
        #expect(shell.session.phase == .recovering)
        #expect(shell.session.hasBeenAdmittedThisSession)
        #expect(shell.session.entryOrigin == .recovery)
        shell.apply(joined(2))
        #expect(shell.feedbackState.token.kind != .joined)
        // A fresh call session resets both.
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
        // S30 CC2 and the 7 matrix: offline blocks socket mutations like recovery; media intent stays live.
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
        // Recovering wins over offline (S30 7 rule 3: the notice decides).
        let both = MeetingShellInputs.make(identity: identity(1), connectionState: .reconnecting, isRecoveringConnection: true, isNetworkOffline: true)
        #expect(availability(.hand, both, MeetingControlRowContext.make(phase: .recovering)).blockedReason == .reconnecting)

        // Permission: blocked toward live, a tap toward muted or off still applies.
        let micDenied = MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isMuted: true, microphonePermission: .denied)
        #expect(availability(.microphone, micDenied).blockedReason == .permissionDenied)
        #expect(!availability(.microphone, micDenied).isEnabled)
        let micDeniedLive = MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isMuted: false, microphonePermission: .denied)
        #expect(availability(.microphone, micDeniedLive).isEnabled)
        let cameraAsk = MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isCameraOff: true, cameraPermission: .undetermined)
        #expect(availability(.camera, cameraAsk).blockedReason == .permissionUndetermined)
        #expect(!availability(.camera, cameraAsk).isEnabled)

        // R29: interruption and hold, microphone only.
        let held = MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isMuted: true, audioInterruption: .held)
        #expect(availability(.microphone, held).blockedReason == .onHold)
        #expect(!availability(.microphone, held).isEnabled)
        #expect(availability(.camera, held).blockedReason == .none)
        let paused = MeetingShellInputs.make(identity: identity(1), connectionState: .joined, isMuted: false, audioInterruption: .otherAudio)
        #expect(availability(.microphone, paused).blockedReason == .audioInterrupted)
        #expect(availability(.microphone, paused).isEnabled, "a tap toward muted still applies")

        // CC2: End pending is `ending` on the End row only, never on Leave (R09).
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

    @Test func handFailuresCarryTheirDirection() {
        // CC3: a failed lower maps to its own copy.
        let log = CommandLog()
        let shell = presenter(log, joined(isHandRaised: true))
        #expect(shell.toggleHand() == .dispatched)
        #expect(shell.finish(log.tickets[0], MeetingActionResult.failed(.ackTimedOut)))
        #expect(row(shell, .hand).failure == .ackTimedOut)
        #expect(row(shell, .hand).failureDirection == .lower)
        // The next dispatch clears it; a raise that fails reports raise, from the view model's result first.
        shell.apply(joined(isHandRaised: false))
        #expect(shell.toggleHand() == .dispatched)
        #expect(row(shell, .hand).failure == .none)
        #expect(row(shell, .hand).failureDirection == .none)
        #expect(shell.finish(log.tickets[1], MeetingActionResult.failed(.rejectedByServer, direction: .raise)))
        #expect(row(shell, .hand).failureDirection == .raise)
        #expect(row(shell, .microphone).failureDirection == .none)
    }

    @Test func typedMediaFailuresPublishOnTheRowAndClear() {
        // PLAN-next 7 item 4: typed microphone and camera failures, no feedback token (not tickets).
        let log = CommandLog()
        let shell = presenter(log, joined(isMuted: true, isCameraOff: true))
        let sequence = shell.feedbackState.token.sequence
        let denied = MeetingErrorClassifier.actionResult(MeetingErrorClassifier.classify(serverMessage: "Microphone permission not granted", context: .media))
        #expect(shell.reportFailure(.microphone, denied))
        #expect(row(shell, .microphone).failure == .permissionDenied)
        #expect(shell.feedbackState.token.sequence == sequence)
        // A change of the row's state clears it.
        shell.apply(joined(isMuted: false, isCameraOff: true))
        #expect(row(shell, .microphone).failure == .none)
        // The next dispatch clears a camera failure.
        #expect(shell.reportFailure(.camera, MeetingActionResult.failed(.deviceUnavailable)))
        #expect(row(shell, .camera).failure == .deviceUnavailable)
        #expect(shell.toggleCamera() == .dispatched)
        #expect(row(shell, .camera).failure == .none)
        // Non-failures and ticket kinds are ignored; a new call session clears everything.
        #expect(!shell.reportFailure(.microphone, MeetingActionResult.completed))
        #expect(!shell.reportFailure(.hand, MeetingActionResult.failed(.unknown)))
        #expect(shell.reportFailure(.screenShare, MeetingActionResult.failed(.permissionDenied)))
        shell.apply(joined(2))
        #expect(row(shell, .screenShare).failure == .none)
    }

    @Test func confirmationInvokerIsTheAskingSurface() {
        // S50 PH17 (R09): the Host Controls End dialog belongs to Host Controls.
        let log = CommandLog()
        let shell = presenter(log, joined(isAdmin: true))
        shell.requestEndForEveryone(from: MeetingConfirmationInvoker.hostControls)
        #expect(shell.session.confirmation?.invoker == "hostControls")
        #expect(MeetingConfirmationInvoker.call == "call")
        #expect(MeetingConfirmationInvoker.more == "more")
    }
}

#if os(macOS)
/// S1C 5.3 view model wiring tests (macOS host: the socket and media stubs never reach the network here).
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
        // activeScreenShareUserId and participants feed hasActiveRemoteScreenShare.
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
        // S1-STALE-03: an old-room terminal event leaves the phase unchanged.
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
        // S30 CC3: the result says which way the hand was going.
        #expect(results == [MeetingActionResult.failed(.notConnected, direction: .raise)])
        #expect(viewModel.shell.toggleHand() == .unavailable)
        #expect(!viewModel.shell.ledger.isPending(.hand))
    }

    @Test func handFlagDoesNotStrandAcrossAttemptChange() {
        // E9 through the pure token helper (the macOS stubs cannot suspend a real acknowledgement here; the
        // suspended path runs in LocalToggleGuardRecoveryTests).
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
        let source = try presenterSessionSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(source.contains("let result = await endMeetingForEveryoneResult(message: message)\n        return result.kind == .completed"))
    }

    @Test func audioInterruptionAndHoldReachTheMicrophoneRow() {
        // R70-6 and RECONCILE R29 through the view model: CallPresence carries the interruption, the row reads it.
        let viewModel = makeJoinedViewModel()
        viewModel.state.isMuted = true
        viewModel.reportAudioInterruption(.otherAudio)
        #expect(viewModel.makeShellInputs().audioInterruption == .otherAudio)
        #expect(viewModel.shell.controls.rows.first { $0.id == "microphone" }?.blockedReason == .audioInterrupted)
        viewModel.reportAudioInterruption(.none)
        #expect(viewModel.shell.controls.rows.first { $0.id == "microphone" }?.blockedReason == MeetingBlockedReason.none)
        // No permission provider yet: the rows match the legacy bar.
        #expect(viewModel.makeShellInputs().microphonePermission == .granted)
        #expect(viewModel.makeShellInputs().cameraPermission == .granted)
    }

    @Test func redirectContinuationIsAnInputOnlyForALiveCall() throws {
        let source = try presenterSessionSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(source.contains("isRedirectContinuation: redirectContinuationPending && presenceJoinedAtMillis > 0,"))
        #expect(source.contains("audioInterruption: callPresence.snapshot.interruption"))
        // The hold and resume commands refresh the shell so the row and the notice follow CallPresence.
        let start = try #require(source.range(of: "    private func performSystemCallCommand(_ command: SystemCallCommand) {"))
        let end = try #require(source.range(of: "    func reportAudioInterruption(", range: start.upperBound..<source.endIndex))
        let body = String(source[start.upperBound..<end.lowerBound])
        #expect(body.components(separatedBy: "requestShellRefresh()").count - 1 == 2)
    }

    @Test func joinRoomChangesTheIdentityInOneRefreshBatch() throws {
        // A19 source guard: the call-session increment precedes the generation bump; the increment, the bump and
        // the attempt id lie between the batch begin and end; the batch end precedes the first room write.
        let source = try presenterSessionSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        let start = try #require(source.range(of: "    func joinRoom("))
        let end = try #require(source.range(of: "    func rejoinIfPossible() async {", range: start.upperBound..<source.endIndex))
        let joinRoom = String(source[start.lowerBound..<end.lowerBound])
        let markers = ["beginShellRefreshBatch()", "callSessionSerial += 1", "meetingLifecycleGeneration += 1",
                       "activeJoinAttemptId = joinAttemptId\n        releaseLocalToggleGuards()", "endShellRefreshBatch()",
                       "self.state.roomId = roomId"]
        var cursor = joinRoom.startIndex
        var batch: Range<String.Index>? = nil
        for marker in markers {
            let range = try #require(joinRoom.range(of: marker, range: cursor..<joinRoom.endIndex), "missing \(marker) in order")
            if marker == "beginShellRefreshBatch()" { batch = range }
            if marker == "endShellRefreshBatch()", let begin = batch {
                #expect(!joinRoom[begin.upperBound..<range.lowerBound].contains("return"))
            }
            cursor = range.upperBound
        }
    }

    @Test func terminalSitesRecordTypedOutcomesBeforeThePhaseWrite() throws {
        let source = try presenterSessionSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(source.contains("finishTerminalRoomError(\"The host has denied your request to join.\", outcome: .denied)"))
        #expect(source.contains("outcome: .removed)"))
        #expect(source.contains("outcome: .roomClosed)"))
        #expect(source.contains("recordTerminalOutcome(outcome, serverText: message)\n        state.connectionState = ConnectionState.error"))
        // WP2-S2a: the join failure keeps only clean server text (S70 7 c, S10 10 j).
        #expect(source.contains("recordTerminalOutcome(outcome, serverText: classification.serverText)\n        state.connectionState = ConnectionState.error"))
        #expect(source.contains("recordTerminalOutcome(.left, serverText: \"\")"))
        // MUTE (S1C 3.3): the guarded strings stay byte-identical.
        #expect(source.contains("state.isMuted = muted ? true : previousMuted"))
        #expect(!source.contains("state.isMuted = !newState"))
    }
}

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

/// The texts of the iOS `SocketError` cases, which exist only in the iOS build.
private struct PresenterHostError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

private func presenterSessionSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}
#endif
