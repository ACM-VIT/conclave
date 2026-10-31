package conclave.module

import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.AndroidUiFrameClock
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.unit.dp
import java.time.Duration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28], qualifiers = "w360dp-h800dp")
class OwnerChatPolishTests {
    private val stops = mutableListOf<() -> Unit>()
    private val activities = mutableListOf<ComponentActivity>()

    @After fun dispose() {
        activities.forEach { it.finish() }
        stops.forEach { it() }
        activities.clear()
        stops.clear()
    }

    @Test fun jumpPillRequiresUnseenMessagesAwayFromBottom() {
        assertFalse(ChatTimelinePolicy.showsJumpToLatest(isAtBottom = false, unseenCount = 0))
        assertFalse(ChatTimelinePolicy.showsJumpToLatest(isAtBottom = true, unseenCount = 3))
        assertTrue(ChatTimelinePolicy.showsJumpToLatest(isAtBottom = false, unseenCount = 1))
    }

    @Test fun openingPrecedenceMatchesSwiftAndKeepsReplyFailuresDistinct() {
        assertEquals("quoted", ChatTimelinePolicy.initialTarget(focusId = "quoted", firstUnreadId = "new", newestId = "last"))
        assertEquals("unread", ChatTimelinePolicy.initialTarget(focusId = "", firstUnreadId = "new", newestId = "last"))
        assertEquals("last", ChatTimelinePolicy.initialTarget(focusId = "", firstUnreadId = "", newestId = "last"))
        assertEquals("", ChatTimelinePolicy.initialTarget(focusId = "", firstUnreadId = "", newestId = ""))
        assertEquals(ChatFailure.replyUnavailable, ChatFailurePolicy.failure(serverMessage = "reply target is no longer available."))
        assertEquals(ChatFailure.privateTargetLeft, ChatFailurePolicy.failure(serverMessage = "target is no longer available."))
    }

    @Test fun shortHistoryStartsAtTheTopAndReadsOldestToNewest() {
        val base = 1_800_014_400_000.0
        val local = "jordan@example.com#s1"
        val peer = "avery@example.com#w1"
        val chat = ChatPresenter()
        chat.now = { base + 600_000.0 }
        chat.apply(ChatInputs.make(callSession = 1, roomId = "room-a", localUserId = local, localName = "Jordan Lee",
            messages = skip.lib.Array(listOf(
                ChatMessageInput.make(id = "first", senderId = peer, senderName = "Avery Lee", content = "First",
                    timestampMillis = base, isHistory = true),
                ChatMessageInput.make(id = "second", senderId = peer, senderName = "Avery Lee", content = "Second",
                    timestampMillis = base + 30_000.0, isHistory = true),
                ChatMessageInput.make(id = "mine", senderId = local, senderName = "Jordan Lee", content = "Mine",
                    timestampMillis = base + 40_000.0, isOwn = true, isHistory = true),
            )), gate = ChatSendGate.allowed), ChatInputChange.messages)
        val cache = ChatTimelineCache(chat)
        val activity = activity()
        val actions = ChatRowActions(chat, activity)
        activity.setContent(runtime()) {
            MaterialTheme {
                Box(Modifier.requiredSize(360.dp, 640.dp)) {
                    ChatTimeline(cache, chat, actions, sidePane = false, reservation = PaddingValues(0.dp))
                }
            }
        }
        settle(activity)
        val timeline = tagged(activity, "chat.timeline").boundsInRoot
        val first = tagged(activity, "chat.row.first").boundsInRoot
        val second = tagged(activity, "chat.row.second").boundsInRoot
        val mine = tagged(activity, "chat.row.mine").boundsInRoot
        assertTrue("the oldest row starts near the top", first.top - timeline.top < timeline.height / 4f)
        assertTrue("chronology stays top to bottom", first.top < second.top && second.top < mine.top)
        assertTrue("short history leaves its space below", mine.bottom < timeline.bottom - timeline.height / 4f)
        assertTrue("no initial jump control for a fully visible history", nodes(activity).none {
            it.config.getOrNull(SemanticsProperties.TestTag) == "chat.jumpPill"
        })
        assertEquals(listOf("mine", "second", "first"), cache.current().ids)
        assertTrue(chat.rows.entry("first").row.isGroupStart)
        assertFalse(chat.rows.entry("second").row.isGroupStart)
        assertTrue(chat.rows.entry("second").row.isGroupEnd)
        assertTrue(chat.rows.entry("mine").row.isOwn)
    }

    @Test fun openingUnreadHistoryShowsTheFirstUnreadBelowItsDivider() {
        val base = 1_800_014_400_000.0
        val local = "jordan@example.com#s1"
        val peer = "avery@example.com#w1"
        val chat = ChatPresenter()
        chat.now = { base + 600_000.0 }
        val messages = (0 until 25).map { index ->
            ChatMessageInput.make(id = "old-$index", senderId = peer, senderName = "Avery Lee",
                content = "Earlier message $index", timestampMillis = base + index * 1_000.0, isHistory = true)
        }.toMutableList()
        fun inputs() = ChatInputs.make(callSession = 1, roomId = "room-a", localUserId = local, localName = "Jordan Lee",
            messages = skip.lib.Array(messages.toList()), gate = ChatSendGate.allowed)
        chat.apply(inputs(), ChatInputChange.messages)
        messages.addAll((0 until 20).map { index ->
            ChatMessageInput.make(id = "new-$index", senderId = peer, senderName = "Avery Lee",
                content = "Unread message $index", timestampMillis = base + (25 + index) * 1_000.0, isHistory = false)
        })
        chat.apply(inputs(), ChatInputChange.messages)
        chat.panelDidOpen(destination = ChatDestination.none, targetId = "")
        assertEquals("new-0", chat.timeline.firstUnreadId)
        val cache = ChatTimelineCache(chat)
        val activity = activity()
        val actions = ChatRowActions(chat, activity)
        activity.setContent(runtime()) {
            MaterialTheme {
                Box(Modifier.requiredSize(360.dp, 640.dp)) {
                    ChatTimeline(cache, chat, actions, sidePane = false, reservation = PaddingValues(0.dp))
                }
            }
        }
        settle(activity)
        val viewport = tagged(activity, "chat.timeline").boundsInRoot
        val divider = tagged(activity, "chat.row.unread").boundsInRoot
        val firstUnread = tagged(activity, "chat.row.new-0").boundsInRoot
        assertTrue("the unread divider is visible above the first unread", divider.top >= viewport.top && divider.bottom <= firstUnread.top)
        assertTrue("the first unread begins inside the upper half of the viewport", firstUnread.top < viewport.top + viewport.height / 2f)
        assertTrue("the first unread is visible on opening", firstUnread.top >= viewport.top && firstUnread.bottom <= viewport.bottom)
    }

    @Test fun bothComposerOverloadsKeepSendInTheBottomBandWithoutLosingInputSemantics() {
        var sends = 0
        val activity = activity()
        activity.setContent(runtime()) {
            MaterialTheme {
                Column(Modifier.requiredSize(360.dp, 640.dp)) {
                    ConclaveComposerField("Message", "One", {}, true, { sends += 1 }, "value.one", sendLabel = "Send")
                    ConclaveComposerField("Message", "One\nTwo\nThree", {}, true, { sends += 1 }, "value.many", sendLabel = "Send")
                    ConclaveComposerField("Message", TextFieldState("One"), true, { sends += 1 }, "state.one", sendLabel = "Send")
                    ConclaveComposerField("Message", TextFieldState("One\nTwo\nThree"), false, { sends += 1 }, "state.many",
                        sendLabel = "Send", sendDisabledReason = "Reconnecting")
                }
            }
        }
        settle(activity)
        val density = activity.resources.displayMetrics.density
        for (id in listOf("value.one", "value.many", "state.one", "state.many")) {
            val field = tagged(activity, id)
            val send = tagged(activity, "$id.send")
            assertEquals("Send stays in the bottom 56 dp band: $id", field.boundsInRoot.bottom - 28f * density,
                send.boundsInRoot.center.y, 1.5f)
            assertNotNull("native text editing semantics stay on the field", field.config.getOrNull(SemanticsActions.SetText))
        }
        assertTrue(tagged(activity, "value.many").boundsInRoot.height > tagged(activity, "value.one").boundsInRoot.height)
        assertTrue(tagged(activity, "state.many").boundsInRoot.height > tagged(activity, "state.one").boundsInRoot.height)
        assertEquals("Reconnecting", tagged(activity, "state.many.send").config.getOrNull(SemanticsProperties.StateDescription))
        assertNotNull(tagged(activity, "state.many.send").config.getOrNull(SemanticsProperties.Disabled))
        assertTrue(tagged(activity, "value.many.send").config[SemanticsActions.OnClick].action!!.invoke())
        assertEquals(1, sends)
    }

    @Test fun stackPaddingCanBeOwnedByThePageWithoutChangingTheDefault() {
        var defaultField = Rect.Zero
        var pageField = Rect.Zero
        val activity = activity()
        activity.setContent(runtime()) {
            Column(Modifier.requiredSize(360.dp, 200.dp)) {
                ConclaveComposerStack(identifier = "default") {
                    Box(Modifier.fillMaxWidth().height(56.dp).onGloballyPositioned { defaultField = it.boundsInRoot() })
                }
                ConclaveComposerStack(identifier = "page", contentPadding = PaddingValues(0.dp)) {
                    Box(Modifier.fillMaxWidth().height(56.dp).onGloballyPositioned { pageField = it.boundsInRoot() })
                }
            }
        }
        settle(activity)
        val density = activity.resources.displayMetrics.density
        assertEquals("default retains 16 dp at each side", 32f * density, pageField.width - defaultField.width, 1f)
        assertEquals("page-owned padding is not doubled", tagged(activity, "page").boundsInRoot.left, pageField.left, 1f)
    }

    @Test fun aLandingChipKeepsOneSpokenNodeAndFollowsItsCount() {
        var count by mutableIntStateOf(1)
        val activity = activity()
        activity.setContent(runtime()) {
            MaterialTheme {
                Box(Modifier.requiredSize(360.dp, 120.dp)) {
                    ConclaveReactionChipRow(
                        chips = listOf(ConclaveReactionChipModel(id = "a", emoji = "\uD83D\uDC4D", count = count, isMine = false,
                            canToggle = true, accessibilityLabel = "Thumbs up")),
                        identifier = "chips", onToggle = {}, initialIds = emptySet(),
                    )
                }
            }
        }
        settle(activity)
        val landed = mergedTagged(activity, "chips.a")
        assertEquals(listOf("Thumbs up"), landed.config.getOrNull(SemanticsProperties.ContentDescription))
        assertEquals("1", landed.config.getOrNull(SemanticsProperties.StateDescription))
        assertNull("the emoji and count texts stay out of the spoken chip", landed.config.getOrNull(SemanticsProperties.Text))
        count = 2
        settle(activity)
        val rolled = mergedTagged(activity, "chips.a")
        assertEquals("2", rolled.config.getOrNull(SemanticsProperties.StateDescription))
        assertNull("the count roll adds no spoken text", rolled.config.getOrNull(SemanticsProperties.Text))
    }

    private fun mergedTagged(activity: ComponentActivity, tag: String): SemanticsNode {
        fun descend(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap { descend(it) }
        return roots(activity.window.decorView).flatMap { descend(it.semanticsOwner.rootSemanticsNode) }
            .firstOrNull { it.config.getOrNull(SemanticsProperties.TestTag) == tag } ?: error("Missing merged semantics tag: $tag")
    }

    private fun activity(): ComponentActivity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get().also {
        activities.add(it)
    }

    private fun runtime(): Recomposer {
        val context = Dispatchers.Main + AndroidUiFrameClock(Choreographer.getInstance())
        val recomposer = Recomposer(context)
        val scope = CoroutineScope(context)
        scope.launch(start = CoroutineStart.UNDISPATCHED) { recomposer.runRecomposeAndApplyChanges() }
        val handler = Handler(Looper.getMainLooper())
        var pending = false
        val observer = Snapshot.registerGlobalWriteObserver {
            if (!pending) {
                pending = true
                handler.post { pending = false; Snapshot.sendApplyNotifications() }
            }
        }
        stops.add { observer.dispose(); recomposer.cancel(); scope.cancel() }
        return recomposer
    }

    private fun settle(activity: ComponentActivity) {
        repeat(8) {
            Snapshot.sendApplyNotifications()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
            roots(activity.window.decorView).forEach { if (it.hasPendingMeasureOrLayout) it.measureAndLayoutForTest() }
        }
    }

    private fun roots(view: View): List<ViewRootForTest> {
        val found = mutableListOf<ViewRootForTest>()
        if (view is ViewRootForTest) found.add(view)
        if (view is ViewGroup) for (index in 0 until view.childCount) found.addAll(roots(view.getChildAt(index)))
        return found
    }

    private fun nodes(activity: ComponentActivity): List<SemanticsNode> {
        fun descend(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap { descend(it) }
        return roots(activity.window.decorView).flatMap { descend(it.semanticsOwner.unmergedRootSemanticsNode) }
    }

    private fun tagged(activity: ComponentActivity, tag: String): SemanticsNode = nodes(activity).firstOrNull {
        it.config.getOrNull(SemanticsProperties.TestTag) == tag
    } ?: error("Missing semantics tag: $tag")
}
