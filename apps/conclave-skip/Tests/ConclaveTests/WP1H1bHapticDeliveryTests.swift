#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct WP1H1bHapticDeliveryTests {
    private static let legacyIOSTokens: Set<String> = [
        "none", "success", "warning", "error", "selection", "impact.light", "impact.medium", "impact.heavy", "impact.soft",
    ]

    @Test func legacyRoutesRespectPaths() {
        for kind in FeedbackKind.allCases {
            if kind.isAsyncOutcome {
                #expect(!ConclaveHapticFeedback.accepts(kind, route: .gesture), "\(kind) is an outcome")
            } else {
                #expect(ConclaveHapticFeedback.accepts(kind, route: .gesture) == (kind != .none), "\(kind)")
                #expect(!ConclaveHapticFeedback.accepts(kind, route: .legacyOutcome), "\(kind) is a gesture")
            }
            let legacy = ConclaveHapticFeedback.accepts(kind, route: .legacyOutcome)
            #expect(legacy == LegacyHapticRoutes.outcomeKinds.contains(kind), "\(kind)")
        }
        for kind in LegacyHapticRoutes.outcomeKinds {
            #expect(kind.isAsyncOutcome, "\(kind) must be an async outcome")
            #expect(Self.legacyIOSTokens.contains(FeedbackHapticContract.ios(kind)), "\(kind) has no legacy iOS token")
            #expect(ConclaveHapticFeedback.iosLegacyHaptic(kind) != .none || FeedbackHapticContract.ios(kind) == "none", "\(kind)")
        }

        #expect(Set(LegacyHapticRoutes.outcomeKinds) == [.validationFailed])
    }

    @Test func deliveredTokenKindsNeverOverlapTheLegacyRoute() {

        #expect(Set(DeliveredTokenKinds.kinds) == [.joined, .admitted, .joinFailed, .denied, .removed, .connectionLost, .connectionRestored, .actionRejected])
        let overlap = Set(DeliveredTokenKinds.kinds).intersection(Set(LegacyHapticRoutes.outcomeKinds))
        #expect(overlap.isEmpty, "single-path invariant broken for \(overlap)")
        for kind in DeliveredTokenKinds.kinds {
            #expect(!ConclaveHapticFeedback.accepts(kind, route: .legacyOutcome))
        }
    }

    @Test func iosStartAndStopRemapThroughTheTestedMapper() {

        #expect(ConclaveHapticFeedback.iosLegacyHaptic(.shareStarted) == .impactMedium)
        #expect(ConclaveHapticFeedback.iosLegacyHaptic(.transcriptionStarted) == .impactMedium)
        #expect(ConclaveHapticFeedback.iosLegacyHaptic(.shareStopped) == .impactLight)
        #expect(ConclaveHapticFeedback.iosLegacyHaptic(.transcriptionStopped) == .impactLight)
        #expect(ConclaveHapticFeedback.iosLegacyHaptic(token: "start") == .none)
        #expect(ConclaveHapticFeedback.iosLegacyHaptic(token: "stop") == .none)
        #expect(ConclaveHapticFeedback.iosLegacyHaptic(token: "alignment") == .none)
        let table: [String: LegacyIOSHaptic] = [
            "success": .notificationSuccess, "warning": .notificationWarning, "error": .notificationError,
            "selection": .selection, "impact.light": .impactLight, "impact.medium": .impactMedium,
            "impact.heavy": .impactHeavy, "impact.soft": .impactSoft, "none": .none,
        ]
        for (token, haptic) in table {
            #expect(ConclaveHapticFeedback.iosLegacyHaptic(token: token) == haptic, "\(token)")
        }

        for kind in FeedbackKind.allCases {
            let token = FeedbackHapticContract.ios(kind)
            #expect(ConclaveHapticFeedback.iosLegacyHaptic(kind) == (table[token] ?? .none), "\(kind)")
        }
    }

}

private func h1bSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}
#endif
