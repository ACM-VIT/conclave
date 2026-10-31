package conclave.module

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.EaseOut
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.TweenSpec
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
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

internal object ConclaveMotion {
    fun reduceMotion(context: Context): Boolean = reduceMotion(animatorDurationScale(context))

    fun reduceMotion(animatorDurationScale: Float): Boolean = animatorDurationScale == 0f

    fun animatorDurationScale(context: Context): Float =
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)

    fun <T> fast(): TweenSpec<T> = tween(durationMillis = ConclaveMotionDurations.fastMillis, easing = EaseOut)

    val bannerTravelDp: Float = ConclaveMotionDurations.bannerTravel.toFloat()

    fun <T> chromeFade(): TweenSpec<T> = tween(durationMillis = ConclaveMotionDurations.chromeFadeMillis, easing = EaseInOut)

    fun <T> spatialDefault(): SpringSpec<T> = spring(dampingRatio = ConclaveMotionDurations.spatialDampingRatio.toFloat(),
        stiffness = ConclaveMotionDurations.spatialStiffness.toFloat())

    fun <T> crossFade(): TweenSpec<T> = tween(durationMillis = ConclaveMotionDurations.crossFadeMillis, easing = EaseInOut)

    fun <T> tileReflow(): SpringSpec<T> = spatialDefault()

    fun <T> stageSwap(): TweenSpec<T> = tween(durationMillis = ConclaveMotionDurations.stageSwapMillis,
        easing = CubicBezierEasing(0.2f, 0f, 0f, 1f))

    fun <T> zoomSnap(): SpringSpec<T> = spatialDefault()
}

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
