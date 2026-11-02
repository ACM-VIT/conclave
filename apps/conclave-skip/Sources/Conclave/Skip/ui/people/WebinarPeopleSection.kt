package conclave.module

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.clickable
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.util.Locale
import kotlinx.coroutines.launch

internal data class WebinarAttendeeTexts(val name: String, val sub: String, val states: String, val actionLabel: String)

internal fun webinarAttendeeTextsOf(context: Context, model: PersonRowModel, queueCount: Int): WebinarAttendeeTexts {
    val name = model.name
    val sub = if (model.detail == PersonDetail.stageInvited) conclaveStringOf(context, "ppl_detail_invited")
        else conclaveStringOf(context, "ds_attendee")
    val states = mutableListOf<String>()
    if (model.isHandRaised) {
        states.add(conclaveStringOf(context, "ds_state_hand_raised"))
        if (model.handOrder > 0 && queueCount > 0) states.add(conclaveStringOf(context, "ppl_queue_position", model.handOrder, queueCount))
    }
    if (model.pendingAction.isNotEmpty()) states.add(conclaveStringOf(context, "ds_in_progress"))
    val action = model.actions.first
    val label = if (action?.action == PersonActionID.cancelStageInvite) conclaveStringOf(context, "ppl_cancel_label", name)
        else conclaveStringOf(context, "ppl_bring_label", name)
    return WebinarAttendeeTexts(name = name, sub = sub, states = states.joinToString(", "), actionLabel = label)
}

@Composable
internal fun WebinarAttendeeRow(people: PeoplePresenter, rowKey: String, sectionId: String, queueCount: Int) {
    val entry = people.rows.entry(rowKey)
    val model = entry.model
    val context = LocalContext.current
    val texts = remember(model, queueCount, context) { webinarAttendeeTextsOf(context, model, queueCount) }
    val identity = remember(model.avatarSeed) { ConclaveAvatarIdentity.fromSeed(model.avatarSeed) }
    val identifier = "people.row.$sectionId.${model.id}"
    val scheme = MaterialTheme.colorScheme
    val hand = LocalConclaveExtendedColors.current.handRaised
    SideEffect { people.recompose?.record("$sectionId:${model.id}") }
    val action = model.actions.first
    val perform: () -> Unit = {
        if (action != null) people.perform(action.action, rowId = model.id, source = PeopleActionSource.rowMenu)
    }
    val actions = if (action != null && action.isEnabled) {
        listOf(CustomAccessibilityAction(texts.actionLabel) { perform(); true })
    } else emptyList()
    ListItem(
        headlineContent = { ConclaveText(texts.name, line = "$identifier.name", maxLines = 2, overflow = TextOverflow.Ellipsis) },
        supportingContent = { ConclaveText(texts.sub, line = "$identifier.detail") },
        leadingContent = { ConclaveAvatar(identity, ConclaveAvatarSize.row.diameter.dp) },
        trailingContent = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (model.isHandRaised && model.handOrder > 0) {
                    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.clearAndSetSemantics { }) {
                        ConclaveText(String.format(Locale.getDefault(), "%d", model.handOrder), line = "$identifier.queue",
                            style = rememberTabular(MaterialTheme.typography.labelLarge), color = hand)
                        Icon(ConclaveIcons.FrontHandFill1, contentDescription = null, tint = hand, modifier = Modifier.size(20.dp))
                    }
                }
                if (action != null) {
                    val pending = model.pendingAction.isNotEmpty()
                    if (action.action == PersonActionID.bringOnStage) {
                        FilledTonalButton(onClick = perform, enabled = action.isEnabled,
                            modifier = Modifier.heightIn(min = 48.dp).testTag("$identifier.bringOnStage")
                                .semantics { contentDescription = texts.actionLabel }) {
                            if (pending) {
                                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                                ConclaveText(conclaveString("ppl_inviting"), line = "$identifier.inviting",
                                    modifier = Modifier.padding(start = 8.dp))
                            } else {
                                ConclaveText(conclaveString("ppl_bring_on_stage"), line = "$identifier.bring")
                            }
                        }
                    } else {
                        TextButton(onClick = perform, enabled = action.isEnabled,
                            modifier = Modifier.heightIn(min = 48.dp).testTag("$identifier.cancelInvite")
                                .semantics { contentDescription = texts.actionLabel }) {
                            if (pending) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                            else ConclaveText(conclaveString("ppl_cancel_invite"), line = "$identifier.cancel")
                        }
                    }
                }
            }
        },
        colors = ListItemDefaults.colors(containerColor = scheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag(identifier)
            .semantics { if (texts.states.isNotEmpty()) stateDescription = texts.states }
            .semantics { if (actions.isNotEmpty()) customActions = actions },
    )
}

@Composable
internal fun WebinarWatchingRow(people: PeoplePresenter) {
    val count = people.attendeeCount
    ListItem(
        headlineContent = { ConclaveText(conclavePlural("ppl_watching", count, count), line = "people.attendees.watching") },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.testTag("people.attendees.watching"),
    )
}

@Composable
internal fun WebinarAttendeesHeader(people: PeoplePresenter) {
    ConclaveSectionHeader(title = conclaveString("ppl_attendees"), identifier = "people.section.attendees.header",
        count = people.attendeeCount)
}

internal fun webinarFooterName(kind: WebinarFooterKind): String? = when (kind) {
    WebinarFooterKind.empty -> "ppl_attendees_empty"
    WebinarFooterKind.quiet -> "ppl_attendees_footer"
    WebinarFooterKind.queuePending -> "ppl_queue_pending"
    else -> null
}

@Composable
internal fun WebinarAttendeesFooter(people: PeoplePresenter, snapshot: PeopleSnapshot) {
    val count = people.attendeeCount
    val queue = snapshot.section(PeopleSectionID.raisedHands)?.count ?: 0
    val invited = snapshot.section(PeopleSectionID.attendees)?.count ?: 0
    val kind = WebinarPeoplePolicy.footer(attendeeCount = count, queueCount = queue, invitedCount = invited,
        queueKnown = snapshot.webinarQueueKnown)
    val name = webinarFooterName(kind)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    Column {
        if (name != null) ConclaveSectionFooter(text = conclaveString(name), identifier = "people.section.attendees.footer")
        if (kind == WebinarFooterKind.empty) {
            ListItem(
                headlineContent = { ConclaveText(conclaveString("ppl_share_webinar_link"), line = "people.attendees.share") },
                leadingContent = { Icon(ConclaveIcons.ShareFill0, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
                colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                modifier = Modifier.testTag("people.attendees.share").clickable(role = Role.Button) {
                    scope.launch {
                        val link = people.host.ensureWebinarLink() ?: return@launch
                        if (link.isNotEmpty()) stageShareMeetingLink(context, link, conclaveStringOf(context, "stg_webinar_fallback_title"))
                    }
                },
            )
        }
    }
}
