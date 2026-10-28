package conclave.module

import android.graphics.Color as AndroidColor
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.LocalActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalConfiguration

internal data class SystemBarAppearance(val statusDark: Boolean, val navigationDark: Boolean)

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

    fun style(dark: Boolean): SystemBarStyle =
        if (dark) SystemBarStyle.dark(AndroidColor.TRANSPARENT)
        else SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
}

@Composable
internal fun ConclaveSystemBars(appearance: SystemBarAppearance) {
    val activity = LocalActivity.current as? ComponentActivity
    val configuration = LocalConfiguration.current
    DisposableEffect(activity, appearance, configuration) {
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
