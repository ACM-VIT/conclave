import Foundation

enum PeopleFailurePlacementPolicy {

    static let stageNoticeKind = "peopleFailed"

    static func placement(origin: String, platform: String) -> HostFailurePlacement {
        if origin == PeopleActionOrigin.stage { return HostFailurePlacement.stage }
        return platform == NoticePlatform.android ? HostFailurePlacement.panelSnackbar : HostFailurePlacement.panelInline
    }

    static func stageNotice(_ failure: HostActionFailureModel, userId: String) -> MeetingNotice {
        MeetingNotice.make(kind: stageNoticeKind, severity: NoticeSeverity.error, userId: userId, name: failure.targetName,
                           actions: [NoticeAction.make(NoticeAction.retry)],
                           detail: stageDetail(failureId: failure.id, action: failure.action, failure: failure.failure))
    }

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

    static let invite = "invite"
    static let inviteGone = "inviteGone"
    static let cancelInvite = "cancelInvite"
    static let webinar = "webinar"

    static let qaSend = "qaSend"
    static let qaRateLimited = "qaRateLimited"
    static let qaTooShort = "qaTooShort"
    static let qaModerate = "qaModerate"

    static let admit = "admit"
    static let admitAll = "admitAll"
    static let deny = "deny"
    static let generic = "generic"

    static func kind(action: String, failure: String, sourceKey: String) -> String {
        let typed = HostActionFailure(rawValue: failure)

        if action == PeopleCommandKind.qaSubmit.rawValue {
            if typed == HostActionFailure.rateLimited { return qaRateLimited }
            if typed == HostActionFailure.invalidInput { return qaTooShort }
        }
        if action == PeopleCommandKind.bringOnStage.rawValue && typed == HostActionFailure.notFound { return inviteGone }
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
        case .bringOnStage: return invite
        case .cancelStageInvite: return cancelInvite
        case .setMaxAttendees, .setAttendeeCode, .clearAttendeeCode, .setLinkSlug, .clearLinkSlug: return webinar
        case .qaSubmit: return qaSend
        case .qaUpvote, .qaModerate: return qaModerate
        case .admit: return admit
        case .admitAll: return admitAll
        case .deny: return deny
        default: return generic
        }
    }

    private static func bulkKind(_ sourceKey: String) -> String {

        if sourceKey == PeopleSectionID.raisedHands.rawValue { return hands }
        if sourceKey == PeopleSectionID.inMeeting.rawValue || sourceKey == PeopleSectionID.panelists.rawValue { return muteAll }
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
             .moveToAudience, .admit, .deny, .cancelStageInvite:
            return true
        default:
            return false
        }
    }
}
