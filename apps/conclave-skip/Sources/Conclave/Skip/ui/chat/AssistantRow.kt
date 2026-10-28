package conclave.module

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/*
 * S40 4 d (CHT-7): the Conclave AI row on Android. Reads only its ChatRowEntry (`row` plus the `assistant` model the
 * transpiled presenter writes), so a streamed delta recomposes this item and never the list. Leading like peer rows:
 * the AssistantMark (CL4: 32 dp primaryContainer circle, onPrimaryContainer glyph), the "Conclave" header with the
 * neutral "AI" tag on every answer, then the bubble: the neutral fill with the 1 dp outlineVariant border (the C23
 * tone that carries a border), and a 1 dp error border for a failure. Inside: the thinking line (stock 16 dp
 * CircularProgressIndicator plus a static label, R13, never the expressive indicator), the reasoning and steps headers
 * (Role.Button, state description, AnimatedVisibility(expandVertically) or instant under Remove animations; expanded
 * while the answer streams, collapsed when it completes unless the person chose), the AssistantMarkdown answer (links
 * through the external link confirmation) and the error line with Try again for the asker. No haptics beyond the
 * message menu's long press. While thinking, streaming or failed the row is one node ("Conclave, Thinking", Try again
 * as its custom action); a finished answer keeps headings and links as their own nodes behind the header, which
 * carries the summary semantics and the row actions. The approval card and the key prompt are W10-2 (not shown).
 */
@Composable
internal fun AssistantRow(entry: ChatRowEntry, actions: ChatRowActions, sidePane: Boolean, maxBubble: Dp) {
    val row = entry.row
    val model = entry.assistant ?: AssistantRowModel.placeholder
    val finished = model.state == AssistantRowState.done
    val haptics = rememberConclaveHaptics()
    val label = assistantRowLabel(row, model)
    val retryLabel = conclaveString("ds_try_again")
    val hasMenu = row.canReply || row.canReact || row.canCopy || row.canCopyLink || row.reactions.count > 0
    val rowSemantics = if (finished) Modifier else Modifier.clearAndSetSemantics {
        contentDescription = label
        if (model.canRetry) {
            customActions = listOf(CustomAccessibilityAction(retryLabel) { actions.retryAssistant(row.id); true })
        }
    }
    Row(
        Modifier.fillMaxWidth().testTag("chat.row.${row.id}.assistant").then(rowSemantics).pointerInput(row.id, hasMenu) {
            detectTapGestures(onLongPress = {
                if (hasMenu) {
                    haptics.gesture(FeedbackKind.longPress)
                    actions.openMenu(row.id)
                }
            })
        },
    ) {
        AssistantMark()
        Column(
            Modifier.padding(start = 8.dp).widthIn(max = maxBubble),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            AssistantHeader(row, model, actions, finished)
            Box {
                AssistantBubble(row, model, actions)
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
        }
    }
}

/** CL4: the canonical assistant mark. */
@Composable
private fun AssistantMark() {
    val scheme = MaterialTheme.colorScheme
    Surface(shape = CircleShape, color = scheme.primaryContainer, modifier = Modifier.size(32.dp).clearAndSetSemantics { }) {
        Box(contentAlignment = Alignment.Center) {
            Icon(ConclaveIcons.AutoAwesomeFill0, contentDescription = null, tint = scheme.onPrimaryContainer,
                modifier = Modifier.size(18.dp))
        }
    }
}

/** "Conclave", the neutral "AI" tag and the time; a finished answer's header is its summary node (3 i, 5 i). */
@Composable
private fun AssistantHeader(row: ChatRowModel, model: AssistantRowModel, actions: ChatRowActions, isSummary: Boolean) {
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val semantics = if (isSummary) chatSummarySemantics(row, actions, assistantRowLabel(row, model))
        else Modifier.clearAndSetSemantics { }
    Row(semantics, horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        ConclaveText(conclaveString("chat_assistant_name"), line = "chat.row.${row.id}.name",
            style = MaterialTheme.typography.titleSmall, color = scheme.onSurface, maxLines = 1)
        Surface(shape = MaterialTheme.shapes.small, color = scheme.surfaceContainerHighest) {
            ConclaveText(conclaveString("chat_assistant_tag"), line = "chat.row.${row.id}.tag",
                style = MaterialTheme.typography.labelMedium, color = scheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
        }
        ConclaveText(ChatCopyAndroid.time(context, row.timestampMillis), line = "chat.row.${row.id}.time",
            style = rememberTabular(MaterialTheme.typography.labelSmall), color = scheme.onSurfaceVariant)
    }
}

@Composable
private fun AssistantBubble(row: ChatRowModel, model: AssistantRowModel, actions: ChatRowActions) {
    val scheme = MaterialTheme.colorScheme
    val failed = model.showsError
    val border = if (failed) Modifier.border(1.dp, scheme.error, conclaveBubbleShape(isOwn = false, isFollowUp = false, hasFollower = false))
        else Modifier
    var reasoningChoice by remember(row.id) { mutableStateOf<Boolean?>(null) }
    var stepsChoice by remember(row.id) { mutableStateOf<Boolean?>(null) }
    val automatic = model.state != AssistantRowState.done
    val workingSpinner: @Composable () -> Unit = { AssistantSpinner() }
    ConclaveChatBubble(
        tone = if (failed) ConclaveBubbleTone.peer else ConclaveBubbleTone.privateMessage,
        isOwn = false,
        identifier = "chat.row.${row.id}.bubble",
        modifier = border,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (model.state == AssistantRowState.thinking) AssistantThinkingLine()
            if (model.showsProcess && model.reasoning.isNotEmpty()) {
                val expanded = reasoningChoice ?: automatic
                AssistantDisclosure(
                    title = assistantReasoningLabel(model),
                    expanded = expanded,
                    onToggle = { reasoningChoice = !expanded },
                    identifier = "chat.row.${row.id}.reasoning",
                ) {
                    ConclaveText(model.reasoning, line = "chat.row.${row.id}.reasoning.text",
                        style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                }
            }
            if (model.showsProcess && model.tasks.count > 0) {
                val expanded = stepsChoice ?: automatic
                AssistantDisclosure(
                    title = if (model.isWorking) conclaveString("chat_assistant_working") else conclaveString("chat_assistant_actions"),
                    expanded = expanded,
                    onToggle = { stepsChoice = !expanded },
                    identifier = "chat.row.${row.id}.actions",
                    leading = if (model.isWorking) workingSpinner else null,
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (task in model.tasks) {
                            AssistantTaskRow(row.id, task)
                        }
                    }
                }
            }
            if (model.showsProcess && model.blocks.count > 0) {
                AssistantMarkdown(
                    blocks = model.blocks.toList(),
                    onLink = { url -> actions.openAssistantLink(url) },
                    identifier = "chat.row.${row.id}.answer",
                )
            }
            if (failed) AssistantErrorLine(row, model, actions)
        }
    }
}

/** The stock indicator (F00 C14), 16 dp, stroke 2 dp, in the secondary ink. */
@Composable
private fun AssistantSpinner() {
    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** R13: the static label with the stock spinner, never a pulse. */
@Composable
private fun AssistantThinkingLine() {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        AssistantSpinner()
        ConclaveText(conclaveString("chat_assistant_thinking"), line = "chat.assistant.thinking",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * A reasoning or steps header: one Button node with the expand or collapse click label and the expanded or collapsed
 * state, 48 dp tall. The nonmirroring disclosure points down when closed and up when open in either reading direction.
 */
@Composable
private fun AssistantDisclosure(
    title: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    identifier: String,
    leading: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val reduceMotion = rememberReduceMotion()
    val clickLabel = if (expanded) conclaveString("chat_assistant_collapse") else conclaveString("chat_assistant_expand")
    val stateText = if (expanded) conclaveString("chat_assistant_expanded") else conclaveString("chat_assistant_collapsed")
    val angle = if (expanded) 180f else 0f
    Column {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(identifier)
                .clickable(role = Role.Button, onClickLabel = clickLabel, onClick = onToggle)
                .semantics { stateDescription = stateText },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            leading?.invoke()
            ConclaveText(title, line = "$identifier.title", style = MaterialTheme.typography.labelLarge,
                color = scheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            Icon(ConclaveIcons.ExpandMoreFill0, contentDescription = null, tint = scheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp).rotate(angle))
        }
        if (reduceMotion) {
            if (expanded) content()
        } else {
            AnimatedVisibility(visible = expanded, enter = expandVertically(), exit = shrinkVertically()) {
                content()
            }
        }
    }
}

/** One listed step: CheckFill0 when done, the 16 dp spinner while running, the label and the query below. */
@Composable
private fun AssistantTaskRow(rowId: String, task: AssistantTask) {
    val scheme = MaterialTheme.colorScheme
    Row(Modifier.semantics(mergeDescendants = true) { }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (task.isDone) {
            Icon(ConclaveIcons.CheckFill0, contentDescription = null, tint = scheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
        } else {
            AssistantSpinner()
        }
        Column {
            ConclaveText(assistantTaskLabel(task), line = "chat.row.$rowId.task.${task.id}", style = MaterialTheme.typography.bodyMedium)
            if (task.query.isNotEmpty()) {
                ConclaveText(task.query, line = "chat.row.$rowId.task.${task.id}.query", style = MaterialTheme.typography.bodySmall,
                    color = scheme.onSurfaceVariant)
            }
        }
    }
}

/** CH8: the kind's copy with ErrorFill1 in error, and Try again for the asker (tonal, neutral). */
@Composable
private fun AssistantErrorLine(row: ChatRowModel, model: AssistantRowModel, actions: ChatRowActions) {
    val scheme = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(ConclaveIcons.ErrorFill1, contentDescription = null, tint = scheme.error, modifier = Modifier.size(16.dp))
            ConclaveText(assistantErrorText(model.errorKind), line = "chat.row.${row.id}.error",
                style = MaterialTheme.typography.bodyMedium)
        }
        if (model.canRetry) {
            ConclaveButton(
                title = conclaveString("ds_try_again"),
                role = ConclaveButtonRole.Tonal,
                identifier = "chat.row.${row.id}.retry",
                onClick = { actions.retryAssistant(row.id) },
            )
        }
    }
}

/** S40 4 g, Android: Material sentence case. */
@Composable
internal fun assistantReasoningLabel(model: AssistantRowModel): String = when {
    !model.reasoningDone && model.state == AssistantRowState.streaming -> conclaveString("chat_assistant_reasoning_live")
    model.thoughtSeconds > 0 -> conclaveString("chat_assistant_thought_for", model.thoughtSeconds)
    else -> conclaveString("chat_assistant_thought")
}

@Composable
internal fun assistantTaskLabel(task: AssistantTask): String = when (task.kind) {
    AssistantTaskKind.webSearch -> conclaveString(if (task.isDone) "chat_task_web_done" else "chat_task_web_running")
    AssistantTaskKind.transcript -> conclaveString(if (task.isDone) "chat_task_transcript_done" else "chat_task_transcript_running")
    AssistantTaskKind.githubIssue -> conclaveString(if (task.isDone) "chat_task_github_done" else "chat_task_github_running")
    AssistantTaskKind.browser -> conclaveString(if (task.isDone) "chat_task_browser_done" else "chat_task_browser_running")
    else -> ""
}

/** Presenter-chosen copy per kind (CH8); `needsKey` reads as unavailable until the key prompt ships (W10-2). */
@Composable
internal fun assistantErrorText(kind: AssistantErrorKind): String = when (kind) {
    AssistantErrorKind.unavailable, AssistantErrorKind.needsKey -> conclaveString("chat_assistant_unavailable")
    AssistantErrorKind.expired -> conclaveString("chat_assistant_error_expired")
    AssistantErrorKind.rateLimited -> conclaveString("chat_assistant_error_rate")
    AssistantErrorKind.empty -> conclaveString("chat_assistant_empty")
    else -> conclaveString("chat_assistant_error_generic")
}

/** The one node's label while the answer is not finished ("Conclave, Thinking"), or the finished header's summary. */
@Composable
internal fun assistantRowLabel(row: ChatRowModel, model: AssistantRowModel): String {
    val name = conclaveString("chat_assistant_name")
    val detail = when {
        model.showsError -> assistantErrorText(model.errorKind)
        model.state == AssistantRowState.done -> AssistantRowPolicy.firstSentence(row.plainText).ifEmpty { row.plainText }
        else -> conclaveString("chat_assistant_thinking")
    }
    return conclaveString("chat_ax_row", name, detail)
}
