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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.AndroidUiFrameClock
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.platform.testTag
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28], qualifiers = "w360dp-h800dp")
class ChatRevealBridgeTests {
    private val stops = mutableListOf<() -> Unit>()
    private val activities = mutableListOf<ComponentActivity>()

    @After fun dispose() {
        activities.forEach { it.finish() }
        stops.forEach { it() }
        activities.clear()
        stops.clear()
    }

    @Test fun aGrowingRowKeepsItsPlaceWhenScrolledUpAndPinsTheBottomWhenAtTheEnd() {
        val activity = activity()
        var grown by mutableStateOf(false)
        var list: LazyListState? = null
        activity.setContent(runtime()) {
            MaterialTheme {
                val state = remember { LazyListState(firstVisibleItemIndex = 6) }
                list = state
                val atBottom = remember { derivedStateOf { !state.canScrollBackward } }
                val anchor = remember { ChatTimelineAnchor(state, atBottom) }
                Box(Modifier.requiredSize(360.dp, 400.dp)) {
                    CompositionLocalProvider(LocalChatTimelineAnchor provides anchor) {
                        LazyColumn(state = state, reverseLayout = true, modifier = Modifier.fillMaxSize()) {
                            items(count = 40, key = { "row-$it" }) { index ->
                                Column(Modifier.fillMaxWidth().testTag("row-$index")) {
                                    Box(Modifier.fillMaxWidth().height(40.dp).testTag("row-$index.bubble"))
                                    if (index == 8 || index == 0) {
                                        ChatAnchoredReveal(present = grown, anchorKey = "row-$index") { Box(Modifier.fillMaxWidth().height(48.dp)) }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        settle(activity)
        val density = activity.resources.displayMetrics.density
        val bubbleBefore = tagged(activity, "row-8.bubble").boundsInRoot
        grown = true
        settle(activity)
        val bubbleAfter = tagged(activity, "row-8.bubble").boundsInRoot
        assertEquals("the reacted bubble does not move while the reader is scrolled up", bubbleBefore.top, bubbleAfter.top, 1.5f)
        assertEquals(88f * density, tagged(activity, "row-8").boundsInRoot.height, 1.5f)

        grown = false
        settle(activity)
        assertEquals("collapsing keeps the bubble in place too", bubbleBefore.top, tagged(activity, "row-8.bubble").boundsInRoot.top, 1.5f)
        assertEquals(40f * density, tagged(activity, "row-8").boundsInRoot.height, 1.5f)

        list!!.requestScrollToItem(0)
        settle(activity)
        val endBefore = tagged(activity, "row-0").boundsInRoot
        grown = true
        settle(activity)
        val endAfter = tagged(activity, "row-0").boundsInRoot
        assertEquals("at the end the newest row stays pinned to the bottom", endBefore.bottom, endAfter.bottom, 1.5f)
        assertEquals("and grows upward into view", endBefore.top - 48f * density, endAfter.top, 1.5f)
    }

    @Test fun theMessageAtTheReadingPointStaysStillWhateverElseGainsReactions() {
        val activity = activity()
        var grownRows by mutableStateOf(setOf<Int>())
        activity.setContent(runtime()) {
            MaterialTheme {
                val state = remember { LazyListState(firstVisibleItemIndex = 6, firstVisibleItemScrollOffset = 30) }
                val atBottom = remember { derivedStateOf { !state.canScrollBackward } }
                val anchor = remember { ChatTimelineAnchor(state, atBottom) }
                Box(Modifier.requiredSize(360.dp, 400.dp)) {
                    CompositionLocalProvider(LocalChatTimelineAnchor provides anchor) {
                        LazyColumn(state = state, reverseLayout = true, modifier = Modifier.fillMaxSize().testTag("list")) {
                            items(count = 40, key = { "row-$it" }) { index ->
                                Column(Modifier.fillMaxWidth().testTag("row-$index")) {
                                    Box(Modifier.fillMaxWidth().height(40.dp).testTag("row-$index.bubble"))
                                    ChatAnchoredReveal(present = index in grownRows, anchorKey = "row-$index") {
                                        Box(Modifier.fillMaxWidth().height(48.dp))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        settle(activity)
        val visible = (6..16).filter { index -> nodes(activity).any { it.config.getOrNull(SemanticsProperties.TestTag) == "row-$index.bubble" } }
        val viewportCenter = tagged(activity, "list").boundsInRoot.center.y
        val center = visible.minByOrNull { kotlin.math.abs(tagged(activity, "row-$it.bubble").boundsInRoot.center.y - viewportCenter) }!!
        val before = tagged(activity, "row-$center.bubble").boundsInRoot.top

        grownRows = setOf(center + 3)
        settle(activity)
        assertEquals("a reaction above the reading point leaves it still", before, tagged(activity, "row-$center.bubble").boundsInRoot.top, 1.5f)

        grownRows = setOf(center + 3, center - 2, center - 3)
        settle(activity)
        assertEquals("two reactions below it at once still leave it still", before, tagged(activity, "row-$center.bubble").boundsInRoot.top, 1.5f)
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
        repeat(16) {
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
