

enum LegacyIOSHaptic: String, CaseIterable, Equatable {
    case none
    case notificationSuccess, notificationWarning, notificationError
    case selection
    case impactLight, impactMedium, impactHeavy, impactSoft
}

@MainActor
enum ConclaveHapticFeedback {

    static func accepts(_ kind: FeedbackKind, route: ConclaveHapticRoute) -> Bool {
        guard kind != .none else { return false }
        switch route {
        case .gesture:
            return !kind.isAsyncOutcome
        case .legacyOutcome:
            return LegacyHapticRoutes.allowsLegacyOutcome(kind) && !DeliveredTokenKinds.delivers(kind)
        }
    }

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

    static func gesture(_ kind: FeedbackKind) {
        guard accepts(kind, route: .gesture) else { return }
        play(kind)
    }

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
