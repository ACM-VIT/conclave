package conclave.module

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

/*
 * S60 2 d (SET-3; C6-4, C6-5, C6-9, C6-29, D11, D21; RECONCILE R40, R43) on Android: Camera quality and Share quality as
 * radio lists in one selectable group (selectionChanged on a dispatched choice, 2 h), their Advanced pages (each setting
 * a ListItem opening a single-choice AlertDialog; the bitrate a Slider plus a numeric field in a dialog), Share device
 * audio while the S70 10 capability holds, and Connection. Presets are encoder ceilings over the persisted
 * NativeMediaQualityPreferences (the presenter writes them, the core re-runs its publish resolver). Connection reads
 * the one shared label (R21) and the ConnectionStatsModel leaf, collected only while the page is composed (one
 * DisposableEffect subscription, zero polls after Back). Pages take the InCallPage reservation as list padding (R50-1).
 */

@Composable
internal fun SettingsCameraQualityPage(settings: SettingsPresenter, reservation: PaddingValues, onPush: (String) -> Unit) {
    val video = settings.video
    val haptics = rememberConclaveHaptics()
    val presets = video.presets.toList()
    LazyColumn(Modifier.fillMaxSize().testTag("settings.page.cameraQuality"), contentPadding = reservation) {
        item("presets", "radios") {
            Column(Modifier.selectableGroup().testTag("settings.quality.presets")) {
                for (preset in presets) {
                    SettingsRadioItem(
                        title = conclaveString(SettingsCopy.cameraPresetName(preset)),
                        detail = conclaveString(SettingsCopy.cameraPresetDetailName(preset)),
                        selected = preset == video.cameraPreset,
                        enabled = !video.dataSaverOn,
                        identifier = "settings.quality.$preset",
                    ) {
                        if (settings.setCameraPreset(preset) == ControlTapResult.dispatched) haptics.gesture(FeedbackKind.selectionChanged)
                    }
                }
            }
        }
        item("footer", "footer") {
            ConclaveSectionFooter(text = conclaveString(SettingsCopy.cameraQualityFooterName(video.dataSaverOn, video.qualityCappedByHost)),
                identifier = "settings.quality.footer")
        }
        item("advanced", "nav") {
            SettingsNavItem(conclaveString("set_advanced"), conclaveString(SettingsCopy.resolutionName(video.custom.resolution)),
                "settings.quality.advanced", enabled = !video.dataSaverOn) { onPush(SettingsRoute.cameraAdvanced.rawValue) }
        }
        item("restore", "action") {
            SettingsActionItem(conclaveString("set_restore_quality"), "settings.quality.restore") { settings.restoreRecommendedQuality() }
        }
    }
}

@Composable
internal fun SettingsShareQualityPage(settings: SettingsPresenter, reservation: PaddingValues, onPush: (String) -> Unit) {
    val video = settings.video
    val haptics = rememberConclaveHaptics()
    val presets = video.screenSharePresets.toList()
    LazyColumn(Modifier.fillMaxSize().testTag("settings.page.screenShareQuality"), contentPadding = reservation) {
        item("presets", "radios") {
            Column(Modifier.selectableGroup().testTag("settings.share.presets")) {
                for (preset in presets) {
                    SettingsRadioItem(
                        title = conclaveString(SettingsCopy.screenSharePresetName(preset)),
                        detail = conclaveString(SettingsCopy.screenSharePresetDetailName(preset)),
                        selected = preset == video.screenSharePreset,
                        enabled = true,
                        identifier = "settings.share.$preset",
                    ) {
                        if (settings.setScreenSharePreset(preset) == ControlTapResult.dispatched) haptics.gesture(FeedbackKind.selectionChanged)
                    }
                }
            }
        }
        item("footer", "footer") {
            ConclaveSectionFooter(text = conclaveString("set_share_quality_footer"), identifier = "settings.share.footer")
        }
        item("advanced", "nav") {
            SettingsNavItem(conclaveString("set_advanced"), conclaveString(SettingsCopy.resolutionName(video.screenShareCustom.resolution)),
                "settings.share.advanced") { onPush(SettingsRoute.screenShareAdvanced.rawValue) }
        }
        item("restore", "action") {
            SettingsActionItem(conclaveString("set_restore_quality"), "settings.share.restore") { settings.restoreRecommendedScreenShare() }
        }
        if (video.canShareDeviceAudio) {
            // C6-29 (RECONCILE R43): shown only while the S70 10 capability holds.
            item("deviceAudio", "switch") {
                SettingsSwitchItem(conclaveString("set_share_device_audio"), video.shareDeviceAudioOn, "settings.share.deviceAudio",
                    supporting = conclaveString("set_share_device_audio_detail")) { settings.setShareDeviceAudio(it) }
            }
        }
    }
}

/** The camera or share Advanced page: each setting opens a single-choice dialog; the bitrate opens the slider dialog. */
@Composable
internal fun SettingsAdvancedPage(settings: SettingsPresenter, reservation: PaddingValues, isScreenShare: Boolean) {
    val video = settings.video
    val limits = if (isScreenShare) video.screenShareCustom else video.custom
    var open by remember { mutableStateOf("") }
    val prefix = if (isScreenShare) "settings.page.screenShareAdvanced" else "settings.page.cameraAdvanced"
    LazyColumn(Modifier.fillMaxSize().testTag(prefix), contentPadding = reservation) {
        item("resolution", "nav") {
            SettingsNavItem(conclaveString(if (isScreenShare) "set_max_size" else "set_resolution"),
                conclaveString(SettingsCopy.resolutionName(limits.resolution)), "settings.advanced.resolution") { open = "resolution" }
        }
        item("frameRate", "nav") {
            SettingsNavItem(conclaveString("set_frame_rate_title"), conclaveString("set_frame_rate", limits.frameRate),
                "settings.advanced.frameRate") { open = "frameRate" }
        }
        item("optimize", "nav") {
            SettingsNavItem(conclaveString("set_optimize_for"), conclaveString(settingsOptimizeName(limits.optimizeFor, isScreenShare)),
                "settings.advanced.optimize") { open = "optimize" }
        }
        item("pressure", "nav") {
            SettingsNavItem(conclaveString("set_under_pressure"), conclaveString(SettingsCopy.underPressureName(limits.underPressure, isScreenShare)),
                "settings.advanced.pressure") { open = "pressure" }
        }
        item("bitrate", "nav") {
            SettingsNavItem(conclaveString("set_bitrate"), conclaveString("set_bitrate_value", limits.bitrateKbps),
                "settings.advanced.bitrate") { open = "bitrate" }
        }
        if (isScreenShare) {
            item("footer", "footer") {
                ConclaveSectionFooter(text = conclaveString("set_share_quality_footer"), identifier = "settings.advanced.footer")
            }
        }
    }
    val dismiss = { open = "" }
    when (open) {
        "resolution" -> {
            val options = limits.resolutions.toList().map { SettingsChoice(it, conclaveString(SettingsCopy.resolutionName(it))) }
            SettingsChoiceDialog(conclaveString(if (isScreenShare) "set_max_size" else "set_resolution"), options, limits.resolution,
                "settings.advanced.resolution.dialog", onSelect = { value ->
                    if (isScreenShare) settings.setScreenShareResolution(value) else settings.setCameraResolution(value)
                    dismiss()
                }, onDismiss = dismiss)
        }
        "frameRate" -> {
            val options = limits.frameRates.toList().map { SettingsChoice(it.toString(), conclaveString("set_frame_rate", it)) }
            SettingsChoiceDialog(conclaveString("set_frame_rate_title"), options, limits.frameRate.toString(),
                "settings.advanced.frameRate.dialog", onSelect = { value ->
                    val fps = value.toIntOrNull()
                    if (fps != null) {
                        if (isScreenShare) settings.setScreenShareFrameRate(fps) else settings.setCameraFrameRate(fps)
                    }
                    dismiss()
                }, onDismiss = dismiss)
        }
        "optimize" -> {
            val options = limits.optimizeOptions.toList().map { SettingsChoice(it, conclaveString(settingsOptimizeName(it, isScreenShare))) }
            SettingsChoiceDialog(conclaveString("set_optimize_for"), options, limits.optimizeFor,
                "settings.advanced.optimize.dialog", onSelect = { value ->
                    if (isScreenShare) settings.setScreenShareOptimizeFor(value) else settings.setCameraOptimizeFor(value)
                    dismiss()
                }, onDismiss = dismiss)
        }
        "pressure" -> {
            val options = limits.pressureOptions.toList().map { SettingsChoice(it, conclaveString(SettingsCopy.underPressureName(it, isScreenShare))) }
            SettingsChoiceDialog(conclaveString("set_under_pressure"), options, limits.underPressure,
                "settings.advanced.pressure.dialog", onSelect = { value ->
                    if (isScreenShare) settings.setScreenShareUnderPressure(value) else settings.setCameraUnderPressure(value)
                    dismiss()
                }, onDismiss = dismiss)
        }
        "bitrate" -> SettingsBitrateDialog(limits, onConfirm = { kbps ->
            if (isScreenShare) settings.setScreenShareBitrate(kbps) else settings.setCameraBitrate(kbps)
            dismiss()
        }, onDismiss = dismiss)
    }
}

private fun settingsOptimizeName(rawValue: String, isScreenShare: Boolean): String =
    if (isScreenShare) SettingsCopy.screenShareOptimizeName(rawValue) else SettingsCopy.cameraOptimizeName(rawValue)

internal data class SettingsChoice(val value: String, val title: String)

/** The Material single-choice dialog: radio rows in one selectable group; a choice applies and closes. */
@Composable
private fun SettingsChoiceDialog(
    title: String, options: List<SettingsChoice>, selected: String, identifier: String,
    onSelect: (String) -> Unit, onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { ConclaveText(title, line = "$identifier.title") },
        text = {
            Column(Modifier.selectableGroup().verticalScroll(rememberScrollState()).testTag(identifier)) {
                for (option in options) {
                    ListItem(
                        headlineContent = { ConclaveText(option.title, line = "$identifier.${option.value}") },
                        leadingContent = { RadioButton(selected = option.value == selected, onClick = null) },
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
                        modifier = Modifier.heightIn(min = 56.dp)
                            .selectable(selected = option.value == selected, role = Role.RadioButton, onClick = { onSelect(option.value) }),
                    )
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.testTag("$identifier.cancel")) {
                ConclaveText(conclaveString("ds_cancel"), line = "$identifier.cancel.title")
            }
        },
    )
}

/** "Full-quality bitrate": a stepped Slider and a numeric field (Number keyboard); Done applies once. */
@Composable
private fun SettingsBitrateDialog(limits: CameraLimitsModel, onConfirm: (Int) -> Unit, onDismiss: () -> Unit) {
    var value by remember { mutableFloatStateOf(limits.bitrateKbps.toFloat()) }
    var field by remember { mutableStateOf(limits.bitrateKbps.toString()) }
    val min = limits.minBitrateKbps.toFloat()
    val max = limits.maxBitrateKbps.toFloat()
    val step = limits.bitrateStepKbps
    val steps = if (step > 0) ((limits.maxBitrateKbps - limits.minBitrateKbps) / step - 1).coerceAtLeast(0) else 0
    val valueText = conclaveString("set_bitrate_value", value.toInt())
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { ConclaveText(conclaveString("set_bitrate"), line = "settings.advanced.bitrate.title") },
        text = {
            Column(Modifier.fillMaxWidth().testTag("settings.advanced.bitrate.dialog")) {
                Slider(
                    value = value,
                    onValueChange = { next ->
                        value = next
                        field = next.toInt().toString()
                    },
                    valueRange = min..max,
                    steps = steps,
                    modifier = Modifier.semantics { stateDescription = valueText },
                )
                OutlinedTextField(
                    value = field,
                    onValueChange = { next ->
                        val digits = next.filter { it.isDigit() }.take(5)
                        field = digits
                        val parsed = digits.toIntOrNull()
                        if (parsed != null) value = parsed.toFloat().coerceIn(min, max)
                    },
                    label = { ConclaveText(conclaveString("set_bitrate_kbps_label"), line = "settings.advanced.bitrate.field.label") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    textStyle = MaterialTheme.typography.bodyLarge.copy(fontFeatureSettings = "tnum"),
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp).testTag("settings.advanced.bitrate.field"),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(value.toInt()) }, modifier = Modifier.testTag("settings.advanced.bitrate.done")) {
                ConclaveText(conclaveString("set_done"), line = "settings.advanced.bitrate.done.title")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.testTag("settings.advanced.bitrate.cancel")) {
                ConclaveText(conclaveString("ds_cancel"), line = "settings.advanced.bitrate.cancel.title")
            }
        },
    )
}

@Composable
internal fun SettingsConnectionPage(settings: SettingsPresenter, reservation: PaddingValues) {
    val general = settings.general
    val stats = settings.stats
    DisposableEffect(stats) {
        // C6-9: 1 Hz while the page is composed; leaving it unsubscribes.
        stats.subscribe()
        onDispose { stats.unsubscribe() }
    }
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val tint = when (general.connection) {
        ConnectionQualityLabel.good -> ext.success
        ConnectionQualityLabel.fair -> ext.warning
        ConnectionQualityLabel.poor, ConnectionQualityLabel.veryPoor -> scheme.error
        else -> scheme.onSurfaceVariant
    }
    val icon = when (general.connection) {
        ConnectionQualityLabel.good -> ConclaveIcons.CheckFill0
        ConnectionQualityLabel.fair -> ConclaveIcons.WarningFill1
        ConnectionQualityLabel.poor, ConnectionQualityLabel.veryPoor -> ConclaveIcons.SignalWifiBadFill0
        ConnectionQualityLabel.measuring -> ConclaveIcons.GraphicEqFill0
        ConnectionQualityLabel.unavailable -> ConclaveIcons.InfoFill0
    }
    LazyColumn(Modifier.fillMaxSize().testTag("settings.page.connection"), contentPadding = reservation) {
        item("quality", "status") {
            ListItem(
                leadingContent = { Icon(icon, contentDescription = null, tint = tint) },
                headlineContent = {
                    ConclaveText(conclaveString(SettingsCopy.connectionName(general.connection)), line = "settings.connection.quality.title")
                },
                supportingContent = {
                    ConclaveText(conclaveString(SettingsCopy.connectionSummaryName(general.connection)), line = "settings.connection.summary")
                },
                colors = ListItemDefaults.colors(containerColor = scheme.surface),
                modifier = Modifier.testTag("settings.connection.quality").semantics(mergeDescendants = true) {},
            )
        }
        if (general.lowBandwidth) {
            item("lowBandwidth", "status") {
                ListItem(
                    leadingContent = { Icon(ConclaveIcons.SignalWifiBadFill0, contentDescription = null, tint = scheme.onSurfaceVariant) },
                    headlineContent = { ConclaveText(conclaveString("set_low_bandwidth"), line = "settings.connection.lowBandwidth") },
                    colors = ListItemDefaults.colors(containerColor = scheme.surface),
                    modifier = Modifier.testTag("settings.connection.lowBandwidth"),
                )
            }
        }
        item("detailsHeader", "header") {
            ConclaveSectionHeader(title = conclaveString("set_details"), identifier = "settings.connection.details")
        }
        item("details", "details") { SettingsConnectionDetails(stats) }
        item("footer", "footer") {
            Column {
                ConclaveSectionFooter(text = conclaveString("set_connection_footer"), identifier = "settings.connection.footer")
                if (general.isRecovering) {
                    ConclaveSectionFooter(text = conclaveString("set_reconnecting"), identifier = "settings.connection.reconnecting")
                }
            }
        }
    }
}

/** The leaf that reads the 1 Hz values (2 k): label and value rows, values in the shared tabular style (R6-13). */
@Composable
private fun SettingsConnectionDetails(stats: ConnectionStatsModel) {
    val values = stats.values
    val noData = conclaveString("set_no_data")
    val latency = values.latencyMillis
    val loss = values.packetLossPercent
    val jitter = values.jitterMillis
    val video = values.videoBitrateKbps
    val audio = values.audioBitrateKbps
    val upload = values.uploadKbps
    val download = values.downloadKbps
    Column {
        SettingsStatItem(conclaveString("set_latency"), if (latency != null) conclaveString("set_ms", latency) else noData, "latency")
        SettingsStatItem(conclaveString("set_packet_loss"), if (loss != null) settingsPercent(loss) else noData, "packetLoss")
        SettingsStatItem(conclaveString("set_jitter"), if (jitter != null) conclaveString("set_ms", jitter) else noData, "jitter")
        SettingsStatItem(conclaveString("set_video_bitrate"), if (video != null) conclaveString("set_bitrate_value", video) else noData, "videoBitrate")
        SettingsStatItem(conclaveString("set_video_codec"), if (values.videoCodec.isNotEmpty()) values.videoCodec else noData, "videoCodec")
        SettingsStatItem(conclaveString("set_audio_bitrate"), if (audio != null) conclaveString("set_bitrate_value", audio) else noData, "audioBitrate")
        SettingsStatItem(conclaveString("set_upload"), if (upload != null) conclaveString("set_bitrate_value", upload) else noData, "upload")
        SettingsStatItem(conclaveString("set_download"), if (download != null) conclaveString("set_bitrate_value", download) else noData, "download")
    }
}

/** Packet loss in percent, locale formatted (the system formats percent; no resource needed). */
private fun settingsPercent(percent: Double): String {
    val format = java.text.NumberFormat.getPercentInstance()
    format.maximumFractionDigits = 1
    return format.format(percent / 100.0)
}

@Composable
private fun SettingsStatItem(title: String, value: String, identifier: String) {
    val scheme = MaterialTheme.colorScheme
    ListItem(
        headlineContent = { ConclaveText(title, line = "settings.connection.$identifier.title") },
        trailingContent = {
            ConclaveText(value, line = "settings.connection.$identifier.value",
                style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"), color = scheme.onSurfaceVariant)
        },
        colors = ListItemDefaults.colors(containerColor = scheme.surface),
        modifier = Modifier.testTag("settings.connection.$identifier").semantics(mergeDescendants = true) {},
    )
}

/** A radio row (Role.RadioButton in the page's selectable group); the RadioButton itself takes no clicks. */
@Composable
private fun SettingsRadioItem(
    title: String, detail: String?, selected: Boolean, enabled: Boolean, identifier: String, onSelect: () -> Unit,
) {
    ListItem(
        leadingContent = { RadioButton(selected = selected, onClick = null, enabled = enabled) },
        headlineContent = { ConclaveText(title, line = "$identifier.title") },
        supportingContent = if (detail != null) { { ConclaveText(detail, line = "$identifier.detail") } } else null,
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag(identifier)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onSelect),
    )
}

/** "Restore recommended settings": a primary-text button row. */
@Composable
private fun SettingsActionItem(title: String, identifier: String, onClick: () -> Unit) {
    ListItem(
        headlineContent = { ConclaveText(title, line = "$identifier.title", color = MaterialTheme.colorScheme.primary) },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag(identifier).clickable(role = Role.Button, onClick = onClick),
    )
}
