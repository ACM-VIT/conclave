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
class ChatComposerFieldBridgeTests {
    private val stops = mutableListOf<() -> Unit>()
    private val activities = mutableListOf<ComponentActivity>()

    @After fun dispose() {
        activities.forEach { it.finish() }
        stops.forEach { it() }
        activities.clear()
        stops.clear()
    }

    @Test fun attachAndPhotoSitInsideTheFieldWithSendInTheBottomBand() {
        val activity = activity()
        activity.setContent(runtime()) {
            MaterialTheme {
                Column(Modifier.requiredSize(360.dp, 640.dp)) {
                    ConclaveComposerField("Message", TextFieldState("One\nTwo\nThree"), true, {}, "field", sendLabel = "Send",
                        attach = {
                            IconButton(onClick = {}, modifier = Modifier.testTag("field.gif")) {
                                Icon(ConclaveIcons.GifBoxFill0, contentDescription = "GIFs")
                            }
                        },
                        accessory = {
                            IconButton(onClick = {}, modifier = Modifier.testTag("field.photo")) {
                                Icon(ConclaveIcons.ImageFill0, contentDescription = "Photo")
                            }
                        })
                }
            }
        }
        settle(activity)
        val density = activity.resources.displayMetrics.density
        val field = tagged(activity, "field").boundsInRoot
        val gif = tagged(activity, "field.gif").boundsInRoot
        val photo = tagged(activity, "field.photo").boundsInRoot
        val send = tagged(activity, "field.send").boundsInRoot
        for (button in listOf(gif, photo, send)) {
            assertTrue("every control sits inside the one field container", button.left >= field.left - 1f && button.right <= field.right + 1f)
            assertEquals("every control shares the bottom 56 dp band", field.bottom - 28f * density, button.center.y, 1.5f)
        }
        assertTrue("attach leads the field", gif.right <= field.left + 56f * density)
        assertTrue("photo sits just before send", photo.right <= send.left + 1f && send.right >= field.right - 56f * density)
        assertNotNull(tagged(activity, "field").config.getOrNull(SemanticsActions.SetText))
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
