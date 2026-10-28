#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// WP2-S2b (PLAN-next 7 item 4; OWNER-DEFAULTS Q16; S70 12 production sink, 0.6 Debug readouts; S10 4): the single
/// root feedback consumer as the production sink, the `DeliveredTokenKinds` registry, the pure room-switch policy and
/// the Debug session readout values. The transpiled delivery runs in `T/Skip/FeedbackPanelBridgeTests.kt`; the iOS
/// consumer compiles only for iOS, so its rules are pinned by source scans here.
@MainActor
struct WP2S2bFeedbackRoomSwitchTests {
    // MARK: Delivered kinds (PLAN-next A9)

    @Test func deliveredKindsAreTheShellKindsAndLeftTheLegacyRoute() {
        #expect(Set(DeliveredTokenKinds.kinds) == [.joined, .admitted, .joinFailed, .denied, .removed, .connectionLost, .connectionRestored, .actionRejected])
        #expect(Set(LegacyHapticRoutes.outcomeKinds) == [.validationFailed])
        #expect(Set(DeliveredTokenKinds.kinds).isDisjoint(with: Set(LegacyHapticRoutes.outcomeKinds)))
        for kind in DeliveredTokenKinds.kinds {
            #expect(kind.isAsyncOutcome)
            #expect(!ConclaveHapticFeedback.accepts(kind, route: .legacyOutcome), "\(kind) plays twice")
        }
        // Every kind the shell can publish is delivered (S1C TOK): the phase kinds, the outcome kinds, actionRejected.
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

    // MARK: F1 rules with shell tokens

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
        // Rotation (a new consumer) baselines on the published token: nothing replays.
        let rotated = FeedbackDeliveryCursor()
        rotated.attach(session: state().session, current: state().token, eligible: true)
        #expect(rotated.observe(session: state().session, token: state().token, epoch: rotated.epoch, eligible: true) == nil)
        // PiP or background: ineligible, the token is consumed; returning rebaselines and plays nothing.
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

    @Test func productionSinksFollowTheF1Rules() throws {
        // iOS: one root modifier over the shell stream, production delivery, the final gate before the effect.
        let root = try s2bSource("Sources/Conclave/Core/Session/ConclaveRootFeedback+iOS.swift")
        #expect(root.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(root.contains("deliversKind: { DeliveredTokenKinds.delivers($0) }"))
        #expect(root.contains("records: FeedbackDeliveryRecords.shared"))
        #expect(root.contains("recordOnly: false"))
        #expect(root.contains("content.modifier(ConclaveFeedbackConsumer(delivery: shellDelivery, mount: 1))"))
        #expect(root.contains("FeedbackSourceState(session: shell.feedbackState.session, token: shell.feedbackState.token)"))
        let delivery = try s2bSource("Sources/Conclave/DesignSystem/iOS/ConclaveFeedback+iOS.swift")
        #expect(delivery.contains("guard deliversKind(kind), let feedback = ConclaveFeedback.sensory(kind) else { return nil }"))
        #expect(delivery.contains("guard let kind = cursor.take(delivery, session: source().session, eligible: eligible) else { return nil }"))
        #expect(delivery.contains("private var eligible: Bool { attached && active && !suspended && ConclaveFeedback.isEnabled(in: defaults) }"))
        #expect(delivery.contains(".onChange(of: delivery.sourceState) { _, _ in delivery.observe(mount: mount) }"))
        #expect(delivery.contains("UIApplication.willResignActiveNotification"))
        // The fixture stays record-only and accepts every kind.
        #expect(delivery.contains("recordOnly: true,\n            deliversKind: { _ in true },"))
        #expect(!delivery.contains("DeliveredTokenKinds"), "the silent adapter probe compiles this file without LegacyHapticRoutes.swift")
        #expect(!delivery.contains("MeetingShellPresenter"))
        // Android: one public root composable, the view's single-argument haptic, resumed only, delivered kinds only.
        let android = try s2bSource("Sources/Conclave/Skip/ui/theme/NativeFeedbackDelivery.kt")
        #expect(android.contains("\n@Composable\nfun ConclaveRootFeedback() {"))
        #expect(android.contains("sink = { ConclaveHaptics.perform(view, it) },"))
        #expect(android.contains("deliversKind = { DeliveredTokenKinds.delivers(it) },"))
        #expect(android.contains("records = FeedbackDeliveryRecords.shared,"))
        #expect(android.contains("delivery.setActive(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))"))
        #expect(android.contains("if (!deliversKind(kind)) return"))
        for pattern in ["performHapticFeedback(", "FLAG_IGNORE", "Vibrator", "LocalHapticFeedback"] {
            #expect(!android.contains(pattern), "\(pattern)")
        }
        for text in [root, delivery, android] {
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"))
            #expect(!text.lowercased().contains("gradient"))
        }
    }

    @Test func productionRootsAndTheReadoutAreMountedOnce() throws {
        // HD request B2-T1 (root files are another lane this batch): one production consumer per platform, outside
        // the PiP swap and the route switch; the Debug readout inside the hosting preview.
        let app = try s2bSource("Sources/Conclave/ConclaveApp.swift")
        #expect(app.components(separatedBy: ".conclaveRootFeedback(shell: MeetingViewModel.shared.shell)").count - 1 == 1)
        let main = try s2bSource("Android/app/src/main/kotlin/Main.kt")
        #expect(main.components(separatedBy: "ConclaveRootFeedback()").count - 1 == 1)
        let rootCall = try #require(main.range(of: "ConclaveRootFeedback()"))
        let pipBranch = try #require(main.range(of: "if (PipController.showsLegacyPipContent) {"))
        #expect(rootCall.lowerBound < pipBranch.lowerBound, "the consumer must sit outside the PiP swap")
        let iosPreview = try s2bSource("Sources/Conclave/App/PlatformRoot+iOS.swift")
        #expect(iosPreview.contains("SessionReadoutSection(shell: MeetingViewModel.shared.shell, records: FeedbackDeliveryRecords.shared)"))
        let androidPreview = try s2bSource("Sources/Conclave/Skip/ui/AppRoot.kt")
        #expect(androidPreview.contains("SessionReadoutSection(MeetingViewModel.shared.shell, FeedbackDeliveryRecords.shared)"))
    }

    // MARK: Room switch (S10 4 c)

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
        // Idle: Home and the outcome screen open the target (no prompt, no auto-join).
        #expect(decide(.home) == .openLobby)
        #expect(decide(.outcome) == .openLobby)
        #expect(decide(.home, target: .webinar, mode: .webinarAttendee) == .openWebinarLanding)
        // Lobby editing another room: replace, no prompt.
        #expect(decide(.home, lobby: .editing) == .replaceLobby)
        #expect(decide(.home, lobby: .failed) == .replaceLobby)
        #expect(decide(.home, lobby: .editing, sameRoom: true) == .ignore)
        // Busy: a different room, or the same room in the other join mode, prompts.
        for phase in [MeetingPhaseKind.entering, .waiting, .inCall, .recovering] {
            #expect(decide(phase) == .prompt, "\(phase)")
            #expect(decide(phase, sameRoom: true) == .ignore, "\(phase)")
            #expect(decide(phase, sameRoom: true, current: .webinarAttendee, mode: .meeting) == .prompt, "\(phase)")
            #expect(decide(phase, sameRoom: true, current: .meeting, target: .webinar, mode: .webinarAttendee) == .prompt, "\(phase)")
        }
        #expect(decide(.home, lobby: .connecting) == .prompt)
        #expect(decide(.home, lobby: .waiting) == .prompt)
        // Sign-in in progress queues; an unparsable Conclave link is the invalid-link notice.
        #expect(decide(.inCall, signingIn: true) == .queue)
        #expect(decide(.inCall, target: .invalid) == .invalidLink)
        #expect(decide(.home, signingIn: true, target: .invalid) == .invalidLink)
        // The pure same-room rule: ids and aliases, trimmed and case-insensitive.
        #expect(MeetingRoomSwitchPolicy.isSameRoom(currentRoomId: "lily-zoro-iris", aliases: [], targetRoomId: " LILY-ZORO-IRIS "))
        #expect(MeetingRoomSwitchPolicy.isSameRoom(currentRoomId: "lily-zoro-iris", aliases: ["team-standup"], targetRoomId: "Team-Standup"))
        #expect(!MeetingRoomSwitchPolicy.isSameRoom(currentRoomId: "lily-zoro-iris", aliases: [], targetRoomId: "rose-sora-luffy"))
        #expect(!MeetingRoomSwitchPolicy.isSameRoom(currentRoomId: "", aliases: [], targetRoomId: "  "))
    }

    // MARK: Debug session readout values

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
        // A reason that blocks only toward live shows while the row can still turn off.
        let paused = MeetingControlRow(id: "microphone", isVisible: true, isOn: true, isEnabled: true, isPending: false,
                                       blockedReason: .audioInterrupted, hint: .none, badgeCount: 0, failure: .none, failureDirection: .none)
        #expect(MeetingSessionReadout.rowText(paused) == "microphone=on,enabled:audioInterrupted")
        let hidden = MeetingControlRow(id: "endForEveryone", isVisible: false, isOn: false, isEnabled: false, isPending: false,
                                       blockedReason: .hostOnly, hint: .none, badgeCount: 0, failure: .none, failureDirection: .none)
        #expect(MeetingSessionReadout.rowText(hidden) == "endForEveryone=hidden")
    }
}

#if os(macOS)
/// The view model's room-switch inputs (macOS stubs; no network).
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
