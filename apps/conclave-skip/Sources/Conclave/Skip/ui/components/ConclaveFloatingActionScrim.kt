package conclave.module

import androidx.compose.foundation.layout.Spacer
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
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
    val ground = if (opaque) veil.copy(alpha = alpha).compositeOver(MaterialTheme.colorScheme.surface) else veil.copy(alpha = alpha)
    Spacer(
        modifier.drawWithCache {
            val fade = ConclaveFloatingActionScrimDefaults.fadeHeight.toPx()
            val band = (size.height + bottomPadding.toPx()).coerceAtLeast(0f)
            val span = fade + band + fade
            val clear = ground.copy(alpha = 0f)
            val solid = ground
            val ramp = Brush.verticalGradient(
                0f to clear,
                fade / span to solid,
                (fade + band) / span to solid,
                1f to clear,
                startY = -fade,
                endY = band + fade,
            )
            onDrawBehind {
                drawRect(brush = ramp, topLeft = Offset(0f, -fade), size = Size(size.width, span))
            }
        },
    )
}
