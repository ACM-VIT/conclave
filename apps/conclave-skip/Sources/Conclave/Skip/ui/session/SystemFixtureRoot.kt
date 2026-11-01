package conclave.module

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalComposeUiApi::class)
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

    CallKeepScreenOnEffect()

    val share = session.share
    if (share != null) {
        Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
            CompositionLocalProvider(LocalCallControls provides share.controls) {
                CallRoot(
                    shell = share.shell,
                    stage = share.stage,
                    renderers = StageRenderers.probes(share.renderers, RendererProbePattern.staticPattern),
                    onMinimize = {},
                )
            }
            HostingTheme(inCall = true) {
                ShareFixtureReadouts(session, Modifier.align(Alignment.TopStart))
            }
        }
        return
    }

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

                PipFixtureReadouts()

                ScreenAwakeFixtureReadouts()

                DiagnosticsFixtureReadouts()

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

@Composable
private fun ShareFixtureReadouts(session: SystemFixtureSession, modifier: Modifier) {
    val ext = LocalConclaveExtendedColors.current
    Column(
        modifier.safeDrawingPadding().padding(start = 8.dp, top = 8.dp).widthIn(max = 240.dp)
            .background(ext.labelScrim, RoundedCornerShape(8.dp)).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        ShareFixtureReadout(session.presenceReadout, SystemFixtureReadout.presenceKey)
        ShareFixtureReadout(session.shareReadout, SystemFixtureReadout.shareKey)
        ShareFixtureReadout(session.shareWindowReadout, SystemFixtureReadout.shareWindowKey)
        ShareFixtureReadout(session.shareNoticeReadout, SystemFixtureReadout.shareNoticeKey)
        ShareFixtureReadout(session.shareCommandsReadout, SystemFixtureReadout.shareCommandsKey)
        if (session.share?.phase == ShareFixturePhase.failed) {
            TextButton(
                onClick = { session.repostShareFailure() },
                modifier = Modifier.heightIn(min = 48.dp).testTag(SystemFixtureReadout.shareRepostKey),
            ) {
                Text("Show failure again", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

@Composable
private fun ShareFixtureReadout(text: String, tag: String) {
    Text(text, modifier = Modifier.testTag(tag), color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.labelSmall, maxLines = 4)
}
