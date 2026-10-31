import Foundation

enum NoticeLane: String, CaseIterable, Equatable {
    case banner, toast
}

enum NoticeSeverity: String, CaseIterable, Equatable {
    case info, success, warning, error, progress
}

struct NoticeAction: Equatable {
    let id: String
    let isEnabled: Bool

    static let view = "view"
    static let admit = "admit"
    static let admitAll = "admitAll"
    static let stopSharing = "stopSharing"
    static let turnOffAudioOnly = "turnOffAudioOnly"
    static let openSettings = "openSettings"
    static let shareAgain = "shareAgain"
    static let catchUp = "catchUp"
    static let retry = "retry"
    static let retryRecovery = "retryRecovery"
    static let undo = "undo"
    static let resume = "resume"
    static let useAudioOnly = "useAudioOnly"
    static let endNow = "endNow"
    static let vote = "vote"
    static let allow = "allow"

    static let notNow = "notNow"

    static let expand = "expand"

    static func make(_ id: String, isEnabled: Bool = true) -> NoticeAction {
        NoticeAction(id: id, isEnabled: isEnabled)
    }
}

enum NoticeAnnouncement {
    static let polite = "polite"
    static let assertiveOnce = "assertiveOnce"
    static let none = "none"
}

enum NoticePlatform {
    static let ios = "ios"
    static let android = "android"
}

enum NoticeKind {

    static let offline = "offline"
    static let captivePortal = "captivePortal"
    static let reconnecting = "reconnecting"
    static let serverRestart = "serverRestart"
    static let recapPosting = "recapPosting"
    static let onHold = "onHold"
    static let audioPaused = "audioPaused"
    static let knock = "knock"
    static let sharing = "sharing"
    static let shareRestoreFailed = "shareRestoreFailed"
    static let shareNotSending = "shareNotSending"
    static let hostNotice = "hostNotice"
    static let liveNotesStarted = "liveNotesStarted"
    static let catchUp = "catchUp"
    static let audioOnly = "audioOnly"
    static let veryPoorConnection = "veryPoorConnection"

    static let permission = "permission"
    static let notificationsOff = "notificationsOff"

    static let joined = "joined"
    static let left = "left"
    static let handRaised = "handRaised"
    static let hostMutedYou = "hostMutedYou"
    static let hostCameraOff = "hostCameraOff"
    static let hostLoweredHand = "hostLoweredHand"
    static let hostStoppedShare = "hostStoppedShare"
    static let becameHost = "becameHost"
    static let lostHost = "lostHost"
    static let routeChanged = "routeChanged"

    static let actionFailed = "actionFailed"

    static let rateLimited = "rateLimited"
    static let voteOpened = "voteOpened"
    static let resumedMuted = "resumedMuted"
    static let qualityLowered = "qualityLowered"
    static let chatPreview = "chatPreview"

    static let blockedExplanation = "blockedExplanation"
    static let endingForEveryone = "endingForEveryone"
    static let endFailed = "endFailed"
    static let routeFailed = "routeFailed"
    static let linkCopied = "linkCopied"
    static let lockFailed = "lockFailed"
    static let shareFailed = "shareFailed"

    static let bannerKinds: [String] = [offline, captivePortal, reconnecting, serverRestart, recapPosting, onHold, audioPaused,
                                        knock, sharing, shareRestoreFailed, shareNotSending, hostNotice, liveNotesStarted,
                                        catchUp, audioOnly, veryPoorConnection, permission, notificationsOff]

    static let eventToastKinds: [String] = [joined, left, handRaised, hostMutedYou, hostCameraOff, hostLoweredHand,
                                            hostStoppedShare, becameHost, lostHost, routeChanged, actionFailed, rateLimited,
                                            voteOpened, resumedMuted, qualityLowered, chatPreview]

    static let localToastKinds: [String] = [blockedExplanation, endingForEveryone, endFailed, routeFailed, linkCopied,
                                            lockFailed, shareFailed]
}

enum StageEventKind {
    static let userJoined = "userJoined"
    static let userLeft = "userLeft"

    static let handRaised = "handRaised"
    static let hostMutedYou = "hostMutedYou"
    static let hostCameraOff = "hostCameraOff"
    static let hostLoweredHand = "hostLoweredHand"
    static let hostStoppedShare = "hostStoppedShare"
    static let becameHost = "becameHost"
    static let lostHost = "lostHost"
    static let routeChanged = "routeChanged"

    static let rateLimited = "rateLimited"

    static let actionFailed = "actionFailed"

    static let chatPreview = "chatPreview"

    static let voteOpened = "voteOpened"
    static let resumedMuted = "resumedMuted"
    static let qualityLowered = "qualityLowered"

    static let hostNotice = "hostNotice"
}

struct MeetingNotice: Equatable, Identifiable {
    let id: String
    let kind: String
    let lane: NoticeLane
    let priority: Int
    let severity: NoticeSeverity
    let userId: String
    let name: String
    let count: Int
    let total: Int
    let serverText: String
    let actions: [NoticeAction]
    let isDismissible: Bool
    let messageId: String
    let detail: String
    let isPrivate: Bool
    let senderCount: Int
    let expiresAtMillis: Double
    let announcement: String

    static func make(id: String = "", kind: String, lane: NoticeLane = NoticeLane.toast, priority: Int = 2,
                     severity: NoticeSeverity = NoticeSeverity.info, userId: String = "", name: String = "", count: Int = 0,
                     total: Int = 0, serverText: String = "", actions: [NoticeAction] = [], isDismissible: Bool = true,
                     messageId: String = "", detail: String = "", isPrivate: Bool = false, senderCount: Int = 0,
                     expiresAtMillis: Double = 0.0, announcement: String = NoticeAnnouncement.polite) -> MeetingNotice {
        MeetingNotice(id: id, kind: kind, lane: lane, priority: priority, severity: severity, userId: userId, name: name,
                      count: count, total: total, serverText: serverText, actions: actions, isDismissible: isDismissible,
                      messageId: messageId, detail: detail, isPrivate: isPrivate, senderCount: senderCount,
                      expiresAtMillis: expiresAtMillis, announcement: announcement)
    }

    func withId(_ next: String) -> MeetingNotice {
        MeetingNotice(id: next, kind: kind, lane: lane, priority: priority, severity: severity, userId: userId, name: name,
                      count: count, total: total, serverText: serverText, actions: actions, isDismissible: isDismissible,
                      messageId: messageId, detail: detail, isPrivate: isPrivate, senderCount: senderCount,
                      expiresAtMillis: expiresAtMillis, announcement: announcement)
    }

    func withExpiry(_ next: Double) -> MeetingNotice {
        MeetingNotice(id: id, kind: kind, lane: lane, priority: priority, severity: severity, userId: userId, name: name,
                      count: count, total: total, serverText: serverText, actions: actions, isDismissible: isDismissible,
                      messageId: messageId, detail: detail, isPrivate: isPrivate, senderCount: senderCount,
                      expiresAtMillis: next, announcement: announcement)
    }

    func coalesced(count nextCount: Int, senderCount nextSenders: Int, messageId nextMessage: String, detail nextDetail: String,
                   isPrivate nextPrivate: Bool) -> MeetingNotice {
        MeetingNotice(id: id, kind: kind, lane: lane, priority: priority, severity: severity, userId: userId, name: name,
                      count: nextCount, total: total, serverText: serverText, actions: actions, isDismissible: isDismissible,
                      messageId: nextMessage, detail: nextDetail, isPrivate: nextPrivate, senderCount: nextSenders,
                      expiresAtMillis: expiresAtMillis, announcement: announcement)
    }

    func mergedPreview(with newest: MeetingNotice, count nextCount: Int, senderCount nextSenders: Int) -> MeetingNotice {
        MeetingNotice(id: id, kind: kind, lane: lane, priority: priority, severity: severity, userId: newest.userId,
                      name: newest.name, count: nextCount, total: total, serverText: newest.serverText, actions: actions,
                      isDismissible: isDismissible, messageId: newest.messageId.isEmpty ? messageId : newest.messageId,
                      detail: newest.detail, isPrivate: newest.isPrivate, senderCount: nextSenders,
                      expiresAtMillis: expiresAtMillis, announcement: announcement)
    }

    func hasAction(_ actionId: String) -> Bool {
        for action in actions {
            if action.id == actionId { return true }
        }
        return false
    }

    var isFailure: Bool { severity == NoticeSeverity.error }
}

struct NoticeCommand: Equatable {
    let actionId: String
    let noticeKind: String
    let userId: String
    let detail: String

    static let dismissHostNotice = "dismissHostNotice"
}

struct StageNoticeInputs: Equatable {
    let callSession: Int
    let isAttendee: Bool
    let isHost: Bool
    let localUserId: String

    let participantCount: Int

    let hasInitialPresenceSnapshot: Bool
    let isOffline: Bool

    let isCaptivePortal: Bool
    let isRecovering: Bool
    let isResumingFromBackground: Bool

    let reconnectAttempt: Int
    let reconnectAttemptLimit: Int
    let isRecoveryAttemptInFlight: Bool
    let hasServerRestartNotice: Bool
    let serverRestartText: String

    let isRecapPosting: Bool

    let isOnHold: Bool
    let isAudioPaused: Bool

    let pendingUserIds: [String]
    let pendingFirstName: String
    let isScreenSharing: Bool

    let shareIssue: String
    let shareIssueSerial: Int
    let liveNotes: LiveNotesState

    let catchUpMinutes: Int
    let isAudioOnly: Bool

    let connectionQuality: ConnectionQuality
    let cameraPermissionRevoked: Bool
    let microphonePermissionRevoked: Bool

    let showsNotificationsPrime: Bool

    let knockSoundOn: Bool
    let handSoundOn: Bool

    static func make(callSession: Int = 0, isAttendee: Bool = false, isHost: Bool = false, localUserId: String = "",
                     participantCount: Int = 1, hasInitialPresenceSnapshot: Bool = true, isOffline: Bool = false,
                     isCaptivePortal: Bool = false, isRecovering: Bool = false, isResumingFromBackground: Bool = false,
                     reconnectAttempt: Int = 0, reconnectAttemptLimit: Int = 5, isRecoveryAttemptInFlight: Bool = false,
                     hasServerRestartNotice: Bool = false, serverRestartText: String = "", isRecapPosting: Bool = false,
                     isOnHold: Bool = false, isAudioPaused: Bool = false, pendingUserIds: [String] = [],
                     pendingFirstName: String = "", isScreenSharing: Bool = false, shareIssue: String = "",
                     shareIssueSerial: Int = 0, liveNotes: LiveNotesState = LiveNotesState.off, catchUpMinutes: Int = 0,
                     isAudioOnly: Bool = false, connectionQuality: ConnectionQuality = ConnectionQuality.unknown,
                     cameraPermissionRevoked: Bool = false, microphonePermissionRevoked: Bool = false,
                     showsNotificationsPrime: Bool = false, knockSoundOn: Bool = false,
                     handSoundOn: Bool = false) -> StageNoticeInputs {
        StageNoticeInputs(callSession: callSession, isAttendee: isAttendee, isHost: isHost, localUserId: localUserId,
                          participantCount: participantCount, hasInitialPresenceSnapshot: hasInitialPresenceSnapshot,
                          isOffline: isOffline, isCaptivePortal: isCaptivePortal, isRecovering: isRecovering,
                          isResumingFromBackground: isResumingFromBackground, reconnectAttempt: reconnectAttempt,
                          reconnectAttemptLimit: reconnectAttemptLimit, isRecoveryAttemptInFlight: isRecoveryAttemptInFlight,
                          hasServerRestartNotice: hasServerRestartNotice, serverRestartText: serverRestartText,
                          isRecapPosting: isRecapPosting, isOnHold: isOnHold, isAudioPaused: isAudioPaused,
                          pendingUserIds: pendingUserIds, pendingFirstName: pendingFirstName, isScreenSharing: isScreenSharing,
                          shareIssue: shareIssue, shareIssueSerial: shareIssueSerial, liveNotes: liveNotes,
                          catchUpMinutes: catchUpMinutes, isAudioOnly: isAudioOnly, connectionQuality: connectionQuality,
                          cameraPermissionRevoked: cameraPermissionRevoked,
                          microphonePermissionRevoked: microphonePermissionRevoked,
                          showsNotificationsPrime: showsNotificationsPrime, knockSoundOn: knockSoundOn,
                          handSoundOn: handSoundOn)
    }

    static let empty = StageNoticeInputs.make(hasInitialPresenceSnapshot: false)
}

enum StageNoticeAnnouncementKind {
    static let reconnecting = "reconnecting"
    static let reconnected = "reconnected"
}

struct NoticeLaneGeometry: Equatable {
    let bannerTop: Double
    let chipsVisible: Bool
    let toastBottom: Double
    let toastLeading: Double
    let toastTrailing: Double

    static let zero = NoticeLaneGeometry(bannerTop: 0, chipsVisible: false, toastBottom: 0, toastLeading: 0, toastTrailing: 0)
}

enum NoticeLaneGeometryPolicy {

    static let edgeMargin = 12.0

    static let bottomBand = 160.0
    static let selfViewGap = 8.0

    static func geometry(viewport: StageViewport, frames: [StageFrame], slots: [StageSlot], chipsVisible: Bool) -> NoticeLaneGeometry {
        var leading = viewport.insetLeading + edgeMargin
        var trailing = viewport.insetTrailing + edgeMargin
        let bandTop = viewport.height - viewport.insetBottom - bottomBand
        for slot in slots {
            if !slot.role.isSelfMovable { continue }
            for frame in frames {
                if frame.slotId != slot.id || frame.maxY < bandTop { continue }
                if frame.x + frame.width / 2.0 < viewport.width / 2.0 {
                    leading = max(leading, frame.maxX + selfViewGap)
                } else {
                    trailing = max(trailing, viewport.width - frame.x + selfViewGap)
                }
            }
        }
        return NoticeLaneGeometry(bannerTop: viewport.insetTop, chipsVisible: chipsVisible, toastBottom: viewport.insetBottom,
                                  toastLeading: leading, toastTrailing: trailing)
    }
}

enum MeetingNoticePolicy {

    static let coalesceWindowMillis = 4_000.0

    static let queueLimit = 3

    static let largeRoomThreshold = 12

    static let hostNoticeMillis = 60_000.0

    static let recoveryGraceMillis = 3_000.0

    static let longNoticeCharacters = 180
    static let maxNoticeCharacters = 2_000
    static let shareIssueRestoreFailed = "restoreFailed"
    static let shareIssueNotSending = "notSending"
    static let permissionCamera = "camera"
    static let permissionMicrophone = "microphone"

    static func bannerCandidates(_ inputs: StageNoticeInputs, hostNotice: MeetingNotice?, liveNotesEpisode: Int,
                                 currentPanel: String, platform: String, knockPending: Bool = false) -> [MeetingNotice] {
        var result: [MeetingNotice] = []
        let android = platform == NoticePlatform.android
        if android && inputs.isCaptivePortal {
            result.append(banner(NoticeKind.captivePortal, 2, NoticeSeverity.warning, arm: "",
                                 actions: [NoticeAction.make(NoticeAction.openSettings)], dismissible: false,
                                 announcement: NoticeAnnouncement.assertiveOnce))
        } else if inputs.isOffline {
            result.append(banner(NoticeKind.offline, 1, NoticeSeverity.warning, arm: "", dismissible: false,
                                 announcement: NoticeAnnouncement.assertiveOnce))
        }
        if inputs.isRecovering && !inputs.isResumingFromBackground {
            let showsAttempt = inputs.reconnectAttempt >= 2
            var actions: [NoticeAction] = []
            if showsAttempt {
                actions.append(NoticeAction.make(NoticeAction.retryRecovery, isEnabled: !inputs.isRecoveryAttemptInFlight))
            }
            result.append(MeetingNotice.make(id: NoticeKind.reconnecting + ":", kind: NoticeKind.reconnecting,
                                             lane: NoticeLane.banner, priority: 3, severity: NoticeSeverity.progress,
                                             count: showsAttempt ? inputs.reconnectAttempt : 0,
                                             total: showsAttempt ? inputs.reconnectAttemptLimit : 0, actions: actions,
                                             isDismissible: false))
        }
        if inputs.hasServerRestartNotice {
            result.append(MeetingNotice.make(id: NoticeKind.serverRestart + ":", kind: NoticeKind.serverRestart,
                                             lane: NoticeLane.banner, priority: 4, severity: NoticeSeverity.progress,
                                             serverText: inputs.serverRestartText, isDismissible: false))
        }
        if inputs.isAttendee {

            return result
        }
        if inputs.isRecapPosting {
            result.append(banner(NoticeKind.recapPosting, 5, NoticeSeverity.progress, arm: "",
                                 actions: [NoticeAction.make(NoticeAction.endNow)], dismissible: false))
        }
        if inputs.isOnHold {
            result.append(banner(NoticeKind.onHold, 6, NoticeSeverity.info, arm: "",
                                 actions: [NoticeAction.make(NoticeAction.resume)], dismissible: false))
        }
        if inputs.isAudioPaused && !inputs.isOnHold {
            result.append(banner(NoticeKind.audioPaused, 7, NoticeSeverity.warning, arm: "", dismissible: false))
        }
        if inputs.isHost && !inputs.pendingUserIds.isEmpty {
            let count = inputs.pendingUserIds.count
            let one = count == 1
            let secondId = one ? NoticeAction.admit : NoticeAction.admitAll
            let second = NoticeAction.make(secondId, isEnabled: !knockPending)

            let peopleShown = currentPanel == MeetingPanel.participants.rawValue
            result.append(MeetingNotice.make(id: NoticeKind.knock + ":", kind: NoticeKind.knock, lane: NoticeLane.banner,
                                             priority: 8, severity: NoticeSeverity.info,
                                             userId: one ? inputs.pendingUserIds[0] : "",
                                             name: one ? inputs.pendingFirstName : "", count: count,
                                             actions: [NoticeAction.make(NoticeAction.view), second], isDismissible: false,
                                             announcement: peopleShown ? NoticeAnnouncement.none : NoticeAnnouncement.assertiveOnce))
        }
        if inputs.isScreenSharing {
            result.append(banner(NoticeKind.sharing, 9, NoticeSeverity.info, arm: "",
                                 actions: [NoticeAction.make(NoticeAction.stopSharing)], dismissible: false))
        }
        if inputs.shareIssue == shareIssueRestoreFailed || inputs.shareIssue == shareIssueNotSending {
            let kind = inputs.shareIssue == shareIssueRestoreFailed ? NoticeKind.shareRestoreFailed : NoticeKind.shareNotSending
            result.append(banner(kind, 10, NoticeSeverity.warning, arm: String(inputs.shareIssueSerial),
                                 actions: [NoticeAction.make(NoticeAction.shareAgain)], dismissible: true))
        }
        if let notice = hostNotice {
            result.append(notice)
        }
        if inputs.liveNotes == LiveNotesState.live {
            result.append(banner(NoticeKind.liveNotesStarted, 12, NoticeSeverity.info, arm: String(liveNotesEpisode),
                                 dismissible: true))
        }
        if inputs.catchUpMinutes > 0 && currentPanel != MeetingPanel.transcript.rawValue {
            result.append(MeetingNotice.make(id: NoticeKind.catchUp + ":call", kind: NoticeKind.catchUp,
                                             lane: NoticeLane.banner, priority: 13, severity: NoticeSeverity.info,
                                             count: inputs.catchUpMinutes,
                                             actions: [NoticeAction.make(NoticeAction.catchUp)], isDismissible: true))
        }
        if inputs.isAudioOnly {
            result.append(banner(NoticeKind.audioOnly, 14, NoticeSeverity.info, arm: "",
                                 actions: [NoticeAction.make(NoticeAction.turnOffAudioOnly)], dismissible: false))
        }
        if inputs.connectionQuality == ConnectionQuality.emergency && !inputs.isAudioOnly {
            result.append(banner(NoticeKind.veryPoorConnection, 15, NoticeSeverity.warning, arm: "",
                                 actions: [NoticeAction.make(NoticeAction.useAudioOnly)], dismissible: true))
        }
        if inputs.microphonePermissionRevoked {
            result.append(MeetingNotice.make(id: NoticeKind.permission + ":" + permissionMicrophone, kind: NoticeKind.permission,
                                             lane: NoticeLane.banner, priority: 16, severity: NoticeSeverity.warning,
                                             actions: [NoticeAction.make(NoticeAction.openSettings)], isDismissible: true,
                                             detail: permissionMicrophone))
        }
        if inputs.cameraPermissionRevoked {
            result.append(MeetingNotice.make(id: NoticeKind.permission + ":" + permissionCamera, kind: NoticeKind.permission,
                                             lane: NoticeLane.banner, priority: 16, severity: NoticeSeverity.warning,
                                             actions: [NoticeAction.make(NoticeAction.openSettings)], isDismissible: true,
                                             detail: permissionCamera))
        }
        if android && inputs.showsNotificationsPrime {
            result.append(banner(NoticeKind.notificationsOff, 17, NoticeSeverity.info, arm: "session",
                                 actions: [NoticeAction.make(NoticeAction.allow), NoticeAction.make(NoticeAction.notNow)],
                                 dismissible: true))
        }
        return result
    }

    private static func banner(_ kind: String, _ priority: Int, _ severity: NoticeSeverity, arm: String,
                               actions: [NoticeAction] = [], dismissible: Bool,
                               announcement: String = NoticeAnnouncement.polite) -> MeetingNotice {
        MeetingNotice.make(id: kind + ":" + arm, kind: kind, lane: NoticeLane.banner, priority: priority, severity: severity,
                           actions: actions, isDismissible: dismissible, announcement: announcement)
    }

    static func hostNoticeBanner(serial: Int, text: String, level: String, senderId: String, senderName: String,
                                 expiresAtMillis: Double) -> MeetingNotice {
        var severity = NoticeSeverity.info
        if level == "warning" { severity = NoticeSeverity.warning }
        if level == "error" { severity = NoticeSeverity.error }
        var actions: [NoticeAction] = []
        if text.count > longNoticeCharacters { actions.append(NoticeAction.make(NoticeAction.expand)) }
        let bounded = text.count > maxNoticeCharacters ? String(text.prefix(maxNoticeCharacters)) : text
        return MeetingNotice.make(id: NoticeKind.hostNotice + ":" + String(serial), kind: NoticeKind.hostNotice,
                                  lane: NoticeLane.banner, priority: 11, severity: severity, userId: senderId, name: senderName,
                                  serverText: bounded, actions: actions, isDismissible: true, detail: level,
                                  expiresAtMillis: expiresAtMillis)
    }

    static func toast(fromEvent event: StageEvent) -> MeetingNotice? {
        switch event.kind {
        case StageEventKind.userJoined:
            return MeetingNotice.make(kind: NoticeKind.joined, userId: event.userId, name: event.name, count: 1,
                                      announcement: NoticeAnnouncement.polite)
        case StageEventKind.userLeft:
            return MeetingNotice.make(kind: NoticeKind.left, userId: event.userId, name: event.name, count: 1)
        case StageEventKind.handRaised:
            return MeetingNotice.make(kind: NoticeKind.handRaised, userId: event.userId, name: event.name, count: 1,
                                      actions: [NoticeAction.make(NoticeAction.view)])
        case StageEventKind.hostMutedYou:
            return MeetingNotice.make(kind: NoticeKind.hostMutedYou)
        case StageEventKind.hostCameraOff:
            return MeetingNotice.make(kind: NoticeKind.hostCameraOff)
        case StageEventKind.hostLoweredHand:
            return MeetingNotice.make(kind: NoticeKind.hostLoweredHand)
        case StageEventKind.hostStoppedShare:
            return MeetingNotice.make(kind: NoticeKind.hostStoppedShare)
        case StageEventKind.becameHost:
            return MeetingNotice.make(kind: NoticeKind.becameHost, severity: NoticeSeverity.success)
        case StageEventKind.lostHost:
            return MeetingNotice.make(kind: NoticeKind.lostHost)
        case StageEventKind.routeChanged:
            return MeetingNotice.make(kind: NoticeKind.routeChanged, name: event.name, detail: event.detail)
        case StageEventKind.rateLimited:
            return MeetingNotice.make(kind: NoticeKind.rateLimited, detail: event.detail)
        case StageEventKind.actionFailed:
            return MeetingNotice.make(kind: NoticeKind.actionFailed, priority: 1, severity: NoticeSeverity.error,
                                      serverText: event.serverText, actions: [NoticeAction.make(NoticeAction.retry)],
                                      detail: event.detail)
        case StageEventKind.chatPreview:

            return MeetingNotice.make(kind: NoticeKind.chatPreview, priority: 3, userId: event.userId, name: event.name,
                                      count: 1, serverText: event.serverText, actions: [NoticeAction.make(NoticeAction.view)],
                                      messageId: event.messageId, detail: event.detail, isPrivate: event.isPrivate,
                                      senderCount: 1)
        case StageEventKind.voteOpened:
            return MeetingNotice.make(kind: NoticeKind.voteOpened, userId: event.userId, name: event.name,
                                      actions: [NoticeAction.make(NoticeAction.vote)])
        case StageEventKind.resumedMuted:
            return MeetingNotice.make(kind: NoticeKind.resumedMuted)
        case StageEventKind.qualityLowered:
            return MeetingNotice.make(kind: NoticeKind.qualityLowered)
        default:
            return nil
        }
    }

    static func coalesces(_ kind: String) -> Bool {
        kind == NoticeKind.joined || kind == NoticeKind.handRaised || kind == NoticeKind.chatPreview
    }

    static func showsPresenceToast(kind: String, participantCount: Int, isHost: Bool) -> Bool {
        if participantCount <= largeRoomThreshold { return true }
        if kind == NoticeKind.joined { return isHost }
        return false
    }

    static func attendeeSeesToast(_ notice: MeetingNotice) -> Bool {
        if notice.kind == NoticeKind.hostLoweredHand { return true }
        if notice.kind == NoticeKind.actionFailed || notice.kind == NoticeKind.rateLimited { return notice.detail == "hand" }
        return false
    }

    static func qualityDismissalResets(_ quality: ConnectionQuality) -> Bool {
        quality == ConnectionQuality.good || quality == ConnectionQuality.fair
    }

    static func feedbackKind(forEvent kind: String) -> FeedbackKind? {
        switch kind {
        case StageEventKind.hostMutedYou: return FeedbackKind.hostMutedYou
        case StageEventKind.hostCameraOff: return FeedbackKind.cameraOffByHost
        case StageEventKind.hostLoweredHand: return FeedbackKind.handLoweredByHost
        case StageEventKind.becameHost: return FeedbackKind.becameHost
        case StageEventKind.lostHost: return FeedbackKind.lostHost
        default: return nil
        }
    }

    static func suspendsToastLane(style: PanelHostStyle) -> Bool {
        style == PanelHostStyle.sheet || style == PanelHostStyle.overlay || style == PanelHostStyle.bottomSheet
    }
}

final class MeetingNoticeCenter {
    private(set) var platform: String
    private(set) var banner: MeetingNotice? = nil
    private(set) var toast: MeetingNotice? = nil
    private(set) var queue: [MeetingNotice] = []
    private(set) var isToastLaneSuspended = false
    private(set) var inputs = StageNoticeInputs.empty

    private(set) var droppedToasts = 0
    private(set) var liveNotesEpisode = 0

    private var dismissed: [String: String] = [:]
    private var currentPanel = ""
    private var postedAt: [String: Double] = [:]
    private var senders: [String: [String]] = [:]
    private var nextToastSerial = 0
    private var recoveryGraceUntilMillis = 0.0
    private var knownPendingIds: [String] = []
    private var knockBaselineReady = false

    private(set) var knockActionsPending = false
    private var hasHostNotice = false
    private var hostNoticeSerial = 0
    private var hostNoticeText = ""
    private var hostNoticeLevel = ""
    private var hostNoticeSenderId = ""
    private var hostNoticeSenderName = ""
    private var hostNoticeRemainingMillis = 0.0
    private var hostNoticeShownSinceMillis = 0.0

    init(platform: String = NoticePlatform.ios) {
        self.platform = platform
    }

    func setPlatform(_ next: String, nowMillis: Double) {
        if next == platform { return }
        platform = next
        recomputeBanner(nowMillis: nowMillis)
    }

    var bannerExpiresAtMillis: Double { banner?.expiresAtMillis ?? 0.0 }

    var hostNoticeRemaining: Double { hasHostNotice ? hostNoticeRemainingMillis : 0.0 }

    func applyState(_ next: StageNoticeInputs, nowMillis: Double) -> [String] {
        let previous = inputs
        inputs = next
        if previous.isRecovering && !next.isRecovering {
            recoveryGraceUntilMillis = nowMillis + MeetingNoticePolicy.recoveryGraceMillis
        }
        if next.liveNotes == LiveNotesState.live && previous.liveNotes != LiveNotesState.live
            && previous.liveNotes != LiveNotesState.paused {
            liveNotesEpisode += 1
        }
        if MeetingNoticePolicy.qualityDismissalResets(next.connectionQuality) {
            dismissed[NoticeKind.veryPoorConnection] = nil
        }
        var chimes: [String] = []
        let wasReady = knockBaselineReady
        let canChime = wasReady && next.isHost && !next.isRecovering && nowMillis >= recoveryGraceUntilMillis
        if canChime {
            for id in next.pendingUserIds {
                if !knownPendingIds.contains(id) {
                    chimes.append(NoticeSoundKind.knock)
                    break
                }
            }
        }
        knownPendingIds = next.pendingUserIds
        knockBaselineReady = next.isHost && next.hasInitialPresenceSnapshot && !next.isRecovering
        if next.isAttendee {
            dropToasts { notice in !MeetingNoticePolicy.attendeeSeesToast(notice) }
        }
        recomputeBanner(nowMillis: nowMillis)
        return chimes
    }

    func setCurrentPanel(_ raw: String, nowMillis: Double) {
        if raw == currentPanel { return }
        currentPanel = raw
        if raw == MeetingPanel.chat.rawValue {
            dropToasts { notice in notice.kind == NoticeKind.chatPreview }
        }
        recomputeBanner(nowMillis: nowMillis)
    }

    func setKnockActionsPending(_ pending: Bool, nowMillis: Double) {
        if pending == knockActionsPending { return }
        knockActionsPending = pending
        recomputeBanner(nowMillis: nowMillis)
    }

    func setToastLaneSuspended(_ suspended: Bool) {
        if suspended == isToastLaneSuspended { return }
        isToastLaneSuspended = suspended
        if suspended {
            dropToasts { notice in notice.kind == NoticeKind.chatPreview }
            if let current = toast {
                toast = nil
                queue.insert(current, at: 0)
                enforceQueueLimit()
            }
        } else {
            promote()
        }
    }

    func post(_ event: StageEvent, nowMillis: Double, showsChatPreviews: Bool = true) -> [String] {
        if event.kind == StageEventKind.hostNotice {
            latchHostNotice(event, nowMillis: nowMillis)
            return []
        }
        guard let candidate = MeetingNoticePolicy.toast(fromEvent: event) else { return [] }
        let presenceKind = candidate.kind == NoticeKind.joined || candidate.kind == NoticeKind.left
            || candidate.kind == NoticeKind.handRaised
        if presenceKind && isPresenceSuppressed(nowMillis: nowMillis) {
            droppedToasts += 1
            return []
        }
        if candidate.kind == NoticeKind.joined || candidate.kind == NoticeKind.left {
            if !MeetingNoticePolicy.showsPresenceToast(kind: candidate.kind, participantCount: inputs.participantCount,
                                                       isHost: inputs.isHost) {
                droppedToasts += 1
                return []
            }
            if event.userId == inputs.localUserId && !event.userId.isEmpty { return [] }
        }
        if candidate.kind == NoticeKind.handRaised {
            if !inputs.isHost || (event.userId == inputs.localUserId && !event.userId.isEmpty) {
                return []
            }
        }
        if inputs.isAttendee && !MeetingNoticePolicy.attendeeSeesToast(candidate) {
            droppedToasts += 1
            return []
        }
        if candidate.kind == NoticeKind.chatPreview && currentPanel == MeetingPanel.chat.rawValue {
            droppedToasts += 1
            return []
        }

        if candidate.kind == NoticeKind.chatPreview && (!showsChatPreviews || isToastLaneSuspended) {
            droppedToasts += 1
            return []
        }

        if candidate.kind == NoticeKind.chatPreview && !event.userId.isEmpty && event.userId == inputs.localUserId {
            return []
        }
        var senderId = event.userId
        if candidate.kind == NoticeKind.chatPreview {
            senderId = ChatPreviewPolicy.senderKey(userId: event.userId, name: event.name)
        }
        enqueue(candidate, senderId: senderId, nowMillis: nowMillis)
        if candidate.kind == NoticeKind.handRaised { return [NoticeSoundKind.hand] }
        return []
    }

    func postLocal(_ notice: MeetingNotice, nowMillis: Double) {
        var next = notice
        if next.id.isEmpty {
            nextToastSerial += 1
            next = next.withId("local:" + String(nextToastSerial))
        }
        if next.lane == NoticeLane.banner { return }
        if inputs.isAttendee && !MeetingNoticePolicy.attendeeSeesToast(next) && next.kind != NoticeKind.blockedExplanation {
            droppedToasts += 1
            return
        }
        if next.kind == NoticeKind.endFailed, let current = toast, current.kind == NoticeKind.endingForEveryone {
            toast = next
            return
        }
        if next.kind == NoticeKind.endFailed {
            removeQueued { notice in notice.kind == NoticeKind.endingForEveryone }
        }
        insertQueued(next, nowMillis: nowMillis)
        promote()
    }

    func dismiss(id: String, nowMillis: Double) {
        if let current = toast, current.id == id {
            if current.severity == NoticeSeverity.progress { return }
            toast = nil
            postedAt[id] = nil
            senders[id] = nil
            promote()
            return
        }
        if let shown = banner, shown.id == id, shown.isDismissible {
            dismissed[shown.kind] = shown.id
            if shown.kind == NoticeKind.hostNotice { clearHostNotice() }
            recomputeBanner(nowMillis: nowMillis)
            return
        }
        removeQueued { notice in notice.id == id }
    }

    func clear(id: String) {
        if let current = toast, current.id == id {
            toast = nil
            promote()
            return
        }
        removeQueued { notice in notice.id == id }
    }

    func clearChatPreviews() {
        dropToasts { notice in notice.kind == NoticeKind.chatPreview }
    }

    func dropChatPreviews(fromUserId userId: String) {
        if userId.isEmpty { return }
        var ids: [String] = []
        if let current = toast, current.kind == NoticeKind.chatPreview, previewIncludes(current, userId: userId) {
            ids.append(current.id)
        }
        for notice in queue {
            if notice.kind == NoticeKind.chatPreview && previewIncludes(notice, userId: userId) {
                ids.append(notice.id)
            }
        }
        if ids.isEmpty { return }
        let dropped = ids
        dropToasts { notice in dropped.contains(notice.id) }
    }

    func previewSenders(noticeId: String) -> [String] {
        senders[noticeId] ?? []
    }

    private func previewIncludes(_ notice: MeetingNotice, userId: String) -> Bool {
        if notice.userId == userId { return true }
        return (senders[notice.id] ?? []).contains(userId)
    }

    func expireIfDue(nowMillis: Double) -> Bool {
        guard let shown = banner, shown.kind == NoticeKind.hostNotice, shown.expiresAtMillis > 0 else { return false }
        if nowMillis < shown.expiresAtMillis { return false }
        clearHostNotice()
        recomputeBanner(nowMillis: nowMillis)
        return true
    }

    func reset() {
        banner = nil
        toast = nil
        queue = []
        isToastLaneSuspended = false
        inputs = StageNoticeInputs.empty
        dismissed = [:]
        currentPanel = ""
        postedAt = [:]
        senders = [:]
        recoveryGraceUntilMillis = 0.0
        knownPendingIds = []
        knockBaselineReady = false
        knockActionsPending = false
        liveNotesEpisode = 0
        clearHostNotice()
    }

    private func recomputeBanner(nowMillis: Double) {
        if hasHostNotice && hostNoticeRemainingMillis <= 0 { clearHostNotice() }
        let wasHostNotice = banner?.kind == NoticeKind.hostNotice
        var hostCandidate: MeetingNotice? = nil
        if hasHostNotice && !inputs.isAttendee {
            hostCandidate = MeetingNoticePolicy.hostNoticeBanner(serial: hostNoticeSerial, text: hostNoticeText,
                                                                 level: hostNoticeLevel, senderId: hostNoticeSenderId,
                                                                 senderName: hostNoticeSenderName, expiresAtMillis: 0.0)
        }
        let candidates = MeetingNoticePolicy.bannerCandidates(inputs, hostNotice: hostCandidate,
                                                              liveNotesEpisode: liveNotesEpisode, currentPanel: currentPanel,
                                                              platform: platform, knockPending: knockActionsPending)
        var top: MeetingNotice? = nil
        for candidate in candidates {
            if dismissed[candidate.kind] == candidate.id { continue }
            top = candidate
            break
        }
        let isHostNotice = top?.kind == NoticeKind.hostNotice
        if wasHostNotice && !isHostNotice && hasHostNotice {

            hostNoticeRemainingMillis -= max(0.0, nowMillis - hostNoticeShownSinceMillis)
            hostNoticeShownSinceMillis = 0.0
        }
        if isHostNotice, let shown = top {
            if !wasHostNotice { hostNoticeShownSinceMillis = nowMillis }
            top = shown.withExpiry(hostNoticeShownSinceMillis + hostNoticeRemainingMillis)
        }
        banner = top
    }

    private func latchHostNotice(_ event: StageEvent, nowMillis: Double) {
        let text = event.serverText.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        if text.isEmpty { return }
        if banner?.kind == NoticeKind.hostNotice {

            clearHostNotice()
            banner = nil
        }
        hostNoticeSerial += 1
        hasHostNotice = true
        hostNoticeText = text
        hostNoticeLevel = event.detail
        hostNoticeSenderId = event.userId
        hostNoticeSenderName = event.name
        hostNoticeRemainingMillis = MeetingNoticePolicy.hostNoticeMillis
        hostNoticeShownSinceMillis = 0.0
        recomputeBanner(nowMillis: nowMillis)
    }

    private func clearHostNotice() {
        hasHostNotice = false
        hostNoticeText = ""
        hostNoticeLevel = ""
        hostNoticeSenderId = ""
        hostNoticeSenderName = ""
        hostNoticeRemainingMillis = 0.0
        hostNoticeShownSinceMillis = 0.0
    }

    private func isPresenceSuppressed(nowMillis: Double) -> Bool {
        !inputs.hasInitialPresenceSnapshot || inputs.isRecovering || nowMillis < recoveryGraceUntilMillis
    }

    private func enqueue(_ notice: MeetingNotice, senderId: String, nowMillis: Double) {

        if notice.kind == NoticeKind.chatPreview, let current = toast, current.kind == NoticeKind.chatPreview {
            let people = addSender(senderId, to: current.id)
            toast = current.mergedPreview(with: notice, count: current.count + 1, senderCount: max(1, people.count))
            postedAt[current.id] = nowMillis
            return
        }
        if MeetingNoticePolicy.coalesces(notice.kind) {
            var index = 0
            while index < queue.count {
                let queued = queue[index]
                let at = postedAt[queued.id] ?? 0.0
                if queued.kind == notice.kind && nowMillis - at <= MeetingNoticePolicy.coalesceWindowMillis {
                    let people = addSender(senderId, to: queued.id)
                    var merged = queued.coalesced(count: queued.count + 1, senderCount: max(1, people.count),
                                                  messageId: notice.messageId.isEmpty ? queued.messageId : notice.messageId,
                                                  detail: notice.detail.isEmpty ? queued.detail : notice.detail,
                                                  isPrivate: queued.isPrivate || notice.isPrivate)
                    if notice.kind == NoticeKind.chatPreview {
                        merged = queued.mergedPreview(with: notice, count: queued.count + 1, senderCount: max(1, people.count))
                    }
                    queue[index] = merged
                    postedAt[queued.id] = nowMillis
                    promote()
                    return
                }
                index += 1
            }
        }
        nextToastSerial += 1
        let next = notice.withId("toast:" + String(nextToastSerial))
        senders[next.id] = senderId.isEmpty ? [] : [senderId]
        insertQueued(next, nowMillis: nowMillis)
        promote()
    }

    private func addSender(_ senderId: String, to noticeId: String) -> [String] {
        var people = senders[noticeId] ?? []
        if !senderId.isEmpty && !people.contains(senderId) { people.append(senderId) }
        senders[noticeId] = people
        return people
    }

    private func insertQueued(_ notice: MeetingNotice, nowMillis: Double) {
        postedAt[notice.id] = nowMillis
        var index = queue.count
        var cursor = 0
        while cursor < queue.count {
            if queue[cursor].priority > notice.priority {
                index = cursor
                break
            }
            cursor += 1
        }
        queue.insert(notice, at: index)
        enforceQueueLimit()
    }

    private func enforceQueueLimit() {
        while queue.count > MeetingNoticePolicy.queueLimit {
            var victim = -1
            var cursor = 0
            while cursor < queue.count {
                if !queue[cursor].isFailure && queue[cursor].severity != NoticeSeverity.progress {
                    victim = cursor
                    break
                }
                cursor += 1
            }
            if victim < 0 { victim = 0 }
            let removed = queue.remove(at: victim)
            postedAt[removed.id] = nil
            senders[removed.id] = nil
            droppedToasts += 1
        }
    }

    private func promote() {
        if toast != nil || isToastLaneSuspended || queue.isEmpty { return }
        toast = queue.remove(at: 0)
    }

    private func removeQueued(_ matches: (MeetingNotice) -> Bool) {
        var kept: [MeetingNotice] = []
        for notice in queue {
            if matches(notice) {
                postedAt[notice.id] = nil
                senders[notice.id] = nil
            } else {
                kept.append(notice)
            }
        }
        queue = kept
    }

    private func dropToasts(_ matches: (MeetingNotice) -> Bool) {
        let before = queue.count
        removeQueued(matches)
        droppedToasts += before - queue.count
        if let current = toast, matches(current) {
            toast = nil
            postedAt[current.id] = nil
            senders[current.id] = nil
            droppedToasts += 1
            promote()
        }
    }
}

enum ChatPreviewBodyKind: String, CaseIterable {
    case text, photo, gif, sticker, clip, voice
}

struct ChatPreviewBody: Equatable {
    let kind: ChatPreviewBodyKind
    let text: String
}

enum ChatPreviewPolicy {

    static let maxDetailCharacters = 160

    static func countsUnread(isOwn: Bool, isHiddenSender: Bool, isEmptyAssistantStart: Bool, isChatCurrent: Bool,
                             isAttendee: Bool) -> Bool {
        if isOwn || isHiddenSender || isEmptyAssistantStart || isAttendee { return false }
        return !isChatCurrent
    }

    static func postsPreview(isOwn: Bool, isHiddenSender: Bool, isEmptyAssistantStart: Bool, isAttendee: Bool) -> Bool {
        !isOwn && !isHiddenSender && !isEmptyAssistantStart && !isAttendee
    }

    static func body(message: ChatMessage) -> ChatPreviewBody {
        if message.userId == ConclaveAssistantChatIdentity.userId {
            return ChatPreviewBody(kind: ChatPreviewBodyKind.text, text: firstSentence(message.content))
        }
        if let image = message.image {
            let caption = message.content.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            let isFileName = caption.isEmpty || caption == image.fileName || caption == image.url
            return ChatPreviewBody(kind: ChatPreviewBodyKind.photo, text: isFileName ? "" : leadingLine(caption))
        }
        if let gif = message.gif {
            var title = gif.title.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            if title.isEmpty {
                let content = message.content.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
                if content != gif.url { title = content }
            }
            return ChatPreviewBody(kind: gifKind(gif.kind), text: leadingLine(title))
        }
        if message.isTts {
            return ChatPreviewBody(kind: ChatPreviewBodyKind.voice,
                                   text: leadingLine(VoiceMessageText.spokenText(normalizedContent: message.content)))
        }
        if let action = ChatMessageContentPolicy.fullActionText(from: message.content) {
            return ChatPreviewBody(kind: ChatPreviewBodyKind.text, text: leadingLine(message.displayName + " " + action))
        }
        return ChatPreviewBody(kind: ChatPreviewBodyKind.text, text: leadingLine(message.content))
    }

    static func event(message: ChatMessage, canonicalSenderId: String) -> StageEvent {
        let preview = body(message: message)
        let isAssistant = message.userId == ConclaveAssistantChatIdentity.userId
        return StageEvent.make(kind: StageEventKind.chatPreview,
                               userId: isAssistant ? ConclaveAssistantChatIdentity.userId : canonicalSenderId,
                               name: message.displayName, serverText: preview.kind.rawValue, messageId: message.id,
                               detail: preview.text, isPrivate: message.isDirect)
    }

    static func gifKind(_ raw: String?) -> ChatPreviewBodyKind {
        if raw == ChatGifKind.sticker.rawValue { return ChatPreviewBodyKind.sticker }
        if raw == ChatGifKind.clip.rawValue { return ChatPreviewBodyKind.clip }
        return ChatPreviewBodyKind.gif
    }

    static func leadingLine(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        var line = ""
        var count = 0
        for character in trimmed {
            if character.isNewline { break }
            line += String(character)
            count += 1
            if count >= maxDetailCharacters { break }
        }
        return line.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
    }

    static func firstSentence(_ text: String) -> String {
        let line = leadingLine(text)
        var result = ""
        var endsSentence = false
        for character in line {
            if endsSentence && character.isWhitespace { break }
            result += String(character)
            endsSentence = character == "." || character == "!" || character == "?"
        }
        return result.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
    }

    static func senderKey(userId: String, name: String) -> String {
        if !userId.isEmpty { return userId }
        if name.isEmpty { return "" }
        return "name:" + name
    }

    static func isChatPreview(_ notice: MeetingNotice?) -> Bool {
        notice?.kind == NoticeKind.chatPreview
    }

    static func bodyKind(_ notice: MeetingNotice) -> ChatPreviewBodyKind {
        ChatPreviewBodyKind(rawValue: notice.serverText) ?? ChatPreviewBodyKind.text
    }

    static func isAssistant(_ notice: MeetingNotice) -> Bool {
        notice.userId == ConclaveAssistantChatIdentity.userId
    }

    static func othersCount(_ notice: MeetingNotice) -> Int {
        max(0, notice.senderCount - 1)
    }

    static func showsCountLine(_ notice: MeetingNotice) -> Bool {
        notice.senderCount <= 1 && notice.count > 1
    }

    static func displayMillis(isScreenReaderRunning: Bool) -> Double {
        isScreenReaderRunning ? 0.0 : SystemAccessibilityDefaults.toastMillis
    }

    static func readout(_ notice: MeetingNotice?) -> String {
        guard let shown = notice, shown.kind == NoticeKind.chatPreview else { return "none" }
        return "count=" + String(shown.count) + " senders=" + String(shown.senderCount) + " name=" + shown.name
            + " private=" + (shown.isPrivate ? "1" : "0") + " body=" + bodyKind(shown).rawValue + " message=" + shown.messageId
    }
}
