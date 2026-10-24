package conclave.module

import android.graphics.Color as AndroidColor
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.LocalActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect

/** Icon appearance of each system bar. Dark means a dark surface behind the bar, so its icons are light. */
internal data class SystemBarAppearance(val statusDark: Boolean, val navigationDark: Boolean)

/**
 * Which surface sits behind each bar (PS 8.7). A visible full-screen overlay owns both bars: always dark when
 * it is in call, otherwise the system appearance. Without one, the status bar shows the root, and the
 * navigation bar shows an in-call strip that reaches the bottom edge, or else the root.
 */
internal object SystemBarPolicy {
    fun resolve(
        rootDark: Boolean,
        overlayVisible: Boolean,
        overlayInCall: Boolean,
        bottomStripInCall: Boolean,
        systemDark: Boolean,
    ): SystemBarAppearance {
        if (overlayVisible) {
            val dark = overlayInCall || systemDark
            return SystemBarAppearance(statusDark = dark, navigationDark = dark)
        }
        return SystemBarAppearance(statusDark = rootDark, navigationDark = bottomStripInCall || rootDark)
    }

    /** Transparent edge-to-edge bars, as the fixture used before; only the icon appearance changes. */
    fun style(dark: Boolean): SystemBarStyle =
        if (dark) SystemBarStyle.dark(AndroidColor.TRANSPARENT)
        else SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
}

/**
 * The single system-bar owner of a native root. Themes never touch the bars, so nested in-call surfaces stay
 * bar-neutral. Leaving composition restores the activity default, the plain `enableEdgeToEdge()` that
 * MainActivity applies at launch, so the legacy root gets its own bars back.
 */
@Composable
internal fun ConclaveSystemBars(appearance: SystemBarAppearance) {
    val activity = LocalActivity.current as? ComponentActivity
    DisposableEffect(activity, appearance) {
        activity?.enableEdgeToEdge(
            statusBarStyle = SystemBarPolicy.style(appearance.statusDark),
            navigationBarStyle = SystemBarPolicy.style(appearance.navigationDark),
        )
        onDispose { }
    }
    DisposableEffect(activity) {
        onDispose { activity?.enableEdgeToEdge() }
    }
}
