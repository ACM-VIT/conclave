package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp

@Composable
internal fun LeaveControl(controls: CallControlsPresenter, modifier: Modifier = Modifier) {
    val cache = remember(controls) { LeaveCache(controls) }
    val leave = cache.current()
    val stage = controls.stage
    val haptics = rememberConclaveHaptics()
    var menuOpen by remember { mutableStateOf(false) }
    val leaveLabel = conclaveString("ds_leave_call")
    val endLabel = conclaveString("ctl_end_for_everyone")
    val leavingText = conclaveString("ctl_state_leaving")
    val titles = rememberLeaveMenuTitles()
    val showsMenu = LeaveControlPolicy.showsHostMenu(leave.snapshot, isAccessibilityText = false)
    val offersEnd = LeaveControlPolicy.offersEndAction(leave.snapshot)
    val expanded = menuOpen && showsMenu

    DisposableEffect(expanded) {
        if (expanded) stage.setTransientChrome(id = ChromeAutoHidePolicy.leaveMenu, open = true)
        onDispose {
            if (expanded) stage.setTransientChrome(id = ChromeAutoHidePolicy.leaveMenu, open = false)
        }
    }

    LaunchedEffect(showsMenu) {
        if (!showsMenu) menuOpen = false
    }
    val openMenu: (() -> Unit)? = if (showsMenu) {
        {
            haptics.gesture(FeedbackKind.longPress)
            menuOpen = true
        }
    } else {
        null
    }
    val body: @Composable () -> Unit = {
        Box(modifier) {
            Box(
                Modifier.testTag(LeaveControlPolicy.controlIdentifier)
                    .size(CompactBarFit.androidLeaveWidth.dp, 48.dp)
                    .clip(CircleShape)
                    .background(Color(conclaveLeaveColors.container))
                    .combinedClickable(
                        enabled = !leave.isLeaving,
                        role = Role.Button,
                        onLongClickLabel = if (showsMenu) endLabel else null,
                        onLongClick = openMenu,
                        hapticFeedbackEnabled = false,
                        onClick = { controls.leave() },
                    )
                    .semantics {
                        contentDescription = leaveLabel
                        if (leave.isLeaving) stateDescription = leavingText
                        if (offersEnd) {
                            customActions = listOf(CustomAccessibilityAction(endLabel) {
                                controls.requestEndForEveryone(from = MeetingConfirmationInvoker.call)
                                true
                            })
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                if (leave.isLeaving) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), color = Color(conclaveLeaveColors.content), strokeWidth = 2.dp)
                } else {
                    Icon(ConclaveIcons.CallEndFill1, contentDescription = null, tint = Color(conclaveLeaveColors.content))
                }
            }
            ConclaveDropdownMenu(
                expanded = expanded,
                onDismissRequest = { menuOpen = false },
                sections = LeaveControlPolicy.menuSections(leave.snapshot, titles = titles, endOnTop = true).toList(),
                identifier = LeaveControlPolicy.menuIdentifier,
                onSelect = { item ->
                    menuOpen = false
                    controls.selectLeaveMenuItem(item.id)
                },
                icon = { null },
                offset = DpOffset(0.dp, -ConclaveMenuDefaults.BarGap),
            )
        }
    }
    if (showsMenu) body() else CallControlTooltip(leaveLabel) { body() }
    if (LeaveControlPolicy.presentsDialog(leave.snapshot, includesMoreInvoker = true)) {
        EndForEveryoneDialog(leave = leave, controls = controls, haptics = haptics)
    }
}

@Composable
internal fun rememberLeaveMenuTitles(): LeaveMenuTitles {
    val leave = conclaveString("ds_leave_call")
    val end = conclaveString("ctl_end_for_everyone_ellipsis")
    val reconnecting = conclaveString("ctl_reason_reconnecting")
    val offline = conclaveString("ctl_reason_offline")
    val ending = conclaveString("ctl_ending")
    return remember(leave, end, reconnecting, offline, ending) {
        LeaveMenuTitles(leave = leave, endForEveryone = end, reconnecting = reconnecting, offline = offline, ending = ending)
    }
}
