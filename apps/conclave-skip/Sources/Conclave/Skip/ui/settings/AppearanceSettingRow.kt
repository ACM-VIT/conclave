package conclave.module

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

@Composable
internal fun AppearanceSettingRow() {
    val preference = AppearancePreference.shared
    val mode = preference.mode
    var isChoosing by remember { mutableStateOf(false) }
    val choices = listOf(AppearanceMode.system, AppearanceMode.light, AppearanceMode.dark)
    val labels = listOf(conclaveString("appearance_system"), conclaveString("appearance_light"), conclaveString("appearance_dark"))
    val title = conclaveString("appearance_title")
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = { Text(labels[choices.indexOf(mode)]) },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.fillMaxWidth().clickable(role = Role.Button) { isChoosing = true }
            .testTag("settings.appearance"),
    )
    if (isChoosing) {
        AlertDialog(
            onDismissRequest = { isChoosing = false },
            title = { Text(title) },
            text = {
                Column(Modifier.selectableGroup()) {
                    choices.forEachIndexed { index, choice ->
                        Row(
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                .selectable(selected = mode == choice, role = Role.RadioButton, onClick = {
                                    preference.setMode(choice)
                                    isChoosing = false
                                })
                                .padding(vertical = 8.dp)
                                .testTag("settings.appearance.${choice.rawValue}"),
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = mode == choice, onClick = null)
                            Text(labels[index])
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { isChoosing = false }) { Text(conclaveString("ds_cancel")) }
            },
        )
    }
}
