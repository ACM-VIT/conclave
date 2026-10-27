package conclave.module

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

/*
 * Dialogs (F00 C18): an M3 AlertDialog composed inside the invoker's theme, so it is dark when raised from the
 * stage and follows the system appearance when raised from a system-appearance page (F00 2.1). Exactly one
 * confirm plus the dismiss button: a destructive confirm uses the error color, never coral; a normal confirm keeps
 * the default primary. Cancel, Back and a scrim tap all call onDismiss. The caller keeps the shown flag (rotation
 * keeps the dialog through rememberSaveable) and shows its pending state after a confirm; End for everyone takes
 * the S30 4 g copy. Each dialog window registers with the Debug semantics exporter and exposes its test tags as
 * resource ids (S40 R40-11).
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
        modifier = modifier.testTag(identifier).semantics { testTagsAsResourceId = true },
        title = {
            NativeSemanticsPopupRoot(identifier)
            ConclaveText(model.title, line = "$identifier.title")
        },
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

/**
 * The short text-entry dialog (S50 0.7 PL10): an AlertDialog with one OutlinedTextField in its text slot (Change
 * name, Max attendees, and the multi-line Answer in writing at 4 to 8 lines). Input stops at the model's limit;
 * the supporting line shows the refusal [error] (isError), else the counter from `counterFrom`, else the model's
 * message. While [pending] the dialog stays open, the confirm shows a 16 dp spinner and Back or a scrim tap do
 * nothing; the caller closes it on success and keeps the text on a refusal.
 */
@Composable
internal fun ConclaveTextEntryDialog(
    model: ConclaveTextEntryDialogModel, value: String, onValueChange: (String) -> Unit, identifier: String,
    onConfirm: () -> Unit, onDismiss: () -> Unit, modifier: Modifier = Modifier, error: String? = null, pending: Boolean = false,
) {
    val canConfirm = ConclaveTextEntryPolicy.canConfirm(value, isPending = pending)
    val multiline = model.kind == ConclaveTextEntryKind.multiline
    val options = when (model.kind) {
        ConclaveTextEntryKind.name -> KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done)
        ConclaveTextEntryKind.number -> KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done)
        ConclaveTextEntryKind.multiline -> KeyboardOptions(capitalization = KeyboardCapitalization.Sentences)
        else -> KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done)
    }
    val showsCounter = ConclaveTextEntryPolicy.showsCounter(count = value.length, model = model)
    val supporting: (@Composable () -> Unit)? = when {
        error != null -> { { ConclaveText(error, line = "$identifier.error") } }
        showsCounter -> { { ConclaveCharacterCounter(value.length, model.limit, model.counterFrom, "$identifier.counter") } }
        model.message.isNotEmpty() -> { { ConclaveText(model.message, line = "$identifier.message") } }
        else -> null
    }
    AlertDialog(
        onDismissRequest = { if (!pending) onDismiss() },
        modifier = modifier.testTag(identifier).semantics { testTagsAsResourceId = true },
        title = {
            NativeSemanticsPopupRoot(identifier)
            ConclaveText(model.title, line = "$identifier.title")
        },
        text = {
            Column {
                OutlinedTextField(
                    value = value,
                    onValueChange = { onValueChange(ConclaveTextEntryPolicy.capped(it, limit = model.limit)) },
                    modifier = Modifier.testTag("$identifier.field"),
                    label = { ConclaveText(model.fieldLabel, line = "$identifier.label") },
                    supportingText = supporting,
                    isError = error != null,
                    keyboardOptions = options,
                    keyboardActions = KeyboardActions(onDone = { if (canConfirm) onConfirm() }),
                    singleLine = !multiline,
                    minLines = if (multiline) ConclaveTextEntryPolicy.multilineMinLines else 1,
                    maxLines = if (multiline) ConclaveTextEntryPolicy.multilineMaxLines else 1,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = canConfirm, modifier = Modifier.testTag("$identifier.confirm")) {
                if (pending) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                } else {
                    ConclaveText(model.confirmTitle, line = "$identifier.confirm")
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !pending, modifier = Modifier.testTag("$identifier.cancel")) {
                ConclaveText(conclaveString("ds_cancel"), line = "$identifier.cancel")
            }
        },
    )
}
