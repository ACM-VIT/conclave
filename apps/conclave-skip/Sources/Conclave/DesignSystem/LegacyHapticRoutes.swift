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
    /// (`DeliveredTokenKinds`, same change). The legacy join form keeps validationFailed; native premeeting has a
    /// distinct source/consumer and rejects invalid input before dispatching any core command.
    static let outcomeKinds: [FeedbackKind] = [
        .validationFailed,
    ]

    static func allowsLegacyOutcome(_ kind: FeedbackKind) -> Bool {
        kind.isAsyncOutcome && outcomeKinds.contains(kind)
    }
}

/// The shell's production kinds through the token route (PLAN-next A9). WP2-S2b wired the single
/// root consumer (iOS `ConclaveRootFeedback`, Android `ConclaveRootFeedback()`) to the shell's `feedbackState`, which
/// publishes these eight S1 kinds (S1C TOK). The change that adds a kind here removes the same kind from
/// `LegacyHapticRoutes.outcomeKinds` in the same change; a test fails if the two sets overlap. The root consumer
/// delivers only these kinds. Native premeeting and call publishers have separate source-scoped whitelists below;
/// widening this shell list would change legacy facade behavior too.
enum DeliveredTokenKinds {
    static let kinds: [FeedbackKind] = [
        .joined, .admitted, .joinFailed, .denied, .removed, .connectionLost, .connectionRestored, .actionRejected,
    ]

    static func delivers(_ kind: FeedbackKind) -> Bool {
        kinds.contains(kind)
    }
}

/// The native premeeting root is mutually exclusive with the legacy join form. A rejected native submit publishes
/// here before any core command; the legacy form keeps its separate validationFailed facade call. Do not add these
/// to DeliveredTokenKinds: that would also change the legacy facade and the shell consumer's accepted kinds.
enum NativePremeetingFeedbackKinds {
    static let kinds: [FeedbackKind] = [.signInSucceeded, .validationFailed, .sessionExpired, .stillConnecting]

    static func delivers(_ kind: FeedbackKind) -> Bool {
        kinds.contains(kind)
    }
}

/// S20 0.5's publisher registry, scoped to the native call route. Each publisher has an independent sequence and
/// cursor. QA forwards through People; gameStarted belongs only to Stage. ACT-7/ACT-9 use hostActionFailed for their
/// own app/browser commands, so those later publishers remain separate identities even though the kind is shared.
enum NativeCallFeedbackPublisher: String, CaseIterable, Hashable {
    case stage, controls, people, transcript, games, appHost, browser

    var kinds: [FeedbackKind] {
        switch self {
        case .stage:
            return [.hostMutedYou, .cameraOffByHost, .handLoweredByHost, .becameHost, .lostHost,
                    .shareStarted, .shareStopped, .shareStoppedBySystem, .transcriptionStarted,
                    .transcriptionStopped, .gameStarted]
        case .controls:
            return [.routeSwitchFailed, .recapPostingStarted]
        case .people:
            return [.hostAdmitted, .hostAdmittedAll, .hostDenied, .hostRemoved, .hostMadeHost, .hostBulkApplied,
                    .hostPolicyChanged, .hostActionFailed, .hostInvitedToStage, .hostMovedToAudience,
                    .questionSent, .questionFailed]
        case .transcript:
            return [.liveNotesFailed]
        case .games:
            return [.gameCorrect, .gameWrong, .tapEarly, .guessInvalid, .wordSolved, .moveRejected]
        case .appHost, .browser:
            return [.hostActionFailed]
        }
    }

    func delivers(_ kind: FeedbackKind) -> Bool {
        kind.isAsyncOutcome && kinds.contains(kind)
    }
}

/// A stable production source, read only by its own feedback leaf. Retaining the presenters adds no observers to the
/// call's visual tree. The shell's call-session identity fences a late old-session token before a platform cursor
/// can observe it; a new session exposes a baseline even if that publisher has not produced an outcome yet.
@MainActor
final class NativeCallFeedbackSource {
    let publisher: NativeCallFeedbackPublisher
    private let read: () -> MeetingShellFeedbackState
    private let currentSession: () -> Int

    init(publisher: NativeCallFeedbackPublisher, read: @escaping () -> MeetingShellFeedbackState,
         currentSession: @escaping () -> Int) {
        self.publisher = publisher
        self.read = read
        self.currentSession = currentSession
    }

    var state: FeedbackSourceState {
        let session = currentSession()
        let feedback = read()
        return FeedbackSourceState(session: session,
                                   token: feedback.session == session ? feedback.token : FeedbackToken.baseline)
    }

    /// A call flag alone still uses the legacy root; the native call is hosted by native premeeting. Both flags
    /// are fixed at launch. Fixtures bypass the production root entirely on both platforms.
    static func isEnabled(routes: NativeRouteFlags) -> Bool {
        routes.isEnabled(.premeeting) && routes.isEnabled(.call)
    }

    static func production(shell: MeetingShellPresenter, stage: StagePresenter, controls: CallControlsPresenter,
                           people: PeoplePresenter, activitySession: ActivitySession) -> [NativeCallFeedbackSource] {
        let currentSession: () -> Int = { shell.session.identity.callSession }
        return [
            NativeCallFeedbackSource(publisher: .stage, read: { stage.feedbackState }, currentSession: currentSession),
            NativeCallFeedbackSource(publisher: .controls, read: { controls.feedbackState }, currentSession: currentSession),
            NativeCallFeedbackSource(publisher: .people, read: { people.feedbackState }, currentSession: currentSession),
            NativeCallFeedbackSource(publisher: .transcript, read: { shell.transcript.feedbackState }, currentSession: currentSession),
            NativeCallFeedbackSource(publisher: .games, read: { activitySession.games.feedbackState }, currentSession: currentSession),
            NativeCallFeedbackSource(publisher: .appHost, read: { activitySession.appHost.feedbackState }, currentSession: currentSession),
            NativeCallFeedbackSource(publisher: .browser, read: { activitySession.browser.feedbackState }, currentSession: currentSession),
        ]
    }
}
