import Foundation

enum EntryPresentation: String, CaseIterable, Equatable {
    case legacyOverlay, native

    var armsLegacyOverlay: Bool { self == .legacyOverlay }
}

enum WaitingKindPolicy {

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

enum EntryFailurePolicy {

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

enum EntrySlowNoticePolicy {

    static let delayMillis: Double = 8000

    static func runs(mode: LobbyMode, isLobbyVisible: Bool, alreadyShown: Bool) -> Bool {
        mode == .connecting && isLobbyVisible && !alreadyShown
    }
}

enum EntryTransitionStyle: String, CaseIterable, Equatable {

    case expand

    case crossFade
}

enum EntryTransitionPolicy {

    static let iosRevealStartFraction = 0.7

    static let androidRevealDelayMillis = 220

    static let androidPremeetingFadeMillis = 120

    static let revealDurationMillis = 160

    static func style(entersCall: Bool, expandsIntoCall: Bool, hasCardFrame: Bool, prefersCrossFade: Bool) -> EntryTransitionStyle {
        guard entersCall, expandsIntoCall, hasCardFrame, !prefersCrossFade else { return .crossFade }
        return .expand
    }

    static var iosRevealDelaySeconds: Double {
        ConclaveMotionDurations.entryExpandResponseSeconds * iosRevealStartFraction
    }

    static func isUsableCardFrame(recordedRouteId: Int, lobbyRouteId: Int, width: Double, height: Double) -> Bool {
        recordedRouteId != 0 && recordedRouteId == lobbyRouteId && width > 1.0 && height > 1.0
    }
}
