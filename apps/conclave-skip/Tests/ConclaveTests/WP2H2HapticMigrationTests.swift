#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// WP2-H2 (TG 3.6 rows 14 to 28; PLAN-next A6; S30 0.8 CC19; OWNER-DEFAULTS Q11, Q18): the legacy haptics left the view
/// model. Gesture haptics belong to the control the person touched (the legacy controls play them through
/// `ConclaveHapticFeedback.gesture`, HD request B2-T1); terminal outcomes derive one legacy kind from
/// `MeetingTerminalOutcomeKind`; chat send, chat command and leave play nothing. The mute guards are untouched:
/// `testNativeCallCorrectnessBlockersStayFixed` and `T/LocalToggleGuardRecoveryTests.swift` keep pinning them.
@MainActor
struct WP2H2HapticMigrationTests {
    private func viewModelSource() throws -> String {
        try h2Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
    }

    @Test func noLegacyHapticManagerRemainsInTheViewModel() throws {
        // CC19 pre-flip scan `noLegacyHapticManagerRemains`, scoped to the view model (H2 rows 14 to 28).
        let source = try viewModelSource()
        #expect(!source.contains("HapticManager"))
        #expect(!source.contains("HapticType"))
        #expect(!source.contains("ConclaveHapticFeedback.gesture("), "gesture haptics never fire from the view model")
    }

    @Test func chatSendChatCommandAndLeavePlayNothing() throws {
        // Q11: no send, command or leave haptic (TG 3.6 rows 15, 25, 26, 27).
        let source = try viewModelSource()
        for (start, end) in [
            ("    func leaveRoom() {", "    private func finishTerminalRoomError("),
            ("    func executeChatCommand(_ parsedCommand: ParsedCommand) {", "let commandContext = currentCallActionContext()"),
            ("    private func sendConclaveQuestion(", "let actionContext = currentCallActionContext()"),
        ] {
            let body = try #require(h2Section(source, from: start, to: end), "missing \(start)")
            #expect(!body.contains("Haptic"), "\(start) still plays a haptic")
        }
        let send = try #require(h2Section(source, from: "            executeChatCommand(parsedCommand)\n            return\n        }", to: "let optimisticMessage = appendOptimisticChatMessage("))
        #expect(!send.contains("Haptic"))
    }

    @Test func gestureSitesKeepTheirBodiesButLoseTheHaptic() throws {
        // Rows 19 to 24 and 28: the control plays the gesture; system commands (CallKit, notification, PiP) that
        // reach these entry points stay silent (S70 D7).
        let source = try viewModelSource()
        for (start, end) in [
            ("    private func toggleMuteIntentDuringRecovery() {", "    private func toggleCameraIntentDuringRecovery() {"),
            ("    private func toggleCameraIntentDuringRecovery() {", "    func toggleMute() {"),
            ("    func toggleMute() {", "    func toggleCamera() {"),
            ("    func switchLocalCamera() {", "Task { @MainActor in"),
            ("    func toggleHandRaise(onResult:", "    private func setHandRaisedState("),
        ] {
            let body = try #require(h2Section(source, from: start, to: end), "missing \(start)")
            #expect(!body.contains("Haptic"), "\(start) still plays a haptic")
        }
        // The WP2-S1c mute order survives the removal (the full pins live in testNativeCallCorrectnessBlockersStayFixed).
        let toggleMute = try #require(h2Section(source, from: "    func toggleMute() {", to: "    func toggleCamera() {"))
        let inFlight = try #require(toggleMute.range(of: "if isMuteToggleInFlight {"))
        let muteNow = try #require(toggleMute.range(of: "applyLocalMuteNow(context: currentSocketEventContext())", range: inFlight.upperBound..<toggleMute.endIndex))
        #expect(toggleMute.range(of: "let toggleToken = UUID()", range: muteNow.upperBound..<toggleMute.endIndex) != nil)
    }

    @Test func terminalHapticDerivesFromTheOutcomeKind() throws {
        // A6: `.denied` to denied, `.removed` to removed, `.roomClosed` to none, `.joinFailed` to joinFailed,
        // `.connectionLost` to connectionLost; the person's own leave and the Home notices play nothing.
        let table: [MeetingTerminalOutcomeKind: FeedbackKind] = [
            .left: .none, .endedByYou: .none, .endedByHost: .none, .roomClosed: .none, .removed: .removed,
            .denied: .denied, .joinFailed: .joinFailed, .connectionLost: .connectionLost, .serverDisconnected: .connectionLost,
        ]
        #expect(table.count == MeetingTerminalOutcomeKind.allCases.count)
        for kind in MeetingTerminalOutcomeKind.allCases {
            #expect(MeetingLegacyHapticPolicy.feedbackKind(for: kind) == table[kind], "\(kind)")
        }
        // One derivation point (recordTerminalOutcome) plus the join-form validation; no per-caller parameter.
        let source = try viewModelSource()
        #expect(source.components(separatedBy: "ConclaveHapticFeedback.legacyOutcome(").count - 1 == 2)
        #expect(source.contains("ConclaveHapticFeedback.legacyOutcome(MeetingLegacyHapticPolicy.feedbackKind(for: kind))"))
        #expect(source.contains("ConclaveHapticFeedback.legacyOutcome(.validationFailed)"))
        let record = try #require(h2Section(source, from: "    private func recordTerminalOutcome(", to: "    /// S1C E8:"))
        #expect(record.contains("MeetingLegacyHapticPolicy.feedbackKind(for: kind)"))
        for site in ["    private func finishTerminalRoomError(", "    private func finishJoinFailure("] {
            let body = try #require(h2Section(source, from: site, to: "    }\n\n"), "missing \(site)")
            #expect(!body.contains("Haptic"), "\(site) plays its own haptic")
        }
    }

    @Test func everyOutcomePlaysThroughExactlyOneRoute() {
        // The single-path invariant after WP2-S2b: a derived legacy kind is either refused by the facade because the
        // root consumer delivers it as a token, or still legacy-only.
        for kind in MeetingTerminalOutcomeKind.allCases {
            let feedback = MeetingLegacyHapticPolicy.feedbackKind(for: kind)
            guard feedback != .none else { continue }
            let legacy = ConclaveHapticFeedback.accepts(feedback, route: .legacyOutcome)
            let token = DeliveredTokenKinds.delivers(feedback)
            #expect(legacy != token, "\(kind) maps to \(feedback): legacy \(legacy), token \(token)")
            #expect(token, "\(feedback) is a shell token kind, so the root consumer delivers it")
            #expect(MeetingFeedbackTokenPolicy.outcomeKind(kind) == feedback, "\(kind): the token and the legacy kind agree")
        }
        #expect(ConclaveHapticFeedback.accepts(.validationFailed, route: .legacyOutcome))
        #expect(!DeliveredTokenKinds.delivers(.validationFailed))
    }
}

private func h2Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

/// The text from `start` up to the first `end` after it.
private func h2Section(_ text: String, from start: String, to end: String) -> String? {
    guard let lower = text.range(of: start) else { return nil }
    guard let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else { return nil }
    return String(text[lower.lowerBound..<upper.lowerBound])
}
#endif
