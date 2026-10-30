package conclave.module

import android.accessibilityservice.AccessibilityServiceInfo
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

internal const val CONCLAVE_TIMEOUT_FLAGS =
    AccessibilityManager.FLAG_CONTENT_CONTROLS or AccessibilityManager.FLAG_CONTENT_ICONS

internal data class ConclaveSystemAccessibility(
    val touchExploration: Boolean,
    val anyServiceEnabled: Boolean,
    val fontScale: Float,

    val fontWeightAdjustment: Int,
    val animatorDurationScale: Float,

    val contrastLevel: Float?,

    val recommendedTimeoutMillis: Int?,
) {
    val removeAnimations: Boolean get() = ConclaveMotion.reduceMotion(animatorDurationScale)
    val boldText: Boolean get() = SystemAccessibilityMapping.androidBoldText(fontWeightAdjustment = fontWeightAdjustment)
    val increasedContrast: Boolean
        get() = SystemAccessibilityMapping.androidIncreasedContrast(contrastLevel = contrastLevel?.toDouble())

    fun state(): SystemAccessibilityState = SystemAccessibilityMapping.androidState(
        touchExploration = touchExploration, anyServiceEnabled = anyServiceEnabled,
        animatorDurationScale = animatorDurationScale.toDouble(),
        recommendedTimeoutMillis = recommendedTimeoutMillis?.toDouble())

    companion object {

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
                anyServiceEnabled = manager != null && spokenFeedbackEnabled(manager),
                fontScale = configuration.fontScale,
                fontWeightAdjustment = if (api >= 31) SystemAccessibilityApi31.fontWeightAdjustment(configuration) else 0,
                animatorDurationScale = ConclaveMotion.animatorDurationScale(context),
                contrastLevel = if (api >= 34) SystemAccessibilityApi34.contrast(context) else null,
                recommendedTimeoutMillis = if (api >= 29 && manager != null) SystemAccessibilityApi29.timeout(manager, base) else null,
            )
        }

        fun spokenFeedbackEnabled(manager: AccessibilityManager): Boolean =
            manager.isEnabled && manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_SPOKEN)
                .any { (it.feedbackType and AccessibilityServiceInfo.FEEDBACK_SPOKEN) != 0 }
    }
}

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
        val stopServiceList = if (Build.VERSION.SDK_INT >= 33 && manager != null) {
            SystemAccessibilityApi33.listen(context, manager) { refresh() }
        } else null
        context.contentResolver.registerContentObserver(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, animator)
        val stopContrast = if (Build.VERSION.SDK_INT >= 34) SystemAccessibilityApi34.listen(context) { refresh() } else null
        lifecycle.addObserver(resumed)
        onDispose {
            lifecycle.removeObserver(resumed)
            stopContrast?.invoke()
            context.contentResolver.unregisterContentObserver(animator)
            stopServiceList?.invoke()
            manager?.removeAccessibilityStateChangeListener(services)
            manager?.removeTouchExplorationStateChangeListener(touch)
        }
    }

    val fontWeight = if (Build.VERSION.SDK_INT >= 31) SystemAccessibilityApi31.fontWeightAdjustment(configuration) else 0
    val fontScale = configuration.fontScale
    return remember(listened, fontScale, fontWeight) { listened.copy(fontScale = fontScale, fontWeightAdjustment = fontWeight) }
}

@RequiresApi(29)
private object SystemAccessibilityApi29 {
    fun timeout(manager: AccessibilityManager, base: Int): Int =
        manager.getRecommendedTimeoutMillis(base, CONCLAVE_TIMEOUT_FLAGS)
}

@RequiresApi(31)
private object SystemAccessibilityApi31 {
    fun fontWeightAdjustment(configuration: Configuration): Int = configuration.fontWeightAdjustment
}

@RequiresApi(33)
private object SystemAccessibilityApi33 {
    fun listen(context: Context, manager: AccessibilityManager, onChange: () -> Unit): () -> Unit {
        val listener = AccessibilityManager.AccessibilityServicesStateChangeListener { onChange() }
        manager.addAccessibilityServicesStateChangeListener(context.mainExecutor, listener)
        return { manager.removeAccessibilityServicesStateChangeListener(listener) }
    }
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
