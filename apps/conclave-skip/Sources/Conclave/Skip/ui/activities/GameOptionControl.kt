package conclave.module

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp

internal fun gameOptionSegmentsFit(labelWidthsPx: List<Float>, rowWidthPx: Float, density: Float): Boolean {
    if (labelWidthsPx.isEmpty()) return true
    val segment = rowWidthPx / labelWidthsPx.size
    val chrome = (12f * 2f + 18f + 8f) * density
    for (width in labelWidthsPx) {
        if (width + chrome > segment) return false
    }
    return true
}

@Composable
internal fun GameOptionControl(
    option: GameOptionModel,
    initialText: String,
    enabled: Boolean,
    onSelect: (String) -> Unit,
    onText: (String) -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("activities.option.${option.id}"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(option.label, style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant)
        val choices = option.choices.toList()
        when {
            option.kind == GameOptionModel.textKind -> GameOptionText(option, initialText, enabled, onText)
            choices.size <= ActivitiesCatalogPolicy.maxSegments -> GameOptionSegments(option, choices, enabled, onSelect)
            else -> GameOptionDialogRow(option, choices, enabled, onSelect)
        }
    }
}

@Composable
private fun GameOptionText(option: GameOptionModel, initialText: String, enabled: Boolean, onText: (String) -> Unit) {
    var text by rememberSaveable(option.id) { mutableStateOf(initialText) }
    val limit = option.maxLength
    OutlinedTextField(
        value = text,
        onValueChange = { value ->
            val next = if (limit > 0 && value.length > limit) value.take(limit) else value
            text = next
            onText(next)
        },
        label = { Text(option.label) },
        placeholder = if (option.placeholder.isEmpty()) null else ({ Text(option.placeholder) }),
        enabled = enabled,
        singleLine = true,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
        supportingText = if (limit > 0 && text.length >= maxOf(0, limit - ActivitiesCatalogPolicy.counterLead)) {
            { Text(activitiesCharacterCount(text.length, limit), style = rememberTabular(MaterialTheme.typography.bodySmall)) }
        } else null,
        modifier = Modifier.fillMaxWidth().testTag("activities.option.${option.id}.field"),
    )
}

@Composable
private fun GameOptionSegments(option: GameOptionModel, choices: List<GameChoiceModel>, enabled: Boolean, onSelect: (String) -> Unit) {
    val haptics = rememberConclaveHaptics()
    val measurer = rememberTextMeasurer()
    val style = MaterialTheme.typography.labelLarge
    val density = LocalDensity.current.density
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val rowWidth = constraints.maxWidth.toFloat()
        val widths = remember(choices, style, rowWidth) { choices.map { measurer.measure(it.label, style).size.width.toFloat() } }
        if (gameOptionSegmentsFit(widths, rowWidth, density)) {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                choices.forEachIndexed { index, choice ->
                    val isSelected = choice.id == option.value
                    SegmentedButton(
                        selected = isSelected,
                        onClick = {
                            if (!isSelected) {
                                haptics.gesture(FeedbackKind.selectionChanged)
                                onSelect(choice.id)
                            }
                        },
                        shape = SegmentedButtonDefaults.itemShape(index = index, count = choices.size),
                        enabled = enabled,
                        modifier = Modifier.testTag("activities.option.${option.id}.${choice.id}"),
                    ) { Text(choice.label, maxLines = 1) }
                }
            }
        } else {
            ConclaveSelectableRows(
                options = choices.map { ConclaveSelectableOption(it.id, it.label) },
                selectedId = option.value,
                identifier = "activities.option.${option.id}.rows",
                onSelect = { id -> if (enabled && id != option.value) onSelect(id) },
                haptics = haptics,
            )
        }
    }
}

@Composable
private fun GameOptionDialogRow(option: GameOptionModel, choices: List<GameChoiceModel>, enabled: Boolean, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val current = choices.firstOrNull { it.id == option.value }?.label ?: ""
    ListItem(
        headlineContent = { Text(current) },
        colors = ListItemDefaults.colors(),
        modifier = Modifier.fillMaxWidth().testTag("activities.option.${option.id}.value")
            .clickable(enabled = enabled, role = Role.Button) { open = true },
    )
    if (open) {
        AlertDialog(
            onDismissRequest = { open = false },
            title = { Text(option.label) },
            text = {
                ConclaveSelectableRows(
                    options = choices.map { ConclaveSelectableOption(it.id, it.label) },
                    selectedId = option.value,
                    identifier = "activities.option.${option.id}.dialog",
                    onSelect = { id ->
                        open = false
                        if (id != option.value) onSelect(id)
                    },
                )
            },
            confirmButton = { TextButton(onClick = { open = false }) { Text(conclaveString("ds_cancel")) } },
        )
    }
}
