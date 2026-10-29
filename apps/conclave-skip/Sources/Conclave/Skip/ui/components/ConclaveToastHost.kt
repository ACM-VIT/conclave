package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

@Composable
internal fun ConclaveToastHost(
    item: ConclaveToastItem?, identifier: String, onAction: (ConclaveToastItem) -> Unit, onDismiss: (String) -> Unit,
    modifier: Modifier = Modifier, stageLane: Boolean = true, hostState: SnackbarHostState = remember { SnackbarHostState() },
) {
    val currentAction by rememberUpdatedState(onAction)
    val currentDismiss by rememberUpdatedState(onDismiss)
    val currentItem by rememberUpdatedState(item)

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

internal fun conclaveToastDuration(item: ConclaveToastItem): SnackbarDuration = when {
    item.isProgress -> SnackbarDuration.Indefinite
    item.hasAction -> SnackbarDuration.Long
    else -> SnackbarDuration.Short
}

@Composable
private fun ConclaveStageSnackbar(message: String, toast: ConclaveToastItem?, identifier: String, onAction: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val stackAction = LocalDensity.current.fontScale >= 1.3f
    Surface(
        modifier = Modifier.widthIn(max = 480.dp).testTag("$identifier.toast"),
        shape = RoundedCornerShape(24.dp),
        color = scheme.surfaceContainerHigh,
        contentColor = scheme.onSurface,
        tonalElevation = 6.dp,
        shadowElevation = 3.dp,
    ) {
        if (stackAction) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                ConclaveStageToastMessage(message, toast, identifier)
                if (toast != null && toast.hasAction) {
                    ConclaveStageToastAction(toast, identifier, onAction)
                }
            }
        } else {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically) {
                ConclaveStageToastMessage(message, toast, identifier, Modifier.weight(1f, fill = false))
                if (toast != null && toast.hasAction) {
                    ConclaveStageToastAction(toast, identifier, onAction)
                }
            }
        }
    }
}

@Composable
private fun ConclaveStageToastMessage(message: String, toast: ConclaveToastItem?, identifier: String, modifier: Modifier = Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        if (toast != null && toast.hasAvatar) {
            ConclaveAvatar(toast.avatarName, if (toast.avatarId.isEmpty()) null else toast.avatarId, ConclaveAvatarSize.mention)
        }
        ConclaveText(message, line = "$identifier.message", style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun ConclaveStageToastAction(toast: ConclaveToastItem, identifier: String, onAction: () -> Unit) {
    TextButton(onClick = onAction, modifier = Modifier.testTag("$identifier.action")) {
        ConclaveText(toast.actionTitle, line = "$identifier.action", color = MaterialTheme.colorScheme.primary)
    }
}
