import Foundation

/// S50 PL14 (shared, pure; RECONCILE R2: origin decides, not coverage). An action started inside People, Host
/// Controls or a pushed host page reports inline at its source on iOS (any detent and the inspector) and on the
/// page's snackbar on Android (any InCallPage variant); an action started on the stage (the tile menu, the knock
/// banner, a stage dialog) uses the S20 toast lane on both platforms. The same rule is S60 D23 and S70 D20.
enum PeopleFailurePlacementPolicy {
    /// The toast kind a stage-origin People failure posts through `StagePresenter.postLocal` (S20 10, S30 CC7).
    static let stageNoticeKind = "peopleFailed"

    static func placement(origin: String, platform: String) -> HostFailurePlacement {
        if origin == PeopleActionOrigin.stage { return HostFailurePlacement.stage }
        return platform == NoticePlatform.android ? HostFailurePlacement.panelSnackbar : HostFailurePlacement.panelInline
    }

    /// The stage toast for a failure (Retry routes back through the core's notice command with this detail).
    static func stageNotice(_ failure: HostActionFailureModel, userId: String) -> MeetingNotice {
        MeetingNotice.make(kind: stageNoticeKind, severity: NoticeSeverity.error, userId: userId, name: failure.targetName,
                           actions: [NoticeAction.make(NoticeAction.retry)],
                           detail: stageDetail(failureId: failure.id, action: failure.action, failure: failure.failure))
    }

    /// `<failure id>|<command kind>|<failure>`: the notice carries what its copy and its Retry need.
    static func stageDetail(failureId: Int, action: String, failure: String) -> String {
        String(failureId) + "|" + action + "|" + failure
    }

    static func stageFailureId(_ detail: String) -> Int {
        let parts = detail.components(separatedBy: "|")
        if parts.isEmpty { return 0 }
        return Int(parts[0]) ?? 0
    }

    static func stageAction(_ detail: String) -> String {
        let parts = detail.components(separatedBy: "|")
        return parts.count > 1 ? parts[1] : ""
    }

    static func stageFailure(_ detail: String) -> String {
        let parts = detail.components(separatedBy: "|")
        return parts.count > 2 ? parts[2] : ""
    }
}

/// Which sentence a failure shows (S50 3 g, 6 g, 7 g, 8 g; RECONCILE R17): a typed reason sentence when the failure
/// names one, else the action's own "Couldn't ..." sentence. Views map the kind to their catalog key or `ppl_` /
/// `hst_` name, so both platforms show the same sentence.
enum PeopleFailureCopy {
    static let cantRemove = "cantRemove"
    static let rateLimited = "rateLimited"
    static let reconnect = "reconnect"
    static let alreadyLeft = "alreadyLeft"
    static let mute = "mute"
    static let camera = "camera"
    static let share = "share"
    static let shareAudio = "shareAudio"
    static let remove = "remove"
    static let coHost = "coHost"
    static let host = "host"
    static let audience = "audience"
    static let rename = "rename"
    static let lockMeeting = "lockMeeting"
    static let policy = "policy"
    static let muteAll = "muteAll"
    static let cameras = "cameras"
    static let shares = "shares"
    static let hands = "hands"
    static let codeSave = "codeSave"
    static let codeRemove = "codeRemove"
    static let access = "access"
    static let notice = "notice"
    static let link = "link"
    static let generic = "generic"

    static func kind(action: String, failure: String, sourceKey: String) -> String {
        let typed = HostActionFailure(rawValue: failure)
        if typed == HostActionFailure.superAdmin { return cantRemove }
        if typed == HostActionFailure.rateLimited { return rateLimited }
        if typed == HostActionFailure.notJoined || typed == HostActionFailure.notConnected { return reconnect }
        guard let kind = PeopleCommandKind(rawValue: action) else { return generic }
        if typed == HostActionFailure.notFound && isPersonAction(kind) { return alreadyLeft }
        switch kind {
        case .mute: return mute
        case .turnOffCamera: return camera
        case .stopScreenShare: return share
        case .stopScreenAudio: return shareAudio
        case .remove, .block: return remove
        case .makeCoHost: return coHost
        case .makeHost: return host
        case .moveToAudience: return audience
        case .changeName: return rename
        case .setPolicy: return sourceKey == HostPolicyID.lockMeeting.rawValue ? lockMeeting : policy
        case .bulk: return bulkKind(sourceKey)
        case .setMeetingInviteCode: return codeSave
        case .clearMeetingInviteCode: return codeRemove
        case .allowKey, .blockKey, .unblockKey, .revokeKey, .refreshAccessLists: return access
        case .sendNotice: return notice
        case .generateLink, .rotateLink: return link
        default: return generic
        }
    }

    private static func bulkKind(_ sourceKey: String) -> String {
        guard let bulk = HostBulkID(rawValue: sourceKey) else { return generic }
        switch bulk {
        case .muteAll: return muteAll
        case .camerasOff: return cameras
        case .stopAllShares: return shares
        case .lowerAllHands: return hands
        }
    }

    private static func isPersonAction(_ kind: PeopleCommandKind) -> Bool {
        switch kind {
        case .mute, .turnOffCamera, .stopScreenShare, .stopScreenAudio, .remove, .block, .makeCoHost, .makeHost,
             .moveToAudience, .admit, .deny:
            return true
        default:
            return false
        }
    }
}
