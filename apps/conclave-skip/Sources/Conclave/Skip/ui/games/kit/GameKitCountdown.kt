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
            Text(label, style = MaterialTheme.typography.bodySmall, color = ext.warning)
        }
    }

    Box(Modifier.size(1.dp).semantics {
        liveRegion = LiveRegionMode.Polite
        contentDescription = announcement
    })
}
