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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/*
 * S20 7 and 8 (STG-4): the top row (Minimize, meeting capsule, audio route, flip camera), the flat status chips (they
 * stay while chrome hides), the toolbar slot (the S30 control bar, CTL-1) and chrome visibility. Android has no glass: the
 * chrome components draw the flat label scrim. The one timer is a LaunchedEffect keyed on the arm serial and the
 * eligibility, armed only while chrome is visible and nothing blocks; nothing ticks while hidden or blocked (RR8). No
 * immersive mode: the status and navigation bars stay (AND 9.2 item 2).
 */

/** View-local chrome visibility (SL8) over the shared ChromeAutoHidePolicy state machine. */
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
    val canAutoHide = ChromeAutoHidePolicy.canAutoHide(blocker = blocker, voiceOver = screenReader, switchControl = false, focusInChrome = false)
    SideEffect { chrome.setCanAutoHide(canAutoHide) }
    val state = chrome.state
    val armed = ChromeAutoHidePolicy.shouldArm(state, canAutoHide = canAutoHide)
    // API 29+ stretches the 5 s base through getRecommendedTimeoutMillis (read by the system accessibility reader).
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
    val visible = !state.isHidden
    val enter = if (access.removeAnimations) EnterTransition.None else fadeIn(animationSpec = ConclaveMotion.chromeFade())
    val exit = if (access.removeAnimations) ExitTransition.None else fadeOut(animationSpec = ConclaveMotion.chromeFade())
    BoxWithConstraints(modifier.fillMaxSize()) {
        val capsuleMax = if (maxWidth >= 600.dp) 360.dp else maxWidth * ConclaveChromeMetrics.CAPSULE_MAX_WIDTH_FRACTION
        Column(
            Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .padding(12.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // The row keeps its height while hidden, so the chips below never move.
            Box(Modifier.heightIn(min = ConclaveChromeMetrics.HEIGHT_DP.dp)) {
                androidx.compose.animation.AnimatedVisibility(visible = visible, enter = enter, exit = exit) {
                    StageTopRow(stage, capsuleMax, onMinimize, onRoute)
                }
            }
            StageStatusChips(stage)
        }
        val stageWidth = maxWidth
        val stageHeight = maxHeight
        AnimatedVisibility(
            visible = visible, enter = enter, exit = exit,
            // S30 1 d: the system bars and the cutout at the bottom and sides (edge to edge at targetSdk 36), then
            // 12 dp. Never the IME (S20 1 d), which safeDrawing would include.
            modifier = Modifier.align(Alignment.BottomCenter)
                .windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout)
                    .only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))
                .padding(bottom = 12.dp),
        ) {
            StageBarSlot(shell, stage, stageWidth, stageHeight)
        }
    }
}

/** Reveal triggers from the S1 snapshots (S20 8 f): your mute state changing for any reason and a panel closing. */
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

/** Minimize top leading (7 of 8 Android apps, AAPPS 1.1 item 9), the capsule, then route and flip. */
@Composable
private fun StageTopRow(stage: StagePresenter, capsuleMax: Dp, onMinimize: () -> Unit, onRoute: () -> Unit) {
    val snapshot = stage.chrome
    val haptics = rememberConclaveHaptics()
    Row(verticalAlignment = Alignment.CenterVertically) {
        ConclaveMinimizeButton(onClick = onMinimize, identifier = "stage.minimize")
        Spacer(Modifier.width(8.dp))
        StageCapsule(stage, capsuleMax, Modifier.weight(1f, fill = false))
        Spacer(Modifier.weight(1f))
        ConclaveRouteButton(routeKind = snapshot.routeKind, routeName = snapshot.routeName, onClick = onRoute, identifier = "stage.route")
        if (snapshot.canFlipCamera) {
            Spacer(Modifier.width(8.dp))
            ConclaveFlipCameraButton(isFront = snapshot.isFrontCamera, onClick = {
                // RECONCILE R13: every user camera flip plays selectionChanged once after a dispatched flip (STG-3).
                if (StageCameraFlip.perform(stage)) haptics.gesture(FeedbackKind.selectionChanged)
            }, identifier = "stage.flip")
        }
    }
}

/** Observes only stage.capsule (S20 7 k). */
@Composable
private fun StageCapsule(stage: StagePresenter, maxWidth: Dp, modifier: Modifier) {
    val model = stage.capsule
    val title = if (model.subtitleKind == AttendeeViewerPolicy.capsuleLiveKind) attendeeTitle(model.title) else model.title
    ConclaveMeetingCapsule(title = title, subtitle = stageCapsuleSubtitle(model), identifier = "stage.capsule",
        onClick = { stage.openMeetingInfo() }, modifier = modifier, locked = model.isLocked, captionsOn = model.captionsOn,
        maxWidth = maxWidth)
}

@Composable
internal fun stageCapsuleSubtitle(model: StageCapsuleModel): String = when (model.subtitleKind) {
    StageCapsuleModel.youPresentingKind -> conclaveString("stg_you_presenting")
    StageCapsuleModel.presentingKind -> conclaveString("ds_is_presenting", model.subtitleName)
    // S20 12 d (STG-8): attendees see the webinar title and "Live", never a count.
    AttendeeViewerPolicy.capsuleLiveKind -> attendeeCapsuleSubtitle()
    StageCapsuleModel.aloneKind -> conclaveString("stg_just_you")
    else -> conclavePlural("stg_participants_count", model.count, model.count)
}

/** Status chips: flat label-scrim capsules with a 1 dp border, visible while chrome hides (S20 SR3). */
@Composable
private fun StageStatusChips(stage: StagePresenter) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        StageHandChip(stage)
        StageNowPlayingChip(stage)
        StageShareInviteChip(stage)
    }
}

/** Your raised hand (SC12): "Raising hand…" while pending, then "Hand raised" with Lower. */
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

/** A hidden activity keeps running behind Show video (S20 7, 11). */
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

/** Solo with your camera on: Share invite as a chip under the capsule so your face stays visible (S20 2 c). */
@Composable
private fun StageShareInviteChip(stage: StagePresenter) {
    val layout = stage.layout
    if (layout.kind != StageKind.solo || !layout.isAloneConfirmed || layout.meetingLink.isEmpty() || layout.slots.count == 0) return
    val entry = stage.tileChrome.entry(layout.slots[0].userId)
    if (entry.model.isCameraOff) return
    val context = LocalContext.current
    val link = layout.meetingLink
    val roomLabel = stage.capsule.title
    ConclaveStageChip(title = conclaveString("ds_share_invite"), identifier = "stage.chip.shareInvite", icon = ConclaveIcons.ShareFill0,
        onClick = { stageShareMeetingLink(context, link, roomLabel) })
}

/**
 * The toolbar slot (S30 1, CTL-1). The controls presenter arrives through LocalCallControls from whoever mounts the call
 * root (the native call route and the controls fixture), so CallRoot's signature stays the stage owner's; without one
 * the slot draws nothing. The window classes come from the whole stage, not the slot. The toolbar is an overlay
 * sibling of the canvas: showing, hiding or recomposing it never relayouts tiles (S30 1 k).
 */
@Composable
private fun StageBarSlot(shell: MeetingShellPresenter, stage: StagePresenter, stageWidth: Dp, stageHeight: Dp) {
    val controls = LocalCallControls.current
    if (controls == null) {
        Box(Modifier) {}
        return
    }
    CallControlBar(controls, windowWidth = stageWidth, windowHeight = stageHeight)
}
