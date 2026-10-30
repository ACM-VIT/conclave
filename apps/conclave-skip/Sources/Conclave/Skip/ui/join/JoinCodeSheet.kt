package conclave.module

import androidx.compose.foundation.layout.size

import androidx.compose.material3.Icon

import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun JoinCodeSheet(premeeting: PremeetingPresenter) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val focus = remember { FocusRequester() }
    var text by rememberSaveable { mutableStateOf("") }
    var showsInvalid by rememberSaveable { mutableStateOf(false) }
    var isSubmitting by remember { mutableStateOf(false) }
    val clipboardHasText = remember { joinClipboardHasText(context) }
    val suggestion = premeeting.home.rejoin?.title
    val isValid = EntryPolicies.isValidJoinInput(text)
    val compactHeight = LocalConfiguration.current.screenHeightDp < 480

    DisposableEffect(premeeting) {
        onDispose { premeeting.joinSheetDidDismiss() }
    }

    fun submit() {
        if (isSubmitting) return
        val raw = text
        if (!EntryPolicies.isValidJoinInput(raw)) {
            showsInvalid = raw.isNotBlank()
            premeeting.submitJoinInput(raw)
            return
        }
        isSubmitting = true
        scope.launch {
            try {
                sheetState.hide()
                if (!sheetState.isVisible) premeeting.submitJoinInput(raw)
            } finally {
                isSubmitting = false
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = { premeeting.dismissJoinSheet() },
        sheetState = sheetState,
        modifier = Modifier.testTag("join.sheet"),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = if (compactHeight) 0.dp else 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Column(
                modifier = Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
                    .padding(bottom = if (compactHeight) 24.dp else 0.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    text = conclaveString("pm_join_meeting"),
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.semantics { heading() },
                )
                OutlinedTextField(
                    value = text,
                    onValueChange = { value ->
                        text = EntryPolicies.sanitizeRoomInput(value)
                        showsInvalid = false
                    },
                    label = { Text(conclaveString("pm_code_or_link_label")) },
                    supportingText = {
                        Text(if (showsInvalid) conclaveString("pm_code_invalid") else conclaveString("pm_code_help"))
                    },
                    isError = showsInvalid,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Go,
                    ),
                    keyboardActions = KeyboardActions(onGo = { submit() }),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("join.field"),
                )
                if (clipboardHasText || suggestion != null) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (clipboardHasText) {
                            AssistChip(
                                onClick = {
                                    val pasted = joinClipboardText(context)
                                    if (pasted.isNotEmpty()) {
                                        text = EntryPolicies.sanitizeRoomInput(pasted)
                                        showsInvalid = EntryPolicies.showsInvalidJoinInput(text)
                                    }
                                },
                                label = { Text(conclaveString("pm_paste")) },
                                leadingIcon = { Icon(ConclaveIcons.ContentPasteFill0, contentDescription = null, modifier = Modifier.size(18.dp)) },
                                modifier = Modifier.testTag("join.paste"),
                            )
                        }
                        if (suggestion != null) {
                            SuggestionChip(
                                onClick = { premeeting.rejoin() },
                                label = { Text(conclaveString("pm_rejoin_named", suggestion)) },
                                modifier = Modifier.testTag("join.rejoinSuggestion"),
                            )
                        }
                    }
                }
                if (compactHeight) JoinConfirmButton(enabled = isValid && !isSubmitting, onClick = { submit() })
            }
            if (!compactHeight) JoinConfirmButton(enabled = isValid && !isSubmitting, onClick = { submit() })

            LaunchedEffect(Unit) {
                snapshotFlow { sheetState.isVisible }.first { it }
                focus.requestFocus()
            }
        }
    }
}

@Composable
private fun JoinConfirmButton(enabled: Boolean, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("join.confirm"),
        colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
    ) {
        Text(conclaveString("pm_join"))
    }
}

internal fun joinClipboardHasText(context: Context): Boolean {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return false
    return clipboard.primaryClipDescription?.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN) == true
}

internal fun joinClipboardText(context: Context): String {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return ""
    val item = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0) ?: return ""
    return item.coerceToText(context)?.toString()?.trim() ?: ""
}
