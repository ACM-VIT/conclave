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

/*
 * ENT-5 (S10 8 d, h, k; 0.6 L10, R3): the Android entry transition plumbing. The lobby card reports its bounds in
 * the root's coordinates into a plain holder (no state, so a moving card invalidates nothing); when the root flips to
 * the call, the host reads them once and draws a flat stage-colored shape (ext.stage) growing from the card to the
 * window with ConclaveMotion.spatialDefault, above the root AnimatedContent, while the call content fades in under it
 * (fadeIn 160 ms after 220 ms) and the premeeting stack fades out (120 ms); the shape dissolves over the same window
 * and is removed. Only a shape and opacity move: no renderer is created, resized, scaled or drawn in an overlay for
 * it, and the call content is measured once at full size (F00 P5). Reduce Motion, no recorded card and the interim
 * legacy call root cross-fade (0.2 s). The shape replaces the spec's shared-bounds placeholder so the lobby card,
 * which hosts the CameraX preview in an AndroidView, is never rendered into a shared-transition overlay (record D1).
 */

/** The lobby card's last bounds in the root (S10 0.6 L10) and the host's origin in the root. */
internal class EntryTransitionAnchors {
    var routeId: Int = 0
        private set
    var bounds: Rect = Rect.Zero
        private set
    var hostOrigin: Offset = Offset.Zero
    /** Debug readout (S10 8 l): how many bounds the card reported. */
    var recordCount: Int = 0
        private set

    fun record(routeId: Int, bounds: Rect) {
        this.routeId = routeId
        this.bounds = bounds
        recordCount += 1
    }

    /** The recorded bounds for the lobby on top, or null (another route, nothing recorded, no size). */
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

/** The host's anchors, provided around the premeeting stack; null outside the native root. */
internal val LocalEntryTransitionAnchors = staticCompositionLocalOf<EntryTransitionAnchors?> { null }

/** The lobby card reports its bounds for the expansion start (a plain holder write, never state). */
internal fun Modifier.entryTransitionAnchor(anchors: EntryTransitionAnchors?, routeId: Int): Modifier =
    if (anchors == null) this else this.onGloballyPositioned { coordinates -> anchors.record(routeId, coordinates.boundsInRoot()) }

/**
 * The root AnimatedContent's transform (S10 8 d): into the call with the card expansion the call content fades in
 * late (the shape covers the swap) and the premeeting stack fades out early; every other change, and Reduce Motion,
 * is the 0.2 s cross-fade.
 */
internal fun entryRootTransform(entersCall: Boolean, expands: Boolean, reduceMotion: Boolean): ContentTransform {
    if (entersCall && expands && !reduceMotion) {
        return fadeIn(tween(durationMillis = EntryTransitionPolicy.revealDurationMillis,
            delayMillis = EntryTransitionPolicy.androidRevealDelayMillis)) togetherWith
            fadeOut(tween(durationMillis = EntryTransitionPolicy.androidPremeetingFadeMillis))
    }
    return fadeIn(ConclaveMotion.crossFade()) togetherWith fadeOut(ConclaveMotion.crossFade())
}

/**
 * The flat shape from the card's bounds (tile radius) to the window (radius 0), drawn in one draw modifier that
 * reads the animations in the draw phase (no recomposition per frame). It dissolves from 220 ms over 160 ms and
 * reports `onFinished` when both the bounds and the dissolve are done.
 */
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
