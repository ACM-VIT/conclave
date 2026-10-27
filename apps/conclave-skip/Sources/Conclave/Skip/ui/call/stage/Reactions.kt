package conclave.module

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * S20 9 (STG-4, SL9): the reaction burst layer. Reads only stage.reactions (hot state in one leaf layer), draws at most
 * renderLimit bubbles in a leading column above the toast lane, and takes no pointer input and no semantics, so taps
 * reach the tiles below and TalkBack never hears it. Each bubble animates its own transform and alpha once; nothing
 * redraws once the last bubble has faded. Remove animations: appear in place, hold, fade.
 */

@Composable
internal fun ReactionBurstLayer(stage: StagePresenter, modifier: Modifier = Modifier) {
    val kind = stage.kind
    if (kind == StageKind.attendeeWaiting || kind == StageKind.attendeeLive) return
    val snapshot = stage.reactions
    val events = remember(snapshot) { StageReactionPolicy.visibleEvents(snapshot).toList() }
    val reduceMotion = rememberReduceMotion()
    Box(
        modifier.fillMaxSize().clearAndSetSemantics { }
            .padding(start = StageReactionPolicy.leadingInset.dp, bottom = (StageCanvasMetrics.BAR_RESERVE_DP + 64.0).dp),
        contentAlignment = Alignment.BottomStart,
    ) {
        for (event in events) {
            key(event.id) { ReactionBubble(event, reduceMotion) }
        }
    }
}

@Composable
private fun ReactionBubble(event: ReactionEvent, reduceMotion: Boolean) {
    val rise = remember { Animatable(0f) }
    val alpha = remember { Animatable(if (reduceMotion) 0f else 1f) }
    LaunchedEffect(Unit) {
        val riseMillis = StageReactionPolicy.riseMillis.toInt()
        if (reduceMotion) {
            val fadeIn = StageReactionPolicy.reducedFadeInMillis.toInt()
            val fadeOut = StageReactionPolicy.reducedFadeOutMillis.toInt()
            alpha.animateTo(1f, tween(fadeIn))
            delay((StageReactionPolicy.lifetimeMillis.toInt() - fadeIn - fadeOut).toLong())
            alpha.animateTo(0f, tween(fadeOut))
        } else {
            launch {
                rise.animateTo(StageReactionPolicy.riseDistance.toFloat(), tween(riseMillis, easing = CubicBezierEasing(0f, 0f, 0.2f, 1f)))
            }
            val fadeStart = (riseMillis * StageReactionPolicy.fadeStartFraction).toInt()
            delay(fadeStart.toLong())
            alpha.animateTo(0f, tween(riseMillis - fadeStart, easing = LinearEasing))
        }
    }
    val ext = LocalConclaveExtendedColors.current
    val scheme = MaterialTheme.colorScheme
    val lane = StageReactionPolicy.lane(event.id)
    val name = when {
        event.isLocal -> conclaveString("ds_you")
        event.senderName.isEmpty() -> conclaveString("stg_someone")
        else -> event.senderName
    }
    Column(
        Modifier.offset(x = (lane * StageReactionPolicy.laneOffset).dp).graphicsLayer {
            translationY = -rise.value.dp.toPx()
            this.alpha = alpha.value
        },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Surface(
            modifier = Modifier.size(StageReactionPolicy.bubbleDiameter.dp),
            shape = CircleShape,
            color = scheme.surfaceContainerHigh,
            border = BorderStroke(1.dp, ext.border),
        ) {
            Box(contentAlignment = Alignment.Center) {
                ConclaveText(if (event.kind == "emoji") event.value else event.label, line = "stage.reaction.${event.id}",
                    style = MaterialTheme.typography.headlineSmall, maxLines = 1, overflow = TextOverflow.Clip)
            }
        }
        Surface(shape = CircleShape, color = ext.labelScrim, contentColor = scheme.onSurface) {
            ConclaveText(name, line = "stage.reaction.${event.id}.name", style = MaterialTheme.typography.labelSmall, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
        }
    }
}
