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

@Composable
internal fun ConclaveTextEntryDialog(
    model: ConclaveTextEntryDialogModel, value: String, onValueChange: (String) -> Unit, identifier: String,
    onConfirm: () -> Unit, onDismiss: () -> Unit, modifier: Modifier = Modifier, error: String? = null, pending: Boolean = false,
) {
    val canConfirm = ConclaveTextEntryPolicy.canConfirm(value, isPending = pending)
    val multiline = model.kind == ConclaveTextEntryKind.multiline
    val options = when (model.kind) {
        ConclaveTextEntryKind.name_ -> KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done)
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
