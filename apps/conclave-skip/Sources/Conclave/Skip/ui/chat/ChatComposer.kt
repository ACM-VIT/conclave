package conclave.module

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * S40 6 d (CHT-2): the composer on Android, in the InCallPage composer slot (the page applies imePadding and the
 * horizontal margin). The FND-3 composer column and field (always opaque on Android: surfaceContainerHighest, no
 * indicator, radius 20, IME action Send, hardware Enter sends and Shift+Enter inserts a newline, Q13). Keystrokes stay
 * in Compose state; the draft is written to ChatDraftStore after 500 ms idle and on dispose (R40-7). Every send goes
 * through `presenter.send` (ChatComposerPolicy.route, D24); no send, command or recipient haptic (Q11). CHT-4 and
 * CHT-5: the attach control (an IconButton opening a DropdownMenu of Photo and GIFs and stickers; an item unavailable
 * in the mode stays, disabled, with its reason), the system Photo Picker (no storage permission; the backport module
 * entry in AndroidManifest.xml covers API 28 and 29) whose URI is copied into a cache file on Dispatchers.IO before the
 * presenter gets it (CH6), the attachment chip and the link preview above the field. Voice is CHT-6. Keyboard and
 * clipboard images (`contentReceiver`) need the FND-3 field on TextFieldState: not wired here (see the B5-T6 record).
 */
@Composable
internal fun ChatComposer(presenter: ChatPresenter, actions: ChatRowActions) {
    val composer = presenter.composer
    ChatDiagnostics.counters?.bump("chat.recompose.composer")
    var text by remember { mutableStateOf("") }
    var loadedKey by remember { mutableStateOf("") }
    var hasLoaded by remember { mutableStateOf(false) }
    // CHT-5: the composer preview the person removed; the next send carries suppressEmbeds (6 d).
    var dismissedPreviewUrl by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // CH6: the Photo Picker's URI becomes a cache file off the main thread; cancelling changes nothing.
    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            scope.launch {
                val file = ChatPhotoFiles.copyToCache(context, uri) { presenter.rejectPhoto(ChatFailure.photoTooLarge) }
                if (file != null) presenter.attachPhoto(file.fileUrl, file.mimeType, file.fileName)
            }
        }
    }
    // R40-7: a recipient switch saves the text under the old key and loads the new key's draft; when the new key has
    // none, the text you were writing moves with you.
    LaunchedEffect(composer.draftKey) {
        val key = composer.draftKey
        val stored = presenter.drafts.text(key)
        if (hasLoaded) {
            if (stored.isEmpty()) {
                presenter.drafts.setText("", loadedKey)
            } else {
                presenter.drafts.setText(text, loadedKey)
                text = stored
            }
        } else {
            text = stored
        }
        loadedKey = key
        hasLoaded = true
    }
    LaunchedEffect(text) {
        delay(ChatDraftStore.writeDelayMillis.toLong())
        presenter.drafts.setText(text, loadedKey)
    }
    LaunchedEffect(actions.focusRequest) {
        if (actions.focusRequest == 0) return@LaunchedEffect
        val insert = actions.pendingInsert
        actions.pendingInsert = ""
        if (insert.isNotEmpty()) text = if (text.isEmpty()) insert else "$text $insert"
        runCatching { focus.requestFocus() }
    }
    DisposableEffect(presenter) {
        onDispose { presenter.drafts.setText(text, loadedKey) }
    }
    val limit = ChatComposerPolicy.limit(text, composer.isVoiceMode)
    val count = ChatComposerPolicy.limitLength(text, composer.isVoiceMode)
    val canSend = ChatComposerPolicy.canSend(text, composer.gate, composer.isVoiceMode, composer.attachment)
    val send: () -> Unit = {
        val dismissed = dismissedPreviewUrl
        val result = if (dismissed.isEmpty()) presenter.send(text, "") else presenter.send(text, dismissed)
        if (result == ChatSendResult.dispatched) {
            text = ""
            dismissedPreviewUrl = ""
            presenter.drafts.setText("", loadedKey)
        }
    }
    // The InCallPage composer slot already pads 16 by 8, so the column adds no padding of its own.
    Column(Modifier.fillMaxWidth().testTag("chat.composer"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ChatSuggestionList(text, composer) { replacement -> text = replacement }
        val reply = composer.reply
        if (reply != null) {
            ConclaveComposerReplyBar(ChatCopyAndroid.replyTitle(reply), ChatCopyAndroid.replyPreview(reply),
                conclaveString("chat_cancel_reply"), "chat.composer.reply", { presenter.cancelReply() })
        }
        ChatAttachmentChipRow(presenter, composer.attachment)
        ChatComposerLinkPreview(presenter, text, dismissedPreviewUrl) { url -> dismissedPreviewUrl = url }
        ChatComposerModeRow(presenter, composer, text)
        ChatVoiceModeRow(presenter, composer, text)
        if (composer.inlineNotice != ChatFailure.none) {
            ConclaveComposerStatusLine(ChatMediaCopyAndroid.failureReason(composer.inlineNotice), "chat.composer.notice")
        }
        val gateLine = ChatCopyAndroid.gateLine(composer.gate)
        if (gateLine.isNotEmpty()) ConclaveComposerStatusLine(gateLine, "chat.composer.gate")
        ConclaveComposerField(
            placeholder = ChatCopyAndroid.placeholder(composer),
            value = text,
            onValueChange = { next ->
                text = next
                presenter.clearInlineNotice()
            },
            sendEnabled = canSend,
            onSend = send,
            identifier = "chat.composer.field",
            modifier = Modifier.focusRequester(focus),
            sendLabel = VoiceCopyAndroid.sendLabel(composer),
            enabled = composer.gate != ChatSendGate.locked,
            attach = {
                ChatAttachMenuButton(
                    presenter,
                    composer,
                    onPhoto = {
                        // S70 8 d (SYS-8, HD/requests/B5-T4.md R17 e): the picker activity must not tear the call into
                        // PiP; auto-enter comes back if the launch fails.
                        PipManager.suppressForExternalHandoff(ExternalHandoffKind.photoPicker)
                        try {
                            pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        } catch (failure: Throwable) {
                            PipManager.restoreAutoEnterAfterExternalActivity()
                        }
                    },
                    onGifs = { actions.openGifs() },
                )
            },
        )
        ConclaveCharacterCounter(count, limit,
            if (composer.isVoiceMode) 0 else ConclaveComposerCounterPolicy.visibleFrom(limit),
            "chat.composer.counter", Modifier.align(Alignment.End))
    }
}

/**
 * 6 d recipient chip and the implicit private line: an AssistChip "To: everyone" opens a DropdownMenu of everyone and
 * the people you can message privately; "Will be sent privately to %1$s" reads the shared implicit-target rule.
 */
@Composable
private fun ChatComposerModeRow(presenter: ChatPresenter, composer: ChatComposerSnapshot, draft: String) {
    var expanded by remember { mutableStateOf(false) }
    if (composer.privateEnabled && composer.recipients.count > 0) {
        val recipient = composer.privateTo
        Box {
            AssistChip(
                onClick = { expanded = true },
                label = {
                    val label = if (recipient != null) conclaveString("chat_private_to", recipient.name) else conclaveString("chat_to_everyone")
                    ConclaveText(label, line = "chat.composer.recipient.label", maxLines = 1, overflow = TextOverflow.Ellipsis)
                },
                leadingIcon = {
                    Icon(if (recipient != null) ConclaveIcons.LockFill1 else ConclaveIcons.GroupFill0, contentDescription = null,
                        modifier = Modifier.size(18.dp))
                },
                modifier = Modifier.testTag("chat.composer.recipient"),
            )
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                NativeSemanticsPopupRoot("chat.composer.recipients")
                DropdownMenuItem(
                    text = { ConclaveText(conclaveString("chat_everyone"), line = "chat.recipient.everyone") },
                    onClick = {
                        presenter.setPrivateTo("")
                        expanded = false
                    },
                )
                HorizontalDivider()
                ConclaveText(conclaveString("chat_send_privately_to"), line = "chat.recipient.header",
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                for (person in composer.recipients) {
                    DropdownMenuItem(
                        text = { ConclaveText(person.name, line = "chat.recipient.${person.userId}", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        onClick = {
                            presenter.setPrivateTo(person.userId)
                            expanded = false
                        },
                        modifier = Modifier.testTag("chat.recipient.${person.userId}"),
                    )
                }
            }
        }
    }
    if (composer.privateTo == null) {
        val implicit = ChatComposerPolicy.implicitPrivateTarget(draft, composer.recipients, "", composer.privateEnabled)
        val target = implicit.recipient
        if (target != null) {
            ConclaveComposerStatusLine(conclaveString("chat_implicit_private", target.name), "chat.composer.implicit")
        } else if (implicit.failure != ChatFailure.none) {
            ConclaveComposerStatusLine(ChatCopyAndroid.failureReason(implicit.failure), "chat.composer.implicit")
        }
    }
}

/**
 * 6 d suggestions: commands for a bare `/word`, mentions for a trailing `@word` (a mention wins), in a surface above
 * the field, 4.5 rows then scrolling; unavailable rows dimmed with their reason; a polite count announcement.
 */
@Composable
private fun ChatSuggestionList(draft: String, composer: ChatComposerSnapshot, onPick: (String) -> Unit) {
    val mentions = ChatComposerPolicy.mentionSuggestions(draft, composer.mentionOptions).toList()
    val commands = if (mentions.isEmpty()) ChatComposerPolicy.commandSuggestions(draft, composer.commandRows).toList() else emptyList()
    val total = if (mentions.isEmpty()) commands.size else mentions.size
    if (total == 0) return
    val countText = conclavePlural("chat_suggestions", total, total)
    val rowHeight = 48.dp
    // 6 i: the count is spoken from a hidden polite node, never from the rows.
    Box(Modifier.size(1.dp).semantics {
        liveRegion = LiveRegionMode.Polite
        contentDescription = countText
    })
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.medium,
        tonalElevation = 0.dp,
        modifier = Modifier.fillMaxWidth().heightIn(max = rowHeight * ChatComposerPolicy.suggestionVisibleRows.toFloat()),
    ) {
        LazyColumn {
            items(mentions, key = { "m:" + it.id }) { option ->
                val dimmed = option.isAssistant && composer.privateTo != null
                val title = when {
                    option.isYou -> conclaveString("chat_mention_you", option.name)
                    option.isAssistant -> conclaveString("chat_mention_assistant")
                    else -> option.name
                }
                val detail = when {
                    option.isAssistant && dimmed -> conclaveString("chat_reason_assistant_public")
                    option.isAssistant -> conclaveString("chat_mention_assistant_hint")
                    else -> "@" + option.token
                }
                Row(
                    Modifier.fillMaxWidth().heightIn(min = rowHeight).alpha(if (dimmed) 0.38f else 1f)
                        .clickable(enabled = !dimmed) { onPick(ChatComposerPolicy.insertingMention(draft, option.token)) }
                        .padding(horizontal = 12.dp).testTag("chat.suggestion.${option.id}"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (option.isAssistant) {
                        Icon(ConclaveIcons.ChatBubbleFill1, contentDescription = null, tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(24.dp))
                    } else {
                        ConclaveAvatar(option.name, option.id, ConclaveAvatarSize.mention)
                    }
                    Column(Modifier.weight(1f)) {
                        ConclaveText(title, line = "chat.suggestion.${option.id}.title", style = MaterialTheme.typography.bodyLarge,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        ConclaveText(detail, line = "chat.suggestion.${option.id}.detail", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            items(commands, key = { "c:" + it.id }) { row ->
                val detail = if (row.isAvailable) ChatCopyAndroid.commandDescription(row.id) else ChatCopyAndroid.commandReason(row.reason)
                Row(
                    Modifier.fillMaxWidth().heightIn(min = rowHeight).alpha(if (row.isAvailable) 1f else 0.38f)
                        .clickable(enabled = row.isAvailable) { onPick(ChatComposerPolicy.insertingCommand(row.id)) }
                        .padding(horizontal = 12.dp).testTag("chat.suggestion.${row.id}"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ConclaveText(row.usage, line = "chat.suggestion.${row.id}.usage", style = MaterialTheme.typography.bodyLarge)
                    ConclaveText(detail, line = "chat.suggestion.${row.id}.detail", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

/**
 * 6 d attach control: an IconButton opening a DropdownMenu. Items unavailable in the current mode stay in the menu,
 * disabled, with the reason as a second line (private mode is text only; photos follow the host switch).
 */
@Composable
private fun ChatAttachMenuButton(presenter: ChatPresenter, composer: ChatComposerSnapshot, onPhoto: () -> Unit, onGifs: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    Box {
        IconButton(onClick = { expanded = true }, enabled = composer.gate == ChatSendGate.open,
            modifier = Modifier.testTag("chat.composer.attach")) {
            Icon(ConclaveIcons.ImageFill0, contentDescription = conclaveString("chat_attach"))
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            NativeSemanticsPopupRoot("chat.composer.attach.menu")
            for (kind in composer.attachKinds) {
                if (kind == VoiceMessagePolicy.attachKind) {
                    ChatVoiceAttachMenuItem(presenter, composer, onDismiss = { expanded = false })
                    continue
                }
                val reason = ChatComposerPolicy.attachItemReason(kind, composer.privateTo != null, composer.photosEnabled,
                    composer.voiceEnabled)
                val reasonText = ChatMediaCopyAndroid.attachReason(reason)
                val title = when (kind) {
                    "photo" -> conclaveString("chat_attach_photo")
                    "gif" -> conclaveString("chat_attach_gif")
                    else -> ""
                }
                if (title.isEmpty()) continue
                val busy = kind == "photo" && composer.attachment.phase != ChatAttachmentPhase.none
                DropdownMenuItem(
                    text = {
                        Column {
                            ConclaveText(title, line = "chat.composer.attach.$kind.title")
                            if (reasonText.isNotEmpty()) {
                                ConclaveText(reasonText, line = "chat.composer.attach.$kind.reason", style = MaterialTheme.typography.bodySmall,
                                    color = scheme.onSurfaceVariant)
                            }
                        }
                    },
                    leadingIcon = {
                        Icon(if (kind == "gif") ConclaveIcons.GifBoxFill0 else ConclaveIcons.ImageFill0, contentDescription = null,
                            tint = scheme.onSurfaceVariant)
                    },
                    enabled = reason.isEmpty() && !busy,
                    onClick = {
                        expanded = false
                        if (kind == "photo") onPhoto() else onGifs()
                    },
                    modifier = Modifier.testTag("chat.composer.attach.$kind"),
                )
            }
        }
    }
}

/**
 * 6 d attachment chip (FND-3 component): the thumbnail from the cache file, "Photo", the status line, the linear
 * indicator while preparing or uploading, Try again after a failure, and Remove. Absent while there is no photo.
 */
@Composable
private fun ChatAttachmentChipRow(presenter: ChatPresenter, attachment: ChatAttachmentState) {
    val phase = when (attachment.phase) {
        ChatAttachmentPhase.preparing -> ConclaveAttachmentPhase.preparing
        ChatAttachmentPhase.uploading -> ConclaveAttachmentPhase.uploading
        ChatAttachmentPhase.ready -> ConclaveAttachmentPhase.ready
        ChatAttachmentPhase.failed -> ConclaveAttachmentPhase.failed
        else -> return
    }
    ConclaveComposerAttachmentChip(
        title = conclaveString("chat_attachment_photo"),
        status = ChatMediaCopyAndroid.attachmentStatus(attachment),
        phase = phase,
        removeLabel = conclaveString("chat_attachment_remove"),
        identifier = "chat.composer.attachment",
        onRemove = { presenter.removeAttachment() },
        progress = if (attachment.phase == ChatAttachmentPhase.uploading && attachment.progress >= 0) attachment.progress.toFloat() else null,
        onRetry = { presenter.retryAttachment() },
        thumbnail = { ChatImageBox(attachment.thumbnailKey, 40.dp, 40.dp) },
    )
}
