package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp

/*
 * S30 0.7 CL13 (CTL-1): the Android Debug controls fixture on the S20 SL14 stage fixture route. MainActivity mounts it
 * for `conclave.stageFixture=controls-<state>` (BuildConfig.DEBUG plus FLAG_DEBUGGABLE; request in HD/requests/B4-T6.md).
 * The native call root with probe renderers and the standalone controls presenter (ControlsFixtureSession, shared with
 * iOS) provided through LocalCallControls. Never MeetingViewModel, WebRTC, audio, capture or network. Readouts sit
 * beside the stage, never inside it (PS 7.6).
 */

/**
 * True for the `controls-<state>` values of `conclave.stageFixture`. Public so MainActivity (the app module sees only
 * public declarations) can route them here without naming the internal `ControlsFixtureScript` (HD request B4-T6 R10).
 */
fun isControlsFixtureState(stateName: String): Boolean = ControlsFixtureScript.state(named = stateName) != null

/** Called only by MainActivity's explicit debug launch route. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun ControlsFixtureRoot(stateName: String) {
    val state = ControlsFixtureScript.state(named = stateName) ?: ControlsFixtureState.guest
    val session = remember(state) { ControlsFixtureSession(state = state) }
    Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        CompositionLocalProvider(LocalCallControls provides session.controls) {
            CallRoot(
                shell = session.shell,
                stage = session.stage,
                renderers = StageRenderers.probes(session.renderers, RendererProbePattern.staticPattern),
                onMinimize = {},
            )
        }
        HostingTheme(inCall = true) {
            ControlsFixtureControls(session, Modifier.align(Alignment.CenterStart))
        }
    }
}

@Composable
private fun ControlsFixtureControls(session: ControlsFixtureSession, modifier: Modifier) {
    var expanded by remember { mutableStateOf(true) }
    var refresh by remember { mutableIntStateOf(0) }
    val ext = LocalConclaveExtendedColors.current
    Column(
        modifier.padding(start = 8.dp).widthIn(max = 240.dp).background(ext.labelScrim, RoundedCornerShape(8.dp)).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        ControlsFixtureButton("Fixture", "controls.fixture.toggle") { expanded = !expanded }
        if (expanded) {
            ControlsFixtureButton("Request end", "controls.fixture.requestEnd") {
                session.requestEnd(from = MeetingConfirmationInvoker.call)
                refresh++
            }
            ControlsFixtureButton("Confirm end", "controls.fixture.confirmEnd") {
                val id = session.shell.session.confirmation?.id
                if (id != null) session.confirmEnd(id = id)
                refresh++
            }
            ControlsFixtureButton("Refresh", "controls.fixture.refresh") { refresh++ }
            val tick = refresh
            ControlsFixtureReadout(session.countersReadout(), "controls.counters", tick)
            ControlsFixtureReadout(session.barReadout(), "controls.bar", tick)
            ControlsFixtureReadout(session.compositionReadout(), "controls.composition", tick)
            ControlsFixtureReadout(session.explanationReadout(), "controls.explanation", tick)
            ControlsFixtureReadout(session.leaveReadout(), "controls.leave", tick)
            ControlsFixtureReadout(session.panelReadout(), "panel.current", tick)
            ControlsFixtureReadout(session.chromeReadout(), "chrome.transient", tick)
            ControlsFixtureReadout(session.renderersReadout(), "stage.renderers", tick)
        }
    }
}

@Composable
private fun ControlsFixtureButton(title: String, tag: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.heightIn(min = 48.dp).testTag(tag)) {
        // Debug fixture labels are not user-facing copy (the stage fixture does the same).
        Text(title, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun ControlsFixtureReadout(text: String, tag: String, tick: Int) {
    Text(text, modifier = Modifier.testTag(tag), color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.labelSmall, maxLines = 4)
}
