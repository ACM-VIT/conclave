package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
            it.presence.adapters = CallNotificationBridge.fixtureAdapters(it.presence)
        }
    }
    LaunchedEffect(session) { session.start() }
    HostingTheme {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
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
        }
    }
}

@Composable
private fun FixtureCommand(label: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick) {
        Text(text = label)
    }
}
