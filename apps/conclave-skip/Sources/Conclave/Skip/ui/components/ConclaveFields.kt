package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import java.util.Locale

/*
 * Text fields and the composer field (F00 C19). The text stays in the caller's local state (keystrokes never reach
 * a presenter until submit, F00 C19 k). Single-line fields are OutlinedTextFields with the label, the error as
 * supporting text and isError; the composer is a TextField growing to six lines with the Send glyph (primary,
 * auto-mirrored in RTL). Hardware Enter sends and Shift+Enter adds a newline. No send haptic (Q11).
 */

/** What a single-line field holds; picks the keyboard, capitalization and IME action (F00 C19 d). */
internal enum class ConclaveTextFieldKind { Name, Code, Text }

@Composable
internal fun ConclaveTextField(
    label: String, value: String, onValueChange: (String) -> Unit, kind: ConclaveTextFieldKind, identifier: String,
    modifier: Modifier = Modifier, error: String? = null, enabled: Boolean = true, onSubmit: () -> Unit = {},
) {
    val options = when (kind) {
        ConclaveTextFieldKind.Name -> KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done)
        ConclaveTextFieldKind.Code -> KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
            keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go)
        ConclaveTextFieldKind.Text -> KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done)
    }
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth().testTag(identifier),
        enabled = enabled,
        label = { ConclaveText(label, line = "$identifier.label") },
        supportingText = if (error == null) null else {
            { ConclaveText(error, line = "$identifier.error") }
        },
        isError = error != null,
        keyboardOptions = options,
        keyboardActions = KeyboardActions(onDone = { onSubmit() }, onGo = { onSubmit() }),
        singleLine = true,
    )
}

/** The near-limit counter ("38/40") with tabular digits and the description "38 of 40 characters", visible from
 *  [visibleFrom] characters (S10 DisplayNamePolicy: cap 40, visible from 30). */
@Composable
internal fun ConclaveCharacterCounter(count: Int, limit: Int, visibleFrom: Int, identifier: String, modifier: Modifier = Modifier) {
    if (count < visibleFrom) return
    val scheme = MaterialTheme.colorScheme
    val description = conclaveString("ds_char_count", count, limit)
    ConclaveText(
        conclaveString("ds_char_counter", String.format(Locale.getDefault(), "%d", count), String.format(Locale.getDefault(), "%d", limit)),
        line = identifier,
        style = rememberTabular(MaterialTheme.typography.bodySmall),
        color = if (count > limit) scheme.error else scheme.onSurfaceVariant,
        modifier = modifier.testTag(identifier).semantics { contentDescription = description },
    )
}

/**
 * The composer: a TextField growing to six lines with the Send glyph as its trailing icon (enabled only when
 * [sendEnabled]); IME Send and hardware Enter send, Shift+Enter adds a newline. The container adds imePadding.
 */
@Composable
internal fun ConclaveComposerField(
    placeholder: String, value: String, onValueChange: (String) -> Unit, sendEnabled: Boolean, onSend: () -> Unit,
    identifier: String, modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
        TextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.weight(1f).testTag(identifier).onPreviewKeyEvent { event ->
                if (event.type == KeyEventType.KeyDown && event.key == Key.Enter && !event.isShiftPressed) {
                    if (sendEnabled) onSend()
                    true
                } else {
                    false
                }
            },
            placeholder = { ConclaveText(placeholder, line = "$identifier.placeholder") },
            trailingIcon = {
                IconButton(onClick = onSend, enabled = sendEnabled, modifier = Modifier.testTag("$identifier.send")) {
                    Icon(ConclaveIcons.SendFill1, contentDescription = conclaveString("ds_send"),
                        tint = if (sendEnabled) scheme.primary else scheme.onSurfaceVariant)
                }
            },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { if (sendEnabled) onSend() }),
            maxLines = 6,
        )
    }
}
