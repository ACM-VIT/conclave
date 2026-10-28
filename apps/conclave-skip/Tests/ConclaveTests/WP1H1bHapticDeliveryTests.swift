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

    @Test func iosPlayerGatesOnPreferenceAndActiveAppAndUsesTheMapper() throws {
        let player = try h1bSource("Sources/Conclave/DesignSystem/iOS/ConclaveFeedbackPlayer+iOS.swift")
        #expect(player.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(player.contains("ConclaveFeedback.isEnabled(in: defaults)"))
        #expect(player.contains("UIApplication.shared.applicationState == .active"))
        #expect(player.contains("ConclaveHapticFeedback.iosLegacyHaptic(kind)"))
        #expect(player.contains("if #available(iOS 17.5, *), let view = attachedView"))
        #expect(player.contains("UIImpactFeedbackGenerator(style: style, view: view)"))
        #expect(!player.contains("SensoryFeedback"))
    }

    @Test func facadeDispatchesOncePerPlatform() throws {
        let facade = try h1bSource("Sources/Conclave/DesignSystem/ConclaveHapticFeedback.swift")
        #expect(facade.contains("#if SKIP\n        ConclaveHaptics.performFromActivity(kind)\n        #elseif os(iOS)\n        ConclaveFeedbackPlayer.shared.play(kind)\n        #endif"))
        #expect(facade.contains("guard accepts(kind, route: .gesture) else { return }"))
        #expect(facade.contains("guard accepts(kind, route: .legacyOutcome) else { return }"))
    }

    @Test func androidActivityRouteRespectsSystemSettings() throws {
        let haptics = try h1bSource("Sources/Conclave/Skip/ui/theme/ConclaveHaptics.kt")
        #expect(haptics.contains("internal var legacyHapticView: () -> View? = {"))
        #expect(haptics.contains("isAtLeast(Lifecycle.State.RESUMED)"))
        #expect(haptics.contains("activity.hasWindowFocus()"))
        #expect(haptics.contains("fun performFromActivity(kind: FeedbackKind) {"))
        #expect(haptics.contains("val view = legacyHapticView() ?: return\n        perform(view, kind)"))
        #expect(haptics.components(separatedBy: "performHapticFeedback(").count - 1 == 1)
        for pattern in ["FLAG_IGNORE", "Vibrator", "LocalHapticFeedback", "isHapticFeedbackEnabled"] {
            #expect(!haptics.contains(pattern), "\(pattern)")
        }
    }
}

private func h1bSource(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}
#endif
