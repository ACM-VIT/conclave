package conclave.module

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.runtime.Composable
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

/*
 * S20 SL5 (STG-1): one non-lazy Layout holds every slot, keyed by slot id, with frames from the shared
 * StageLayoutPolicy and the same viewport the presenter used for its capacity, so slots and frames always agree.
 * Renderers are AndroidView children keyed by slot id, never lazy grid items (P5, D15). The canvas draws under
 * every system bar; the reserved insets (safeDrawing plus the 48 dp top row plus 12, the 64 dp toolbar plus 12) never
 * change when chrome hides, so a chrome toggle never relayouts tiles. placeRelative mirrors frames in RTL.
 */

internal object StageCanvasMetrics {
    /** The 48 dp top row plus 12 dp. */
    const val TOP_RESERVE_DP = 60.0
    /** The 64 dp toolbar plus 12 dp. */
    const val BAR_RESERVE_DP = 76.0
    /** Material window classes (AND 8.1); never "isTablet". */
    const val MEDIUM_WIDTH_DP = 600.0
    const val EXPANDED_WIDTH_DP = 840.0
    const val MEDIUM_HEIGHT_DP = 480.0
}

/** The Android viewport from the canvas size and the safe drawing insets (all in dp). Pure, so tests can call it. */
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
        // Android keeps the bottom toolbar in every orientation (S20 Q2).
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
        // Equality guarded in the presenter: only real size or inset changes reach it.
        SideEffect { stage.setViewport(viewport) }
        val snapshot = stage.layout
        val frames = remember(snapshot, viewport) {
            StageLayoutPolicy.frames(viewport = viewport, kind = snapshot.kind, slots = snapshot.slots, selfCorner = snapshot.selfCorner)
        }
        val seeds = remember(snapshot) { snapshot.overflowSeeds.toList() }
        Layout(
            modifier = Modifier.fillMaxSize().pointerInput(Unit) {
                // A tap on the stage outside a control toggles chrome (S20 8 d) and clears the bar hold (S30 CC16).
                detectTapGestures(onTap = {
                    stage.stageTapped()
                    chrome.send(ChromeVisibilityEvent.tap)
                })
            },
            content = {
                for (slot in snapshot.slots) {
                    key(slot.id) {
                        SlotView(slot, stage, renderers, snapshot.overflowCount, seeds, Modifier.layoutId(slot.id))
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
