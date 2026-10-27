#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// WP1-H1b (TG 3.4 item 3, 3.5, 3.8; PLAN-next A9; OWNER-DEFAULTS Q11, Q18): the legacy haptic facade, its route
/// policy, the `DeliveredTokenKinds` registry and the tested iOS mapper. The iOS player and the Android activity
/// route are not compiled by this host, so their rules are pinned by source scans; the transpiled route runs in
/// `T/Skip/SystemBridgeTests.kt` (`legacyActivityRouteUsesSingleArgumentCall`).
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
        #expect(Set(LegacyHapticRoutes.outcomeKinds) == [.joined, .joinFailed, .validationFailed, .actionRejected, .denied, .removed, .connectionLost])
    }

    @Test func deliveredTokenKindsNeverOverlapTheLegacyRoute() {
        // Empty until WP2-S2b wires the production consumer; the patch that adds a kind removes it from the legacy set.
        #expect(DeliveredTokenKinds.kinds.isEmpty)
        let overlap = Set(DeliveredTokenKinds.kinds).intersection(Set(LegacyHapticRoutes.outcomeKinds))
        #expect(overlap.isEmpty, "single-path invariant broken for \(overlap)")
        for kind in DeliveredTokenKinds.kinds {
            #expect(!ConclaveHapticFeedback.accepts(kind, route: .legacyOutcome))
        }
    }

    @Test func iosStartAndStopRemapThroughTheTestedMapper() {
        // OWNER-DEFAULTS Q11: SensoryFeedback.start and .stop only play on watchOS.
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
        // Every kind maps through its contract token; the four Q11 rows never fall back to silence.
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
