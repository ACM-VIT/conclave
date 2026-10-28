package conclave.module

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layoutId
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.LayoutDirection
import kotlin.math.roundToInt

internal object StageCanvasMetrics {

    const val TOP_RESERVE_DP = 60.0

    const val BAR_RESERVE_DP = 76.0

    const val MEDIUM_WIDTH_DP = 600.0
    const val EXPANDED_WIDTH_DP = 840.0
    const val MEDIUM_HEIGHT_DP = 480.0
}

internal fun stageViewportFrom(width: Double, height: Double, top: Double, bottom: Double, leading: Double, trailing: Double): StageViewport {
    val widthClass = when {
        width < StageCanvasMetrics.MEDIUM_WIDTH_DP -> StageSizeClass.compact
        width < StageCanvasMetrics.EXPANDED_WIDTH_DP -> StageSizeClass.medium
        else -> StageSizeClass.expanded
    }
    val heightClass = if (height < StageCanvasMetrics.MEDIUM_HEIGHT_DP) StageSizeClass.compact else StageSizeClass.medium
    return StageViewport(
        width = width,
        height = height,
        insetTop = top + StageCanvasMetrics.TOP_RESERVE_DP,
        insetBottom = bottom + StageCanvasMetrics.BAR_RESERVE_DP,
        insetLeading = leading,
        insetTrailing = trailing,
        widthClass = widthClass,
        heightClass = heightClass,

        placement = StageChromePlacement.bottomBar,
    )
}

@Composable
internal fun StageCanvas(stage: StagePresenter, renderers: StageRenderers, chrome: StageChromeVisibilityState, modifier: Modifier = Modifier) {
    val density = LocalDensity.current
    val direction = LocalLayoutDirection.current
    val insets = WindowInsets.safeDrawing
    BoxWithConstraints(modifier.fillMaxSize()) {
        val scale = density.density.toDouble()
        val left = insets.getLeft(density, direction) / scale
        val right = insets.getRight(density, direction) / scale
        val viewport = stageViewportFrom(
            width = maxWidth.value.toDouble(),
            height = maxHeight.value.toDouble(),
            top = insets.getTop(density) / scale,
            bottom = insets.getBottom(density) / scale,
            leading = if (direction == LayoutDirection.Ltr) left else right,
            trailing = if (direction == LayoutDirection.Ltr) right else left,
        )

        val inPip = PipController.inPipMode
        val pipSlotId = stage.pipTarget.slotId

        SideEffect { if (!inPip) stage.setViewport(viewport) }
        val snapshot = stage.layout
        val frames = remember(snapshot, viewport, inPip, pipSlotId) {
            if (inPip) {
                PipStageLayoutPolicy.frames(targetSlotId = pipSlotId, width = maxWidth.value.toDouble(), height = maxHeight.value.toDouble())
            } else {
                StageLayoutPolicy.frames(viewport = viewport, kind = snapshot.kind, slots = snapshot.slots, selfCorner = snapshot.selfCorner)
            }
        }
        val seeds = remember(snapshot) { snapshot.overflowSeeds.toList() }
        Layout(
            modifier = Modifier.fillMaxSize().pointerInput(Unit) {

                detectTapGestures(onTap = {
                    stage.stageTapped()
                    chrome.send(ChromeVisibilityEvent.tap)
                })
            },
            content = {

                CompositionLocalProvider(LocalStageChromeVisibility provides chrome, LocalStageViewport provides viewport) {
                    for (slot in snapshot.slots) {
                        key(slot.id) {
                            SlotView(slot, stage, renderers, snapshot.overflowCount, seeds, Modifier.layoutId(slot.id))
                        }
                    }
                }
            },
        ) { measurables, constraints ->
            val placeables = measurables.map { measurable ->
                val id = measurable.layoutId as? String ?: ""
                val frame = StageLayoutPolicy.find(id, frames)
                val widthPx = if (frame != null) (frame.width * scale).roundToInt().coerceAtLeast(0) else 0
                val heightPx = if (frame != null) (frame.height * scale).roundToInt().coerceAtLeast(0) else 0
                Pair(frame, measurable.measure(Constraints.fixed(widthPx, heightPx)))
            }
            layout(constraints.maxWidth, constraints.maxHeight) {
                for (entry in placeables) {
                    val frame = entry.first
                    val x = if (frame != null) (frame.x * scale).roundToInt() else 0
                    val y = if (frame != null) (frame.y * scale).roundToInt() else 0
                    entry.second.placeRelative(x, y)
                }
            }
        }
    }
}
