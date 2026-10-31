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

fun isControlsFixtureState(stateName: String): Boolean = ControlsFixtureScript.state(named = stateName) != null

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

            ControlsFixtureReadout(session.moreReadout(), "controls.more", tick)
            ControlsFixtureReadout(session.handReadout(), "controls.hand", tick)
            ControlsFixtureReadout(session.routeReadout(), "controls.route", tick)
            ControlsFixtureReadout(session.shortcutsReadout(), "controls.shortcuts", tick)
            ControlsFixtureReadout(session.noticesReadout(), "stage.notices", tick)
            ControlsFixtureReadout(session.panelReadout(), "panel.current", tick)
            ControlsFixtureReadout(session.chromeReadout(), "chrome.transient", tick)
            ControlsFixtureReadout(session.renderersReadout(), "stage.renderers", tick)
        }
    }
}

@Composable
private fun ControlsFixtureButton(title: String, tag: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.heightIn(min = 48.dp).testTag(tag)) {

        Text(title, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun ControlsFixtureReadout(text: String, tag: String, tick: Int) {
    Text(text, modifier = Modifier.testTag(tag), color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.labelSmall, maxLines = 4)
}
