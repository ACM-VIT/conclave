package conclave.module

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import skip.ui.UIApplication

/*
 * S20 1 d (STG-1): the native call root, always dark (HostingTheme(inCall = true)). The panel host owns the panels and
 * keeps the stage as its first child (PS 8.3); the stage surface layers the canvas, the solo invite card, the reaction
 * layer and the chrome as siblings, so a chrome change never recomposes a renderer. Back with no panel open minimizes
 * (never leaves); with a panel open the panel's own handler, registered later, closes it first. Entry point for the
 * native route behind the Debug `call` flag (the premeeting host mounts it; this file never reads the route flags) and
 * for the stage fixture (SL14).
 */

@Composable
internal fun CallRoot(
    shell: MeetingShellPresenter,
    stage: StagePresenter,
    renderers: StageRenderers,
    forceScreenReader: Boolean = false,
    onMinimize: () -> Unit,
    onRoute: () -> Unit = {},
) {
    HostingTheme(inCall = true) {
        val panels = shell.panels.snapshot
        val lifetime = remember(shell) { NativePanelOverlayLifetime(shell.panels) }
        val focus = remember { PanelInvokerFocus() }
        val readout = remember { PanelHostReadout() }
        val chrome = remember(stage) { StageChromeVisibilityState() }
        val systemDark = isSystemInDarkTheme()
        // PiP or moveTaskToBack, never a leave (S20 1 a); enabled only with no panel open (AND 10.2 item 4).
        BackHandler(enabled = panels.current == null) { onMinimize() }
        val ledger = renderers.ledger
        val content: @Composable () -> Unit = {
            NativePanelHost(
                panels = shell.panels,
                lifetime = lifetime,
                focus = focus,
                readout = readout,
                systemBars = { inputs ->
                    // Transparent bars with light icons over the stage; the host adds its overlay inputs (PS 8.7).
                    ConclaveSystemBars(SystemBarPolicy.resolve(rootDark = true, overlayVisible = inputs.overlayVisible,
                        overlayInCall = inputs.overlayInCall, bottomStripInCall = true, systemDark = systemDark))
                },
                stage = { coverage ->
                    StageSurface(shell, stage, renderers, chrome, coverage, forceScreenReader, onMinimize, onRoute)
                },
                panel = { session, request, decision, variant ->
                    CallPanelContent(shell, stage, renderers, session, request, decision, variant,
                        onMounted = { lifetime.mounted(session, request.presentationID) },
                        onDisposed = { lifetime.disposed(session, request.presentationID) })
                },
            )
        }
        if (ledger != null) {
            CompositionLocalProvider(LocalRendererLedger provides ledger) { content() }
        } else {
            content()
        }
    }
}

/**
 * Back with no panel open (S20 1 a): the call moves to the background and keeps running; it never leaves. SYS-4 (S70)
 * adds Picture in Picture entry here when the device and the call allow it.
 */
internal fun stageMinimizeToBackground() {
    UIApplication.shared.androidActivity?.moveTaskToBack(true)
}

@Composable
private fun StageSurface(
    shell: MeetingShellPresenter, stage: StagePresenter, renderers: StageRenderers, chrome: StageChromeVisibilityState,
    coverage: PanelStageCoverage, forceScreenReader: Boolean, onMinimize: () -> Unit, onRoute: () -> Unit,
) {
    val ext = LocalConclaveExtendedColors.current
    val paneTitle = conclaveString("stg_pane_call", stage.capsule.title)
    // A full overlay hides the stage from TalkBack (PS 8.3); the stage container only.
    val covered = coverage == PanelStageCoverage.full
    Box(
        Modifier.fillMaxSize().background(ext.stage).testTag("stage.root").semantics {
            this.paneTitle = paneTitle
            isTraversalGroup = true
            if (covered) hideFromAccessibility()
        },
    ) {
        StageCanvas(stage, renderers, chrome)
        StageSoloLayer(stage, Modifier.fillMaxSize())
        ReactionBurstLayer(stage)
        StageChrome(shell, stage, chrome, forceScreenReader, onMinimize, onRoute)
        StageAnnouncementRegion(stage)
        StageVisibilityReporter(stage, coverage, chrome)
    }
}

/**
 * One-shot announcements (S20 1 i) through one persistent 1 x 1 dp polite live region, because
 * the View announcement call is deprecated at API 36; two identical texts in a row clear for one frame first.
 */
@Composable
private fun StageAnnouncementRegion(stage: StagePresenter) {
    val announcement = stage.announcement
    val text = if (announcement == null) "" else stageAnnouncementText(announcement)
    var shown by remember { mutableStateOf("") }
    LaunchedEffect(announcement?.id) {
        if (text.isNotEmpty() && text == shown) {
            shown = ""
            withFrameNanos { }
        }
        shown = text
    }
    Box(Modifier.size(1.dp).semantics {
        liveRegion = LiveRegionMode.Polite
        contentDescription = shown
    })
}

@Composable
private fun stageAnnouncementText(announcement: StageAnnouncement): String = when (announcement.kind) {
    StageAnnouncement.joinedKind -> conclaveString("stg_announce_joined", announcement.name)
    else -> announcement.name
}

/** SL15: what the stage shows, from the laid-out frames, the panel coverage and the chrome state, debounced 150 ms. */
@Composable
private fun StageVisibilityReporter(stage: StagePresenter, coverage: PanelStageCoverage, chrome: StageChromeVisibilityState) {
    val layout = stage.layout
    val hidden = chrome.state.isHidden
    val report = remember(layout, coverage, hidden) {
        val viewport = stage.viewport
        val frames = StageLayoutPolicy.frames(viewport = viewport, kind = layout.kind, slots = layout.slots, selfCorner = layout.selfCorner)
        StageVisibilityPolicy.report(frames = frames, slots = layout.slots, viewport = viewport, kind = layout.kind,
            coverage = coverage.rawValue, chromeHidden = hidden, isInPip = false, pipTarget = null)
    }
    LaunchedEffect(report) {
        delay(StageVisibilityPolicy.debounceMillis.toLong())
        stage.reportVisibility(report)
    }
}

/**
 * Panel content inside the native call root. Content panels register here through requests as they land (CHT-1,
 * PPL-1, SET-1, ...); until then every panel opens its InCallPage with an empty body, which the fixture uses for the
 * open and close cells (S20 1 l5).
 */
@Composable
private fun CallPanelContent(
    shell: MeetingShellPresenter, stage: StagePresenter, renderers: StageRenderers, session: Int, request: PanelRequest, decision: PanelHostDecision,
    variant: InCallPageVariant, onMounted: () -> Unit, onDisposed: () -> Unit,
) {
    val miniTileVideo: (@Composable () -> Unit)? = if (renderers.usesProbes) {
        @Composable {
            RendererProbe(key = "mini:$session:${request.presentationID}", slot = RendererSlot.miniTile,
                modifier = Modifier.fillMaxSize(), pattern = renderers.pattern)
        }
    } else null
    InCallPage(
        title = stageCallPanelTitle(request.panel),
        variant = variant,
        appearance = if (decision.inCallAppearance) PanelAppearance.inCall else PanelAppearance.system,
        hasComposer = decision.hasBottomComposer,
        miniTile = if (decision.showsMiniTile) stageMiniTileModel(stage) else null,
        onClose = { shell.panels.dismiss(cancelPending = true) },
        onMounted = onMounted,
        onDisposed = onDisposed,
        miniTileVideo = miniTileVideo,
    ) { _ ->
        Column(Modifier.testTag("call.panel.${request.panel.rawValue}")) {}
    }
}

/** The call mini tile over a full overlay (PS 8.4): the first person on the stage. */
@Composable
private fun stageMiniTileModel(stage: StagePresenter): CallMiniTileModel? {
    val layout = stage.layout
    for (slot in layout.slots) {
        if (slot.id.startsWith("p:")) {
            val model = stage.tileChrome.entry(slot.userId).model
            val name = if (model.isLocal) conclaveString("ds_you") else model.displayName
            return CallMiniTileModel(displayName = name, cameraOff = model.isCameraOff, isLocal = model.isLocal,
                speaking = stage.speaking.state(slot.userId).isSpeaking)
        }
    }
    return null
}

@Composable
internal fun stageCallPanelTitle(panel: MeetingPanel): String = when (panel) {
    MeetingPanel.chat -> conclaveString("stg_panel_chat")
    MeetingPanel.participants -> conclaveString("native_panel_participants")
    MeetingPanel.transcript -> conclaveString("stg_panel_transcript")
    MeetingPanel.activities -> conclaveString("stg_panel_activities")
    MeetingPanel.effects -> conclaveString("stg_panel_effects")
    MeetingPanel.hostControls -> conclaveString("stg_panel_host_controls")
    MeetingPanel.settings -> conclaveString("native_panel_settings")
    MeetingPanel.webinarQA -> conclaveString("stg_panel_qa")
    MeetingPanel.meetingInfo -> conclaveString("stg_panel_meeting_details")
    MeetingPanel.layout -> conclaveString("native_panel_layout")
    else -> ""
}
