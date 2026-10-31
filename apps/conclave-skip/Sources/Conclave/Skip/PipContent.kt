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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun NativePipOverlay(stage: StagePresenter, phase: CallPresencePhase, modifier: Modifier = Modifier, rendersVideo: Boolean = true) {
    val choice = stage.pipTarget
    val chrome = if (choice.isEmpty) null else stage.tileChrome.entry(choice.userId).model
    val videoKey = if (choice.isEmpty || !rendersVideo) "" else stage.bindings.binding(choice.slotId).videoKey
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
