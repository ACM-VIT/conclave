package conclave.module

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

/*
 * The audio route list (S30 CL8, 3 d): RadioButton rows in one selectable group, shared by the in-call route sheet
 * (CTL-3) and the S10 lobby dialog. Rows come from the WP3 AudioRouteSnapshot through the caller's cache as plain
 * data, keyed by route id; names and supporting lines are the caller's copy (device names, "Connecting…", the
 * Bluetooth permission lines). The pending row shows a spinner instead of its radio and says so in its state
 * description. The caller plays `selectionChanged` on a person's choice; automatic changes never reach here.
 */

/** One route row. [kind] is the S30 AudioRouteKind raw value: speaker, receiver, bluetooth, wired, usb, hearingAid,
 *  unknown. */
internal data class ConclaveAudioRouteRow(
    val id: String, val kind: String, val name: String, val selected: Boolean, val pending: Boolean = false,
    val supporting: String? = null, val enabled: Boolean = true,
)

@Composable
internal fun AudioRouteList(
    rows: List<ConclaveAudioRouteRow>, identifier: String, switchingDescription: String, onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    Column(modifier.testTag(identifier).selectableGroup()) {
        for (row in rows) {
            key(row.id) {
                ListItem(
                    headlineContent = { ConclaveText(row.name, line = "$identifier.${row.id}.name") },
                    supportingContent = if (row.supporting != null) {
                        { ConclaveText(row.supporting, line = "$identifier.${row.id}.supporting", color = scheme.onSurfaceVariant) }
                    } else null,
                    leadingContent = { Icon(conclaveRouteIcon(row.kind), contentDescription = null, tint = scheme.onSurfaceVariant) },
                    trailingContent = {
                        if (row.pending) {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else {
                            RadioButton(selected = row.selected, onClick = null, enabled = row.enabled)
                        }
                    },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.testTag("$identifier.${row.id}")
                        .selectable(selected = row.selected, enabled = row.enabled, role = Role.RadioButton, onClick = { onSelect(row.id) })
                        .semantics { if (row.pending) stateDescription = switchingDescription },
                )
            }
        }
    }
}
