package conclave.module

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/*
 * S50 PL2, 4 d (PPL-3): the Android waiting row, a Material 3 ListItem with the 40 dp avatar, the name (two lines) and
 * two explicit targets: Deny as a TextButton in onSurfaceVariant and Admit as a FilledTonalButton (C01 tonal,
 * secondaryContainer; never coral, F00 C10 e). The row itself is not clickable and has no swipe (AND 7.8). At font scale
 * 1.5 and up the buttons drop under the name through supportingContent. While its own Admit or Deny is in flight the
 * buttons become one spinner with "In progress"; recovering, offline or a bulk admission keeps them visible but
 * disabled, with the reason as the name's state description. Reads only its WaitingRowEntry; texts resolve once per
 * model change.
 */

/** The waiting row's resolved texts (S50 4 g, 4 i). */
internal data class WaitingRowTexts(
    val name: String,
    val deny: String,
    val admit: String,
    val denyLabel: String,
    val admitLabel: String,
    val state: String,
)

internal fun waitingRowTextsOf(context: Context, model: WaitingRowModel): WaitingRowTexts {
    val state = if (model.pendingAction.isNotEmpty()) conclaveStringOf(context, "ds_in_progress")
        else if (model.isEnabled) "" else peopleReasonOf(context, model.reason)
    return WaitingRowTexts(
        name = model.name,
        deny = conclaveStringOf(context, "ds_deny"),
        admit = conclaveStringOf(context, "ds_admit"),
        denyLabel = conclaveStringOf(context, "ds_deny_name", model.name),
        admitLabel = conclaveStringOf(context, "ds_admit_name", model.name),
        state = state,
    )
}

/** The unavailable reasons a waiting row or a header action can carry (S50 4 f). */
internal fun peopleReasonOf(context: Context, reason: String): String = when (reason) {
    PeopleActionReason.reconnecting, PeopleActionReason.notJoined -> conclaveStringOf(context, "ds_unavailable_reconnecting")
    PeopleActionReason.offline -> conclaveStringOf(context, "ds_unavailable_offline")
    PeopleActionReason.pending -> conclaveStringOf(context, "ds_in_progress")
    else -> ""
}

/** One waiting request (S50 4 d). */
@Composable
internal fun WaitingRow(people: PeoplePresenter, rowKey: String, modifier: Modifier = Modifier) {
    val entry = people.waiting.entry(rowKey)
    val model = entry.model
    val context = LocalContext.current
    val texts = remember(model, context) { waitingRowTextsOf(context, model) }
    val identity = remember(model.avatarSeed) { ConclaveAvatarIdentity.fromSeed(model.avatarSeed) }
    val identifier = "people.row.${model.id}"
    // Font scale 1.5 and up: the buttons move under the name (S50 4 d), nothing is clipped at 2.0.
    val stacked = LocalDensity.current.fontScale >= 1.5f
    // people.recompose.waiting:<rowId> (PL12): the fixture ledger counts row compositions; production passes none.
    SideEffect { people.recompose?.record("${PeopleSectionID.waiting.rawValue}:${model.id}") }
    ListItem(
        headlineContent = {
            ConclaveText(texts.name, line = "$identifier.name", maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.semantics { if (texts.state.isNotEmpty()) stateDescription = texts.state })
        },
        supportingContent = if (stacked) { { WaitingRowButtons(people, model, texts, identifier) } } else null,
        leadingContent = { ConclaveAvatar(identity, ConclaveAvatarSize.row.diameter.dp) },
        trailingContent = if (stacked) null else { { WaitingRowButtons(people, model, texts, identifier) } },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = modifier.heightIn(min = 56.dp).testTag(identifier),
    )
}

/** Deny then Admit, 48 dp targets labelled with the name (F00 C10 g), or the one spinner while in flight. */
@Composable
private fun WaitingRowButtons(people: PeoplePresenter, model: WaitingRowModel, texts: WaitingRowTexts, identifier: String) {
    if (model.pendingAction.isNotEmpty()) {
        Box(
            Modifier.size(48.dp).testTag("$identifier.pending").semantics {
                contentDescription = texts.name
                stateDescription = texts.state
            },
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        }
    } else {
        val scheme = MaterialTheme.colorScheme
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(
                onClick = { people.perform(PersonActionID.deny, rowId = model.id, source = PeopleActionSource.rowMenu) },
                enabled = model.isEnabled,
                colors = ButtonDefaults.textButtonColors(contentColor = scheme.onSurfaceVariant),
                modifier = Modifier.heightIn(min = 48.dp).testTag("$identifier.deny")
                    .semantics { contentDescription = texts.denyLabel },
            ) {
                ConclaveText(texts.deny, line = "$identifier.deny")
            }
            FilledTonalButton(
                onClick = { people.perform(PersonActionID.admit, rowId = model.id, source = PeopleActionSource.rowMenu) },
                enabled = model.isEnabled,
                modifier = Modifier.heightIn(min = 48.dp).testTag("$identifier.admit")
                    .semantics { contentDescription = texts.admitLabel },
            ) {
                ConclaveText(texts.admit, line = "$identifier.admit")
            }
        }
    }
}
