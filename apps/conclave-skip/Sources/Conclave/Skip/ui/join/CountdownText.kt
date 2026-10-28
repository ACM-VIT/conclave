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

/*
 * ENT-9 (S10 0.6 L7, 12 d, e, i, k): the webinar early state's countdown leaf. One produceState ticks once per second
 * only while the lifecycle is RESUMED (repeatOnLifecycle), so it stops in the background and recomputes on resume, and
 * it is the only thing that recomposes each second: the presenter's snapshot carries just the start time and the
 * header around it stays flat (S10 12 l4, WebinarLandingDiagnostics). titleLarge with tabular digits, no animation
 * (S10 12 h). TalkBack reads one value that changes at most every 10 s, with no live region (S10 12 i).
 */
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
                // Wake just after the shown second changes.
                delay(((remaining % 1000L) + 1L).coerceIn(1L, 1000L))
            }
        }
    }
    SideEffect { WebinarLandingDiagnostics.countdownCompositions += 1 }
    val countdown = WebinarLandingPolicy.countdown(remainingMillis = startsAtMillis - nowMillis)
    val text = conclaveString("pm_starts_in", webinarCountdownClock(countdown))
    val totalSeconds = countdown.hours * 3600 + countdown.minutes * 60 + countdown.seconds
    // The spoken value keeps the text of the first tick in each 10 s bucket.
    val spoken = remember(startsAtMillis, totalSeconds / 10) { text }
    Text(
        text,
        style = rememberTabular(MaterialTheme.typography.titleLarge),
        modifier = modifier.testTag("webinar.countdown").clearAndSetSemantics { contentDescription = spoken },
    )
}

/** "12:41", or "1:12:41" from an hour on (hours may pass 24), in the device locale's digits like the iOS timer text. */
internal fun webinarCountdownClock(countdown: WebinarCountdown): String =
    if (countdown.hours > 0) {
        String.format(Locale.getDefault(), "%d:%02d:%02d", countdown.hours, countdown.minutes, countdown.seconds)
    } else {
        String.format(Locale.getDefault(), "%d:%02d", countdown.minutes, countdown.seconds)
    }
