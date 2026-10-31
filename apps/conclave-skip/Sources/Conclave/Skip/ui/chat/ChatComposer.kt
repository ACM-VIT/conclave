package conclave.module

import android.content.ClipData
import android.content.Context
import android.content.res.Configuration
import android.net.Uri
import android.view.accessibility.AccessibilityManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.content.ReceiveContentListener
import androidx.compose.foundation.content.TransferableContent
import androidx.compose.foundation.content.consume
import androidx.compose.foundation.content.contentReceiver
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.clearText
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.PopupProperties
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ChatComposer(presenter: ChatPresenter, actions: ChatRowActions) {
    val composer = presenter.composer
    ChatDiagnostics.counters?.bump("chat.recompose.composer")
    val draftState = rememberTextFieldState()
    var loadedKey by remember { mutableStateOf("") }
    var hasLoaded by remember { mutableStateOf(false) }

    var dismissedPreviewUrl by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val keys = remember { ChatComposerKeys() }
    val focusMemory = remember { ChatComposerFocusMemory() }

    var photoIntakeInFlight by remember { mutableStateOf(false) }

    var blockedPress by remember { mutableIntStateOf(0) }
    var blockedBlock by remember { mutableStateOf(ChatSendBlock.none) }

    val hardware = LocalConfiguration.current.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO

    val restoreFocus: (ChatFocusCapture) -> Unit = { capture ->
        if (ChatComposerPolicy.restoresComposerFocus(capture.wasFocused, chatTouchExplorationOn(context))) {
            runCatching { focus.requestFocus() }
            if (capture.imeWasVisible) keyboard?.show()
        }
    }

    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            scope.launch {
                val file = ChatPhotoFiles.copyToCache(context, uri) { presenter.rejectPhoto(ChatFailure.photoTooLarge) }
                if (file != null) presenter.attachPhoto(file.fileUrl, file.mimeType, file.fileName)
            }
        }

        focusMemory.takePicker()?.let { restoreFocus(it) }
    }

    LaunchedEffect(composer.draftKey) {
        chatSwitchDraft(draftState, presenter.drafts, loadedKey, hasLoaded, composer.draftKey)
        loadedKey = composer.draftKey
        hasLoaded = true
    }

    LaunchedEffect(draftState) {
        snapshotFlow { draftState.text.toString() }
            .drop(1)
            .collectLatest { value ->
                presenter.clearInlineNotice()
                keys.syncDraft(value)
                delay(ChatDraftStore.writeDelayMillis.toLong())
                presenter.drafts.setText(value, loadedKey)
            }
    }
    LaunchedEffect(actions.focusRequest) {
        if (actions.focusRequest == 0) return@LaunchedEffect
        val insert = actions.pendingInsert
        actions.pendingInsert = ""
        chatAppendInsert(draftState, insert)
        runCatching { focus.requestFocus() }
    }

    LaunchedEffect(actions.showsGifs) {
        if (!actions.showsGifs) actions.takeGifsFocusCapture()?.let { restoreFocus(it) }
    }
    DisposableEffect(presenter) {
        onDispose { presenter.drafts.setText(draftState.text.toString(), loadedKey) }
    }

    val receiver = remember(presenter) {
        object : ReceiveContentListener {
            override fun onReceive(transferableContent: TransferableContent): TransferableContent? {
                val uris = chatImageUris(transferableContent.clipEntry.clipData)
                if (uris.isEmpty()) return transferableContent
                val current = presenter.composer
                if (photoIntakeInFlight || !presenter.canAcceptPhoto) {
                    val notice = ChatComposerPolicy.photoIntakeNotice(current.gate, current.privateTo != null, current.photosEnabled,
                        current.attachment.phase != ChatAttachmentPhase.none, photoIntakeInFlight)
                    if (notice != ChatFailure.none) presenter.rejectPhoto(notice)
                    return transferableContent
                }
                photoIntakeInFlight = true
                val uri = uris.first()
                val surplus = uris.size > 1
                scope.launch {
                    var tooLarge = false
                    val file = try {
                        ChatPhotoFiles.copyToCache(context, uri) {
                            tooLarge = true
                            presenter.rejectPhoto(ChatFailure.photoTooLarge)
                        }
                    } catch (failure: SecurityException) {
                        null
                    }
                    if (file != null) {
                        presenter.attachPhoto(file.fileUrl, file.mimeType, file.fileName)

                        if (surplus) presenter.rejectPhoto(ChatFailure.oneAttachment)
                    } else if (!tooLarge) {
                        presenter.rejectPhoto(ChatFailure.photoUnavailable)
                    }
                    photoIntakeInFlight = false
                }
                return transferableContent.consume { item -> item.uri != null }
            }
        }
    }
    val draft = draftState.text.toString()
    val suggestions = ChatSuggestionsModel.make(draft, composer, keys, hardware)
    val limit = ChatComposerPolicy.limit(draft, composer.isVoiceMode)
    val count = ChatComposerPolicy.limitLength(draft, composer.isVoiceMode)
    val block = ChatComposerPolicy.sendBlock(draft, composer.gate, composer.isVoiceMode, composer.attachment)
    val canSend = block == ChatSendBlock.none
    val sendReason = chatSendBlockReason(block, count - limit, composer.attachment)

    val dispatch: () -> ChatSendResult = {
        val text = draftState.text.toString()
        val dismissed = dismissedPreviewUrl
        val result = if (dismissed.isEmpty()) presenter.send(text, "") else presenter.send(text, dismissed)
        if (result == ChatSendResult.dispatched) {
            draftState.clearText()
            dismissedPreviewUrl = ""
            presenter.drafts.setText("", loadedKey)
        }
        result
    }
    val send: () -> Unit = { dispatch() }

    val sendFromKeyboard: () -> Unit = {
        val current = presenter.composer
        val pressed = ChatComposerPolicy.sendBlock(draftState.text.toString(), current.gate, current.isVoiceMode, current.attachment)
        val noticeBefore = current.inlineNotice
        val result = dispatch()
        if (result == ChatSendResult.blocked && presenter.composer.inlineNotice == noticeBefore
            && ChatComposerPolicy.announcesBlockedSend(pressed)) {
            blockedBlock = pressed
            blockedPress += 1
        }
    }
    val insertSuggestion: (String) -> Unit = { insert -> draftState.setTextAndPlaceCursorAtEnd(insert) }

    Column(Modifier.fillMaxWidth().testTag("chat.composer").contentReceiver(receiver), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ChatSuggestionList(suggestions, keys, composer.privateTo != null, insertSuggestion)
        val reply = composer.reply
        if (reply != null) {
            ConclaveComposerReplyBar(ChatCopyAndroid.replyTitle(reply), ChatCopyAndroid.replyPreview(reply),
                conclaveString("chat_cancel_reply"), "chat.composer.reply", { presenter.cancelReply() })
        }
        ChatAttachmentChipRow(presenter, composer.attachment)
        ChatComposerLinkPreview(presenter, draft, dismissedPreviewUrl) { url -> dismissedPreviewUrl = url }
        ChatComposerModeRow(presenter, composer, draft, { focusMemory.fieldFocused }, restoreFocus)
        ChatVoiceModeRow(presenter, composer, draft)
        if (composer.inlineNotice != ChatFailure.none) {
            ConclaveComposerStatusLine(ChatMediaCopyAndroid.failureReason(composer.inlineNotice), "chat.composer.notice")
        }

        val gateLine = ChatCopyAndroid.gateLine(composer.gateLine)
        if (gateLine.isNotEmpty()) ConclaveComposerStatusLine(gateLine, "chat.composer.gate")
        Box(Modifier.fillMaxWidth()) {
            ConclaveComposerField(
                placeholder = ChatCopyAndroid.placeholder(composer),
                state = draftState,
                sendEnabled = canSend,
                onSend = send,
                identifier = "chat.composer.field",
                sendLabel = VoiceCopyAndroid.sendLabel(composer),
                sendDisabledReason = sendReason,
                enabled = composer.gate != ChatSendGate.locked,
                onHardwareKey = { event ->
                    keys.onKey(event, hardware, draftState.text.toString(), suggestions, insertSuggestion, sendFromKeyboard)
                },
                onSendBlocked = sendFromKeyboard,

                fieldModifier = Modifier.focusRequester(focus).onFocusChanged { state ->
                    val now = state.hasFocus

                    if (now && !focusMemory.fieldFocused) actions.composerDidFocus()
                    focusMemory.fieldFocused = now
                },
                attach = {
                    ChatAttachMenuButton(
                        presenter,
                        composer,
                        isFieldFocused = { focusMemory.fieldFocused },
                        restoreFocus = restoreFocus,
                        onPhoto = { capture ->
                            focusMemory.picker = capture

                            PipManager.suppressForExternalHandoff(ExternalHandoffKind.photoPicker)
                            try {
                                pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                            } catch (failure: Throwable) {
                                focusMemory.picker = null
                                PipManager.restoreAutoEnterAfterExternalActivity()
                            }
                        },
                        onGifs = { capture ->
                            actions.gifsFocusCapture = capture
                            actions.openGifs()
                        },
                    )
                },
            )
            ChatBlockedSendAnnouncer(blockedPress, chatSendBlockReason(blockedBlock, count - limit, composer.attachment))
        }
        ConclaveCharacterCounter(count, limit,
            if (composer.isVoiceMode) 0 else ConclaveComposerCounterPolicy.visibleFrom(limit),
            "chat.composer.counter", Modifier.align(Alignment.End), announcesBands = true)
    }
}

@Composable
private fun ChatBlockedSendAnnouncer(press: Int, reason: String) {
    val view = LocalView.current
    LaunchedEffect(press) {
        if (press > 0 && reason.isNotEmpty()) {
            @Suppress("DEPRECATION")
            view.announceForAccessibility(reason)
        }
    }
}

internal fun chatSwitchDraft(state: TextFieldState, drafts: ChatDraftStore, loadedKey: String, hasLoaded: Boolean, key: String) {
    val stored = drafts.text(key)
    if (hasLoaded) {
        if (stored.isEmpty()) {
            drafts.setText("", loadedKey)
        } else {
            drafts.setText(state.text.toString(), loadedKey)
            state.setTextAndPlaceCursorAtEnd(stored)
        }
    } else {
        state.setTextAndPlaceCursorAtEnd(stored)
    }
}

internal fun chatAppendInsert(state: TextFieldState, insert: String) {
    if (insert.isEmpty()) return
    val current = state.text.toString()
    state.setTextAndPlaceCursorAtEnd(if (current.isEmpty()) insert else "$current $insert")
}

internal fun chatImageUris(clipData: ClipData): List<Uri> {
    if (!clipData.description.hasMimeType("image/*")) return emptyList()
    val result = mutableListOf<Uri>()
    for (index in 0 until clipData.itemCount) {
        val uri = clipData.getItemAt(index).uri
        if (uri != null) result.add(uri)
    }
    return result
}

internal fun chatSendBlockReasonName(block: ChatSendBlock): String = when (block) {
    ChatSendBlock.none, ChatSendBlock.attendee, ChatSendBlock.photoFailed -> ""
    ChatSendBlock.empty -> "chat_send_reason_empty"
    ChatSendBlock.notJoined -> "chat_send_reason_not_joined"
    ChatSendBlock.reconnecting -> "ds_state_reconnecting"
    ChatSendBlock.offline -> "chat_send_reason_offline"
    ChatSendBlock.locked -> "chat_placeholder_locked"
    ChatSendBlock.overLimit -> "ds_char_over_limit"
    ChatSendBlock.photoPending -> "chat_send_reason_uploading"
}

@Composable
private fun chatSendBlockReason(block: ChatSendBlock, overBy: Int, attachment: ChatAttachmentState): String {
    if (block == ChatSendBlock.photoFailed) return ChatMediaCopyAndroid.attachmentStatus(attachment)
    if (block == ChatSendBlock.overLimit) {
        val over = maxOf(overBy, 1)
        return conclavePlural("ds_char_over_limit", over, over)
    }
    val name = chatSendBlockReasonName(block)
    return if (name.isEmpty()) "" else conclaveString(name)
}

private fun chatTouchExplorationOn(context: Context): Boolean =
    context.getSystemService(AccessibilityManager::class.java)?.isTouchExplorationEnabled == true

internal data class ChatFocusCapture(val wasFocused: Boolean, val imeWasVisible: Boolean, val menuFocusable: Boolean) {
    companion object {
        val none = ChatFocusCapture(wasFocused = false, imeWasVisible = false, menuFocusable = true)

        fun capture(wasFocused: Boolean, imeVisible: Boolean, touchExploration: Boolean): ChatFocusCapture =
            ChatFocusCapture(wasFocused, imeVisible, ChatComposerPolicy.composerMenuIsFocusable(imeVisible, touchExploration))
    }
}

internal class ChatComposerFocusMemory {
    var fieldFocused = false
    var picker: ChatFocusCapture? = null

    fun takePicker(): ChatFocusCapture? {
        val capture = picker
        picker = null
        return capture
    }
}

internal class ChatSuggestionsModel(
    val trigger: ChatSuggestionTrigger,
    val queryKey: String,
    val mentions: List<ChatMentionOption>,
    val commands: List<ChatCommandRow>,
    val items: skip.lib.Array<ChatSuggestionItem>,
    val visible: Boolean,
    val highlight: String,
) {
    val itemIds: List<String> = items.toList().map { it.id }

    val highlightedInsert: String
        get() = ChatComposerPolicy.insertText(highlight, items)

    fun insertText(itemId: String): String {
        for (item in items) {
            if (item.id == itemId) return item.insertText
        }
        return ""
    }

    companion object {
        fun make(draft: String, composer: ChatComposerSnapshot, keys: ChatComposerKeys, hardware: Boolean): ChatSuggestionsModel {
            val trigger = ChatComposerPolicy.suggestionTrigger(draft)
            val queryKey = ChatComposerPolicy.highlightQueryKey(trigger)
            val mentions = ChatComposerPolicy.mentionSuggestions(draft, composer.mentionOptions)
            val commands = if (mentions.count == 0) ChatComposerPolicy.commandSuggestions(draft, composer.commandRows)
                else skip.lib.Array<ChatCommandRow>()
            val items = ChatComposerPolicy.suggestionItemsFor(mentions, commands, draft, composer.privateTo != null)
            val visible = items.count > 0 && !keys.isDismissed(trigger)
            val highlight = keys.effectiveHighlight(items, queryKey, hardware, visible)
            return ChatSuggestionsModel(trigger, queryKey, mentions.toList(), commands.toList(), items, visible, highlight)
        }
    }
}

internal class ChatComposerKeys {
    var highlightedId by mutableStateOf("")
        private set
    var highlightQuery by mutableStateOf("")
        private set
    var dismissedKey by mutableStateOf("")
        private set

    var announcedId by mutableStateOf("")
        private set
    private val consumedDowns = mutableSetOf<Key>()

    fun isDismissed(trigger: ChatSuggestionTrigger): Boolean = ChatComposerPolicy.isDismissed(trigger, dismissedKey)

    fun effectiveHighlight(items: skip.lib.Array<ChatSuggestionItem>, queryKey: String, hardware: Boolean, visible: Boolean): String =
        if (hardware && visible) ChatComposerPolicy.resolvedHighlight(highlightedId, items, highlightQuery, queryKey) else ""

    fun syncDraft(draft: String) {
        val trigger = ChatComposerPolicy.suggestionTrigger(draft)
        val kept = ChatComposerPolicy.dismissedKey(trigger, dismissedKey)
        if (kept != dismissedKey) dismissedKey = kept
        val query = ChatComposerPolicy.highlightQueryKey(trigger)
        if (query != highlightQuery && (highlightedId.isNotEmpty() || announcedId.isNotEmpty())) {
            highlightedId = ""
            announcedId = ""
            highlightQuery = query
        }
    }

    fun onKey(
        event: KeyEvent, hardware: Boolean, draft: String, model: ChatSuggestionsModel, onInsert: (String) -> Unit,
        onSend: () -> Unit,
    ): Boolean {
        if (!hardware) {
            consumedDowns.clear()
            return false
        }
        val key = event.key
        if (event.type == KeyEventType.KeyUp) return consumedDowns.remove(key)
        if (event.type != KeyEventType.KeyDown) return false
        val isRepeat = event.nativeKeyEvent.repeatCount > 0
        val handled = when (key) {
            Key.DirectionUp -> move(-1, model)
            Key.DirectionDown -> move(1, model)

            Key.Tab -> if (isRepeat) consumedDowns.contains(key) else !event.isShiftPressed && insert(model, onInsert)
            Key.Escape -> if (isRepeat) consumedDowns.contains(key) else dismiss(model)
            Key.Enter, Key.NumPadEnter -> enter(event.isShiftPressed, isRepeat, draft, model, onInsert, onSend)
            else -> false
        }
        if (handled) consumedDowns.add(key) else consumedDowns.remove(key)
        return handled
    }

    private fun enter(
        isShift: Boolean, isRepeat: Boolean, draft: String, model: ChatSuggestionsModel, onInsert: (String) -> Unit,
        onSend: () -> Unit,
    ): Boolean = when (ChatComposerPolicy.returnKeyAction(true, isShift, false, isRepeat, model.visible, model.highlightedInsert, draft)) {
        ChatReturnKeyAction.ignore -> false
        ChatReturnKeyAction.consume -> true
        ChatReturnKeyAction.insertSuggestion -> {
            onInsert(model.highlightedInsert)
            true
        }
        ChatReturnKeyAction.send -> {
            onSend()
            true
        }
    }

    private fun move(delta: Int, model: ChatSuggestionsModel): Boolean {
        if (!model.visible) return false
        val next = ChatComposerPolicy.movedHighlight(model.highlight, model.items, delta)
        if (next.isEmpty()) return false
        highlightedId = next
        highlightQuery = model.queryKey
        announcedId = next
        return true
    }

    private fun insert(model: ChatSuggestionsModel, onInsert: (String) -> Unit): Boolean {
        if (!model.visible) return false
        val text = model.highlightedInsert
        if (text.isEmpty()) return false
        onInsert(text)
        return true
    }

    private fun dismiss(model: ChatSuggestionsModel): Boolean {
        if (!model.visible) return false
        dismissedKey = model.trigger.key
        return true
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChatComposerModeRow(
    presenter: ChatPresenter, composer: ChatComposerSnapshot, draft: String, isFieldFocused: () -> Boolean,
    restoreFocus: (ChatFocusCapture) -> Unit,
) {

    val imeVisible = WindowInsets.isImeVisible
    var expanded by remember { mutableStateOf(false) }
    var capture by remember { mutableStateOf(ChatFocusCapture.none) }
    val context = LocalContext.current
    if (composer.privateEnabled && composer.recipients.count > 0) {
        val recipient = composer.privateTo

        val close: () -> Unit = {
            expanded = false
            if (capture.menuFocusable) restoreFocus(capture)
        }
        Box {
            AssistChip(
                onClick = {
                    capture = ChatFocusCapture.capture(isFieldFocused(), imeVisible, chatTouchExplorationOn(context))
                    expanded = true
                },
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
            ConclaveDropdownMenu(
                expanded = expanded,
                onDismissRequest = close,
                identifier = "chat.composer.recipients",
                properties = if (capture.menuFocusable) PopupProperties(focusable = true) else PopupProperties(focusable = false),
            ) {
                val everyone = recipient == null
                ConclaveMenuItem(
                    title = conclaveString("chat_everyone"),
                    identifier = "chat.recipient.everyone",
                    onClick = {
                        presenter.setPrivateTo("")
                        close()
                    },
                    role = ConclaveMenuRole.Single(everyone),
                    leadingIcon = ConclaveIcons.GroupFill0,
                )
                ConclaveMenuDivider()
                ConclaveMenuHeader(conclaveString("chat_send_privately_to"), "chat.recipient.header")
                for (person in composer.recipients) {
                    val current = recipient?.userId == person.userId
                    ConclaveMenuItem(
                        title = person.name,
                        identifier = "chat.recipient.${person.userId}",
                        onClick = {
                            presenter.setPrivateTo(person.userId)
                            close()
                        },
                        role = ConclaveMenuRole.Single(current),
                        leadingContent = {
                            ConclaveAvatar(ConclaveAvatarIdentity.fromSeed(PeopleRowPolicy.avatarSeed(name = person.name,
                                userId = person.userId, isLocal = false)), 24.dp)
                        },
                    )
                }
            }
            BackHandler(enabled = expanded && !capture.menuFocusable) { expanded = false }
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

@Composable
private fun ChatSuggestionList(model: ChatSuggestionsModel, keys: ChatComposerKeys, isPrivateMode: Boolean, onPick: (String) -> Unit) {
    if (!model.visible) return
    val total = model.itemIds.size
    val countText = conclavePlural("chat_suggestions", total, total)
    val rowHeight = 48.dp
    val listState = rememberLazyListState()
    val scheme = MaterialTheme.colorScheme

    LaunchedEffect(model.highlight) {
        val index = model.itemIds.indexOf(model.highlight)
        val visible = listState.layoutInfo.visibleItemsInfo
        if (index < 0 || visible.isEmpty()) return@LaunchedEffect
        val first = visible.first().index
        val last = visible.last().index
        if (index <= first) {
            listState.scrollToItem(index)
        } else if (index >= last) {
            listState.scrollToItem(maxOf(0, index - (last - first) + 1))
        }
    }
    val moveText = chatSuggestionAnnouncement(model, keys.announcedId, isPrivateMode)
    Surface(
        color = scheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.medium,
        tonalElevation = 0.dp,
        modifier = Modifier.fillMaxWidth().heightIn(max = rowHeight * ChatComposerPolicy.suggestionVisibleRows.toFloat() + 8.dp),
    ) {
        Box {
            LazyColumn(state = listState, contentPadding = PaddingValues(4.dp)) {
                items(model.mentions, key = { "m:" + it.id }) { option ->
                    val itemId = ChatComposerPolicy.mentionItemId(option.id)
                    val dimmed = option.isAssistant && isPrivateMode
                    val highlighted = itemId == model.highlight
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = rowHeight)
                            .then(if (highlighted) Modifier.background(scheme.surfaceContainerHighest, MaterialTheme.shapes.small) else Modifier)
                            .alpha(if (dimmed) 0.38f else 1f)
                            .clip(MaterialTheme.shapes.small)
                            .clickable(enabled = !dimmed) { onPick(model.insertText(itemId)) }
                            .then(if (highlighted) Modifier.semantics { selected = true } else Modifier)
                            .padding(horizontal = 12.dp).testTag("chat.suggestion.${option.id}"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (option.isAssistant) {
                            Icon(ConclaveIcons.AutoAwesomeFill0, contentDescription = null, tint = scheme.primary,
                                modifier = Modifier.size(24.dp))
                        } else {
                            ConclaveAvatar(option.name, option.id, ConclaveAvatarSize.mention)
                        }
                        Column(Modifier.weight(1f)) {
                            ConclaveText(chatMentionTitle(option), line = "chat.suggestion.${option.id}.title",
                                style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            ConclaveText(chatMentionDetail(option, dimmed), line = "chat.suggestion.${option.id}.detail",
                                style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 2,
                                overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                items(model.commands, key = { "c:" + it.id }) { row ->
                    val itemId = ChatComposerPolicy.commandItemId(row.id)
                    val highlighted = itemId == model.highlight
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = rowHeight)
                            .then(if (highlighted) Modifier.background(scheme.surfaceContainerHighest, MaterialTheme.shapes.small) else Modifier)
                            .alpha(if (row.isAvailable) 1f else 0.38f)
                            .clip(MaterialTheme.shapes.small)
                            .clickable(enabled = row.isAvailable) { onPick(model.insertText(itemId)) }
                            .then(if (highlighted) Modifier.semantics { selected = true } else Modifier)
                            .padding(horizontal = 12.dp).testTag("chat.suggestion.${row.id}"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        ConclaveText(row.usage, line = "chat.suggestion.${row.id}.usage", style = MaterialTheme.typography.bodyLarge)
                        ConclaveText(chatCommandDetail(row), line = "chat.suggestion.${row.id}.detail", style = MaterialTheme.typography.bodySmall,
                            color = scheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f))
                    }
                }
            }

            Box(Modifier.size(1.dp).semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = countText
            })

            Box(Modifier.size(1.dp).testTag("chat.suggestions.move").semantics {
                liveRegion = LiveRegionMode.Polite
                if (moveText.isNotEmpty()) contentDescription = moveText
            })
        }
    }
}

@Composable
private fun chatMentionTitle(option: ChatMentionOption): String = when {
    option.isYou -> conclaveString("chat_mention_you", option.name)
    option.isAssistant -> conclaveString("chat_mention_assistant")
    else -> option.name
}

@Composable
private fun chatMentionDetail(option: ChatMentionOption, dimmed: Boolean): String = when {
    option.isAssistant && dimmed -> conclaveString("chat_reason_assistant_public")
    option.isAssistant -> conclaveString("chat_mention_assistant_hint")
    else -> "@" + option.token
}

@Composable
private fun chatCommandDetail(row: ChatCommandRow): String =
    if (row.isAvailable) ChatCopyAndroid.commandDescription(row.id) else ChatCopyAndroid.commandReason(row.reason)

@Composable
private fun chatSuggestionAnnouncement(model: ChatSuggestionsModel, itemId: String, isPrivateMode: Boolean): String {
    if (itemId.isEmpty()) return ""
    for (option in model.mentions) {
        if (ChatComposerPolicy.mentionItemId(option.id) == itemId) {
            return chatMentionTitle(option) + ", " + chatMentionDetail(option, option.isAssistant && isPrivateMode)
        }
    }
    for (row in model.commands) {
        if (ChatComposerPolicy.commandItemId(row.id) == itemId) return row.usage + ", " + chatCommandDetail(row)
    }
    return ""
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChatAttachMenuButton(
    presenter: ChatPresenter, composer: ChatComposerSnapshot, isFieldFocused: () -> Boolean,
    restoreFocus: (ChatFocusCapture) -> Unit, onPhoto: (ChatFocusCapture) -> Unit, onGifs: (ChatFocusCapture) -> Unit,
) {

    val imeVisible = WindowInsets.isImeVisible
    var expanded by remember { mutableStateOf(false) }
    var capture by remember { mutableStateOf(ChatFocusCapture.none) }
    val context = LocalContext.current
    Box {
        IconButton(
            onClick = {
                capture = ChatFocusCapture.capture(isFieldFocused(), imeVisible, chatTouchExplorationOn(context))
                expanded = true
            },
            enabled = composer.gate == ChatSendGate.allowed,
            modifier = Modifier.testTag("chat.composer.attach"),
        ) {
            Icon(ConclaveIcons.AddFill0, contentDescription = conclaveString("chat_attach"))
        }
        ConclaveDropdownMenu(
            expanded = expanded,
            onDismissRequest = {
                expanded = false
                if (capture.menuFocusable) restoreFocus(capture)
            },
            identifier = "chat.composer.attach.menu",
            properties = if (capture.menuFocusable) PopupProperties(focusable = true) else PopupProperties(focusable = false),
        ) {
            for (kind in composer.attachKinds) {
                if (kind == VoiceMessagePolicy.attachKind) {
                    ChatVoiceAttachMenuItem(presenter, composer, onDismiss = {
                        expanded = false
                        if (capture.menuFocusable) restoreFocus(capture)
                    })
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
                ConclaveMenuItem(
                    title = title,
                    identifier = "chat.composer.attach.$kind",
                    onClick = {
                        expanded = false
                        if (kind == "photo") onPhoto(capture) else onGifs(capture)
                    },
                    leadingIcon = if (kind == "gif") ConclaveIcons.GifBoxFill0 else ConclaveIcons.ImageFill0,
                    supporting = if (reasonText.isEmpty()) null else reasonText,
                    enabled = reason.isEmpty() && !busy,
                )
            }
        }
        BackHandler(enabled = expanded && !capture.menuFocusable) { expanded = false }
    }
}

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
