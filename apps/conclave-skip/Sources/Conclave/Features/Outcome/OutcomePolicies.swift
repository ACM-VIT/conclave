import Foundation

// ENT-6 (S10 10 f, j, 0.8 C3, C5; RECONCILE R4, R08 via Q16): the pure rules behind the outcome screen and rejoin.
// Transpiled Swift: String raw-value enums and static functions over scalars, so the presenter, both platforms'
// views and both test suites read the same table. No display strings here: each platform maps the variant, the
// actions and the failure class to its own catalog keys (iOS `OutcomeCopy`) or `pm_` names (Android `OutcomeUi`).

// MARK: - The rejoin context (S10 0.8 C3)

/// What a terminal outcome does to the view model's rejoin context.
enum RejoinContextDecision: String, CaseIterable, Equatable {
    /// Keep the call's room, invite codes, client id and media intent for Rejoin and Try Again.
    case capture
    /// The host or the server ended the person's place: nothing to rejoin.
    case clear
    /// Leave an earlier context as it is (an initial join failure, a cancelled join that was never admitted).
    case keep
}

enum RejoinContextPolicy {
    /// S10 0.8 C3: captured for `left`, `connectionLost`, `serverDisconnected` and a `joinFailed` after recovery
    /// started; cleared for `removed`, `denied`, `endedByHost`, `endedByYou` and `roomClosed`. A `left` before the
    /// first admission (Cancel while connecting or waiting) never replaces an earlier call's context: the Rejoin card
    /// belongs to sessions that reached the call (S10 2 j).
    static func decision(kind: MeetingTerminalOutcomeKind, entryOrigin: MeetingEntryOrigin,
                         hasBeenAdmittedThisSession: Bool) -> RejoinContextDecision {
        switch kind {
        case .left:
            return hasBeenAdmittedThisSession ? .capture : .keep
        case .connectionLost, .serverDisconnected:
            return .capture
        case .joinFailed:
            return entryOrigin == .recovery ? .capture : .keep
        case .removed, .denied, .endedByHost, .endedByYou, .roomClosed:
            return .clear
        }
    }

    /// Whether a rejoin target names the same room as a lobby or a Rejoin card (ids compared without case and
    /// surrounding spaces, like the room switch rule).
    static func matches(rejoinRoomId: String, roomId: String) -> Bool {
        let context = rejoinRoomId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let target = roomId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !context.isEmpty && context == target
    }
}

// MARK: - The outcome model (S10 10 f, j)

enum OutcomeModelPolicy {
    /// The legacy removal text the view model records when the host gave no reason (`VM` `onKicked`); it is not a
    /// host-provided reason, so the screen never repeats it.
    static let removedFallbackText = "You were removed from the meeting"

    /// The outcome screen for a variant. Rejoin and Try Again need the view model's rejoin context; without one the
    /// only action is Back to Home (one coral per screen, S10 10 c).
    static func model(id: Int, variant: OutcomeVariant, hasRejoinContext: Bool, serverText: String,
                      failure: LobbyIssue) -> OutcomeModel {
        let primary = primaryAction(variant: variant, hasRejoinContext: hasRejoinContext)
        let secondary = primary == .backHome ? OutcomeAction.none : OutcomeAction.backHome
        return OutcomeModel(id: id, variant: variant, primary: primary, secondary: secondary,
                            serverDetail: serverDetail(variant: variant, serverText: serverText, failure: failure),
                            failure: variant == .rejoinFailed ? failure : LobbyIssue.none)
    }

    static func primaryAction(variant: OutcomeVariant, hasRejoinContext: Bool) -> OutcomeAction {
        switch variant {
        case .removed, .denied:
            return .backHome
        case .connectionLost, .serverDisconnected:
            return hasRejoinContext ? .rejoin : .backHome
        case .rejoinFailed:
            return hasRejoinContext ? .tryAgain : .backHome
        }
    }

    /// The second paragraph: a host-provided removal reason (shown in quotes), or the clean server sentence of a
    /// failed rejoin whose class is `failedServerText`; nothing for the other variants (their copy is fixed).
    static func serverDetail(variant: OutcomeVariant, serverText: String, failure: LobbyIssue) -> String {
        let clean = MeetingErrorClassifier.cleanServerText(serverText)
        switch variant {
        case .removed:
            return clean == removedFallbackText ? "" : clean
        case .rejoinFailed:
            return failure == .failedServerText ? clean : ""
        case .denied, .connectionLost, .serverDisconnected:
            return ""
        }
    }

    /// Whether the action rejoins (Rejoin and Try Again call `rejoinLastMeeting()` and push `lobby(rejoin)`).
    static func rejoins(_ action: OutcomeAction) -> Bool {
        action == .rejoin || action == .tryAgain
    }
}
