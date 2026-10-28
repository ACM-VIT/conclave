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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
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

/*
 * S40 6 d (CHT-2): the composer on Android, in the InCallPage composer slot (the page applies imePadding and the
 * horizontal margin). The FND-3 composer column and field (always opaque on Android: surfaceContainerHighest, no
 * indicator, radius 20, IME action Send, hardware Enter sends and Shift+Enter inserts a newline, Q13). Keystrokes stay
 * in Compose state; the draft is written to ChatDraftStore after 500 ms idle and on dispose (R40-7). Every send goes
 * through `presenter.send` (ChatComposerPolicy.route, D24); no send, command, attach or recipient haptic (Q11). CHT-4
 * and CHT-5: the attach control (an IconButton opening a DropdownMenu of Photo and GIFs and stickers; an item
 * unavailable in the mode stays, disabled, with its reason), the system Photo Picker (no storage permission; the
 * backport module entry in AndroidManifest.xml covers API 28 and 29) whose URI is copied into a cache file on
 * Dispatchers.IO before the presenter gets it (CH6), the attachment chip and the link preview above the field.
 *
 * T3 borrow (R/t3-borrow/PLAN.md, patterns only, written fresh): P1 hardware keys for the suggestion list (Up and Down
 * move a flat highlight with wrap-around, skipping dimmed rows; Enter and Tab insert; a row whose insert text equals
 * the draft sends; Escape hides the list for this trigger and, with the list hidden, falls through to Back), only
 * while a hardware keyboard is attached, so touch and the IME Send key never change (Q13); P2 a held Enter sends once;
 * P3 composer menus decide at open time whether to take popup focus, so the IME stays up, and the field gets focus
 * back after the picker or the GIF sheet only when it had it and TalkBack is off (AX12); P4 the draft is a
 * TextFieldState, so the one content receiver on the composer column takes keyboard images (Gboard stickers and
 * GIFs), clipboard images and drops on the whole composer (its built-in drop node requests the drag permissions); a
 * text paste and its undo stay native; P6 the Send reason comes from ChatComposerPolicy.sendBlock; P7 the gate line
 * reads the delayed `composer.gateLine`; P8 a focus gain tells the timeline; P9 the counter announces its bands.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ChatComposer(presenter: ChatPresenter, actions: ChatRowActions) {
    val composer = presenter.composer
    ChatDiagnostics.counters?.bump("chat.recompose.composer")
    val draftState = rememberTextFieldState()
    var loadedKey by remember { mutableStateOf("") }
    var hasLoaded by remember { mutableStateOf(false) }
    // CHT-5: the composer preview the person removed; the next send carries suppressEmbeds (6 d).
    var dismissedPreviewUrl by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val keys = remember { ChatComposerKeys() }
    val focusMemory = remember { ChatComposerFocusMemory() }
    // P4: a keyboard, clipboard or drop image still being copied; every other intake is refused meanwhile.
    var photoIntakeInFlight by remember { mutableStateOf(false) }
    // P6: a blocked hardware Enter or IME Send (gate or photo); each press is spoken once (ChatBlockedSendAnnouncer).
    var blockedPress by remember { mutableIntStateOf(0) }
    var blockedBlock by remember { mutableStateOf(ChatSendBlock.none) }
    // P1: hardware keyboard only. The activity handles keyboard configuration changes, so this updates live.
    val hardware = LocalConfiguration.current.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO
    // P3: focus comes back only when the field had it and TalkBack is off (AX12); the IME only when it was up.
    val restoreFocus: (ChatFocusCapture) -> Unit = { capture ->
        if (ChatComposerPolicy.restoresComposerFocus(capture.wasFocused, chatTouchExplorationOn(context))) {
            runCatching { focus.requestFocus() }
            if (capture.imeWasVisible) keyboard?.show()
        }
    }
    // CH6: the Photo Picker's URI becomes a cache file off the main thread; cancelling changes nothing.
    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            scope.launch {
                val file = ChatPhotoFiles.copyToCache(context, uri) { presenter.rejectPhoto(ChatFailure.photoTooLarge) }
                if (file != null) presenter.attachPhoto(file.fileUrl, file.mimeType, file.fileName)
            }
        }
        // P3: back from the picker (pick or cancel).
        focusMemory.takePicker()?.let { restoreFocus(it) }
    }
    // R40-7: a recipient switch saves the text under the old key and loads the new key's draft; when the new key has
    // none, the text you were writing moves with you.
    LaunchedEffect(composer.draftKey) {
        chatSwitchDraft(draftState, presenter.drafts, loadedKey, hasLoaded, composer.draftKey)
        loadedKey = composer.draftKey
        hasLoaded = true
    }
    // Every edit (typed, pasted, inserted or loaded) clears the blocked-send notice and keeps the suggestion state in
    // step; the draft store write waits for 500 ms idle (the collector restarts on each edit), never per keystroke.
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
    // P3: the GIF picker closed (pick or dismissal). The capture is kept on the actions, not here: the side pane's
    // in-pane GIF page removes this composer, so the composer composed after it (this effect's first run) takes it.
    LaunchedEffect(actions.showsGifs) {
        if (!actions.showsGifs) actions.takeGifsFocusCapture()?.let { restoreFocus(it) }
    }
    DisposableEffect(presenter) {
        onDispose { presenter.drafts.setText(draftState.text.toString(), loadedKey) }
    }
    // P4: keyboard images (IME commit content), clipboard images and drops on the whole composer. Image items with a
    // URI are copied at once (the grant lasts only so long) and handed over as a file; text and every other item go
    // back untouched, so a text paste and its undo stay native. Refused while a photo exists or a copy is running.
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
                        // One photo per message: the rest of a multi-image clip is dropped and the notice says why.
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
    // The send reads the state at the moment of the press, never a value from the last composition.
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
    // P6: a hardware Enter, or an IME Send while Send is disabled (the field's onSendBlocked). A gate or photo block
    // (refused silently by the presenter) posts its reason once per press; route and limit blocks announce their own
    // notice; an empty draft posts nothing.
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
    // The InCallPage composer slot already pads 16 by 8, so the column adds no padding of its own.
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
        // P7: the line follows the delayed gate (shown after 400 ms closed, held at least 400 ms); Send and its reason
        // follow the real gate at once.
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
                // On the TextField itself, not the row: with a hardware keyboard a focus request on the row lands on the
                // attach button first, and the row's hasFocus would also count the attach button (P3, P8).
                fieldModifier = Modifier.focusRequester(focus).onFocusChanged { state ->
                    val now = state.hasFocus
                    // P8 (S40 2 d): the timeline follows a focus gain only when the newest row is visible.
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
                            // S70 8 d (SYS-8, HD/requests/B5-T4.md R17 e): the picker activity must not tear the call
                            // into PiP; auto-enter comes back if the launch fails.
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

/**
 * P6: a blocked press (hardware Enter or IME Send, gate or photo) speaks its reason once, with the text composed right
 * after the press; never on a keystroke, and a recreated composer (press 0) speaks nothing. Posted through
 * View.announceForAccessibility, as AppPageAnnouncer does: a fresh polite node per press would be new to Compose's
 * accessibility delegate, which reports live region changes only for nodes already in its previous semantics
 * snapshot, and one kept node could not repeat the same reason on the next press. Emits no layout node.
 */
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

/**
 * R40-7 on the TextFieldState: a recipient switch saves the current text under the old key and loads the new key's
 * draft; when the new key has none, the text being written moves along (the old key is cleared). The first load just
 * places the stored draft.
 */
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

/** A focus request's text ("@Conclave " from the empty state): appended after a space, the caret at the end. */
internal fun chatAppendInsert(state: TextFieldState, insert: String) {
    if (insert.isEmpty()) return
    val current = state.text.toString()
    state.setTextAndPlaceCursorAtEnd(if (current.isEmpty()) insert else "$current $insert")
}

/**
 * P4: the image URIs of a received clip (a keyboard image, a clipboard paste or a drop): every item with a URI when
 * the clip says it holds images; text items never count. Pure, for the host tests.
 */
internal fun chatImageUris(clipData: ClipData): List<Uri> {
    if (!clipData.description.hasMimeType("image/*")) return emptyList()
    val result = mutableListOf<Uri>()
    for (index in 0 until clipData.itemCount) {
        val uri = clipData.getItemAt(index).uri
        if (uri != null) result.add(uri)
    }
    return result
}

/**
 * P6: the string resource behind each Send reason. "" for none and attendee (the composer is absent) and for
 * photoFailed, which reuses the chip's status line; overLimit names the F00 counter plurals.
 */
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

/** P6 (S40 6 i, AX2): the disabled Send's state description and the blocked-Enter announcement. */
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

/** TalkBack touch exploration, read at the moment a menu or picker opens or closes (never observed). */
private fun chatTouchExplorationOn(context: Context): Boolean =
    context.getSystemService(AccessibilityManager::class.java)?.isTouchExplorationEnabled == true

/**
 * P3: the field's focus and the IME at the moment a menu or picker opened, and whether the menu takes popup focus
 * (decided then, ChatComposerPolicy.composerMenuIsFocusable, and held until it closes).
 */
internal data class ChatFocusCapture(val wasFocused: Boolean, val imeWasVisible: Boolean, val menuFocusable: Boolean) {
    companion object {
        val none = ChatFocusCapture(wasFocused = false, imeWasVisible = false, menuFocusable = true)

        fun capture(wasFocused: Boolean, imeVisible: Boolean, touchExploration: Boolean): ChatFocusCapture =
            ChatFocusCapture(wasFocused, imeVisible, ChatComposerPolicy.composerMenuIsFocusable(imeVisible, touchExploration))
    }
}

/**
 * P3, P8: plain fields (never Compose state): the field's focus and the capture waiting for the Photo Picker to return.
 * The GIF picker's capture lives on ChatRowActions (gifsFocusCapture), because the side pane's GIF page removes the
 * composer from the composition.
 */
internal class ChatComposerFocusMemory {
    var fieldFocused = false
    var picker: ChatFocusCapture? = null

    fun takePicker(): ChatFocusCapture? {
        val capture = picker
        picker = null
        return capture
    }
}

/**
 * P1: the suggestion list as the person sees it, derived once per composition from the draft (pure): the trigger,
 * the matching rows, whether the list shows (not empty, not dismissed by Escape) and the effective highlight ("" on
 * touch, while hidden or with no available row).
 */
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

    /** A tap on a row inserts the same text as Enter and Tab. */
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

/**
 * P1 and P2 (hardware keyboard only): the suggestion highlight (a row id plus the query it belongs to), the
 * per-trigger Escape dismissal and the key decisions. One per composer; its fields are Compose state read by the list.
 * The composer field calls [onKey] first for every key event (ConclaveComposerField's onHardwareKey).
 */
internal class ChatComposerKeys {
    var highlightedId by mutableStateOf("")
        private set
    var highlightQuery by mutableStateOf("")
        private set
    var dismissedKey by mutableStateOf("")
        private set
    /** The row the last arrow move landed on; only arrow moves change it, so the polite node speaks only then. */
    var announcedId by mutableStateOf("")
        private set
    private val consumedDowns = mutableSetOf<Key>()

    fun isDismissed(trigger: ChatSuggestionTrigger): Boolean = ChatComposerPolicy.isDismissed(trigger, dismissedKey)

    fun effectiveHighlight(items: skip.lib.Array<ChatSuggestionItem>, queryKey: String, hardware: Boolean, visible: Boolean): String =
        if (hardware && visible) ChatComposerPolicy.resolvedHighlight(highlightedId, items, highlightQuery, queryKey) else ""

    /**
     * After every draft change: the Escape dismissal stays only for the same trigger (deleting "@" and typing it
     * again shows the list), and a highlight from another query is dropped.
     */
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

    /**
     * True when the event is consumed. Nothing is consumed without a hardware keyboard, so touch input and the IME
     * Send key behave exactly as before. A consumed press also consumes its release, so the system's Escape-to-Back
     * fallback (or a Tab focus move) never acts on a key the list used; with the list hidden Escape is not consumed
     * and falls back to Back, which closes the panel (S40 6 d).
     */
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
            // A held Tab or Escape only swallows its repeats (it never inserts again or moves focus).
            Key.Tab -> if (isRepeat) consumedDowns.contains(key) else !event.isShiftPressed && insert(model, onInsert)
            Key.Escape -> if (isRepeat) consumedDowns.contains(key) else dismiss(model)
            Key.Enter, Key.NumPadEnter -> enter(event.isShiftPressed, isRepeat, draft, model, onInsert, onSend)
            else -> false
        }
        if (handled) consumedDowns.add(key) else consumedDowns.remove(key)
        return handled
    }

    /** Enter in the order ChatComposerPolicy.returnKeyAction gives; an auto-repeat (repeatCount > 0) returns true
     *  without sending, so a held Enter never fills the cleared field with newlines. */
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

/**
 * 6 d recipient chip and the implicit private line: an AssistChip "To: everyone" opens a DropdownMenu of everyone and
 * the people you can message privately; "Will be sent privately to %1$s" reads the shared implicit-target rule. P3:
 * while the IME was up and TalkBack is off when the chip is pressed, the menu does not take popup focus, so the IME
 * stays up and the draft keeps its caret; Back then reaches the BackHandler below (after the system's first Back hid
 * the IME). With a hardware keyboard and no IME, or under TalkBack, the menu stays focusable.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChatComposerModeRow(
    presenter: ChatPresenter, composer: ChatComposerSnapshot, draft: String, isFieldFocused: () -> Boolean,
    restoreFocus: (ChatFocusCapture) -> Unit,
) {
    // Read in this small leaf (the IME toggling recomposes only it) and captured when the chip is pressed.
    val imeVisible = WindowInsets.isImeVisible
    var expanded by remember { mutableStateOf(false) }
    var capture by remember { mutableStateOf(ChatFocusCapture.none) }
    val context = LocalContext.current
    if (composer.privateEnabled && composer.recipients.count > 0) {
        val recipient = composer.privateTo
        // A focusable menu took focus from the field: give it back after a pick or a dismissal.
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
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = close,
                properties = if (capture.menuFocusable) PopupProperties(focusable = true) else PopupProperties(focusable = false),
            ) {
                NativeSemanticsPopupRoot("chat.composer.recipients")
                DropdownMenuItem(
                    text = { ConclaveText(conclaveString("chat_everyone"), line = "chat.recipient.everyone") },
                    onClick = {
                        presenter.setPrivateTo("")
                        close()
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
                            close()
                        },
                        modifier = Modifier.testTag("chat.recipient.${person.userId}"),
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

/**
 * 6 d suggestions: commands for a bare `/word`, mentions for a trailing `@word` (a mention wins), in a flat surface
 * above the field, 4.5 rows then scrolling; unavailable rows dimmed with their reason; a polite count announcement.
 * P1: with a hardware keyboard one row carries the flat surfaceContainerHighest highlight (never the primary color)
 * and the selected state; each arrow move is spoken once from a hidden polite node. Rows appear without animation.
 */
@Composable
private fun ChatSuggestionList(model: ChatSuggestionsModel, keys: ChatComposerKeys, isPrivateMode: Boolean, onPick: (String) -> Unit) {
    if (!model.visible) return
    val total = model.itemIds.size
    val countText = conclavePlural("chat_suggestions", total, total)
    val rowHeight = 48.dp
    val listState = rememberLazyListState()
    val scheme = MaterialTheme.colorScheme
    // Keeps the highlighted row on screen past the 4.5 visible rows (an instant scroll, 6 h).
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
            // 6 i: the count is spoken from a hidden polite node, never from the rows (inside the surface, so the
            // column spacing never moves the field).
            Box(Modifier.size(1.dp).semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = countText
            })
            // P1: the arrow-move text; it changes only when an arrow move lands on another row. The node is composed with
            // the list and has no text until the first move, so every move changes the text of a node TalkBack already
            // knows (a polite node that appears with its text is not reported).
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

/** P1: the highlighted row's title and second line after an arrow move ("" before any move). */
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

/**
 * 6 d attach control: an IconButton opening a DropdownMenu. Items unavailable in the current mode stay in the menu,
 * disabled, with the reason as a second line (private mode is text only; photos follow the host switch). P3: the
 * menu's popup focus is decided when it opens (as for the recipient chip); the picker and the GIF sheet take the
 * capture along, so focus comes back when they close.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChatAttachMenuButton(
    presenter: ChatPresenter, composer: ChatComposerSnapshot, isFieldFocused: () -> Boolean,
    restoreFocus: (ChatFocusCapture) -> Unit, onPhoto: (ChatFocusCapture) -> Unit, onGifs: (ChatFocusCapture) -> Unit,
) {
    // Read in this small leaf (the IME toggling recomposes only it) and captured when the button is pressed.
    val imeVisible = WindowInsets.isImeVisible
    var expanded by remember { mutableStateOf(false) }
    var capture by remember { mutableStateOf(ChatFocusCapture.none) }
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
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
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = {
                expanded = false
                if (capture.menuFocusable) restoreFocus(capture)
            },
            properties = if (capture.menuFocusable) PopupProperties(focusable = true) else PopupProperties(focusable = false),
        ) {
            NativeSemanticsPopupRoot("chat.composer.attach.menu")
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
                        if (kind == "photo") onPhoto(capture) else onGifs(capture)
                    },
                    modifier = Modifier.testTag("chat.composer.attach.$kind"),
                )
            }
        }
        BackHandler(enabled = expanded && !capture.menuFocusable) { expanded = false }
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
