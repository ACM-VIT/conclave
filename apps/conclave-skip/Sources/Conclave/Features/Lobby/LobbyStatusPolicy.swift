import Foundation

enum LobbyStatusRowKind: String, CaseIterable, Equatable {
    case issue, microphone, camera, media
}

enum LobbyStatusRowAction: String, CaseIterable, Equatable {
    case none, openSettings, allow
}

enum LobbyStatusLineKind: String, CaseIterable, Equatable {
    case none, nameMissing, offline, updateRequired, signInRequired, roomNotFound, stillConnecting,
         failedNetwork, failedMedia, failedServerBusy, failedServerText, failedUnknown,
         waitingStandard, waitingLocked, waitingNoHost, waitingHostAvailable, waitingReconnecting, waitingOffline,
         waitingServerRestarting
}

enum LobbyPendingKind: String, CaseIterable, Equatable {
    case none, joining, starting, reconnecting, asking
}

struct LobbyStatusRowModel: Equatable {
    let kind: LobbyStatusRowKind
    let issue: LobbyIssue
    let mediaKind: LobbyMediaKind
    let restricted: Bool
    let action: LobbyStatusRowAction
}

enum LobbyStatusPolicy {
    static let maxRows = 2
    static let lineMaxLines = 2

    static var platformOffersAppInfo: Bool {
        #if SKIP
        return true
        #else
        return false
        #endif
    }

    static func rows(status: LobbyStatusSnapshot?, media: LobbyMediaSnapshot?, supportsRationale: Bool,
                     offersAppInfo: Bool) -> [LobbyStatusRowModel] {
        var result: [LobbyStatusRowModel] = []
        if let status, status.mode == .editing, status.issue == .appSuspended {
            result.append(LobbyStatusRowModel(kind: .issue, issue: .appSuspended, mediaKind: .microphone, restricted: false,
                                              action: offersAppInfo ? LobbyStatusRowAction.openSettings : LobbyStatusRowAction.none))
        }
        if let media, let row = mediaRow(media: media, supportsRationale: supportsRationale) {
            result.append(row)
        }
        return result
    }

    static func line(status: LobbyStatusSnapshot, isSignedIn: Bool) -> LobbyStatusLineKind {
        let reason = LobbyPrimaryReason(rawValue: status.primaryReason) ?? LobbyPrimaryReason.none
        let nameMissing = reason == .nameMissingJoin || reason == .nameMissingStart
        switch status.mode {
        case .editing:
            if reason == .updateRequired { return .updateRequired }
            if reason == .offline || status.issue == .offline { return .offline }
            if status.issue == .signInRequired && !isSignedIn { return .signInRequired }
            if nameMissing { return .nameMissing }
            if status.issue == .roomNotFound { return .roomNotFound }
            if status.issue == .failedServerText && !status.issueServerText.isEmpty { return .failedServerText }
            return .none
        case .connecting:
            if status.issue == .offline { return .offline }
            if status.showsSlowNotice { return .stillConnecting }
            return .none
        case .failed:
            if reason == .updateRequired { return .updateRequired }
            if reason == .offline { return .offline }
            if nameMissing { return .nameMissing }
            return failureLine(status)
        case .waiting:
            return waitingLine(status.waitingKind)
        }
    }

    static func primaryEnabled(status: LobbyStatusSnapshot, isSignedIn: Bool) -> Bool {
        switch status.mode {
        case .editing:
            return status.isPrimaryEnabled && !(status.issue == .signInRequired && !isSignedIn)
        case .failed:
            return status.primaryReason.isEmpty && !status.isPrimaryPending
        case .connecting, .waiting:
            return false
        }
    }

    static func pendingKind(status: LobbyStatusSnapshot) -> LobbyPendingKind {
        switch status.mode {
        case .connecting:
            if status.waitingKind == .reconnecting { return .reconnecting }
            return status.intent == .newMeeting ? LobbyPendingKind.starting : LobbyPendingKind.joining
        case .waiting:
            return .asking
        case .editing, .failed:
            return .none
        }
    }

    static func announcesLine(_ kind: LobbyStatusLineKind) -> Bool {
        switch kind {
        case .offline, .stillConnecting, .updateRequired, .signInRequired, .roomNotFound, .failedServerText,
             .waitingStandard, .waitingLocked, .waitingNoHost, .waitingHostAvailable, .waitingReconnecting, .waitingOffline,
             .waitingServerRestarting:
            return true
        case .none, .nameMissing, .failedNetwork, .failedMedia, .failedServerBusy, .failedUnknown:
            return false
        }
    }

    static func lineIdentifier(_ kind: LobbyStatusLineKind) -> String {
        switch kind {
        case .none, .nameMissing, .offline, .updateRequired, .signInRequired, .roomNotFound:
            return "lobby.primary.reason"
        case .stillConnecting:
            return "lobby.slowNotice"
        case .failedNetwork, .failedMedia, .failedServerBusy, .failedServerText, .failedUnknown:
            return "lobby.status"
        case .waitingStandard, .waitingLocked, .waitingNoHost, .waitingHostAvailable, .waitingReconnecting, .waitingOffline,
             .waitingServerRestarting:
            return "lobby.waiting.body"
        }
    }

    static func serverLine(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasSuffix(".") {
            return String(trimmed.dropLast())
        }
        return trimmed
    }

    private static func mediaRow(media: LobbyMediaSnapshot, supportsRationale: Bool) -> LobbyStatusRowModel? {
        let microphone = PermissionPrimingPolicy.model(kind: .microphone, permission: media.micPermission,
                                                       canAskAgain: media.canAskAgainMicrophone,
                                                       supportsRationale: supportsRationale, rationaleDismissed: false)
        let camera = PermissionPrimingPolicy.model(kind: .camera, permission: media.cameraPermission,
                                                   canAskAgain: media.canAskAgainCamera,
                                                   supportsRationale: supportsRationale, rationaleDismissed: false)
        if microphone.priming == camera.priming
            && (microphone.priming == .openSettings || microphone.priming == .restricted) {
            let restricted = microphone.priming == .restricted
            return LobbyStatusRowModel(kind: .media, issue: .none, mediaKind: .microphone, restricted: restricted,
                                       action: restricted ? LobbyStatusRowAction.none : LobbyStatusRowAction.openSettings)
        }
        if rowAction(microphone.priming) != LobbyStatusRowAction.none {
            return LobbyStatusRowModel(kind: .microphone, issue: .none, mediaKind: .microphone, restricted: false,
                                       action: rowAction(microphone.priming))
        }
        if rowAction(camera.priming) != LobbyStatusRowAction.none {
            return LobbyStatusRowModel(kind: .camera, issue: .none, mediaKind: .camera, restricted: false,
                                       action: rowAction(camera.priming))
        }
        if microphone.priming == .restricted {
            return LobbyStatusRowModel(kind: .microphone, issue: .none, mediaKind: .microphone, restricted: true, action: .none)
        }
        if camera.priming == .restricted {
            return LobbyStatusRowModel(kind: .camera, issue: .none, mediaKind: .camera, restricted: true, action: .none)
        }
        return nil
    }

    private static func rowAction(_ priming: PermissionPrimingKind) -> LobbyStatusRowAction {
        switch priming {
        case .rationale:
            return .allow
        case .openSettings:
            return .openSettings
        case .none, .restricted:
            return .none
        }
    }

    private static func failureLine(_ status: LobbyStatusSnapshot) -> LobbyStatusLineKind {
        switch status.issue {
        case .failedNetwork:
            return .failedNetwork
        case .failedMedia:
            return .failedMedia
        case .failedServerBusy:
            return .failedServerBusy
        case .failedServerText:
            return status.issueServerText.isEmpty ? LobbyStatusLineKind.failedUnknown : LobbyStatusLineKind.failedServerText
        case .none, .offline, .nameMissing, .roomNotFound, .inviteCodeRequired, .inviteCodeInvalid, .signInRequired,
             .appSuspended, .failedUnknown, .updateRequired:
            return .failedUnknown
        }
    }

    private static func waitingLine(_ kind: WaitingKind) -> LobbyStatusLineKind {
        switch kind {
        case .standard:
            return .waitingStandard
        case .locked:
            return .waitingLocked
        case .noHost:
            return .waitingNoHost
        case .hostAvailable:
            return .waitingHostAvailable
        case .reconnecting:
            return .waitingReconnecting
        case .offline:
            return .waitingOffline
        case .serverRestarting:
            return .waitingServerRestarting
        }
    }
}
