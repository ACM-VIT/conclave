

enum ConclaveHapticRoute: String, CaseIterable, Equatable {
    case gesture, legacyOutcome
}

enum LegacyHapticRoutes {

    static let outcomeKinds: [FeedbackKind] = [
        .validationFailed,
    ]

    static func allowsLegacyOutcome(_ kind: FeedbackKind) -> Bool {
        kind.isAsyncOutcome && outcomeKinds.contains(kind)
    }
}

enum DeliveredTokenKinds {
    static let kinds: [FeedbackKind] = [
        .joined, .admitted, .joinFailed, .denied, .removed, .connectionLost, .connectionRestored, .actionRejected,
    ]

    static func delivers(_ kind: FeedbackKind) -> Bool {
        kinds.contains(kind)
    }
}

enum NativePremeetingFeedbackKinds {
    static let kinds: [FeedbackKind] = [.signInSucceeded, .validationFailed, .sessionExpired, .stillConnecting]

    static func delivers(_ kind: FeedbackKind) -> Bool {
        kinds.contains(kind)
    }
}

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
