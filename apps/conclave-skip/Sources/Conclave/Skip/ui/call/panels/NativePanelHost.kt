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

/** Tracks actual composition lifetime, including requests coalesced before first presentation. */
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

/**
 * The container is visible while a panel is current, and stays through a replacement, so the stage never
 * flashes between two panels; Close hides it together with its content (PS 8.3).
 */
internal fun panelContainerVisible(state: PanelSnapshot): Boolean =
    state.current != null && !(state.isDismissing && state.pending == null)

/**
 * The host's cached decision for one presentation and window class (PS 8.2). `skipsPartialSheet` matters only for the
 * WP1-3c bottom sheet (SET-5): Effects and accessibility text sizes open it expanded.
 */
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

/** The panel inputs of the single system-bar owner (PS 8.7): a visible full-screen overlay and its appearance. */
internal data class PanelBarInputs(val overlayVisible: Boolean, val overlayInCall: Boolean)

internal fun panelBarInputs(state: PanelSnapshot, decision: PanelHostDecision?): PanelBarInputs {
    val overlay = decision != null && decision.style == PanelHostStyle.overlay && panelContainerVisible(state)
    return PanelBarInputs(overlayVisible = overlay, overlayInCall = overlay && decision?.inCallAppearance == true)
}

/**
 * Focus restore (PS 8.10, A16): the root control that opened the overlay gets TalkBack and keyboard focus back
 * when the overlay closes. Controls inside an open overlay (replacement, rapid, reset) never replace it, so a
 * close after any replacement or a session reset returns to the opener. Pure state; `update` runs with every
 * change of overlay visibility and returns the control to focus once, on the visible to hidden edge.
 */
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

/** One FocusRequester per invoking control, keyed by its test tag, so a restore can reach it. */
internal class PanelInvokerFocus {
    val tracker = PanelFocusTracker()
    private val requesters = HashMap<String, FocusRequester>()

    fun requester(tag: String): FocusRequester = requesters.getOrPut(tag) { FocusRequester() }

    fun invoked(tag: String) = tracker.invoked(tag)

    /**
     * Whether focus really moved to the control. A control that left composition, or one that cannot take focus,
     * answers false; that is not an error.
     */
    fun restore(tag: String): Boolean = requesters[tag]?.requestFocusOrFalse() ?: false
}

/**
 * A focus request that reports its real outcome: `requestFocus` answers false when no attached target can take
 * focus, and throws when the requester has no target at all, which also reads as false here.
 */
internal fun FocusRequester.requestFocusOrFalse(): Boolean = runCatching { requestFocus() }.getOrDefault(false)

/** Frames a panel focus request may wait for its target to attach and accept focus (PS 8.10). */
internal const val PANEL_FOCUS_ATTEMPTS = 10

/**
 * Asks for focus once per frame, after waiting for the frame, until a request lands or the attempts run out, and
 * reports whether one landed. A target composed in the same frame as the request gets the next frames to attach.
 */
internal suspend fun requestPanelFocus(attempts: Int, awaitFrame: suspend () -> Unit, request: () -> Boolean): Boolean {
    repeat(attempts) {
        awaitFrame()
        if (request()) return true
    }
    return false
}

/**
 * A root control that opens panels, registered for focus restore under its tag. Material clickables take focus
 * only outside touch mode (`Focusability.SystemDefined`), so after a tap Close could not hand focus back; this
 * control may always take focus, which lets the host return TalkBack and keyboard focus to it (PS 8.10, A16).
 */
internal fun Modifier.panelInvoker(focus: PanelInvokerFocus, tag: String): Modifier =
    this.focusRequester(focus.requester(tag)).focusProperties { canFocus = true }

/**
 * The in-pane pages of one presentation (S40 R40-12, PS 8.3): content pushes a page key (for example the chat GIF
 * picker or the reactions viewer in the side pane) instead of opening a window-level sheet over the live stage, and
 * renders the page `top` names. System Back pops the page before it closes the panel, and predictive back moves the
 * page, not the pane. One stack per presentation, remembered by the host, so it survives a move between the
 * overlay and the side pane; a replacement starts empty. Keys are plain strings (a route enum's raw value).
 */
internal class PanelPageStack {
    private val pages = mutableStateListOf<String>()

    /** Gesture progress of the pop in flight; a fresh instance per page, so a committed pop never latches the next. */
    var backProgress by mutableStateOf(PanelBackProgress())
        private set

    val depth: Int get() = pages.size

    val isNested: Boolean get() = pages.isNotEmpty()

    /** The page on top, or null at the panel's root page. */
    val top: String? get() = pages.lastOrNull()

    fun push(page: String) {
        pages.add(page)
        backProgress = PanelBackProgress()
    }

    /** Pops the top page; false at the root, where Back belongs to the panel. */
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

/** The shown presentation's page stack; null outside a panel host. */
internal val LocalPanelPageStack = staticCompositionLocalOf<PanelPageStack?> { null }

/** What one system Back does in an open panel (PS 8.5, S40 R40-12): an inner page pops first. */
internal enum class PanelBackAction { PopPage, ClosePanel }

internal fun panelBackAction(pages: PanelPageStack): PanelBackAction =
    if (pages.isNested) PanelBackAction.PopPage else PanelBackAction.ClosePanel

/** Applies a committed Back: a pop on the page stack, or Close (cancelling a pending replacement). */
internal fun performPanelBack(action: PanelBackAction, pages: PanelPageStack, panels: PanelCoordinator) {
    when (action) {
        PanelBackAction.PopPage -> pages.pop()
        PanelBackAction.ClosePanel -> panels.dismiss(cancelPending = true)
    }
}

/** Debug readouts: `panel.style` follows the host live; the mount counters are read on refresh only. */
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

/**
 * The Android panel host (PS 8.3, 8.5). The stage is the first child of one Row, created once and never moved
 * or made conditional; the expanded side pane follows it in the same Row and the full overlay sits above it.
 * The host measures its own constraints, so the decision is right in multi-window and on foldables. It only
 * translates the coordinator into containers and reports removal back after composition disposal; it never
 * presents or resets. One movable content per presentation carries the page between the overlay and the side
 * pane when the window class changes (WP1-3b2, PS 9.2): its remembered state and its mount survive the move, so
 * nothing is acknowledged and the coordinator keeps its request. Each presentation also gets its [PanelPageStack]
 * through [LocalPanelPageStack] (PNL-1, S40 R40-12): Back pops an inner page first, and the gesture moves that
 * page; at the root Back closes the panel, scaling the overlay or sliding the side pane toward its outer edge.
 * SET-5 (WP1-3c, PS 8.6) adds the bottom sheet for Layout and Effects in compact and medium windows: [LayoutSheetHost]
 * stays composed through the coordinator's dismissal until its hide completes, so the content acknowledges only after
 * the sheet is gone; the stage reads partial coverage under it (never hidden from accessibility), and the sheet's
 * dialog window handles Back and predictive back itself.
 */
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
        // The sheet follows the current request, through the dismissal, until its hide completes (PS 8.6).
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
                    // A pop in flight moves the page inside its container; the layer reads the progress, so the
                    // gesture redraws without recomposing the page.
                    Box(Modifier.fillMaxSize().graphicsLayer { translationX = pages.backProgress.pageTranslationDp * 1.dp.toPx() }) {
                        latestPanel(session, shown, current, variant)
                    }
                }
            }
        }
        systemBars(panelBarInputs(state, decision))
        SideEffect { readout.update(decision, overlay || sidePane || bottomSheet) }
        Row(Modifier.fillMaxSize()) {
            // The stage container alone reads the coverage, so opening a panel never recomposes stage tiles.
            // Covered: hidden from accessibility, and keyboard focus cannot enter it from the overlay.
            Box(
                Modifier.weight(1f).fillMaxHeight()
                    .semantics { if (covered) hideFromAccessibility() }
                    .focusProperties { onEnter = { if (covered) cancelFocusChange() } }
                    .focusGroup()
            ) {
                stage(coverage)
            }
            // Non-modal: the stage stays visible and reachable, and traversal reads the stage, then the pane.
            if (sidePane && request != null && decision != null && movablePanel != null) {
                PanelSidePane(decision, back, rightToLeft) {
                    if (!state.isDismissing) {
                        key(state.session, request.presentationID) { movablePanel(InCallPageVariant.SidePane, decision) }
                    }
                }
            }
        }
        if (overlay && request != null && decision != null && movablePanel != null) {
            // A Surface filling the window blocks pointer input from reaching the covered stage (AND-9). Its own
            // theme matches the page, so the container never shows another color between two panels.
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
            // WP1-3c (SET-5): one sheet per presentation, keyed so a replacement gets a fresh sheet state. The page is
            // invoked directly, not through the movable content: the sheet composes in its own dialog window, and a
            // window-class change to the side pane remounts the page (a disposal while not dismissing is a coordinator
            // no-op, PS 8.3 fallback).
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
        // Registered after the root handler, so it wins while a panel is open; the root handler closes the
        // preview only when no panel is current (PS 8.5).
        // An inner page pops first and its own progress moves it; at the root the panel's progress drives Close.
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
        // A move between the overlay and the side pane keeps the panel visible, so it restores nothing; a close
        // from either returns focus to the opener.
        val panelVisible = overlay || sidePane || bottomSheet
        LaunchedEffect(panelVisible) {
            val target = focus.tracker.update(panelVisible) ?: return@LaunchedEffect
            requestPanelFocus(PANEL_FOCUS_ATTEMPTS, awaitFrame = { withFrameNanos { } }) { focus.restore(target) }
        }
    }
}

/**
 * The expanded side pane (PS 8.3): a 1 dp divider and a fixed-width page container after the stage in the same
 * Row, so the stage only narrows and the pane sits at the end, mirroring to the start in right-to-left layouts.
 * It is not modal and is never laid over the stage. A Back gesture at the panel's root slides it up to 24 dp
 * toward its outer edge (PS 8.5); a pop of an inner page moves only the page.
 */
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
