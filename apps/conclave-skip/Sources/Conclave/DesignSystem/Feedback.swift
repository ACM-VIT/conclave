
enum FeedbackKind: String, CaseIterable, Equatable {
    case none, signInSucceeded, validationFailed, sessionExpired, stillConnecting, meetingOpened
    case cameraOffByHost, handLoweredByHost, actionRejected, routeSwitchFailed
    case shareStoppedBySystem, recapPostingStarted, connectionRestored
    case micOn, micOff, cameraOn, cameraOff
    case handRaised, handLowered, reactionSent, selectionChanged
    case longPress, selfViewSnapped, swipeThresholdCrossed, linkCopied, endForEveryonePrompted
    case joined, admitted, joinFailed, denied, removed, connectionLost, hostMutedYou
    case shareStarted, shareStopped, transcriptionStarted, transcriptionStopped
    case gameCorrect, gameWrong
    case liveNotesFailed, answerLocked, voteCast, tapValid, tapEarly, guessInvalid, wordSolved
    case pieceMoved, moveRejected, gameStarted, bluffSubmitted, revealHeld
    case hostAdmitted, hostAdmittedAll, hostDenied, hostRemoved, hostMadeHost, hostBulkApplied
    case hostPolicyChanged, hostActionFailed, hostInvitedToStage, hostMovedToAudience, questionSent, questionFailed, upvoteChanged, becameHost, lostHost

    var isAsyncOutcome: Bool {
        switch self {
        case .none, .micOn, .micOff, .cameraOn, .cameraOff, .handRaised, .handLowered,
             .reactionSent, .selectionChanged, .longPress, .selfViewSnapped, .swipeThresholdCrossed,
             .linkCopied, .endForEveryonePrompted, .answerLocked, .voteCast, .tapValid,
             .pieceMoved, .bluffSubmitted, .revealHeld, .upvoteChanged:
            return false
        case .signInSucceeded, .validationFailed, .sessionExpired, .stillConnecting, .meetingOpened,
             .cameraOffByHost, .handLoweredByHost, .actionRejected, .routeSwitchFailed,
             .shareStoppedBySystem, .recapPostingStarted, .connectionRestored, .joined, .admitted,
             .joinFailed, .denied, .removed, .connectionLost, .hostMutedYou, .shareStarted,
             .shareStopped, .transcriptionStarted, .transcriptionStopped, .gameCorrect, .gameWrong,
             .liveNotesFailed, .tapEarly, .guessInvalid, .wordSolved, .moveRejected, .gameStarted,
             .hostAdmitted, .hostAdmittedAll, .hostDenied, .hostRemoved, .hostMadeHost,
             .hostBulkApplied, .hostPolicyChanged, .hostActionFailed, .hostInvitedToStage,
             .hostMovedToAudience, .questionSent, .questionFailed, .becameHost, .lostHost:
            return true
        }
    }

}

struct FeedbackToken: Equatable {
    let sequence: Int
    let kind: FeedbackKind

    static let baseline = FeedbackToken(sequence: 0, kind: .none)
}
