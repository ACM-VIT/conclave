package conclave.module

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * TRN-2 (S60 6, C6-11, C6-12, C6-26; S30 CC8) through the transpiled incremental feed, the Transcript presenter, the
 * fixtures' FakeTranscriptOwner, the recap coordinator and the recap overlay policy, plus the handwritten copy map and
 * export helper. The Swift half is T/TRN2TranscriptPanelTests.swift; the same fixtures give the same results: a partial
 * delta on 2,000 segments touches at most three groups and rebuilds nothing, the states table, Stop confirming and
 * failing, Ask settling at 30 s, the finals-only export named for the room, Post Recap and End with the 30 s cap, and
 * every copy resource name resolving (red until HD/strings/B7-T5.json is merged). Pure: no composition (only the first
 * composition in a JVM keeps recomposing under Robolectric; PanelStageBridgeTests owns it).
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class TRN2TranscriptBridgeTests {
    private class Clock {
        var value = 1_000_000.0
    }

    private fun fixture(state: TranscriptFixtureState): TranscriptFixtureDriver {
        val driver = TranscriptFixtureDriver(fixture = state)
        driver.runsFollowUps = false
        driver.presenter.sleep = { _ -> kotlinx.coroutines.delay(60_000) }
        return driver
    }

    private fun segment(id: String, sequence: Int, speaker: String, text: String, final: Boolean, at: Double) =
        TranscriptSegmentModel(itemId = id, sequence = sequence, speakerUserId = speaker, speakerDisplayName = speaker,
            text = text, startMs = at, isFinal = final)

    private val labels = TranscriptExportLabels(title = "Meeting transcript - room", summary = "Summary", topics = "Topics",
        decisions = "Decisions", actionItems = "Action items", openQuestions = "Open questions", followUps = "Follow-ups",
        transcript = "Transcript", speaker = "Speaker")

    @Test
    fun theEngineGroupsLikeTheLegacyPolicy() {
        val engine = TranscriptFeedEngine()
        engine.upsert(segment("c", 3, "sam", "three", true, 3_000.0))
        engine.upsert(segment("a", 1, "avery", "one", true, 1_000.0))
        engine.upsert(segment("e", 5, "avery", "five", true, 200_000.0))
        engine.upsert(segment("b", 2, "avery", "two", true, 2_000.0))
        engine.upsert(segment("d", 4, "sam", "four", false, 4_000.0))
        val texts = mutableListOf<String>()
        for (group in engine.groups) texts.add(group.text)
        assertEquals(listOf("one two", "three four", "five"), texts)
        assertTrue(engine.hasMarker(before = 2))
        assertEquals(0, engine.sortCount)
        engine.upsert(segment("d", 4, "sam", "four done", true, 4_000.0))
        assertTrue(engine.groups[1].isFinal)
        assertEquals("three four done", engine.groups[1].text)
    }

    @Test
    fun aPartialStreamOnTwoThousandSegmentsRebuildsNothing() {
        val driver = fixture(TranscriptFixtureState.long)
        val feed = driver.presenter.feed
        assertEquals(2_001, driver.state.feedEngine.segments.count)
        val rebuilds = feed.rebuildCount
        val sorts = driver.state.feedEngine.sortCount
        driver.streamPartials(10, finalize = false)
        assertTrue(driver.state.feedEngine.lastTouchedGroupCount <= 3)
        assertTrue(feed.lastTouchedCount <= 3)
        assertEquals(rebuilds, feed.rebuildCount)
        assertEquals(sorts, driver.state.feedEngine.sortCount)
        assertEquals(0, driver.state.legacyRebuildCount)
    }

    @Test
    fun fixtureSnapshotsMatchSwift() {
        val idle = fixture(TranscriptFixtureState.idle).presenter.snapshot
        assertEquals(TranscriptBody.startCard, idle.body)
        assertTrue(idle.offersStart)
        val viewOnly = fixture(TranscriptFixtureState.viewOnly).presenter.snapshot
        assertTrue(viewOnly.isViewOnly)
        assertFalse(viewOnly.offersStart)
        val controller = fixture(TranscriptFixtureState.liveController).presenter.snapshot
        assertEquals(TranscriptStatusKind.live, controller.status)
        assertEquals(TranscriptHostKind.you, controller.host)
        assertTrue(controller.canStop && controller.canPause)
        assertEquals(listOf(TranscriptTab.transcript, TranscriptTab.ask, TranscriptTab.minutes), controller.tabs.toList())
        val follower = fixture(TranscriptFixtureState.liveFollower).presenter.snapshot
        assertEquals(TranscriptHostKind.named, follower.host)
        assertFalse(follower.canStop)
        assertEquals(TranscriptStatusKind.reconnecting, fixture(TranscriptFixtureState.reconnecting).presenter.snapshot.status)
        assertEquals(TranscriptBody.unavailable, fixture(TranscriptFixtureState.unavailable).presenter.snapshot.body)
        val ended = fixture(TranscriptFixtureState.ended).presenter.snapshot
        assertEquals(TranscriptStatusKind.ended, ended.status)
        assertTrue(ended.hasContent)
        val relay = fixture(TranscriptFixtureState.relayUnavailable).presenter.snapshot
        assertEquals(TranscriptBody.relayUnavailable, relay.body)
        assertFalse(relay.offersStart)
    }

    @Test
    fun stopConfirmsOnceAndAScriptedFailureShowsTheBanner() {
        val driver = fixture(TranscriptFixtureState.liveController)
        val presenter = driver.presenter
        presenter.requestStop()
        assertEquals(StopPhase.confirming, presenter.snapshot.stop)
        assertTrue(presenter.confirmStop())
        assertEquals(listOf("stop"), presenter.callLog.toList())
        assertFalse(presenter.confirmStop())
        driver.finishStop()
        assertEquals(LiveNotesPhase.ended, presenter.snapshot.phase)
        val failing = fixture(TranscriptFixtureState.liveController)
        failing.run(TranscriptFixtureScriptName.stopFails)
        failing.presenter.requestStop()
        failing.presenter.confirmStop()
        assertEquals(StopPhase.failed, failing.presenter.snapshot.stop)
    }

    @Test
    fun askSettlesAfterThirtySilentSeconds() {
        val driver = fixture(TranscriptFixtureState.liveController)
        val presenter = driver.presenter
        val clock = Clock()
        presenter.now = { clock.value }
        driver.run(TranscriptFixtureScriptName.askSilence)
        assertTrue(presenter.askQuestion("What did we decide?"))
        val id = presenter.ask.rowIds[0]
        assertEquals(AskRowState.thinking, presenter.ask.row(id).state)
        clock.value += 30_500.0
        presenter.expireAskRows()
        assertEquals(AskRowState.timedOut, presenter.ask.row(id).state)
        driver.run(TranscriptFixtureScriptName.askReject)
        presenter.askQuestion("Summarize the discussion")
        assertEquals(AskRowState.error, presenter.ask.row(presenter.ask.rowIds[1]).state)
    }

    @Test
    fun exportIsFinalsOnlyAndNamedForTheRoom() {
        val presenter = fixture(TranscriptFixtureState.liveController).presenter
        val file = presenter.exportFile(labels = labels, timeLabel = { _ -> "10:41" })
        assertEquals("conclave-fixture-room-transcript.md", file.fileName)
        assertTrue(file.byteCount > 0)
        assertFalse(file.content.contains("And then we probably need to dec"))
        assertTrue(file.content.contains("- 10:41 Avery Lee: So the deck is ready for review by Friday."))
        assertEquals("conclave-abc-def-ghi-transcript.md", TranscriptExportPolicy.fileName(roomId = "abc def/ghi"))
    }

    @Test
    fun postRecapAndEndHonorsTheThirtySecondCap() {
        val recap = RecapCoordinator()
        val clock = Clock()
        recap.now = { clock.value }
        recap.sleep = { _ -> kotlinx.coroutines.delay(60_000) }
        var ended = 0
        recap.sendRecap = { true }
        recap.endCall = { ended += 1 }
        assertTrue(recap.postAndEnd())
        assertTrue(recap.isPostingBeforeEnd)
        clock.value += 29_000.0
        recap.expireIfDue()
        assertEquals(0, ended)
        clock.value += 1_000.0
        recap.expireIfDue()
        assertEquals(1, ended)
        val settled = RecapCoordinator()
        settled.sleep = { _ -> kotlinx.coroutines.delay(60_000) }
        var settledEnds = 0
        settled.sendRecap = { true }
        settled.endCall = { settledEnds += 1 }
        settled.postAndEnd()
        settled.noteAssistantAnswerSettled(atMillis = settled.requestedAtMillis + 1.0, failed = false)
        assertEquals(1, settledEnds)
    }

    @Test
    fun theLeaveOverlayOffersTheRecapOnlyToHostsAndPostsTheRecapPhase() {
        val base = LeaveSnapshot(revision = 1, canEndForEveryone = true, leavePhase = LeavePhase.idle, endPhase = EndPhase.idle,
            confirmationId = 3, confirmationInvoker = "call", offersRecap = false, endFailure = "none", showsEndForEveryone = true,
            endBlockedReason = ControlBlockedReason.none)
        assertTrue(RecapPolicy.leaveSnapshot(base, recap = RecapControlsState(offersRecap = true, isPostingBeforeEnd = false)).offersRecap)
        val posting = RecapPolicy.leaveSnapshot(base, recap = RecapControlsState(offersRecap = true, isPostingBeforeEnd = true))
        assertFalse(posting.offersRecap) // no second recap while one posts
        val guest = LeaveSnapshot(revision = 1, canEndForEveryone = false, leavePhase = LeavePhase.idle, endPhase = EndPhase.idle,
            confirmationId = 0, confirmationInvoker = "", offersRecap = false, endFailure = "none", showsEndForEveryone = false,
            endBlockedReason = ControlBlockedReason.none)
        assertFalse(RecapPolicy.leaveSnapshot(guest, recap = RecapControlsState(offersRecap = true, isPostingBeforeEnd = false)).offersRecap)
        val idle = LeaveSnapshot(revision = 1, canEndForEveryone = true, leavePhase = LeavePhase.idle, endPhase = EndPhase.idle,
            confirmationId = 0, confirmationInvoker = "", offersRecap = false, endFailure = "none", showsEndForEveryone = true,
            endBlockedReason = ControlBlockedReason.none)
        assertEquals(EndPhase.postingRecap,
            RecapPolicy.leaveSnapshot(idle, recap = RecapControlsState(offersRecap = true, isPostingBeforeEnd = true)).endPhase)
        assertTrue(RecapPolicy.offersRecap(canPostToChat = true, phase = LiveNotesPhase.paused, hasContent = true))
        assertFalse(RecapPolicy.offersRecap(canPostToChat = false, phase = LiveNotesPhase.live, hasContent = true))
    }

    @Test
    fun everyCopyNameIsDeclared() {
        val context = RuntimeEnvironment.getApplication()
        val names = mutableListOf<String>()
        for (tab in TranscriptTab.allCases) names.add(TranscriptCopy.tab(tab))
        for (kind in TranscriptStartKind.allCases) { names.add(TranscriptCopy.startTitle(kind)); names.add(TranscriptCopy.startButton(kind)) }
        for (blurb in TranscriptBlurb.allCases) names.add(TranscriptCopy.blurb(blurb))
        for (coverage in KeyCoverage.allCases) names.add(TranscriptCopy.coverage(coverage))
        for (status in TranscriptStatusKind.allCases) TranscriptCopy.status(status)?.let { names.add(it) }
        for (host in TranscriptHostKind.allCases) TranscriptCopy.host(host)?.let { names.add(it) }
        for (issue in TranscriptIssue.allCases) TranscriptCopy.issue(issue)?.let { names.add(it) }
        for (state in AskRowState.allCases) TranscriptCopy.askState(state)?.let { names.add(it) }
        for (section in MinutesSection.allCases) names.add(TranscriptCopy.section(section))
        for (kind in MinutesEmptyKind.allCases) { TranscriptCopy.emptyTitle(kind)?.let { names.add(it) }; TranscriptCopy.emptyBody(kind)?.let { names.add(it) } }
        for (kind in MinutesStatusKind.allCases) names.add(TranscriptCopy.minutesStatus(kind))
        for (phase in RecapPhase.allCases) TranscriptCopy.recapValue(phase)?.let { names.add(it) }
        for (kind in TranscriptAnnouncementKind.allCases) TranscriptCopy.announcement(kind)?.let { names.add(it) }
        // The library test module has no app resources (TypographyHapticsGalleryBridgeTests), so the resources themselves
        // are checked against strings.xml and HD/strings/B7-T5.json by the Swift contract test; here every name a mapping
        // returns must be in the declared list, which has no duplicates.
        val missing = names.filter { it !in TranscriptCopy.allNames }.distinct()
        assertEquals(emptyList<String>(), missing)
        assertEquals(TranscriptCopy.allNames.size, TranscriptCopy.allNames.toSet().size)
        assertNotEquals(0, TranscriptCopy.allNames.size)
        assertEquals("[trn_title]", conclaveStringOf(context, "trn_title"))
    }

    @Test
    fun theExportFolderIsTheFileProviderPath() {
        val context = RuntimeEnvironment.getApplication()
        val folder = TranscriptExport.directory(context)
        assertTrue(folder.path.endsWith("/exports"))
        assertEquals(context.packageName + ".fileprovider", TranscriptExport.authority(context))
    }
}
