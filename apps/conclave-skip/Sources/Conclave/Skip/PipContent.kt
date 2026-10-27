package conclave.module

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Minimal Picture-in-Picture surface: active speaker video when available,
 * otherwise their avatar. Mute and Leave stay in Android's PiP action bar.
 *
 * Legacy root only (S70 3 d, 3 m): Main.kt swaps to it while the legacy call screen ships
 * (PipController.showsLegacyPipContent). The native call root stays composed in PiP and draws
 * [NativePipOverlay] over its own canvas instead.
 */
@Composable
fun PipContent() {
    val videoState = PipController.pipVideoState

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0A0A0B)),
        contentAlignment = Alignment.Center
    ) {
        if (videoState.track != null && !videoState.cameraOff) {
            val trackKey = videoState.track.id()
            VideoTrackView(
                track = videoState.track,
                mirror = false,
                fit = false,
                useOverlaySurface = false,
                rendererKey = "pip:${videoState.surfaceVersion}:${videoState.targetId}:$trackKey",
                clearBeforeAttach = false
            )
        } else {
            PipAvatar(videoState.displayName)
        }
    }
}

@Composable
private fun PipAvatar(name: String) {
    val initial = name.trim().take(1).uppercase().ifEmpty { "?" }
    Box(
        modifier = Modifier
            .size(72.dp)
            .clip(CircleShape)
            .background(Color(0xFF232327)),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = initial,
            color = Color(0xFFFAFAFA),
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center
        )
    }
}

/**
 * S20 13 d content over the native call root while it is in a PiP window (S70 3 b, d, f, i; SYS-4). The root stays
 * composed and its canvas lays out only the PiP target over the whole window (PipStageLayoutPolicy), so no renderer is
 * disposed (PS 9.4); this layer adds what the target's video does not show: the name pill and muted glyph from 160 dp
 * wide, the avatar with the name while the camera is off, the solo text when nobody else is here, and the
 * Reconnecting or On hold pill. It reads the stage's PiP choice and that person's tile chrome only (one observable
 * entry), and is one semantics node: "Video of Avery" with the state "Muted". In-call tokens (always dark), no
 * gradients, no buttons (the window's actions are the system RemoteActions).
 */
@Composable
internal fun NativePipOverlay(stage: StagePresenter, phase: CallPresencePhase, modifier: Modifier = Modifier) {
    val choice = stage.pipTarget
    val chrome = if (choice.isEmpty) null else stage.tileChrome.entry(choice.userId).model
    val videoKey = if (choice.isEmpty) "" else stage.bindings.binding(choice.slotId).videoKey
    val hasVideo = videoKey.isNotEmpty() && (choice.isShare || !(chrome?.isCameraOff ?: true))
    BoxWithConstraints(modifier.fillMaxSize()) {
        val content = PipContentPolicy.content(
            choice = choice,
            name = chrome?.displayName ?: "",
            isMuted = chrome?.isMuted ?: false,
            hasVideo = hasVideo,
            phase = phase,
            windowWidth = maxWidth.value.toDouble(),
        )
        NativePipContentLayer(content, avatarDiameter = minOf(76f, maxOf(24f, maxWidth.value * 0.28f)))
    }
}

@Composable
private fun NativePipContentLayer(content: PipContentModel, avatarDiameter: Float) {
    val ext = LocalConclaveExtendedColors.current
    val scheme = MaterialTheme.colorScheme
    val solo = conclaveString("stg_solo_title")
    val description = if (content.kind == PipContentKind.solo) solo else conclaveString("sys_pip_content", content.name)
    val state = if (content.isMuted) conclaveString("stg_pip_muted") else ""
    Box(
        Modifier.fillMaxSize().testTag("pip.content").clearAndSetSemantics {
            contentDescription = description
            if (state.isNotEmpty()) stateDescription = state
        },
    ) {
        when (content.kind) {
            PipContentKind.solo -> Box(Modifier.fillMaxSize().background(ext.stage), contentAlignment = Alignment.Center) {
                Text(solo, style = MaterialTheme.typography.labelMedium, color = scheme.onSurface, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(12.dp))
            }
            PipContentKind.avatar -> Box(Modifier.fillMaxSize().background(ext.stage), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    ConclaveAvatar(identity = ConclaveAvatarIdentity.make(name = content.name, id = content.userId),
                        diameter = avatarDiameter.dp)
                    if (content.showsNamePill) {
                        Text(content.name, style = MaterialTheme.typography.labelSmall, color = scheme.onSurface, maxLines = 1,
                            overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            PipContentKind.video -> Unit
        }
        if (content.kind == PipContentKind.video && content.showsNamePill) {
            Surface(
                modifier = Modifier.align(Alignment.BottomStart).padding(8.dp),
                shape = CircleShape,
                color = ext.labelScrim,
                contentColor = scheme.onSurface,
            ) {
                Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (content.isMuted) {
                        Icon(ConclaveIcons.MicOffFill1, contentDescription = null, modifier = Modifier.size(14.dp), tint = scheme.onSurface)
                    }
                    Text(content.name, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        if (content.status != PipStatusPill.none) {
            val label = if (content.status == PipStatusPill.onHold) conclaveString("sys_pip_on_hold") else conclaveString("sys_pip_reconnecting")
            Surface(
                modifier = Modifier.align(Alignment.TopStart).padding(8.dp),
                shape = CircleShape,
                color = ext.labelScrim,
                contentColor = scheme.onSurface,
            ) {
                Text(label, style = MaterialTheme.typography.labelSmall, maxLines = 1,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp))
            }
        }
    }
}

/**
 * The S70 SX1 PiP readouts for the system fixture (HD request B5-T4): `sys.pip` (the last params) and
 * `sys.pipSuppressions` (count and last reason), as test tags with ASCII values.
 */
@Composable
internal fun PipFixtureReadouts(modifier: Modifier = Modifier) {
    val params = PipController.paramsReadout
    val suppressions = PipController.suppressionReadout
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(params, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.testTag("sys.pip"))
        Text(suppressions, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.testTag("sys.pipSuppressions"))
    }
}
