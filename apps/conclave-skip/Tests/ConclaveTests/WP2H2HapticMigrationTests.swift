#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct WP2H2HapticMigrationTests {
    @Test func terminalHapticDerivesFromTheOutcomeKind() throws {
        let table: [MeetingTerminalOutcomeKind: FeedbackKind] = [
            .left: .none, .endedByYou: .none, .endedByHost: .none, .roomClosed: .none, .removed: .removed,
            .denied: .denied, .joinFailed: .joinFailed, .connectionLost: .connectionLost, .serverDisconnected: .connectionLost,
        ]
        #expect(table.count == MeetingTerminalOutcomeKind.allCases.count)
        for kind in MeetingTerminalOutcomeKind.allCases {
            #expect(MeetingLegacyHapticPolicy.feedbackKind(for: kind) == table[kind], "\(kind)")
        }
    }

    @Test func everyOutcomePlaysThroughExactlyOneRoute() {

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
#endif
