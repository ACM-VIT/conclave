package conclave.module

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState

@Composable
internal fun GameKitTextEntry(
    label: String,
    placeholder: String,
    maxLength: Int,
    text: String,
    onTextChange: (String) -> Unit,
    submitTitle: String,
    isPending: Boolean,
    enabled: Boolean,
    onSubmit: () -> Unit,
) {
    val canSubmit = enabled && !isPending && text.trim().isNotEmpty()
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = text,
            onValueChange = { value -> onTextChange(if (maxLength > 0 && value.length > maxLength) value.take(maxLength) else value) },
            label = { Text(label) },
            placeholder = { Text(placeholder) },
            enabled = enabled && !isPending,
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { if (canSubmit) onSubmit() }),
            supportingText = if (maxLength > 0 && text.length >= maxOf(0, maxLength - ActivitiesCatalogPolicy.counterLead)) {
                { Text(activitiesCharacterCount(text.length, maxLength), style = rememberTabular(MaterialTheme.typography.bodySmall)) }
            } else null,
            modifier = Modifier.fillMaxWidth().testTag("game.text.field"),
        )
        GameKitHostBar(primaryTitle = submitTitle, onPrimary = onSubmit, primaryEnabled = canSubmit, primaryPending = isPending)
    }
}

@Composable
internal fun GameKitSecretCard(prompt: String, secret: String, enabled: Boolean, onRevealBegan: () -> Unit) {
    var held by remember { mutableStateOf(false) }
    var revealedForTalkBack by remember { mutableStateOf(false) }
    val began by rememberUpdatedState(onRevealBegan)
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val active = lifecycleState.isAtLeast(Lifecycle.State.STARTED)
    LaunchedEffect(active) { if (!active) revealedForTalkBack = false }

    LaunchedEffect(secret) { revealedForTalkBack = false }
    val shows = enabled && active && (held || revealedForTalkBack)
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val revealLabel = conclaveString("gm_reveal_word")
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = scheme.surfaceContainerHighest,
        border = BorderStroke(1.dp, ext.border),
        modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp).testTag("game.secret")
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectTapGestures(onPress = {
                    held = true
                    began()
                    tryAwaitRelease()
                    held = false
                })
            }
            .semantics {
                customActions = listOf(CustomAccessibilityAction(revealLabel) {
                    if (enabled) revealedForTalkBack = true
                    true
                })
            },
    ) {
        Box(Modifier.padding(16.dp), contentAlignment = Alignment.Center) {
            if (shows) {
                Text(secret, style = MaterialTheme.typography.titleLarge, color = scheme.onSurface, textAlign = TextAlign.Center)
            } else {
                Row(Modifier.clearAndSetSemantics { contentDescription = prompt }, verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(ConclaveIcons.LockFill1, contentDescription = null, tint = scheme.onSurfaceVariant)
                    Text(prompt, style = MaterialTheme.typography.titleSmall, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center)
                }
            }
        }
    }
}
