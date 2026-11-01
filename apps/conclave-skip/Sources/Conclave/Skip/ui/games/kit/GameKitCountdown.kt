package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
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
    Box(modifier.testTag("game.countdown").clearAndSetSemantics { contentDescription = label }) {
        if (model.durationMillis > 0) {
            GameKitTimerRing(model.fractionLeft(nowMillis = nowMillis).toFloat(), seconds, color)
        } else {
            GameKitTimerCapsule(gameSeconds(seconds), warning)
        }
    }

    Box(Modifier.size(1.dp).semantics {
        liveRegion = LiveRegionMode.Polite
        contentDescription = announcement
    })
}

@Composable
internal fun GameKitTimerRing(fraction: Float, seconds: Int, color: Color) {
    val scheme = MaterialTheme.colorScheme
    Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(
            progress = { fraction.coerceIn(0f, 1f) },
            modifier = Modifier.size(40.dp),
            color = color,
            trackColor = scheme.surfaceContainerHighest,
            strokeWidth = 3.dp,
            strokeCap = StrokeCap.Round,
            gapSize = 0.dp,
        )
        Text(seconds.toString(), style = rememberTabular(MaterialTheme.typography.labelLarge), color = color, maxLines = 1)
    }
}

@Composable
internal fun GameKitTimerCapsule(text: String, warning: Boolean, modifier: Modifier = Modifier) {
    val ext = LocalConclaveExtendedColors.current
    val ink = if (warning) ext.warning else MaterialTheme.colorScheme.onSurface
    Surface(shape = CircleShape, color = Color.Transparent, border = BorderStroke(1.dp, if (warning) ink else ext.border), modifier = modifier) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Icon(ConclaveIcons.TimerFill0, contentDescription = null, tint = ink, modifier = Modifier.size(16.dp))
            Text(text, style = rememberTabular(MaterialTheme.typography.labelLarge), color = ink, maxLines = 1)
        }
    }
}

