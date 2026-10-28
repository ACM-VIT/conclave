

struct FeedbackHapticRow: Equatable {
    let kind: FeedbackKind
    let ios: String
    let android34: String
    let android30: String
    let android28: String
}

enum FeedbackHapticContract {
    static let rows: [FeedbackHapticRow] = [
        FeedbackHapticRow(kind: .none, ios: "none", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .signInSucceeded, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .validationFailed, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .sessionExpired, ios: "warning", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .stillConnecting, ios: "warning", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .meetingOpened, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .cameraOffByHost, ios: "warning", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .handLoweredByHost, ios: "none", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .actionRejected, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .routeSwitchFailed, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .shareStoppedBySystem, ios: "none", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .recapPostingStarted, ios: "none", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .connectionRestored, ios: "none", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .micOn, ios: "impact.light", android34: "TOGGLE_ON", android30: "CONTEXT_CLICK", android28: "CONTEXT_CLICK"),
        FeedbackHapticRow(kind: .micOff, ios: "impact.light", android34: "TOGGLE_OFF", android30: "CONTEXT_CLICK", android28: "CONTEXT_CLICK"),
        FeedbackHapticRow(kind: .cameraOn, ios: "impact.light", android34: "TOGGLE_ON", android30: "CONTEXT_CLICK", android28: "CONTEXT_CLICK"),
        FeedbackHapticRow(kind: .cameraOff, ios: "impact.light", android34: "TOGGLE_OFF", android30: "CONTEXT_CLICK", android28: "CONTEXT_CLICK"),
        FeedbackHapticRow(kind: .handRaised, ios: "impact.medium", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .handLowered, ios: "impact.light", android34: "TOGGLE_OFF", android30: "CONTEXT_CLICK", android28: "CONTEXT_CLICK"),
        FeedbackHapticRow(kind: .reactionSent, ios: "impact.soft", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .selectionChanged, ios: "selection", android34: "SEGMENT_TICK", android30: "CLOCK_TICK", android28: "CLOCK_TICK"),
        FeedbackHapticRow(kind: .longPress, ios: "none", android34: "LONG_PRESS", android30: "LONG_PRESS", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .selfViewSnapped, ios: "alignment", android34: "GESTURE_END", android30: "GESTURE_END", android28: "none"),
        FeedbackHapticRow(kind: .swipeThresholdCrossed, ios: "impact.medium", android34: "GESTURE_THRESHOLD_ACTIVATE", android30: "CONTEXT_CLICK", android28: "CONTEXT_CLICK"),
        FeedbackHapticRow(kind: .linkCopied, ios: "success", android34: "none", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .endForEveryonePrompted, ios: "warning", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .joined, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .admitted, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .joinFailed, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .denied, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .removed, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .connectionLost, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .hostMutedYou, ios: "warning", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .shareStarted, ios: "impact.medium", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .shareStopped, ios: "impact.light", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .transcriptionStarted, ios: "impact.medium", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .transcriptionStopped, ios: "impact.light", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .gameCorrect, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .gameWrong, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .liveNotesFailed, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .answerLocked, ios: "selection", android34: "SEGMENT_TICK", android30: "CLOCK_TICK", android28: "CLOCK_TICK"),
        FeedbackHapticRow(kind: .voteCast, ios: "selection", android34: "SEGMENT_TICK", android30: "CLOCK_TICK", android28: "CLOCK_TICK"),
        FeedbackHapticRow(kind: .tapValid, ios: "impact.heavy", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .tapEarly, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .guessInvalid, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .wordSolved, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .pieceMoved, ios: "impact.light", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .moveRejected, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .gameStarted, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .bluffSubmitted, ios: "selection", android34: "SEGMENT_TICK", android30: "CLOCK_TICK", android28: "CLOCK_TICK"),
        FeedbackHapticRow(kind: .revealHeld, ios: "impact.light", android34: "LONG_PRESS", android30: "LONG_PRESS", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .hostAdmitted, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .hostAdmittedAll, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .hostDenied, ios: "none", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .hostRemoved, ios: "none", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .hostMadeHost, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .hostBulkApplied, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .hostPolicyChanged, ios: "none", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .hostActionFailed, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .hostInvitedToStage, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .hostMovedToAudience, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .questionSent, ios: "success", android34: "CONFIRM", android30: "CONFIRM", android28: "VIRTUAL_KEY"),
        FeedbackHapticRow(kind: .questionFailed, ios: "error", android34: "REJECT", android30: "REJECT", android28: "LONG_PRESS"),
        FeedbackHapticRow(kind: .upvoteChanged, ios: "selection", android34: "SEGMENT_TICK", android30: "CLOCK_TICK", android28: "CLOCK_TICK"),

        FeedbackHapticRow(kind: .becameHost, ios: "success", android34: "none", android30: "none", android28: "none"),
        FeedbackHapticRow(kind: .lostHost, ios: "none", android34: "none", android30: "none", android28: "none"),
    ]

    static let linkCopiedFromAPI33 = "none"

    static let iPhoneSilentTokens: Set<String> = ["none", "start", "stop"]

    static func row(for kind: FeedbackKind) -> FeedbackHapticRow? {
        for row in rows {
            if row.kind == kind { return row }
        }
        return nil
    }

    static func ios(_ kind: FeedbackKind) -> String {
        return row(for: kind)?.ios ?? "none"
    }

    static func android(_ kind: FeedbackKind, api: Int) -> String {
        guard let match = row(for: kind) else { return "none" }
        if api >= 34 { return match.android34 }
        if api >= 33 && kind == .linkCopied { return linkCopiedFromAPI33 }
        if api >= 30 { return match.android30 }
        return match.android28
    }

    static func isSilentOnIPhone(_ kind: FeedbackKind) -> Bool {
        return iPhoneSilentTokens.contains(ios(kind))
    }

    static func isSilentOnAndroid(_ kind: FeedbackKind, api: Int) -> Bool {
        return android(kind, api: api) == "none"
    }
}
