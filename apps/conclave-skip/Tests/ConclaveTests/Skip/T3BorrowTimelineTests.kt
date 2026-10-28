package conclave.module

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import java.time.Duration
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * T3B-3 (R/t3-borrow/PLAN.md section 4; P7, the presenter half of P4, P8) through the transpiled Kotlin (the Swift half
 * is T/T3BorrowPresenterTests.swift): the DelayedStatusPolicy table with the same results as Swift, the presenter's
 * delayed gate line (the gate task parks on the injected sleep and the test runs its body at the deadline), the
 * one-attachment guard and canAcceptPhoto, the fixture's new states and scripts, ChatRowActions.composerDidFocus, and
 * the composer focus follow on a real reversed LazyColumn composed on a Robolectric activity: one row up follows, three
 * screens up stays. The Conclave test classpath has no Compose UI test artifacts, so the list runs on the Robolectric
 * frame clock (runtime-sensitive, like PanelStageBridgeTests).
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class T3BorrowTimelineTests {
    private val local = "jordan@example.com#s1"
    private val avery = "avery@example.com#w1"
    private val base = 1_800_014_400_000.0
    private val firstPhoto = "file:///cache/chat-photos/first.jpg"
    private var clock = 0.0

    private fun roster() = skip.lib.Array(listOf(
        ChatRosterEntry(userId = local, name = "Jordan Lee", isPresent = true),
        ChatRosterEntry(userId = avery, name = "Avery Lee", isPresent = true),
    ))

    private fun inputs(
        gate: ChatSendGate,
        attachment: ChatAttachmentState = ChatAttachmentState.none,
        photosEnabled: Boolean = true,
    ) = ChatInputs.make(callSession = 1, roomId = "room-a", localUserId = local, localName = "Jordan Lee",
        photosEnabled = photosEnabled, gate = gate, roster = roster(), assistant = AssistantAvailability.available,
        attachment = attachment)

    /** A presenter on the test clock; its gate task parks, and the tests run its body when the clock reaches the deadline. */
    private fun presenter(gate: ChatSendGate = ChatSendGate.open): ChatPresenter {
        val chat = ChatPresenter()
        chat.now = { base + clock }
        chat.sleep = { _ -> kotlinx.coroutines.delay(60_000) }
        chat.apply(inputs(gate), ChatInputChange.messages)
        return chat
    }

    private fun status(phase: DelayedStatusPhase, value: String, deadline: Double) =
        DelayedStatus(phase = phase, value = value, deadline = deadline)

    @Test
    fun delayedStatusPolicyMatchesSwift() {
        assertEquals(400.0, DelayedStatusPolicy.showDelayMillis, 0.0)
        assertEquals(400.0, DelayedStatusPolicy.minimumVisibleMillis, 0.0)
        // A 250 ms blip never shows.
        var current = DelayedStatusPolicy.step(DelayedStatus.idle, value = "reconnecting", isImmediate = false, now = 0.0)
        assertEquals(status(DelayedStatusPhase.pending, "reconnecting", 400.0), current)
        assertEquals("", DelayedStatusPolicy.visible(current))
        assertEquals(DelayedStatus.idle, DelayedStatusPolicy.step(current, value = "", isImmediate = false, now = 250.0))
        // A 1,500 ms outage shows from 400 ms, holds to 800 ms and hides when it ends.
        current = DelayedStatusPolicy.step(current, value = "reconnecting", isImmediate = false, now = 400.0)
        assertEquals(status(DelayedStatusPhase.shown, "reconnecting", 800.0), current)
        assertEquals("reconnecting", DelayedStatusPolicy.visible(current))
        assertEquals(current, DelayedStatusPolicy.step(current, value = "", isImmediate = false, now = 600.0))
        assertEquals(800.0, DelayedStatusPolicy.wakeDeadline(current, value = "", now = 600.0), 0.0)
        assertEquals(DelayedStatus.idle, DelayedStatusPolicy.step(current, value = "", isImmediate = false, now = 1500.0))
        // Reconnecting to offline while shown re-stamps the hold.
        assertEquals(status(DelayedStatusPhase.shown, "offline", 1000.0),
            DelayedStatusPolicy.step(current, value = "offline", isImmediate = false, now = 600.0))
        // A different value while pending keeps the show time.
        assertEquals(status(DelayedStatusPhase.pending, "offline", 400.0),
            DelayedStatusPolicy.step(status(DelayedStatusPhase.pending, "reconnecting", 400.0), value = "offline",
                isImmediate = false, now = 200.0))
        // Immediate values show and clear at once.
        val locked = DelayedStatusPolicy.step(DelayedStatus.idle, value = "locked", isImmediate = true, now = 50.0)
        assertEquals(status(DelayedStatusPhase.shown, "locked", 50.0), locked)
        assertEquals(DelayedStatus.idle, DelayedStatusPolicy.step(locked, value = "", isImmediate = false, now = 50.0))
        assertEquals(DelayedStatus.idle, DelayedStatusPolicy.step(current, value = "", isImmediate = true, now = 500.0))
        assertEquals(-1.0, DelayedStatusPolicy.wakeDeadline(DelayedStatus.idle, value = "", now = 0.0), 0.0)
        assertTrue(ChatGateLinePolicy.showsLine(ChatSendGate.reconnecting))
        assertFalse(ChatGateLinePolicy.showsLine(ChatSendGate.locked))
        assertTrue(ChatGateLinePolicy.isImmediate(ChatSendGate.attendee))
    }

    @Test
    fun theGateLineWaitsHoldsAndFollowsTheFirstApplyAtOnce() {
        clock = 0.0
        assertEquals(ChatSendGate.notJoined, ChatComposerSnapshot.initial.gateLine)
        val reconnecting = presenter(ChatSendGate.reconnecting)
        assertEquals(ChatSendGate.reconnecting, reconnecting.composer.gateLine)
        assertFalse(reconnecting.hasGateLineTask)
        // R8 first apply (fix pass): a line drawn at once by the first apply counts as one show, as in Swift.
        assertEquals(1, reconnecting.gateLineShowCount)
        reconnecting.reset()
        assertEquals(0, reconnecting.gateLineShowCount)
        assertEquals(0, reconnecting.gateLineTasksStarted)

        val chat = presenter()
        val publishes = chat.composerPublishCount
        // A 250 ms blip: Send follows the gate, the line never draws, the task is cancelled.
        chat.apply(inputs(ChatSendGate.reconnecting), ChatInputChange.gate)
        assertEquals(ChatSendGate.reconnecting, chat.composer.gate)
        assertEquals(ChatSendGate.open, chat.composer.gateLine)
        assertTrue(chat.hasGateLineTask)
        clock = 250.0
        chat.apply(inputs(ChatSendGate.open), ChatInputChange.gate)
        assertFalse(chat.hasGateLineTask)
        assertEquals(ChatSendGate.open, chat.composer.gateLine)
        assertEquals(2, chat.composerPublishCount - publishes)
        assertEquals(0, chat.gateLineShowCount)
        // A long outage: drawn at the 400 ms deadline, held through a reopen until 800 ms.
        clock = 1000.0
        chat.apply(inputs(ChatSendGate.reconnecting), ChatInputChange.gate)
        clock = 1400.0
        chat.gateLineDeadlineDidPass()
        assertEquals(ChatSendGate.reconnecting, chat.composer.gateLine)
        assertEquals(1, chat.gateLineShowCount)
        clock = 1600.0
        chat.apply(inputs(ChatSendGate.open), ChatInputChange.gate)
        assertEquals(ChatSendGate.open, chat.composer.gate)
        assertEquals(ChatSendGate.reconnecting, chat.composer.gateLine)
        assertTrue(chat.hasGateLineTask)
        clock = 1800.0
        chat.gateLineDeadlineDidPass()
        assertEquals(ChatSendGate.open, chat.composer.gateLine)
        assertFalse(chat.hasGateLineTask)
        // Locked is immediate; an outage the lock masked shows at once when the lock lifts (it is not new).
        chat.apply(inputs(ChatSendGate.locked), ChatInputChange.gate)
        assertEquals(ChatSendGate.locked, chat.composer.gateLine)
        chat.apply(inputs(ChatSendGate.offline), ChatInputChange.gate)
        assertEquals(ChatSendGate.offline, chat.composer.gateLine)
        // Reset cancels the waiting task (the offline hold) and makes the next apply immediate.
        chat.apply(inputs(ChatSendGate.open), ChatInputChange.gate)
        assertEquals(ChatSendGate.offline, chat.composer.gateLine)
        assertTrue(chat.hasGateLineTask)
        chat.reset()
        assertFalse(chat.hasGateLineTask)
        assertEquals(ChatComposerSnapshot.initial, chat.composer)
        chat.apply(inputs(ChatSendGate.offline), ChatInputChange.messages)
        assertEquals(ChatSendGate.offline, chat.composer.gateLine)
    }

    @Test
    fun oneAttachmentAtATimeAndCanAcceptPhotoMatchSwift() {
        clock = 0.0
        val log = mutableListOf<ChatCommandRequest>()
        val chat = presenter()
        chat.onCommand = { log.add(it) }
        assertTrue(chat.canAcceptPhoto)
        chat.attachPhoto(firstPhoto, "image/jpeg", "first.jpg")
        assertFalse(chat.canAcceptPhoto)
        chat.attachPhoto("file:///cache/chat-photos/second.jpg", "image/jpeg", "second.jpg")
        assertEquals(1, log.count { it.kind == ChatCommandKind.attachPhoto })
        assertEquals(ChatFailure.oneAttachment, chat.composer.inlineNotice)
        assertEquals(ChatAttachmentPhase.preparing, chat.composer.attachment.phase)
        assertEquals(firstPhoto, chat.composer.attachment.thumbnailKey)
        for (gate in listOf(ChatSendGate.notJoined, ChatSendGate.reconnecting, ChatSendGate.offline, ChatSendGate.locked)) {
            assertFalse(gate.rawValue, presenter(gate).canAcceptPhoto)
        }
        val off = presenter().also { it.apply(inputs(ChatSendGate.open, photosEnabled = false), ChatInputChange.policy) }
        assertFalse(off.canAcceptPhoto)
        val privateMode = presenter()
        privateMode.setPrivateTo(avery)
        assertFalse(privateMode.canAcceptPhoto)
        val ready = ChatAttachmentState(phase = ChatAttachmentPhase.ready, progress = 1.0, thumbnailKey = firstPhoto,
            failure = ChatFailure.none)
        assertFalse(presenter().also { it.apply(inputs(ChatSendGate.open, attachment = ready), ChatInputChange.attachment) }.canAcceptPhoto)
    }

    @Test
    fun theFixtureAddsTheNewStatesAndScripts() {
        clock = 0.0
        assertEquals(ChatFixtureState.draftMultiline, ChatFixtureDriver.state("chat-draft-multiline"))
        assertEquals(ChatFixtureState.suggestionsMentionQuery, ChatFixtureDriver.state("chat-suggestions-mention-query"))
        val multilineShell = MeetingShellPresenter()
        val multiline = ChatFixtureDriver.installOnStage(ChatFixtureState.draftMultiline, multilineShell)
        assertEquals(3, multiline.chat.drafts.text(multiline.chat.composer.draftKey).split("\n").size)
        val queryShell = MeetingShellPresenter()
        val query = ChatFixtureDriver.installOnStage(ChatFixtureState.suggestionsMentionQuery, queryShell)
        assertEquals("@av", query.chat.drafts.text(query.chat.composer.draftKey))
        // photoTwice: one chip, the notice and one attachPhoto in the log.
        val shell = MeetingShellPresenter()
        val driver = ChatFixtureDriver.installOnStage(ChatFixtureState.busy, shell)
        driver.run(ChatFixtureScriptName.photoTwice)
        assertEquals(ChatAttachmentPhase.preparing, shell.chat.composer.attachment.phase)
        assertEquals(ChatFailure.oneAttachment, shell.chat.composer.inlineNotice)
        assertEquals(1, driver.actionsReadout.split("\n").count { it.startsWith("attachPhoto") })
        // gateBlip: Send greys out at once while the line stays hidden (the scripts park on the injected sleep).
        val gateShell = MeetingShellPresenter()
        val gate = ChatFixtureDriver.installOnStage(ChatFixtureState.busy, gateShell)
        gateShell.chat.now = { base + clock }
        gateShell.chat.sleep = { _ -> kotlinx.coroutines.delay(60_000) }
        gate.sleep = { _ -> kotlinx.coroutines.delay(60_000) }
        gate.run(ChatFixtureScriptName.gateBlip)
        assertEquals(ChatSendGate.reconnecting, gateShell.chat.composer.gate)
        assertEquals("gateLine=open gate=reconnecting shows=0", gate.gateLineReadout)
        ChatDiagnostics.driver = null
        ChatDiagnostics.counters = null
    }

    @Test
    fun composerDidFocusBumpsOnlyTheFocusRevision() {
        val actions = ChatRowActions(ChatPresenter(), RuntimeEnvironment.getApplication())
        assertEquals(0, actions.composerFocusRevision)
        actions.composerDidFocus()
        actions.composerDidFocus()
        assertEquals(2, actions.composerFocusRevision)
        assertEquals(0, actions.focusRequest)
    }

    /** P8 on a real reversed list: one row up (the newest row still partly visible) follows, three screens up stays. */
    @Test
    fun focusFollowsOnlyWhileTheNewestRowIsVisible() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val listState = LazyListState()
        var revision by mutableIntStateOf(0)
        activity.setContent {
            Box(Modifier.requiredSize(360.dp, 800.dp)) {
                LazyColumn(state = listState, reverseLayout = true, modifier = Modifier.fillMaxSize()) {
                    items(count = 120, key = { "row-$it" }) { Box(Modifier.fillMaxWidth().height(100.dp)) }
                }
                ChatComposerFocusFollow(listState, reduceMotion = true) { revision }
            }
        }
        settle()
        assertTrue(ChatFocusFollow.newestVisible(listState))
        // One row up: scrolled past the 48 px bottom slop, the newest row still partly visible.
        runBlocking { listState.scrollToItem(0, 60) }
        settle()
        assertEquals(60, listState.firstVisibleItemScrollOffset)
        assertTrue(ChatFocusFollow.newestVisible(listState))
        revision += 1
        settle()
        assertEquals(0, listState.firstVisibleItemIndex)
        assertEquals(0, listState.firstVisibleItemScrollOffset)
        // Three screens up: the newest row is out of view, so a focus gain leaves the position alone.
        runBlocking { listState.scrollToItem(24) }
        settle()
        assertFalse(ChatFocusFollow.newestVisible(listState))
        revision += 1
        settle()
        assertEquals(24, listState.firstVisibleItemIndex)
    }

    /** The animated follow (animations on): it settles on the newest row on the Robolectric frame clock. */
    @Test
    fun focusFollowAnimatesToTheNewestRow() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val listState = LazyListState()
        var revision by mutableIntStateOf(0)
        activity.setContent {
            Box(Modifier.requiredSize(360.dp, 800.dp)) {
                LazyColumn(state = listState, reverseLayout = true, modifier = Modifier.fillMaxSize()) {
                    items(count = 120, key = { "row-$it" }) { Box(Modifier.fillMaxWidth().height(100.dp)) }
                }
                ChatComposerFocusFollow(listState, reduceMotion = false) { revision }
            }
        }
        settle()
        runBlocking { listState.scrollToItem(0, 80) }
        settle()
        assertTrue("the newest row is still partly visible", ChatFocusFollow.newestVisible(listState))
        revision += 1
        repeat(8) { settle() }
        assertEquals(0, listState.firstVisibleItemIndex)
        assertEquals(0, listState.firstVisibleItemScrollOffset)
    }

    private fun settle() {
        repeat(5) {
            Snapshot.sendApplyNotifications()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
        }
    }
}
