package conclave.module

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.text.format.DateFormat
import android.text.format.DateUtils
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import java.util.Date
import skip.ui.UIApplication

internal class ChatTimelineCache(private val presenter: ChatPresenter) {
    internal class Reversed(val revision: Int, val ids: List<String>, val kinds: List<ChatRowKind>, val snapshot: ChatTimelineSnapshot)

    private var cached: Reversed? = null

    fun current(): Reversed {
        val timeline = presenter.timeline
        val existing = cached
        if (existing != null && existing.revision == timeline.revision && existing.snapshot.focusRequest == timeline.focusRequest) {
            return existing
        }
        val ids = timeline.rowIds.toList().asReversed().toList()
        val kinds = timeline.rowKinds.toList().asReversed().toList()
        val next = Reversed(timeline.revision, ids, kinds, timeline)
        cached = next
        return next
    }
}

internal class ChatRowActions(val presenter: ChatPresenter, private val context: Context) {

    var menuRowId by mutableStateOf("")

    var viewerRowId by mutableStateOf("")

    var focusRequest by mutableStateOf(0)

    var composerFocusRevision by mutableIntStateOf(0)
        private set

    var pendingInsert = ""

    var pendingExternalUrl by mutableStateOf("")
    var pendingExternalIsWeb = false

    var copiedRequest by mutableStateOf(0)

    var photoRowId by mutableStateOf("")

    var showsGifs by mutableStateOf(false)

    var gifsFocusCapture: ChatFocusCapture? = null

    var pendingAssistantUrl by mutableStateOf("")

    fun openMenu(rowId: String) { menuRowId = rowId }
    fun closeMenu() { menuRowId = "" }
    fun openViewer(rowId: String) { viewerRowId = rowId }
    fun closeViewer() { viewerRowId = "" }
    fun openPhoto(rowId: String) { photoRowId = rowId }
    fun closePhoto() { photoRowId = "" }
    fun openGifs() { showsGifs = true }
    fun closeGifs() { showsGifs = false }

    fun takeGifsFocusCapture(): ChatFocusCapture? {
        val capture = gifsFocusCapture
        gifsFocusCapture = null
        return capture
    }

    fun embed(url: String): ChatEmbedEntry = presenter.embeds.entry(url)

    fun focusComposer(insert: String = "") {
        pendingInsert = insert
        focusRequest += 1
    }

    fun composerDidFocus() {
        composerFocusRevision += 1
    }

    fun reply(rowId: String) {
        presenter.beginReply(rowId)
        focusComposer()
    }

    fun messagePrivately(userId: String) {
        presenter.setPrivateTo(userId)
        focusComposer()
    }

    fun copy(rowId: String) { writeClip(presenter.copyText(rowId)) }
    fun copyLink(rowId: String) { writeClip(presenter.linkText(rowId)) }
    fun toggle(rowId: String, emoji: String) { presenter.toggleReaction(rowId, emoji) }
    fun retry(rowId: String) { presenter.retry(rowId) }

    fun retryAssistant(rowId: String) { presenter.retryAssistant(rowId) }

    fun openAssistantLink(url: String) { pendingAssistantUrl = url }

    fun confirmAssistantLink() {
        val url = pendingAssistantUrl
        if (url.isEmpty()) return
        pendingAssistantUrl = ""
        val kind = NativeJoinLinkParser.classify(url)
        if (kind == NativeJoinLinkKind.meeting || kind == NativeJoinLinkKind.webinar) {
            ConclaveAppDelegate.shared.onOpenURL(url)
            return
        }
        val lower = url.lowercase()
        val isWeb = lower.startsWith("http://") || lower.startsWith("https://")
        if (isWeb && ChatLinkLauncher.openInCustomTab(context, url)) return
        NativeExternalHandoff.openExternalApp(url)
    }

    fun copyAssistantLink() {
        val url = pendingAssistantUrl
        pendingAssistantUrl = ""
        writeClip(url)
    }
    fun delete(rowId: String) { presenter.deleteFailed(rowId) }
    fun hideSender(userId: String) { presenter.hideSender(userId) }
    fun showSender(userId: String) { presenter.showSender(userId) }
    fun jumpToReply(messageId: String) { presenter.jumpTo(messageId) }

    fun openLink(url: String) {
        val kind = NativeJoinLinkParser.classify(url)
        if (kind == NativeJoinLinkKind.meeting || kind == NativeJoinLinkKind.webinar) {
            ConclaveAppDelegate.shared.onOpenURL(url)
            return
        }
        val lower = url.lowercase()
        val isWeb = lower.startsWith("http://") || lower.startsWith("https://")
        if (isWeb && ChatLinkLauncher.openInCustomTab(context, url)) return
        pendingExternalIsWeb = isWeb
        pendingExternalUrl = url
    }

    private fun writeClip(text: String) {
        if (text.isEmpty()) return
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        clipboard.setPrimaryClip(ClipData.newPlainText(conclaveStringOf(context, "chat_clip_label"), text))
        presenter.noteCopied()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) copiedRequest += 1
    }
}

internal object ChatLinkLauncher {
    fun openInCustomTab(context: Context, url: String): Boolean {
        val activity = UIApplication.shared.androidActivity ?: return false
        if (CustomTabsClient.getPackageName(context, null) == null) return false
        return try {
            PipManager.suppressNextAutoEnter("chat_link")
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, Uri.parse(url))
            true
        } catch (failure: Throwable) {
            PipManager.restoreAutoEnterAfterExternalActivity()
            false
        }
    }
}

internal object ChatCopyAndroid {
    @Composable
    fun failureReason(failure: ChatFailure): String = when (failure) {
        ChatFailure.tooLong -> conclaveString("chat_fail_too_long")
        ChatFailure.locked -> conclaveString("chat_fail_locked")
        ChatFailure.attendee -> conclaveString("chat_fail_attendee")
        ChatFailure.privateDisabled -> conclaveString("chat_fail_private_disabled")
        ChatFailure.privateTargetMissing -> conclaveString("chat_fail_private_missing")
        ChatFailure.privateTargetAmbiguous -> conclaveString("chat_fail_private_ambiguous")
        ChatFailure.privateSelf -> conclaveString("chat_fail_private_self")
        ChatFailure.privateTargetLeft -> conclaveString("chat_fail_private_left")
        ChatFailure.replyUnavailable -> conclaveString("chat_fail_reply_unavailable")
        ChatFailure.replyPrivateThread -> conclaveString("chat_fail_reply_private")
        ChatFailure.voiceDisabled -> conclaveString("chat_fail_voice_disabled")
        ChatFailure.voiceTooLong -> conclaveString("chat_fail_voice_too_long")
        ChatFailure.oneAttachment -> conclaveString("chat_fail_one_attachment")
        ChatFailure.rateLimited -> conclaveString("chat_fail_rate_limited")
        ChatFailure.assistantIsPublic -> conclaveString("chat_reason_assistant_public")
        ChatFailure.privateTextOnly -> conclaveString("chat_reason_private_text")
        ChatFailure.reactionFailed -> conclaveString("chat_reaction_failed")
        else -> ""
    }

    @Composable
    fun systemText(row: ChatRowModel): String = when (row.notice) {
        ChatNotice.cleared -> conclaveString("chat_cleared")
        ChatNotice.alreadyMuted -> conclaveString("chat_cmd_already_muted")
        ChatNotice.alreadyUnmuted -> conclaveString("chat_cmd_already_unmuted")
        ChatNotice.cameraAlreadyOn -> conclaveString("chat_cmd_camera_on")
        ChatNotice.cameraAlreadyOff -> conclaveString("chat_cmd_camera_off")
        ChatNotice.cameraUsage -> conclaveString("chat_cmd_camera_usage")
        ChatNotice.ttsUsage -> conclaveString("chat_cmd_tts_usage")
        ChatNotice.help -> conclaveString("chat_cmd_help")
        ChatNotice.reactionFailed -> conclaveString("chat_reaction_failed")
        ChatNotice.senderHidden -> conclaveString("chat_sender_hidden", row.noticeArgument)
        else -> row.plainText
    }

    @Composable
    fun announcement(announcement: ChatAnnouncement): String = when (announcement.kind) {
        "newMessage" -> conclaveString("chat_announce_message", announcement.name, announcement.text)
        "newMessages" -> conclavePlural("chat_announce_messages", announcement.count, announcement.count)

        "assistantAnswered" -> conclaveString("chat_ax_assistant_answered", announcement.text)
        else -> ""
    }

    @Composable
    fun emojiName(emoji: String): String = when (ChatReactionRules.nameKey(emoji)) {
        "thumbsUp" -> conclaveString("chat_emoji_thumbs_up")
        "clappingHands" -> conclaveString("chat_emoji_clapping")
        "laughing" -> conclaveString("chat_emoji_laughing")
        "heart" -> conclaveString("chat_emoji_heart")
        "party" -> conclaveString("chat_emoji_party")
        "surprised" -> conclaveString("chat_emoji_surprised")
        "sad" -> conclaveString("chat_emoji_sad")
        "thinking" -> conclaveString("chat_emoji_thinking")
        else -> emoji
    }

    @Composable
    fun chipLabel(chip: ChatReactionChip): String {
        val name = emojiName(chip.emoji)
        val you = conclaveString("chat_you")
        val names = chip.names.toList().map { if (it.isEmpty()) you else it }
        if (names.isEmpty()) return conclaveString("chat_reacted", name)
        val subject = if (chip.remaining > 0) {
            names.joinToString(", ") + " " + conclavePlural("chat_and_others", chip.remaining, chip.remaining)
        } else {
            names.joinToString(", ")
        }
        return conclaveString("chat_reacted_by", subject, name)
    }

    @Composable
    fun chipModels(row: ChatRowModel): List<ConclaveReactionChipModel> = row.reactions.toList().map { chip ->
        ConclaveReactionChipModel(id = chip.emoji, emoji = chip.emoji, count = chip.count, isMine = chip.isMine,
            canToggle = row.canReact, accessibilityLabel = chipLabel(chip))
    }

    @Composable
    fun commandDescription(commandId: String): String = when (commandId) {
        "help" -> conclaveString("chat_cmd_desc_help")
        "dm" -> conclaveString("chat_cmd_desc_dm")
        "tts" -> conclaveString("chat_cmd_desc_tts")
        "me" -> conclaveString("chat_cmd_desc_me")
        "action" -> conclaveString("chat_cmd_desc_action")
        "raise" -> conclaveString("chat_cmd_desc_raise")
        "lower" -> conclaveString("chat_cmd_desc_lower")
        "mute" -> conclaveString("chat_cmd_desc_mute")
        "unmute" -> conclaveString("chat_cmd_desc_unmute")
        "camera" -> conclaveString("chat_cmd_desc_camera")
        "leave" -> conclaveString("chat_cmd_desc_leave")
        "clear" -> conclaveString("chat_cmd_desc_clear")
        else -> ""
    }

    @Composable
    fun commandReason(reason: String): String = when (reason) {
        "privateDisabled" -> conclaveString("chat_reason_private_off")
        "voiceDisabled" -> conclaveString("chat_reason_voice_off")
        "privateTextOnly" -> conclaveString("chat_reason_private_text")
        else -> ""
    }

    @Composable
    fun gateLine(gate: ChatSendGate): String = when (gate) {
        ChatSendGate.reconnecting -> conclaveString("chat_gate_reconnecting")
        ChatSendGate.offline -> conclaveString("chat_gate_offline")
        ChatSendGate.notJoined -> conclaveString("chat_gate_not_joined")
        else -> ""
    }

    @Composable
    fun placeholder(composer: ChatComposerSnapshot): String {
        if (composer.gate == ChatSendGate.locked) return conclaveString("chat_placeholder_locked")
        VoiceCopyAndroid.placeholder(composer)?.let { return it }
        val recipient = composer.privateTo
        if (recipient != null) return conclaveString("chat_placeholder_private", recipient.name)
        return conclaveString("chat_placeholder")
    }

    @Composable
    fun replyTitle(reply: ChatReplyRef): String =
        if (reply.isAuthorYou) conclaveString("chat_replying_self") else conclaveString("chat_replying_to", reply.authorName)

    @Composable
    fun replyPreview(reply: ChatReplyRef): String = when {
        reply.preview.isNotEmpty() -> reply.preview
        reply.media == "gif" -> conclaveString("chat_reply_gif")
        reply.media == "photo" -> conclaveString("chat_reply_photo")
        else -> ""
    }

    @Composable
    fun senderName(row: ChatRowModel): String = if (row.isOwn) conclaveString("chat_you") else row.senderName

    fun time(context: Context, millis: Double): String = DateFormat.getTimeFormat(context).format(Date(millis.toLong()))

    fun day(context: Context, millis: Double): String {
        val time = millis.toLong()
        val now = System.currentTimeMillis()
        if (DateUtils.isToday(time) || DateUtils.isToday(time + DateUtils.DAY_IN_MILLIS)) {
            return DateUtils.getRelativeTimeSpanString(time, now, DateUtils.DAY_IN_MILLIS).toString()
        }
        return DateFormat.getLongDateFormat(context).format(Date(time))
    }

    @Composable
    fun rowLabel(row: ChatRowModel): String = conclaveString("chat_ax_row", senderName(row), row.plainText)

    @Composable
    fun rowValue(context: Context, row: ChatRowModel): String {
        val parts = mutableListOf<String>()
        if (row.privacy == ChatPrivacy.privateSent) parts.add(conclaveString("chat_private_to", row.privateName))
        if (row.privacy == ChatPrivacy.privateReceived) parts.add(conclaveString("chat_private_received"))
        val reply = row.reply
        if (reply != null) {
            val author = if (reply.isAuthorYou) conclaveString("chat_you") else reply.authorName
            parts.add(conclaveString("chat_ax_reply", author, replyPreview(reply)))
        }
        if (row.kind == ChatRowKind.photo) parts.add(conclaveString("chat_reply_photo"))
        if (row.kind == ChatRowKind.gif) parts.add(conclaveString("chat_reply_gif"))
        if (row.kind == ChatRowKind.voice) parts.add(VoiceCopyAndroid.accessibilityValue())
        var total = 0
        for (chip in row.reactions) total += chip.count
        if (total > 0) parts.add(conclavePlural("chat_ax_reactions", total, total))
        parts.add(time(context, row.timestampMillis))
        if (row.delivery == ChatDelivery.failed) parts.add(conclaveString("chat_ax_not_delivered"))
        if (row.delivery == ChatDelivery.sendingSlow) parts.add(conclaveString("chat_sending"))
        return parts.joinToString(", ")
    }
}
