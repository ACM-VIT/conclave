package conclave.module

import androidx.compose.foundation.layout.Spacer
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal object ConclaveFloatingActionScrimDefaults {
    val fadeHeight: Dp = 32.dp
    const val lightAlpha: Float = 0.2f
    const val darkAlpha: Float = 0.55f
}

@Composable
internal fun ConclaveFloatingActionScrim(modifier: Modifier = Modifier, bottomPadding: Dp = 0.dp, opaque: Boolean = false) {
    val dark = MaterialTheme.colorScheme.surface.luminance() < 0.5f
    val veil = Color(DesignTokens.neutralStage)
    val alpha = if (dark) ConclaveFloatingActionScrimDefaults.darkAlpha else ConclaveFloatingActionScrimDefaults.lightAlpha
    val ground = if (opaque) MaterialTheme.colorScheme.surface else veil.copy(alpha = alpha)
    Spacer(
        modifier.drawBehind {
            val band = (size.height + bottomPadding.toPx()).coerceAtLeast(0f)
            drawRect(color = ground, size = Size(size.width, band))
        },
    )
}
