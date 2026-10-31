package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

internal object VoiceIcons {
    val play: ImageVector get() = ConclaveIcons.PlayArrowFill1
    val stop: ImageVector get() = ConclaveIcons.StopFill1
    val speaking: ImageVector get() = ConclaveIcons.GraphicEqFill0
    val voiceMessage: ImageVector get() = ConclaveIcons.RecordVoiceOverFill0
}

internal object VoiceCopyAndroid {
    @Composable
    fun header(isPlaying: Boolean): String =
        if (isPlaying) conclaveString("chat_voice_speaking") else conclaveString("chat_voice")

    @Composable
    fun playTitle(isPlaying: Boolean): String =
        if (isPlaying) conclaveString("chat_voice_stop") else conclaveString("chat_voice_play")

    @Composable
    fun modeLine(voiceKind: String): String {
        val kind = if (voiceKind == VoiceKind.personal.rawValue) conclaveString("chat_voice_personal") else conclaveString("chat_voice_system")
        return conclaveString("chat_voice_line", conclaveString("chat_voice_hint"), kind)
    }

    @Composable
    fun placeholder(composer: ChatComposerSnapshot): String? =
        if (composer.isVoiceMode) conclaveString("chat_placeholder_voice") else null

    @Composable
    fun sendLabel(composer: ChatComposerSnapshot): String? =
        if (composer.isVoiceMode) conclaveString("chat_send_voice") else null

    @Composable
    fun accessibilityValue(): String = conclaveString("chat_ax_voice")

    @Composable
    fun unavailableReason(composer: ChatComposerSnapshot): String = when {
        composer.privateTo != null -> conclaveString("chat_reason_private_text")
        !composer.voiceEnabled -> conclaveString("chat_reason_voice_off")
        else -> ""
    }
}

@Composable
internal fun ChatVoiceControl(row: ChatRowModel, presenter: ChatPresenter) {
    val isPlaying = presenter.playback.activeVoiceRowId == row.id
    val tint = LocalContentColor.current
    val label = VoiceCopyAndroid.playTitle(isPlaying)
    val status = VoiceCopyAndroid.header(isPlaying)
    val hint = conclaveString("chat_voice_play_hint")
    val controlTint = if (row.canPlayVoice) tint else tint.copy(alpha = 0.45f)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        IconButton(
            onClick = { if (isPlaying) presenter.stopVoice() else presenter.playVoice(row.id) },
            enabled = row.canPlayVoice,
            modifier = Modifier.size(48.dp).testTag("chat.row.${row.id}.voice").semantics {
                stateDescription = if (isPlaying) status else hint
            },
        ) {
            Icon(if (isPlaying) VoiceIcons.stop else VoiceIcons.play, contentDescription = label, tint = controlTint,
                modifier = Modifier.size(24.dp))
        }
        ConclaveText(conclaveString("chat_voice"), line = "chat.row.${row.id}.voice.label",
            style = MaterialTheme.typography.labelMedium, color = tint, maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false).clearAndSetSemantics { })
        Icon(VoiceIcons.speaking, contentDescription = null, tint = tint,
            modifier = Modifier.size(16.dp).clearAndSetSemantics { })
    }
}

@Composable
internal fun chatVoiceCustomAction(row: ChatRowModel, presenter: ChatPresenter): CustomAccessibilityAction? {
    if (!row.canPlayVoice) return null
    val isPlaying = presenter.playback.activeVoiceRowId == row.id
    val label = VoiceCopyAndroid.playTitle(isPlaying)
    return CustomAccessibilityAction(label) {
        if (isPlaying) presenter.stopVoice() else presenter.playVoice(row.id)
        true
    }
}

@Composable
internal fun ChatVoiceModeRow(presenter: ChatPresenter, composer: ChatComposerSnapshot, draft: String) {
    if (!VoiceMessagePolicy.showsComposerRow(isVoiceMode = composer.isVoiceMode, draft = draft,
            isPrivateMode = composer.privateTo != null, voiceEnabled = composer.voiceEnabled)) return
    val scheme = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().testTag("chat.composer.voice"), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(VoiceIcons.voiceMessage, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f).semantics(mergeDescendants = true) { }) {
            ConclaveText(conclaveString("chat_voice"), line = "chat.composer.voice.title", style = MaterialTheme.typography.labelLarge,
                color = scheme.onSurface)
            ConclaveText(VoiceCopyAndroid.modeLine(composer.voiceKind), line = "chat.composer.voice.line",
                style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
        }
        if (composer.isVoiceMode) {
            IconButton(onClick = { presenter.setVoiceMode(false) }, modifier = Modifier.testTag("chat.composer.voice.exit")) {
                Icon(ConclaveIcons.CloseFill0, contentDescription = conclaveString("chat_voice_exit"), tint = scheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
internal fun ChatVoiceAttachMenuItem(presenter: ChatPresenter, composer: ChatComposerSnapshot, onDismiss: () -> Unit) {
    val reason = VoiceCopyAndroid.unavailableReason(composer)
    ConclaveMenuItem(
        title = conclaveString("chat_attach_voice"),
        identifier = "chat.composer.attach.voice",
        onClick = {
            presenter.setVoiceMode(true)
            onDismiss()
        },
        leadingIcon = VoiceIcons.voiceMessage,
        supporting = if (reason.isEmpty()) null else reason,
        enabled = reason.isEmpty(),
    )
}
