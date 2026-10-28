package conclave.module

import androidx.activity.BackEventCompat
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlin.coroutines.cancellation.CancellationException

internal class NativePanelOverlayLifetime(private val coordinator: PanelCoordinator) {
    private var mountedSession: Int? = null
    private var mountedID: Int? = null

    fun mounted(session: Int, id: Int) {
        mountedSession = session
        mountedID = id
    }

    fun disposed(session: Int, id: Int) {
        if (mountedSession == session && mountedID == id) {
            mountedSession = null
            mountedID = null
        }
        coordinator.didDismiss(session = session, presentationID = id)
    }

    fun acknowledgeAbsent() {
        val state = coordinator.snapshot
        val request = state.current ?: return
        if (state.isDismissing && mountedID == null) {
            coordinator.didDismiss(session = state.session, presentationID = request.presentationID)
        }
    }
}

internal fun panelContainerVisible(state: PanelSnapshot): Boolean =
    state.current != null && !(state.isDismissing && state.pending == null)

internal data class PanelHostDecision(
    val style: PanelHostStyle,
    val coverage: PanelStageCoverage,
    val paneWidthDp: Int,
    val showsMiniTile: Boolean,
    val inCallAppearance: Boolean,
    val hasBottomComposer: Boolean,
    val skipsPartialSheet: Boolean = false,
)

internal fun panelHostDecision(
    request: PanelRequest,
    window: PanelWindow,
    sideStylesEnabled: Boolean = PanelPresentationPolicy.sideStylesEnabled,
    isAccessibilitySize: Boolean = false,
): PanelHostDecision {
    val presentation = PanelPresentationPolicy.resolve(request, window = window, platform = PanelPlatform.android,
        isAccessibilitySize = isAccessibilitySize, sideStylesEnabled = sideStylesEnabled)
    return PanelHostDecision(
        style = presentation.style,
        coverage = PanelPresentationPolicy.coverage(presentation, detent = null),
        paneWidthDp = presentation.paneWidth.toInt(),
        showsMiniTile = presentation.showsMiniTile,
        inCallAppearance = presentation.appearance == PanelAppearance.inCall,
        hasBottomComposer = presentation.hasBottomComposer,
        skipsPartialSheet = presentation.style == PanelHostStyle.bottomSheet &&
            PanelPresentationPolicy.bottomSheetSkipsPartialState(request.panel, isAccessibilitySize = isAccessibilitySize),
    )
}

internal data class PanelBarInputs(val overlayVisible: Boolean, val overlayInCall: Boolean)

internal fun panelBarInputs(state: PanelSnapshot, decision: PanelHostDecision?): PanelBarInputs {
    val overlay = decision != null && decision.style == PanelHostStyle.overlay && panelContainerVisible(state)
    return PanelBarInputs(overlayVisible = overlay, overlayInCall = overlay && decision?.inCallAppearance == true)
}

internal class PanelFocusTracker {
    var opener: String? = null
        private set
    private var overlayVisible = false

    fun invoked(tag: String) {
        if (!overlayVisible) opener = tag
    }

    fun update(visible: Boolean): String? {
        val target = if (overlayVisible && !visible) opener else null
        overlayVisible = visible
        return target
    }
}

internal class PanelInvokerFocus {
    val tracker = PanelFocusTracker()
    private val requesters = HashMap<String, FocusRequester>()

    fun requester(tag: String): FocusRequester = requesters.getOrPut(tag) { FocusRequester() }

    fun invoked(tag: String) = tracker.invoked(tag)

    fun restore(tag: String): Boolean = requesters[tag]?.requestFocusOrFalse() ?: false
}

internal fun FocusRequester.requestFocusOrFalse(): Boolean = runCatching { requestFocus() }.getOrDefault(false)

internal const val PANEL_FOCUS_ATTEMPTS = 10

internal suspend fun requestPanelFocus(attempts: Int, awaitFrame: suspend () -> Unit, request: () -> Boolean): Boolean {
    repeat(attempts) {
        awaitFrame()
        if (request()) return true
    }
    return false
}

internal fun Modifier.panelInvoker(focus: PanelInvokerFocus, tag: String): Modifier =
    this.focusRequester(focus.requester(tag)).focusProperties { canFocus = true }

internal class PanelPageStack {
    private val pages = mutableStateListOf<String>()

    var backProgress by mutableStateOf(PanelBackProgress())
        private set

    val depth: Int get() = pages.size

    val isNested: Boolean get() = pages.isNotEmpty()

    val top: String? get() = pages.lastOrNull()

    fun push(page: String) {
        pages.add(page)
        backProgress = PanelBackProgress()
    }

    fun pop(): Boolean {
        if (pages.isEmpty()) return false
        pages.removeAt(pages.size - 1)
        backProgress = PanelBackProgress()
        return true
    }

    fun popToRoot() {
        if (pages.isEmpty()) return
        pages.clear()
        backProgress = PanelBackProgress()
    }
}

internal val LocalPanelPageStack = staticCompositionLocalOf<PanelPageStack?> { null }

internal enum class PanelBackAction { PopPage, ClosePanel }

internal fun panelBackAction(pages: PanelPageStack): PanelBackAction =
    if (pages.isNested) PanelBackAction.PopPage else PanelBackAction.ClosePanel

internal fun performPanelBack(action: PanelBackAction, pages: PanelPageStack, panels: PanelCoordinator) {
    when (action) {
        PanelBackAction.PopPage -> pages.pop()
        PanelBackAction.ClosePanel -> panels.dismiss(cancelPending = true)
    }
}

internal class PanelHostReadout {
    var style by mutableStateOf(NONE)
        private set
    var mounts = 0
        private set
    var disposals = 0
        private set

    fun update(decision: PanelHostDecision?, visible: Boolean) {
        val text = if (decision == null || !visible) NONE
            else "style=${decision.style.rawValue} coverage=${decision.coverage.rawValue}"
        if (style != text) style = text
    }

    fun mounted() {
        mounts++
    }

    fun disposed() {
        disposals++
    }

    fun mountsSummary(): String = "mounts=$mounts disposals=$disposals"

    private companion object {
        const val NONE = "style=none coverage=none"
    }
}

@Composable
internal fun NativePanelHost(
    panels: PanelCoordinator,
    lifetime: NativePanelOverlayLifetime,
    focus: PanelInvokerFocus,
    readout: PanelHostReadout,
    systemBars: @Composable (PanelBarInputs) -> Unit,
    stage: @Composable (coverage: PanelStageCoverage) -> Unit,
    panel: @Composable (session: Int, request: PanelRequest, decision: PanelHostDecision, variant: InCallPageVariant) -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val state = panels.snapshot
        val window = PanelPresentationPolicy.androidWindow(width = maxWidth.value.toDouble(), height = maxHeight.value.toDouble())
        val accessibilitySize = PanelPresentationPolicy.androidIsAccessibilitySize(fontScale = LocalDensity.current.fontScale.toDouble())
        val rightToLeft = LocalLayoutDirection.current == LayoutDirection.Rtl
        val request = state.current
        val decision = remember(request, window.horizontalRegular, window.verticalRegular, accessibilitySize) {
            if (request == null) null else panelHostDecision(request, window, isAccessibilitySize = accessibilitySize)
        }
        val visible = panelContainerVisible(state)
        val overlay = decision != null && decision.style == PanelHostStyle.overlay && visible
        val sidePane = decision != null && decision.style == PanelHostStyle.sidePane && visible

        val bottomSheet = decision != null && decision.style == PanelHostStyle.bottomSheet && request != null
        val coverage = if ((overlay || bottomSheet) && decision != null) decision.coverage else PanelStageCoverage.none
        val covered = coverage == PanelStageCoverage.full
        val back = remember(state.session, request?.presentationID) { PanelBackProgress() }
        val pages = remember(state.session, request?.presentationID) { PanelPageStack() }
        val latestPanel by rememberUpdatedState(panel)
        val movablePanel = remember(state.session, request?.presentationID) {
            val session = state.session
            val shown = request
            if (shown == null) null else movableContentOf { variant: InCallPageVariant, current: PanelHostDecision ->
                CompositionLocalProvider(LocalPanelPageStack provides pages) {

                    Box(Modifier.fillMaxSize().graphicsLayer { translationX = pages.backProgress.pageTranslationDp * 1.dp.toPx() }) {
                        latestPanel(session, shown, current, variant)
                    }
                }
            }
        }
        systemBars(panelBarInputs(state, decision))
        SideEffect { readout.update(decision, overlay || sidePane || bottomSheet) }
        Row(Modifier.fillMaxSize()) {

            Box(
                Modifier.weight(1f).fillMaxHeight()
                    .semantics { if (covered) hideFromAccessibility() }
                    .focusProperties { onEnter = { if (covered) cancelFocusChange() } }
                    .focusGroup()
            ) {
                stage(coverage)
            }

            if (sidePane && request != null && decision != null && movablePanel != null) {
                PanelSidePane(decision, back, rightToLeft) {
                    if (!state.isDismissing) {
                        key(state.session, request.presentationID) { movablePanel(InCallPageVariant.SidePane, decision) }
                    }
                }
            }
        }
        if (overlay && request != null && decision != null && movablePanel != null) {

            HostingTheme(inCall = decision.inCallAppearance) {
                Surface(
                    modifier = Modifier.fillMaxSize()
                        .testTag("panel.overlay")
                        .graphicsLayer {
                            scaleX = back.scale
                            scaleY = back.scale
                            translationX = back.translationDp * 1.dp.toPx()
                        }
                        .focusProperties { onExit = { cancelFocusChange() } }
                        .focusGroup(),
                    color = MaterialTheme.colorScheme.surface,
                ) {
                    if (!state.isDismissing) {
                        key(state.session, request.presentationID) { movablePanel(InCallPageVariant.Overlay, decision) }
                    }
                }
            }
        }
        if (bottomSheet && request != null && decision != null) {

            key(state.session, request.presentationID) {
                val session = state.session
                LayoutSheetHost(
                    dismissing = state.isDismissing,
                    skipPartiallyExpanded = decision.skipsPartialSheet,
                    inCallAppearance = decision.inCallAppearance,
                    onDismissRequest = { panels.dismiss(cancelPending = false) },
                ) {
                    CompositionLocalProvider(LocalPanelPageStack provides pages) {
                        latestPanel(session, request, decision, InCallPageVariant.Sheet)
                    }
                }
            }
        }
        SideEffect { lifetime.acknowledgeAbsent() }

        PredictiveBackHandler(enabled = request != null && !state.isDismissing) { events ->
            val action = panelBackAction(pages)
            val progress = if (action == PanelBackAction.PopPage) pages.backProgress else back
            try {
                events.collect { event -> progress.update(event.progress, event.swipeEdge == BackEventCompat.EDGE_LEFT) }
                if (progress.commit()) performPanelBack(action, pages, panels)
            } catch (cancelled: CancellationException) {
                progress.cancel()
                throw cancelled
            }
        }

        val panelVisible = overlay || sidePane || bottomSheet
        LaunchedEffect(panelVisible) {
            val target = focus.tracker.update(panelVisible) ?: return@LaunchedEffect
            requestPanelFocus(PANEL_FOCUS_ATTEMPTS, awaitFrame = { withFrameNanos { } }) { focus.restore(target) }
        }
    }
}

@Composable
private fun PanelSidePane(decision: PanelHostDecision, back: PanelBackProgress, rightToLeft: Boolean, content: @Composable () -> Unit) {
    HostingTheme(inCall = decision.inCallAppearance) {
        Row(Modifier.fillMaxHeight().testTag("panel.sidePane")
            .graphicsLayer { translationX = back.paneTranslationDp(rightToLeft) * 1.dp.toPx() }) {
            VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Surface(
                modifier = Modifier.width(decision.paneWidthDp.dp).fillMaxHeight().focusGroup(),
                color = MaterialTheme.colorScheme.surface,
            ) {
                content()
            }
        }
    }
}
