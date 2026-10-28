package conclave.module

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp

internal data class NativeIconArtwork(
    val id: String, val property: String, val inputSHA256: String,
    val mirrors: Boolean, val vector: () -> ImageVector,
)

internal data class NativeIconBinding(
    val id: String, val caption: String, val role: String, val label: String?, val value: String?,
    val fillBasis: String, val decisionId: String?, val vector: () -> ImageVector,
) {
    val summary: String
        get() = listOfNotNull(role, label?.let { "label $it" }, value?.let { "value $it" },
            decisionId?.let { "$fillBasis $it" } ?: fillBasis).joinToString("; ")
}

@Composable
internal fun NativeIconGalleryControls(controller: NativeIconRasterController) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    var constructed by remember { mutableStateOf<Int?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Icons", style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Constructed vectors: ${constructed?.toString() ?: "not counted"}",
                modifier = Modifier.weight(1f).testTag("icons.lazy.count"))

            TextButton(onClick = { constructed = ConclaveIcons.initializedCount() },
                modifier = Modifier.heightIn(min = 48.dp).testTag("icons.lazy.refresh")) { Text("Count") }
        }
        TextButton(onClick = { expanded = !expanded }, modifier = Modifier.heightIn(min = 48.dp)
            .testTag("icons.gallery.toggle").semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }) {
            Text(if (expanded) "Hide icon gallery" else "Show icon gallery")
        }
        if (expanded) {
            Text("Inert samples. No devices, calls or feedback.")
            NativeIconSampleControls()
            LazyColumn(Modifier.fillMaxWidth().height(320.dp).testTag("icons.gallery.rows"),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(NativeIconCatalog.bindings, key = { it.id }) { row -> NativeIconBindingRow(row) }
            }
        }
        NativeIconRasterControls(controller)
    }
}

@Composable
private fun NativeIconBindingRow(row: NativeIconBinding) {

    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("icons.binding.${row.id}").semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(imageVector = row.vector(), contentDescription = null, modifier = Modifier.size(24.dp))
        Column(Modifier.weight(1f)) {
            Text(row.caption, style = MaterialTheme.typography.bodyMedium)
            Text(row.summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun NativeIconSampleControls() {
    var microphone by rememberSaveable { mutableStateOf(true) }
    var captions by rememberSaveable { mutableStateOf(false) }

    Box(Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).testTag("icons.sample.microphone")
        .toggleable(value = microphone, role = Role.Switch, onValueChange = { microphone = it })
        .semantics { contentDescription = "Microphone"; stateDescription = if (microphone) "On" else "Muted" },
        contentAlignment = Alignment.Center) {
        Icon(if (microphone) ConclaveIcons.MicFill1 else ConclaveIcons.MicOffFill1, contentDescription = null)
    }

    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("icons.sample.captions")
        .toggleable(value = captions, role = Role.Switch, onValueChange = { captions = it })
        .semantics { stateDescription = if (captions) "On" else "Off" },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Icon(if (captions) ConclaveIcons.ClosedCaptionFill1 else ConclaveIcons.ClosedCaptionFill0, contentDescription = null)
        Text("Captions", modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
        Switch(checked = captions, onCheckedChange = null)
    }
}

@Composable
private fun NativeIconRasterControls(controller: NativeIconRasterController) {
    Text("Native software raster fixture", style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
    Text(controller.status, modifier = Modifier.testTag("icons.raster.status"))
    TextButton(enabled = controller.canStart, onClick = { controller.start(IconRasterPlan.Geometry) },
        modifier = Modifier.heightIn(min = 48.dp).testTag("icons.raster.geometry")) { Text("Start geometry captures") }
    TextButton(enabled = controller.canStart, onClick = { controller.start(IconRasterPlan.Artwork) },
        modifier = Modifier.heightIn(min = 48.dp).testTag("icons.raster.artwork")) { Text("Start artwork captures") }
    TextButton(enabled = controller.canStart, onClick = { controller.start(IconRasterPlan.ReadinessFailure) },
        modifier = Modifier.heightIn(min = 48.dp).testTag("icons.raster.failReadiness")) { Text("Test incomplete readiness export") }
    TextButton(enabled = controller.canStart, onClick = { controller.start(IconRasterPlan.ExportFailure) },
        modifier = Modifier.heightIn(min = 48.dp).testTag("icons.raster.failExport")) { Text("Test incomplete encoding export") }
    TextButton(enabled = controller.busy, onClick = { controller.cancel("explicit cancel") },
        modifier = Modifier.heightIn(min = 48.dp).testTag("icons.raster.cancel")) { Text("Cancel captures") }
}
