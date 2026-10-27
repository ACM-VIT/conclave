package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/*
 * S40 5 d (CHT-3): message actions on Android. The overlay shows a ModalBottomSheet (system theme, skips the partial
 * state) with a two-line excerpt, all eight emoji in canonical order as 48 dp targets (selected secondaryContainer;
 * a tap toggles and closes), then the actions in the iOS order: Reply, Send private message, Copy text, Copy link,
 * View reactions; Hide messages from %1$s (Report stays hidden while canReport is false, Owner OQ5 (2026-10-26));
 * failed rows end with Retry and Delete (error color, last). The side pane shows the same items as a DropdownMenu
 * anchored to the bubble inside the pane, so no window sheet or scrim covers the stage (AND 7.12). One sheet at a
 * time: the viewer opens only after this sheet finished hiding (D12). Popup roots register with the exporter (R40-11).
 */

private class ChatMenuAction(val tag: String, val label: String, val icon: ImageVector?, val destructive: Boolean, val run: () -> Unit)

@Composable
private fun chatMenuActions(row: ChatRowModel, actions: ChatRowActions, close: () -> Unit, openViewer: () -> Unit): List<List<ChatMenuAction>> {
    val main = mutableListOf<ChatMenuAction>()
    if (row.canReply) main.add(ChatMenuAction("reply", conclaveString("chat_action_reply"), ConclaveIcons.ChatBubbleFill0, false) {
        close(); actions.reply(row.id)
    })
    if (row.canMessagePrivately) main.add(ChatMenuAction("private", conclaveString("chat_action_private"), ConclaveIcons.LockFill1, false) {
        close(); actions.messagePrivately(row.senderId)
    })
    if (row.canCopy) main.add(ChatMenuAction("copy", conclaveString("chat_action_copy"), ConclaveIcons.ContentCopyFill0, false) {
        close(); actions.copy(row.id)
    })
    if (row.canCopyLink) main.add(ChatMenuAction("copyLink", conclaveString("chat_action_copy_link"), ConclaveIcons.ContentCopyFill0, false) {
        close(); actions.copyLink(row.id)
    })
    if (row.reactions.count > 0) main.add(ChatMenuAction("reactions", conclaveString("chat_action_reactions"), ConclaveIcons.AddReactionFill0, false) {
        openViewer()
    })
    val safety = mutableListOf<ChatMenuAction>()
    if (row.canHideSender) safety.add(ChatMenuAction("hide", conclaveString("chat_action_hide_sender", row.senderName),
        ConclaveIcons.PersonRemoveFill0, false) {
        close(); actions.hideSender(row.senderId)
    })
    val failed = mutableListOf<ChatMenuAction>()
    if (row.canRetry) failed.add(ChatMenuAction("retry", conclaveString("ds_retry"), null, false) { close(); actions.retry(row.id) })
    if (row.canDelete) failed.add(ChatMenuAction("delete", conclaveString("chat_delete"), ConclaveIcons.DeleteFill0, true) {
        close(); actions.delete(row.id)
    })
    return listOf(main, safety, failed).filter { it.isNotEmpty() }
}

/** The emoji a menu offers: all eight, except at the 12-emoji cap only those already on the message (5 f). */
private fun chatMenuEmojis(row: ChatRowModel): List<String> {
    val present = row.reactions.toList().map { it.emoji }
    return ChatReactionRules.emojis.toList().filter { !row.isAtReactionCap || present.contains(it) }
}

@Composable
private fun ChatEmojiRow(row: ChatRowModel, onPick: (String) -> Unit) {
    val haptics = rememberConclaveHaptics()
    val mine = row.reactions.toList().filter { it.isMine }.map { it.emoji }
    FlowRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceEvenly, maxItemsInEachRow = 8) {
        for (emoji in chatMenuEmojis(row)) {
            val selected = mine.contains(emoji)
            val name = ChatCopyAndroid.emojiName(emoji)
            val label = conclaveString("chat_react_with", name)
            Box(
                Modifier.size(48.dp).background(
                    if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerHighest,
                    CircleShape,
                ).clickable(role = Role.Button) {
                    if (!selected) haptics.gesture(FeedbackKind.reactionSent)
                    onPick(emoji)
                }.semantics {
                    contentDescription = label
                    this.selected = selected
                }.testTag("chat.actions.emoji.$emoji"),
                contentAlignment = Alignment.Center,
            ) {
                ConclaveText(emoji, line = "chat.actions.emoji.$emoji.face", style = MaterialTheme.typography.titleLarge)
            }
        }
    }
}

/** The overlay's long-press sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MessageActionsSheet(presenter: ChatPresenter, actions: ChatRowActions, rowId: String) {
    val row = presenter.rows.entry(rowId).row
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val hideThen: (() -> Unit) -> Unit = { after ->
        scope.launch { sheetState.hide() }.invokeOnCompletion {
            actions.closeMenu()
            after()
        }
    }
    ModalBottomSheet(
        onDismissRequest = { actions.closeMenu() },
        sheetState = sheetState,
        modifier = Modifier.semantics { testTagsAsResourceId = true }.testTag("chat.actions.sheet"),
    ) {
        NativeSemanticsPopupRoot("chat.actions.sheet")
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            val excerpt = ChatCopyAndroid.senderName(row) + ": " + row.plainText
            ConclaveText(excerpt, line = "chat.actions.excerpt", style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            if (row.canReact) {
                ChatEmojiRow(row) { emoji -> hideThen { actions.toggle(row.id, emoji) } }
            }
            val groups = chatMenuActions(row, actions, close = { hideThen { } }, openViewer = { hideThen { actions.openViewer(row.id) } })
            groups.forEachIndexed { index, group ->
                if (index > 0 || row.canReact) HorizontalDivider()
                for (item in group) {
                    val color = if (item.destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
                    ListItem(
                        headlineContent = { ConclaveText(item.label, line = "chat.actions.${item.tag}", color = color) },
                        leadingContent = item.icon?.let { icon ->
                            @Composable {
                                Icon(icon, contentDescription = null,
                                    tint = if (item.destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        },
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                        modifier = Modifier.clickable { item.run() }.testTag("chat.actions.${item.tag}"),
                    )
                }
            }
        }
    }
}

/** The side pane's anchored menu (emoji row first), inside the pane, never over the stage. */
@Composable
internal fun MessageActionsMenu(presenter: ChatPresenter, actions: ChatRowActions, rowId: String) {
    val row = presenter.rows.entry(rowId).row
    DropdownMenu(
        expanded = true,
        onDismissRequest = { actions.closeMenu() },
        modifier = Modifier.semantics { testTagsAsResourceId = true }.testTag("chat.actions.menu"),
    ) {
        NativeSemanticsPopupRoot("chat.actions.menu")
        if (row.canReact) {
            ChatEmojiRow(row) { emoji ->
                actions.closeMenu()
                actions.toggle(row.id, emoji)
            }
        }
        val groups = chatMenuActions(row, actions, close = { actions.closeMenu() }, openViewer = {
            actions.closeMenu()
            actions.openViewer(row.id)
        })
        groups.forEachIndexed { index, group ->
            if (index > 0 || row.canReact) HorizontalDivider()
            for (item in group) {
                val color = if (item.destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
                DropdownMenuItem(
                    text = { ConclaveText(item.label, line = "chat.menu.${item.tag}", color = color) },
                    leadingIcon = item.icon?.let { icon ->
                        @Composable {
                            Icon(icon, contentDescription = null,
                                tint = if (item.destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    },
                    onClick = { item.run() },
                    modifier = Modifier.testTag("chat.menu.${item.tag}"),
                )
            }
        }
    }
}
