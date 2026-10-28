package conclave.module

import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal class EntryTransitionAnchors {
    var routeId: Int = 0
        private set
    var bounds: Rect = Rect.Zero
        private set
    var hostOrigin: Offset = Offset.Zero

    var recordCount: Int = 0
        private set

    fun record(routeId: Int, bounds: Rect) {
        this.routeId = routeId
        this.bounds = bounds
        recordCount += 1
    }

    fun bounds(forRoute: Int): Rect? {
        val usable = EntryTransitionPolicy.isUsableCardFrame(recordedRouteId = routeId, lobbyRouteId = forRoute,
            width = bounds.width.toDouble(), height = bounds.height.toDouble())
        return if (usable) bounds else null
    }

    fun clear() {
        routeId = 0
        bounds = Rect.Zero
    }
}

internal val LocalEntryTransitionAnchors = staticCompositionLocalOf<EntryTransitionAnchors?> { null }

internal fun Modifier.entryTransitionAnchor(anchors: EntryTransitionAnchors?, routeId: Int): Modifier =
    if (anchors == null) this else this.onGloballyPositioned { coordinates -> anchors.record(routeId, coordinates.boundsInRoot()) }

internal fun entryRootTransform(entersCall: Boolean, expands: Boolean, reduceMotion: Boolean): ContentTransform {
    if (entersCall && expands && !reduceMotion) {
        return fadeIn(tween(durationMillis = EntryTransitionPolicy.revealDurationMillis,
            delayMillis = EntryTransitionPolicy.androidRevealDelayMillis)) togetherWith
            fadeOut(tween(durationMillis = EntryTransitionPolicy.androidPremeetingFadeMillis))
    }
    return fadeIn(ConclaveMotion.crossFade()) togetherWith fadeOut(ConclaveMotion.crossFade())
}

@Composable
internal fun EntryExpansionLayer(start: Rect, hostOrigin: Offset, onFinished: () -> Unit) {
    val progress = remember(start) { Animatable(0f) }
    val alpha = remember(start) { Animatable(1f) }
    val finish by rememberUpdatedState(onFinished)
    val radiusPx = with(LocalDensity.current) { DesignTokens.radiusTile.dp.toPx() }
    val color = Color(DesignTokens.androidExtendedStage)
    LaunchedEffect(start) {
        val dissolve = launch {
            delay(EntryTransitionPolicy.androidRevealDelayMillis.toLong())
            alpha.animateTo(0f, tween(durationMillis = EntryTransitionPolicy.revealDurationMillis))
        }
        progress.animateTo(1f, ConclaveMotion.spatialDefault())
        dissolve.join()
        finish()
    }
    Spacer(
        Modifier.fillMaxSize().drawBehind {
            val fraction = progress.value
            val fromLeft = start.left - hostOrigin.x
            val fromTop = start.top - hostOrigin.y
            val fromRight = start.right - hostOrigin.x
            val fromBottom = start.bottom - hostOrigin.y
            val left = fromLeft + (0f - fromLeft) * fraction
            val top = fromTop + (0f - fromTop) * fraction
            val right = fromRight + (size.width - fromRight) * fraction
            val bottom = fromBottom + (size.height - fromBottom) * fraction
            val radius = radiusPx * (1f - fraction).coerceIn(0f, 1f)
            drawRoundRect(
                color = color,
                topLeft = Offset(left, top),
                size = Size(right - left, bottom - top),
                cornerRadius = CornerRadius(radius, radius),
                alpha = alpha.value.coerceIn(0f, 1f),
            )
        },
    )
}

@Composable
internal fun StageEntryFinishedEffect(settled: Boolean) {
    LaunchedEffect(settled) {
        if (settled) {
            SystemNotifications.shared.stageEntryFinished()
        }
    }
}
