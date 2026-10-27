package conclave.module

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

/*
 * ENT-3 (S10 6 d RouteDialog, 6 l11): the Android audio output choice before the call, a Material simple selection
 * dialog in the system appearance: one radio row per communication device with the current one checked; choosing a
 * row records the prejoin intent (S10 0.8 C2) and dismisses; Back or a scrim tap cancels with no change. It never
 * routes audio (no live output or communication device write); the single routing owner applies the intent at join.
 */

/** One row: an AudioRouteKind raw value, the shown name and whether it is the current or chosen route. */
internal data class LobbyRouteRow(val id: String, val kind: String, val name: String, val selected: Boolean)

internal object LobbyRouteRows {
    /** Rows from the audio snapshot; a nameless option takes its kind's resource name. */
    fun rows(audio: LobbyAudioSnapshot, resolve: (String) -> String): List<LobbyRouteRow> {
        val rows = mutableListOf<LobbyRouteRow>()
        for (option in audio.outputs) {
            val name = if (option.name.isNotEmpty()) option.name else resolve(option.kind.rawValue)
            rows.add(LobbyRouteRow(id = option.id, kind = option.kind.rawValue, name = name,
                selected = option.id == audio.currentOutputId))
        }
        return rows
    }

    /** The resource name of a route kind's label (the SYS-2 ctl_route_ names). */
    fun resourceName(kind: String): String = when (kind) {
        "speaker" -> "ctl_route_speaker"
        "receiver" -> "ctl_route_phone"
        "bluetooth" -> "ctl_route_bluetooth"
        "wired" -> "ctl_route_wired"
        "usb" -> "ctl_route_usb"
        "hearingAid" -> "ctl_route_hearing_aid"
        else -> "ctl_route_speaker"
    }
}

@Composable
internal fun RouteDialog(rows: List<LobbyRouteRow>, onSelect: (String) -> Unit, onDismiss: () -> Unit) {
    val selectedDescription = conclaveString("pm_state_selected")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(conclaveString("ds_audio_output")) },
        text = {
            Column(Modifier.selectableGroup().testTag("lobby.route.dialog")) {
                for (row in rows) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 56.dp)
                            .selectable(selected = row.selected, role = Role.RadioButton, onClick = { onSelect(row.kind) })
                            .padding(horizontal = 16.dp)
                            .semantics { if (row.selected) stateDescription = selectedDescription }
                            .testTag("lobby.route." + row.id),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = row.selected, onClick = null)
                        Spacer(Modifier.width(16.dp))
                        Icon(conclaveRouteIcon(row.kind), contentDescription = null)
                        Spacer(Modifier.width(16.dp))
                        Text(row.name, style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
        },
        confirmButton = {},
    )
}
