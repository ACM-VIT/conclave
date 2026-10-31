package conclave.module

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun ReactionBurstLayer(stage: StagePresenter, modifier: Modifier = Modifier) {
    val kind = stage.kind
    if (kind == StageKind.attendeeWaiting || kind == StageKind.attendeeLive) return
    val snapshot = stage.reactions
    val reduceMotion = rememberReduceMotion()
    val events = remember(snapshot, reduceMotion) { StageReactionPolicy.visibleEvents(snapshot, reduceMotion).toList() }
    val tileLabelLine = MaterialTheme.typography.labelMedium.lineHeight.value.toDouble()
    val bottomInset = StageReactionPolicy.layerBottomInset(barReserve = StageCanvasMetrics.BAR_RESERVE_DP,
        labelLineHeight = tileLabelLine * LocalDensity.current.fontScale, defaultLabelLineHeight = tileLabelLine)
    val density = LocalDensity.current
    val direction = LocalLayoutDirection.current
    val fontScale = density.fontScale.toDouble()
    val pillLine = MaterialTheme.typography.labelSmall.lineHeight.value.toDouble() * minOf(fontScale, StageReactionPolicy.reducedPillMaxFontScale)
    val slotHeight = StageReactionPolicy.reducedSlotHeight(pillLineHeight = pillLine)
    val insets = WindowInsets.safeDrawing
    BoxWithConstraints(modifier.fillMaxSize().clearAndSetSemantics { }) {
        val scale = density.density.toDouble()
        val left = insets.getLeft(density, direction) / scale
        val right = insets.getRight(density, direction) / scale
        val safeBottom = insets.getBottom(density) / scale
        val viewport = stageViewportFrom(
            width = maxWidth.value.toDouble(),
            height = maxHeight.value.toDouble(),
            top = insets.getTop(density) / scale,
            bottom = safeBottom,
            leading = if (direction == LayoutDirection.Ltr) left else right,
            trailing = if (direction == LayoutDirection.Ltr) right else left,
            chipRow = if (stage.chipRowVisible) StageViewportPolicy.androidChipRowReserve else 0.0,
        )
        val placement = if (reduceMotion) {
            val layout = stage.layout
            val metrics = StageReactionSlotMetrics(defaultBottomInset = bottomInset, layerLeading = viewport.insetLeading,
                layerBottom = safeBottom, slotHeight = slotHeight,
                labelBand = StageReactionPolicy.tileLabelBand(lineHeight = tileLabelLine * fontScale),
                barMaxWidth = ControlBarPolicy.androidMaxToolbarWidth)
            val frames = StageLayoutPolicy.frames(viewport = viewport, kind = layout.kind, slots = layout.slots, selfCorner = layout.selfCorner)
            StageReactionPolicy.reducedPlacement(viewport = viewport, kind = layout.kind, slots = layout.slots, frames = frames,
                metrics = metrics)
        } else {
            StageReactionSlotPlacement(bottomInset = bottomInset, shape = StageReactionSlotShape.row)
        }
        Box(
            Modifier.fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Start))
                .padding(start = StageReactionPolicy.leadingInset.dp, bottom = placement.bottomInset.dp),
            contentAlignment = Alignment.BottomStart,
        ) {
            for (event in events) {
                key(event.id) { ReactionBubble(event, reduceMotion, placement.shape, slotHeight) }
            }
        }
    }
}

@Composable
private fun ReactionBubble(event: ReactionEvent, reduceMotion: Boolean, slotShape: StageReactionSlotShape, slotHeight: Double) {
    val rise = remember { Animatable(0f) }
    val drift = remember { Animatable(0f) }
    val pop = remember { Animatable(if (reduceMotion) 1f else StageReactionPolicy.popFromScale.toFloat()) }
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
                pop.animateTo(1f, spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMedium))
            }
            launch {
                rise.animateTo(StageReactionPolicy.riseDistance.toFloat(), tween(riseMillis, easing = CubicBezierEasing(0f, 0f, 0.2f, 1f)))
            }
            launch {
                drift.animateTo((StageReactionPolicy.driftDirection(event.id) * StageReactionPolicy.driftDistance).toFloat(),
                    tween(riseMillis, easing = LinearOutSlowInEasing))
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
        Modifier.zIndex(if (event.isLocal) 1f else 0f)
            .offset(x = StageReactionPolicy.slotOffsetX(lane = lane, reduceMotion = reduceMotion, shape = slotShape).dp,
                y = (-StageReactionPolicy.slotOffsetY(lane = lane, shape = slotShape, slotHeight = slotHeight)).dp)
            .then(if (reduceMotion) Modifier.width(StageReactionPolicy.reducedSlotWidth.dp) else Modifier).graphicsLayer {
            translationX = drift.value.dp.toPx()
            translationY = -rise.value.dp.toPx()
            scaleX = pop.value
            scaleY = pop.value
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
        val fontScale = LocalDensity.current.fontScale
        val pillMaxFontScale = StageReactionPolicy.reducedPillMaxFontScale.toFloat()
        val labelBase = MaterialTheme.typography.labelSmall
        val labelStyle = if (reduceMotion && fontScale > pillMaxFontScale) {
            val shrink = pillMaxFontScale / fontScale
            labelBase.copy(fontSize = labelBase.fontSize * shrink, lineHeight = labelBase.lineHeight * shrink,
                letterSpacing = labelBase.letterSpacing * shrink)
        } else {
            labelBase
        }
        val label: @Composable () -> Unit = {
            ConclaveText(name, line = "stage.reaction.${event.id}.name", style = labelStyle, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
        }
        if (event.isLocal) {
            Surface(shape = CircleShape, color = scheme.surfaceContainerHigh, contentColor = scheme.primary,
                border = BorderStroke(1.dp, ext.border)) { label() }
        } else {
            Surface(shape = CircleShape, color = ext.labelScrim, contentColor = scheme.onSurface) { label() }
        }
    }
}
