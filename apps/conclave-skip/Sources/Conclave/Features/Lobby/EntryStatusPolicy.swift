import Foundation

// ENT-5 (S10 8, 9, 0.6 L6, L10, R3, 0.8 C6, C18; RECONCILE R46, R48): the pure rules behind the lobby's connecting,
// waiting and failed blocks and the entry transition into the call root. Transpiled Swift: String raw-value enums
// and static functions over scalars (S1C 3.6), so both platforms and both test suites read the same rules.

// MARK: - Entry presentation (S10 0.8 C6)

/// Who presents the way into a call. The legacy route keeps the branded overlay (its entry begin, the 12 s safety
/// task and the reveal timers); the native premeeting root sets `.native`, so the view model never arms them
/// and the lobby's own connecting state and the entry transition take their place (HD request B5-T5 R1).
enum EntryPresentation: String, CaseIterable, Equatable {
    case legacyOverlay, native

    /// Whether the view model may arm the legacy entry overlay and its timers.
    var armsLegacyOverlay: Bool { self == .legacyOverlay }
}

// MARK: - Waiting room (S10 9 f; RECONCILE R46)

enum WaitingKindPolicy {
    /// The waiting body's kind. Offline wins (it mirrors the 8 f offline row), then a server restart notice, then a
    /// reconnect before the first admission, then today's server sentences (Q8: one policy, ready for typed codes;
    /// `SFU/socket/handlers/joinRoom.ts`, `SFU/admin/controlPlane.ts`).
    static func classify(waitingMessage: String, isNetworkOffline: Bool, serverRestartText: String,
                         isReconnecting: Bool) -> WaitingKind {
        if isNetworkOffline {
            return .offline
        }
        if !serverRestartText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .serverRestarting
        }
        if isReconnecting {
            return .reconnecting
        }
        let lowered = waitingMessage.lowercased()
        if lowered.contains("locked") {
            return .locked
        }
        if lowered.contains("no one to let you in") || lowered.contains("no one is here") {
            return .noHost
        }
        if lowered.contains("host is available") || lowered.contains("host is here") {
            return .hostAvailable
        }
        return .standard
    }
}

// MARK: - Initial join failure (S10 8 f)

enum EntryFailurePolicy {
    /// The failed block's class for an initial join failure, from the S70 classifier's category and diagnostic code
    /// (`MeetingErrorCategory` raw value, "" when unknown) and the clean server sentence. Media failures (device, media
    /// permission and the WebRTC transport codes) come first, then the network, then a busy or draining server (shown
    /// only after the one automatic retry failed, C18), then a clean server sentence, else unknown.
    static func issue(category: String, diagnosticCode: String, serverText: String) -> LobbyIssue {
        let kind = MeetingErrorCategory(rawValue: category) ?? MeetingErrorCategory.unknown
        if diagnosticCode.hasPrefix("media.") {
            return .failedMedia
        }
        switch kind {
        case .deviceUnavailable, .deviceInUse, .microphonePermission, .cameraPermission:
            return .failedMedia
        case .offline, .serverUnreachable, .timedOut:
            return .failedNetwork
        case .serverBusy, .serverRestarting:
            return .failedServerBusy
        default:
            break
        }
        let clean = MeetingErrorClassifier.cleanServerText(serverText)
        return clean.isEmpty ? LobbyIssue.failedUnknown : LobbyIssue.failedServerText
    }

    /// Whether an issue belongs to the failed block (the other issues are rows under the card).
    static func isFailure(_ issue: LobbyIssue) -> Bool {
        switch issue {
        case .failedNetwork, .failedMedia, .failedServerBusy, .failedServerText, .failedUnknown:
            return true
        case .none, .offline, .nameMissing, .roomNotFound, .inviteCodeRequired, .inviteCodeInvalid, .signInRequired,
             .appSuspended, .updateRequired:
            return false
        }
    }
}

// MARK: - Slow notice (S10 8 c, 0.5 task table)

enum EntrySlowNoticePolicy {
    /// The one-shot footnote after 8 s in Connecting with no phase change ([Rec], tuned with the WP4 milestones).
    static let delayMillis: Double = 8000

    /// The task runs only while the lobby on top is visible and in `connecting`; any phase change cancels it.
    static func runs(mode: LobbyMode, isLobbyVisible: Bool, alreadyShown: Bool) -> Bool {
        mode == .connecting && isLobbyVisible && !alreadyShown
    }
}

// MARK: - Entry transition (S10 8 c, d, h; 0.6 L10, R3)

/// How the root moves from the premeeting stack to the call root and back.
enum EntryTransitionStyle: String, CaseIterable, Equatable {
    /// The lobby card's frame grows into the stage (a flat shape, never a renderer), then dissolves into it.
    case expand
    /// A 0.2 s opacity swap: the interim legacy call root, Reduce Motion, no recorded card frame, and leaving a call.
    case crossFade
}

enum EntryTransitionPolicy {
    /// iOS: the stage is revealed from 70% of the entry spring's response (S10 8 c).
    static let iosRevealStartFraction = 0.7
    /// Android: the stage fades in after 220 ms (S10 8 d `fadeIn(tween(160, delayMillis = 220))`).
    static let androidRevealDelayMillis = 220
    /// Android: the premeeting stack fades out over 120 ms while the card grows (S10 8 d).
    static let androidPremeetingFadeMillis = 120
    /// The stage reveal (S10 8 c "fades from 0 to 1 over 0.16 s").
    static let revealDurationMillis = 160

    /// The style for a root change. The expansion runs only into a stage surface (the native CallRoot, or the L9
    /// fixture's dark stand-in), only on the way in, only with a recorded card frame and never under Reduce Motion or
    /// the cross-fade preference; the interim legacy root always cross-fades (S10 8 m interim).
    static func style(entersCall: Bool, expandsIntoCall: Bool, hasCardFrame: Bool, prefersCrossFade: Bool) -> EntryTransitionStyle {
        guard entersCall, expandsIntoCall, hasCardFrame, !prefersCrossFade else { return .crossFade }
        return .expand
    }

    /// The iOS reveal delay in seconds (70% of the 0.38 s response).
    static var iosRevealDelaySeconds: Double {
        ConclaveMotionDurations.entryExpandResponseSeconds * iosRevealStartFraction
    }

    /// A recorded card frame is usable only for the lobby route on top and only with a real size.
    static func isUsableCardFrame(recordedRouteId: Int, lobbyRouteId: Int, width: Double, height: Double) -> Bool {
        recordedRouteId != 0 && recordedRouteId == lobbyRouteId && width > 1.0 && height > 1.0
    }
}
