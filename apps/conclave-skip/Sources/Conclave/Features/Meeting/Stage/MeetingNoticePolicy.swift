import Foundation

// S20 10 (STG-5; SL10, SR5, SC5, SC18; RECONCILE R1, R3, R27; F00 C12, C13): the single in-call notice catalog. The
// banner lane shows the highest active banner of the 17-row table (one at a time; a dismissed banner returns only when
// its condition re-arms); the toast lane shows one event toast at a time from a queue of 3 with same-kind coalescing
// within 4 s. The presenter owns order, coalescing, queueing, banner expiry, masking, quality dismissal and event
// suppression; it never expires a toast (the platform host times toasts and calls `dismissNotice(id:)`). Shared
// (transpiled) Swift under the S1C 3.6 rules: String raw-value enums, scalar structs, arrays of structs, no associated
// values, no tuples, no protocols, no platform branches (the platform arrives as a value).

enum NoticeLane: String, CaseIterable, Equatable {
    case banner, toast
}

/// The visual kind of a notice (F00 C12 e, C13): progress draws the system spinner.
enum NoticeSeverity: String, CaseIterable, Equatable {
    case info, success, warning, error, progress
}

/// One action on a notice. `id` is one of the ids below (S20 10 f; RECONCILE R27); `isEnabled` keeps Retry Now
/// visible but disabled while a recovery attempt is in flight (SR5).
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
    /// Android notifications banner: "Not now" dismisses it for the session (S70 2).
    static let notNow = "notNow"
    /// The host notice "More" and "Less" expand in place; the view handles them without a presenter call.
    static let expand = "expand"

    static func make(_ id: String, isEnabled: Bool = true) -> NoticeAction {
        NoticeAction(id: id, isEnabled: isEnabled)
    }
}

/// How a new notice is announced (S20 10 c, d): the host knock and offline announce assertively once.
enum NoticeAnnouncement {
    static let polite = "polite"
    static let assertiveOnce = "assertiveOnce"
    static let none = "none"
}

/// The platform the policy decides for (captive portal and notifications priming are Android only).
enum NoticePlatform {
    static let ios = "ios"
    static let android = "android"
}

/// Notice kinds: the 17 banner kinds in table order, then the toast kinds (S20 10 f, SR5, S30 CC7, S40 R40-4, S60 R6-5,
/// S70 R70-1). The views resolve copy per platform from the kind.
enum NoticeKind {
    // Banners (priority 1 to 17).
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
    /// `detail` is "camera" or "microphone".
    static let permission = "permission"
    static let notificationsOff = "notificationsOff"

    // Toasts from events (SC18).
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
    /// `detail` is the failed action: "hand", "microphone", "camera", "screenShare" or another raw kind.
    static let actionFailed = "actionFailed"
    /// `detail` is "reaction" or "hand".
    static let rateLimited = "rateLimited"
    static let voteOpened = "voteOpened"
    static let resumedMuted = "resumedMuted"
    static let qualityLowered = "qualityLowered"
    static let chatPreview = "chatPreview"

    // Toasts through `postLocal` (S30 CC7, S50 PL14).
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

/// What the core posts through `StagePresenter.post(_:)` (SC18). `routeChanged` is SYS-2's `AudioRouteEvent` kind.
enum StageEventKind {
    static let userJoined = "userJoined"
    static let userLeft = "userLeft"
    /// A remote hand went up; `userId` and `name` name the person.
    static let handRaised = "handRaised"
    static let hostMutedYou = "hostMutedYou"
    static let hostCameraOff = "hostCameraOff"
    static let hostLoweredHand = "hostLoweredHand"
    static let hostStoppedShare = "hostStoppedShare"
    static let becameHost = "becameHost"
    static let lostHost = "lostHost"
    static let routeChanged = "routeChanged"
    /// `detail` "reaction" or "hand".
    static let rateLimited = "rateLimited"
    /// A typed failure of an action started on the stage or the bar; `detail` is the action, `serverText` clean text.
    static let actionFailed = "actionFailed"
    /// S40 R40-4: `userId`, `name`, `messageId`, `detail` (preview text), `isPrivate`.
    static let chatPreview = "chatPreview"
    /// S60 R6-5: `name` opened a game vote.
    static let voteOpened = "voteOpened"
    static let resumedMuted = "resumedMuted"
    static let qualityLowered = "qualityLowered"
    /// The admin notice (`admin:notice`): `serverText` the message, `userId` and `name` the sender, `detail` the level.
    static let hostNotice = "hostNotice"
}

/// The banner and toast notice (F00 A9 made concrete, S20 0.5). Toasts carry `expiresAtMillis` 0: the platform host
/// times them (SR5).
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

    /// A coalesced copy: `count` people (joins, hands) or messages (chat previews), the newest preview fields.
    func coalesced(count nextCount: Int, senderCount nextSenders: Int, messageId nextMessage: String, detail nextDetail: String,
                   isPrivate nextPrivate: Bool) -> MeetingNotice {
        MeetingNotice(id: id, kind: kind, lane: lane, priority: priority, severity: severity, userId: userId, name: name,
                      count: nextCount, total: total, serverText: serverText, actions: actions, isDismissible: isDismissible,
                      messageId: nextMessage, detail: nextDetail, isPrivate: nextPrivate, senderCount: nextSenders,
                      expiresAtMillis: expiresAtMillis, announcement: announcement)
    }

    /// CHT-8 (S40 8 f): a chat preview updated in place (while it shows) or coalesced in the queue. The message and
    /// sender counts grow, and the newest message supplies the sender, the body kind, the text and the private tag, so
    /// the title, the avatar and the accessibility label always describe the body that shows. Id, actions and
    /// priority stay, so the host keeps the same toast.
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

/// A notice action the core performs (the S1 `onCommand` pattern): admit, admit all, audio-only on and off, Retry Now,
/// system settings, share again, resume, End Now, allow notifications, the host notice dismissal, and Retry for the
/// failures whose owner is the core (route, lock).
struct NoticeCommand: Equatable {
    let actionId: String
    let noticeKind: String
    let userId: String
    let detail: String

    /// The core's `dismissAdminNotice()` (the native stage keeps its own copy of the host notice, SC5).
    static let dismissHostNotice = "dismissHostNotice"
}

/// The notice state inputs (S20 0.5 "Notices (state)" rows plus S60, S70 and S30 rows), built by the view model's
/// `makeStageNoticeInputs()` and pushed through `StagePresenter.applyNotices(_:)` on the stage refresh path (SC5).
/// Every id is canonical.
struct StageNoticeInputs: Equatable {
    let callSession: Int
    let isAttendee: Bool
    let isHost: Bool
    let localUserId: String
    /// Present people, you included (Q4 thresholds).
    let participantCount: Int
    /// `MeetingState.hasInitialPresenceSnapshot`: joins before it are the initial snapshot.
    let hasInitialPresenceSnapshot: Bool
    let isOffline: Bool
    /// S70 SY22, Android only.
    let isCaptivePortal: Bool
    let isRecovering: Bool
    let isResumingFromBackground: Bool
    /// SC16: rejoin retries so far, the native limit and whether an attempt is in flight.
    let reconnectAttempt: Int
    let reconnectAttemptLimit: Int
    let isRecoveryAttemptInFlight: Bool
    let hasServerRestartNotice: Bool
    let serverRestartText: String
    /// S30 CC8: `LeaveSnapshot.endPhase == .postingRecap`.
    let isRecapPosting: Bool
    /// S70 `CallPresence`: phase `onHold`, and an audio interruption by another call or app.
    let isOnHold: Bool
    let isAudioPaused: Bool
    /// Waiting people in display order; the first name serves the one-person knock.
    let pendingUserIds: [String]
    let pendingFirstName: String
    let isScreenSharing: Bool
    /// S70 10: "", "restoreFailed" or "notSending"; the serial re-arms a dismissed share banner.
    let shareIssue: String
    let shareIssueSerial: Int
    let liveNotes: LiveNotesState
    /// TRN-1 `CatchUpPolicy.minutes`; 0 means no offer.
    let catchUpMinutes: Int
    let isAudioOnly: Bool
    /// Stabilized to at most one change per 2 s (INM H3.3).
    let connectionQuality: ConnectionQuality
    let cameraPermissionRevoked: Bool
    let microphonePermissionRevoked: Bool
    /// S70 2: the first live phase without POST_NOTIFICATIONS on Android 13+, after the entry transition.
    let showsNotificationsPrime: Bool
    /// S60 C6-24 (host only, default off): the notice sound switches.
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

    /// Before any input arrives: no notice, presence not yet snapshotted.
    static let empty = StageNoticeInputs.make(hasInitialPresenceSnapshot: false)
}

/// One-shot announcements the notice lanes add to the stage channel (S70 R70-1); the views resolve the text.
enum StageNoticeAnnouncementKind {
    static let reconnecting = "reconnecting"
    static let reconnected = "reconnected"
}

/// Where the lanes sit on the full-bleed stage (points on iOS, dp on Android), published by the presenter so each
/// lane reads one cold value: the banner under the top chrome slot (and under the status chips when they show), the
/// toast lane above the bar slot, narrowed to clear a floating self view in a bottom corner (S20 10 b, c, d). The
/// values come from the reserved viewport insets, which never change when chrome hides, so the lanes never move
/// with chrome (S20 10 b "stable lanes").
struct NoticeLaneGeometry: Equatable {
    let bannerTop: Double
    let chipsVisible: Bool
    let toastBottom: Double
    let toastLeading: Double
    let toastTrailing: Double

    static let zero = NoticeLaneGeometry(bannerTop: 0, chipsVisible: false, toastBottom: 0, toastLeading: 0, toastTrailing: 0)
}

enum NoticeLaneGeometryPolicy {
    /// The lane margin from the stage edges.
    static let edgeMargin = 12.0
    /// A self view whose bottom sits within this distance of the bar slot shares the toast row.
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

/// The pure rules (SL10): the banner table, toast construction, coalescing, thresholds and suppression constants.
enum MeetingNoticePolicy {
    /// Same-kind toasts within this window coalesce ("and 2 others", F00 C13).
    static let coalesceWindowMillis = 4_000.0
    /// The toast queue holds at most this many waiting toasts (F00 C13 c, RECONCILE R3).
    static let queueLimit = 3
    /// S20 Q4: grouped join and leave toasts up to 12 people; above it only hosts see joins and nobody sees leaves.
    static let largeRoomThreshold = 12
    /// S20 10 f row 11: the host notice shows for 60 s of visible time; the clock pauses while a higher banner masks it.
    static let hostNoticeMillis = 60_000.0
    /// After a recovery ends, the rejoin's roster resync may still post joins and leaves: none for this long (SC18).
    static let recoveryGraceMillis = 3_000.0
    /// Host notices longer than this show "More" to expand in place (up to 2,000 characters).
    static let longNoticeCharacters = 180
    static let maxNoticeCharacters = 2_000
    static let shareIssueRestoreFailed = "restoreFailed"
    static let shareIssueNotSending = "notSending"
    static let permissionCamera = "camera"
    static let permissionMicrophone = "microphone"

    /// Every active banner in table order, before dismissals; the lane shows the first one that is not dismissed.
    /// `hostNotice` is the latched host notice (or nil); `liveNotesEpisode` re-arms the live notes banner per session;
    /// `currentPanel` is the current panel's raw value ("" for none). `knockPending` (PPL-3) is true while an admission
    /// is in flight in the People presenter: the knock banner's Admit or Admit All stays visible but disabled, so a
    /// second tap cannot race the first.
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
            // Attendees see only offline, reconnecting and server restart (S20 10 f "Other states").
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
            // S50 4 i (PPL-3): while Participants is current, People announces a new knock once politely, so the banner
            // stays silent instead of reading the same news assertively a second time.
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

    /// The latched host notice as a banner (row 11): level maps to severity; long text expands in place.
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

    /// The toast an event turns into, before suppression (the center applies the presence, recovery, room size,
    /// attendee and open-Chat rules). Nil for events that are not toasts.
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
            // CHT-8: `serverText` carries the `ChatPreviewBodyKind` raw value ("" reads as text), `detail` the payload.
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

    /// Kinds that merge within the coalescing window: grouped joins and hands, coalesced chat previews.
    static func coalesces(_ kind: String) -> Bool {
        kind == NoticeKind.joined || kind == NoticeKind.handRaised || kind == NoticeKind.chatPreview
    }

    /// Joins and leaves (S20 Q4): grouped up to 12 people; above 12 only hosts see joins and nobody sees leaves.
    static func showsPresenceToast(kind: String, participantCount: Int, isHost: Bool) -> Bool {
        if participantCount <= largeRoomThreshold { return true }
        if kind == NoticeKind.joined { return isHost }
        return false
    }

    /// Attendees see no toasts except their own hand results (S20 10 f "Other states").
    static func attendeeSeesToast(_ notice: MeetingNotice) -> Bool {
        if notice.kind == NoticeKind.hostLoweredHand { return true }
        if notice.kind == NoticeKind.actionFailed || notice.kind == NoticeKind.rateLimited { return notice.detail == "hand" }
        return false
    }

    /// Quality dismissal (SC5, fixing the Android legacy reset bug): a dismissed very poor connection banner stays
    /// dismissed while the connection is poor or very poor and re-arms once it recovers to fair or good.
    static func qualityDismissalResets(_ quality: ConnectionQuality) -> Bool {
        quality == ConnectionQuality.good || quality == ConnectionQuality.fair
    }

    /// Feedback tokens the stage publishes for events (S20 0.5 token table): moderation targeting you and role changes.
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

    /// RECONCILE R3: the toast lane is suspended under a compact-width iOS sheet at any detent and under an Android full
    /// overlay; the regular-width inspector and the Android side pane keep it.
    static func suspendsToastLane(style: PanelHostStyle) -> Bool {
        style == PanelHostStyle.sheet || style == PanelHostStyle.overlay || style == PanelHostStyle.bottomSheet
    }
}

/// The stateful half of SL10, owned by `StagePresenter`: the current banner and toast, the toast queue, dismissals,
/// the latched host notice and its masked expiry clock, the knock baseline for notice sounds and the recovery grace.
/// Not observable: the presenter republishes `banner`, `toast` and `queue.count` after every call (equality guarded).
final class MeetingNoticeCenter {
    private(set) var platform: String
    private(set) var banner: MeetingNotice? = nil
    private(set) var toast: MeetingNotice? = nil
    private(set) var queue: [MeetingNotice] = []
    private(set) var isToastLaneSuspended = false
    private(set) var inputs = StageNoticeInputs.empty
    /// Diagnostics: toasts dropped by suppression, the queue cap or an open Chat.
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
    /// PPL-3: an admission is in flight in the People presenter (the knock banner's Admit stays disabled meanwhile).
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

    /// The native call root names its platform once (captive portal and notifications priming are Android only).
    func setPlatform(_ next: String, nowMillis: Double) {
        if next == platform { return }
        platform = next
        recomputeBanner(nowMillis: nowMillis)
    }

    var bannerExpiresAtMillis: Double { banner?.expiresAtMillis ?? 0.0 }

    /// Remaining visible time of the latched host notice (masking pauses it); 0 without one.
    var hostNoticeRemaining: Double { hasHostNotice ? hostNoticeRemainingMillis : 0.0 }

    // MARK: State

    /// New state inputs. Returns the notice sound kinds to request (a new knock).
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

    /// The current panel's raw value ("" for none): an open Chat drops chat previews; an open Transcript hides the
    /// catch-up offer.
    func setCurrentPanel(_ raw: String, nowMillis: Double) {
        if raw == currentPanel { return }
        currentPanel = raw
        if raw == MeetingPanel.chat.rawValue {
            dropToasts { notice in notice.kind == NoticeKind.chatPreview }
        }
        recomputeBanner(nowMillis: nowMillis)
    }

    /// PPL-3: the People presenter reports whether an admission (Admit, Deny, Admit All, Deny All) is in flight; the
    /// knock banner's Admit or Admit All is disabled meanwhile.
    func setKnockActionsPending(_ pending: Bool, nowMillis: Double) {
        if pending == knockActionsPending { return }
        knockActionsPending = pending
        recomputeBanner(nowMillis: nowMillis)
    }

    /// RECONCILE R3: while suspended no toast shows; the interrupted toast returns first when the lane comes back. Chat
    /// previews are dropped instead (S40 8 f: the badge is the lasting signal), shown or waiting.
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

    // MARK: Events

    /// One core event (SC18). Returns the notice sound kinds to request (a new remote hand for hosts). `showsChatPreviews`
    /// is the S60 C6-22 preference read when a chat preview arrives (off: no preview, the badge still counts, S40 Q8).
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
        // CHT-8 (S40 8 f, RECONCILE R3): previews are off, or a compact sheet or an Android overlay suspends the lane.
        if candidate.kind == NoticeKind.chatPreview && (!showsChatPreviews || isToastLaneSuspended) {
            droppedToasts += 1
            return []
        }
        // Your own messages never preview (CH12); the core already filters them, this keeps the stage honest.
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

    /// Presenter-originated toasts (S30 CC7, S50 PL14). A caller id is kept so the caller can clear it later; an
    /// `endFailed` replaces a showing `endingForEveryone` progress toast.
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

    /// The host's dismissal when a toast leaves (timed out, acted on, swiped) or a person's banner Dismiss. A progress
    /// toast stays until its owner clears it (`clear(id:)`).
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

    /// The owner of a local toast removes it, progress included.
    func clear(id: String) {
        if let current = toast, current.id == id {
            toast = nil
            promote()
            return
        }
        removeQueued { notice in notice.id == id }
    }

    /// CHT-8 (S40 8 f): `/clear` drops every chat preview, shown or waiting; other toasts stay.
    func clearChatPreviews() {
        dropToasts { notice in notice.kind == NoticeKind.chatPreview }
    }

    /// CHT-8 (S40 CH21): hiding a sender drops the previews that carry one of their messages (a coalesced preview
    /// included). `userId` is the canonical stage id the previews were posted with.
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

    /// The people a shown or waiting chat preview counts (diagnostics and tests); empty for other notices.
    func previewSenders(noticeId: String) -> [String] {
        senders[noticeId] ?? []
    }

    private func previewIncludes(_ notice: MeetingNotice, userId: String) -> Bool {
        if notice.userId == userId { return true }
        return (senders[notice.id] ?? []).contains(userId)
    }

    /// Ends the host notice once its visible time ran out. True when the banner changed.
    func expireIfDue(nowMillis: Double) -> Bool {
        guard let shown = banner, shown.kind == NoticeKind.hostNotice, shown.expiresAtMillis > 0 else { return false }
        if nowMillis < shown.expiresAtMillis { return false }
        clearHostNotice()
        recomputeBanner(nowMillis: nowMillis)
        return true
    }

    /// A new call session or a leave: nothing carries over.
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

    // MARK: Banner

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
            // Masked (or gone): the visible clock pauses with what is left (SC5).
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
            // The new notice replaces the shown one; account the old clock first.
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

    // MARK: Toast queue

    private func enqueue(_ notice: MeetingNotice, senderId: String, nowMillis: Double) {
        // CHT-8 (S40 8 f): a chat preview arriving while another one shows updates the shown toast in place (same id,
        // so the host keeps it and restarts its display time): "3 new messages" from one sender, or "and 2 others".
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

    /// Records one more person behind a coalesced notice (joins and hands by user id; chat previews by
    /// `ChatPreviewPolicy.senderKey`) and returns everyone counted so far.
    private func addSender(_ senderId: String, to noticeId: String) -> [String] {
        var people = senders[noticeId] ?? []
        if !senderId.isEmpty && !people.contains(senderId) { people.append(senderId) }
        senders[noticeId] = people
        return people
    }

    /// Lower priority numbers wait in front (failures first); equal priorities keep arrival order.
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

    /// Past the limit the oldest waiting event goes first; failures go only when nothing else can.
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

// MARK: - Chat previews and unread (CHT-8: S40 8, 0.8 CH12, R40-4; S60 C6-22; RECONCILE R1, R3)

/// What a chat preview's body says (S40 8 f, 8 g). Shared Swift has no String Catalog access (owner Q14), so the core
/// sends the kind in `StageEvent.serverText` (carried into `MeetingNotice.serverText`) and the payload (a caption, a
/// title or the text) in `detail`; the toast views resolve "Photo: %@", "GIF: %@" and the rest per platform (F00 11).
/// `text` covers plain messages, `/me` actions (the payload already reads "Avery Lee waves") and assistant answers (the
/// first sentence). An empty `serverText` reads as `text`.
enum ChatPreviewBodyKind: String, CaseIterable {
    case text, photo, gif, sticker, clip, voice
}

/// One preview body: the kind the views format and its payload ("" for a photo without a caption).
struct ChatPreviewBody: Equatable {
    let kind: ChatPreviewBodyKind
    let text: String
}

/// The pure CHT-8 rules: which arrivals count toward the Chat badge and post a stage preview (CH12), the preview body
/// for one message (8 f), the `StageEvent` the core posts (R40-4) and the small view decisions both toast variants
/// share (title grouping, count line, display time). The notice center applies the stage rules (Chat current, lane
/// suspended, previews off, attendee) when the event arrives.
enum ChatPreviewPolicy {
    /// The longest payload a preview carries; the toast shows at most two lines of it.
    static let maxDetailCharacters = 160

    /// CH12: +1 for a remote message, a private message to you, a voice message and an assistant answer once its
    /// content arrives, while Chat is not the current panel. Never for your own messages, a hidden sender (CH21), the
    /// empty first packet of an assistant answer or a webinar attendee (who has no Chat control). History, system rows
    /// and reaction changes never reach this rule (they are not new messages).
    static func countsUnread(isOwn: Bool, isHiddenSender: Bool, isEmptyAssistantStart: Bool, isChatCurrent: Bool,
                             isAttendee: Bool) -> Bool {
        if isOwn || isHiddenSender || isEmptyAssistantStart || isAttendee { return false }
        return !isChatCurrent
    }

    /// CH12: which arrivals post a `chatPreview` event. The notice center still drops it while Chat is current, while
    /// the toast lane is suspended and while "Show Chat Previews" is off.
    static func postsPreview(isOwn: Bool, isHiddenSender: Bool, isEmptyAssistantStart: Bool, isAttendee: Bool) -> Bool {
        !isOwn && !isHiddenSender && !isEmptyAssistantStart && !isAttendee
    }

    /// S40 8 f: the body for one received message. A photo never shows its file name; a GIF, sticker or clip shows its
    /// title; a voice message its spoken text; an action reads "Avery Lee waves"; the assistant its first sentence;
    /// everything else the first line of the text.
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

    /// R40-4: the event the core posts through `stage.post(_:)` from its chat message handler. The assistant keeps its
    /// own identity (it is not a participant, so it has no canonical stage id); everyone else uses the canonical id.
    static func event(message: ChatMessage, canonicalSenderId: String) -> StageEvent {
        let preview = body(message: message)
        let isAssistant = message.userId == ConclaveAssistantChatIdentity.userId
        return StageEvent.make(kind: StageEventKind.chatPreview,
                               userId: isAssistant ? ConclaveAssistantChatIdentity.userId : canonicalSenderId,
                               name: message.displayName, serverText: preview.kind.rawValue, messageId: message.id,
                               detail: preview.text, isPrivate: message.isDirect)
    }

    /// The GIF picker's kinds (`ChatGifKind`); anything else is a GIF.
    static func gifKind(_ raw: String?) -> ChatPreviewBodyKind {
        if raw == ChatGifKind.sticker.rawValue { return ChatPreviewBodyKind.sticker }
        if raw == ChatGifKind.clip.rawValue { return ChatPreviewBodyKind.clip }
        return ChatPreviewBodyKind.gif
    }

    /// The first line of `text`, trimmed and bounded to `maxDetailCharacters`.
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

    /// S40 8 f "Conclave and the first sentence": the first line up to the first sentence end followed by a space.
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

    /// Who a coalesced preview counts: the canonical user id, or the name when the core had no id (people, not
    /// messages, F00 `ds_name_and_others`).
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

    /// The assistant's previews show its mark (the avatar of its identity until the `assistant` glyph lands, R40-5).
    static func isAssistant(_ notice: MeetingNotice) -> Bool {
        notice.userId == ConclaveAssistantChatIdentity.userId
    }

    /// Several senders: the title is "Avery Lee and 2 others" (people other than the newest sender).
    static func othersCount(_ notice: MeetingNotice) -> Int {
        max(0, notice.senderCount - 1)
    }

    /// One sender with more than one message: the count line ("3 new messages") under the newest text.
    static func showsCountLine(_ notice: MeetingNotice) -> Bool {
        notice.senderCount <= 1 && notice.count > 1
    }

    /// The host's display time (S40 8 c, S20 10 f): 4 s, held under VoiceOver (0 means held until dismissed or
    /// replaced). Android stretches the 4 s through the system's recommended timeout; an in-place update restarts it.
    static func displayMillis(isScreenReaderRunning: Bool) -> Double {
        isScreenReaderRunning ? 0.0 : SystemAccessibilityDefaults.toastMillis
    }

    /// The `chat.preview` readout: the shown preview's counts and fields, or "none".
    static func readout(_ notice: MeetingNotice?) -> String {
        guard let shown = notice, shown.kind == NoticeKind.chatPreview else { return "none" }
        return "count=" + String(shown.count) + " senders=" + String(shown.senderCount) + " name=" + shown.name
            + " private=" + (shown.isPrivate ? "1" : "0") + " body=" + bodyKind(shown).rawValue + " message=" + shown.messageId
    }
}
