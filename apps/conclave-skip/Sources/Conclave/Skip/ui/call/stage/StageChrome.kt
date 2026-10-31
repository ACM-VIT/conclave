package conclave.module

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

internal class StageChromeVisibilityState {
    var state by mutableStateOf(ChromeVisibilityState.initial)
        private set
    var canAutoHide: Boolean = false
        private set

    fun send(event: ChromeVisibilityEvent) {
        val next = ChromeAutoHidePolicy.reduce(state, event = event, canAutoHide = canAutoHide)
        if (next != state) state = next
    }

    fun setCanAutoHide(value: Boolean) {
        if (canAutoHide == value) return
        canAutoHide = value
        send(ChromeVisibilityEvent.blockerChanged)
    }
}

@Composable
internal fun StageChrome(
    shell: MeetingShellPresenter, stage: StagePresenter, chrome: StageChromeVisibilityState, forceScreenReader: Boolean,
    onMinimize: () -> Unit, onRoute: () -> Unit, modifier: Modifier = Modifier,
) {
    val access = rememberSystemAccessibility()
    val accessState = access.state()
    val screenReader = forceScreenReader || accessState.isScreenReaderRunning
    val blocker = ChromeAutoHidePolicy.effectiveBlocker(presenter = stage.autoHideBlocker, screenReader = screenReader, focusInChrome = false)
    val canAutoHide = ChromeAutoHidePolicy.canAutoHideHeader(blocker = blocker, voiceOver = screenReader, switchControl = false, focusInChrome = false)
    SideEffect { chrome.setCanAutoHide(canAutoHide) }
    val state = chrome.state
    val armed = ChromeAutoHidePolicy.shouldArm(state, canAutoHide = canAutoHide)

    val timeout = accessState.recommendedTimeoutMillis
    LaunchedEffect(state.armSerial, armed) {
        if (!armed) return@LaunchedEffect
        val delayMillis = ChromeAutoHidePolicy.hideDelayMillis(timeoutMillis = timeout, holdUntilMillis = stage.recentJoinHoldUntilMillis,
            nowMillis = System.currentTimeMillis().toDouble())
        delay(delayMillis.toLong())
        chrome.send(ChromeVisibilityEvent.timerFired)
    }
    LaunchedEffect(screenReader) {
        if (screenReader) chrome.send(ChromeVisibilityEvent.screenReaderOn)
    }
    StageChromeRevealObserver(shell, chrome)
    val controls = LocalCallControls.current
    var routeSheetOpen by remember { mutableStateOf(false) }
    val routeAction: () -> Unit = {
        if (controls != null) {
            routeSheetOpen = true
        } else {
            onRoute()
        }
    }
    val visible = !state.isHidden
    val controlsVisible = !ChromeAutoHidePolicy.controlsHidden(state, canAutoHide =
        ChromeAutoHidePolicy.canAutoHide(blocker = blocker, voiceOver = screenReader, switchControl = false, focusInChrome = false))
    val enter = if (access.removeAnimations) EnterTransition.None else fadeIn(animationSpec = ConclaveMotion.chromeFade())
    val exit = if (access.removeAnimations) ExitTransition.None else fadeOut(animationSpec = ConclaveMotion.chromeFade())
    BoxWithConstraints(modifier.fillMaxSize()) {
        val capsuleMax = if (maxWidth >= 600.dp) 360.dp else maxWidth * ConclaveChromeMetrics.CAPSULE_MAX_WIDTH_FRACTION
        Column(
            Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .padding(12.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {

            Box(Modifier.heightIn(min = ConclaveChromeMetrics.HEIGHT_DP.dp)) {
                androidx.compose.animation.AnimatedVisibility(visible = visible, enter = enter, exit = exit) {
                    StageTopRow(stage, capsuleMax, onMinimize, routeAction)
                }
            }
            StageStatusChips(stage)
        }
        val stageWidth = maxWidth
        val stageHeight = maxHeight
        AnimatedVisibility(
            visible = controlsVisible, enter = enter, exit = exit,

            modifier = Modifier.align(Alignment.BottomCenter)
                .windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout)
                    .only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))
                .padding(bottom = 12.dp),
        ) {
            StageBarSlot(shell, stage, stageWidth, stageHeight)
        }
    }
    if (routeSheetOpen && controls != null) {
        AudioRouteSheet(controls, stage, onDismiss = { routeSheetOpen = false })
    }
}

@Composable
private fun StageChromeRevealObserver(shell: MeetingShellPresenter, chrome: StageChromeVisibilityState) {
    var microphoneOn = false
    for (row in shell.controls.rows) {
        if (row.id == MeetingControlID.microphone.rawValue) microphoneOn = row.isOn
    }
    val panelOpen = shell.panels.snapshot.current != null
    var seenMicrophone by remember { mutableStateOf<Boolean?>(null) }
    var seenPanel by remember { mutableStateOf(panelOpen) }
    LaunchedEffect(microphoneOn) {
        if (seenMicrophone != null && seenMicrophone != microphoneOn) chrome.send(ChromeVisibilityEvent.muteChanged)
        seenMicrophone = microphoneOn
    }
    LaunchedEffect(panelOpen) {
        if (seenPanel && !panelOpen) chrome.send(ChromeVisibilityEvent.panelClosed)
        seenPanel = panelOpen
    }
}

@Composable
private fun StageTopRow(stage: StagePresenter, capsuleMax: Dp, onMinimize: () -> Unit, onRoute: () -> Unit) {
    val snapshot = stage.chrome
    val haptics = rememberConclaveHaptics()
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        ConclaveMinimizeButton(onClick = onMinimize, identifier = "stage.minimize")
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f)) {
            StageCapsule(stage, capsuleMax, Modifier)
        }
        Spacer(Modifier.width(8.dp))
        ConclaveRouteButton(routeKind = snapshot.routeKind, routeName = snapshot.routeName, onClick = onRoute, identifier = "stage.route")
        if (snapshot.canFlipCamera) {
            Spacer(Modifier.width(8.dp))
            ConclaveFlipCameraButton(isFront = snapshot.isFrontCamera, onClick = {

                if (StageCameraFlip.perform(stage)) haptics.gesture(FeedbackKind.selectionChanged)
            }, identifier = "stage.flip")
        }
    }
}

@Composable
private fun StageCapsule(stage: StagePresenter, maxWidth: Dp, modifier: Modifier) {
    val model = stage.capsule
    val title = if (model.subtitleKind == AttendeeViewerPolicy.capsuleLiveKind) attendeeTitle(model.title) else model.title
    ConclaveMeetingCapsule(title = title, subtitle = stageCapsuleSubtitle(model), identifier = "stage.capsule",
        onClick = { stage.openMeetingInfo() }, modifier = modifier, locked = model.isLocked, captionsOn = model.captionsOn,
        live = model.subtitleKind == AttendeeViewerPolicy.capsuleLiveKind, maxWidth = maxWidth)
}

@Composable
internal fun stageCapsuleSubtitle(model: StageCapsuleModel): String = when (model.subtitleKind) {
    StageCapsuleModel.youPresentingKind -> conclaveString("stg_you_presenting")
    StageCapsuleModel.presentingKind -> conclaveString("ds_is_presenting", model.subtitleName)

    AttendeeViewerPolicy.capsuleLiveKind -> attendeeCapsuleSubtitle()
    StageCapsuleModel.aloneKind -> conclaveString("stg_just_you")
    else -> conclavePlural("stg_participants_count", model.count, model.count)
}

@Composable
private fun StageStatusChips(stage: StagePresenter) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        StageHandChip(stage)
        StageNowPlayingChip(stage)
    }
}

@Composable
private fun StageHandChip(stage: StagePresenter) {
    val haptics = rememberConclaveHaptics()
    when (stage.localHand) {
        LocalHandState.raised -> ConclaveStageChip(
            title = conclaveString("stg_hand_raised"), identifier = "stage.chip.hand", icon = ConclaveIcons.FrontHandFill1,
            actionTitle = conclaveString("stg_lower"),
            onAction = {
                stage.lowerHand()
                haptics.gesture(FeedbackKind.handLowered)
            },
            actionDescription = conclaveString("stg_lower_hand"),
        )
        LocalHandState.raising -> ConclaveStageChip(title = conclaveString("stg_raising_hand"), identifier = "stage.chip.hand",
            icon = ConclaveIcons.FrontHandFill1)
        LocalHandState.lowering -> ConclaveStageChip(title = conclaveString("stg_hand_raised"), identifier = "stage.chip.hand",
            icon = ConclaveIcons.FrontHandFill1)
        else -> {}
    }
}

@Composable
private fun StageNowPlayingChip(stage: StagePresenter) {
    val chip = stage.chrome.nowPlaying ?: return
    val name = activityStageDisplayName(chip.kind, chip.name)
    val icon = when (chip.kind) {
        "app" -> ConclaveIcons.AppsFill0
        "browser" -> ConclaveIcons.PublicFill0
        else -> ConclaveIcons.SportsEsportsFill0
    }
    ConclaveStageChip(title = conclaveString("stg_activity_running", name), identifier = "stage.chip.nowPlaying", icon = icon,
        actionTitle = conclaveString("stg_show"), onAction = { stage.showHiddenActivity() },
        actionDescription = conclaveString("stg_show_activity", name))
}

@Composable
private fun StageBarSlot(shell: MeetingShellPresenter, stage: StagePresenter, stageWidth: Dp, stageHeight: Dp) {
    val controls = LocalCallControls.current
    if (controls == null) {
        Box(Modifier) {}
        return
    }
    CallControlBar(controls, windowWidth = stageWidth, windowHeight = stageHeight)
}
