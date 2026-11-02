package conclave.module

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.constrainHeight
import kotlin.math.roundToInt

internal class ChatTimelineAnchor(private val listState: LazyListState, private val atBottom: State<Boolean>) {
    fun hold(deltaPx: Float, key: Any?) {
        if (deltaPx == 0f || atBottom.value || key == null) return
        val info = listState.layoutInfo
        val visible = info.visibleItemsInfo
        val row = visible.firstOrNull { it.key == key } ?: return
        val center = (info.viewportStartOffset + info.viewportEndOffset) / 2
        val anchor = visible.minByOrNull { kotlin.math.abs(it.offset + it.size / 2 - center) } ?: return
        if (row.index <= anchor.index) listState.dispatchRawDelta(deltaPx)
    }
}

internal val LocalChatTimelineAnchor = staticCompositionLocalOf<ChatTimelineAnchor?> { null }

private class ChatRevealMemory(var follows: Boolean)

private val ChatRevealSpec = tween<Float>(durationMillis = 220, easing = FastOutSlowInEasing)

@Composable
internal fun ChatAnchoredReveal(present: Boolean, anchorKey: Any?, modifier: Modifier = Modifier, onSettled: (Boolean) -> Unit = {},
    content: @Composable () -> Unit) {
    val anchor = LocalChatTimelineAnchor.current
    val reduceMotion = rememberReduceMotion()
    val memory = remember { ChatRevealMemory(follows = present) }
    val shown = remember { Animatable(0f) }
    var natural by remember { mutableIntStateOf(-1) }
    val target = if (present) natural else 0
    LaunchedEffect(target) {
        if (target < 0) return@LaunchedEffect
        if (memory.follows) {
            memory.follows = false
            shown.snapTo(target.toFloat())
            onSettled(present)
            return@LaunchedEffect
        }
        var previous = shown.value
        if (reduceMotion) {
            shown.snapTo(target.toFloat())
            anchor?.hold(target - previous, anchorKey)
        } else {
            shown.animateTo(target.toFloat(), ChatRevealSpec) {
                anchor?.hold(value - previous, anchorKey)
                previous = value
            }
        }
        onSettled(present)
    }
    Layout(
        content = { Box(Modifier.onSizeChanged { natural = it.height }) { content() } },
        modifier = modifier.graphicsLayer {
            clip = !memory.follows && shown.value < natural - 0.5f
            shape = RectangleShape
        },
    ) { measurables, constraints ->
        val placeable = measurables.first().measure(constraints.copy(minHeight = 0, maxHeight = Constraints.Infinity))
        val height = if (memory.follows) placeable.height else shown.value.roundToInt()
        layout(placeable.width, constraints.constrainHeight(height)) { placeable.place(0, 0) }
    }
}
