/// The two routes the legacy facade serves (TG 3.4 item 3, WP1-H1b). New native UI uses the view-local gesture
/// modifiers and the session-owned outcome tokens instead.
enum ConclaveHapticRoute: String, CaseIterable, Equatable {
    case gesture, legacyOutcome
}

/// Async outcomes the temporary legacy route may play until each surface moves to the token route (TG 3.4, 3.6).
/// Always a subset of the async outcomes, and never overlapping `DeliveredTokenKinds` (the single-path invariant: a
/// kind is delivered by exactly one route at a time).
enum LegacyHapticRoutes {
    /// WP2-S2b moved joined, joinFailed, actionRejected, denied, removed and connectionLost to the token route
    /// (`DeliveredTokenKinds`, same change). `validationFailed` stays until the premeeting presenter publishes it
    /// (ENT-1); the legacy join form failure plays it.
    static let outcomeKinds: [FeedbackKind] = [
        .validationFailed,
    ]

    static func allowsLegacyOutcome(_ kind: FeedbackKind) -> Bool {
        kind.isAsyncOutcome && outcomeKinds.contains(kind)
    }
}

/// The kinds a production consumer actually delivers through the token route (PLAN-next A9). WP2-S2b wired the single
/// root consumer (iOS `ConclaveRootFeedback`, Android `ConclaveRootFeedback()`) to the shell's `feedbackState`, which
/// publishes these eight S1 kinds (S1C TOK). The change that adds a kind here removes the same kind from
/// `LegacyHapticRoutes.outcomeKinds` in the same change; a test fails if the two sets overlap. The root consumer
/// delivers only these kinds, so a published kind that is not listed stays silent instead of playing twice.
enum DeliveredTokenKinds {
    static let kinds: [FeedbackKind] = [
        .joined, .admitted, .joinFailed, .denied, .removed, .connectionLost, .connectionRestored, .actionRejected,
    ]

    static func delivers(_ kind: FeedbackKind) -> Bool {
        kinds.contains(kind)
    }
}
