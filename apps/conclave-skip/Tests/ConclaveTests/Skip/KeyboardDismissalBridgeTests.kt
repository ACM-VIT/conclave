package conclave.module

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.InputDevice
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Spacer
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.AndroidUiFrameClock
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import java.time.Duration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28], qualifiers = "w360dp-h800dp")
class KeyboardDismissalBridgeTests {
    private val stops = mutableListOf<() -> Unit>()
    private val activities = mutableListOf<ComponentActivity>()

    @After fun dispose() {
        activities.forEach { it.finish() }
        stops.forEach { it() }
        activities.clear()
        stops.clear()
    }

    @Test fun nameDoneAndCodeGoClearFocusHideKeyboardAndSubmitOnce() {
        for (kind in listOf(ConclaveTextFieldKind.Name, ConclaveTextFieldKind.Code)) {
            val activity = activity()
            var focused = false
            var hides = 0
            var submits = 0
            val keyboard = object : androidx.compose.ui.platform.SoftwareKeyboardController {
                override fun show() {}
                override fun hide() { hides++ }
            }
            activity.setContent(runtime()) {
                CompositionLocalProvider(androidx.compose.ui.platform.LocalSoftwareKeyboardController provides keyboard) {
                    MaterialTheme {
                        ConclaveTextField("Your name", "Avery", {}, kind, "field",
                            modifier = Modifier.onFocusChanged { focused = it.isFocused },
                            onSubmit = { submits++ })
                    }
                }
            }
            settle(activity)
            tagged(activity, "field").config[SemanticsActions.RequestFocus].action!!.invoke()
            settle(activity)
            assertTrue(focused)
            tagged(activity, "field").config[SemanticsActions.OnImeAction].action!!.invoke()
            settle(activity)
            org.junit.Assert.assertFalse(focused)
            assertTrue(hides >= 1)
            assertEquals(1, submits)
        }
    }

    @Test fun fieldTapKeepsFocusWhileOutsideTapAndPhysicalScrollDismiss() {
        val activity = activity()
        var focused = false
        var hides = 0
        val keyboard = object : androidx.compose.ui.platform.SoftwareKeyboardController {
            override fun show() {}
            override fun hide() { hides++ }
        }
        activity.setContent(runtime()) {
            CompositionLocalProvider(androidx.compose.ui.platform.LocalSoftwareKeyboardController provides keyboard) {
                MaterialTheme {
                    Column(Modifier.fillMaxSize().dismissKeyboardOnInteraction().verticalScroll(rememberScrollState())) {
                        ConclaveTextField("Your name", "Avery", {}, ConclaveTextFieldKind.Name, "field",
                            modifier = Modifier.onFocusChanged { focused = it.isFocused })
                        Spacer(Modifier.height(1600.dp))
                    }
                }
            }
        }
        settle(activity)
        val composeRoot = roots(activity.window.decorView).first()
        (composeRoot as ViewTreeObserver.OnTouchModeChangeListener).onTouchModeChanged(true)
        settle(activity)
        val location = IntArray(2)
        (composeRoot as View).getLocationInWindow(location)
        val field = tagged(activity, "field").boundsInRoot.translate(
            androidx.compose.ui.geometry.Offset(location[0].toFloat(), location[1].toFloat()))
        touch(activity, field.center.x, field.center.y)
        assertTrue("a real field tap must retain focus", focused)
        assertEquals(0, hides)
        touch(activity, field.center.x, field.bottom + 60f)
        org.junit.Assert.assertFalse(focused)
        assertTrue(hides >= 1)
        touch(activity, field.center.x, field.center.y)
        assertTrue(focused)
        val beforeDrag = hides
        touch(activity, field.center.x, field.bottom + 160f, dragY = -120f)
        org.junit.Assert.assertFalse(focused)
        assertTrue(hides > beforeDrag)
    }

    private fun touch(activity: ComponentActivity, x: Float, y: Float, dragY: Float = 0f) {
        val down = SystemClock.uptimeMillis()
        val steps = mutableListOf(Triple(MotionEvent.ACTION_DOWN, 0L, y))
        if (dragY != 0f) steps.add(Triple(MotionEvent.ACTION_MOVE, 40L, y + dragY))
        steps.add(Triple(MotionEvent.ACTION_UP, 80L, y + dragY))
        for ((action, elapsed, position) in steps) {
            val event = MotionEvent.obtain(down, down + elapsed, action, x, position, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            activity.window.decorView.dispatchTouchEvent(event)
            event.recycle()
            settle(activity)
        }
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
