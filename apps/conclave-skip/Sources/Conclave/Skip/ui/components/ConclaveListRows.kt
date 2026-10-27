package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.semantics.heading
import java.util.Locale

/*
 * List rows (F00 C09) and the person row (F00 C10) as Material 3 ListItems. Each row is one accessibility node
 * (clickable, toggleable or selectable merge their content); trailing controls of the waiting row stay their own
 * nodes. Text wraps; maxLines defaults to no cap (OQ-2b-5).
 */

/** A title with its value as supporting text, read as one node. */
@Composable
internal fun ConclaveValueRow(title: String, value: String, identifier: String, modifier: Modifier = Modifier) {
    ListItem(
        headlineContent = { ConclaveText(title, line = "$identifier.title") },
        supportingContent = { ConclaveText(value, line = "$identifier.value") },
        modifier = modifier.testTag(identifier).semantics(mergeDescendants = true) {},
    )
}

/** A navigation row: the whole row is a button and, by Material convention, draws no chevron. */
@Composable
internal fun ConclaveNavigationRow(title: String, identifier: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    ListItem(
        headlineContent = { ConclaveText(title, line = "$identifier.title") },
        modifier = modifier.testTag(identifier).clickable(role = Role.Button, onClick = onClick),
    )
}

/** A settings switch row: one Switch node for the whole row; the Switch itself takes no clicks. */
@Composable
internal fun ConclaveToggleRow(
    title: String, checked: Boolean, identifier: String, onCheckedChange: (Boolean) -> Unit, modifier: Modifier = Modifier,
) {
    ListItem(
        headlineContent = { ConclaveText(title, line = "$identifier.title") },
        trailingContent = { Switch(checked = checked, onCheckedChange = null) },
        modifier = modifier.testTag(identifier).toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange),
    )
}

/** A destructive row: the headline in the error role, never coral. */
@Composable
internal fun ConclaveDestructiveRow(title: String, identifier: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    ListItem(
        headlineContent = { ConclaveText(title, line = "$identifier.title", color = MaterialTheme.colorScheme.error) },
        modifier = modifier.testTag(identifier).clickable(role = Role.Button, onClick = onClick),
    )
}

/** One choice of a single-choice group. */
internal data class ConclaveSelectableOption(val id: String, val title: String)

/**
 * A single-choice group: radio rows inside `selectableGroup()`. A choice plays `selectionChanged` through the
 * gesture route (F00 8); the Debug gallery passes a record-only route and records each decision.
 */
@Composable
internal fun ConclaveSelectableRows(
    options: List<ConclaveSelectableOption>, selectedId: String, identifier: String, onSelect: (String) -> Unit,
    modifier: Modifier = Modifier, haptics: ConclaveGestureHaptics = rememberConclaveHaptics(),
    onGesture: (FeedbackKind, GestureHapticDecision) -> Unit = { _, _ -> },
) {
    Column(modifier.testTag(identifier).selectableGroup()) {
        for (option in options) {
            val selected = option.id == selectedId
            ListItem(
                headlineContent = { ConclaveText(option.title, line = "$identifier.${option.id}") },
                leadingContent = { RadioButton(selected = selected, onClick = null) },
                modifier = Modifier.testTag("$identifier.${option.id}").selectable(selected = selected, role = Role.RadioButton,
                    onClick = {
                        onGesture(FeedbackKind.selectionChanged, haptics.gesture(FeedbackKind.selectionChanged))
                        onSelect(option.id)
                    }),
            )
        }
    }
}

// Person row (F00 C10, OQ-2b-8)

/** The leading avatar stand-in until FND-1's C07 avatar: a flat palette circle, decorative, no text. */
@Composable
internal fun ConclaveAvatarStandIn(paletteIndex: Int, modifier: Modifier = Modifier) {
    val palette = DesignTokens.avatarPalette
    val count = palette.count
    Box(modifier.size(40.dp).clip(CircleShape).background(Color(palette[((paletteIndex % count) + count) % count]))
        .clearAndSetSemantics { })
}

/**
 * A person: avatar, name, optional detail and status glyphs, read as one node whose state description carries
 * the status ("Muted, hand raised"). Status glyphs have no description of their own.
 */
@Composable
internal fun ConclavePersonRow(
    name: String, identifier: String, avatarPaletteIndex: Int, modifier: Modifier = Modifier, detail: String? = null,
    status: String? = null, statusIcons: List<ImageVector> = emptyList(), maxLines: Int = Int.MAX_VALUE,
) {
    ListItem(
        headlineContent = { ConclaveText(name, line = "$identifier.name", maxLines = maxLines) },
        supportingContent = if (detail == null) null else { { ConclaveText(detail, line = "$identifier.detail") } },
        leadingContent = { ConclaveAvatarStandIn(avatarPaletteIndex) },
        trailingContent = if (statusIcons.isEmpty()) null else {
            {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (icon in statusIcons) {
                        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        },
        modifier = modifier.testTag(identifier).semantics(mergeDescendants = true) {
            if (status != null) stateDescription = status
        },
    )
}

/**
 * The C10 waiting variant: the name is one node, then Deny (text) and Admit (tonal, never coral) as separate
 * focusable buttons described with the name ("Deny Sam", "Admit Sam").
 */
@Composable
internal fun ConclaveWaitingPersonRow(
    name: String, identifier: String, avatarPaletteIndex: Int, onDeny: () -> Unit, onAdmit: () -> Unit,
    modifier: Modifier = Modifier, maxLines: Int = Int.MAX_VALUE,
) {
    val denyLabel = conclaveString("ds_deny_name", name)
    val admitLabel = conclaveString("ds_admit_name", name)
    ListItem(
        headlineContent = {
            ConclaveText(name, line = "$identifier.name", maxLines = maxLines, modifier = Modifier.semantics(mergeDescendants = true) {})
        },
        leadingContent = { ConclaveAvatarStandIn(avatarPaletteIndex) },
        trailingContent = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onDeny, modifier = Modifier.heightIn(min = 48.dp).testTag("$identifier.deny")
                    .semantics { contentDescription = denyLabel }) {
                    ConclaveText(conclaveString("ds_deny"), line = "$identifier.deny")
                }
                FilledTonalButton(onClick = onAdmit, modifier = Modifier.heightIn(min = 48.dp).testTag("$identifier.admit")
                    .semantics { contentDescription = admitLabel }) {
                    ConclaveText(conclaveString("ds_admit"), line = "$identifier.admit")
                }
            }
        },
        modifier = modifier.testTag(identifier),
    )
}

// MARK: Section header and footer (F00 C11)

/**
 * A section header: titleSmall in onSurfaceVariant (never coral), the optional count at the end with tabular digits,
 * one merged heading node so the count reads with the title ("In this meeting, 5"). Long titles wrap; the count
 * stays. Empty sections are not rendered (the caller's rule).
 */
@Composable
internal fun ConclaveSectionHeader(title: String, identifier: String, modifier: Modifier = Modifier, count: Int? = null) {
    val scheme = MaterialTheme.colorScheme
    val style = MaterialTheme.typography.titleSmall
    Row(
        modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag(identifier)
            .semantics(mergeDescendants = true) { heading() },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ConclaveText(title, line = "$identifier.title", style = style, color = scheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        if (count != null) {
            ConclaveText(String.format(Locale.getDefault(), "%d", count), line = "$identifier.count",
                style = rememberTabular(style), color = scheme.onSurfaceVariant)
        }
    }
}

/** A section footer: bodySmall in onSurfaceVariant with 16 dp margins ("Only you see this layout."). */
@Composable
internal fun ConclaveSectionFooter(text: String, identifier: String, modifier: Modifier = Modifier) {
    ConclaveText(text, line = "$identifier.text", style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag(identifier))
}
