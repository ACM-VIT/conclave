package conclave.module

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

internal enum class NoticeCardActionStyle { Primary, Secondary, Quiet }

internal data class NoticeCardAction(
    val title: String, val identifier: String, val style: NoticeCardActionStyle, val enabled: Boolean,
    val disabledDescription: String, val onClick: () -> Unit,
)

internal object NoticeCardMetrics {
    const val RADIUS_DP = 20
    const val BADGE_DP = 28
    const val CLOSE_DP = 28
    const val ACTION_HEIGHT_DP = 34
    const val FLING_SECONDS = 0.2f
}

@Composable
internal fun NoticeCard(
    kind: ConclaveBannerKind, title: String, text: String, announcement: String, identifier: String,
    actions: List<NoticeCardAction>, onDismiss: (() -> Unit)?, maxLines: Int, announces: Boolean, isAssertive: Boolean,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    val ext = ConclaveExtendedColorsDark
    val reduceMotion = rememberReduceMotion()
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val offsetX = remember { Animatable(0f) }
    val offsetY = remember { Animatable(0f) }
    var leaving by remember { mutableStateOf(false) }
    val dismiss by rememberUpdatedState(onDismiss)
    val dismissible = onDismiss != null

    fun leave(outcome: NoticeSwipeOutcome) {
        val action = dismiss ?: return
        if (leaving) return
        leaving = true
        if (reduceMotion) {
            action()
            return
        }
        val target = NoticeSwipePolicy.exitOffset(outcome, NoticeSwipeOffset(offsetX.value.toDouble(), offsetY.value.toDouble()))
        scope.launch {
            launch { offsetX.animateTo(target.x.toFloat(), tween(180, easing = FastOutLinearInEasing)) }
            offsetY.animateTo(target.y.toFloat(), tween(180, easing = FastOutLinearInEasing))
            action()
        }
    }

    val swipe = Modifier.pointerInput(dismissible) {
        val tracker = VelocityTracker()
        var raw = Offset.Zero
        detectDragGestures(
            onDragStart = {
                tracker.resetTracking()
                raw = Offset.Zero
            },
            onDragEnd = {
                if (!leaving) {
                    val velocity = tracker.calculateVelocity()
                    val dx = with(density) { raw.x.toDp().value }
                    val dy = with(density) { raw.y.toDp().value }
                    val vx = with(density) { velocity.x.toDp().value }
                    val vy = with(density) { velocity.y.toDp().value }
                    val outcome = NoticeSwipePolicy.outcome(dx.toDouble(), dy.toDouble(),
                        (dx + vx * NoticeCardMetrics.FLING_SECONDS).toDouble(), (dy + vy * NoticeCardMetrics.FLING_SECONDS).toDouble(),
                        dismissible)
                    if (outcome == NoticeSwipeOutcome.settle || !dismissible) {
                        scope.launch {
                            launch { offsetX.animateTo(0f, spring(dampingRatio = 0.78f, stiffness = Spring.StiffnessMediumLow)) }
                            offsetY.animateTo(0f, spring(dampingRatio = 0.78f, stiffness = Spring.StiffnessMediumLow))
                        }
                    } else {
                        leave(outcome)
                    }
                }
            },
            onDragCancel = {
                scope.launch {
                    launch { offsetX.animateTo(0f) }
                    offsetY.animateTo(0f)
                }
            },
        ) { change, amount ->
            if (leaving) return@detectDragGestures
            change.consume()
            raw += amount
            tracker.addPosition(change.uptimeMillis, change.position)
            val dx = with(density) { raw.x.toDp().value }
            val dy = with(density) { raw.y.toDp().value }
            val next = NoticeSwipePolicy.offset(dx.toDouble(), dy.toDouble(), dismissible)
            scope.launch {
                offsetX.snapTo(next.x.toFloat())
                offsetY.snapTo(next.y.toFloat())
            }
        }
    }

    val shape = RoundedCornerShape(NoticeCardMetrics.RADIUS_DP.dp)
    Surface(
        modifier = modifier.fillMaxWidth().testTag(identifier).then(swipe).graphicsLayer {
            val travel = NoticeSwipeOffset(offsetX.value.toDouble(), offsetY.value.toDouble())
            if (!reduceMotion) {
                translationX = offsetX.value * density.density
                translationY = offsetY.value * density.density
            }
            alpha = NoticeSwipePolicy.opacity(travel).toFloat()
        },
        shape = shape,
        color = scheme.surfaceContainerHigh,
        contentColor = scheme.onSurface,
        border = BorderStroke(1.dp, ext.border),
        shadowElevation = 8.dp,
    ) {
        Row(
            Modifier.padding(start = 12.dp, end = if (dismissible) 4.dp else 14.dp, top = 12.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            NoticeCardBadge(kind)
            Column(Modifier.weight(1f).padding(top = if (title.isEmpty()) 4.dp else 0.dp)) {
                Column(Modifier.semantics(mergeDescendants = true) {
                    contentDescription = announcement
                    if (announces) liveRegion = if (isAssertive) LiveRegionMode.Assertive else LiveRegionMode.Polite
                }, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    if (title.isNotEmpty()) {
                        ConclaveText(title, line = "$identifier.title",
                            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold), maxLines = 1)
                    }
                    ConclaveText(text, line = "$identifier.text", style = MaterialTheme.typography.bodyMedium, maxLines = maxLines,
                        color = if (title.isEmpty()) scheme.onSurface else scheme.onSurfaceVariant, overflow = TextOverflow.Ellipsis)
                }
                if (actions.isNotEmpty()) {
                    val quietOnly = actions.all { it.style == NoticeCardActionStyle.Quiet }
                    Row(Modifier.padding(top = if (quietOnly) 0.dp else 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        for (action in actions) NoticeCardActionButton(action)
                    }
                }
            }
            if (dismissible) {
                IconButton(onClick = { leave(NoticeSwipeOutcome.dismissUp) },
                    modifier = Modifier.size(44.dp).padding(bottom = 0.dp).testTag("$identifier.dismiss")) {
                    Box(Modifier.size(NoticeCardMetrics.CLOSE_DP.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.08f)),
                        contentAlignment = Alignment.Center) {
                        Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString("ds_dismiss"),
                            modifier = Modifier.size(16.dp), tint = scheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun NoticeCardBadge(kind: ConclaveBannerKind) {
    val scheme = MaterialTheme.colorScheme
    val ext = ConclaveExtendedColorsDark
    val tint = when (kind) {
        ConclaveBannerKind.Info, ConclaveBannerKind.Reconnecting -> scheme.onSurface
        ConclaveBannerKind.Warning -> ext.warning
        ConclaveBannerKind.Success -> ext.success
        ConclaveBannerKind.Error -> scheme.error
    }
    val alpha = if (kind == ConclaveBannerKind.Info || kind == ConclaveBannerKind.Reconnecting) 0.14f else 0.18f
    Box(Modifier.size(NoticeCardMetrics.BADGE_DP.dp).clip(CircleShape).background(tint.copy(alpha = alpha)),
        contentAlignment = Alignment.Center) {
        val icon = Modifier.size(16.dp)
        when (kind) {
            ConclaveBannerKind.Reconnecting -> CircularProgressIndicator(modifier = icon, color = tint, strokeWidth = 2.dp)
            ConclaveBannerKind.Info -> Icon(ConclaveIcons.InfoFill0, contentDescription = null, modifier = icon, tint = tint)
            ConclaveBannerKind.Warning -> Icon(ConclaveIcons.WarningFill1, contentDescription = null, modifier = icon, tint = tint)
            ConclaveBannerKind.Error -> Icon(ConclaveIcons.ErrorFill1, contentDescription = null, modifier = icon, tint = tint)
            ConclaveBannerKind.Success -> Icon(ConclaveIcons.CheckCircleFill1, contentDescription = null, modifier = icon, tint = tint)
        }
    }
}

@Composable
private fun NoticeCardActionButton(action: NoticeCardAction) {
    val scheme = MaterialTheme.colorScheme
    val described = Modifier.testTag(action.identifier).semantics {
        if (!action.enabled && action.disabledDescription.isNotEmpty()) stateDescription = action.disabledDescription
    }
    if (action.style == NoticeCardActionStyle.Quiet) {
        Box(described.heightIn(min = 48.dp).clip(RoundedCornerShape(8.dp))
            .clickable(enabled = action.enabled, role = Role.Button, onClick = action.onClick),
            contentAlignment = Alignment.CenterStart) {
            ConclaveText(action.title, line = action.identifier, color = scheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(end = 8.dp))
        }
        return
    }
    val primary = action.style == NoticeCardActionStyle.Primary
    Button(
        onClick = action.onClick, enabled = action.enabled,
        modifier = described.height(NoticeCardMetrics.ACTION_HEIGHT_DP.dp),
        shape = RoundedCornerShape(50),
        contentPadding = PaddingValues(horizontal = 14.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (primary) scheme.primary.copy(alpha = 0.16f) else Color.White.copy(alpha = 0.08f),
            contentColor = if (primary) scheme.primary else scheme.onSurface,
            disabledContainerColor = Color.White.copy(alpha = 0.05f),
            disabledContentColor = scheme.onSurface.copy(alpha = 0.38f),
        ),
        elevation = null,
    ) {
        ConclaveText(action.title, line = action.identifier,
            style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold))
    }
}
