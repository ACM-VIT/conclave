package conclave.module

import androidx.activity.BackEventCompat
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
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

/** The host's cached decision for one presentation and window class (PS 8.2). */
internal data class PanelHostDecision(
    val style: PanelHostStyle,
    val coverage: PanelStageCoverage,
    val paneWidthDp: Int,
    val showsMiniTile: Boolean,
    val inCallAppearance: Boolean,
    val hasBottomComposer: Boolean,
)

internal fun panelHostDecision(
    request: PanelRequest,
    window: PanelWindow,
    sideStylesEnabled: Boolean = PanelPresentationPolicy.sideStylesEnabled,
): PanelHostDecision {
    val presentation = PanelPresentationPolicy.resolve(request, window = window, platform = PanelPlatform.android,
        sideStylesEnabled = sideStylesEnabled)
    return PanelHostDecision(
        style = presentation.style,
        coverage = PanelPresentationPolicy.coverage(presentation, detent = null),
        paneWidthDp = presentation.paneWidth.toInt(),
        showsMiniTile = presentation.showsMiniTile,
        inCallAppearance = presentation.appearance == PanelAppearance.inCall,
        hasBottomComposer = presentation.hasBottomComposer,
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
 * or made conditional; the full overlay sits above it. The host measures its own constraints, so the decision
 * is right in multi-window and on foldables. It only translates the coordinator into containers and reports
 * removal back after composition disposal; it never presents or resets. WP1-3b2 adds the side pane after the
 * stage and moves the panel content with `movableContentOf`.
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
        val request = state.current
        val decision = remember(request, window.horizontalRegular, window.verticalRegular) {
            if (request == null) null else panelHostDecision(request, window)
        }
        val overlay = decision != null && decision.style == PanelHostStyle.overlay && panelContainerVisible(state)
        val coverage = if (overlay && decision != null) decision.coverage else PanelStageCoverage.none
        val covered = coverage == PanelStageCoverage.full
        val back = remember(state.session, request?.presentationID) { PanelBackProgress() }
        systemBars(panelBarInputs(state, decision))
        SideEffect { readout.update(decision, overlay) }
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
        }
        if (overlay && request != null && decision != null) {
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
                        key(state.session, request.presentationID) {
                            panel(state.session, request, decision, InCallPageVariant.Overlay)
                        }
                    }
                }
            }
        }
        SideEffect { lifetime.acknowledgeAbsent() }
        // Registered after the root handler, so it wins while a panel is open; the root handler closes the
        // preview only when no panel is current (PS 8.5).
        PredictiveBackHandler(enabled = request != null && !state.isDismissing) { events ->
            try {
                events.collect { event -> back.update(event.progress, event.swipeEdge == BackEventCompat.EDGE_LEFT) }
                if (back.commit()) panels.dismiss(cancelPending = true)
            } catch (cancelled: CancellationException) {
                back.cancel()
                throw cancelled
            }
        }
        LaunchedEffect(overlay) {
            val target = focus.tracker.update(overlay) ?: return@LaunchedEffect
            requestPanelFocus(PANEL_FOCUS_ATTEMPTS, awaitFrame = { withFrameNanos { } }) { focus.restore(target) }
        }
    }
}
