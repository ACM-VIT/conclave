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

internal enum class GestureHapticDecision {

    Played,

    Recorded,

    Silent,

    OutcomeRoute,
}

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

            check(!debuggable) { "${kind.rawValue} is an async outcome; deliver it through the session token" }
            return GestureHapticDecision.OutcomeRoute
        }
        val decision = decide(kind)
        val view = view ?: return decision
        if (decision == GestureHapticDecision.Played) ConclaveHaptics.perform(view, kind)
        return decision
    }
}

@Composable
internal fun rememberConclaveHaptics(): ConclaveGestureHaptics {
    val view = LocalView.current
    val context = LocalContext.current.applicationContext
    return remember(view, context) { ConclaveGestureHaptics(view = view, debuggable = isDebuggableApp(context)) }
}

internal fun isDebuggableApp(context: Context): Boolean =
    context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
