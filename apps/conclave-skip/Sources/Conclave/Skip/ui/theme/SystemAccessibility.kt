package conclave.module

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.database.ContentObserver
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import androidx.annotation.RequiresApi
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/*
 * The system accessibility readers (S70 13 d): one composed state from TalkBack touch exploration, any running
 * accessibility service, font scale and Bold Text, "Remove animations", the contrast level (API 34) and the
 * recommended timeout (API 29). Every value updates live from a listener or the configuration; the activity
 * handles configuration changes itself, so ON_RESUME also re-reads everything. Presenters get the shared
 * SystemAccessibilityState through state(); leaves read the fields they need. High-contrast tokens arrive with WP4
 * (owner Q10): the contrast reader exists now so WP4 only maps values.
 */

/** Flags for the recommended auto-hide timeout: the chrome holds controls and icons (S20 8 d). */
internal const val CONCLAVE_TIMEOUT_FLAGS =
    AccessibilityManager.FLAG_CONTENT_CONTROLS or AccessibilityManager.FLAG_CONTENT_ICONS

internal data class ConclaveSystemAccessibility(
    val touchExploration: Boolean,
    val anyServiceEnabled: Boolean,
    val fontScale: Float,
    /** Configuration.fontWeightAdjustment (API 31); 0 below. */
    val fontWeightAdjustment: Int,
    val animatorDurationScale: Float,
    /** UiModeManager.getContrast() (API 34); null below. */
    val contrastLevel: Float?,
    /** getRecommendedTimeoutMillis for the 5 s auto-hide base (API 29); null on API 28. */
    val recommendedTimeoutMillis: Int?,
) {
    val removeAnimations: Boolean get() = ConclaveMotion.reduceMotion(animatorDurationScale)
    val boldText: Boolean get() = SystemAccessibilityMapping.androidBoldText(fontWeightAdjustment = fontWeightAdjustment)
    val increasedContrast: Boolean
        get() = SystemAccessibilityMapping.androidIncreasedContrast(contrastLevel = contrastLevel?.toDouble())

    /** The shared state pushed into the stage presenter and the toast hosts. */
    fun state(): SystemAccessibilityState = SystemAccessibilityMapping.androidState(
        touchExploration = touchExploration, anyServiceEnabled = anyServiceEnabled,
        animatorDurationScale = animatorDurationScale.toDouble(),
        recommendedTimeoutMillis = recommendedTimeoutMillis?.toDouble())

    companion object {
        /** Pure API gating for host tests: values a level does not have read as their absence. */
        fun from(
            api: Int, touchExploration: Boolean, anyServiceEnabled: Boolean, fontScale: Float, fontWeightAdjustment: Int,
            animatorDurationScale: Float, contrastLevel: Float?, recommendedTimeoutMillis: Int?,
        ): ConclaveSystemAccessibility = ConclaveSystemAccessibility(
            touchExploration = touchExploration,
            anyServiceEnabled = anyServiceEnabled,
            fontScale = fontScale,
            fontWeightAdjustment = if (api >= 31) fontWeightAdjustment else 0,
            animatorDurationScale = animatorDurationScale,
            contrastLevel = if (api >= 34) contrastLevel else null,
            recommendedTimeoutMillis = if (api >= 29) recommendedTimeoutMillis else null,
        )

        fun read(context: Context, configuration: Configuration): ConclaveSystemAccessibility {
            val manager = context.getSystemService(AccessibilityManager::class.java)
            val api = Build.VERSION.SDK_INT
            val base = SystemAccessibilityDefaults.autoHideBaseMillis.toInt()
            return from(
                api = api,
                touchExploration = manager?.isTouchExplorationEnabled == true,
                anyServiceEnabled = manager?.isEnabled == true,
                fontScale = configuration.fontScale,
                fontWeightAdjustment = if (api >= 31) SystemAccessibilityApi31.fontWeightAdjustment(configuration) else 0,
                animatorDurationScale = ConclaveMotion.animatorDurationScale(context),
                contrastLevel = if (api >= 34) SystemAccessibilityApi34.contrast(context) else null,
                recommendedTimeoutMillis = if (api >= 29 && manager != null) SystemAccessibilityApi29.timeout(manager, base) else null,
            )
        }
    }
}

/**
 * Composes the readers. The state object changes only when a value changes (data class equality), so a reader
 * at the root recomposes only its own readers on a settings change.
 */
@Composable
internal fun rememberSystemAccessibility(): ConclaveSystemAccessibility {
    val context = LocalContext.current.applicationContext
    val configuration = LocalConfiguration.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var listened by remember(context) { mutableStateOf(ConclaveSystemAccessibility.read(context, configuration)) }
    DisposableEffect(context, lifecycle) {
        val manager = context.getSystemService(AccessibilityManager::class.java)
        fun refresh() {
            val next = ConclaveSystemAccessibility.read(context, context.resources.configuration)
            if (next != listened) listened = next
        }
        val touch = AccessibilityManager.TouchExplorationStateChangeListener { refresh() }
        val services = AccessibilityManager.AccessibilityStateChangeListener { refresh() }
        val animator = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) = refresh()
        }
        val resumed = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) refresh() }
        manager?.addTouchExplorationStateChangeListener(touch)
        manager?.addAccessibilityStateChangeListener(services)
        context.contentResolver.registerContentObserver(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, animator)
        val stopContrast = if (Build.VERSION.SDK_INT >= 34) SystemAccessibilityApi34.listen(context) { refresh() } else null
        lifecycle.addObserver(resumed)
        onDispose {
            lifecycle.removeObserver(resumed)
            stopContrast?.invoke()
            context.contentResolver.unregisterContentObserver(animator)
            manager?.removeAccessibilityStateChangeListener(services)
            manager?.removeTouchExplorationStateChangeListener(touch)
        }
    }
    // Font scale and Bold Text arrive through the configuration, never through a listener.
    val fontWeight = if (Build.VERSION.SDK_INT >= 31) SystemAccessibilityApi31.fontWeightAdjustment(configuration) else 0
    val fontScale = configuration.fontScale
    return remember(listened, fontScale, fontWeight) { listened.copy(fontScale = fontScale, fontWeightAdjustment = fontWeight) }
}

/** Version-gated calls in their own classes, so older devices never load the newer APIs. */
@RequiresApi(29)
private object SystemAccessibilityApi29 {
    fun timeout(manager: AccessibilityManager, base: Int): Int =
        manager.getRecommendedTimeoutMillis(base, CONCLAVE_TIMEOUT_FLAGS)
}

@RequiresApi(31)
private object SystemAccessibilityApi31 {
    fun fontWeightAdjustment(configuration: Configuration): Int = configuration.fontWeightAdjustment
}

@RequiresApi(34)
private object SystemAccessibilityApi34 {
    fun contrast(context: Context): Float? = context.getSystemService(UiModeManager::class.java)?.contrast

    fun listen(context: Context, onChange: () -> Unit): () -> Unit {
        val manager = context.getSystemService(UiModeManager::class.java) ?: return {}
        val listener = UiModeManager.ContrastChangeListener { onChange() }
        manager.addContrastChangeListener(context.mainExecutor, listener)
        return { manager.removeContrastChangeListener(listener) }
    }
}
