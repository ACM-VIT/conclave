package conclave.module

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/** Reduced motion on Android is "Remove animations", an animator duration scale of 0. App-owned motion
 *  branches on it explicitly instead of relying on implicit animator behavior (TG 2.5). */
internal object ConclaveMotion {
    fun reduceMotion(context: Context): Boolean = reduceMotion(
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f))

    fun reduceMotion(animatorDurationScale: Float): Boolean = animatorDurationScale == 0f
}

/** Re-read on ON_RESUME and on every change of the setting: the activity handles configuration changes
 *  itself, so a change made while the app is in the foreground would otherwise never arrive. */
@Composable
internal fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current.applicationContext
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var reduce by remember(context) { mutableStateOf(ConclaveMotion.reduceMotion(context)) }
    DisposableEffect(context, lifecycle) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                reduce = ConclaveMotion.reduceMotion(context)
            }
        }
        val resumed = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) reduce = ConclaveMotion.reduceMotion(context)
        }
        context.contentResolver.registerContentObserver(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer)
        lifecycle.addObserver(resumed)
        onDispose {
            lifecycle.removeObserver(resumed)
            context.contentResolver.unregisterContentObserver(observer)
        }
    }
    return reduce
}
