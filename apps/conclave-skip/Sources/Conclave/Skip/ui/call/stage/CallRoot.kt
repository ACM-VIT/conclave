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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/*
 * S20 1 d (STG-1): the native call root, always dark (HostingTheme(inCall = true)). The panel host owns the panels and
 * keeps the stage as its first child (PS 8.3); the stage surface layers the canvas, the solo invite card, the reaction
 * layer, the chrome and the STG-5 notice lanes as siblings, so a chrome or notice change never recomposes a renderer. Back with no panel open minimizes
 * (never leaves); with a panel open the panel's own handler, registered later, closes it first. Entry point for the
 * native route behind the Debug `call` flag (the premeeting host mounts it; this file never reads the route flags) and
 * for the stage fixture (SL14).
 */

@Composable
internal fun CallRoot(
    shell: MeetingShellPresenter,
    stage: StagePresenter,
    people: PeoplePresenter? = null,
    renderers: StageRenderers,
    forceScreenReader: Boolean = false,
    activitySession: ActivitySession? = null,
    /**
     * STG-6 (RECONCILE R34): who generates a missing webinar link for Meeting details. null on the live route, which
     * uses the People presenter's S50 HostControlsPresenter.ensureWebinarLink(); the stage fixture passes its counting
     * stand-in (StageFixtureSession.ensureWebinarLink).
     */
    webinarLinkProvider: (suspend () -> String?)? = null,
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
        // SYS-4 (S70 3 d): while this root is mounted, Main.kt never swaps to the legacy PipContent.
        DisposableEffect(Unit) {
            PipController.setNativeRootComposed(true)
            onDispose { PipController.setNativeRootComposed(false) }
        }
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
                    StageSurface(shell, stage, renderers, chrome, coverage, forceScreenReader, onMinimize, onRoute, people)
                },
                panel = { session, request, decision, variant ->
                    CallPanelContent(shell, stage, people, renderers, session, request, decision, variant,
                        onMounted = { lifetime.mounted(session, request.presentationID) },
                        onDisposed = { lifetime.disposed(session, request.presentationID) },
                        webinarLinkProvider = callRootWebinarLinkProvider(webinarLinkProvider, people))
                },
            )
        }
        // STG-7 (S20 SC11): the renderers report decoded frame sizes into the stage's store; STG-9: the activity card and
        // the Activities page read the session. One provider covers the stage and the panels.
        val frameSizes = stage.frameSizes
        val provided: @Composable () -> Unit = {
            CompositionLocalProvider(LocalRendererFrameSizes provides frameSizes, LocalActivitySession provides activitySession) {
                content()
            }
        }
        if (ledger != null) {
            CompositionLocalProvider(LocalRendererLedger provides ledger) { provided() }
        } else {
            provided()
        }
    }
}

/**
 * Back with no panel open (S20 1 a): the call moves to the background and keeps running; it never leaves. PiP entry
 * comes from PipManager (SYS-4).
 */
internal fun stageMinimizeToBackground() {
    // SYS-4 (S70 D9): PiP when the call is eligible and the person allows it, else the task moves to the back.
    PipManager.minimizeCurrent()
}

/**
 * STG-6 (RECONCILE R34): the one owner of webinar link generation is the S50 HostControlsPresenter (PPL-4); the root
 * forwards to it unless a fixture passed its own stand-in. Without either, the webinar link rows stay disabled.
 */
internal fun callRootWebinarLinkProvider(
    override: (suspend () -> String?)?,
    people: PeoplePresenter?,
): (suspend () -> String?)? {
    if (override != null) return override
    val owner = people ?: return null
    return suspend { owner.host.ensureWebinarLink() }
}

@Composable
private fun StageSurface(
    shell: MeetingShellPresenter, stage: StagePresenter, renderers: StageRenderers, chrome: StageChromeVisibilityState,
    coverage: PanelStageCoverage, forceScreenReader: Boolean, onMinimize: () -> Unit, onRoute: () -> Unit,
    people: PeoplePresenter? = null,
) {
    val ext = LocalConclaveExtendedColors.current
    // STG-8: an attendee's pane is named for the webinar (the capsule title is the webinar title, or the fallback).
    val capsule = stage.capsule
    val paneName = if (capsule.subtitleKind == AttendeeViewerPolicy.capsuleLiveKind) attendeeTitle(capsule.title) else capsule.title
    val paneTitle = conclaveString("stg_pane_call", paneName)
    // A full overlay hides the stage from TalkBack (PS 8.3); the stage container only.
    val covered = coverage == PanelStageCoverage.full
    // STG-7: the stage's position in the window, for the PiP target in window px (S70 R70-10).
    var origin by remember { mutableStateOf(Offset.Zero) }
    Box(
        Modifier.fillMaxSize().background(ext.stage).onGloballyPositioned { coordinates ->
            val bounds = coordinates.boundsInWindow()
            if (bounds.topLeft != origin) origin = bounds.topLeft
        }.testTag("stage.root").semantics {
            this.paneTitle = paneTitle
            isTraversalGroup = true
            if (covered) hideFromAccessibility()
        },
    ) {
        StageCanvas(stage, renderers, chrome)
        if (PipController.chromeHiddenForPip) {
            // SYS-4 (S70 3 b, 3 d): in PiP (or entering it on API 35) the canvas shows only the target (R9); this layer
            // adds its name pill, avatar, solo text and Reconnecting pill. Chrome, lanes and reactions are not composed.
            NativePipOverlay(stage, CallPresencePhasePolicy.phase(sessionPhase = shell.session.phase,
                interruption = AudioInterruptionKind.none))
        } else {
            StageSoloLayer(stage, Modifier.fillMaxSize())
            // STG-8 (S20 12 d): the attendee waiting state; reads only stage.attendee.
            AttendeeWaitingLayer(stage, Modifier.attendeeLayer())
            ReactionBurstLayer(stage)
            // PPL-2 (S50 3 j, R50-9): tile-menu confirmations over the stage, HostingTheme(inCall = true) inside.
            StagePeopleConfirmationHost(people)
            StageChrome(shell, stage, chrome, forceScreenReader, onMinimize, onRoute)
            // STG-5: banner, captions and toast lanes over the chrome; the notice sound output only on the live route.
            NoticeLanes(stage, forceScreenReader, installsSound = !renderers.usesProbes)
        }
        NoticeLaneSuspension(stage, coverage)
        StageAnnouncementRegion(stage)
        StageVisibilityReporter(stage, coverage, chrome, origin)
    }
}

/** RECONCILE R3: an Android full overlay suspends the toast lane; the side pane (no coverage) keeps it. */
@Composable
private fun NoticeLaneSuspension(stage: StagePresenter, coverage: PanelStageCoverage) {
    val suspended = coverage == PanelStageCoverage.full
    LaunchedEffect(suspended) { stage.setToastLaneSuspended(suspended) }
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
    // S70 R70-1 (STG-5): recovery starts and ends on the same one-shot channel.
    StageNoticeAnnouncementKind.reconnecting -> conclaveString("sys_announce_reconnecting")
    StageNoticeAnnouncementKind.reconnected -> conclaveString("sys_announce_reconnected")
    // STG-8 (S20 12 f, i): "You're now watching as an attendee." and "The webinar is live."
    AttendeeViewerPolicy.demotedAnnouncement, AttendeeViewerPolicy.webinarLiveAnnouncement ->
        attendeeAnnouncementText(announcement.kind) ?: announcement.name
    // STG-2 pin announcements (TileMenu.kt, HD request B4-T5 R9), then STG-9 activity start and end (ActivityStage.kt,
    // HD request B4-T8 R5b).
    else -> tileAnnouncementText(announcement) ?: shareAnnouncementText(announcement)
        ?: activityStageAnnouncement(announcement.kind, announcement.name) ?: announcement.name
}

/** SL15: what the stage shows, from the laid-out frames, the panel coverage and the chrome state, debounced 150 ms. */
@Composable
private fun StageVisibilityReporter(stage: StagePresenter, coverage: PanelStageCoverage, chrome: StageChromeVisibilityState, origin: Offset) {
    val layout = stage.layout
    val hidden = chrome.state.isHidden
    val inPip = PipController.inPipMode
    // STG-7 (S20 SC11): the PiP target in window px from dp through the density (S70 R70-10); `isInPip` follows
    // PipController (SYS-4); SC11 keeps only the target's video in PiP.
    val choice = stage.pipTarget
    val sizeRevision = stage.frameSizes.revision
    val density = LocalDensity.current.density.toDouble()
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val report = remember(layout, coverage, hidden, inPip, choice, sizeRevision, density, rtl, origin) {
        val viewport = stage.viewport
        val frames = StageLayoutPolicy.frames(viewport = viewport, kind = layout.kind, slots = layout.slots, selfCorner = layout.selfCorner)
        val pipTarget = PipTargetPolicy.frame(choice = choice, frames = frames, canvasWidth = viewport.width,
            originX = origin.x.toDouble(), originY = origin.y.toDouble(), scale = density, isRightToLeft = rtl,
            frameSize = stage.frameSizes.size(slotId = choice.slotId))
        StageVisibilityPolicy.report(frames = frames, slots = layout.slots, viewport = viewport, kind = layout.kind,
            coverage = coverage.rawValue, chromeHidden = hidden, isInPip = inPip, pipTarget = pipTarget)
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
    shell: MeetingShellPresenter, stage: StagePresenter, people: PeoplePresenter?, renderers: StageRenderers, session: Int,
    request: PanelRequest, decision: PanelHostDecision, variant: InCallPageVariant, onMounted: () -> Unit, onDisposed: () -> Unit,
    webinarLinkProvider: (suspend () -> String?)? = null,
) {
    val miniTileVideo: (@Composable () -> Unit)? = if (renderers.usesProbes) {
        @Composable {
            RendererProbe(key = "mini:$session:${request.presentationID}", slot = RendererSlot.miniTile,
                modifier = Modifier.fillMaxSize(), pattern = renderers.pattern)
        }
    } else null
    if (request.panel == MeetingPanel.meetingInfo) {
        // STG-6 (S20 15 d): Meeting details, or Webinar details for an attendee (RECONCILE R44); Host controls and the
        // attendee Settings push on the host's page stack.
        MeetingDetailsPage(
            stage = stage,
            request = request,
            variant = variant,
            appearance = if (decision.inCallAppearance) PanelAppearance.inCall else PanelAppearance.system,
            miniTile = if (decision.showsMiniTile) stageMiniTileModel(stage) else null,
            onClose = { shell.panels.dismiss(cancelPending = true) },
            onMounted = onMounted,
            onDisposed = onDisposed,
            miniTileVideo = miniTileVideo,
            webinarLinkProvider = webinarLinkProvider,
            people = people,
        )
        return
    }
    if (request.panel == MeetingPanel.chat) {
        // CHT-1 (S40 1): the chat page passes hasComposer and the lazyList content mode to InCallPage itself.
        ChatPanel(
            presenter = shell.chat,
            panels = shell.panels,
            request = request,
            variant = variant,
            appearance = if (decision.inCallAppearance) PanelAppearance.inCall else PanelAppearance.system,
            miniTile = if (decision.showsMiniTile) stageMiniTileModel(stage) else null,
            miniTileVideo = miniTileVideo,
            onMounted = onMounted,
            onDisposed = onDisposed,
        )
        return
    }
    if (request.panel == MeetingPanel.participants && people != null) {
        // PPL-1 (S50 1 d): the native Participants page, InCallPage in lazyList mode with the host's page stack.
        ParticipantsPage(
            people = people,
            request = request,
            variant = variant,
            appearance = if (decision.inCallAppearance) PanelAppearance.inCall else PanelAppearance.system,
            miniTile = if (decision.showsMiniTile) stageMiniTileModel(stage) else null,
            onClose = { shell.panels.dismiss(cancelPending = true) },
            onMounted = onMounted,
            onDisposed = onDisposed,
            miniTileVideo = miniTileVideo,
        )
        return
    }
    if (request.panel == MeetingPanel.hostControls && people != null) {
        // PPL-4 (S50 6 a): Host controls as a root page, InCallPage in lazyList mode whose page stack starts at Host
        // controls (R50-2); the access, notice and webinar pages push on the same stack.
        HostControlsPage(
            people = people,
            request = request,
            variant = variant,
            appearance = if (decision.inCallAppearance) PanelAppearance.inCall else PanelAppearance.system,
            miniTile = if (decision.showsMiniTile) stageMiniTileModel(stage) else null,
            onClose = { shell.panels.dismiss(cancelPending = true) },
            onMounted = onMounted,
            onDisposed = onDisposed,
            miniTileVideo = miniTileVideo,
        )
        return
    }
    val activitySession = LocalActivitySession.current
    if (request.panel == MeetingPanel.activities && activitySession != null) {
        // ACT-1 (S60 7): the Activities launcher page.
        ActivitiesPage(activitySession, request, variant,
            appearance = if (decision.inCallAppearance) PanelAppearance.inCall else PanelAppearance.system,
            miniTile = if (decision.showsMiniTile) stageMiniTileModel(stage) else null,
            onClose = { shell.panels.dismiss(cancelPending = true) }, onMounted = onMounted, onDisposed = onDisposed,
            miniTileVideo = miniTileVideo)
        return
    }
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
