package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class STG5NoticeBridgeTests {
    private fun host(
        pending: List<String> = emptyList(), count: Int = 4, isOffline: Boolean = false, isCaptivePortal: Boolean = false,
        isOnHold: Boolean = false, isAudioOnly: Boolean = false, quality: ConnectionQuality = ConnectionQuality.good,
        isRecovering: Boolean = false, attempt: Int = 0, snapshot: Boolean = true, isHost: Boolean = true,
        knockSound: Boolean = false, handSound: Boolean = false,
    ): StageNoticeInputs = StageNoticeInputs.make(
        callSession = 1, isHost = isHost, localUserId = "you", participantCount = count, hasInitialPresenceSnapshot = snapshot,
        isOffline = isOffline, isCaptivePortal = isCaptivePortal, isRecovering = isRecovering, reconnectAttempt = attempt,
        reconnectAttemptLimit = 5, isOnHold = isOnHold, pendingUserIds = skip.lib.Array(pending),
        pendingFirstName = if (pending.isEmpty()) "" else "Sam", isAudioOnly = isAudioOnly, connectionQuality = quality,
        knockSoundOn = knockSound, handSoundOn = handSound,
    )

    private fun join(id: String, name: String) = StageEvent.make(kind = StageEventKind.userJoined, userId = id, name = name)

    private fun actionIds(notice: MeetingNotice?): List<String> {
        val ids = mutableListOf<String>()
        if (notice == null) return ids
        for (action in notice.actions) ids.add(action.id)
        return ids
    }

    @Test fun bannerPrioritiesMatchSwift() {
        val center = MeetingNoticeCenter(platform = NoticePlatform.android)
        center.applyState(host(pending = listOf("w1"), isOffline = true), nowMillis = 0.0)
        assertEquals(NoticeKind.offline, center.banner?.kind)
        assertEquals(NoticeAnnouncement.assertiveOnce, center.banner?.announcement)
        center.applyState(host(pending = listOf("w1"), isOnHold = true), nowMillis = 1.0)
        assertEquals(NoticeKind.onHold, center.banner?.kind)
        center.applyState(host(pending = listOf("w1")), nowMillis = 2.0)
        assertEquals(listOf(NoticeAction.view, NoticeAction.admit), actionIds(center.banner))
        center.applyState(host(isOffline = true, isCaptivePortal = true), nowMillis = 3.0)
        assertEquals(NoticeKind.captivePortal, center.banner?.kind)
        val ios = MeetingNoticeCenter(platform = NoticePlatform.ios)
        ios.applyState(host(isOffline = true, isCaptivePortal = true), nowMillis = 0.0)
        assertEquals(NoticeKind.offline, ios.banner?.kind)
        val quality = MeetingNoticeCenter(platform = NoticePlatform.android)
        quality.applyState(host(quality = ConnectionQuality.emergency), nowMillis = 0.0)
        assertEquals(listOf(NoticeAction.useAudioOnly), actionIds(quality.banner))
        quality.applyState(host(isAudioOnly = true, quality = ConnectionQuality.emergency), nowMillis = 1.0)
        assertEquals(NoticeKind.audioOnly, quality.banner?.kind)
        quality.applyState(host(quality = ConnectionQuality.poor), nowMillis = 2.0)
        assertNull(quality.banner)
    }

    @Test fun qualityDismissalResetsOnlyOnFairOrGood() {
        val center = MeetingNoticeCenter(platform = NoticePlatform.android)
        center.applyState(host(quality = ConnectionQuality.emergency), nowMillis = 0.0)
        center.dismiss(id = center.banner?.id ?: "", nowMillis = 1.0)
        assertNull(center.banner)
        center.applyState(host(quality = ConnectionQuality.poor), nowMillis = 2.0)
        center.applyState(host(quality = ConnectionQuality.emergency), nowMillis = 3.0)
        assertNull(center.banner)
        center.applyState(host(quality = ConnectionQuality.fair), nowMillis = 4.0)
        center.applyState(host(quality = ConnectionQuality.emergency), nowMillis = 5.0)
        assertEquals(NoticeKind.veryPoorConnection, center.banner?.kind)
    }

    @Test fun hostNoticeMaskedForSeventySecondsKeepsItsRemainingTime() {
        val center = MeetingNoticeCenter(platform = NoticePlatform.android)
        val start = 1_000_000.0
        center.applyState(host(), nowMillis = start)
        center.post(StageEvent.make(kind = StageEventKind.hostNotice, userId = "r1", name = "Avery", serverText = "Five minutes",
            detail = "warning"), nowMillis = start)
        assertEquals(start + 60_000.0, center.banner?.expiresAtMillis ?: 0.0, 0.001)
        center.applyState(host(isOffline = true), nowMillis = start + 20_000.0)
        assertEquals(NoticeKind.offline, center.banner?.kind)
        assertEquals(40_000.0, center.hostNoticeRemaining, 0.001)
        center.applyState(host(), nowMillis = start + 90_000.0)
        assertEquals(start + 130_000.0, center.banner?.expiresAtMillis ?: 0.0, 0.001)
        assertFalse(center.expireIfDue(nowMillis = start + 129_000.0))
        assertTrue(center.expireIfDue(nowMillis = start + 130_000.0))
        assertNull(center.banner)
    }

    @Test fun knockAndReconnectingFixturesMatchSwift() {
        val knock = StageFixtureSession(state = StageFixtureState.knock2).stage.banner
        assertEquals(NoticeKind.knock, knock?.kind)
        assertEquals(2, knock?.count)
        assertEquals(listOf(NoticeAction.view, NoticeAction.admitAll), actionIds(knock))
        val attempt = StageFixtureSession(state = StageFixtureState.reconnecting2).stage.banner
        assertEquals(2, attempt?.count)
        assertEquals(5, attempt?.total)
        assertTrue(attempt?.actions?.get(0)?.isEnabled == true)
        val inFlight = StageFixtureSession(state = StageFixtureState.reconnectingInFlight).stage.banner
        assertFalse(inFlight?.actions?.get(0)?.isEnabled == true)
        val joins = StageFixtureSession(state = StageFixtureState.toastJoins)
        assertEquals("Avery Lee", joins.stage.toast?.name)
        assertEquals(1, joins.stage.queuedToasts)
        assertEquals(0.0, joins.stage.toast?.expiresAtMillis ?: -1.0, 0.0)
        assertEquals(0, joins.counters.chimes.count)
    }

    @Test fun toastQueueCoalescesWithinFourSecondsAndCapsAtThree() {
        val center = MeetingNoticeCenter(platform = NoticePlatform.android)
        val t = 10_000.0
        center.applyState(host(), nowMillis = t)
        center.post(join("a", "Avery"), nowMillis = t)
        center.post(join("b", "Ben"), nowMillis = t + 1_000.0)
        center.post(join("c", "Cai"), nowMillis = t + 2_000.0)
        assertEquals(1, center.queue.count)
        assertEquals(2, center.queue[0].count)
        center.post(join("d", "Dev"), nowMillis = t + 6_500.0)
        center.post(StageEvent.make(kind = StageEventKind.routeChanged, name = "Speaker"), nowMillis = t + 6_600.0)
        center.post(StageEvent.make(kind = StageEventKind.actionFailed, detail = "hand"), nowMillis = t + 6_700.0)
        assertEquals(3, center.queue.count)
        assertEquals(NoticeKind.actionFailed, center.queue[0].kind)

        assertEquals("Avery", center.toast?.name)
        center.dismiss(id = center.toast?.id ?: "", nowMillis = t + 600_000.0)
        assertEquals(NoticeKind.actionFailed, center.toast?.kind)
    }

    @Test fun presenceAndRecoverySuppressionAndTheQ4Thresholds() {
        val center = MeetingNoticeCenter(platform = NoticePlatform.android)
        center.applyState(host(count = 8, snapshot = false), nowMillis = 0.0)
        for (index in 0 until 8) center.post(join("p$index", "Person $index"), nowMillis = index.toDouble())
        assertNull(center.toast)
        center.applyState(host(count = 8, isRecovering = true), nowMillis = 100.0)
        center.post(join("x", "Xan"), nowMillis = 200.0)
        center.applyState(host(count = 8), nowMillis = 1_000.0)
        center.post(join("y", "Yu"), nowMillis = 2_000.0)
        assertNull(center.toast)
        center.post(join("z", "Zed"), nowMillis = 1_000.0 + MeetingNoticePolicy.recoveryGraceMillis + 1.0)
        assertEquals("Zed", center.toast?.name)
        val thirteen = MeetingNoticeCenter(platform = NoticePlatform.android)
        thirteen.applyState(host(count = 13, isHost = false), nowMillis = 0.0)
        thirteen.post(join("a", "Avery"), nowMillis = 0.0)
        assertNull(thirteen.toast)
        val twelve = MeetingNoticeCenter(platform = NoticePlatform.android)
        twelve.applyState(host(count = 12, isHost = false), nowMillis = 0.0)
        twelve.post(join("a", "Avery"), nowMillis = 0.0)
        assertEquals(NoticeKind.joined, twelve.toast?.kind)
    }

    @Test fun anAndroidFullOverlaySuspendsTheToastLane() {
        val center = MeetingNoticeCenter(platform = NoticePlatform.android)
        center.applyState(host(pending = listOf("w1")), nowMillis = 0.0)
        center.setToastLaneSuspended(true)
        center.post(join("a", "Avery"), nowMillis = 10.0)
        assertNull(center.toast)
        assertEquals(1, center.queue.count)
        assertEquals(NoticeKind.knock, center.banner?.kind)
        center.setToastLaneSuspended(false)
        assertEquals("Avery", center.toast?.name)
        assertTrue(MeetingNoticePolicy.suspendsToastLane(style = PanelHostStyle.overlay))
        assertFalse(MeetingNoticePolicy.suspendsToastLane(style = PanelHostStyle.sidePane))
    }

    @Test fun aSecondToastWaitsUntilTheHostDismissesTheFirst() {

        val stage = StagePresenter(shell = MeetingShellPresenter())
        stage.apply(StageFixtureScript.base(count = 4))
        stage.applyNotices(host())
        stage.post(join("a", "Avery"))
        stage.post(StageEvent.make(kind = StageEventKind.routeChanged, name = "Speaker"))
        val first = stage.toast
        assertEquals(NoticeKind.joined, first?.kind)
        assertEquals(1, stage.queuedToasts)
        stage.dismissNotice(id = "not-the-current-id")
        assertEquals(first, stage.toast)
        stage.dismissNotice(id = first?.id ?: "")
        assertEquals(NoticeKind.routeChanged, stage.toast?.kind)
        assertEquals(0, stage.queuedToasts)
    }

    @Test fun noticeSoundsPlayOncePerKindThroughARecordingOutput() {
        var clock = 10_000.0
        val stage = StagePresenter(shell = MeetingShellPresenter())
        stage.now = { clock }
        stage.sounds.now = { clock }
        stage.apply(StageFixtureScript.base(count = 4))
        val played = mutableListOf<String>()
        stage.sounds.output = { kind -> played.add(kind) }
        stage.applyNotices(host(pending = listOf("w1", "w2"), knockSound = true, handSound = true))
        assertEquals(0, played.size)
        clock += 10_000.0
        stage.applyNotices(host(pending = listOf("w1", "w2", "w3"), knockSound = true, handSound = true))
        clock += 1_000.0
        stage.applyNotices(host(pending = listOf("w1", "w2", "w3", "w4"), knockSound = true, handSound = true))
        assertEquals(listOf(NoticeSoundKind.knock), played)
        stage.post(StageEvent.make(kind = StageEventKind.handRaised, userId = "you", name = "You"))
        assertEquals(1, played.size)
        stage.post(StageEvent.make(kind = StageEventKind.handRaised, userId = "r1", name = "Avery"))
        assertEquals(listOf(NoticeSoundKind.knock, NoticeSoundKind.hand), played)
        clock += 10_000.0
        stage.applyNotices(host(pending = listOf("w1", "w2", "w3", "w4", "w5"), isOnHold = true, knockSound = true, handSound = true))
        assertEquals(2, played.size)
        clock += 10_000.0
        stage.applyNotices(host(pending = listOf("w1", "w2", "w3", "w4", "w5", "w6")))
        assertEquals(2, played.size)
    }

    @Test fun liveNotesCatchUpCaptionTailAndStartGateMatchSwift() {
        assertEquals(LiveNotesState.needsAttention, LiveNotesPolicy.stageState(phase = LiveNotesPhase.live, link = TranscriptLink.failed,
            issue = TranscriptIssue.none))
        assertEquals(LiveNotesState.live, LiveNotesPolicy.stageState(phase = LiveNotesPhase.stopping, link = TranscriptLink.connected,
            issue = TranscriptIssue.none))
        assertEquals(LiveNotesState.off, LiveNotesPolicy.stageState(phase = LiveNotesPhase.ended, link = TranscriptLink.connected,
            issue = TranscriptIssue.none))
        assertEquals(LiveNotesPhase.unavailable, TranscriptPhasePolicy.phase(sessionStatus = "live", hasSnapshot = true,
            failedAttempts = 8, sawSession = true))
        val start = 1_700_000_000_000.0
        assertEquals(2, CatchUpPolicy.minutes(phase = LiveNotesPhase.live, sessionStartedAtMillis = start,
            joinedAtMillis = start + 120_000.0, isAttendee = false))
        assertEquals(0, CatchUpPolicy.minutes(phase = LiveNotesPhase.live, sessionStartedAtMillis = start,
            joinedAtMillis = start + 60_000.0, isAttendee = false))
        assertFalse(LiveNotesStartPolicy.offersStart(canStart = true, relay = RelayAvailability.unavailable, phase = LiveNotesPhase.idle))
        assertFalse(TranscriptStreamPolicy.shouldBeOpen(isInCall = true, isAttendee = true))
        val words = mutableListOf<String>()
        for (index in 0 until 400) words.add("word$index")
        val tail = CaptionLinePolicy.trimmedTail(words.joinToString(" "))
        assertTrue(tail.length <= CaptionLinePolicy.maxCharacters)
        assertTrue(tail.startsWith("…") && tail.endsWith("word399"))
        val quiet = StageFixtureSession(state = StageFixtureState.captionsQuiet)
        assertTrue(quiet.stage.captionsActive)
        assertTrue(quiet.stage.captions.line.isPlaceholder)
        assertFalse(StageFixtureSession(state = StageFixtureState.captionsAttendee).stage.captionsActive)
    }

    @Test fun captionUserStyleFallsBackToTheTokensWhenCaptionsAreOff() {
        val style = CaptionUserStyle.read(RuntimeEnvironment.getApplication())
        assertEquals(CaptionUserStyle.standard, style)
        assertEquals(1.0f, style.fontScale, 0.0f)
    }
}
