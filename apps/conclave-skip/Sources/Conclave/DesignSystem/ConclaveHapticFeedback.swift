/// The iOS legacy route's generator for a kind (WP1-H1b). Named after the UIKit generator call, so the mapper is
/// host-tested on macOS and in Robolectric while the player stays iOS-only.
enum LegacyIOSHaptic: String, CaseIterable, Equatable {
    case none
    case notificationSuccess, notificationWarning, notificationError
    case selection
    case impactLight, impactMedium, impactHeavy, impactSoft
}

/// WP1-H1b legacy haptic facade (TG 3.4 item 3, 3.5): serves legacy SkipUI and SwiftUI call sites until each surface
/// is replaced (WP2-H2 migrates the view-model sites). `gesture` takes only gesture kinds; `legacyOutcome` takes only
/// `LegacyHapticRoutes.outcomeKinds`. Platform dispatch: Android `ConclaveHaptics.performFromActivity(kind)` (resumed
/// activity with window focus, single-argument `performHapticFeedback`); iOS `ConclaveFeedbackPlayer.shared.play`
/// (haptics preference and an active app). System, remote and automatic events never call this (S70 D7).
@MainActor
enum ConclaveHapticFeedback {
    /// The route policy: gestures never take outcomes, the legacy outcome route takes only its allowed set.
    static func accepts(_ kind: FeedbackKind, route: ConclaveHapticRoute) -> Bool {
        guard kind != .none else { return false }
        switch route {
        case .gesture:
            return !kind.isAsyncOutcome
        case .legacyOutcome:
            return LegacyHapticRoutes.allowsLegacyOutcome(kind) && !DeliveredTokenKinds.delivers(kind)
        }
    }

    /// The tested iOS mapper (OWNER-DEFAULTS Q11): the contract token for the kind, so share and transcription starts
    /// play impact(medium) and stops impact(light) (SensoryFeedback.start and .stop only play on watchOS). Kinds whose
    /// iOS value is alignment, start or stop are not allowed on the legacy route and map to none.
    static func iosLegacyHaptic(_ kind: FeedbackKind) -> LegacyIOSHaptic {
        iosLegacyHaptic(token: FeedbackHapticContract.ios(kind))
    }

    static func iosLegacyHaptic(token: String) -> LegacyIOSHaptic {
        switch token {
        case "success": return .notificationSuccess
        case "warning": return .notificationWarning
        case "error": return .notificationError
        case "selection": return .selection
        case "impact.light": return .impactLight
        case "impact.medium": return .impactMedium
        case "impact.heavy": return .impactHeavy
        case "impact.soft": return .impactSoft
        default: return .none
        }
    }

    /// A legacy control's own gesture.
    static func gesture(_ kind: FeedbackKind) {
        guard accepts(kind, route: .gesture) else { return }
        play(kind)
    }

    /// A legacy outcome (joined, failures). Never for a kind the token route already delivers.
    static func legacyOutcome(_ kind: FeedbackKind) {
        guard accepts(kind, route: .legacyOutcome) else { return }
        play(kind)
    }

    private static func play(_ kind: FeedbackKind) {
        #if SKIP
        ConclaveHaptics.performFromActivity(kind)
        #elseif os(iOS)
        ConclaveFeedbackPlayer.shared.play(kind)
        #endif
    }
}
