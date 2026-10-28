package conclave.module

import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import java.util.Locale

@Composable
internal fun SettingsVoicePage(settings: SettingsPresenter, reservation: PaddingValues, snackbar: SnackbarHostState, onPush: (String) -> Unit) {
    val chat = settings.chat
    val context = LocalContext.current
    val haptics = rememberConclaveHaptics()
    var pickingVoice by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val ttsIntent = remember { Intent("com.android.settings.TTS_SETTINGS") }
    val hasTtsSettings = remember { ttsIntent.resolveActivity(context.packageManager) != null }
    val failedText = conclaveString("set_voice_create_failed")
    LaunchedEffect(Unit) {
        TtsSpeaker.loadStandardVoices(Locale.getDefault().toLanguageTag()) { voices ->
            settings.setStandardVoices(skip.lib.Array(voices))
        }
    }
    LaunchedEffect(chat.personalVoice) {

        if (chat.personalVoice == PersonalVoicePhase.failed) snackbar.showSnackbar(message = failedText)
    }
    val currentVoiceName = chat.standardVoices.toList().firstOrNull { it.id == chat.standardVoiceId }
    val standardSupporting = if (currentVoiceName != null) settingsVoiceLabel(currentVoiceName) else conclaveString("set_voice_automatic")
    LazyColumn(Modifier.fillMaxSize().testTag("settings.page.voice"), contentPadding = reservation) {
        item(key = "h:messages", contentType = "header") {
            ConclaveSectionHeader(title = conclaveString("set_your_messages"), identifier = "settings.voice.messages")
        }
        item(key = "kinds", contentType = "radio") {
            Column(Modifier.selectableGroup().testTag("settings.voice.kind")) {
                SettingsVoiceKindRow(VoiceKind.system, chat.effectiveVoiceKind == VoiceKind.system, enabled = true) {
                    haptics.gesture(FeedbackKind.selectionChanged)
                    settings.setVoiceKind(VoiceKind.system)
                }
                SettingsVoiceKindRow(VoiceKind.personal, chat.effectiveVoiceKind == VoiceKind.personal,
                    enabled = chat.personalVoice == PersonalVoicePhase.ready) {
                    haptics.gesture(FeedbackKind.selectionChanged)
                    settings.setVoiceKind(VoiceKind.personal)
                }
            }
        }
        item(key = "f:messages", contentType = "footer") {
            ConclaveSectionFooter(text = conclaveString("set_your_messages_detail"), identifier = "settings.voice.messages.footer")
        }
        item(key = "h:personal", contentType = "header") {
            ConclaveSectionHeader(title = conclaveString("set_your_voice"), identifier = "settings.voice.personal")
        }
        if (chat.canUsePersonalVoice) {
            item(key = "personal", contentType = "personal") {
                SettingsPersonalVoiceItems(settings, chat, onPush, onDelete = { confirmDelete = true })
            }
        } else {
            val reason = SettingsCopy.reasonName(chat.personalVoiceReason)
            if (reason != null) {
                item(key = "f:personal", contentType = "footer") {
                    ConclaveSectionFooter(text = conclaveString(reason), identifier = "settings.voice.unavailable")
                }
            }
        }
        item(key = "h:hear", contentType = "header") {
            ConclaveSectionHeader(title = conclaveString("set_voices_you_hear"), identifier = "settings.voice.hear")
        }
        item(key = "standard", contentType = "nav") {
            SettingsNavItem(conclaveString("set_standard_voice"), standardSupporting, "settings.voice.standard") { pickingVoice = true }
        }
        if (chat.canPreviewStandardVoice) {
            item(key = "preview", contentType = "action") {
                SettingsVoicePreviewItem(settings, chat)
            }
        }
        if (hasTtsSettings) {
            item(key = "tts", contentType = "nav") {
                SettingsNavItem(conclaveString("set_tts_settings"), null, "settings.voice.ttsSettings") {
                    NativeExternalHandoff.openSettings(Intent("com.android.settings.TTS_SETTINGS"))
                }
            }
        }
        item(key = "f:hear", contentType = "footer") {
            ConclaveSectionFooter(text = conclaveString("set_standard_voice_detail"), identifier = "settings.voice.hear.footer")
        }
    }
    if (pickingVoice) {
        SettingsStandardVoiceDialog(chat, onSelect = { id ->
            haptics.gesture(FeedbackKind.selectionChanged)
            settings.setStandardVoice(id)
            pickingVoice = false
        }, onDismiss = { pickingVoice = false })
    }
    if (confirmDelete) {
        ConclaveDialog(
            model = ConclaveDialogModel(kind = ConclaveDialogKind.confirmation, title = conclaveString("set_delete_voice_title"),
                message = conclaveString("set_delete_voice_message"), confirmTitle = conclaveString("set_delete"),
                confirmRole = ConclaveDialogRole.destructive),
            identifier = "settings.voice.delete.dialog",
            onConfirm = {
                confirmDelete = false
                settings.deletePersonalVoice()
            },
            onDismiss = { confirmDelete = false },
        )
    }
}

@Composable
internal fun settingsVoiceLabel(voice: VoiceOptionModel): String {
    val language = Locale.forLanguageTag(voice.languageTag).displayName
    return conclaveString("set_voice_option", voice.name, language)
}

@Composable
private fun SettingsVoiceKindRow(kind: VoiceKind, selected: Boolean, enabled: Boolean, onSelect: () -> Unit) {
    ListItem(
        headlineContent = { ConclaveText(conclaveString(SettingsCopy.voiceKindName(kind)), line = "settings.voice.kind.${kind.rawValue}") },
        leadingContent = { RadioButton(selected = selected, onClick = null, enabled = enabled) },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag("settings.voice.kind.${kind.rawValue}")
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onSelect),
    )
}

@Composable
private fun SettingsPersonalVoiceItems(settings: SettingsPresenter, chat: SettingsChat, onPush: (String) -> Unit, onDelete: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Column {
        when (chat.personalVoice) {
            PersonalVoicePhase.ready -> {
                ConclaveValueRow(title = conclaveString("set_your_voice"), value = conclaveString("set_voice_ready"), identifier = "settings.voice.ready")
                SettingsNavItem(conclaveString("set_hear_voice"), null, "settings.voice.hearMine") { settings.hearPersonalVoice() }
                ListItem(
                    headlineContent = { ConclaveText(conclaveString("set_delete_voice"), line = "settings.voice.delete.title", color = scheme.error) },
                    colors = ListItemDefaults.colors(containerColor = scheme.surface),
                    modifier = Modifier.heightIn(min = 56.dp).testTag("settings.voice.delete").clickable(role = Role.Button, onClick = onDelete),
                )
            }
            PersonalVoicePhase.creating, PersonalVoicePhase.deleting -> {
                val name = SettingsCopy.personalVoicePhaseName(chat.personalVoice)
                ListItem(
                    headlineContent = { ConclaveText(if (name != null) conclaveString(name) else "", line = "settings.voice.pending") },
                    trailingContent = { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) },
                    colors = ListItemDefaults.colors(containerColor = scheme.surface),
                )
            }
            PersonalVoicePhase.unavailable -> Unit
            PersonalVoicePhase.none, PersonalVoicePhase.recording, PersonalVoicePhase.review, PersonalVoicePhase.failed ->
                SettingsNavItem(conclaveString("set_create_voice"), conclaveString("set_create_voice_detail"), "settings.voice.create") {
                    onPush(SettingsRoute.voiceRecord.rawValue)
                }
        }
    }
}

@Composable
private fun SettingsVoicePreviewItem(settings: SettingsPresenter, chat: SettingsChat) {
    val sentence = conclaveString("set_preview_sentence")
    val playing = chat.standardPreview == SpeakerTestPhase.playing
    SettingsNavItem(conclaveString(if (playing) "set_stop_preview_voice" else "set_preview_voice"), null, "settings.voice.preview") {
        settings.toggleStandardVoicePreview(sentence = sentence)
    }
}

@Composable
private fun SettingsStandardVoiceDialog(chat: SettingsChat, onSelect: (String) -> Unit, onDismiss: () -> Unit) {
    val voices = chat.standardVoices.toList()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(conclaveString("set_standard_voice")) },
        text = {
            Column(Modifier.selectableGroup().verticalScroll(rememberScrollState()).testTag("settings.voice.standard.dialog")) {
                SettingsStandardVoiceRow("", conclaveString("set_voice_automatic"), chat.standardVoiceId.isEmpty(), onSelect)
                for (voice in voices) {
                    SettingsStandardVoiceRow(voice.id, settingsVoiceLabel(voice), chat.standardVoiceId == voice.id, onSelect)
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.testTag("settings.voice.standard.cancel")) { Text(conclaveString("ds_cancel")) }
        },
    )
}

@Composable
private fun SettingsStandardVoiceRow(id: String, title: String, selected: Boolean, onSelect: (String) -> Unit) {
    ListItem(
        headlineContent = { ConclaveText(title, line = "settings.voice.standard.${id.ifEmpty { "automatic" }}") },
        leadingContent = { RadioButton(selected = selected, onClick = null) },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
        modifier = Modifier.heightIn(min = 56.dp).selectable(selected = selected, role = Role.RadioButton, onClick = { onSelect(id) }),
    )
}
