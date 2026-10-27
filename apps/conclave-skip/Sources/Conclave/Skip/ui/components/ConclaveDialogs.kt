package conclave.module

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag

/*
 * Dialogs (F00 C18): an M3 AlertDialog composed inside the invoker's theme, so it is dark when raised from the
 * stage and follows the system appearance when raised from a system-appearance page (F00 2.1). Exactly one
 * confirm plus the dismiss button: a destructive confirm uses the error color, never coral; a normal confirm keeps
 * the default primary. Cancel, Back and a scrim tap all call onDismiss. The caller keeps the shown flag (rotation
 * keeps the dialog through rememberSaveable) and shows its pending state after a confirm; End for everyone takes
 * the S30 4 g copy.
 */

@Composable
internal fun ConclaveDialog(
    model: ConclaveDialogModel, identifier: String, onConfirm: () -> Unit, onDismiss: () -> Unit, modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    val destructive = model.confirmRole == ConclaveDialogRole.destructive
    val dismissTitle = if (model.kind == ConclaveDialogKind.alert) conclaveString("ds_not_now") else conclaveString("ds_cancel")
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = modifier.testTag(identifier),
        title = { ConclaveText(model.title, line = "$identifier.title") },
        text = if (model.message.isEmpty()) null else {
            { ConclaveText(model.message, line = "$identifier.message", color = scheme.onSurfaceVariant) }
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                modifier = Modifier.testTag("$identifier.confirm"),
                colors = if (destructive) ButtonDefaults.textButtonColors(contentColor = scheme.error) else ButtonDefaults.textButtonColors(),
            ) { ConclaveText(model.confirmTitle, line = "$identifier.confirm") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.testTag("$identifier.cancel")) {
                ConclaveText(dismissTitle, line = "$identifier.cancel")
            }
        },
    )
}
