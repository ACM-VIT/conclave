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

/** Reduced motion on Android is "Remove animations", an animator duration scale of 0. App-owned motion
 *  branches on it explicitly instead of relying on implicit animator behavior (TG 2.5). */
internal object ConclaveMotion {
    fun reduceMotion(context: Context): Boolean = reduceMotion(animatorDurationScale(context))

    fun reduceMotion(animatorDurationScale: Float): Boolean = animatorDurationScale == 0f

    /** The raw animator duration scale; the system accessibility reader reports it too (S70 13 d). */
    fun animatorDurationScale(context: Context): Float =
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)

    // Named specs (F00 9, 2.6 A5; S10 R3; S20 SR2). Durations come from the shared ConclaveMotionDurations, so the
    // iOS constants in ConclaveMotion+iOS.swift read the same numbers. Panels, sheets and snackbars keep their M3
    // motion; nothing here is a pulse, a shimmer or a loop. Under "Remove animations" callers skip travel (banners
    // fade only, chrome is instant), see reduceMotion and rememberReduceMotion.

    /** Banner enter and exit: 120 ms ease-out with an 8 dp move (`motion.fast`). */
    fun <T> fast(): TweenSpec<T> = tween(durationMillis = ConclaveMotionDurations.fastMillis, easing = EaseOut)

    /** The banner travel distance in dp. */
    val bannerTravelDp: Float = ConclaveMotionDurations.bannerTravel.toFloat()

    /** Chrome auto-hide fade: opacity only, 200 ms (M3 short4). */
    fun <T> chromeFade(): TweenSpec<T> = tween(durationMillis = ConclaveMotionDurations.chromeFadeMillis, easing = EaseInOut)

    /** User-driven drag and snap, and the entry bounds (S10 R3): the M3 spatial default spring. */
    fun <T> spatialDefault(): SpringSpec<T> = spring(dampingRatio = ConclaveMotionDurations.spatialDampingRatio.toFloat(),
        stiffness = ConclaveMotionDurations.spatialStiffness.toFloat())

    /** S10 R3: the cross-fade that replaces travel. */
    fun <T> crossFade(): TweenSpec<T> = tween(durationMillis = ConclaveMotionDurations.crossFadeMillis, easing = EaseInOut)

    /** S20 SR2: tiles moving to new frames. */
    fun <T> tileReflow(): SpringSpec<T> = spatialDefault()

    /** S20 SR2: the stage kind changing. */
    fun <T> stageSwap(): TweenSpec<T> = tween(durationMillis = ConclaveMotionDurations.stageSwapMillis,
        easing = CubicBezierEasing(0.2f, 0f, 0f, 1f))

    /** S20 SR2: a pinch zoom settling. */
    fun <T> zoomSnap(): SpringSpec<T> = spatialDefault()
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
