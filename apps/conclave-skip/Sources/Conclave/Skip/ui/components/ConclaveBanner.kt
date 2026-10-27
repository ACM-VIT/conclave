package conclave.module

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

/*
 * Banners (F00 C12, TG 4.2 banner.*): flat, a 1 dp border, radius 12, never glass. The text is one merged node
 * in a polite live region; actions and Dismiss stay their own nodes. Which banner shows, its priority and its copy
 * belong to the S20 notice catalog and the banner lane (STG-5).
 */

/** The visual kinds of a banner. */
internal enum class ConclaveBannerKind { Info, Warning, Error, Success, Reconnecting }

/** One banner action, drawn as a text button after the text. [enabled] is S20 SR5 `NoticeAction.isEnabled`: Retry
 *  now stays visible but disabled while an attempt is in flight. [onClick] stays last so callers can pass it as a
 *  trailing lambda (the gallery's `ConclaveBannerAction(title, id) {}`). */
internal data class ConclaveBannerAction(
    val title: String, val identifier: String, val enabled: Boolean = true, val disabledDescription: String = "",
    val onClick: () -> Unit,
)

/** Banner motion: an 8 dp move plus opacity over 120 ms, opacity only when animations are removed. The values are
 *  the shared A5 durations (ConclaveMotionDurations, `motion.fast`). */
internal object ConclaveBannerMotion {
    val DURATION_MILLIS: Int = ConclaveMotionDurations.fastMillis
    val TRAVEL_DP: Int = ConclaveMotionDurations.bannerTravel.toInt()
}

/**
 * A banner. [inCall] picks the always-dark call surface's border and status colors; the fill is the current
 * scheme's surfaceContainerHigh in both. Text wraps; [maxLines] is for the lane's four-line cap (OQ-2b-5).
 */
@Composable
internal fun ConclaveBanner(
    kind: ConclaveBannerKind, text: String, identifier: String, inCall: Boolean, modifier: Modifier = Modifier,
    actions: List<ConclaveBannerAction> = emptyList(), onDismiss: (() -> Unit)? = null, maxLines: Int = Int.MAX_VALUE,
) {
    val scheme = MaterialTheme.colorScheme
    // The extended roles (F00 2.6 A4) from the theme; an in-call banner always takes the dark set.
    val ext = if (inCall) ConclaveExtendedColorsDark else LocalConclaveExtendedColors.current
    val border = if (inCall) ext.border else scheme.outlineVariant
    val glyph = when (kind) {
        ConclaveBannerKind.Info, ConclaveBannerKind.Reconnecting -> if (inCall) scheme.onSurface else scheme.onSurfaceVariant
        ConclaveBannerKind.Warning -> ext.warning
        ConclaveBannerKind.Success -> ext.success
        ConclaveBannerKind.Error -> scheme.error
    }
    Surface(
        modifier = modifier.fillMaxWidth().testTag(identifier),
        shape = RoundedCornerShape(DesignTokens.radiusMedium.dp),
        color = scheme.surfaceContainerHigh,
        contentColor = scheme.onSurface,
        border = BorderStroke(1.dp, border),
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            BannerGlyph(kind, glyph)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ConclaveText(text, line = "$identifier.text", style = MaterialTheme.typography.bodyMedium, maxLines = maxLines,
                    modifier = Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite })
                if (actions.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (action in actions) {
                            TextButton(onClick = action.onClick, enabled = action.enabled,
                                modifier = Modifier.heightIn(min = 48.dp).testTag(action.identifier).semantics {
                                    // S70 6 i (SYS-6): a disabled Retry Now says why ("Retrying now").
                                    if (!action.enabled && action.disabledDescription.isNotEmpty()) {
                                        stateDescription = action.disabledDescription
                                    }
                                }) {
                                ConclaveText(action.title, line = action.identifier)
                            }
                        }
                    }
                }
            }
            if (onDismiss != null) {
                IconButton(onClick = onDismiss, modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).testTag("$identifier.dismiss")) {
                    Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString("ds_dismiss"), tint = scheme.onSurface)
                }
            }
        }
    }
}

/** The status glyph, or the system spinner while reconnecting. Success and offline are pending in the icon
 *  manifest, so success uses the check stand-in (FND-1 carry, F00 7.3). Glyphs carry no description. */
@Composable
private fun BannerGlyph(kind: ConclaveBannerKind, color: Color) {
    val modifier = Modifier.size(20.dp)
    when (kind) {
        ConclaveBannerKind.Reconnecting -> CircularProgressIndicator(modifier = modifier, color = color, strokeWidth = 2.dp)
        ConclaveBannerKind.Info -> Icon(ConclaveIcons.InfoFill0, contentDescription = null, modifier = modifier, tint = color)
        ConclaveBannerKind.Warning -> Icon(ConclaveIcons.WarningFill1, contentDescription = null, modifier = modifier, tint = color)
        ConclaveBannerKind.Error -> Icon(ConclaveIcons.ErrorFill1, contentDescription = null, modifier = modifier, tint = color)
        ConclaveBannerKind.Success -> Icon(ConclaveIcons.CheckFill0, contentDescription = null, modifier = modifier, tint = color)
    }
}

/** Shows and hides a banner with the banner motion; with animations removed it only fades. */
@Composable
internal fun ConclaveBannerPresence(visible: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val reduceMotion = rememberReduceMotion()
    val travel = with(LocalDensity.current) { ConclaveBannerMotion.TRAVEL_DP.dp.roundToPx() }
    val fade = tween<Float>(durationMillis = ConclaveBannerMotion.DURATION_MILLIS, easing = LinearOutSlowInEasing)
    val enter = if (reduceMotion) fadeIn(fade) else fadeIn(fade) + slideInVertically(
        tween(durationMillis = ConclaveBannerMotion.DURATION_MILLIS, easing = LinearOutSlowInEasing)) { -travel }
    val exit = if (reduceMotion) fadeOut(fade) else fadeOut(fade) + slideOutVertically(
        tween(durationMillis = ConclaveBannerMotion.DURATION_MILLIS, easing = LinearOutSlowInEasing)) { -travel }
    AnimatedVisibility(visible = visible, modifier = modifier, enter = enter, exit = exit) {
        content()
    }
}

/** The lane's width cap and line cap (F00 C12 c, f). */
internal object ConclaveBannerLaneMetrics {
    const val MAX_WIDTH_DP = 560
    const val LINE_LIMIT = 4
}

/**
 * The in-call banner lane: the one banner the S20 presenter publishes (highest priority wins, STG-5 decides) in the
 * stage Box under the top chrome, at most 560 dp wide and centered. It overlays the stage outside the tile layout,
 * so it never moves tiles, and it stays while chrome auto-hides. [noticeId] null hides the lane with the banner
 * motion; [content] draws the banner for the current notice (inCall = true, maxLines = LINE_LIMIT).
 */
@Composable
internal fun ConclaveBannerLane(
    noticeId: String?, identifier: String, modifier: Modifier = Modifier, content: @Composable () -> Unit,
) {
    Box(modifier.fillMaxWidth().padding(horizontal = DesignTokens.space12.dp).padding(top = DesignTokens.space8.dp)
        .testTag(identifier), contentAlignment = Alignment.TopCenter) {
        ConclaveBannerPresence(visible = noticeId != null, modifier = Modifier.widthIn(max = ConclaveBannerLaneMetrics.MAX_WIDTH_DP.dp)) {
            content()
        }
    }
}
