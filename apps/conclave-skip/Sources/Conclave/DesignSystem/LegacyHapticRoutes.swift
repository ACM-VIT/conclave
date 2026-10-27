/// The two routes the legacy facade serves (TG 3.4 item 3, WP1-H1b). New native UI uses the view-local gesture
/// modifiers and the session-owned outcome tokens instead.
enum ConclaveHapticRoute: String, CaseIterable, Equatable {
    case gesture, legacyOutcome
}

/// Async outcomes the temporary legacy route may play until each surface moves to the token route (TG 3.4, 3.6).
/// Always a subset of the async outcomes, and never overlapping `DeliveredTokenKinds` (the single-path invariant: a
/// kind is delivered by exactly one route at a time).
enum LegacyHapticRoutes {
    static let outcomeKinds: [FeedbackKind] = [
        .joined, .joinFailed, .validationFailed, .actionRejected, .denied, .removed,
        // TG 3.6 row 17: retry exhaustion and the recovery watchdog end in connectionLost (PLAN-next A6).
        .connectionLost,
    ]

    static func allowsLegacyOutcome(_ kind: FeedbackKind) -> Bool {
        kind.isAsyncOutcome && outcomeKinds.contains(kind)
    }
}

/// The kinds a production consumer actually delivers through the token route (PLAN-next A9). Empty until WP2-S2b
/// wires the root `ConclaveFeedbackConsumer` as the production sink. The foundation-owner-approved change that adds a
/// kind here removes the same kind from `LegacyHapticRoutes.outcomeKinds` in the same change; a test fails if the two
/// sets overlap.
enum DeliveredTokenKinds {
    static let kinds: [FeedbackKind] = []

    static func delivers(_ kind: FeedbackKind) -> Bool {
        kinds.contains(kind)
    }
}
