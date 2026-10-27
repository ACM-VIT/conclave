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

/*
 * S20 SL14 (STG-1, STG-4): the Android Debug stage fixture root. MainActivity mounts it for the intent extra
 * `conclave.stageFixture=<state>` (BuildConfig.DEBUG plus FLAG_DEBUGGABLE, request in HD/requests/B3-T2.md);
 * `conclave.stageFixturePattern=live` switches the probes to the live pattern and `conclave.stageForceScreenReader=true`
 * makes auto-hide behave as if TalkBack ran. Standalone presenters (StageFixtureSession, shared with iOS); never
 * MeetingViewModel, WebRTC, audio, capture or network. Readouts sit beside the stage, never inside it (PS 7.6).
 */

/** Called only by MainActivity's explicit debug launch route. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun StageFixtureRoot(stateName: String, patternName: String? = null, forceScreenReader: Boolean = false, chatStateName: String? = null) {
    val state = StageFixtureScript.state(named = stateName) ?: StageFixtureState.grid6
    val session = remember(state) {
        StageFixtureSession(state = state, pattern = StageFixtureScript.pattern(named = patternName), forceScreenReader = forceScreenReader)
    }
    LaunchedEffect(session) {
        // S40 0.9 (HD request B4-T1 R3): `conclave.chatFixture` layers the chat fixture on this stage fixture and opens Chat.
        val chatState = ChatFixtureDriver.state(named = chatStateName)
        if (chatState != null) ChatFixtureDriver.installOnStage(state = chatState, shell = session.shell)
    }
    Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        CallRoot(
            shell = session.shell,
            stage = session.stage,
            renderers = StageRenderers.probes(session.renderers, session.pattern),
            forceScreenReader = session.forceScreenReader,
            activitySession = session.activity,
            onMinimize = { session.minimize() },
        )
        HostingTheme(inCall = true) {
            StageFixtureControls(session, Modifier.align(Alignment.CenterStart))
        }
    }
}

@Composable
private fun StageFixtureControls(session: StageFixtureSession, modifier: Modifier) {
    var expanded by remember { mutableStateOf(true) }
    var refresh by remember { mutableIntStateOf(0) }
    val ext = LocalConclaveExtendedColors.current
    Column(
        modifier.padding(start = 8.dp).widthIn(max = 220.dp).background(ext.labelScrim, RoundedCornerShape(8.dp)).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        FixtureButton("Fixture", "stage.fixture.toggle") { expanded = !expanded }
        if (expanded) {
            FixtureButton("Magic Tap", "stage.fixture.magicTap") { session.magicTap(); refresh++ }
            FixtureButton("Speakers", "stage.fixture.speakers") { session.runSpeakerScript(); refresh++ }
            FixtureButton("Speak hidden", "stage.fixture.speakHidden") { session.speakHiddenParticipant(); refresh++ }
            FixtureButton("Next role", "stage.fixture.rolesNext") { session.nextRolesSweepStep(); refresh++ }
            FixtureButton("Reactions", "stage.fixture.reactions") { session.replayReactions(); refresh++ }
            FixtureButton("Join burst", "stage.fixture.joinBurst") { session.postJoinBurst(); refresh++ }
            FixtureButton("Dismiss toast", "stage.fixture.dismissToast") { session.dismissCurrentToast(); refresh++ }
            FixtureButton("Suspend toasts", "stage.fixture.suspendToasts") { session.toggleToastSuspension(); refresh++ }
            FixtureButton("Next caption", "stage.fixture.nextCaption") { session.nextCaption(); refresh++ }
            FixtureButton("Reconnect", "stage.fixture.reconnect") { session.toggleReconnecting(); refresh++ }
            FixtureButton("Refresh", "stage.fixture.refresh") { refresh++ }
            val tick = refresh
            FixtureReadout(session.renderersReadout(), "stage.renderers", tick)
            FixtureReadout(session.layoutReadout(), "stage.layout", tick)
            FixtureReadout(session.countersReadout(), "stage.counters", tick)
            FixtureReadout(session.announcementsReadout(), "stage.announcements", tick)
            FixtureReadout(session.noticesReadout(), "stage.notices", tick)
            FixtureReadout(session.captionsReadout(), "stage.captions.readout", tick)
            FixtureReadout(session.activityReadout(), "game.emits", tick)
            FixtureReadout(session.panelReadout(), "panel.current", tick)
            FixtureReadout(session.chromeReadout(), "chrome.transient", tick)
            FixtureReadout(session.recomposeReadout(), "stage.recompose", tick)
        }
    }
}

@Composable
private fun FixtureButton(title: String, tag: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.heightIn(min = 48.dp).testTag(tag)) {
        // Debug fixture labels are not user-facing copy (the hosting preview does the same).
        Text(title, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun FixtureReadout(text: String, tag: String, tick: Int) {
    Text(text, modifier = Modifier.testTag(tag), color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.labelSmall, maxLines = 3)
}
