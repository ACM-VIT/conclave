package conclave.module

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/**
 * S70 SX1 Debug system fixture root (Android). Main.kt mounts it for the Debug intent extra conclave.systemFixture
 * (FLAG_DEBUGGABLE checked, HD request B1-T2). It drives a standalone CallPresence through the real call notification
 * service, started with the mediaPlayback type alone, and never WebRTC, audio, capture or the network. The two
 * readouts carry the SX1 keys as test tags; the values are ASCII machine-readable text.
 */
@Composable
fun SystemFixtureRoot(stateName: String) {
    val state = SystemFixtureScript.state(named = stateName) ?: SystemFixtureState.presenceLive
    val session = remember(state) {
        SystemFixtureSession(state = state, providerMode = SystemFixtureProviderMode.fake).also {
            it.presence.adapters = CallDiagnostics.shared.withPresenceAdapter(
                CallScreenAwake.withScreenAwake(CallNotificationBridge.fixtureAdapters(it.presence))
            )
        }
    }
    LaunchedEffect(session) { session.start() }
    // SYS-5 (S70 4 d, l2): the Compose-scoped keep awake follows the fixture's snapshot (dumpsys window).
    CallKeepScreenOnEffect()
    // SYS-4 (S70 SX1, 3 l2, 3 l3): pip-speaker draws a full-bleed static pattern behind the readouts and Back minimizes
    // (PiP when eligible). PipController.isInCall stays false, so Main.kt keeps this root composed in PiP.
    val ledger = remember { RendererIdentityLedger() }
    BackHandler(enabled = state == SystemFixtureState.pipSpeaker) { PipManager.minimizeCurrent() }
    HostingTheme {
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            if (state == SystemFixtureState.pipSpeaker) {
                CompositionLocalProvider(LocalRendererLedger provides ledger) {
                    RendererProbe(key = "pip:fixture", slot = RendererSlot.pip, modifier = Modifier.fillMaxSize(),
                        pattern = RendererProbePattern.staticPattern)
                }
            }
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .safeDrawingPadding()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = session.presenceReadout,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onBackground,
                    modifier = Modifier.testTag(SystemFixtureReadout.presenceKey),
                )
                Text(
                    text = session.commandsReadout,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onBackground,
                    modifier = Modifier.testTag(SystemFixtureReadout.commandsKey),
                )
                FixtureCommand(conclaveString("sys_call_mute")) { session.send(SystemCallCommandKind.mute, source = SystemCallSource.notification) }
                FixtureCommand(conclaveString("sys_call_unmute")) { session.send(SystemCallCommandKind.unmute, source = SystemCallSource.notification) }
                FixtureCommand(conclaveString("ds_leave_call")) { session.send(SystemCallCommandKind.leave, source = SystemCallSource.notification) }
                // SYS-4 and SYS-8 (S70 3 l2, 8 l2): the sys.pip and sys.pipSuppressions readouts and the hand-off commands.
                PipFixtureReadouts()
                // SYS-5 (S70 4 l2): sys.awake and sys.proximity, and the route switch that releases proximity.
                ScreenAwakeFixtureReadouts()
                // SYS-15 (AC-SI18-1, AC-SI18-2): sys.diagListeners, sys.diagBuffer, a test error and a 6 s test hang.
                DiagnosticsFixtureReadouts()
                // SYS-3 (S70 2 l, SX1): sys.notifications (permission/banner/posted) and the admission and mention
                // posts for the silent AVD check (grants set by pm grant and revoke, never by a prompt).
                NotificationFixtureReadouts()
                FixtureCommand(conclaveString("ctl_route_phone")) { session.setAudioRoute(AudioRouteKind.receiver) }
                FixtureCommand(conclaveString("ctl_route_speaker")) { session.setAudioRoute(AudioRouteKind.speaker) }
                FixtureCommand(conclaveString("chat_link_open")) { NativeExternalHandoff.openWebLink("https://conclave.acmvit.in") }
                FixtureCommand(conclaveString("ds_open_settings")) { PermissionHelper.openAppSettings() }
            }
        }
    }
}

@Composable
private fun FixtureCommand(label: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick) {
        Text(text = label)
    }
}
