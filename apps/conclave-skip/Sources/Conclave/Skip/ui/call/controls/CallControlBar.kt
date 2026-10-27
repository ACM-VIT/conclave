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
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/*
 * S30 1 d (CTL-1): the Android control toolbar the stage chrome mounts in its toolbar slot (StageChrome.kt). One
 * toolbar container (WP1-2b ConclaveCallControlBar: #18181B, 1 dp border, 8 dp padding and gaps, the divider, then
 * Leave), compact five below 600 dp wide or 480 dp tall, the wide eight from medium width (Q13, RECONCILE R7; max
 * 560 dp), the attendee three. Toggle widths and the overflow move come from the shared fit (ControlBarPolicy over
 * CompactBarFit): 321 dp at 360 dp, 353 dp at 412 dp, 545 dp wide. The bar reads only controls.bar through the cache;
 * each cell reads only its CallControlUi. Every click computes the gesture kind first and plays it only when the
 * presenter returns dispatched (S30 1 h); Chat, Participants, Q&A, More and Leave play nothing.
 */

/** The controls presenter of the native call root, provided by whoever mounts CallRoot; no bar without it. */
internal val LocalCallControls = staticCompositionLocalOf<CallControlsPresenter?> { null }

/** S30 1 d: the spinner replaces an optimistic glyph only once an acknowledgment is slow. */
internal const val CALL_CONTROL_SPINNER_DELAY_MS = 600L

@Composable
internal fun CallControlBar(controls: CallControlsPresenter, windowWidth: Dp, windowHeight: Dp, modifier: Modifier = Modifier) {
    // Wide from 600 dp wide and 480 dp tall (Q13); the vertical composition is iPhone only (D27).
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
            // Never published: More reads the overflow when it opens; the fixture reads the readout on demand.
            controls.setOverflow(ids = plan.moved)
            controls.reportFit(ControlBarPolicy.fitReadout(plan = plan, available = available, composition = bar.composition))
        }
        ConclaveCallControlBar(
            identifier = "control.bar",
            modifier = Modifier.widthIn(max = ControlBarPolicy.androidMaxToolbarWidth.dp),
            leave = { if (leave != null) CallLeaveCell(controls, leave) },
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
        else -> CallInvokerCell(controls, control, width)
    }
}

/** Mic and Camera (optimistic: spinner after 600 ms) and Raise Hand and Share Screen (spinner at once, tooltips). */
@Composable
private fun CallToggleCell(controls: CallControlsPresenter, control: CallControlUi, width: Dp) {
    val haptics = rememberConclaveHaptics()
    var slowAck by remember { mutableStateOf(false) }
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
    val toggle: @Composable () -> Unit = {
        CallToggle(control = control, label = label, stateText = stateText, icon = callControlIcon(control), width = width,
            showsSpinner = showsSpinner, onClick = { dispatch() })
    }
    Box {
        // Mic and Camera have no tooltip: their long press becomes the CTL-4 shortcut (S30 1 d).
        if (optimistic) toggle() else CallControlTooltip(label) { toggle() }
        if (control.reason == ControlBlockedReason.permissionDenied) {
            Icon(ConclaveIcons.WarningFill1, contentDescription = null, tint = LocalConclaveExtendedColors.current.warning,
                modifier = Modifier.align(Alignment.TopEnd).size(14.dp))
        }
    }
}

/** Chat, Participants, Q&A and More: R01 On, Engaged with `selected` while their panel is current (CC18). */
@Composable
private fun CallInvokerCell(controls: CallControlsPresenter, control: CallControlUi, width: Dp) {
    val label = callControlLabel(control.kind)
    val value = callControlInvokerValue(control)
    val engaged = control.visual == CallControlVisual.engaged
    val colors = conclaveCallToggleColors(callControlVisual(control.visual))
    CallControlTooltip(label) {
        ConclaveBadgedAnchor(count = control.badgeCount, identifier = "control.${control.id}", showsDot = control.showsDot) {
            Box(
                Modifier.testTag("control.${control.id}").size(width, 48.dp)
                    .alpha(if (control.isBlocked) CONCLAVE_CALL_DISABLED_ALPHA else 1f)
                    .clip(CircleShape)
                    .background(Color(colors.container))
                    .clickable(enabled = !control.isLeaving, role = Role.Button) { controls.tap(control.kind) }
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

/** Leave (F00 C04 d): the WP1-2b 72 x 48 dp callEnd pill, "Leave call" (OQ3), no haptic (Q11). While leaving it shows a
 *  spinner and takes no clicks. The host long-press End menu arrives with CTL-2 (LeaveControl.kt). */
@Composable
private fun CallLeaveCell(controls: CallControlsPresenter, control: CallControlUi) {
    val leaving = control.isLeaving || control.isPending
    if (!leaving) {
        CallControlTooltip(conclaveString("ds_leave_call")) {
            ConclaveLeaveButton(identifier = "control.leave", onClick = { controls.leave() })
        }
        return
    }
    val description = conclaveString("ds_leave_call")
    Box(
        Modifier.testTag("control.leave").size(CompactBarFit.androidLeaveWidth.dp, 48.dp)
            .clip(CircleShape)
            .background(Color(conclaveLeaveColors.container))
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(20.dp), color = Color(conclaveLeaveColors.content), strokeWidth = 2.dp)
    }
}

/** The M3 plain tooltip above the control (S30 1 d; material3 1.4.0 rememberTooltipPositionProvider). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CallControlTooltip(label: String, content: @Composable () -> Unit) {
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above),
        tooltip = { PlainTooltip { Text(label) } },
        state = rememberTooltipState(),
    ) { content() }
}

/** The S10 7 permission dialog a permission-denied tap opens (S30 1 f): Open settings or Not now. */
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

/** Permanently denied permissions are changed in the app's system settings page. */
internal fun openAppPermissionSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
    }
}

// Copy (S30 1 g and 7, Material sentence case). Names resolve at run time from the app module (ConclaveStrings.kt).

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

/** S30 1 e concepts: the slashed glyphs for muted and off, CancelPresentation while sharing, FILL 1 while engaged. */
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

/** The state description: the state (or the paused and on-hold microphone, R29), the blocked reason, then "Applies
 *  when reconnected" while media intent waits for recovery. */
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

/** S30 7 Android state description column; null where the reason has no bar copy. */
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

/** Chat unread, the host waiting count (Participants or More), new questions (Q&A), or More's dot. */
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

/** The toast for a blocked bar tap (S30 7 last column); STG-5's toast lane shows it for the blockedExplanation notice. */
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
