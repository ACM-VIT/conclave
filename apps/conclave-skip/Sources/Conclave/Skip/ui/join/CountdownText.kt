package conclave.module

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

@Composable
internal fun CountdownText(startsAtMillis: Double, modifier: Modifier = Modifier) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val nowMillis by produceState(initialValue = System.currentTimeMillis().toDouble(), startsAtMillis, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (isActive) {
                val now = System.currentTimeMillis()
                value = now.toDouble()
                val remaining = startsAtMillis.toLong() - now
                if (remaining <= 0L) break

                delay(((remaining % 1000L) + 1L).coerceIn(1L, 1000L))
            }
        }
    }
    SideEffect { WebinarLandingDiagnostics.countdownCompositions += 1 }
    val countdown = WebinarLandingPolicy.countdown(remainingMillis = startsAtMillis - nowMillis)
    val text = conclaveString("pm_starts_in", webinarCountdownClock(countdown))
    val totalSeconds = countdown.hours * 3600 + countdown.minutes * 60 + countdown.seconds

    val spoken = remember(startsAtMillis, totalSeconds / 10) { text }
    Text(
        text,
        style = rememberTabular(MaterialTheme.typography.titleLarge),
        modifier = modifier.testTag("webinar.countdown").clearAndSetSemantics { contentDescription = spoken },
    )
}

internal fun webinarCountdownClock(countdown: WebinarCountdown): String =
    if (countdown.hours > 0) {
        String.format(Locale.getDefault(), "%d:%02d:%02d", countdown.hours, countdown.minutes, countdown.seconds)
    } else {
        String.format(Locale.getDefault(), "%d:%02d", countdown.minutes, countdown.seconds)
    }
