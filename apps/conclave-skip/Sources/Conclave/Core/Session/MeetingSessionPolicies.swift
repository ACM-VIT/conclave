import Foundation

// WP2-S1 pure policies (contract-wp2-first-slice 3.3). Host-tested on macOS and, transpiled, in Robolectric.

/// S1C ID: when a join starts a new call session. Every fresh New or Join and every redirect starts one; a recovery
/// rejoin (`isRejoinInFlight`) and an admission continuation (the socket reused from `.waiting`) keep it.
enum MeetingCallSessionPolicy {
    static func startsNewCallSession(
        isRecoveryJoin: Bool,
        reuseExistingSocket: Bool,
        previousConnectionState: ConnectionState
    ) -> Bool {
        if isRecoveryJoin { return false }
        if reuseExistingSocket && previousConnectionState == .waiting { return false }
        if reuseExistingSocket && previousConnectionState == .joining { return false }
        return true
    }
}

struct MeetingPhaseResolution: Equatable {
    let phase: MeetingPhaseKind
    let notice: MeetingNoticeKind
    let noticeText: String?
}

/// S1C PHASE, the R08 table. Room closed goes to a Home notice, denied and the other losses to the outcome screen
/// (OWNER-DEFAULTS Q16), even though the legacy app shows its error screen for both.
///
/// WP2-S2a (S10 R6): a recovery before the first admission stays `recovering`, and the root shows the lobby for it
/// because `hasBeenAdmittedThisSession` is false (S10 0.4); a server redirect continuation connects as `recovering`
/// so the stage never flashes the lobby; `serverDisconnected` is an outcome; a CallKit hold is the `onHold` notice.
enum MeetingPhasePolicy {
    static func resolve(_ inputs: MeetingShellInputs) -> MeetingPhaseResolution {
        let outcome = inputs.currentOutcome
        let outcomeKind = outcome?.kind
        if inputs.isTearingDown && outcomeKind == .left {
            return MeetingPhaseResolution(phase: .leaving, notice: .none, noticeText: nil)
        }
        switch inputs.connectionState {
        case .joined:
            if inputs.isNetworkOffline {
                return MeetingPhaseResolution(phase: .inCall, notice: .offline, noticeText: nil)
            }
            if let restart = inputs.serverRestartNotice {
                return MeetingPhaseResolution(phase: .inCall, notice: .serverRestarting, noticeText: restart)
            }
            if inputs.audioInterruption == .held {
                return MeetingPhaseResolution(phase: .inCall, notice: .onHold, noticeText: nil)
            }
            return MeetingPhaseResolution(phase: .inCall, notice: .none, noticeText: nil)
        case .reconnecting:
            return recovering(inputs)
        case .connecting, .connected, .joining:
            if inputs.isRecoveringConnection || inputs.isRedirectContinuation {
                return recovering(inputs)
            }
            return MeetingPhaseResolution(phase: .entering, notice: .none, noticeText: nil)
        case .waiting:
            return MeetingPhaseResolution(phase: .waiting, notice: .none, noticeText: inputs.waitingMessage)
        case .error, .disconnected:
            return settled(inputs, outcomeKind: outcomeKind)
        }
    }

    private static func recovering(_ inputs: MeetingShellInputs) -> MeetingPhaseResolution {
        // A background and foreground transition is not an outage (MS isResumingFromBackground).
        let notice: MeetingNoticeKind = inputs.isResumingFromBackground ? .resuming : .reconnecting
        return MeetingPhaseResolution(phase: .recovering, notice: notice, noticeText: nil)
    }

    private static func settled(_ inputs: MeetingShellInputs, outcomeKind: MeetingTerminalOutcomeKind?) -> MeetingPhaseResolution {
        if let kind = outcomeKind {
            switch kind {
            case .roomClosed:
                return MeetingPhaseResolution(phase: .home, notice: .roomClosed, noticeText: inputs.currentOutcome?.serverText)
            case .endedByHost:
                return MeetingPhaseResolution(phase: .home, notice: .endedByHost, noticeText: inputs.meetingEndedNoticeMessage)
            case .removed, .denied, .joinFailed, .connectionLost:
                if inputs.connectionState == .error {
                    return MeetingPhaseResolution(phase: .outcome, notice: .none, noticeText: nil)
                }
            case .serverDisconnected:
                // S10 0.8 C4: the legacy route goes home (disconnected); the native root shows the outcome.
                return MeetingPhaseResolution(phase: .outcome, notice: .none, noticeText: nil)
            case .left, .endedByYou:
                break
            }
        }
        if inputs.connectionState == .disconnected {
            if let notice = inputs.meetingEndedNoticeMessage {
                return MeetingPhaseResolution(phase: .home, notice: .endedByHost, noticeText: notice)
            }
            if let formError = inputs.joinFormErrorMessage {
                return MeetingPhaseResolution(phase: .home, notice: .formError, noticeText: formError)
            }
        }
        return MeetingPhaseResolution(phase: .home, notice: .none, noticeText: nil)
    }
}

/// What the presenter knows beyond the inputs when it builds the rows: ticket pending state and the last accepted
/// failure per row (S1C AVAIL, ROW).
struct MeetingControlRowContext: Equatable {
    let phase: MeetingPhaseKind
    let handTicketPending: Bool
    let leaveTicketPending: Bool
    let endTicketPending: Bool
    let handFailure: MeetingActionFailure
    let leaveFailure: MeetingActionFailure
    let endFailure: MeetingActionFailure
    /// WP2-S2a: typed microphone, camera and screen share failures, and the hand failure's direction (S30 CC3).
    let micFailure: MeetingActionFailure
    let cameraFailure: MeetingActionFailure
    let screenShareFailure: MeetingActionFailure
    let handFailureDirection: MeetingActionDirection

    static func make(
        phase: MeetingPhaseKind = .home,
        handTicketPending: Bool = false,
        leaveTicketPending: Bool = false,
        endTicketPending: Bool = false,
        handFailure: MeetingActionFailure = .none,
        leaveFailure: MeetingActionFailure = .none,
        endFailure: MeetingActionFailure = .none,
        micFailure: MeetingActionFailure = .none,
        cameraFailure: MeetingActionFailure = .none,
        screenShareFailure: MeetingActionFailure = .none,
        handFailureDirection: MeetingActionDirection = .none
    ) -> MeetingControlRowContext {
        MeetingControlRowContext(
            phase: phase,
            handTicketPending: handTicketPending,
            leaveTicketPending: leaveTicketPending,
            endTicketPending: endTicketPending,
            handFailure: handFailure,
            leaveFailure: leaveFailure,
            endFailure: endFailure,
            micFailure: micFailure,
            cameraFailure: cameraFailure,
            screenShareFailure: screenShareFailure,
            handFailureDirection: handFailureDirection
        )
    }
}

/// S1C AVAIL: the rules of `ControlsBarView.swift:199-215` and the view model guards, as one pure table. The legacy
/// bar hides every media and participant control from a webinar attendee; the rows keep their ids and order and say
/// why with the `attendee` reason.
enum MeetingControlAvailabilityPolicy {
    static func rows(_ inputs: MeetingShellInputs, context: MeetingControlRowContext) -> [MeetingControlRow] {
        var rows: [MeetingControlRow] = []
        for id in MeetingControlID.allCases {
            rows.append(row(id, inputs: inputs, context: context))
        }
        return rows
    }

    static func row(_ id: MeetingControlID, inputs: MeetingShellInputs, context: MeetingControlRowContext) -> MeetingControlRow {
        let isJoined = inputs.connectionState == .joined
        let isAttendee = inputs.isWebinarAttendee
        let canChangeMedia = MeetingMediaControlAvailabilityPolicy.canChangeLocalMediaIntent(
            connectionState: inputs.connectionState,
            isRecoveringConnection: inputs.isRecoveringConnection,
            mediaPublishingDisabled: isAttendee
        )
        let isLeaving = context.phase == .leaving
        // S30 CC2 and the 7 matrix: offline blocks socket mutations like recovery; media intent stays live.
        let isOfflineInCall = isJoined && inputs.isNetworkOffline && !inputs.isRecoveringConnection
        let mediaHint: MeetingControlHint = (inputs.isRecoveringConnection || isOfflineInCall) ? .appliesAfterReconnect : .none
        let liveOnlyReason: MeetingBlockedReason = inputs.isRecoveringConnection ? .reconnecting : .notJoined

        switch id {
        case .microphone:
            var reason = MeetingBlockedReason.none
            if isAttendee {
                reason = .attendee
            } else if isLeaving {
                reason = .leaving
            } else if !canChangeMedia {
                reason = .notJoined
            } else if inputs.microphonePermission == .denied {
                reason = .permissionDenied
            } else if inputs.microphonePermission == .undetermined {
                reason = .permissionUndetermined
            } else if inputs.audioInterruption == .held {
                reason = .onHold
            } else if inputs.audioInterruption == .otherAudio {
                reason = .audioInterrupted
            }
            // RECONCILE R29: these block only toward live; a tap toward muted still applies.
            let enabled = reason == .none || (blocksOnlyTowardOn(reason) && !inputs.isMuted)
            return MeetingControlRow(
                id: id.rawValue, isVisible: !isAttendee, isOn: !inputs.isMuted,
                isEnabled: enabled, isPending: inputs.micToggleInFlight,
                blockedReason: reason, hint: reason == .none ? mediaHint : .none, badgeCount: 0,
                failure: context.micFailure, failureDirection: .none
            )
        case .camera:
            var reason = MeetingBlockedReason.none
            if isAttendee {
                reason = .attendee
            } else if isLeaving {
                reason = .leaving
            } else if !canChangeMedia {
                reason = .notJoined
            } else if inputs.isAudioOnlyMode {
                reason = .audioOnly
            } else if inputs.cameraPermission == .denied {
                reason = .permissionDenied
            } else if inputs.cameraPermission == .undetermined {
                reason = .permissionUndetermined
            }
            let enabled = reason == .none || (blocksOnlyTowardOn(reason) && !inputs.isCameraOff)
            return MeetingControlRow(
                id: id.rawValue, isVisible: !isAttendee, isOn: !inputs.isCameraOff,
                isEnabled: enabled, isPending: inputs.cameraToggleInFlight,
                blockedReason: reason, hint: reason == .none ? mediaHint : .none, badgeCount: 0,
                failure: context.cameraFailure, failureDirection: .none
            )
        case .screenShare:
            var reason = MeetingBlockedReason.none
            if !inputs.isScreenShareSupported {
                reason = .unsupported
            } else if isAttendee {
                reason = .attendee
            } else if isLeaving {
                reason = .leaving
            } else if !isJoined {
                reason = liveOnlyReason
            } else if isOfflineInCall {
                reason = .offline
            } else if inputs.hasActiveRemoteScreenShare {
                reason = .remoteShareActive
            } else if inputs.isAudioOnlyMode && !inputs.isScreenSharing {
                reason = .audioOnly
            }
            return MeetingControlRow(
                id: id.rawValue, isVisible: inputs.isScreenShareSupported && !isAttendee, isOn: inputs.isScreenSharing,
                isEnabled: reason == .none, isPending: inputs.screenShareToggleInFlight,
                blockedReason: reason, hint: .none, badgeCount: 0,
                failure: context.screenShareFailure, failureDirection: .none
            )
        case .hand:
            var reason = MeetingBlockedReason.none
            // S20 Q10 (PPL-5): with the attendee hand capability an attendee's hand follows the call like anyone's.
            let attendeeHand = isAttendee && inputs.attendeeCanRaiseHand
            if isAttendee && !attendeeHand {
                reason = .attendee
            } else if isLeaving {
                reason = .leaving
            } else if !isJoined {
                reason = liveOnlyReason
            } else if isOfflineInCall {
                reason = .offline
            }
            return MeetingControlRow(
                id: id.rawValue, isVisible: !isAttendee || attendeeHand, isOn: inputs.isHandRaised,
                isEnabled: reason == .none, isPending: context.handTicketPending || inputs.handToggleInFlight,
                blockedReason: reason, hint: .none, badgeCount: 0,
                failure: context.handFailure, failureDirection: context.handFailure == .none ? .none : context.handFailureDirection
            )
        case .reactions:
            var reason = MeetingBlockedReason.none
            if isAttendee {
                reason = .attendee
            } else if inputs.isReactionsDisabled && !inputs.isAdmin {
                reason = .disabledByHost
            } else if isLeaving {
                reason = .leaving
            } else if !isJoined {
                reason = liveOnlyReason
            } else if isOfflineInCall {
                reason = .offline
            }
            let visible = !isAttendee && (!inputs.isReactionsDisabled || inputs.isAdmin)
            return MeetingControlRow(
                id: id.rawValue, isVisible: visible, isOn: false,
                isEnabled: reason == .none, isPending: false,
                blockedReason: reason, hint: .none, badgeCount: 0, failure: .none, failureDirection: .none
            )
        case .chat:
            let reason: MeetingBlockedReason = isLeaving ? .leaving : .none
            return MeetingControlRow(
                id: id.rawValue, isVisible: true, isOn: inputs.isChatOpen,
                isEnabled: reason == .none, isPending: false,
                blockedReason: reason, hint: .none, badgeCount: max(0, inputs.unreadChatCount),
                failure: .none, failureDirection: .none
            )
        case .participants:
            var reason = MeetingBlockedReason.none
            if isAttendee {
                reason = .attendee
            } else if isLeaving {
                reason = .leaving
            }
            return MeetingControlRow(
                id: id.rawValue, isVisible: !isAttendee, isOn: false,
                isEnabled: reason == .none, isPending: false,
                blockedReason: reason, hint: .none, badgeCount: max(0, inputs.pendingUsersCount),
                failure: .none, failureDirection: .none
            )
        case .leave:
            var reason = MeetingBlockedReason.none
            if isLeaving {
                reason = .leaving
            } else if !isCallPhase(context.phase) {
                reason = .notJoined
            }
            // R09: Leave stays enabled while End for everyone is pending or failed, and offline.
            return MeetingControlRow(
                id: id.rawValue, isVisible: true, isOn: false,
                isEnabled: reason == .none, isPending: context.leaveTicketPending,
                blockedReason: reason, hint: .none, badgeCount: 0,
                failure: context.leaveFailure, failureDirection: .none
            )
        case .endForEveryone:
            var reason = MeetingBlockedReason.none
            if isAttendee {
                reason = .attendee
            } else if !inputs.isAdmin {
                reason = .hostOnly
            } else if isLeaving {
                reason = .leaving
            } else if context.endTicketPending {
                // S30 CC2 (R09): `ending` on the End row only, never on Leave.
                reason = .ending
            } else if inputs.isRecoveringConnection {
                reason = .reconnecting
            } else if !isJoined {
                reason = .notJoined
            } else if isOfflineInCall {
                reason = .offline
            }
            return MeetingControlRow(
                id: id.rawValue, isVisible: inputs.isAdmin && !isAttendee, isOn: false,
                isEnabled: reason == .none, isPending: context.endTicketPending,
                blockedReason: reason, hint: .none, badgeCount: 0,
                failure: context.endFailure, failureDirection: .none
            )
        }
    }

    /// RECONCILE R29 and S30 7: reasons that block only a tap toward live or on (permission, interruption, hold).
    static func blocksOnlyTowardOn(_ reason: MeetingBlockedReason) -> Bool {
        switch reason {
        case .permissionDenied, .permissionUndetermined, .audioInterrupted, .onHold:
            return true
        default:
            return false
        }
    }

    static func canEndForEveryone(_ inputs: MeetingShellInputs) -> Bool {
        inputs.isAdmin
            && !inputs.isWebinarAttendee
            && inputs.connectionState == .joined
            && !inputs.isRecoveringConnection
    }

    static func isCallPhase(_ phase: MeetingPhaseKind) -> Bool {
        switch phase {
        case .entering, .waiting, .inCall, .recovering:
            return true
        case .home, .leaving, .outcome:
            return false
        }
    }
}

/// S1C F6, now fed by the one classifier (WP2-S2a, S70 SY11): iOS throws `SocketError.timeout` ("Timed out waiting
/// for the SFU"); Kotlin throws `ErrorException("Timed out waiting for <event> acknowledgement")` and "Socket changed
/// before <event> acknowledgement"; SkipLib's `localizedDescription` is the description. Call actions (hand, end for
/// everyone) classify in the `hostAction` context; results carry only clean server text.
enum MeetingActionFailurePolicy {
    static func classify(_ error: Error) -> MeetingActionFailure {
        MeetingErrorClassifier.actionFailure(MeetingErrorClassifier.classify(error, context: .hostAction))
    }

    static func classify(message: String) -> MeetingActionFailure {
        MeetingErrorClassifier.actionFailure(MeetingErrorClassifier.classify(serverMessage: message, context: .hostAction))
    }

    static func result(for error: Error, direction: MeetingActionDirection = .none) -> MeetingActionResult {
        MeetingErrorClassifier.actionResult(MeetingErrorClassifier.classify(error, context: .hostAction), direction: direction)
    }
}

/// S1C TOK: which feedback kind an accepted transition publishes. Duplicate and stale completions never reach here.
enum MeetingFeedbackTokenPolicy {
    static func phaseKind(
        from previous: MeetingPhaseKind,
        to next: MeetingPhaseKind,
        admittedThisSession: Bool,
        joinedThisSession: Bool
    ) -> FeedbackKind {
        if previous == .waiting && next == .entering { return .admitted }
        if previous == .entering && next == .inCall {
            if admittedThisSession || joinedThisSession { return .none }
            return .joined
        }
        if previous == .recovering && next == .inCall {
            // S10 R6 a: a recovery before the first admission ends in the first join, not a restore.
            if joinedThisSession { return .connectionRestored }
            if admittedThisSession { return .none }
            return .joined
        }
        return .none
    }

    static func outcomeKind(_ kind: MeetingTerminalOutcomeKind) -> FeedbackKind {
        switch kind {
        case .removed: return .removed
        case .denied: return .denied
        case .joinFailed: return .joinFailed
        // S10 R6 d: a server disconnect plays the connection-lost outcome.
        case .connectionLost, .serverDisconnected: return .connectionLost
        case .left, .endedByYou, .endedByHost, .roomClosed: return .none
        }
    }
}

/// WP2-S1c rule CC21 (S30 0.8): what a microphone or camera tap does while its row is pending. A tap toward muted or
/// off still dispatches (the view model applies it at once through `applyLocalMuteNow` or `applyLocalCameraOffNow`);
/// a tap toward live or on is a duplicate (fail closed).
enum MeetingPendingMediaTapPolicy {
    static func microphoneTap(isPending: Bool, isMuted: Bool) -> MeetingDispatch {
        guard isPending else { return .dispatched }
        return isMuted ? .duplicate : .dispatched
    }

    static func cameraTap(isPending: Bool, isCameraOff: Bool) -> MeetingDispatch {
        guard isPending else { return .dispatched }
        return isCameraOff ? .duplicate : .dispatched
    }
}

/// E9 (intake amendment 3): the F7 fix already made the hand guard token-owned (`handRaiseToggleToken`), so the S1
/// hand ticket binds to that token's release. A completion frees the guard, and reports its ticket, only while it
/// still owns the token; a new join attempt releases every token (`releaseLocalToggleGuards()`).
enum MeetingHandToggleTokenPolicy {
    static func completionReleasesGuard(completionToken: String, currentToken: String?) -> Bool {
        currentToken == completionToken
    }

    static func ticketResult(applied: Bool, stillCurrentAttempt: Bool) -> MeetingActionResult {
        guard stillCurrentAttempt else { return MeetingActionResult.interrupted }
        return applied ? MeetingActionResult.completed : MeetingActionResult.cancelled
    }
}

/// WP2-H2 (PLAN-next A6, TG 3.6 rows 16 and 17): the one legacy haptic of a terminal outcome, derived from the typed
/// kind instead of a second per-caller parameter. `roomClosed` and `endedByHost` are Home notices and `left` and
/// `endedByYou` are the person's own leave (Q11), so they play nothing. The facade then refuses any kind the token route
/// already delivers (`DeliveredTokenKinds`).
enum MeetingLegacyHapticPolicy {
    static func feedbackKind(for outcome: MeetingTerminalOutcomeKind) -> FeedbackKind {
        switch outcome {
        case .denied: return .denied
        case .removed: return .removed
        case .joinFailed: return .joinFailed
        case .connectionLost, .serverDisconnected: return .connectionLost
        case .left, .endedByYou, .endedByHost, .roomClosed: return .none
        }
    }
}
