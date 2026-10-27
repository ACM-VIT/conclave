package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import java.util.Locale

/*
 * S60 2 d (SET-2) on Android. Audio output: the S30 CL8 AudioRouteList over the route owner's snapshot (read
 * directly, R23), RadioButton rows in one selectable group; a choice requests the route once, plays selectionChanged
 * once on dispatch and posts one polite announcement (R11), because the S20 route toast is suppressed while this
 * overlay covers the stage (D23). Microphone: the level meter (12 flat segments at 10 Hz, read only by its leaf),
 * "Unmute to test your microphone" while muted (C6-6: Android mutes the audio device module), and Record and replay
 * with Test gain only while canRecordMicTest (false until the SamplesReadyCallback capture lands, Q8). No input picker
 * and no Mic mode (the communication device carries the microphone). The test lives exactly as long as the page's
 * composition (DisposableEffect), never longer.
 */

@Composable
internal fun SettingsOutputPage(settings: SettingsPresenter, reservation: PaddingValues) {
    val owner = settings.routeOwner
    val route = owner.route
    val haptics = rememberConclaveHaptics()
    val view = LocalView.current
    val rows = mutableListOf<ConclaveAudioRouteRow>()
    for (option in route.options) {
        val name = if (option.name.isNotEmpty()) option.name else conclaveString(LobbyRouteRows.resourceName(option.kind.rawValue))
        val pending = route.phase == RouteSwitchPhase.switching && option.id == route.pendingId
        rows.add(ConclaveAudioRouteRow(id = option.id, kind = option.kind.rawValue, name = name,
            selected = option.id == route.currentId && !pending, pending = pending))
    }
    val switching = conclaveString("ds_in_progress")
    LazyColumn(Modifier.fillMaxSize().testTag("settings.page.output"), contentPadding = reservation) {
        item(key = "routes", contentType = "routes") {
            AudioRouteList(rows = rows, identifier = "settings.output.routes", switchingDescription = switching, onSelect = { id ->
                if (settings.requestRoute(id = id) == ControlTapResult.dispatched) {
                    haptics.gesture(FeedbackKind.selectionChanged)
                    val chosen = rows.firstOrNull { it.id == id }
                    if (chosen != null) {
                        @Suppress("DEPRECATION")
                        view.announceForAccessibility(chosen.name)
                    }
                }
            })
        }
        item(key = "footer", contentType = "footer") {
            ConclaveSectionFooter(text = conclaveString("set_output_footer"), identifier = "settings.output.footer")
        }
    }
}

@Composable
internal fun SettingsMicrophonePage(settings: SettingsPresenter, reservation: PaddingValues) {
    DisposableEffect(Unit) {
        settings.startMicTest()
        onDispose { settings.stopMicTest() }
    }
    val audio = settings.audio
    LazyColumn(Modifier.fillMaxSize().testTag("settings.page.microphone"), contentPadding = reservation) {
        item(key = "level", contentType = "level") {
            when {
                audio.isMuted -> ListItem(
                    headlineContent = { ConclaveText(conclaveString("set_speak_to_test"), line = "settings.mic.level.title") },
                    supportingContent = { ConclaveText(conclaveString("set_unmute_to_test"), line = "settings.mic.unmuteToTest") },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                    modifier = Modifier.testTag("settings.mic.level"),
                )
                audio.micPhase == MicTestPhase.starting -> ListItem(
                    headlineContent = { ConclaveText(conclaveString("set_mic_starting"), line = "settings.mic.starting") },
                    trailingContent = { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                    modifier = Modifier.testTag("settings.mic.level"),
                )
                else -> SettingsMicLevelItem(settings.micLevel)
            }
        }
        if (audio.canRecordMicTest) {
            item(key = "record", contentType = "action") { SettingsRecordReplayItem(settings, audio) }
            item(key = "gain", contentType = "gain") { SettingsTestGainItem(settings, audio) }
            item(key = "gainFooter", contentType = "footer") {
                ConclaveSectionFooter(text = conclaveString("set_test_gain_detail"), identifier = "settings.mic.gain.footer")
            }
        }
    }
}

/** The only reader of MicLevelMeter.segments: "Speak to test" with the meter; stateDescription, no live region (2 i). */
@Composable
private fun SettingsMicLevelItem(meter: MicLevelMeter) {
    val segments = meter.segments
    val title = conclaveString("set_speak_to_test")
    val state = conclaveString("set_level_state", segments, MicLevelPolicy.segmentCount)
    ListItem(
        headlineContent = { ConclaveText(title, line = "settings.mic.level.title") },
        trailingContent = { SettingsLevelMeter(segments, Modifier.width(120.dp)) },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.testTag("settings.mic.level").clearAndSetSemantics {
            contentDescription = title
            stateDescription = state
        },
    )
}

/** L6-2: 12 flat segments, onSurface filled and outlineVariant empty (never coral or green: level is not a status). */
@Composable
internal fun SettingsLevelMeter(segments: Int, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    Row(modifier.height(12.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        for (index in 0 until MicLevelPolicy.segmentCount) {
            Box(
                Modifier.weight(1f).height(12.dp).clip(RoundedCornerShape(2.dp))
                    .background(if (index < segments) scheme.onSurface else scheme.outlineVariant),
            )
        }
    }
}

/** Record and replay (C6-6): "Recording" during the 5 s capture, "Stop playback" while it replays. */
@Composable
private fun SettingsRecordReplayItem(settings: SettingsPresenter, audio: SettingsAudio) {
    val busy = audio.micPhase == MicTestPhase.recording || audio.micPhase == MicTestPhase.replaying
    val phaseName = SettingsCopy.micPhaseName(audio.micPhase)
    ListItem(
        headlineContent = { ConclaveText(conclaveString("set_record_replay"), line = "settings.mic.recordReplay.title") },
        supportingContent = {
            ConclaveText(if (busy && phaseName != null) conclaveString(phaseName) else conclaveString("set_record_replay_detail"),
                line = "settings.mic.recordReplay.value")
        },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.heightIn(min = 56.dp).testTag("settings.mic.recordReplay").clickable(enabled = !audio.isMuted, role = Role.Button) {
            if (busy) settings.micSampleFinished() else settings.recordMicSample()
        },
    )
}

/** Test gain 0 to 2 for this test only, stateDescription "%1$s times". */
@Composable
private fun SettingsTestGainItem(settings: SettingsPresenter, audio: SettingsAudio) {
    val state = conclaveString("set_test_gain_state", String.format(Locale.getDefault(), "%.1f", audio.testGain))
    ListItem(
        headlineContent = { ConclaveText(conclaveString("set_test_gain"), line = "settings.mic.gain.title") },
        supportingContent = {
            Column(Modifier.fillMaxWidth()) {
                Slider(value = audio.testGain.toFloat(), onValueChange = { settings.setTestGain(it.toDouble()) }, valueRange = 0f..2f, steps = 19,
                    modifier = Modifier.semantics { stateDescription = state }.testTag("settings.mic.gain"))
            }
        },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
    )
}
