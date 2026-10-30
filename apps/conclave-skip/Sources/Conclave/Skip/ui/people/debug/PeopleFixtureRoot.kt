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
import androidx.compose.runtime.LaunchedEffect
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
import kotlinx.coroutines.delay

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun PeopleFixtureRoot(stateName: String, patternName: String? = null, forceScreenReader: Boolean = false) {

    val qaState = PeopleWebinarFixtureScript.state(named = stateName)?.takeIf {
        it == PeopleWebinarFixtureState.qaAttendee5 || it == PeopleWebinarFixtureState.qaHostOpen7
    }
    val qaSession = remember(qaState) { qaState?.let { PeopleWebinarFixtureSession(state = it) } }
    val state = PeopleFixtureScript.state(named = stateName) ?: qaState?.let { PeopleWebinarFixtureScript.baseState(it) } ?: PeopleFixtureState.host6
    val session = remember(state, qaSession) {
        qaSession?.base ?: PeopleFixtureSession(state = state, pattern = StageFixtureScript.pattern(named = patternName), forceScreenReader = forceScreenReader)
    }
    LaunchedEffect(session) {
        if (qaSession != null) {
            qaSession.people.openQuestionsAndAnswers()
            return@LaunchedEffect
        }

        session.open(destination = PeopleFixtureScript.openDestination(state))
        if (state == PeopleFixtureState.lostHost) {
            delay(PeopleFixtureScript.lostHostDelayMillis.toLong())
            session.loseHost()
        }
        if (state == PeopleFixtureState.hostWaitingLate) {
            delay(PeopleFixtureScript.lateWaitingDelayMillis.toLong())
            session.deliverLateWaiting()
        }
    }
    Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        CallRoot(
            shell = session.shell,
            stage = session.stage,
            people = session.people,
            renderers = StageRenderers.probes(session.stageSession.renderers, session.stageSession.pattern),
            forceScreenReader = session.stageSession.forceScreenReader,
            onMinimize = { session.stageSession.minimize() },
        )
        HostingTheme(inCall = true) {
            PeopleFixtureControls(session, Modifier.align(Alignment.CenterStart))
        }
    }
}

@Composable
private fun PeopleFixtureControls(session: PeopleFixtureSession, modifier: Modifier) {
    var expanded by remember { mutableStateOf(true) }
    var refresh by remember { mutableIntStateOf(0) }
    val ext = LocalConclaveExtendedColors.current
    Column(
        modifier.padding(start = 8.dp).widthIn(max = 220.dp).background(ext.labelScrim, RoundedCornerShape(8.dp)).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        FixtureButton("Fixture", "people.fixture.toggle") { expanded = !expanded }
        if (expanded) {
            FixtureButton("Open", "people.fixture.open") { session.open(destination = PanelDestination.none); refresh++ }
            FixtureButton("Knock view", "people.fixture.knockView") { session.open(destination = PanelDestination.peopleWaiting); refresh++ }
            FixtureButton("Hand view", "people.fixture.handView") { session.open(destination = PanelDestination.peopleRaisedHands); refresh++ }
            FixtureButton("Speakers", "people.fixture.speakers") { session.runSpeakerScript(); refresh++ }
            FixtureButton("Mute row", "people.fixture.mute") { session.scriptedMute(); refresh++ }
            FixtureButton("Lose host", "people.fixture.loseHost") { session.loseHost(); refresh++ }
            FixtureButton("Refresh", "people.fixture.refresh") { refresh++ }
            val tick = refresh
            FixtureReadout(session.revisionReadout(), "people.revision", tick)
            FixtureReadout(session.recomposeReadout(), "people.recompose", tick)
            FixtureReadout(session.focusReadout(), "people.focus", tick)
            FixtureReadout(session.countersReadout(), "people.counters", tick)

            FixtureReadout(session.actionsReadout(), "people.actions", tick)
            FixtureReadout(session.noticesReadout(), "stage.notices", tick)
            FixtureReadout(session.panelReadout(), "panel.current", tick)
            FixtureReadout(session.renderersReadout(), "stage.renderers", tick)
        }
    }
}

@Composable
private fun FixtureButton(title: String, tag: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.heightIn(min = 48.dp).testTag(tag)) {

        Text(title, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun FixtureReadout(text: String, tag: String, tick: Int) {
    Text(text, modifier = Modifier.testTag(tag), color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.labelSmall, maxLines = 4)
}
