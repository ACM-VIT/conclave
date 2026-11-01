#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct WP2S2bFeedbackRoomSwitchTests {

    @Test func deliveredKindsAreTheShellKindsAndLeftTheLegacyRoute() {
        #expect(Set(DeliveredTokenKinds.kinds) == [.joined, .admitted, .joinFailed, .denied, .removed, .connectionLost, .connectionRestored, .actionRejected])
        #expect(Set(LegacyHapticRoutes.outcomeKinds) == [.validationFailed])
        #expect(Set(DeliveredTokenKinds.kinds).isDisjoint(with: Set(LegacyHapticRoutes.outcomeKinds)))
        for kind in DeliveredTokenKinds.kinds {
            #expect(kind.isAsyncOutcome)
            #expect(!ConclaveHapticFeedback.accepts(kind, route: .legacyOutcome), "\(kind) plays twice")
        }

        var published: Set<FeedbackKind> = [.actionRejected]
        for kind in MeetingTerminalOutcomeKind.allCases {
            published.insert(MeetingFeedbackTokenPolicy.outcomeKind(kind))
        }
        for from in MeetingPhaseKind.allCases {
            for to in MeetingPhaseKind.allCases {
                for admitted in [false, true] {
                    for joined in [false, true] {
                        published.insert(MeetingFeedbackTokenPolicy.phaseKind(from: from, to: to, admittedThisSession: admitted, joinedThisSession: joined))
                    }
                }
            }
        }
        published.remove(.none)
        #expect(published == Set(DeliveredTokenKinds.kinds))
    }

    @Test func aTokenIsDeliveredOnceAndNeverReplayedOnRemountOrPictureInPicture() throws {
        let shell = MeetingShellPresenter()
        let identity = MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "attempt-1")
        shell.apply(MeetingShellInputs.make(identity: identity, connectionState: .connecting))
        func state() -> FeedbackSourceState {
            FeedbackSourceState(session: shell.feedbackState.session, token: shell.feedbackState.token)
        }
        let cursor = FeedbackDeliveryCursor()
        cursor.attach(session: state().session, current: state().token, eligible: true)
        shell.apply(MeetingShellInputs.make(identity: identity, connectionState: .joined))
        let ticket = cursor.observe(session: state().session, token: state().token, epoch: cursor.epoch, eligible: true)
        #expect(ticket?.kind == .joined)
        let observed = try #require(ticket)
        #expect(cursor.take(observed, session: state().session, eligible: true) == .joined)
        #expect(cursor.observe(session: state().session, token: state().token, epoch: cursor.epoch, eligible: true) == nil)

        let rotated = FeedbackDeliveryCursor()
        rotated.attach(session: state().session, current: state().token, eligible: true)
        #expect(rotated.observe(session: state().session, token: state().token, epoch: rotated.epoch, eligible: true) == nil)

        rotated.setEligibility(session: state().session, current: state().token, eligible: false)
        let removed = MeetingTerminalOutcome(id: 1, callSession: 1, kind: .removed, serverText: "")
        shell.apply(MeetingShellInputs.make(identity: identity, connectionState: .error, terminalOutcome: removed))
        #expect(rotated.observe(session: state().session, token: state().token, epoch: rotated.epoch, eligible: false) == nil)
        rotated.setEligibility(session: state().session, current: state().token, eligible: true)
        #expect(rotated.observe(session: state().session, token: state().token, epoch: rotated.epoch, eligible: true) == nil)
    }

    @Test func recordsCountAndReset() {
        let records = FeedbackDeliveryRecords()
        records.record(.joined)
        records.record(.removed)
        #expect(records.count == 2)
        #expect(records.lastKind == "removed")
        records.reset()
        #expect(records.count == 0)
        #expect(records.lastKind == "none")
        #expect(MeetingSessionReadout.feedbackRecords(count: 3, lastKind: "joined") == "3 last=joined")
    }

    @Test func roomSwitchPolicyMatchesTheS10Table() {
        func decide(
            _ phase: MeetingPhaseKind,
            lobby: MeetingRoomSwitchLobby = .none,
            signingIn: Bool = false,
            sameRoom: Bool = false,
            current: JoinMode = .meeting,
            target: MeetingRoomSwitchTargetKind = .meeting,
            mode: JoinMode = .meeting
        ) -> MeetingRoomSwitchDecision {
            MeetingRoomSwitchPolicy.decide(MeetingRoomSwitchInputs.make(
                phase: phase, lobby: lobby, isSigningIn: signingIn, isSameRoom: sameRoom,
                currentJoinMode: current, targetKind: target, targetJoinMode: mode
            ))
        }

        #expect(decide(.home) == .openLobby)
        #expect(decide(.outcome) == .openLobby)
        #expect(decide(.home, target: .webinar, mode: .webinarAttendee) == .openWebinarLanding)

        #expect(decide(.home, lobby: .editing) == .replaceLobby)
        #expect(decide(.home, lobby: .failed) == .replaceLobby)
        #expect(decide(.home, lobby: .editing, sameRoom: true) == .ignore)

        for phase in [MeetingPhaseKind.entering, .waiting, .inCall, .recovering] {
            #expect(decide(phase) == .prompt, "\(phase)")
            #expect(decide(phase, sameRoom: true) == .ignore, "\(phase)")
            #expect(decide(phase, sameRoom: true, current: .webinarAttendee, mode: .meeting) == .prompt, "\(phase)")
            #expect(decide(phase, sameRoom: true, current: .meeting, target: .webinar, mode: .webinarAttendee) == .prompt, "\(phase)")
        }
        #expect(decide(.home, lobby: .connecting) == .prompt)
        #expect(decide(.home, lobby: .waiting) == .prompt)

        #expect(decide(.inCall, signingIn: true) == .queue)
        #expect(decide(.inCall, target: .invalid) == .invalidLink)
        #expect(decide(.home, signingIn: true, target: .invalid) == .invalidLink)

        #expect(MeetingRoomSwitchPolicy.isSameRoom(currentRoomId: "lily-zoro-iris", aliases: [], targetRoomId: " LILY-ZORO-IRIS "))
        #expect(MeetingRoomSwitchPolicy.isSameRoom(currentRoomId: "lily-zoro-iris", aliases: ["team-standup"], targetRoomId: "Team-Standup"))
        #expect(!MeetingRoomSwitchPolicy.isSameRoom(currentRoomId: "lily-zoro-iris", aliases: [], targetRoomId: "rose-sora-luffy"))
        #expect(!MeetingRoomSwitchPolicy.isSameRoom(currentRoomId: "", aliases: [], targetRoomId: "  "))
    }

    @Test func sessionReadoutValuesAreMachineReadable() throws {
        let shell = MeetingShellPresenter()
        let identity = MeetingSessionIdentity(callSession: 3, attempt: 7, attemptToken: "attempt")
        shell.apply(MeetingShellInputs.make(identity: identity, connectionState: .connecting))
        shell.apply(MeetingShellInputs.make(identity: identity, connectionState: .joined, isAdmin: true, isHandRaised: true))
        #expect(MeetingSessionReadout.identity(shell.session).hasPrefix("cs=3 a=7 r="))
        #expect(MeetingSessionReadout.identity(shell.session).hasSuffix(" active"))
        #expect(MeetingSessionReadout.phase(shell.session) == "inCall/none admitted=1 origin=initial")
        #expect(MeetingSessionReadout.outcome(shell.session) == "none")
        #expect(MeetingSessionReadout.feedback(shell.feedbackState) == "s=3 seq=1 kind=joined")
        #expect(shell.toggleHand() == .dispatched)
        #expect(MeetingSessionReadout.ledger(shell.ledger) == "pending=hand resolved=0 last=none")
        #expect(MeetingSessionReadout.controls(shell.controls).contains("hand=on,enabled,pending"))
        let ticket = try #require(shell.ledger.pending.first)
        #expect(shell.finish(ticket, MeetingActionResult.failed(.ackTimedOut)))
        let controls = MeetingSessionReadout.controls(shell.controls)
        #expect(controls.contains("hand=on,enabled,failed:ackTimedOut:lower"))
        #expect(controls.contains("microphone=off,enabled"))
        #expect(MeetingSessionReadout.ledger(shell.ledger) == "pending=none resolved=1 last=hand:failed")
        let removed = MeetingTerminalOutcome(id: 5, callSession: 3, kind: .removed, serverText: "")
        shell.apply(MeetingShellInputs.make(identity: identity, connectionState: .error, terminalOutcome: removed))
        #expect(MeetingSessionReadout.outcome(shell.session) == "removed#5")
        #expect(MeetingSessionReadout.keys == ["session.identity", "session.phase", "session.outcome", "session.controls",
                                               "session.ledger", "session.feedback", "sys.feedbackRecords"])
        for value in [MeetingSessionReadout.identity(shell.session), MeetingSessionReadout.phase(shell.session),
                      MeetingSessionReadout.controls(shell.controls), MeetingSessionReadout.ledger(shell.ledger),
                      MeetingSessionReadout.feedback(shell.feedbackState)] {
            #expect(value.unicodeScalars.allSatisfy { $0.isASCII }, "\(value)")
        }

        let paused = MeetingControlRow(id: "microphone", isVisible: true, isOn: true, isEnabled: true, isPending: false,
                                       blockedReason: .audioInterrupted, hint: .none, badgeCount: 0, failure: .none, failureDirection: .none)
        #expect(MeetingSessionReadout.rowText(paused) == "microphone=on,enabled:audioInterrupted")
        let hidden = MeetingControlRow(id: "endForEveryone", isVisible: false, isOn: false, isEnabled: false, isPending: false,
                                       blockedReason: .hostOnly, hint: .none, badgeCount: 0, failure: .none, failureDirection: .none)
        #expect(MeetingSessionReadout.rowText(hidden) == "endForEveryone=hidden")
    }
}

#if os(macOS)

@MainActor
@Suite(.serialized)
struct WP2S2bRoomSwitchViewModelTests {
    @Test func roomSwitchInputsReadTheShellPhaseAndTheCurrentJoinMode() {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.roomId = "lily-zoro-iris"
        viewModel.state.connectionState = ConnectionState.joined
        #expect(viewModel.currentJoinMode == .meeting)
        let same = viewModel.makeRoomSwitchInputs(targetRoomId: "LILY-ZORO-IRIS", targetJoinMode: .meeting, targetKind: .meeting)
        #expect(same.phase == .inCall)
        #expect(same.isSameRoom)
        #expect(MeetingRoomSwitchPolicy.decide(same) == .ignore)
        let attendee = viewModel.makeRoomSwitchInputs(targetRoomId: "lily-zoro-iris", targetJoinMode: .webinarAttendee, targetKind: .webinar)
        #expect(MeetingRoomSwitchPolicy.decide(attendee) == .prompt)
        let other = viewModel.makeRoomSwitchInputs(targetRoomId: "rose-sora-luffy", targetJoinMode: .meeting, targetKind: .meeting)
        #expect(MeetingRoomSwitchPolicy.decide(other) == .prompt)
        viewModel.state.connectionState = ConnectionState.disconnected
        let idle = viewModel.makeRoomSwitchInputs(targetRoomId: "rose-sora-luffy", targetJoinMode: .meeting, targetKind: .meeting)
        #expect(MeetingRoomSwitchPolicy.decide(idle) == .openLobby)
    }
}
#endif

private func s2bSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}
#endif
