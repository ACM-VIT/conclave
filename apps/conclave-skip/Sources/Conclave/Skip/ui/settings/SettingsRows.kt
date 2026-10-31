package conclave.module

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

internal enum class SettingsItemKind { Header, Row, Footer, Card }

internal data class SettingsListItem(val key: String, val kind: SettingsItemKind, val section: SettingsSection, val row: SettingsRowID? = null)

internal fun settingsListItems(sections: List<SettingsRowSection>): List<SettingsListItem> {
    val items = mutableListOf<SettingsListItem>()
    for (section in sections) {
        items.add(SettingsListItem("h:${section.id}", SettingsItemKind.Header, section.section))
        var hasFooter = false
        for (row in section.rows) {
            if (row == SettingsRowID.cameraFacing) {
                items.add(SettingsListItem("c:preview", SettingsItemKind.Card, section.section))
            }
            items.add(SettingsListItem("r:${row.rawValue}", SettingsItemKind.Row, section.section, row))
            if (row == SettingsRowID.knockSound || row == SettingsRowID.cameraQuality) hasFooter = true
        }
        if (hasFooter) items.add(SettingsListItem("f:${section.id}", SettingsItemKind.Footer, section.section))
    }
    return items
}

@Composable
internal fun SettingsRootList(
    settings: SettingsPresenter,
    reservation: PaddingValues,
    snackbar: SnackbarHostState,
    onPush: (String) -> Unit,
    onOpenTranscript: (() -> Unit)? = null,
) {
    val sections = settings.sections
    val items = remember(sections) { settingsListItems(sections.toList()) }
    var confirmSignOut by remember { mutableStateOf(false) }
    LazyColumn(Modifier.fillMaxSize().testTag("settings.root"), contentPadding = reservation) {
        item("appearance", contentType = "appearance") { AppearanceSettingRow() }
        items(items, key = { it.key }, contentType = { it.kind }) { item ->
            when (item.kind) {
                SettingsItemKind.Header -> ConclaveSectionHeader(title = conclaveString(SettingsCopy.sectionName(item.section)),
                    identifier = "settings.header.${item.section.rawValue}")
                SettingsItemKind.Footer -> SettingsSectionFooterItem(settings, item.section)
                SettingsItemKind.Card -> LivePreviewCard(settings, Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                SettingsItemKind.Row -> {
                    val row = item.row
                    if (row != null) SettingsRootRow(settings, row, onPush, onOpenTranscript, onSignOut = { confirmSignOut = true })
                }
            }
        }
    }
    SettingsFlipFailureSnackbar(settings, snackbar)
    DiagnosticsExportEffects(DiagnosticsExportPresenter.shared, snackbar)
    if (confirmSignOut) SettingsSignOutDialog(settings, onDismiss = { confirmSignOut = false })
}

@Composable
private fun SettingsRootRow(
    settings: SettingsPresenter,
    row: SettingsRowID,
    onPush: (String) -> Unit,
    onOpenTranscript: (() -> Unit)?,
    onSignOut: () -> Unit,
) {
    val tag = "settings.row.${row.rawValue}"
    when (row) {
        SettingsRowID.output -> SettingsOutputRow(settings.routeOwner, tag) { onPush(SettingsRoute.output.rawValue) }
        SettingsRowID.microphone -> SettingsNavItem(conclaveString(SettingsCopy.rowName(row)),
            conclaveString("set_test_microphone_detail"), tag) { onPush(SettingsRoute.microphone.rawValue) }
        SettingsRowID.noiseSuppression -> {
            val audio = settings.audio
            val reason = SettingsCopy.reasonName(audio.noiseSuppressionReason)
            SettingsSwitchItem(conclaveString(SettingsCopy.rowName(row)), audio.noiseSuppressionOn, tag,
                enabled = audio.noiseSuppression == SettingsCapability.available,
                supporting = conclaveString("set_noise_suppression_detail"),
                secondary = if (reason != null) conclaveString(reason) else null) { settings.setNoiseSuppression(it) }
        }
        SettingsRowID.testSound -> SettingsTestSoundItem(settings, tag)
        SettingsRowID.cameraFacing -> SettingsFacingItem(settings, tag)
        SettingsRowID.captions -> {
            val chat = settings.chat
            Column {
                SettingsSwitchItem(conclaveString(SettingsCopy.rowName(row)), chat.captionsOn, tag,
                    supporting = conclaveString("set_captions_detail")) { settings.setCaptions(it) }
                if (chat.liveNotes == LiveNotesState.off && onOpenTranscript != null) {
                    SettingsNavItem(conclaveString("set_live_notes"), null, "settings.captions.liveNotes", onClick = onOpenTranscript)
                }
            }
        }
        SettingsRowID.captionStyle -> SettingsNavItem(conclaveString("set_caption_style"), conclaveString("set_caption_style_detail"), tag) {
            NativeExternalHandoff.openSettings(Intent(Settings.ACTION_CAPTIONING_SETTINGS))
        }
        SettingsRowID.chatPreviews -> {
            val chat = settings.chat
            SettingsSwitchItem(conclaveString(SettingsCopy.rowName(row)), chat.showsChatPreviews, tag) { settings.setShowsChatPreviews(it) }
        }
        SettingsRowID.playVoiceMessages -> {
            val chat = settings.chat
            SettingsSwitchItem(conclaveString(SettingsCopy.rowName(row)), chat.playsVoiceMessages, tag) { settings.setPlaysVoiceMessages(it) }
        }
        SettingsRowID.voiceMessages -> {
            val chat = settings.chat
            SettingsNavItem(conclaveString(SettingsCopy.rowName(row)), conclaveString(SettingsCopy.voiceKindName(chat.effectiveVoiceKind)), tag) {
                onPush(SettingsRoute.voice.rawValue)
            }
        }
        SettingsRowID.hostControls -> {
            val general = settings.general
            val reason = SettingsCopy.reasonName(general.hostReason)
            SettingsNavItem(conclaveString(SettingsCopy.rowName(row)), if (reason != null) conclaveString(reason) else null, tag,
                enabled = !general.isRecovering) { onPush(SettingsRoute.hostControls.rawValue) }
        }
        SettingsRowID.knockSound -> {
            val general = settings.general
            SettingsSwitchItem(conclaveString(SettingsCopy.rowName(row)), general.knockSoundOn, tag) { settings.setKnockSound(it) }
        }
        SettingsRowID.handSound -> {
            val general = settings.general
            SettingsSwitchItem(conclaveString(SettingsCopy.rowName(row)), general.handSoundOn, tag) { settings.setHandSound(it) }
        }
        SettingsRowID.connection -> {
            val general = settings.general
            SettingsNavItem(conclaveString(SettingsCopy.rowName(row)), conclaveString(SettingsCopy.connectionName(general.connection)), tag) {
                onPush(SettingsRoute.connection.rawValue)
            }
        }
        SettingsRowID.mirror -> {
            val video = settings.video
            SettingsSwitchItem(conclaveString(SettingsCopy.rowName(row)), video.mirrorsSelfView, tag, enabled = !video.isAudioOnly,
                supporting = conclaveString("set_mirror_detail")) { settings.setMirrorsSelfView(it) }
        }
        SettingsRowID.cameraQuality -> {
            val video = settings.video
            SettingsNavItem(conclaveString(SettingsCopy.rowName(row)), conclaveString(SettingsCopy.cameraPresetName(video.effectiveCameraPreset)), tag) {
                onPush(SettingsRoute.cameraQuality.rawValue)
            }
        }
        SettingsRowID.screenShareQuality -> {
            val video = settings.video
            SettingsNavItem(conclaveString(SettingsCopy.rowName(row)), conclaveString(SettingsCopy.screenSharePresetName(video.screenSharePreset)), tag) {
                onPush(SettingsRoute.screenShareQuality.rawValue)
            }
        }
        SettingsRowID.dataSaver -> {
            val video = settings.video
            SettingsSwitchItem(conclaveString(SettingsCopy.rowName(row)), video.dataSaverOn, tag, enabled = !video.systemDataSaverOn,
                supporting = conclaveString("set_data_saver_detail"),
                secondary = if (video.systemDataSaverOn) conclaveString("set_system_data_saver") else null) { settings.setDataSaver(it) }
        }
        SettingsRowID.messageNotifications -> MessageNotificationsItem(tag)
        SettingsRowID.callNotification -> CallNotificationStatusItem(tag)
        SettingsRowID.openLinks -> SettingsOpenLinksItem(settings, tag)
        SettingsRowID.alwaysShowControls -> {
            val general = settings.general
            SettingsSwitchItem(conclaveString(SettingsCopy.rowName(row)), general.alwaysShowControls, tag) { settings.setAlwaysShowControls(it) }
        }
        SettingsRowID.name_ -> SettingsNameItem(settings, tag)
        SettingsRowID.identity -> SettingsIdentityItem(settings, tag)
        SettingsRowID.signOut -> {
            val account = settings.account
            ListItem(
                headlineContent = { ConclaveText(conclaveString("set_sign_out"), line = "$tag.title", color = MaterialTheme.colorScheme.error) },
                supportingContent = if (account.signOutPending) { { ConclaveText(conclaveString("ds_in_progress"), line = "$tag.value") } } else null,
                colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                modifier = Modifier.heightIn(min = 56.dp).testTag(tag).clickable(enabled = !account.signOutPending, role = Role.Button,
                    onClick = onSignOut),
            )
        }
        SettingsRowID.privacy -> SettingsNavItem(conclaveString(SettingsCopy.rowName(row)), null, tag) { onPush(SettingsRoute.privacy.rawValue) }
        SettingsRowID.version -> {
            val context = LocalContext.current
            val version = remember { meetingDetailsVersionName(context) }
            ConclaveValueRow(title = conclaveString("set_version"), value = version, identifier = tag)
        }
        SettingsRowID.exportDiagnostics -> DiagnosticsExportItem(DiagnosticsExportPresenter.shared, tag)
        SettingsRowID.haptics, SettingsRowID.effects -> Unit
    }
}

@Composable
private fun SettingsSectionFooterItem(settings: SettingsPresenter, section: SettingsSection) {
    val identifier = "settings.footer.${section.rawValue}"
    if (section != SettingsSection.video) {
        ConclaveSectionFooter(text = conclaveString("set_host_sounds_detail"), identifier = identifier)
        return
    }
    val video = settings.video
    if (video.qualityCappedByHost) {
        ConclaveSectionFooter(text = conclaveString("set_host_quality_cap"), identifier = "$identifier.hostQualityCap")
    }
}

@Composable
internal fun SettingsNavItem(title: String, supporting: String?, identifier: String, enabled: Boolean = true, onClick: () -> Unit) {
    ListItem(
        headlineContent = { ConclaveText(title, line = "$identifier.title") },
        supportingContent = if (supporting != null) { { ConclaveText(supporting, line = "$identifier.value") } } else null,
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag(identifier).clickable(enabled = enabled, role = Role.Button, onClick = onClick),
    )
}

@Composable
internal fun SettingsSwitchItem(
    title: String, checked: Boolean, identifier: String, enabled: Boolean = true, supporting: String? = null,
    secondary: String? = null, onCheckedChange: (Boolean) -> Unit,
) {
    ListItem(
        headlineContent = { ConclaveText(title, line = "$identifier.title") },
        supportingContent = if (supporting != null || secondary != null) {
            {
                Column {
                    if (supporting != null) ConclaveText(supporting, line = "$identifier.supporting")
                    if (secondary != null) ConclaveText(secondary, line = "$identifier.reason")
                }
            }
        } else null,
        trailingContent = { Switch(checked = checked, onCheckedChange = null, enabled = enabled) },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag(identifier)
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange),
    )
}

@Composable
private fun SettingsOutputRow(owner: AudioRouteOwner, identifier: String, onClick: () -> Unit) {
    val route = owner.route
    val name = if (route.routeName.isNotEmpty()) route.routeName else conclaveString(LobbyRouteRows.resourceName(route.routeKind.rawValue))
    SettingsNavItem(conclaveString("set_audio_output"), name, identifier, onClick = onClick)
}

@Composable
private fun SettingsTestSoundItem(settings: SettingsPresenter, identifier: String) {
    val playing = settings.audio.speakerTest == SpeakerTestPhase.playing
    val playingText = conclaveString("set_playing")
    ListItem(
        headlineContent = { ConclaveText(conclaveString("set_play_test_sound"), line = "$identifier.title") },
        supportingContent = if (playing) { { ConclaveText(playingText, line = "$identifier.value") } } else null,
        trailingContent = if (playing) { { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) } } else null,
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag(identifier)
            .semantics { if (playing) stateDescription = playingText }
            .clickable(enabled = !playing, role = Role.Button) { settings.playTestSound() },
    )
}

@Composable
private fun SettingsFacingItem(settings: SettingsPresenter, identifier: String) {
    val video = settings.video
    val haptics = rememberConclaveHaptics()
    val silent = remember { ConclaveGestureHaptics(view = null, debuggable = false) }
    val enabled = video.canFlipCamera && !video.isFlipInFlight
    val reason = SettingsCopy.reasonName(video.flipReason)
    val options = listOf(
        ConclaveSegmentModel(id = "front", title = conclaveString("set_front"), isEnabled = enabled),
        ConclaveSegmentModel(id = "back", title = conclaveString("set_back"), isEnabled = enabled),
    )
    ListItem(
        headlineContent = { ConclaveText(conclaveString("set_camera"), line = "$identifier.title") },
        supportingContent = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                ConclaveSegmentedRow(options = options, selectedId = video.cameraFacing, identifier = "$identifier.picker",
                    onSelect = { id ->
                        if (settings.setCameraFacing(front = id == "front") == ControlTapResult.dispatched) {
                            haptics.gesture(FeedbackKind.selectionChanged)
                        }
                    },
                    haptics = silent)
                if (reason != null) ConclaveText(conclaveString(reason), line = "$identifier.reason")
            }
        },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.testTag(identifier),
    )
}

@Composable
private fun SettingsOpenLinksItem(settings: SettingsPresenter, identifier: String) {
    val general = settings.general
    val context = LocalContext.current
    Column {
        SettingsNavItem(conclaveString("sys_links_title"), conclaveString(SettingsCopy.linkVerificationName(general.linkVerification)), identifier) {
            if (Build.VERSION.SDK_INT >= 31) {
                NativeExternalHandoff.openSettings(Intent(Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS, Uri.parse("package:" + context.packageName)))
            }
        }
        if (general.linkVerification != LinkVerification.verified) {
            ConclaveSectionFooter(text = conclaveString("sys_links_footer"), identifier = "$identifier.footer")
        }
    }
}

@Composable
private fun SettingsNameItem(settings: SettingsPresenter, identifier: String) {
    val account = settings.account
    val editor = settings.nameEditor
    if (editor == null) {
        ConclaveValueRow(title = conclaveString("set_name"), value = account.savedDisplayName, identifier = identifier)
        return
    }
    val context = LocalContext.current
    val draft = editor.draft
    val refusal = editor.refusal
    val phase = SettingsNamePolicy.status(isSaving = editor.isSaving, refusal = refusal, draft = draft,
        saved = account.savedDisplayName, hasEdited = settings.hasEditedName)
    val error = if (phase == NameSavePhase.failed) peopleRenameRefusalOf(context, refusal) else null
    val status = SettingsCopy.nameStatusName(phase)
    val reason = SettingsCopy.nameReasonName(account.nameReason)
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ConclaveTextField(label = conclaveString("set_name"), value = draft, onValueChange = { settings.editDisplayName(it) },
            kind = ConclaveTextFieldKind.Name, identifier = identifier, error = error, enabled = account.canEditName,
            onSubmit = { settings.flushDisplayName() })
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (phase == NameSavePhase.saving) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
            if (status != null) {
                ConclaveText(conclaveString(status), line = "$identifier.status", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            } else {
                Row(Modifier.weight(1f)) {}
            }
            ConclaveCharacterCounter(count = draft.length, limit = DisplayNamePolicy.limit, visibleFrom = DisplayNamePolicy.counterThreshold,
                identifier = "$identifier.counter")
        }
        if (reason != null) {
            ConclaveText(conclaveString(reason), line = "$identifier.reason", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun SettingsIdentityItem(settings: SettingsPresenter, identifier: String) {
    val account = settings.account
    val guest = SettingsCopy.accountKindName(account.account)
    val provider = SettingsCopy.providerName(account.accountProvider)
    val headline = if (guest != null) conclaveString(guest) else if (account.accountName.isNotEmpty()) account.accountName else account.accountEmail
    val lines = mutableListOf<String>()
    if (guest == null && account.accountName.isNotEmpty() && account.accountEmail.isNotEmpty()) lines.add(account.accountEmail)
    if (guest == null && provider != null) lines.add(conclaveString(provider))
    ListItem(
        headlineContent = { ConclaveText(headline, line = "$identifier.title") },
        supportingContent = if (lines.isNotEmpty()) { { ConclaveText(lines.joinToString("\n"), line = "$identifier.value") } } else null,
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.testTag(identifier).semantics(mergeDescendants = true) {},
    )
}

@Composable
private fun SettingsFlipFailureSnackbar(settings: SettingsPresenter, snackbar: SnackbarHostState) {
    val failed = settings.video.flipFailed
    val text = conclaveString("set_flip_failed")
    LaunchedEffect(failed) {
        if (failed) snackbar.showSnackbar(message = text)
    }
}

@Composable
private fun SettingsSignOutDialog(settings: SettingsPresenter, onDismiss: () -> Unit) {
    val account = settings.account
    ConclaveDialog(
        model = ConclaveDialogModel(kind = ConclaveDialogKind.confirmation, title = conclaveString("set_sign_out_title"),
            message = conclaveString(SettingsCopy.signOutMessageName(account.isHost)), confirmTitle = conclaveString("set_sign_out"),
            confirmRole = ConclaveDialogRole.destructive),
        identifier = "settings.signOut.dialog",
        onConfirm = {
            onDismiss()
            settings.signOut()
        },
        onDismiss = onDismiss,
    )
}
