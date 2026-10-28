package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.DropdownMenuItem
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

/*
 * S40 3 d and 6 d (CHT-6): voice messages on Android, handwritten Compose Material 3 over the transpiled presenter.
 * ChatVoiceControl is the header inside a voice row's bubble and the only composable that reads presenter.playback (a
 * playback change recomposes that small node only; R13: a static GraphicEqFill0 mark, no equalizer animation);
 * chatVoiceCustomAction adds "Play voice message" or "Stop speaking" to the row's summary node; ChatVoiceModeRow is
 * the composer's voice row and ChatVoiceAttachMenuItem the attach menu item. Replay is local ("Only you will hear
 * it"). No haptic for play, stop or voice mode (D6, Q11). The row and the composer mount these (HD request B5-T7 R3
 * to B5-T6, who owns the chat row and composer files this batch). Icons carry an explicit tint.
 */

/**
 * Canonical playback, stop and voice-message artwork; speaking remains the S40 3 e GraphicEqFill0.
 */
internal object VoiceIcons {
    val play: ImageVector get() = ConclaveIcons.PlayArrowFill1
    val stop: ImageVector get() = ConclaveIcons.StopFill1
    val speaking: ImageVector get() = ConclaveIcons.GraphicEqFill0
    val voiceMessage: ImageVector get() = ConclaveIcons.RecordVoiceOverFill0
}

/** S40 3 g and 6 g voice copy (Material sentence case). */
internal object VoiceCopyAndroid {
    @Composable
    fun header(isPlaying: Boolean): String =
        if (isPlaying) conclaveString("chat_voice_speaking") else conclaveString("chat_voice")

    @Composable
    fun playTitle(isPlaying: Boolean): String =
        if (isPlaying) conclaveString("chat_voice_stop") else conclaveString("chat_voice_play")

    /** "Read aloud to everyone · System voice" (the hint and the voice kind joined with " · "). */
    @Composable
    fun modeLine(voiceKind: String): String {
        val kind = if (voiceKind == VoiceKind.personal.rawValue) conclaveString("chat_voice_personal") else conclaveString("chat_voice_system")
        return conclaveString("chat_voice_line", conclaveString("chat_voice_hint"), kind)
    }

    /** The composer placeholder in voice mode; null outside it (the composer keeps its own). */
    @Composable
    fun placeholder(composer: ChatComposerSnapshot): String? =
        if (composer.isVoiceMode) conclaveString("chat_placeholder_voice") else null

    /** The Send description in voice mode; null keeps the component's "Send". */
    @Composable
    fun sendLabel(composer: ChatComposerSnapshot): String? =
        if (composer.isVoiceMode) conclaveString("chat_send_voice") else null

    /** The row summary's value part (3 i). */
    @Composable
    fun accessibilityValue(): String = conclaveString("chat_ax_voice")

    /** Why the attach item is unavailable ("" when available): private mode first (D24), then the host switch. */
    @Composable
    fun unavailableReason(composer: ChatComposerSnapshot): String = when {
        composer.privateTo != null -> conclaveString("chat_reason_private_text")
        !composer.voiceEnabled -> conclaveString("chat_reason_voice_off")
        else -> ""
    }
}

/**
 * S40 3 d voice header: an IconButton play or stop (48 dp target), labelMedium "Voice message" or "Speaking", then the
 * static speaking mark; the bubble text (the full message) follows. With voice messages off by the host the button
 * hides and the label stays (3 f). The label and mark are cleared from semantics: the summary node speaks "Voice
 * message", and the button is its own node.
 */
@Composable
internal fun ChatVoiceControl(row: ChatRowModel, presenter: ChatPresenter) {
    val isPlaying = presenter.playback.activeVoiceRowId == row.id
    val tint = LocalContentColor.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (row.canPlayVoice) {
            val label = VoiceCopyAndroid.playTitle(isPlaying)
            val hint = conclaveString("chat_voice_play_hint")
            IconButton(
                onClick = { if (isPlaying) presenter.stopVoice() else presenter.playVoice(row.id) },
                modifier = Modifier.testTag("chat.row.${row.id}.voice").semantics {
                    if (!isPlaying) stateDescription = hint
                },
            ) {
                Icon(if (isPlaying) VoiceIcons.stop else VoiceIcons.play, contentDescription = label, tint = tint)
            }
        }
        ConclaveText(VoiceCopyAndroid.header(isPlaying), line = "chat.row.${row.id}.voice.label",
            style = MaterialTheme.typography.labelMedium, color = tint, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.clearAndSetSemantics { })
        Icon(VoiceIcons.speaking, contentDescription = null, tint = tint,
            modifier = Modifier.size(16.dp).clearAndSetSemantics { })
    }
}

/** 3 i: the voice row's summary action, after the menu actions; null for rows that cannot play. */
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

/**
 * S40 6 d voice mode row above the field: "Voice message" over "Read aloud to everyone · System voice", with Exit in
 * voice mode. A typed "/tts " draft shows the same row without Exit (web CHT-18). Hidden in private mode (D24) and
 * while the host turned voice messages off.
 */
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

/**
 * S40 6 d attach menu item "Voice message" inside the composer's DropdownMenu: unavailable items stay, disabled, with
 * the reason as a second line. [onDismiss] closes the menu.
 */
@Composable
internal fun ChatVoiceAttachMenuItem(presenter: ChatPresenter, composer: ChatComposerSnapshot, onDismiss: () -> Unit) {
    val reason = VoiceCopyAndroid.unavailableReason(composer)
    val scheme = MaterialTheme.colorScheme
    DropdownMenuItem(
        text = {
            Column {
                ConclaveText(conclaveString("chat_attach_voice"), line = "chat.composer.attach.voice.title")
                if (reason.isNotEmpty()) {
                    ConclaveText(reason, line = "chat.composer.attach.voice.reason", style = MaterialTheme.typography.bodySmall,
                        color = scheme.onSurfaceVariant)
                }
            }
        },
        onClick = {
            presenter.setVoiceMode(true)
            onDismiss()
        },
        leadingIcon = { Icon(VoiceIcons.voiceMessage, contentDescription = null, tint = LocalContentColor.current) },
        enabled = reason.isEmpty(),
        modifier = Modifier.testTag("chat.composer.attach.voice"),
    )
}
