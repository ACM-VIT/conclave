package conclave.module

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/*
 * The toast host (F00 C13; RECONCILE R1). One stock M3 SnackbarHost with a custom slot: in the in-call stage lane
 * every snackbar is the dark variant (in-call surfaceContainerHigh #232327, onSurface #FAFAFA 15.001, action in-call
 * primary #FF7D66 6.246, a 1 dp extended border), never the light inverse snackbar, because owner decision 3 keeps
 * in-call overlays dark. Snackbars inside a system-appearance InCallPage use stageLane = false: stock M3 colors in
 * the page scheme. Actions read "View", "Retry" in stock casing (never forced capitals). The stock host keeps lengthening
 * durations for accessibility and announces through its live region. The queue, coalescing and suspension belong
 * to the S20 lane owner (STG-5): this host shows the one item it is given and reports the result once.
 */

@Composable
internal fun ConclaveToastHost(
    item: ConclaveToastItem?, identifier: String, onAction: (ConclaveToastItem) -> Unit, onDismiss: (String) -> Unit,
    modifier: Modifier = Modifier, stageLane: Boolean = true, hostState: SnackbarHostState = remember { SnackbarHostState() },
) {
    val currentAction by rememberUpdatedState(onAction)
    val currentDismiss by rememberUpdatedState(onDismiss)
    val currentItem by rememberUpdatedState(item)
    // One-shot per toast id: showSnackbar suspends until the toast times out, is acted on or is replaced. No loop, and
    // nothing runs when no toast shows (F00 C13 k).
    LaunchedEffect(item?.id) {
        val shown = item
        if (shown == null) {
            hostState.currentSnackbarData?.dismiss()
            return@LaunchedEffect
        }
        val result = hostState.showSnackbar(
            message = shown.message,
            actionLabel = if (shown.hasAction) shown.actionTitle else null,
            withDismissAction = false,
            duration = conclaveToastDuration(shown),
        )
        if (result == SnackbarResult.ActionPerformed) currentAction(shown)
        if (currentItem?.id == shown.id) currentDismiss(shown.id)
    }
    SnackbarHost(hostState, modifier.testTag(identifier)) { data ->
        val toast = currentItem
        if (stageLane) {
            ConclaveStageSnackbar(data.visuals.message, toast, identifier, onAction = { data.performAction() })
        } else {
            Snackbar(data, shape = MaterialTheme.shapes.small)
        }
    }
}

/** Progress stays until its owner removes it. Other durations keep stock accessibility adjustment. */
internal fun conclaveToastDuration(item: ConclaveToastItem): SnackbarDuration = when {
    item.isProgress -> SnackbarDuration.Indefinite
    item.hasAction -> SnackbarDuration.Long
    else -> SnackbarDuration.Short
}

/** The dark stage-lane snackbar, with the 24 dp avatar row for chat previews and raised hands (S40 R40-8). */
@Composable
private fun ConclaveStageSnackbar(message: String, toast: ConclaveToastItem?, identifier: String, onAction: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val shape = MaterialTheme.shapes.small
    Snackbar(
        modifier = Modifier.border(1.dp, ext.border, shape).testTag("$identifier.toast"),
        action = if (toast != null && toast.hasAction) {
            {
                TextButton(onClick = onAction, modifier = Modifier.testTag("$identifier.action")) {
                    ConclaveText(toast.actionTitle, line = "$identifier.action", color = scheme.primary)
                }
            }
        } else null,
        shape = shape,
        containerColor = scheme.surfaceContainerHigh,
        contentColor = scheme.onSurface,
        actionContentColor = scheme.primary,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (toast != null && toast.hasAvatar) {
                ConclaveAvatar(toast.avatarName, if (toast.avatarId.isEmpty()) null else toast.avatarId, ConclaveAvatarSize.mention)
            }
            ConclaveText(message, line = "$identifier.message", style = MaterialTheme.typography.bodyMedium, color = scheme.onSurface)
        }
    }
}
