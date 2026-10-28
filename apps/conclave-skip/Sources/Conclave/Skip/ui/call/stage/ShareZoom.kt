package conclave.module

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateCentroidSize
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

internal val LocalStageRenderTargetResize = staticCompositionLocalOf<(() -> Unit)?> { null }

internal class ShareZoomState {
    var live by mutableStateOf(ShareZoomValue.identity)
        private set
    var settled by mutableStateOf(ShareZoomValue.identity)
        private set
    var layoutScale by mutableStateOf(1.0)
        private set

    private var gestureStart = ShareZoomValue.identity
    private var magnification = 1.0
    private var anchorX = 0.0
    private var anchorY = 0.0
    private var translationX = 0.0
    private var translationY = 0.0
    private var token = 0
    private var settleJob: Job? = null
    private var slotWidth = 0.0
    private var slotHeight = 0.0
    private var videoWidth = 0.0
    private var videoHeight = 0.0
    var isGestureActive = false
        private set

    fun updateVideoSize(size: RendererFrameSize) {
        videoWidth = size.width.toDouble()
        videoHeight = size.height.toDouble()
    }

    fun beginGesture(centroid: Offset) {
        token += 1
        settleJob?.cancel()
        settleJob = null
        isGestureActive = true
        gestureStart = live
        magnification = 1.0
        translationX = 0.0
        translationY = 0.0
        anchorX = centroid.x.toDouble()
        anchorY = centroid.y.toDouble()
    }

    fun gestureChanged(zoomChange: Float, pan: Offset) {
        magnification *= zoomChange.toDouble()
        translationX += pan.x.toDouble()
        translationY += pan.y.toDouble()
        val next = ShareZoomPolicy.live(start = gestureStart, magnification = magnification, anchorX = anchorX, anchorY = anchorY,
            translationX = translationX, translationY = translationY, slotWidth = slotWidth, slotHeight = slotHeight,
            videoWidth = videoWidth, videoHeight = videoHeight)
        if (next != live) live = next
    }

    fun endGesture() {
        isGestureActive = false
    }

    fun settleTarget(): ShareZoomValue = ShareZoomPolicy.settled(live, slotWidth = slotWidth, slotHeight = slotHeight,
        videoWidth = videoWidth, videoHeight = videoHeight)

    fun doubleTapTarget(at: Offset): ShareZoomValue = ShareZoomPolicy.doubleTapped(live, atX = at.x.toDouble(), atY = at.y.toDouble(),
        slotWidth = slotWidth, slotHeight = slotHeight, videoWidth = videoWidth, videoHeight = videoHeight)

    fun steppedTarget(zoomIn: Boolean): ShareZoomValue = ShareZoomPolicy.stepped(live, zoomIn = zoomIn, slotWidth = slotWidth,
        slotHeight = slotHeight, videoWidth = videoWidth, videoHeight = videoHeight)

    fun settle(target: ShareZoomValue, scope: CoroutineScope, reduceMotion: Boolean, onResize: (() -> Unit)?) {
        token += 1
        val expected = token
        settleJob?.cancel()
        settleJob = null
        val start = live
        if (reduceMotion || start == target) {
            commit(target, expected, onResize)
            return
        }
        settleJob = scope.launch {
            val progress = Animatable(0f)
            progress.animateTo(1f, ConclaveMotion.zoomSnap()) {
                live = ShareZoomPolicy.interpolated(start = start, end = target, fraction = value.toDouble())
            }
            commit(target, expected, onResize)
        }
    }

    private fun commit(value: ShareZoomValue, expected: Int, onResize: (() -> Unit)?) {
        if (expected != token) return
        live = value
        settled = value
        val next = ShareZoomPolicy.layoutScale(scale = value.scale, slotWidth = slotWidth, slotHeight = slotHeight,
            pixelsPerUnit = 1.0, videoWidth = videoWidth, videoHeight = videoHeight)
        if (next != layoutScale) {
            layoutScale = next
            onResize?.invoke()
        }
    }

    fun slotSizeChanged(width: Int, height: Int, onResize: (() -> Unit)?) {
        val first = slotWidth == 0.0 && slotHeight == 0.0
        if (width.toDouble() == slotWidth && height.toDouble() == slotHeight) return
        slotWidth = width.toDouble()
        slotHeight = height.toDouble()
        if (first) return
        token += 1
        settleJob?.cancel()
        settleJob = null
        isGestureActive = false
        if (live != ShareZoomValue.identity) live = ShareZoomValue.identity
        if (settled != ShareZoomValue.identity) settled = ShareZoomValue.identity
        if (layoutScale != 1.0) {
            layoutScale = 1.0
            onResize?.invoke()
        }
    }
}

@Composable
internal fun ShareZoomBox(
    state: ShareZoomState, zoomable: Boolean, slotId: String, stage: StagePresenter, modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val reduceMotion = rememberReduceMotion()
    val reduce by rememberUpdatedState(reduceMotion)
    val onResize by rememberUpdatedState(LocalStageRenderTargetResize.current)
    val chrome by rememberUpdatedState(LocalStageChromeVisibility.current)
    Box(
        modifier
            .clipToBounds()
            .onSizeChanged { size -> state.slotSizeChanged(size.width, size.height, onResize) }
            .pointerInput(zoomable) {
                if (!zoomable) return@pointerInput
                detectShareZoomGestures(
                    canPan = { state.settled.isZoomed },
                    onStart = { centroid ->
                        state.updateVideoSize(stage.frameSizes.size(slotId = slotId))
                        state.beginGesture(centroid)
                    },
                    onChange = { zoomChange, pan -> state.gestureChanged(zoomChange, pan) },
                    onEnd = {
                        state.endGesture()
                        state.settle(state.settleTarget(), scope, reduce, onResize)
                    },
                )
            }
            .pointerInput(zoomable) {
                if (!zoomable) return@pointerInput
                detectTapGestures(
                    onDoubleTap = { at ->
                        state.updateVideoSize(stage.frameSizes.size(slotId = slotId))
                        state.settle(state.doubleTapTarget(at), scope, reduce, onResize)
                    },
                    onTap = {

                        stage.stageTapped()
                        chrome?.send(ChromeVisibilityEvent.tap)
                    },
                )
            },
    ) {
        Box(
            Modifier.shareZoomLayout(state).graphicsLayer {
                val live = state.live
                val scale = (live.scale / state.layoutScale).toFloat()
                scaleX = scale
                scaleY = scale
                translationX = live.panX.toFloat()
                translationY = live.panY.toFloat()
            },
        ) {
            content()
        }
    }
}

private fun Modifier.shareZoomLayout(state: ShareZoomState): Modifier = layout { measurable, constraints ->
    val width = constraints.maxWidth
    val height = constraints.maxHeight
    val scale = state.layoutScale
    val laidWidth = (width * scale).roundToInt().coerceAtLeast(0)
    val laidHeight = (height * scale).roundToInt().coerceAtLeast(0)
    val placeable = measurable.measure(Constraints.fixed(laidWidth, laidHeight))
    layout(width, height) {
        placeable.place((width - laidWidth) / 2, (height - laidHeight) / 2)
    }
}

private suspend fun PointerInputScope.detectShareZoomGestures(
    canPan: () -> Boolean, onStart: (Offset) -> Unit, onChange: (Float, Offset) -> Unit, onEnd: () -> Unit,
) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false)
        var zoom = 1f
        var pan = Offset.Zero
        var pastSlop = false
        val slop = viewConfiguration.touchSlop
        do {
            val event = awaitPointerEvent()
            val canceled = event.changes.any { it.isConsumed }
            if (!canceled) {
                val zoomChange = event.calculateZoom()
                val fingers = event.changes.count { it.pressed }
                val panChange = if (canPan() || fingers > 1) event.calculatePan() else Offset.Zero
                if (!pastSlop) {
                    zoom *= zoomChange
                    pan += panChange
                    val zoomMotion = abs(1f - zoom) * event.calculateCentroidSize(useCurrent = false)
                    if (zoomMotion > slop || pan.getDistance() > slop) {
                        pastSlop = true
                        onStart(event.calculateCentroid(useCurrent = false))
                    }
                }
                if (pastSlop) {
                    if (zoomChange != 1f || panChange != Offset.Zero) onChange(zoomChange, panChange)
                    for (change in event.changes) {
                        if (change.positionChanged()) change.consume()
                    }
                }
            }
        } while (!canceled && event.changes.any { it.pressed })
        if (pastSlop) onEnd()
    }
}

@Composable
internal fun SharePlaceholder(model: TileChromeModel, binding: RendererBinding, isShare: Boolean, modifier: Modifier = Modifier) {
    if (!isShare) return
    val local = model.isLocal
    if (!local && binding.videoKey.isNotEmpty()) return
    val scheme = MaterialTheme.colorScheme
    val text = if (local) conclaveString("stg_you_presenting") else conclaveString("ds_is_presenting", model.displayName)
    val identity = remember(model.avatarSeed) { ConclaveAvatarIdentity.fromSeed(model.avatarSeed) }
    Column(
        modifier.background(scheme.surfaceContainer).padding(horizontal = 16.dp).semantics { hideFromAccessibility() },
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (local) {
            Icon(ConclaveIcons.PresentToAllFill1, contentDescription = null, tint = scheme.onSurface, modifier = Modifier.size(32.dp))
        } else {
            ConclaveAvatar(identity, ConclaveAvatarSize.lobby.diameter.dp)
        }
        Spacer(Modifier.height(12.dp))
        ConclaveText(text, line = "stage.share.placeholder", style = MaterialTheme.typography.titleMedium, color = scheme.onSurface,
            textAlign = TextAlign.Center, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
internal fun ShareResetZoomChip(state: ShareZoomState, zoomable: Boolean, onReset: () -> Unit, modifier: Modifier = Modifier) {
    if (!zoomable || !state.settled.isZoomed) return
    val density = LocalDensity.current
    val direction = LocalLayoutDirection.current
    val insets = WindowInsets.safeDrawing
    val top = with(density) { insets.getTop(density).toDp() } + StageCanvasMetrics.TOP_RESERVE_DP.dp
    val end = with(density) {
        (if (direction == LayoutDirection.Ltr) insets.getRight(density, direction) else insets.getLeft(density, direction)).toDp()
    } + 12.dp
    ConclaveStageChip(title = conclaveString("stg_reset_zoom"), identifier = "stage.share.resetZoom",
        modifier = modifier.padding(top = top, end = end), onClick = onReset)
}

@Composable
internal fun shareNodeLabel(model: TileChromeModel): String =
    if (model.isLocal) conclaveString("stg_you_presenting") else conclaveString("stg_shared_screen_from", model.displayName)

@Composable
internal fun shareZoomValue(state: ShareZoomState, zoomable: Boolean): String {
    val settled = state.settled
    if (!zoomable || !settled.isZoomed) return ""
    val spoken = ShareZoomPolicy.spokenScale(settled.scale)
    val digits = if (ShareZoomPolicy.isWholeScale(settled.scale)) "%.0f" else "%.1f"
    return conclaveString("stg_zoom_value", String.format(Locale.getDefault(), digits, spoken))
}

@Composable
internal fun shareAnnouncementText(announcement: StageAnnouncement): String? =
    if (announcement.kind == ShareAnnouncementPolicy.presentingKind) conclaveString("stg_announce_presenting", announcement.name) else null

@Composable
internal fun rememberShareZoomActions(state: ShareZoomState, zoomable: Boolean, slotId: String, stage: StagePresenter): List<ConclaveTileAction> {
    val zoomIn = conclaveString("stg_zoom_in")
    val zoomOut = conclaveString("stg_zoom_out")
    val reset = conclaveString("stg_reset_zoom")
    val scope = rememberCoroutineScope()
    val reduceMotion = rememberReduceMotion()
    val onResize = LocalStageRenderTargetResize.current
    val zoomed = state.settled.isZoomed
    return remember(zoomable, zoomed, zoomIn, zoomOut, reset, reduceMotion, onResize) {
        if (!zoomable) {
            emptyList()
        } else {
            val step: (Boolean) -> Unit = { inward ->
                state.updateVideoSize(stage.frameSizes.size(slotId = slotId))
                state.settle(state.steppedTarget(inward), scope, reduceMotion, onResize)
            }
            val result = mutableListOf(ConclaveTileAction("share.zoomIn", zoomIn) { step(true) })
            if (zoomed) {
                result.add(ConclaveTileAction("share.zoomOut", zoomOut) { step(false) })
                result.add(ConclaveTileAction("share.resetZoom", reset) {
                    state.settle(ShareZoomValue.identity, scope, reduceMotion, onResize)
                })
            }
            result
        }
    }
}
