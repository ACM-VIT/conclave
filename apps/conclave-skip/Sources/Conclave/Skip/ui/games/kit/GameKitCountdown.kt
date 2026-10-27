package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/**
 * K2 (S60 8 d): the one countdown leaf. One LaunchedEffect keyed to the deadline recomputes once per second and only
 * while the lifecycle is at least STARTED (repeatOnLifecycle), so the ticker stops in the background and recomputes on
 * resume (8 k). Everything derives from the server deadline plus the push's clock offset (CountdownModel). The bar
 * moves once per second without animation (R13); at 5 s or less it turns ext.warning with the "5 s left" text twin.
 * TalkBack reads one element ("12 seconds left") and hears a polite update at 10 s and 5 s only.
 */
@Composable
internal fun GameKitCountdown(model: CountdownModel, modifier: Modifier = Modifier) {
    var nowMillis by remember(model) { mutableDoubleStateOf(System.currentTimeMillis().toDouble()) }
    var announcement by remember(model) { mutableStateOf("") }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(model, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                nowMillis = System.currentTimeMillis().toDouble()
                if (model.secondsLeft(nowMillis = nowMillis) == 0) break
                delay(1000L)
            }
        }
    }
    val seconds = model.secondsLeft(nowMillis = nowMillis)
    val warning = seconds <= CountdownModel.warningSeconds
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val color = if (warning) ext.warning else scheme.onSurface
    val label = gameSecondsLeft(seconds)
    val announcedText = if (CountdownModel.announcedSeconds.contains(seconds)) label else ""
    LaunchedEffect(announcedText) {
        if (announcedText.isNotEmpty()) announcement = announcedText
    }
    Column(
        modifier.fillMaxWidth().testTag("game.countdown").clearAndSetSemantics { contentDescription = label },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (model.durationMillis > 0) {
                val fraction = model.fractionLeft(nowMillis = nowMillis).toFloat()
                LinearProgressIndicator(
                    progress = { fraction },
                    modifier = Modifier.weight(1f),
                    color = color,
                    trackColor = scheme.outlineVariant,
                    drawStopIndicator = {},
                )
            }
            Surface(shape = CircleShape, color = scheme.surfaceContainer, border = BorderStroke(1.dp, ext.border)) {
                Text(gameSeconds(seconds), style = rememberTabular(MaterialTheme.typography.labelLarge), color = color,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
            }
        }
        if (warning && seconds > 0) {
            Text(conclaveString("gm_warning"), style = MaterialTheme.typography.bodySmall, color = ext.warning)
        }
    }
    // One persistent polite live region whose text changes only at 10 s and 5 s, so TalkBack hears those marks and
    // never a per-second tick.
    Box(Modifier.size(1.dp).semantics {
        liveRegion = LiveRegionMode.Polite
        contentDescription = announcement
    })
}
