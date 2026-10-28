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

/*
 * S30 1 d (CTL-1): the Android control toolbar the stage chrome mounts in its toolbar slot (StageChrome.kt). One
 * toolbar container (WP1-2b ConclaveCallControlBar: #18181B, 1 dp border, 8 dp padding and gaps, the divider, then
 * Leave), compact five below 600 dp wide or 480 dp tall, the wide eight from medium width (Q13, RECONCILE R7; max
 * 560 dp), the attendee three. Toggle widths and the overflow move come from the shared fit (ControlBarPolicy over
 * CompactBarFit): 321 dp at 360 dp, 353 dp at 412 dp, 545 dp wide. The bar reads only controls.bar through the cache;
 * each cell reads only its CallControlUi. Every click computes the gesture kind first and plays it only when the
 * presenter returns dispatched (S30 1 h); Chat, Participants, Q&A, More and Leave play nothing. CTL-5: More opens the
 * in-call More sheet (MoreSheet.kt) and draws Engaged while it shows.
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

/** S30 5 d (CTL-5): More, Engaged while its sheet shows; the tap plays nothing (Q11) and composes the sheet, which a
 *  role change to attendee disposes with this cell (5 f). */
@Composable
private fun MoreControlCell(controls: CallControlsPresenter, control: CallControlUi, width: Dp) {
    var sheetOpen by remember { mutableStateOf(false) }
    CallInvokerCell(controls, control, width, engaged = sheetOpen || control.visual == CallControlVisual.engaged, onClick = {
        controls.tap(CallControlKind.more)
        sheetOpen = true
    })
    if (sheetOpen) MoreSheet(controls, onDismissed = { sheetOpen = false })
}

/** Mic and Camera (optimistic: spinner after 600 ms) and Raise Hand and Share Screen (spinner at once, tooltips).
 *  CTL-4 (S30 2 d): the Mic long press opens the route sheet (AudioRouteSheet.kt, the same sheet as the top-row route
 *  button); the Camera long press opens its dropdown (MediaShortcutMenu.kt) only when an item can act, otherwise the
 *  Camera keeps the plain tooltip. Each plays `longPress` as it opens; TalkBack gets the same shortcuts as custom actions
 *  (AX4) and the long-click label. */
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
        // A Mic or Camera with a shortcut has no tooltip: its long press is the CTL-4 shortcut (S30 1 d, 2 d). A Camera
        // with no enabled item keeps the plain "Camera" tooltip instead of a dead-end menu.
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

/** What a toggle's long press opens (null: no long press), its long-click label and its TalkBack custom actions. */
internal class CallToggleShortcut(
    val opens: (() -> Unit)?,
    val longClickLabel: String?,
    val actions: List<CustomAccessibilityAction>,
    val cameraItems: MediaShortcutsUi?,
)

/** S30 2 d: the Mic's route sheet (always, while the Mic has its shortcut) and the Camera's dropdown (only with an
 *  enabled item); Raise Hand and Share Screen have none. Only the Camera reads `controls.shortcuts` (CL14 cache); the
 *  route snapshot is read only by the sheet (S30 2 k). */
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

/** Chat, Participants, Q&A and More: R01 On, Engaged with `selected` while their panel (More: its sheet) is current
 *  (CC18). */
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

/** The M3 plain tooltip above the control (S30 1 d; material3 1.4.0 rememberTooltipPositionProvider); also the guest
 *  Leave control's (LeaveControl.kt). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CallControlTooltip(label: String, content: @Composable () -> Unit) {
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
