package conclave.module

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

/*
 * S60 0.6 L6-13 (SET-4) on Android: the VoiceSampleRecorder on the "Record voice" page. It drives C6-23 through the
 * presenter and never owns a recorder: the core pauses the meeting microphone for the take and restores the mute intent
 * afterwards (HD request B6-T2 R1). Ticking parts read only the VoiceRecorderModel leaf. Reachable only while
 * canUsePersonalVoice (W10-4 is out of this push). Back mid-take asks "Discard recording?"; leaving the page any other
 * way mid-take discards the take, so the meeting microphone always returns to its prior intent.
 */

@Composable
internal fun SettingsVoiceRecordPage(settings: SettingsPresenter, reservation: PaddingValues) {
    val phase = settings.chat.personalVoice
    val midTake = phase == PersonalVoicePhase.recording || phase == PersonalVoicePhase.review
    val pages = LocalPanelPageStack.current
    var confirmDiscard by remember { mutableStateOf(false) }
    val latestPhase by rememberUpdatedState(phase)
    BackHandler(enabled = midTake) { confirmDiscard = true }
    DisposableEffect(Unit) {
        onDispose {
            if (latestPhase == PersonalVoicePhase.recording || latestPhase == PersonalVoicePhase.review) settings.discardVoiceSample()
        }
    }
    LaunchedEffect(phase) {
        // Success pops to Voice messages, which shows "Ready" (2 f).
        if (phase == PersonalVoicePhase.ready) pages?.pop()
    }
    val scheme = MaterialTheme.colorScheme
    LazyColumn(Modifier.fillMaxSize().testTag("settings.page.voiceRecord"), contentPadding = reservation) {
        item(key = "script", contentType = "script") {
            Surface(color = scheme.surfaceContainerLow, shape = MaterialTheme.shapes.medium,
                modifier = Modifier.fillMaxWidth().padding(16.dp)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ConclaveText(conclaveString("set_read_naturally"), line = "settings.recorder.scriptTitle",
                        style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
                    ConclaveText(conclaveString("set_voice_script"), line = "settings.recorder.script", style = MaterialTheme.typography.bodyLarge)
                }
            }
        }
        if (phase == PersonalVoicePhase.recording) {
            item(key = "paused", contentType = "note") {
                ConclaveSectionFooter(text = conclaveString("set_mic_paused_recording"), identifier = "settings.recorder.paused")
            }
        }
        item(key = "progress", contentType = "progress") {
            SettingsVoiceRecorderProgress(settings.recorder, isRecording = phase == PersonalVoicePhase.recording)
        }
        item(key = "controls", contentType = "controls") {
            SettingsVoiceRecorderControls(settings, phase)
        }
    }
    if (confirmDiscard) {
        ConclaveDialog(
            model = ConclaveDialogModel(kind = ConclaveDialogKind.confirmation, title = conclaveString("set_discard_recording_title"),
                message = "", confirmTitle = conclaveString("set_discard"), confirmRole = ConclaveDialogRole.destructive),
            identifier = "settings.recorder.discard.dialog",
            onConfirm = {
                confirmDiscard = false
                settings.discardVoiceSample()
                pages?.pop()
            },
            onDismiss = { confirmDiscard = false },
        )
    }
}

/** The ticking leaf: remaining time (tabular; a polite live region announced every 10 s, 2 i) and the flat level bar. */
@Composable
private fun SettingsVoiceRecorderProgress(model: VoiceRecorderModel, isRecording: Boolean) {
    val left = model.secondsLeft
    // The spoken text moves in 10 s steps, so the polite live region announces every 10 s, not every second.
    val interval = VoiceRecorderPolicy.announcementIntervalSeconds
    val bucket = ((left + interval - 1) / interval) * interval
    val announcement = conclaveString("set_keep_speaking", bucket)
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (isRecording && left > 0) {
            ConclaveText(conclaveString("set_keep_speaking", left), line = "settings.recorder.left",
                style = rememberTabular(MaterialTheme.typography.bodyLarge),
                modifier = Modifier.clearAndSetSemantics {
                    contentDescription = announcement
                    liveRegion = LiveRegionMode.Polite
                })
        }
        SettingsLevelMeter(if (isRecording) model.segments else 0, Modifier.fillMaxWidth())
    }
}

@Composable
private fun SettingsVoiceRecorderControls(settings: SettingsPresenter, phase: PersonalVoicePhase) {
    val recorder = settings.recorder
    val recordingText = conclaveString("set_recording")
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when (phase) {
            PersonalVoicePhase.recording -> ConclaveButton(title = conclaveString("set_stop"), role = ConclaveButtonRole.Primary,
                identifier = "settings.recorder.stop", onClick = { settings.stopVoiceSample() },
                modifier = Modifier.semantics { stateDescription = recordingText })
            PersonalVoicePhase.review, PersonalVoicePhase.failed, PersonalVoicePhase.creating -> {
                val creating = phase == PersonalVoicePhase.creating
                ConclaveButton(title = conclaveString("set_listen_back"), role = ConclaveButtonRole.Tonal, identifier = "settings.recorder.listen",
                    onClick = { settings.playVoiceSample() }, enabled = !creating)
                SettingsVoiceConsentItem(settings, recorder)
                ConclaveButton(title = conclaveString(if (creating) "set_creating" else "set_create_my_voice"), role = ConclaveButtonRole.Primary,
                    identifier = "settings.recorder.create", onClick = { settings.createPersonalVoice() },
                    enabled = recorder.canCreate && !creating, pending = creating)
                ConclaveButton(title = conclaveString("set_redo"), role = ConclaveButtonRole.Text, identifier = "settings.recorder.redo",
                    onClick = { settings.discardVoiceSample() }, enabled = !creating)
            }
            else -> ConclaveButton(title = conclaveString("set_record"), role = ConclaveButtonRole.Primary,
                identifier = "settings.recorder.record", onClick = { settings.startVoiceSample() })
        }
    }
}

/** Consent (the Material consent idiom): a Checkbox row whose label is the full consent sentence. */
@Composable
private fun SettingsVoiceConsentItem(settings: SettingsPresenter, recorder: VoiceRecorderModel) {
    val consent = recorder.consent
    ListItem(
        headlineContent = { ConclaveText(conclaveString("set_voice_consent"), line = "settings.recorder.consent.title") },
        leadingContent = { Checkbox(checked = consent, onCheckedChange = null) },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.testTag("settings.recorder.consent")
            .toggleable(value = consent, role = Role.Checkbox, onValueChange = { settings.setVoiceConsent(it) }),
    )
}
