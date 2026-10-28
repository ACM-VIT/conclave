package conclave.module

import android.content.Context
import android.os.Build
import android.view.accessibility.AccessibilityManager
import androidx.annotation.RequiresApi
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/*
 * S40 8 d (CHT-8; R40-8, RECONCILE R1, R3; F00 C13 d chat variant): the chat preview on the stage toast lane. The lane
 * composes this host beside the F00 C13 host (HD request B6-T5 R2): this one shows stage.toast only while it is a
 * chatPreview, the other host every other kind, and the presenter shows one toast at a time, so at most one snackbar is
 * visible (each host's SnackbarHostState queue stays empty, AND 7.10). The dark stage-lane slot: in-call
 * surfaceContainerHigh #232327 with onSurface content, a 1 dp extended border (the fill alone is 1.264:1 against the
 * stage) and the "View" action in the in-call primary #FF7D66, never capitals. The stock SnackbarHost has no swipe, so the
 * preview wraps its own SwipeToDismissBox (both directions). The whole surface opens Chat at the newest message; View
 * does the same. Display time: 4 s through the system's recommended timeout (counting the action as a control),
 * restarted when the preview updates in place. No sound, no haptic (S20 10 h).
 */

/** A plain holder written during composition, so the preview keeps drawing while the host's exit motion runs. */
private class RetainedChatPreview {
    var notice: MeetingNotice? = null
}

/** The chat variant's host: reads stage.toast only and hands the id back through dismissNotice when the preview leaves. */
@Composable
internal fun ChatPreviewSnackbarHost(stage: StagePresenter, modifier: Modifier = Modifier) {
    val current = stage.toast
    val preview = if (ChatPreviewPolicy.isChatPreview(current)) current else null
    val hostState = remember { SnackbarHostState() }
    val retained = remember { RetainedChatPreview() }
    if (preview != null) retained.notice = preview
    val displayed = rememberUpdatedState(retained.notice)
    val shownId by rememberUpdatedState(preview?.id)
    val context = LocalContext.current
    // One showSnackbar per preview id, Indefinite because this host times it below; never a second while one shows.
    LaunchedEffect(preview?.id) {
        val shown = preview
        if (shown == null) {
            hostState.currentSnackbarData?.dismiss()
            return@LaunchedEffect
        }
        hostState.showSnackbar(message = shown.name, actionLabel = null, withDismissAction = false,
            duration = SnackbarDuration.Indefinite)
        // Returns only for the host's own accessibility dismiss action; the timer, the swipe and the taps already went
        // through the presenter (and a new preview id cancels this effect instead).
        if (shownId == shown.id) stage.dismissNotice(id = shown.id)
    }
    // S40 8 m: 4 s, stretched by the accessibility timeout, and started again when the preview updates in place.
    LaunchedEffect(preview?.id, preview?.count) {
        val shown = preview ?: return@LaunchedEffect
        delay(chatPreviewTimeoutMillis(context))
        stage.dismissNotice(id = shown.id)
    }
    SnackbarHost(hostState, modifier.testTag("chat.preview.host")) { _ ->
        val shown = displayed.value
        if (shown != null) {
            ChatPreviewSnackbar(
                notice = shown,
                onOpen = { stage.performNoticeAction(noticeId = shown.id, actionId = NoticeAction.view) },
                onDismiss = { stage.dismissNotice(id = shown.id) },
            )
        }
    }
}

/** One preview: the 24 dp avatar row with the title, the two-line body and the count line, plus the View action. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatPreviewSnackbar(notice: MeetingNotice, onOpen: () -> Unit, onDismiss: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val shape = MaterialTheme.shapes.small
    val title = chatPreviewTitle(notice)
    val body = chatPreviewBody(notice)
    val countLine = if (ChatPreviewPolicy.showsCountLine(notice)) conclavePlural("chat_preview_new_count", notice.count, notice.count) else ""
    val label = chatPreviewLabel(notice)
    val openLabel = conclaveString("chat_preview_open")
    val dismissLabel = conclaveString("chat_preview_dismiss", title)
    val viewTitle = conclaveString("ds_view")
    val swipe = rememberSwipeToDismissBoxState(initialValue = SwipeToDismissBoxValue.Settled,
        positionalThreshold = { distance -> distance * 0.4f })
    SwipeToDismissBox(
        state = swipe,
        backgroundContent = {},
        enableDismissFromStartToEnd = true,
        enableDismissFromEndToStart = true,
        onDismiss = { _ -> onDismiss() },
    ) {
        Snackbar(
            modifier = Modifier
                .testTag("chat.preview.toast")
                .border(1.dp, ext.border, shape)
                .clickable(onClickLabel = openLabel) { onOpen() }
                .semantics {
                    customActions = listOf(CustomAccessibilityAction(dismissLabel) {
                        onDismiss()
                        true
                    })
                },
            action = {
                TextButton(onClick = onOpen, modifier = Modifier.testTag("chat.preview.view")) {
                    ConclaveText(viewTitle, line = "chat.preview.view", color = scheme.primary)
                }
            },
            shape = shape,
            containerColor = scheme.surfaceContainerHigh,
            contentColor = scheme.onSurface,
            actionContentColor = scheme.primary,
        ) {
            Row(
                Modifier.clearAndSetSemantics { contentDescription = label },
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.Top,
            ) {
                // The assistant's mark is the avatar of its identity until the assistant glyph lands (R40-5, CL4).
                ConclaveAvatar(notice.name, if (notice.userId.isEmpty()) null else notice.userId, ConclaveAvatarSize.mention)
                Column {
                    ChatPreviewTitleRow(title, notice.isPrivate)
                    if (body.isNotEmpty()) {
                        ConclaveText(body, line = "chat.preview.body", style = MaterialTheme.typography.bodyMedium,
                            color = scheme.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    if (countLine.isNotEmpty()) {
                        ConclaveText(countLine, line = "chat.preview.count", style = MaterialTheme.typography.bodySmall,
                            color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

/** The title row: the name (or the grouping) and, for a private message, the lock glyph with "Private" (S40 8 b). */
@Composable
private fun ChatPreviewTitleRow(title: String, isPrivate: Boolean) {
    val scheme = MaterialTheme.colorScheme
    val separator = "·"
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (isPrivate) {
            Icon(ConclaveIcons.LockFill1, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
        }
        ConclaveText(title, line = "chat.preview.title", modifier = Modifier.weight(1f, fill = false),
            style = MaterialTheme.typography.titleSmall, color = scheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (isPrivate) {
            ConclaveText(separator + " " + conclaveString("chat_preview_private"), line = "chat.preview.private",
                style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 1)
        }
    }
}

/** One sender: the name; several: "Avery Lee and 2 others" (F00 ds_name_and_others, people other than the newest). */
@Composable
internal fun chatPreviewTitle(notice: MeetingNotice): String {
    val others = ChatPreviewPolicy.othersCount(notice)
    return if (others > 0) conclavePlural("ds_name_and_others", others, notice.name, others) else notice.name
}

/** The body from the presenter's kind and payload (S40 8 g; never a file name). */
@Composable
internal fun chatPreviewBody(notice: MeetingNotice): String {
    val text = notice.detail
    return when (ChatPreviewPolicy.bodyKind(notice)) {
        ChatPreviewBodyKind.photo -> if (text.isEmpty()) conclaveString("chat_preview_photo") else conclaveString("chat_preview_photo_caption", text)
        ChatPreviewBodyKind.gif -> if (text.isEmpty()) conclaveString("chat_reply_gif") else conclaveString("chat_preview_gif", text)
        ChatPreviewBodyKind.sticker -> if (text.isEmpty()) conclaveString("chat_sticker") else conclaveString("chat_preview_sticker", text)
        ChatPreviewBodyKind.clip -> if (text.isEmpty()) conclaveString("chat_clip") else conclaveString("chat_preview_clip", text)
        ChatPreviewBodyKind.voice -> if (text.isEmpty()) conclaveString("chat_ax_voice") else conclaveString("chat_preview_voice", text)
        else -> text
    }
}

/** "Message from Avery Lee: Can you share the deck?", then the private tag and the count line. */
@Composable
internal fun chatPreviewLabel(notice: MeetingNotice): String {
    val parts = mutableListOf(conclaveString("chat_preview_label", chatPreviewTitle(notice), chatPreviewBody(notice)))
    if (notice.isPrivate) parts.add(conclaveString("chat_preview_private"))
    if (ChatPreviewPolicy.showsCountLine(notice)) parts.add(conclavePlural("chat_preview_new_count", notice.count, notice.count))
    return parts.joinToString(", ")
}

/**
 * The display time in milliseconds: the shared 4 s (S20 10 f) through AccessibilityManager.getRecommendedTimeoutMillis
 * on API 29+ with text, icons and controls (the View action), so "Time to take action" stretches it; 4 s on API 28.
 */
internal fun chatPreviewTimeoutMillis(context: Context): Long {
    val base = ChatPreviewPolicy.displayMillis(isScreenReaderRunning = false).toInt()
    if (Build.VERSION.SDK_INT < 29) return base.toLong()
    val manager = context.getSystemService(AccessibilityManager::class.java) ?: return base.toLong()
    return ChatPreviewTimeoutApi29.timeout(manager, base).toLong()
}

/** Version-gated call in its own class, so API 28 never loads it. */
@RequiresApi(29)
private object ChatPreviewTimeoutApi29 {
    fun timeout(manager: AccessibilityManager, base: Int): Int = manager.getRecommendedTimeoutMillis(base,
        AccessibilityManager.FLAG_CONTENT_TEXT or AccessibilityManager.FLAG_CONTENT_ICONS or AccessibilityManager.FLAG_CONTENT_CONTROLS)
}
