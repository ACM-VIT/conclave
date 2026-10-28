package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.material3.Surface
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.Hyphens
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/*
 * S40 3 d (CHT-1, CHT-3 chips): message rows on Android. A row reads only its own ChatRowEntry, so a reaction or
 * delivery write recomposes one item. A long press on the row opens the message actions (no click semantics on the
 * row, so TalkBack offers no empty "Double tap to activate"); the summary node carries the label, the value parts,
 * the long-click label "Message actions" and the custom actions (3 i, 5 i). Every control (quote, chips, failed row)
 * is its own node. Bubbles are the C23 component; own public rows primaryContainer with onPrimaryContainer, every
 * private and peer row neutral (Q9). CHT-4 and CHT-5: photo rows show the Coil image in a fixed 240 by 180 dp box (the
 * viewer opens on tap, a failed load retries on tap), GIF rows animate through coil-gif (the first frame under Remove
 * animations; stickers without a bubble; clips as a poster with the play glyph, no inline player until Media3 is
 * approved, Q6), and ready link cards follow the reactions. Media-only rows carry the summary semantics on the media
 * element. Voice rows are CHT-6's; Conclave AI rows are AssistantRow (CHT-7, AssistantRow.kt).
 */
@Composable
internal fun ChatRow(entry: ChatRowEntry, actions: ChatRowActions, sidePane: Boolean, maxBubble: Dp, highlighted: Boolean) {
    val row = entry.row
    ChatDiagnostics.counters?.bump("chat.recompose." + row.id)
    val highlight = if (highlighted) {
        Modifier.background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(8.dp))
    } else Modifier
    Box(Modifier.fillMaxWidth().testTag("chat.row.${row.id}").then(highlight)
        .padding(top = chatRowTop(row), bottom = chatRowBottom(row))) {
        when (row.kind) {
            ChatRowKind.system -> ChatSystemRow(row, actions)
            ChatRowKind.action -> ChatActionRow(row, actions)
            ChatRowKind.daySeparator -> ChatDayRow(row)
            ChatRowKind.unreadDivider -> ChatUnreadDivider()
            ChatRowKind.assistant -> ChatSwipeToReply(row, actions) { AssistantRow(entry, actions, sidePane, maxBubble) }
            else -> ChatSwipeToReply(row, actions) { ChatMessageRow(row, actions, sidePane, maxBubble) }
        }
    }
}

private fun chatRowTop(row: ChatRowModel): Dp = when (row.kind) {
    ChatRowKind.system, ChatRowKind.action, ChatRowKind.daySeparator, ChatRowKind.unreadDivider -> 8.dp
    else -> if (row.isGroupStart) 12.dp else 2.dp
}

private fun chatRowBottom(row: ChatRowModel): Dp = when (row.kind) {
    ChatRowKind.system, ChatRowKind.action, ChatRowKind.daySeparator, ChatRowKind.unreadDivider -> 8.dp
    else -> 0.dp
}

/**
 * 5 d swipe to reply: SwipeToDismissBox start to end (RTL swaps automatically), threshold 35%, the threshold haptic
 * once per crossing; the row never dismisses (reset after the reply).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatSwipeToReply(row: ChatRowModel, actions: ChatRowActions, content: @Composable () -> Unit) {
    if (!row.canReply) {
        content()
        return
    }
    val haptics = rememberConclaveHaptics()
    val scope = rememberCoroutineScope()
    val state = rememberSwipeToDismissBoxState(initialValue = SwipeToDismissBoxValue.Settled, positionalThreshold = { distance -> distance * 0.35f })
    LaunchedEffect(state) {
        snapshotFlow { state.targetValue }.collect { value ->
            if (value == SwipeToDismissBoxValue.StartToEnd) haptics.gesture(FeedbackKind.swipeThresholdCrossed)
        }
    }
    SwipeToDismissBox(
        state = state,
        backgroundContent = {
            // Rows are transparent outside their bubbles. A settled swipe must not reveal a reply cue through
            // the avatar gutter; show the named action only while the row is moving towards Reply.
            if (state.dismissDirection == SwipeToDismissBoxValue.StartToEnd) {
                Box(Modifier.fillMaxSize().padding(start = 16.dp).clearAndSetSemantics { },
                    contentAlignment = Alignment.CenterStart) {
                    ConclaveText(conclaveString("chat_action_reply"), line = "chat.row.${row.id}.swipeReply",
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        enableDismissFromStartToEnd = true,
        enableDismissFromEndToStart = false,
        onDismiss = { value ->
            if (value == SwipeToDismissBoxValue.StartToEnd) actions.reply(row.id)
            scope.launch { state.reset() }
        },
    ) {
        content()
    }
}

@Composable
private fun ChatMessageRow(row: ChatRowModel, actions: ChatRowActions, sidePane: Boolean, maxBubble: Dp) {
    val haptics = rememberConclaveHaptics()
    Row(
        Modifier.fillMaxWidth().pointerInput(row.id) {
            detectTapGestures(onLongPress = {
                haptics.gesture(FeedbackKind.longPress)
                actions.openMenu(row.id)
            })
        },
        horizontalArrangement = if (row.isOwn) Arrangement.End else Arrangement.Start,
    ) {
        if (!row.isOwn) {
            if (row.isGroupStart) {
                ConclaveAvatar(row.senderName, row.senderId, ConclaveAvatarSize.chat, Modifier.clearAndSetSemantics { })
            } else {
                Spacer(Modifier.width(32.dp))
            }
        }
        Column(
            Modifier.padding(start = 8.dp).widthIn(max = maxBubble),
            horizontalAlignment = if (row.isOwn) Alignment.End else Alignment.Start,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (row.isGroupStart) ChatRowHeader(row)
            if (row.privacy != ChatPrivacy.everyone) ChatPrivateLabel(row)
            Box {
                ChatBubble(row, actions)
                if (sidePane && actions.menuRowId == row.id) {
                    MessageActionsMenu(actions.presenter, actions, row.id)
                }
            }
            if (row.reactions.count > 0) {
                ConclaveReactionChipRow(
                    chips = ChatCopyAndroid.chipModels(row),
                    identifier = "chat.row.${row.id}.chip",
                    onToggle = { chip -> actions.toggle(row.id, chip.emoji) },
                    onLongPress = { _ -> actions.openViewer(row.id) },
                    longPressLabel = conclaveString("chat_action_reactions"),
                    haptics = haptics,
                )
            }
            // CL6: only ready cards are in the row (CH16), so each appears once and never resizes.
            row.embedURLs.toList().forEachIndexed { index, url ->
                LinkEmbedCard(actions.embed(url), row.id, index) { target -> actions.openLink(target) }
            }
            ChatDeliveryLine(row, actions)
        }
    }
}

/** Name or "You" (titleSmall, one line) and the time (labelSmall, tabular, locale 12 or 24 hour). */
@Composable
private fun ChatRowHeader(row: ChatRowModel) {
    val context = LocalContext.current
    Row(Modifier.clearAndSetSemantics { }, horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically) {
        ConclaveText(ChatCopyAndroid.senderName(row), line = "chat.row.${row.id}.name", style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.weight(1f, fill = false),
            color = MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
        ConclaveText(ChatCopyAndroid.time(context, row.timestampMillis), line = "chat.row.${row.id}.time",
            style = rememberTabular(MaterialTheme.typography.labelSmall), color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1)
    }
}

/** Every private row, grouped follow-ups included (lock glyph plus text, Q9). */
@Composable
private fun ChatPrivateLabel(row: ChatRowModel) {
    val text = if (row.privacy == ChatPrivacy.privateSent) conclaveString("chat_private_to", row.privateName)
        else conclaveString("chat_private_received")
    Row(Modifier.clearAndSetSemantics { }, horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Icon(ConclaveIcons.LockFill1, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(14.dp))
        ConclaveText(text, line = "chat.row.${row.id}.private", style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Which media element a row draws (3 d, f). */
internal enum class ChatRowMediaKind { None, Photo, Gif, Sticker, Clip }

internal fun chatRowMedia(row: ChatRowModel): ChatRowMediaKind {
    if (row.kind == ChatRowKind.photo && row.photoURL.isNotEmpty()) return ChatRowMediaKind.Photo
    if (row.kind == ChatRowKind.gif) {
        // A GIF whose URL does not parse shows its title in a bubble (3 f).
        if (row.gifURL.isEmpty() || runCatching { java.net.URI(row.gifURL) }.isFailure) return ChatRowMediaKind.None
        return when (row.gifKind) {
            ChatGifKind.sticker -> ChatRowMediaKind.Sticker
            ChatGifKind.clip -> ChatRowMediaKind.Clip
            else -> ChatRowMediaKind.Gif
        }
    }
    return ChatRowMediaKind.None
}

/** The text summary shows for text rows, a photo with a caption and a GIF that fell back to its title. */
internal fun chatRowShowsText(row: ChatRowModel, media: ChatRowMediaKind): Boolean = when (media) {
    ChatRowMediaKind.None -> true
    ChatRowMediaKind.Photo -> !row.photoCaptionIsEmpty && row.plainText.isNotEmpty()
    else -> false
}

@Composable
private fun ChatBubble(row: ChatRowModel, actions: ChatRowActions) {
    val tone = row.bubbleTone
    val media = chatRowMedia(row)
    if (media == ChatRowMediaKind.Sticker) {
        // Stickers have no bubble fill (3 c).
        ChatGifElement(row, actions, media)
        return
    }
    ConclaveChatBubble(tone = tone, isOwn = row.isOwn, identifier = "chat.row.${row.id}.bubble",
        isFollowUp = !row.isGroupStart, hasFollower = !row.isGroupEnd, isMedia = media != ChatRowMediaKind.None) {
        val insets = if (media == ChatRowMediaKind.None) Modifier else Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
        val reply = row.reply
        if (reply != null) Box(insets) { ChatQuote(row, reply, tone, actions) }
        when (media) {
            ChatRowMediaKind.Photo -> ChatPhotoElement(row, actions)
            ChatRowMediaKind.Gif, ChatRowMediaKind.Clip -> ChatGifElement(row, actions, media)
            else -> {}
        }
        if (row.kind == ChatRowKind.voice) ChatVoiceControl(row, actions.presenter)
        if (chatRowShowsText(row, media)) Box(insets) { ChatBubbleText(row, tone, actions) }
    }
}

/**
 * S40 3 d photo: a fixed 240 by 180 dp Coil box bounded to its size, the viewer on tap, "Couldn't load photo. Tap to
 * retry." in the same box on failure. Labelled "Photo from Avery Lee" plus the caption (never the upload file name);
 * for a photo without caption it carries the row's summary semantics.
 */
@Composable
private fun ChatPhotoElement(row: ChatRowModel, actions: ChatRowActions) {
    val isSummary = !chatRowShowsText(row, ChatRowMediaKind.Photo)
    val label = ChatMediaCopyAndroid.photoLabel(row)
    val summary = if (isSummary) chatSummarySemantics(row, actions, label) else Modifier
    ChatImageBox(
        url = row.photoURL,
        width = ChatMediaGeometry.photoWidth.dp,
        height = ChatMediaGeometry.photoHeight.dp,
        modifier = summary.testTag("chat.row.${row.id}.photo"),
        shape = RoundedCornerShape(0.dp),
        failureText = conclaveString("chat_photo_failed"),
        retriesOnTap = true,
        description = if (isSummary) null else label,
        onOpen = { actions.openPhoto(row.id) },
    )
}

/**
 * S40 3 d GIF, sticker and clip: a GIF box 220 dp wide (height from the aspect, 120 to 300) animated through coil-gif
 * (static under Remove animations); a sticker up to 160 dp square without a bubble; a clip as its poster with the play
 * glyph and the "Clip" tag, opening the clip through the link policy (Custom Tabs). Carries the summary semantics.
 */
@Composable
private fun ChatGifElement(row: ChatRowModel, actions: ChatRowActions, media: ChatRowMediaKind) {
    val summary = chatSummarySemantics(row, actions, ChatCopyAndroid.rowLabel(row))
    val scheme = MaterialTheme.colorScheme
    when (media) {
        ChatRowMediaKind.Clip -> {
            val height = ChatMediaGeometry.gifHeight(row.gifAspect).dp
            val poster = row.gifPreviewURL.ifEmpty { row.gifURL }
            val target = row.gifVideoURL.ifEmpty { row.gifURL }
            Box(summary.testTag("chat.row.${row.id}.gif"), contentAlignment = Alignment.Center) {
                ChatImageBox(poster, ChatMediaGeometry.gifWidth.dp, height, shape = RoundedCornerShape(0.dp),
                    onOpen = { actions.openLink(target) })
                Surface(shape = CircleShape, color = scheme.surface) {
                    Icon(ConclaveIcons.PlayArrowFill1, contentDescription = null, tint = scheme.onSurface,
                        modifier = Modifier.padding(12.dp).size(24.dp))
                }
                Surface(shape = MaterialTheme.shapes.small, color = scheme.surface, modifier = Modifier.align(Alignment.BottomStart).padding(8.dp)) {
                    ConclaveText(conclaveString("chat_clip"), line = "chat.row.${row.id}.clipTag", style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
                }
            }
        }
        ChatRowMediaKind.Sticker -> ChatImageBox(
            row.gifURL, ChatMediaGeometry.stickerWidth(row.gifAspect).dp, ChatMediaGeometry.stickerHeight(row.gifAspect).dp,
            modifier = summary.testTag("chat.row.${row.id}.gif"), shape = RoundedCornerShape(0.dp), placeholder = Color.Transparent,
            animate = true,
        )
        else -> ChatImageBox(
            row.gifURL, ChatMediaGeometry.gifWidth.dp, ChatMediaGeometry.gifHeight(row.gifAspect).dp,
            modifier = summary.testTag("chat.row.${row.id}.gif"), shape = RoundedCornerShape(0.dp), animate = true,
        )
    }
}

/** 3 d quote: one clickable node that jumps; a gone target shows the unavailable line and is not clickable. */
@Composable
private fun ChatQuote(row: ChatRowModel, reply: ChatReplyRef, tone: ConclaveBubbleTone, actions: ChatRowActions) {
    val author = if (reply.isAuthorYou) conclaveString("chat_you") else reply.authorName
    if (row.canJumpToReply) {
        val preview = ChatCopyAndroid.replyPreview(reply)
        ConclaveBubbleQuote(author = author, preview = preview, tone = tone,
            description = conclaveString("chat_ax_reply", author, preview),
            clickLabel = conclaveString("chat_ax_go_to_original"), identifier = "chat.row.${row.id}.quote",
            onClick = { actions.jumpToReply(reply.messageId) })
    } else {
        val missing = conclaveString("chat_reply_missing")
        Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = missing }
            .background(ConclaveBubbleColors.quoteFill(tone), RoundedCornerShape(8.dp)).padding(8.dp)) {
            ConclaveText(author, line = "chat.row.${row.id}.quote.author", style = MaterialTheme.typography.labelMedium)
            ConclaveText(missing, line = "chat.row.${row.id}.quote.missing", style = MaterialTheme.typography.bodySmall)
        }
    }
}

/**
 * The summary node (3 i): linkified spans (CH17) through LinkAnnotation, mentions SemiBold, a mention of you in primary
 * on neutral fills; label, value parts, the long-click label and the custom actions (5 i).
 */
@Composable
private fun ChatBubbleText(row: ChatRowModel, tone: ConclaveBubbleTone, actions: ChatRowActions) {
    val semantics = chatSummarySemantics(row, actions, ChatCopyAndroid.rowLabel(row))
    val linkColor = ConclaveBubbleColors.link(tone)
    val youColor = MaterialTheme.colorScheme.primary
    // Assistant rows never reach this text (AssistantRow, CHT-7).
    val text = buildAnnotatedString {
        for (span in row.spans) {
            when (span.kind) {
                ChatSpanKind.link -> withLink(LinkAnnotation.Url(span.url,
                    TextLinkStyles(style = SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline))) {
                    actions.openLink(span.url)
                }) { append(span.text) }
                ChatSpanKind.mention -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(span.text) }
                ChatSpanKind.mentionYou -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold,
                    color = if (tone.usesCoralFill) linkColor else youColor)) { append(span.text) }
                else -> append(span.text)
            }
        }
    }
    Text(
        text,
        style = MaterialTheme.typography.bodyLarge.copy(lineBreak = LineBreak.Simple, hyphens = Hyphens.None),
        modifier = semantics,
    )
}

/**
 * The one summary node per message (3 i): the label, the value parts as the state description, the long-click label
 * "Message actions" and the custom actions (5 i). The bubble text carries it, or the media element for a media-only row.
 */
@Composable
internal fun chatSummarySemantics(row: ChatRowModel, actions: ChatRowActions, label: String): Modifier {
    val context = LocalContext.current
    val value = ChatCopyAndroid.rowValue(context, row)
    val menuLabel = conclaveString("chat_message_actions")
    val customActions = chatCustomActions(row, actions)
    return Modifier.semantics {
        contentDescription = label
        stateDescription = value
        onLongClick(label = menuLabel) {
            actions.openMenu(row.id)
            true
        }
        this.customActions = customActions
    }
}

/** 5 i: the menu's actions in menu order, then the row actions; Android's long press reaches the menu itself. */
@Composable
private fun chatCustomActions(row: ChatRowModel, actions: ChatRowActions): List<CustomAccessibilityAction> {
    val result = mutableListOf<CustomAccessibilityAction>()
    val replyLabel = conclaveString("chat_action_reply")
    val reactLabel = conclaveString("chat_add_reaction")
    val privateLabel = conclaveString("chat_action_private")
    val copyLabel = conclaveString("chat_action_copy")
    val copyLinkLabel = conclaveString("chat_action_copy_link")
    val viewLabel = conclaveString("chat_action_reactions")
    val hideLabel = conclaveString("chat_action_hide_sender", row.senderName)
    val retryLabel = conclaveString("ds_retry")
    val deleteLabel = conclaveString("chat_delete")
    val originalLabel = conclaveString("chat_ax_go_to_original")
    val openPhotoLabel = conclaveString("chat_ax_open_photo")
    if (row.canReply) result.add(CustomAccessibilityAction(replyLabel) { actions.reply(row.id); true })
    if (row.canReact) result.add(CustomAccessibilityAction(reactLabel) { actions.openMenu(row.id); true })
    if (row.canMessagePrivately) result.add(CustomAccessibilityAction(privateLabel) { actions.messagePrivately(row.senderId); true })
    if (row.canCopy) result.add(CustomAccessibilityAction(copyLabel) { actions.copy(row.id); true })
    if (row.canCopyLink) result.add(CustomAccessibilityAction(copyLinkLabel) { actions.copyLink(row.id); true })
    if (row.reactions.count > 0) result.add(CustomAccessibilityAction(viewLabel) { actions.openViewer(row.id); true })
    if (row.canHideSender) result.add(CustomAccessibilityAction(hideLabel) { actions.hideSender(row.senderId); true })
    if (row.canRetry) result.add(CustomAccessibilityAction(retryLabel) { actions.retry(row.id); true })
    if (row.canDelete) result.add(CustomAccessibilityAction(deleteLabel) { actions.delete(row.id); true })
    chatVoiceCustomAction(row, actions.presenter)?.let { result.add(it) }
    val reply = row.reply
    if (row.canJumpToReply && reply != null) {
        result.add(CustomAccessibilityAction(originalLabel) { actions.jumpToReply(reply.messageId); true })
    }
    if (row.kind == ChatRowKind.photo && row.photoURL.isNotEmpty()) {
        result.add(CustomAccessibilityAction(openPhotoLabel) { actions.openPhoto(row.id); true })
    }
    return result
}

/**
 * 3 d delivery: "Sending…" after 1 s; failed shows the error glyph and "Not sent. Tap to try again." in error color,
 * the row clickable when retryable; non-retryable rows show the reason and offer Delete through the long press.
 */
@Composable
private fun ChatDeliveryLine(row: ChatRowModel, actions: ChatRowActions) {
    val scheme = MaterialTheme.colorScheme
    if (row.isOwn && row.delivery == ChatDelivery.sendingSlow) {
        ConclaveText(conclaveString("chat_sending"), line = "chat.row.${row.id}.sending", style = MaterialTheme.typography.labelSmall,
            color = scheme.onSurfaceVariant, modifier = Modifier.clearAndSetSemantics { })
        return
    }
    if (row.delivery != ChatDelivery.failed) return
    val retryLabel = conclaveString("ds_retry")
    val clickable = if (row.canRetry) Modifier.clickable(onClickLabel = retryLabel) { actions.retry(row.id) } else Modifier
    Column(horizontalAlignment = Alignment.End) {
        Row(Modifier.testTag("chat.row.${row.id}.failed").then(clickable).padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(ConclaveIcons.ErrorFill1, contentDescription = null, tint = scheme.error, modifier = Modifier.size(16.dp))
            ConclaveText(conclaveString("chat_not_sent"), line = "chat.row.${row.id}.notSent", style = MaterialTheme.typography.labelSmall,
                color = scheme.error)
        }
        if (ChatFailurePolicy.showsReason(row.failure)) {
            ConclaveText(ChatMediaCopyAndroid.failureReason(row.failure), line = "chat.row.${row.id}.reason",
                style = MaterialTheme.typography.labelSmall, color = scheme.onSurfaceVariant, textAlign = TextAlign.End)
        }
    }
}

/** 3 d system rows: centered bodySmall; the error tone adds ErrorFill1; the hidden-sender row adds Show (Q2b). */
@Composable
private fun ChatSystemRow(row: ChatRowModel, actions: ChatRowActions) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (row.systemTone == ChatSystemTone.error) {
                Icon(ConclaveIcons.ErrorFill1, contentDescription = null, tint = scheme.error, modifier = Modifier.size(16.dp))
            }
            ConclaveText(ChatCopyAndroid.systemText(row), line = "chat.row.${row.id}.text", style = MaterialTheme.typography.bodySmall,
                color = scheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
        if (row.notice == ChatNotice.senderHidden) {
            TextButton(onClick = { actions.showSender(row.senderId) }, modifier = Modifier.testTag("chat.row.${row.id}.show")) {
                ConclaveText(conclaveString("chat_sender_show"), line = "chat.row.${row.id}.show.label")
            }
        }
    }
}

/** 3 d action rows (`/me`): centered, the name SemiBold; Copy through the long press menu. */
@Composable
private fun ChatActionRow(row: ChatRowModel, actions: ChatRowActions) {
    val scheme = MaterialTheme.colorScheme
    val name = ChatCopyAndroid.senderName(row)
    val menuLabel = conclaveString("chat_message_actions")
    val text = buildAnnotatedString {
        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = scheme.onSurface)) { append(name) }
        append(" ")
        append(row.plainText)
    }
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = scheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().pointerInput(row.id) {
            detectTapGestures(onLongPress = { actions.openMenu(row.id) })
        }.semantics {
            onLongClick(label = menuLabel) {
                actions.openMenu(row.id)
                true
            }
        },
    )
}
