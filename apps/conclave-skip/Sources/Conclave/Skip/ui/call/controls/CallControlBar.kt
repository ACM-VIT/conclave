package conclave.module

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

internal val LocalCallControls = staticCompositionLocalOf<CallControlsPresenter?> { null }

internal const val CALL_CONTROL_SPINNER_DELAY_MS = 600L

@Composable
internal fun CallControlBar(controls: CallControlsPresenter, windowWidth: Dp, windowHeight: Dp, modifier: Modifier = Modifier) {

    val regularWidth = windowWidth.value >= StageCanvasMetrics.MEDIUM_WIDTH_DP
    val regularHeight = windowHeight.value >= StageCanvasMetrics.MEDIUM_HEIGHT_DP
    LaunchedEffect(regularWidth, regularHeight) {
        controls.setWindow(
            width = if (regularWidth) ControlsWindowClass.regular else ControlsWindowClass.compact,
            height = if (regularHeight) ControlsWindowClass.regular else ControlsWindowClass.compact,
            isPhone = false,
        )
    }
    val cache = remember(controls) { ControlBarCache(controls) }
    val bar = cache.current()
    BoxWithConstraints(modifier.fillMaxWidth(), contentAlignment = Alignment.BottomCenter) {
        val available = maxWidth.value.toDouble()
        val plan = remember(bar.revision, available) { ControlBarPolicy.androidPlan(bar = bar.snapshot, availableWidth = available) }
        val toggleWidth = plan.targetWidth.dp
        val shown = bar.controls.filter { it.kind != CallControlKind.leave && !plan.moved.contains(it.id) }
        val leave = bar.control(CallControlKind.leave)
        LaunchedEffect(plan, available) {

            controls.setOverflow(ids = plan.moved)
            controls.reportFit(ControlBarPolicy.fitReadout(plan = plan, available = available, composition = bar.composition))
        }
        ConclaveCallControlBar(
            identifier = "control.bar",
            modifier = Modifier.widthIn(max = ControlBarPolicy.androidMaxToolbarWidth.dp),
            leave = { if (leave != null) LeaveControl(controls) },
        ) {
            for (control in shown) {
                key(control.id) { CallControlCell(controls, control, toggleWidth) }
            }
        }
    }
    CallControlsPermissionDialog(controls)
}

@Composable
private fun CallControlCell(controls: CallControlsPresenter, control: CallControlUi, width: Dp) {
    when (control.kind) {
        CallControlKind.microphone, CallControlKind.camera, CallControlKind.screenShare, CallControlKind.hand ->
            CallToggleCell(controls, control, width)
        CallControlKind.more -> MoreControlCell(controls, control, width)
        else -> CallInvokerCell(controls, control, width)
    }
}

@Composable
private fun MoreControlCell(controls: CallControlsPresenter, control: CallControlUi, width: Dp) {
    var sheetOpen by remember { mutableStateOf(false) }
    CallInvokerCell(controls, control, width, engaged = sheetOpen || control.visual == CallControlVisual.engaged, onClick = {
        controls.tap(CallControlKind.more)
        sheetOpen = true
    })
    if (sheetOpen) MoreSheet(controls, onDismissed = { sheetOpen = false })
}

@Composable
private fun CallToggleCell(controls: CallControlsPresenter, control: CallControlUi, width: Dp) {
    val haptics = rememberConclaveHaptics()
    var slowAck by remember { mutableStateOf(false) }
    var routeSheetOpen by remember { mutableStateOf(false) }
    var cameraMenuOpen by remember { mutableStateOf(false) }
    LaunchedEffect(control.isPending) {
        slowAck = false
        if (control.isPending) {
            delay(CALL_CONTROL_SPINNER_DELAY_MS)
            slowAck = true
        }
    }
    val optimistic = control.kind == CallControlKind.microphone || control.kind == CallControlKind.camera
    val showsSpinner = control.isPending && (!optimistic || slowAck)
    val label = callControlLabel(control.kind)
    val stateText = callControlStateText(control)
    val dispatch = {
        val kind = control.gesture
        if (controls.tap(control.kind) == ControlTapResult.dispatched && kind != null) haptics.gesture(kind)
    }
    val shortcut = rememberCallToggleShortcut(controls, control, onRouteSheet = { routeSheetOpen = true },
        onCameraMenu = { cameraMenuOpen = true })
    val opens = shortcut.opens
    val longPress: (() -> Unit)? = if (opens != null) {
        {
            haptics.gesture(FeedbackKind.longPress)
            opens()
        }
    } else {
        null
    }
    val toggle: @Composable () -> Unit = {
        CallToggle(control = control, label = label, stateText = stateText, icon = callControlIcon(control), width = width,
            showsSpinner = showsSpinner, onClick = { dispatch() }, onLongClick = longPress,
            onLongClickLabel = shortcut.longClickLabel, customActions = shortcut.actions)
    }
    Box {

        if (longPress != null) toggle() else CallControlTooltip(label) { toggle() }
        if (control.reason == ControlBlockedReason.permissionDenied) {
            Icon(ConclaveIcons.WarningFill1, contentDescription = null, tint = LocalConclaveExtendedColors.current.warning,
                modifier = Modifier.align(Alignment.TopEnd).size(14.dp))
        }
        val cameraItems = shortcut.cameraItems
        if (control.kind == CallControlKind.camera && cameraItems != null) {
            CameraShortcutMenu(controls, cameraItems, expanded = cameraMenuOpen, onDismiss = { cameraMenuOpen = false })
        }
    }
    if (routeSheetOpen && control.kind == CallControlKind.microphone) {
        AudioRouteSheet(controls, controls.stage, onDismiss = { routeSheetOpen = false })
    }
}

internal class CallToggleShortcut(
    val opens: (() -> Unit)?,
    val longClickLabel: String?,
    val actions: List<CustomAccessibilityAction>,
    val cameraItems: MediaShortcutsUi?,
)

@Composable
private fun rememberCallToggleShortcut(
    controls: CallControlsPresenter, control: CallControlUi, onRouteSheet: () -> Unit, onCameraMenu: () -> Unit,
): CallToggleShortcut {
    when (control.kind) {
        CallControlKind.microphone -> {
            val chooseOutput = conclaveString("ctl_choose_audio_output")
            if (!control.hasShortcut) return CallToggleShortcut(opens = null, longClickLabel = null, actions = emptyList(), cameraItems = null)
            val action = CustomAccessibilityAction(chooseOutput) {
                onRouteSheet()
                true
            }
            return CallToggleShortcut(opens = onRouteSheet, longClickLabel = chooseOutput, actions = listOf(action), cameraItems = null)
        }
        CallControlKind.camera -> {
            val cache = remember(controls) { MediaShortcutsCache(controls) }
            val items = cache.current()
            val flipLabel = mediaShortcutActionLabel(MediaShortcutItemID.flipCamera)
            val effectsLabel = mediaShortcutActionLabel(MediaShortcutItemID.effects)
            val haptics = rememberConclaveHaptics()
            val actions = mutableListOf<CustomAccessibilityAction>()
            for (item in items.accessibilityItems) {
                val kind = item.kind
                val title = if (kind == MediaShortcutItemID.effects) effectsLabel else flipLabel
                actions.add(CustomAccessibilityAction(title) {
                    val result = controls.selectShortcut(kind)
                    val feedback = MediaShortcutPolicy.gestureKind(kind, result = result)
                    if (feedback != null) haptics.gesture(feedback)
                    result == ControlTapResult.dispatched
                })
            }
            val opens = if (control.hasShortcut && items.hasEnabledCameraItem) onCameraMenu else null
            val label = if (opens == null) null else if (items.accessibilityItems.firstOrNull()?.kind == MediaShortcutItemID.effects) effectsLabel else flipLabel
            return CallToggleShortcut(opens = opens, longClickLabel = label, actions = actions, cameraItems = items)
        }
        else -> return CallToggleShortcut(opens = null, longClickLabel = null, actions = emptyList(), cameraItems = null)
    }
}

@Composable
private fun CallInvokerCell(
    controls: CallControlsPresenter, control: CallControlUi, width: Dp,
    engaged: Boolean = control.visual == CallControlVisual.engaged, onClick: () -> Unit = { controls.tap(control.kind) },
) {
    val label = callControlLabel(control.kind)
    val value = callControlInvokerValue(control)
    val colors = conclaveCallToggleColors(callControlVisual(if (engaged) CallControlVisual.engaged else control.visual))
    CallControlTooltip(label) {
        ConclaveBadgedAnchor(count = control.badgeCount, identifier = "control.${control.id}", showsDot = control.showsDot) {
            Box(
                Modifier.testTag("control.${control.id}").size(width, 48.dp)
                    .alpha(if (control.isBlocked) CONCLAVE_CALL_DISABLED_ALPHA else 1f)
                    .clip(CircleShape)
                    .background(Color(colors.container))
                    .clickable(enabled = !control.isLeaving, role = Role.Button) { onClick() }
                    .semantics {
                        contentDescription = label
                        if (engaged) selected = true
                        if (value != null) stateDescription = value
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(callControlIcon(control), contentDescription = null, tint = Color(colors.content))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CallControlTooltip(label: String, content: @Composable () -> Unit) {
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above),
        tooltip = { PlainTooltip { Text(label) } },
        state = rememberTooltipState(),
    ) { content() }
}

@Composable
private fun CallControlsPermissionDialog(controls: CallControlsPresenter) {
    val prompt = controls.permissionPrompt ?: return
    val context = LocalContext.current
    val camera = prompt.kind == ControlPermissionKind.camera
    val model = ConclaveDialogModel(
        kind = ConclaveDialogKind.alert,
        title = conclaveString(if (camera) "ctl_camera_denied_title" else "ctl_mic_denied_title"),
        message = conclaveString(if (camera) "ctl_camera_denied_body" else "ctl_mic_denied_body"),
        confirmTitle = conclaveString("ctl_open_settings"),
        confirmRole = ConclaveDialogRole.normal,
    )
    ConclaveDialog(
        model = model,
        identifier = "control.permission",
        onConfirm = {
            controls.dismissPermissionPrompt(id = prompt.id)
            openAppPermissionSettings(context)
        },
        onDismiss = { controls.dismissPermissionPrompt(id = prompt.id) },
    )
}

internal fun openAppPermissionSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
    }
}

@Composable
internal fun callControlLabel(kind: CallControlKind): String = when (kind) {
    CallControlKind.microphone -> conclaveString("ds_microphone")
    CallControlKind.camera -> conclaveString("ds_camera")
    CallControlKind.screenShare -> conclaveString("ds_share_screen")
    CallControlKind.hand -> conclaveString("ds_raise_hand")
    CallControlKind.chat -> conclaveString("ds_chat")
    CallControlKind.participants -> conclaveString("native_panel_participants")
    CallControlKind.qa -> conclaveString("ctl_qa")
    CallControlKind.more -> conclaveString("ds_more_options")
    else -> conclaveString("ds_leave_call")
}

internal fun callControlIcon(control: CallControlUi): ImageVector = when (control.kind) {
    CallControlKind.microphone -> if (control.isOn) ConclaveIcons.MicFill1 else ConclaveIcons.MicOffFill1
    CallControlKind.camera -> if (control.isOn) ConclaveIcons.VideocamFill1 else ConclaveIcons.VideocamOffFill1
    CallControlKind.screenShare -> if (control.isOn) ConclaveIcons.CancelPresentationFill1 else ConclaveIcons.PresentToAllFill0
    CallControlKind.hand -> if (control.isOn) ConclaveIcons.FrontHandFill1 else ConclaveIcons.FrontHandFill0
    CallControlKind.chat -> if (control.isOn) ConclaveIcons.ChatBubbleFill1 else ConclaveIcons.ChatBubbleFill0
    CallControlKind.participants -> if (control.isOn) ConclaveIcons.GroupFill1 else ConclaveIcons.GroupFill0
    CallControlKind.qa -> ConclaveIcons.QuizFill0
    CallControlKind.more -> ConclaveIcons.MoreVertFill0
    else -> ConclaveIcons.CallEndFill1
}

@Composable
internal fun callControlStateText(control: CallControlUi): String {
    val parts = mutableListOf<String>()
    if (control.kind == CallControlKind.microphone && control.reason == ControlBlockedReason.audioInterrupted) {
        parts.add(conclaveString("ctl_mic_paused"))
    } else if (control.kind == CallControlKind.microphone && control.reason == ControlBlockedReason.onHold) {
        parts.add(conclaveString("ctl_reason_on_hold"))
    } else {
        parts.add(callControlState(control))
        val reason = callControlReasonText(control.kind, control.reason, control.reasonName)
        if (reason != null) parts.add(reason)
    }
    if (control.appliesAfterReconnect) parts.add(conclaveString("ctl_applies_after_reconnect"))
    return parts.joinToString(", ")
}

@Composable
private fun callControlState(control: CallControlUi): String = when (control.kind) {
    CallControlKind.microphone -> conclaveString(if (control.isOn) "ds_state_on" else "ds_state_muted")
    CallControlKind.camera -> conclaveString(if (control.isOn) "ds_state_on" else "ds_state_off")
    CallControlKind.screenShare -> conclaveString(if (control.isOn) "ds_state_sharing" else "ctl_state_not_sharing")
    CallControlKind.hand -> when {
        control.isPending -> conclaveString(if (control.isOn) "ctl_state_lowering" else "ctl_state_raising")
        control.isOn -> conclaveString("ds_state_raised")
        else -> conclaveString("ds_state_not_raised")
    }
    else -> ""
}

@Composable
internal fun callControlReasonText(kind: CallControlKind, reason: ControlBlockedReason, name: String): String? = when (reason) {
    ControlBlockedReason.reconnecting -> conclaveString("ctl_reason_reconnecting")
    ControlBlockedReason.offline -> conclaveString("ctl_reason_offline")
    ControlBlockedReason.remoteShareActive -> conclaveString("ds_is_presenting", name)
    ControlBlockedReason.audioOnly -> conclaveString("ctl_reason_audio_only")
    ControlBlockedReason.disabledByHost ->
        conclaveString(if (kind == CallControlKind.camera) "ctl_reason_host_camera" else "ctl_reason_host_mic")
    ControlBlockedReason.permissionDenied -> conclaveString("ctl_reason_permission")
    else -> null
}

@Composable
internal fun callControlInvokerValue(control: CallControlUi): String? {
    if (control.badgeCount > 0) {
        return when (control.kind) {
            CallControlKind.chat -> conclaveString("ds_unread_count", control.badgeCount)
            CallControlKind.participants, CallControlKind.more -> conclavePlural("ctl_waiting_count", control.badgeCount, control.badgeCount)
            CallControlKind.qa -> conclavePlural("ctl_qa_new", control.badgeCount, control.badgeCount)
            else -> null
        }
    }
    return if (control.showsDot) conclaveString("ctl_new_activity") else null
}

@Composable
internal fun callControlToast(explanation: ControlExplanation): String? = when (explanation.reason) {
    ControlBlockedReason.reconnecting -> conclaveString("ctl_toast_reconnecting")
    ControlBlockedReason.offline -> conclaveString("ctl_toast_offline")
    ControlBlockedReason.remoteShareActive -> conclaveString("ctl_toast_presenting", explanation.reasonName)
    ControlBlockedReason.audioOnly -> conclaveString("ctl_toast_audio_only")
    ControlBlockedReason.disabledByHost ->
        conclaveString(if (explanation.kind == CallControlKind.camera) "ctl_toast_host_camera" else "ctl_toast_host_mic")
    else -> null
}
