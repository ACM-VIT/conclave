package conclave.module

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Looper
import android.view.View
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView

/** What the view-local gesture route does for one touch (TG 3.4, item 2). */
internal enum class GestureHapticDecision {
    /** The touched control's view played the constant. */
    Played,
    /** Record-only route (no view): the constant would play. */
    Recorded,
    /** No haptic for this kind at this API level. */
    Silent,
    /** Async outcomes go only through the session token and the single root consumer (F1). */
    OutcomeRoute,
}

/**
 * The view-local gesture route for handwritten Compose. Call [gesture] from the click handler of the control
 * the person touched; remote, system and automatic changes never play (R05, R11). Delivery goes through
 * [ConclaveHaptics.perform], whose single-argument call respects the system touch-feedback settings. A null
 * [view] makes the route record-only, which is what the Debug gallery uses.
 */
internal class ConclaveGestureHaptics(private val view: View?, private val debuggable: Boolean) {
    fun decide(kind: FeedbackKind, api: Int = Build.VERSION.SDK_INT): GestureHapticDecision = when {
        kind.isAsyncOutcome -> GestureHapticDecision.OutcomeRoute
        ConclaveHaptics.constant(kind, api) == null -> GestureHapticDecision.Silent
        view == null -> GestureHapticDecision.Recorded
        else -> GestureHapticDecision.Played
    }

    fun gesture(kind: FeedbackKind): GestureHapticDecision {
        check(Looper.myLooper() == Looper.getMainLooper()) { "gesture haptics run on the main thread" }
        if (kind.isAsyncOutcome) {
            // Debug assertion: an outcome reaching a gesture route is a wiring bug.
            check(!debuggable) { "${kind.rawValue} is an async outcome; deliver it through the session token" }
            return GestureHapticDecision.OutcomeRoute
        }
        val decision = decide(kind)
        val view = view ?: return decision
        if (decision == GestureHapticDecision.Played) ConclaveHaptics.perform(view, kind)
        return decision
    }
}

/** Holds the composition's view; the Debug assertion follows the app's debuggable flag. */
@Composable
internal fun rememberConclaveHaptics(): ConclaveGestureHaptics {
    val view = LocalView.current
    val context = LocalContext.current.applicationContext
    return remember(view, context) { ConclaveGestureHaptics(view = view, debuggable = isDebuggableApp(context)) }
}

internal fun isDebuggableApp(context: Context): Boolean =
    context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
