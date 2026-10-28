package conclave.module

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import java.util.Locale

/*
 * S50 1 d, 4 d, 5 d (PPL-3): the Android section headers with host actions. The title and count merge into one
 * heading node ("Waiting, 3") and every action stays its own node (F00 C11 d): Waiting gets Admit all in
 * primaryContainer (the screen's one coral fill, S50 4 e) and the overflow IconButton with "Deny all..." in error colors;
 * Raised hands gets one Lower all TextButton (no confirmation, Q4, Q9); In this meeting (Panelists in webinar mode)
 * gets Mute all..., which opens the Mute everyone dialog through the People root confirmation leaf. At font scale 1.5
 * and up the actions drop under the heading. Only this header reads `people.headerActions`, so a pending Admit all
 * recomposes the header items and nothing else (S50 4 k). Header actions hide while a search query is active.
 */

/** Sections whose header can carry host actions (S50 1 c). */
internal fun peopleHeaderCanHaveActions(sectionId: String): Boolean =
    sectionId == PeopleSectionID.waiting.rawValue || sectionId == PeopleSectionID.raisedHands.rawValue ||
        sectionId == PeopleSectionID.inMeeting.rawValue || sectionId == PeopleSectionID.panelists.rawValue

/** One section header (the LazyColumn header item). */
@Composable
internal fun PeopleSectionHeaderRow(people: PeoplePresenter, sectionId: String, count: Int, showsActions: Boolean) {
    val title = conclaveString(peopleSectionTitleName(sectionId))
    val identifier = "people.section.$sectionId.header"
    if (!showsActions || !peopleHeaderCanHaveActions(sectionId)) {
        ConclaveSectionHeader(title = title, identifier = identifier, count = count)
    } else {
        PeopleSectionHeaderWithActions(people, sectionId, count, title, identifier)
    }
}

@Composable
private fun PeopleSectionHeaderWithActions(people: PeoplePresenter, sectionId: String, count: Int, title: String, identifier: String) {
    val actions = people.headerActions
    if (!actions.hasActions(sectionId)) {
        ConclaveSectionHeader(title = title, identifier = identifier, count = count)
    } else if (LocalDensity.current.fontScale >= 1.5f) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp)) {
            PeopleHeaderHeading(title, count, identifier, Modifier.heightIn(min = 48.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                PeopleHeaderButtons(people, sectionId, actions)
            }
        }
    } else {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp).heightIn(min = 48.dp),
            verticalAlignment = Alignment.CenterVertically) {
            PeopleHeaderHeading(title, count, identifier, Modifier.weight(1f))
            PeopleHeaderButtons(people, sectionId, actions)
        }
    }
}

/** "Waiting, 3": the title and count as one heading node (S50 4 d, 4 i). */
@Composable
private fun PeopleHeaderHeading(title: String, count: Int, identifier: String, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val style = MaterialTheme.typography.titleSmall
    Row(modifier.testTag(identifier).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically) {
        ConclaveText(title, line = "$identifier.title", style = style, color = scheme.onSurfaceVariant)
        Spacer(Modifier.width(8.dp))
        ConclaveText(String.format(Locale.getDefault(), "%d", count), line = "$identifier.count", style = rememberTabular(style),
            color = scheme.onSurfaceVariant)
    }
}

/** The header's buttons, every target at least 48 dp (S50 4 i). */
@Composable
private fun PeopleHeaderButtons(people: PeoplePresenter, sectionId: String, actions: PeopleHeaderActions) {
    val context = LocalContext.current
    val reason = peopleReasonOf(context, actions.reason)
    when (sectionId) {
        PeopleSectionID.waiting.rawValue -> PeopleWaitingHeaderButtons(people, actions, reason)
        PeopleSectionID.raisedHands.rawValue -> PeopleHeaderTextAction(
            title = conclaveString("ppl_lower_all"), pending = actions.lowerAllPending, enabled = actions.isLowerAllEnabled,
            reason = reason, tag = "people.section.raisedHands.lowerAll", onClick = { people.lowerAllHands() })
        else -> PeopleHeaderTextAction(
            title = conclaveString("ppl_mute_all"), pending = actions.muteAllPending, enabled = actions.isMuteAllEnabled,
            reason = reason, tag = "people.section.$sectionId.muteAll", onClick = { people.requestMuteAll() })
    }
}

/** Admit all (primaryContainer, "Admitting..." with a spinner while in flight) and the Deny all overflow (S50 4 d). */
@Composable
private fun PeopleWaitingHeaderButtons(people: PeoplePresenter, actions: PeopleHeaderActions, reason: String) {
    val scheme = MaterialTheme.colorScheme
    val pendingLabel = conclaveString("ds_in_progress")
    val admitState = if (actions.admitAllPending) pendingLabel else if (actions.isAdmitAllEnabled) "" else reason
    Button(
        onClick = { people.admitAll() },
        enabled = actions.isAdmitAllEnabled,
        colors = ButtonDefaults.buttonColors(containerColor = scheme.primaryContainer, contentColor = scheme.onPrimaryContainer),
        contentPadding = ButtonDefaults.TextButtonContentPadding,
        modifier = Modifier.heightIn(min = 48.dp).testTag("people.section.waiting.admitAll")
            .semantics { if (admitState.isNotEmpty()) stateDescription = admitState },
    ) {
        if (actions.admitAllPending) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = LocalContentColor.current)
            Spacer(Modifier.width(8.dp))
            ConclaveText(conclaveString("ppl_admitting"), line = "people.section.waiting.admitting")
        } else {
            ConclaveText(conclaveString("stg_admit_all"), line = "people.section.waiting.admitAll")
        }
    }
    Box {
        var overflow by remember { mutableStateOf(false) }
        val denyAll = conclaveString("ppl_deny_all")
        val sections = remember(denyAll) {
            listOf(MenuSectionModel(id = "people.waiting", items = skip.lib.Array(listOf(
                MenuItemModel(id = "denyAll", title = denyAll, concept = "", role = MenuItemRole.destructive, isOn = false,
                    isEnabled = true, disabledReason = ""),
            ))))
        }
        IconButton(onClick = { overflow = true }, enabled = actions.isDenyAllEnabled,
            modifier = Modifier.testTag("people.section.waiting.more")) {
            Icon(ConclaveIcons.MoreVertFill0, contentDescription = conclaveString("ppl_more_waiting"), tint = LocalContentColor.current)
        }
        ConclaveDropdownMenu(
            expanded = overflow,
            onDismissRequest = { overflow = false },
            sections = sections,
            identifier = "people.section.waiting.menu",
            onSelect = {
                overflow = false
                people.requestDenyAll()
            },
        )
    }
}

/** Lower all and Mute all...: a TextButton in primary (C01 text style), a spinner while in flight. */
@Composable
private fun PeopleHeaderTextAction(title: String, pending: Boolean, enabled: Boolean, reason: String, tag: String, onClick: () -> Unit) {
    val pendingLabel = conclaveString("ds_in_progress")
    val state = if (pending) pendingLabel else if (enabled) "" else reason
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.heightIn(min = 48.dp).testTag(tag).semantics { if (state.isNotEmpty()) stateDescription = state },
    ) {
        if (pending) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = LocalContentColor.current)
            Spacer(Modifier.width(8.dp))
        }
        ConclaveText(title, line = tag)
    }
}
