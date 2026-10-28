package conclave.module

import android.content.Context
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/*
 * S50 11 d (PPL-6, PL5): the Android question row. One Column per question reading only its QaQuestionEntry, so a vote
 * change recomposes one row (11 k). Attendees get the upvote FilterChip (selected = secondaryContainer, the count in
 * tabular digits with the canonical R50-4 upvote glyph) that plays `upvoteChanged` after a dispatched toggle. Hosts get a static count, and the row opens the host
 * DropdownMenu on tap or long press (longPress through the gesture route), the same items as TalkBack custom actions;
 * while an action is pending a spinner replaces the menu affordance. Status labels: "Being answered" in `live` with the
 * speaking glyph, "Answered" in `success`, "Waiting" and "Dismissed" in onSurfaceVariant. Static times, no clock.
 */

/** The row's resolved texts (S50 11 g, i), rebuilt only when the model changes. */
internal data class QaRowTexts(val status: String?, val meta: String, val answeredBy: String?, val description: String, val votes: String)

internal fun qaStatusTextOf(context: Context, model: QaQuestionModel, isHost: Boolean): String? = when (model.status) {
    QaStatus.answering -> conclaveStringOf(context, "qa_being_answered")
    QaStatus.answered -> conclaveStringOf(context, "qa_answered")
    QaStatus.pending -> if (model.isMine && !isHost) conclaveStringOf(context, "qa_waiting") else null
    QaStatus.dismissed -> if (isHost) conclaveStringOf(context, "qa_dismissed") else null
}

internal fun qaAskerOf(context: Context, model: QaQuestionModel): String = when {
    model.isMine -> conclaveStringOf(context, "ds_tag_you")
    model.askerName.isEmpty() -> conclaveStringOf(context, "ds_attendee")
    else -> model.askerName
}

internal fun qaTimeOf(millis: Double): String =
    DateFormat.getTimeInstance(DateFormat.SHORT, Locale.getDefault()).format(Date(millis.toLong()))

internal fun qaRowTextsOf(context: Context, model: QaQuestionModel, isHost: Boolean): QaRowTexts {
    val status = qaStatusTextOf(context, model, isHost)
    val asker = qaAskerOf(context, model)
    val time = qaTimeOf(model.askedAtMillis)
    val meta = conclaveStringOf(context, "qa_meta", asker, time)
    val answeredBy = if (model.answeredByName.isEmpty()) null else conclaveStringOf(context, "qa_answered_by", model.answeredByName)
    val votes = conclavePluralOf(context, "qa_votes", model.upvotes, model.upvotes)
    val parts = mutableListOf<String>()
    if (status != null) parts.add(status)
    parts.add(votes)
    parts.add(meta)
    if (model.answerText.isNotEmpty()) parts.add(if (answeredBy == null) model.answerText else "$answeredBy: ${model.answerText}")
    return QaRowTexts(status = status, meta = meta, answeredBy = answeredBy, description = parts.joinToString(", "), votes = votes)
}

/** The host action title name for a `QaOrderingPolicy.hostActions` id (S50 11 g). */
internal fun qaHostActionName(action: String): String = when (action) {
    QaModerationAction.answering -> "qa_answer_live"
    QaModerationAction.answered -> "qa_mark_answered"
    QaHostAction.answerText -> "qa_answer_writing"
    QaModerationAction.dismissed -> "qa_dismiss"
    else -> "qa_reopen"
}

/** One question (S50 11 d). [onAnswerInWriting] opens the PL10 multi-line dialog for the question id. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun QuestionRow(people: PeoplePresenter, entry: QaQuestionEntry, isHost: Boolean, onAnswerInWriting: (String) -> Unit) {
    val model = entry.model
    val qa = people.qa
    val context = LocalContext.current
    val scheme = MaterialTheme.colorScheme
    val extended = LocalConclaveExtendedColors.current
    val haptics = rememberConclaveHaptics()
    val texts = remember(model, isHost, context) { qaRowTextsOf(context, model, isHost) }
    val identifier = "qa.row.${model.id}"
    var menu by remember(model.id) { mutableStateOf(false) }
    SideEffect { qa.recompose?.record(model.id) }
    val hostActions = if (isHost && model.isEnabled) QaOrderingPolicy.hostActions(model.status).toList() else emptyList()
    val run: (String) -> Unit = { action ->
        menu = false
        if (action == QaHostAction.answerText) onAnswerInWriting(model.id) else qa.perform(hostAction = action, id = model.id)
    }
    val menuActions = hostActions.map { action ->
        CustomAccessibilityAction(conclaveStringOf(context, qaHostActionName(action))) { run(action); true }
    }
    val click = if (isHost) {
        Modifier.combinedClickable(
            enabled = model.isEnabled,
            role = Role.Button,
            onClickLabel = conclaveString("qa_actions"),
            onLongClickLabel = conclaveString("qa_actions"),
            hapticFeedbackEnabled = false,
            onClick = { menu = true },
            onLongClick = { haptics.gesture(FeedbackKind.longPress); menu = true },
        )
    } else Modifier
    Box {
        Row(
            Modifier.fillMaxWidth().then(click).padding(horizontal = 16.dp, vertical = 12.dp).testTag(identifier),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Column(
                Modifier.weight(1f).semantics(mergeDescendants = true) {
                    contentDescription = model.text
                    stateDescription = texts.description
                    if (menuActions.isNotEmpty()) customActions = menuActions
                },
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                val status = texts.status
                if (status != null) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        val color = when (model.status) {
                            QaStatus.answering -> extended.live
                            QaStatus.answered -> extended.success
                            else -> scheme.onSurfaceVariant
                        }
                        if (model.status == QaStatus.answering) {
                            Icon(ConclaveIcons.GraphicEqFill0, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
                        }
                        ConclaveText(status, line = "$identifier.status", style = MaterialTheme.typography.labelLarge, color = color)
                    }
                }
                ConclaveText(model.text, line = "$identifier.text", style = MaterialTheme.typography.bodyLarge)
                ConclaveText(texts.meta, line = "$identifier.meta", style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                if (model.answerText.isNotEmpty()) {
                    Row(Modifier.height(IntrinsicSize.Min)) {
                        Box(Modifier.width(2.dp).fillMaxHeight().background(scheme.outlineVariant))
                        Column(Modifier.padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            ConclaveText(model.answerText, line = "$identifier.answer", style = MaterialTheme.typography.bodyMedium)
                            val by = texts.answeredBy
                            if (by != null) {
                                ConclaveText(by, line = "$identifier.answeredBy", style = MaterialTheme.typography.bodySmall,
                                    color = scheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            if (isHost) {
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (model.pendingAction.isNotEmpty()) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    } else if (model.isEnabled) {
                        Icon(ConclaveIcons.MoreVertFill0, contentDescription = null, tint = scheme.onSurfaceVariant)
                    }
                    ConclaveText(model.upvotes.toString(), line = "$identifier.votes", style = rememberTabular(MaterialTheme.typography.labelLarge),
                        color = scheme.onSurfaceVariant, modifier = Modifier.semantics { contentDescription = texts.votes })
                }
            } else {
                FilterChip(
                    selected = model.hasUpvoted,
                    onClick = { if (qa.toggleUpvote(id = model.id) == ControlTapResult.dispatched) haptics.gesture(FeedbackKind.upvoteChanged) },
                    enabled = model.isEnabled,
                    label = { ConclaveText(model.upvotes.toString(), line = "$identifier.upvote.count", style = rememberTabular(MaterialTheme.typography.labelLarge), color = scheme.onSurface) },
                    leadingIcon = {
                        Icon(if (model.hasUpvoted) ConclaveIcons.ArrowUpwardFill1 else ConclaveIcons.ArrowUpwardFill0,
                            contentDescription = null, modifier = Modifier.size(18.dp))
                    },
                    modifier = Modifier.heightIn(min = 48.dp).testTag("$identifier.upvote").semantics {
                        contentDescription = conclaveStringOf(context, if (model.hasUpvoted) "qa_upvoted" else "qa_upvote")
                        stateDescription = texts.votes
                        selected = model.hasUpvoted
                    },
                )
            }
        }
        if (isHost) {
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, modifier = Modifier.testTag("$identifier.menu")) {
                for (action in hostActions) {
                    DropdownMenuItem(
                        text = { ConclaveText(conclaveString(qaHostActionName(action)), line = "$identifier.menu.$action") },
                        onClick = { run(action) },
                        modifier = Modifier.testTag("$identifier.menu.$action"),
                    )
                }
            }
        }
    }
}
