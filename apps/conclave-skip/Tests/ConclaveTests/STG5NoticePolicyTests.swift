#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// STG-5 (OUT/PLAN-screens.md section 5; S20 10 l, SC5, SC18, SC24; RECONCILE R1, R3, R27, R45): the 17-row banner
/// table, toast queue, coalescing, masking, quality dismissal, event suppression, the Q4 thresholds, compact sheet
/// suspension, the notice sounds through a recording output, the presenter routing and the lane sources. The Kotlin
/// twin with the same fixtures is T/Skip/STG5NoticeBridgeTests.kt.
@MainActor
struct STG5NoticePolicyTests {
    final class Clock {
        var millis = 1_000_000.0
    }

    final class Recorder {
        var values: [String] = []
    }

    static let longSleep: (Double) async -> Void = { _ in try? await Task.sleep(nanoseconds: 60_000_000_000) }

    private func host(pending: [String] = [], count: Int = 4, isOffline: Bool = false, isCaptivePortal: Bool = false,
                      isOnHold: Bool = false, isAudioOnly: Bool = false, quality: ConnectionQuality = .good,
                      isRecovering: Bool = false, attempt: Int = 0, inFlight: Bool = false, snapshot: Bool = true,
                      isHost: Bool = true, isAttendee: Bool = false, catchUp: Int = 0, liveNotes: LiveNotesState = .off,
                      knockSound: Bool = false, handSound: Bool = false) -> StageNoticeInputs {
        StageNoticeInputs.make(callSession: 1, isAttendee: isAttendee, isHost: isHost, localUserId: "you", participantCount: count,
                               hasInitialPresenceSnapshot: snapshot, isOffline: isOffline, isCaptivePortal: isCaptivePortal,
                               isRecovering: isRecovering, reconnectAttempt: attempt, reconnectAttemptLimit: 5,
                               isRecoveryAttemptInFlight: inFlight, isOnHold: isOnHold, pendingUserIds: pending,
                               pendingFirstName: pending.isEmpty ? "" : "Sam", liveNotes: liveNotes, catchUpMinutes: catchUp,
                               isAudioOnly: isAudioOnly, connectionQuality: quality, knockSoundOn: knockSound,
                               handSoundOn: handSound)
    }

    private func join(_ id: String, _ name: String) -> StageEvent {
        StageEvent.make(kind: StageEventKind.userJoined, userId: id, name: name)
    }

    private func presenter(_ clock: Clock) -> StagePresenter {
        let stage = StagePresenter(shell: MeetingShellPresenter())
        stage.now = { clock.millis }
        stage.sleep = STG5NoticePolicyTests.longSleep
        stage.captions.sleep = STG5NoticePolicyTests.longSleep
        stage.sounds.now = { clock.millis }
        stage.setViewport(StagePoliciesTests.iphoneSE)
        stage.apply(StageFixtureScript.base(count: 4))
        return stage
    }

    // MARK: Banner table (S20 10 f)

    @Test func theBannerTableHasSeventeenRowsInPriorityOrder() {
        let notice = MeetingNoticePolicy.hostNoticeBanner(serial: 1, text: "Hi", level: "info", senderId: "r1", senderName: "Avery",
                                                          expiresAtMillis: 0)
        let first = StageNoticeInputs.make(callSession: 1, isHost: true, localUserId: "you", isOffline: true, isCaptivePortal: true,
                                           isRecovering: true, reconnectAttempt: 2, hasServerRestartNotice: true,
                                           isRecapPosting: true, isOnHold: true, pendingUserIds: ["w1"], pendingFirstName: "Sam",
                                           isScreenSharing: true, shareIssue: MeetingNoticePolicy.shareIssueRestoreFailed,
                                           shareIssueSerial: 1, liveNotes: .live, catchUpMinutes: 3, isAudioOnly: true,
                                           connectionQuality: .emergency, cameraPermissionRevoked: true,
                                           microphonePermissionRevoked: true, showsNotificationsPrime: true)
        let android = MeetingNoticePolicy.bannerCandidates(first, hostNotice: notice, liveNotesEpisode: 1, currentPanel: "",
                                                           platform: NoticePlatform.android)
        #expect(android.map(\.kind) == [NoticeKind.captivePortal, NoticeKind.reconnecting, NoticeKind.serverRestart,
                                         NoticeKind.recapPosting, NoticeKind.onHold, NoticeKind.knock, NoticeKind.sharing,
                                         NoticeKind.shareRestoreFailed, NoticeKind.hostNotice, NoticeKind.liveNotesStarted,
                                         NoticeKind.catchUp, NoticeKind.audioOnly, NoticeKind.permission, NoticeKind.permission,
                                         NoticeKind.notificationsOff])
        let second = StageNoticeInputs.make(callSession: 1, isHost: true, localUserId: "you", isOffline: true, isAudioPaused: true,
                                            shareIssue: MeetingNoticePolicy.shareIssueNotSending, shareIssueSerial: 2,
                                            connectionQuality: .emergency)
        let ios = MeetingNoticePolicy.bannerCandidates(second, hostNotice: nil, liveNotesEpisode: 0, currentPanel: "",
                                                       platform: NoticePlatform.ios)
        #expect(ios.map(\.kind) == [NoticeKind.offline, NoticeKind.audioPaused, NoticeKind.shareNotSending,
                                     NoticeKind.veryPoorConnection])
        var priorities = Set<Int>()
        for candidate in android + ios {
            priorities.insert(candidate.priority)
            #expect(candidate.lane == .banner && candidate.expiresAtMillis == 0)
        }
        #expect(priorities == Set(1...17))
        for list in [android, ios] {
            #expect(list.map(\.priority) == list.map(\.priority).sorted())
        }
        // iOS never shows the Android-only rows.
        let iosAll = MeetingNoticePolicy.bannerCandidates(first, hostNotice: notice, liveNotesEpisode: 1, currentPanel: "",
                                                          platform: NoticePlatform.ios)
        #expect(iosAll.first?.kind == NoticeKind.offline)
        #expect(!iosAll.map(\.kind).contains(NoticeKind.captivePortal) && !iosAll.map(\.kind).contains(NoticeKind.notificationsOff))
        #expect(NoticeKind.bannerKinds.count == 18)
    }

    @Test func offlineMasksTheKnockAndOnHoldOutranksIt() {
        let center = MeetingNoticeCenter()
        _ = center.applyState(host(pending: ["w1"], isOffline: true), nowMillis: 0)
        #expect(center.banner?.kind == NoticeKind.offline)
        #expect(center.banner?.announcement == NoticeAnnouncement.assertiveOnce)
        _ = center.applyState(host(pending: ["w1"], isOnHold: true), nowMillis: 1)
        #expect(center.banner?.kind == NoticeKind.onHold && center.banner?.actions.map(\.id) == [NoticeAction.resume])
        _ = center.applyState(host(pending: ["w1"]), nowMillis: 2)
        #expect(center.banner?.kind == NoticeKind.knock && center.banner?.actions.map(\.id) == [NoticeAction.view, NoticeAction.admit])
        #expect(center.banner?.name == "Sam" && center.banner?.userId == "w1")
    }

    @Test func captivePortalReplacesOfflineOnAndroidOnly() {
        let ios = MeetingNoticeCenter(platform: NoticePlatform.ios)
        _ = ios.applyState(host(isOffline: true, isCaptivePortal: true), nowMillis: 0)
        #expect(ios.banner?.kind == NoticeKind.offline)
        let android = MeetingNoticeCenter(platform: NoticePlatform.android)
        _ = android.applyState(host(isOffline: true, isCaptivePortal: true), nowMillis: 0)
        #expect(android.banner?.kind == NoticeKind.captivePortal && android.banner?.actions.map(\.id) == [NoticeAction.openSettings])
        // The call root names its platform once.
        ios.setPlatform(NoticePlatform.android, nowMillis: 1)
        #expect(ios.banner?.kind == NoticeKind.captivePortal)
    }

    @Test func veryPoorConnectionOffersAudioOnlyAndLeavesOnceItIsOn() {
        let center = MeetingNoticeCenter()
        _ = center.applyState(host(quality: .emergency), nowMillis: 0)
        #expect(center.banner?.kind == NoticeKind.veryPoorConnection && center.banner?.actions.map(\.id) == [NoticeAction.useAudioOnly])
        _ = center.applyState(host(isAudioOnly: true, quality: .emergency), nowMillis: 1)
        #expect(center.banner?.kind == NoticeKind.audioOnly && center.banner?.actions.map(\.id) == [NoticeAction.turnOffAudioOnly])
        // Poor is not a banner (Q5, SR5).
        _ = center.applyState(host(quality: .poor), nowMillis: 2)
        #expect(center.banner == nil)
    }

    @Test func qualityDismissalResetsOnlyOnFairOrGood() {
        let center = MeetingNoticeCenter()
        _ = center.applyState(host(quality: .emergency), nowMillis: 0)
        let id = center.banner?.id ?? ""
        center.dismiss(id: id, nowMillis: 1)
        #expect(center.banner == nil)
        _ = center.applyState(host(quality: .poor), nowMillis: 2)
        _ = center.applyState(host(quality: .emergency), nowMillis: 3)
        #expect(center.banner == nil)
        _ = center.applyState(host(quality: .fair), nowMillis: 4)
        _ = center.applyState(host(quality: .emergency), nowMillis: 5)
        #expect(center.banner?.kind == NoticeKind.veryPoorConnection)
        center.dismiss(id: center.banner?.id ?? "", nowMillis: 6)
        _ = center.applyState(host(quality: .good), nowMillis: 7)
        _ = center.applyState(host(quality: .emergency), nowMillis: 8)
        #expect(center.banner?.kind == NoticeKind.veryPoorConnection)
    }

    @Test func aHostNoticeMaskedForSeventySecondsKeepsItsRemainingTime() {
        let center = MeetingNoticeCenter()
        let start = 1_000_000.0
        _ = center.applyState(host(), nowMillis: start)
        _ = center.post(StageEvent.make(kind: StageEventKind.hostNotice, userId: "r1", name: "Avery", serverText: "Five minutes",
                                        detail: "warning"), nowMillis: start)
        #expect(center.banner?.kind == NoticeKind.hostNotice && center.banner?.severity == .warning)
        #expect(center.banner?.expiresAtMillis == start + 60_000)
        // Shown for 20 s, then offline masks it for 70 s.
        _ = center.applyState(host(isOffline: true), nowMillis: start + 20_000)
        #expect(center.banner?.kind == NoticeKind.offline)
        #expect(center.hostNoticeRemaining == 40_000)
        _ = center.applyState(host(), nowMillis: start + 90_000)
        #expect(center.banner?.kind == NoticeKind.hostNotice)
        #expect(center.banner?.expiresAtMillis == start + 130_000)
        #expect(!center.expireIfDue(nowMillis: start + 129_000))
        #expect(center.expireIfDue(nowMillis: start + 130_000))
        #expect(center.banner == nil)
        // Dismiss works too, and a long notice expands in place.
        let long = String(repeating: "Please read this. ", count: 20)
        _ = center.post(StageEvent.make(kind: StageEventKind.hostNotice, serverText: long, detail: "info"), nowMillis: start + 131_000)
        #expect(center.banner?.actions.map(\.id) == [NoticeAction.expand] && center.banner?.isDismissible == true)
        center.dismiss(id: center.banner?.id ?? "", nowMillis: start + 132_000)
        #expect(center.banner == nil)
    }

    @Test func knockTwoAndReconnectingFixturesMatchTheCatalog() {
        let knock = StageFixtureSession(state: .knock2).stage.banner
        #expect(knock?.kind == NoticeKind.knock && knock?.count == 2)
        #expect(knock?.actions.map(\.id) == [NoticeAction.view, NoticeAction.admitAll])
        #expect(knock?.announcement == NoticeAnnouncement.assertiveOnce && knock?.isDismissible == false)
        let attempt = StageFixtureSession(state: .reconnecting2).stage.banner
        #expect(attempt?.kind == NoticeKind.reconnecting && attempt?.count == 2 && attempt?.total == 5)
        #expect(attempt?.actions == [NoticeAction.make(NoticeAction.retryRecovery, isEnabled: true)])
        let inFlight = StageFixtureSession(state: .reconnectingInFlight).stage.banner
        #expect(inFlight?.actions == [NoticeAction.make(NoticeAction.retryRecovery, isEnabled: false)])
        // Before the first rejoin fails there is no attempt line and no Retry Now.
        let center = MeetingNoticeCenter()
        _ = center.applyState(host(isRecovering: true, attempt: 1), nowMillis: 0)
        #expect(center.banner?.count == 0 && center.banner?.actions.isEmpty == true)
        // Within the foreground grace the recovery shows nothing.
        let quiet = StageNoticeInputs.make(callSession: 1, isRecovering: true, isResumingFromBackground: true)
        #expect(MeetingNoticePolicy.bannerCandidates(quiet, hostNotice: nil, liveNotesEpisode: 0, currentPanel: "",
                                                     platform: NoticePlatform.ios).isEmpty)
    }

    @Test func everyNoticeFixtureShowsItsBannerOrToast() {
        let banners: [StageFixtureState: String] = [
            .knock1: NoticeKind.knock, .offline: NoticeKind.offline, .serverRestart: NoticeKind.serverRestart,
            .onHold: NoticeKind.onHold, .audioPaused: NoticeKind.audioPaused, .shareStalled: NoticeKind.shareNotSending,
            .hostNotice: NoticeKind.hostNotice, .hostNoticeLong: NoticeKind.hostNotice, .liveNotes: NoticeKind.liveNotesStarted,
            .catchUp: NoticeKind.liveNotesStarted, .veryPoor: NoticeKind.veryPoorConnection,
            .permissionMicrophone: NoticeKind.permission,
        ]
        for (state, kind) in banners {
            #expect(StageFixtureSession(state: state).stage.banner?.kind == kind, "\(state.rawValue)")
        }
        let toasts: [StageFixtureState: String] = [
            .toastJoins: NoticeKind.joined, .toastHand: NoticeKind.handRaised, .toastFailure: NoticeKind.actionFailed,
            .toastChat: NoticeKind.chatPreview, .toastRoute: NoticeKind.routeChanged,
        ]
        for (state, kind) in toasts {
            let session = StageFixtureSession(state: state)
            #expect(session.stage.toast?.kind == kind, "\(state.rawValue)")
            #expect(session.stage.toast?.expiresAtMillis == 0, "toasts carry no presenter expiry")
            #expect(session.counters.chimes.isEmpty, "the fixture never chimes with the switches off")
        }
        // The fixture joins coalesce: Avery first, then "Ben and 1 other".
        let joins = StageFixtureSession(state: .toastJoins)
        #expect(joins.stage.toast?.name == "Avery Lee" && joins.stage.queuedToasts == 1)
        #expect(joins.stage.notices.queue.first?.count == 2)
    }

    // MARK: Toast lane (S20 10 f toast paragraph, F00 C13)

    @Test func toastsQueueThreeCoalesceWithinFourSecondsAndNeverExpire() throws {
        let center = MeetingNoticeCenter()
        let t = 10_000.0
        _ = center.applyState(host(), nowMillis: t)
        _ = center.post(join("a", "Avery"), nowMillis: t)
        #expect(center.toast?.kind == NoticeKind.joined && center.toast?.count == 1)
        _ = center.post(join("b", "Ben"), nowMillis: t + 1_000)
        _ = center.post(join("c", "Cai"), nowMillis: t + 2_000)
        #expect(center.queue.count == 1 && center.queue[0].name == "Ben" && center.queue[0].count == 2)
        _ = center.post(join("d", "Dev"), nowMillis: t + 6_500)
        #expect(center.queue.count == 2)
        _ = center.post(StageEvent.make(kind: StageEventKind.routeChanged, name: "Speaker"), nowMillis: t + 6_600)
        _ = center.post(StageEvent.make(kind: StageEventKind.actionFailed, detail: "hand"), nowMillis: t + 6_700)
        // Queue max 3: the oldest event left; the failure waits first.
        #expect(center.queue.count == 3)
        try #require(!center.queue.isEmpty)
        #expect(center.queue[0].kind == NoticeKind.actionFailed)
        #expect(!center.queue.map(\.name).contains("Ben"))
        // The presenter never expires a toast: only the host's dismissal moves the lane.
        #expect(center.toast?.name == "Avery")
        center.dismiss(id: center.toast?.id ?? "", nowMillis: t + 600_000)
        #expect(center.toast?.kind == NoticeKind.actionFailed && center.toast?.actions.map(\.id) == [NoticeAction.retry])
        #expect(center.toast?.isFailure == true)
    }

    @Test func anInitialSnapshotOfEightAndARecoveryResyncPostNoJoinToast() {
        let center = MeetingNoticeCenter()
        _ = center.applyState(host(count: 8, snapshot: false), nowMillis: 0)
        for index in 0..<8 {
            _ = center.post(join("p\(index)", "Person \(index)"), nowMillis: Double(index))
        }
        #expect(center.toast == nil && center.queue.isEmpty)
        _ = center.applyState(host(count: 8), nowMillis: 100)
        _ = center.applyState(host(count: 8, isRecovering: true), nowMillis: 200)
        _ = center.post(join("x", "Xan"), nowMillis: 300)
        _ = center.post(StageEvent.make(kind: StageEventKind.userLeft, userId: "y", name: "Yu"), nowMillis: 310)
        _ = center.applyState(host(count: 8), nowMillis: 1_000)
        _ = center.post(join("z", "Zed"), nowMillis: 2_000)
        #expect(center.toast == nil && center.queue.isEmpty)
        _ = center.post(join("z", "Zed"), nowMillis: 1_000 + MeetingNoticePolicy.recoveryGraceMillis + 1)
        #expect(center.toast?.name == "Zed")
    }

    @Test func q4ThresholdsAtTwelveAndThirteen() {
        let twelve = MeetingNoticeCenter()
        _ = twelve.applyState(host(count: 12, isHost: false), nowMillis: 0)
        _ = twelve.post(join("a", "Avery"), nowMillis: 0)
        _ = twelve.post(StageEvent.make(kind: StageEventKind.userLeft, userId: "b", name: "Ben"), nowMillis: 10)
        #expect(twelve.toast?.kind == NoticeKind.joined && twelve.queue.first?.kind == NoticeKind.left)
        let thirteen = MeetingNoticeCenter()
        _ = thirteen.applyState(host(count: 13, isHost: false), nowMillis: 0)
        _ = thirteen.post(join("a", "Avery"), nowMillis: 0)
        _ = thirteen.post(StageEvent.make(kind: StageEventKind.userLeft, userId: "b", name: "Ben"), nowMillis: 10)
        #expect(thirteen.toast == nil && thirteen.queue.isEmpty)
        let hostThirteen = MeetingNoticeCenter()
        _ = hostThirteen.applyState(host(count: 13), nowMillis: 0)
        _ = hostThirteen.post(join("a", "Avery"), nowMillis: 0)
        _ = hostThirteen.post(StageEvent.make(kind: StageEventKind.userLeft, userId: "b", name: "Ben"), nowMillis: 10)
        #expect(hostThirteen.toast?.kind == NoticeKind.joined && hostThirteen.queue.isEmpty)
    }

    @Test func aCompactSheetQueuesTheJoinToastWhileTheBannerStays() {
        let center = MeetingNoticeCenter()
        _ = center.applyState(host(pending: ["w1"]), nowMillis: 0)
        center.setToastLaneSuspended(true)
        _ = center.post(join("a", "Avery"), nowMillis: 10)
        #expect(center.toast == nil && center.queue.count == 1)
        #expect(center.banner?.kind == NoticeKind.knock)
        center.setToastLaneSuspended(false)
        #expect(center.toast?.name == "Avery")
        // A toast that was showing when a sheet opened comes back first.
        center.setToastLaneSuspended(true)
        #expect(center.toast == nil && center.queue.first?.name == "Avery")
        center.setToastLaneSuspended(false)
        #expect(center.toast?.name == "Avery")
        // R3: sheets and Android overlays suspend; the inspector and the side pane keep the lane.
        #expect(MeetingNoticePolicy.suspendsToastLane(style: .sheet) && MeetingNoticePolicy.suspendsToastLane(style: .overlay))
        #expect(!MeetingNoticePolicy.suspendsToastLane(style: .inspector) && !MeetingNoticePolicy.suspendsToastLane(style: .sidePane))
    }

    @Test func chatPreviewsDropWhileChatIsOpenAndCoalesceSenders() {
        let center = MeetingNoticeCenter()
        _ = center.applyState(host(), nowMillis: 0)
        _ = center.post(join("a", "Avery"), nowMillis: 0)
        let preview: (String, String, String) -> StageEvent = { user, name, message in
            StageEvent.make(kind: StageEventKind.chatPreview, userId: user, name: name, messageId: message, detail: "text " + message)
        }
        _ = center.post(preview("r1", "Avery", "m1"), nowMillis: 100)
        _ = center.post(preview("r2", "Ben", "m2"), nowMillis: 200)
        _ = center.post(preview("r1", "Avery", "m3"), nowMillis: 300)
        let queued = center.queue.first
        #expect(queued?.kind == NoticeKind.chatPreview && queued?.count == 3 && queued?.senderCount == 2)
        #expect(queued?.messageId == "m3" && queued?.detail == "text m3" && queued?.name == "Avery")
        center.setCurrentPanel(MeetingPanel.chat.rawValue, nowMillis: 400)
        #expect(center.queue.isEmpty)
        _ = center.post(preview("r3", "Cai", "m4"), nowMillis: 500)
        #expect(center.queue.isEmpty)
    }

    @Test func attendeesSeeOnlyRecoveryBannersAndTheirHandResults() {
        let center = MeetingNoticeCenter()
        _ = center.applyState(host(pending: ["w1"], isRecovering: true, isHost: false, isAttendee: true, liveNotes: .live), nowMillis: 0)
        #expect(center.banner?.kind == NoticeKind.reconnecting)
        _ = center.applyState(host(pending: ["w1"], isHost: false, isAttendee: true, liveNotes: .live), nowMillis: 5_000)
        #expect(center.banner == nil)
        _ = center.post(join("a", "Avery"), nowMillis: 10_000)
        _ = center.post(StageEvent.make(kind: StageEventKind.chatPreview, userId: "r1", name: "Avery", messageId: "m1"), nowMillis: 10_001)
        #expect(center.toast == nil)
        _ = center.post(StageEvent.make(kind: StageEventKind.hostLoweredHand), nowMillis: 10_002)
        #expect(center.toast?.kind == NoticeKind.hostLoweredHand)
    }

    @Test func localToastsKeepTheirIdsAndEndProgressIsReplacedByItsFailure() {
        let center = MeetingNoticeCenter()
        _ = center.applyState(host(), nowMillis: 0)
        center.postLocal(MeetingNotice.make(id: "ending", kind: NoticeKind.endingForEveryone, severity: .progress), nowMillis: 0)
        #expect(center.toast?.id == "ending")
        center.dismiss(id: "ending", nowMillis: 5_000)
        #expect(center.toast?.id == "ending", "the host cannot time out a progress toast")
        center.postLocal(MeetingNotice.make(id: "endFailed", kind: NoticeKind.endFailed, severity: .error,
                                            actions: [NoticeAction.make(NoticeAction.retry)]), nowMillis: 6_000)
        #expect(center.toast?.id == "endFailed")
        center.postLocal(MeetingNotice.make(kind: NoticeKind.linkCopied), nowMillis: 7_000)
        #expect(center.queue.first?.id.hasPrefix("local:") == true)
        center.clear(id: "endFailed")
        #expect(center.toast?.kind == NoticeKind.linkCopied)
        // A local notice can never become a banner.
        center.postLocal(MeetingNotice.make(kind: NoticeKind.offline, lane: .banner), nowMillis: 8_000)
        #expect(center.banner == nil)
    }

    // MARK: Notice sounds (SC24, RECONCILE R45) through a recording output only

    @Test func noticeSoundsPlayOncePerKindAndNeverForTheHostsOwnHandOnHoldOrSwitchOff() {
        let clock = Clock()
        let stage = presenter(clock)
        let recorder = Recorder()
        stage.sounds.output = { kind in recorder.values.append(kind) }
        // The first host snapshot is a baseline: two people already waiting play nothing.
        stage.applyNotices(host(pending: ["w1", "w2"], knockSound: true, handSound: true))
        #expect(recorder.values.isEmpty)
        clock.millis += 10_000
        stage.applyNotices(host(pending: ["w1", "w2", "w3"], knockSound: true, handSound: true))
        clock.millis += 1_000
        stage.applyNotices(host(pending: ["w1", "w2", "w3", "w4"], knockSound: true, handSound: true))
        #expect(recorder.values == [NoticeSoundKind.knock], "two knocks 1 s apart play one chime")
        stage.post(StageEvent.make(kind: StageEventKind.handRaised, userId: "you", name: "You"))
        #expect(recorder.values == [NoticeSoundKind.knock], "your own hand plays nothing")
        stage.post(StageEvent.make(kind: StageEventKind.handRaised, userId: "r1", name: "Avery"))
        #expect(recorder.values == [NoticeSoundKind.knock, NoticeSoundKind.hand])
        #expect(stage.toast?.kind == NoticeKind.handRaised || stage.queuedToasts > 0)
        clock.millis += 10_000
        stage.applyNotices(host(pending: ["w1", "w2", "w3", "w4", "w5"], isOnHold: true, knockSound: true, handSound: true))
        #expect(recorder.values.count == 2, "on hold plays nothing")
        clock.millis += 10_000
        stage.applyNotices(host(pending: ["w1", "w2", "w3", "w4", "w5", "w6"], knockSound: false, handSound: false))
        stage.post(StageEvent.make(kind: StageEventKind.handRaised, userId: "r2", name: "Ben"))
        #expect(recorder.values.count == 2, "switches off play nothing")
        // The policy itself.
        let gate = NoticeSoundGate(isHost: true, knockSoundOn: true, handSoundOn: true, isOnHold: false, isAudioPaused: false)
        #expect(NoticeSoundPolicy.shouldPlay(kind: NoticeSoundKind.knock, gate: gate, lastPlayedMillis: nil, nowMillis: 0))
        #expect(!NoticeSoundPolicy.shouldPlay(kind: NoticeSoundKind.knock, gate: gate, lastPlayedMillis: 0, nowMillis: 2_999))
        #expect(NoticeSoundPolicy.shouldPlay(kind: NoticeSoundKind.knock, gate: gate, lastPlayedMillis: 0, nowMillis: 3_000))
        let guest = NoticeSoundGate(isHost: false, knockSoundOn: true, handSoundOn: true, isOnHold: false, isAudioPaused: false)
        #expect(!NoticeSoundPolicy.shouldPlay(kind: NoticeSoundKind.hand, gate: guest, lastPlayedMillis: nil, nowMillis: 0))
        let paused = NoticeSoundGate(isHost: true, knockSoundOn: true, handSoundOn: true, isOnHold: false, isAudioPaused: true)
        #expect(!NoticeSoundPolicy.shouldPlay(kind: NoticeSoundKind.hand, gate: paused, lastPlayedMillis: nil, nowMillis: 0))
        #expect(NoticeSoundKind.assetName(NoticeSoundKind.knock) == "notice_knock")
        #expect(NoticeSoundKind.assetName(NoticeSoundKind.hand) == "notice_hand")
    }

    @Test func noRecoveryResyncKnockChimes() {
        let clock = Clock()
        let stage = presenter(clock)
        let recorder = Recorder()
        stage.sounds.output = { kind in recorder.values.append(kind) }
        stage.applyNotices(host(pending: [], knockSound: true))
        clock.millis += 5_000
        stage.applyNotices(host(pending: ["w1"], isRecovering: true, knockSound: true))
        clock.millis += 1_000
        stage.applyNotices(host(pending: ["w1", "w2"], knockSound: true))
        #expect(recorder.values.isEmpty)
    }

    // MARK: Presenter routing, tokens, announcements and geometry

    @Test func noticeActionsRouteToPanelsTheShellAndTheCore() {
        let clock = Clock()
        let stage = presenter(clock)
        var commands: [NoticeCommand] = []
        stage.onNoticeCommand = { command in commands.append(command) }
        stage.applyNotices(host(pending: ["w1"]))
        let knock = stage.banner?.id ?? ""
        stage.performNoticeAction(noticeId: knock, actionId: NoticeAction.admit)
        #expect(commands.last == NoticeCommand(actionId: NoticeAction.admit, noticeKind: NoticeKind.knock, userId: "w1", detail: ""))
        stage.performNoticeAction(noticeId: knock, actionId: NoticeAction.view)
        #expect(stage.shell.panels.snapshot.current?.panel == .participants)
        #expect(stage.shell.panels.snapshot.current?.destination == .peopleWaiting)
        // An action the notice does not carry does nothing.
        let before = commands.count
        stage.performNoticeAction(noticeId: knock, actionId: NoticeAction.endNow)
        #expect(commands.count == before)
        // A host notice Dismiss also clears the core's copy.
        stage.post(StageEvent.make(kind: StageEventKind.hostNotice, serverText: "Hello", detail: "info"))
        stage.applyNotices(host())
        #expect(stage.banner?.kind == NoticeKind.hostNotice)
        stage.dismissNotice(id: stage.banner?.id ?? "")
        #expect(commands.last?.actionId == NoticeCommand.dismissHostNotice)
    }

    @Test func catchUpOpensMinutesOncePerCall() {
        let clock = Clock()
        let stage = presenter(clock)
        stage.applyNotices(host(catchUp: 7))
        #expect(stage.banner?.kind == NoticeKind.catchUp && stage.banner?.count == 7)
        stage.performNoticeAction(noticeId: stage.banner?.id ?? "", actionId: NoticeAction.catchUp)
        #expect(stage.shell.panels.snapshot.current?.panel == .transcript)
        #expect(stage.shell.panels.snapshot.current?.destination == .transcriptMinutes)
        stage.shell.panels.dismiss(cancelPending: true)
        stage.applyNotices(host(catchUp: 8))
        #expect(stage.banner == nil)
    }

    @Test func moderationAndRoleEventsPublishTheStageTokens() {
        let clock = Clock()
        let stage = presenter(clock)
        stage.applyNotices(host())
        stage.post(StageEvent.make(kind: StageEventKind.hostMutedYou))
        #expect(stage.feedbackState.token.kind == .hostMutedYou)
        stage.post(StageEvent.make(kind: StageEventKind.hostCameraOff))
        #expect(stage.feedbackState.token.kind == .cameraOffByHost)
        stage.post(StageEvent.make(kind: StageEventKind.becameHost))
        #expect(stage.feedbackState.token.kind == .becameHost)
        stage.post(StageEvent.make(kind: StageEventKind.lostHost))
        #expect(stage.feedbackState.token.kind == .lostHost)
        #expect(stage.toast?.kind == NoticeKind.hostMutedYou)
    }

    @Test func recoveryPostsReconnectingAndReconnectedAnnouncements() {
        let clock = Clock()
        let stage = presenter(clock)
        stage.applyNotices(host())
        stage.applyNotices(host(isRecovering: true))
        #expect(stage.announcement?.kind == StageNoticeAnnouncementKind.reconnecting)
        stage.applyNotices(host())
        #expect(stage.announcement?.kind == StageNoticeAnnouncementKind.reconnected)
    }

    @Test func laneGeometryFollowsTheReservedInsetsTheChipsAndABottomSelfView() {
        let clock = Clock()
        let stage = presenter(clock)
        let viewport = StagePoliciesTests.iphoneSE
        #expect(stage.noticeGeometry.bannerTop == viewport.insetTop && !stage.noticeGeometry.chipsVisible)
        #expect(stage.noticeGeometry.toastBottom == viewport.insetBottom)
        #expect(stage.noticeGeometry.toastLeading == NoticeLaneGeometryPolicy.edgeMargin)
        stage.apply(StageFixtureScript.inputs(for: .handRaised))
        #expect(stage.noticeGeometry.chipsVisible)
        stage.apply(StageFixtureScript.rolesSweepStep(3))
        let floating = stage.layout.slots.contains { $0.role == .selfFloating }
        if floating {
            #expect(stage.noticeGeometry.toastTrailing > NoticeLaneGeometryPolicy.edgeMargin
                    || stage.noticeGeometry.toastLeading > NoticeLaneGeometryPolicy.edgeMargin)
        }
        // Chrome hiding never reaches the geometry: it comes from the viewport only.
        let before = stage.noticeGeometry
        stage.setTransientChrome(id: ChromeAutoHidePolicy.moreSheet, open: true)
        #expect(stage.noticeGeometry == before)
    }

    @Test func resetAndANewCallSessionClearTheLanes() {
        let clock = Clock()
        let stage = presenter(clock)
        stage.applyNotices(host(pending: ["w1"]))
        stage.post(join("a", "Avery"))
        #expect(stage.banner != nil && stage.toast != nil)
        stage.reset()
        #expect(stage.banner == nil && stage.toast == nil && stage.queuedToasts == 0 && !stage.hasLiveNoticeExpiryTask)
        stage.applyNotices(host(pending: ["w1"]))
        let next = StageNoticeInputs.make(callSession: 2, isHost: true, localUserId: "you", pendingUserIds: [])
        stage.applyNotices(next)
        #expect(stage.banner == nil)
    }

    // MARK: Sources and assets

    @Test func laneSourcesUseTheFoundationComponentsAndStaySilentInFixtures() throws {
        let ios = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/NoticeLanes+iOS.swift"))
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP"))
        #expect(ios.contains("ConclaveBannerLane(noticeID: stage.banner?.id, identifier: \"stage.banner\")"))
        #expect(ios.contains("ConclaveToastHost(item: item, isScreenReaderRunning: screenReader"))
        #expect(ios.contains("onDismiss: { id in stage.dismissNotice(id: id) }"))
        #expect(ios.contains("if installsSound { stage.sounds.output = { kind in NoticeSoundOutput.play(kind) } }"))
        #expect(!ios.contains("setCategory"), "the chime never changes the call's audio session")
        let root = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/CallRoot+iOS.swift"))
        #expect(root.contains("NoticeLanesLayer(stage: stage, forceScreenReader: forceScreenReader, installsSound: !renderers.usesProbes)"))
        #expect(root.contains("MeetingNoticePolicy.suspendsToastLane(style: presentation.style)"))
        let android = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/NoticeLanes.kt"))
        #expect(android.contains("ConclaveToastHost( item = item, identifier = \"stage.toast\""))
        #expect(!android.contains("stageLane = false"), "the stage lane keeps the dark snackbar slot (R1)")
        #expect(!android.contains("showSnackbar"), "only the toast host shows snackbars")
        #expect(android.contains("if (installsSound) { stage.sounds.output = { kind -> NativeNoticeSound.play(kind) } }"))
        let callRoot = stageNormalized(try stageSource("Sources/Conclave/Skip/ui/call/stage/CallRoot.kt"))
        #expect(callRoot.contains("NoticeLanes(stage, forceScreenReader, installsSound = !renderers.usesProbes)"))
        #expect(callRoot.contains("val suspended = coverage == PanelStageCoverage.full"))
        let player = try stageSource("Sources/Conclave/Skip/NativeNoticeSound.kt")
        #expect(player.contains("AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING"))
        #expect(player.contains("conclave/module/Resources/$name.mp3"))
        #expect(!player.contains("Vibrat"))
        let shared = try stageSource("Sources/Conclave/Features/Meeting/Stage/NoticeSoundPlayer.swift")
        #expect(!shared.contains("AVAudio") && !shared.contains("SoundPool"))
        let fixtures = stageNormalized(try stageSource("Sources/Conclave/Features/Meeting/Stage/StageFixtures.swift"))
        #expect(fixtures.contains("stage.sounds.output = { kind in counters.recordChime(kind) }"))
    }

    @Test func chimeAssetsAreBundledOnBothPlatformsAndIdentical() throws {
        for name in ["notice_knock", "notice_hand"] {
            let module = try Data(contentsOf: stagePackageURL("Sources/Conclave/Resources/" + name + ".mp3"))
            let app = try Data(contentsOf: stagePackageURL("Android/app/src/main/assets/" + name + ".mp3"))
            #expect(module == app, "\(name) differs between the module and the app assets")
            #expect(module.count > 2_000 && module.count < 40_000, "\(name) is a short chime")
            #expect(Array(module.prefix(3)) == Array("ID3".utf8), "\(name) is an MP3 with an ID3 header")
        }
    }

    private func stagePackageURL(_ path: String) -> URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(path)
    }
}
#endif
