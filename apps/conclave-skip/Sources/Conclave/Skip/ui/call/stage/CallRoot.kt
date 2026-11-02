package conclave.module

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
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

@Composable
internal fun CallRoot(
    shell: MeetingShellPresenter,
    stage: StagePresenter,
    people: PeoplePresenter? = null,
    renderers: StageRenderers,
    forceScreenReader: Boolean = false,
    activitySession: ActivitySession? = null,

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
        val systemDark = conclaveUsesDarkAppearance()

        DisposableEffect(Unit) {
            PipController.setNativeRootComposed(true)
            onDispose { PipController.setNativeRootComposed(false) }
        }

        CallKeepScreenOnEffect()

        BackHandler(enabled = panels.current == null) { onMinimize() }
        val ledger = renderers.ledger
        val content: @Composable () -> Unit = {
            NativePanelHost(
                panels = shell.panels,
                lifetime = lifetime,
                focus = focus,
                readout = readout,
                systemBars = { inputs ->

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

        val frameSizes = stage.frameSizes
        val provided: @Composable () -> Unit = {
            CompositionLocalProvider(LocalRendererFrameSizes provides frameSizes, LocalActivitySession provides activitySession) {
                content()
            }
        }

        val rootFocus = remember { FocusRequester() }
        LaunchedEffect(Unit) { runCatching { rootFocus.requestFocus() } }
        Box(
            Modifier
                .fillMaxSize()
                .callControlsKeyboardShortcuts(LocalCallControls.current)
                .focusRequester(rootFocus)
                .focusable()
        ) {
            if (ledger != null) {
                CompositionLocalProvider(LocalRendererLedger provides ledger) { provided() }
            } else {
                provided()
            }
        }
    }
}

internal fun stageMinimizeToBackground() {

    PipManager.minimizeCurrent()
}

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

    val capsule = stage.capsule
    val paneName = if (capsule.subtitleKind == AttendeeViewerPolicy.capsuleLiveKind) attendeeTitle(capsule.title) else capsule.title
    val paneTitle = conclaveString("stg_pane_call", paneName)

    val covered = coverage == PanelStageCoverage.full

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

            NativePipOverlay(stage, CallPresencePhasePolicy.phase(sessionPhase = shell.session.phase,
                interruption = AudioInterruptionKind.none))
        } else {
            AttendeeWaitingLayer(stage, Modifier.attendeeLayer())

            AttendeeRoleLayer(stage)
            ReactionBurstLayer(stage)

            StagePeopleConfirmationHost(people)
            StageChrome(shell, stage, chrome, forceScreenReader, onMinimize, onRoute)

            NoticeLanes(stage, forceScreenReader, installsSound = !renderers.usesProbes)
        }
        NoticeLaneSuspension(stage, coverage)
        StageAnnouncementRegion(stage)
        StageVisibilityReporter(stage, coverage, chrome, origin)
    }
}

@Composable
private fun NoticeLaneSuspension(stage: StagePresenter, coverage: PanelStageCoverage) {
    val suspended = coverage == PanelStageCoverage.full || coverage == PanelStageCoverage.partial
    LaunchedEffect(suspended) { stage.setToastLaneSuspended(suspended) }
}

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

    StageAnnouncement.handRaisedKind -> conclaveString("ctl_announce_hand_raised")
    StageAnnouncement.handLoweredKind -> conclaveString("ctl_announce_hand_lowered")

    StageNoticeAnnouncementKind.reconnecting -> conclaveString("sys_announce_reconnecting")
    StageNoticeAnnouncementKind.reconnected -> conclaveString("sys_announce_reconnected")

    AttendeeViewerPolicy.demotedAnnouncement, AttendeeViewerPolicy.webinarLiveAnnouncement ->
        attendeeAnnouncementText(announcement.kind) ?: announcement.name

    else -> tileAnnouncementText(announcement) ?: shareAnnouncementText(announcement)
        ?: activityStageAnnouncement(announcement.kind, announcement.name) ?: announcement.name
}

@Composable
private fun StageVisibilityReporter(stage: StagePresenter, coverage: PanelStageCoverage, chrome: StageChromeVisibilityState, origin: Offset) {
    val layout = stage.layout
    val hidden = chrome.state.isHidden
    val inPip = PipController.inPipMode

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
            settings = shell.settings,
        )
        return
    }
    if (request.panel == MeetingPanel.chat) {

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
    if (request.panel == MeetingPanel.webinarQA && people != null) {

        QaPage(
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
    if (request.panel == MeetingPanel.settings) {

        SettingsPage(
            settings = shell.settings,
            people = people,
            panels = shell.panels,
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
    if (request.panel == MeetingPanel.layout) {

        LayoutPage(
            layout = stage.layoutPanel,
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
    if (request.panel == MeetingPanel.effects && EffectsAvailabilityPolicy.showsPanelEntry(stage.effects.snapshot.availability)) {

        EffectsPage(
            effects = stage.effects,
            variant = variant,
            appearance = if (decision.inCallAppearance) PanelAppearance.inCall else PanelAppearance.system,
            miniTile = if (decision.showsMiniTile) stageMiniTileModel(stage) else null,
            onClose = { shell.panels.dismiss(cancelPending = true) },
            onMounted = onMounted,
            onDisposed = onDisposed,
            miniTileVideo = miniTileVideo,
            preview = { snapshot -> EffectsPreviewContent(stage, renderers, session, request, snapshot) },
        )
        return
    }
    if (request.panel == MeetingPanel.transcript) {

        TranscriptPage(
            presenter = shell.transcript,
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
    val activitySession = LocalActivitySession.current
    if (request.panel == MeetingPanel.activities && activitySession != null) {

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

@Composable
private fun EffectsPreviewContent(
    stage: StagePresenter, renderers: StageRenderers, session: Int, request: PanelRequest, snapshot: EffectsSnapshot,
) {
    if (renderers.usesProbes) {
        RendererProbe(key = "effects:$session:${request.presentationID}", slot = RendererSlot.miniTile,
            modifier = Modifier.fillMaxSize(), pattern = renderers.pattern)
        return
    }
    if (snapshot.camera == EffectsCameraState.on) {
        val local = stage.inputs.localUserId
        val videoKey = stage.inputs.participant(local)?.videoKey ?: ""
        StageLiveVideo(slotId = "effects:${request.presentationID}", userId = local, isLocal = true, isShare = false,
            videoKey = videoKey, fit = StageVideoFit.fill, mirror = stage.chrome.isFrontCamera)
    } else {
        LocalPreviewSurface(LocalPreviewController.shared.sessionId)
    }
}

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
