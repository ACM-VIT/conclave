package conclave.module

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.coerceIn
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

private val lobbyPreviewControlsClearance = 72.dp

@Composable
internal fun LobbyPreviewCard(
    card: LobbyCardUi,
    wide: Boolean,
    visibleHeight: Dp,
    onMic: (Boolean) -> Unit,
    onCamera: (Boolean) -> Unit,
    onFlip: () -> Unit,
    onEffects: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val ext = LocalConclaveExtendedColors.current
    val shape = RoundedCornerShape(DesignTokens.radiusTile.dp)
    val compact = wide || LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val minimumVideoHeight = if (compact) 180.dp else 280.dp
    val maximumVideoHeight = if (compact) 320.dp else 420.dp
    BoxWithConstraints(modifier.fillMaxWidth().testTag("lobby.card")) {
        val natural = if (compact) maxWidth * (9f / 16f) else maxWidth
        val upper = (visibleHeight * (if (compact) 0.75f else 0.58f)).coerceIn(minimumVideoHeight, maximumVideoHeight)
        val videoHeight = natural.coerceIn(minimumVideoHeight, upper)
        Box(Modifier.fillMaxWidth().height(videoHeight).clip(shape).border(1.dp, ext.border, shape)) {
            LobbyPreviewVideo(card, compact, onFlip, Modifier.fillMaxSize().background(ext.tile))
            Row(
                modifier = Modifier.align(Alignment.BottomCenter).padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                LobbyToggles(card, onMic, onCamera, onEffects)
            }
        }
    }
}

@Composable
private fun LobbyPreviewVideo(card: LobbyCardUi, compact: Boolean, onFlip: () -> Unit, modifier: Modifier) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val previewLabel = conclaveString("pm_your_preview")
    val previewValue = when {
        card.preview == PreviewState.live && card.isFrontCamera -> conclaveString("ds_front")
        card.preview == PreviewState.live -> conclaveString("ds_back_camera")
        card.cameraIsUnavailable -> conclaveString("pm_camera_unavailable")
        else -> conclaveString("pm_camera_off")
    }
    Box(modifier.testTag("lobby.preview")) {
        Box(
            Modifier.fillMaxSize().semantics {
                contentDescription = previewLabel
                stateDescription = previewValue
            },
            contentAlignment = Alignment.Center,
        ) {
            if (card.showsSurface) LocalPreviewSurface(card.previewSessionId)
            Box(Modifier.fillMaxSize().padding(bottom = lobbyPreviewControlsClearance), contentAlignment = Alignment.Center) {
                if (!card.showsSurface) LobbyCameraOffContent(card, compact)
                if (card.preview == PreviewState.interrupted) {
                    Text(
                        conclaveString("pm_camera_paused"),
                        style = MaterialTheme.typography.bodyMedium,
                        color = scheme.onSurface,
                        modifier = Modifier.clip(CircleShape).background(ext.labelScrim).padding(horizontal = 10.dp, vertical = 4.dp),
                    )
                }
            }
        }
        Text(
            conclaveString("ds_you"),
            style = MaterialTheme.typography.labelMedium,
            color = scheme.onSurface,
            modifier = Modifier.align(Alignment.TopStart).padding(12.dp).clip(CircleShape).background(ext.labelScrim)
                .padding(horizontal = 8.dp, vertical = 3.dp).clearAndSetSemantics { },
        )
        if (card.preview == PreviewState.live) {
            ConclaveFlipCameraButton(isFront = card.isFrontCamera, onClick = onFlip,
                modifier = Modifier.align(Alignment.TopEnd).padding(12.dp), identifier = "lobby.flip")
        }
    }
}

private val LobbyCardUi.cameraIsUnavailable: Boolean
    get() = preview == PreviewState.unavailable || cameraPermission == MediaPermissionState.unavailable

@Composable
private fun LobbyCameraOffContent(card: LobbyCardUi, compact: Boolean) {
    val scheme = MaterialTheme.colorScheme
    val content: @Composable () -> Unit = {
        ConclaveAvatar(
            identity = ConclaveAvatarIdentity.make(name = card.avatarName, id = if (card.avatarSeed.isEmpty()) null else card.avatarSeed),
            diameter = if (compact) 56.dp else 76.dp,
        )
        if (card.preview == PreviewState.starting) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = scheme.onSurface)
        } else if (card.cameraIsUnavailable) {
            Text(conclaveString("pm_camera_unavailable"), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant,
                textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
    if (compact) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.padding(horizontal = 24.dp).clearAndSetSemantics { },
        ) { content() }
    } else {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.padding(horizontal = 24.dp).clearAndSetSemantics { },
        ) { content() }
    }
}

@Composable
private fun LobbyToggles(card: LobbyCardUi, onMic: (Boolean) -> Unit, onCamera: (Boolean) -> Unit, onEffects: () -> Unit) {
    ConclaveCallToggle(
        label = conclaveString("ds_microphone"),
        stateText = lobbyToggleStateText(
            stateText = if (card.micOn) conclaveString("ds_state_on") else conclaveString("ds_state_muted"),
            stateReason = permissionReasonText(LobbyMediaKind.microphone, card.micReason),
        ),
        icon = if (card.micOn) ConclaveIcons.MicFill1 else ConclaveIcons.MicOffFill1,
        visual = if (card.micOn) ConclaveCallControlVisual.On else ConclaveCallControlVisual.Off,
        checked = card.micOn,
        identifier = "lobby.mic",
        onToggle = { onMic(it) },
        width = 56.dp,
        feedback = LobbyToggleFeedbackPolicy.kind(isOn = card.micOn, permission = card.micPermission,
            onKind = FeedbackKind.micOn, offKind = FeedbackKind.micOff, canAskAgain = card.canAskAgainMicrophone),
    )
    ConclaveCallToggle(
        label = conclaveString("ds_camera"),
        stateText = lobbyToggleStateText(
            stateText = if (card.cameraOn) conclaveString("ds_state_on") else conclaveString("ds_state_off"),
            stateReason = permissionReasonText(LobbyMediaKind.camera, card.cameraReason),
        ),
        icon = if (card.cameraOn) ConclaveIcons.VideocamFill1 else ConclaveIcons.VideocamOffFill1,
        visual = if (card.cameraOn) ConclaveCallControlVisual.On else ConclaveCallControlVisual.Off,
        checked = card.cameraOn,
        identifier = "lobby.camera",
        onToggle = { onCamera(it) },
        width = 56.dp,
        enabled = card.cameraPermission != MediaPermissionState.unavailable,
        feedback = LobbyToggleFeedbackPolicy.kind(isOn = card.cameraOn, permission = card.cameraPermission,
            onKind = FeedbackKind.cameraOn, offKind = FeedbackKind.cameraOff, canAskAgain = card.canAskAgainCamera),
    )
    if (card.showsEffects) {
        ConclaveCallToggle(
            label = conclaveString("pm_effects"),
            stateText = if (card.isCameraBlocked) conclaveString("pm_effects_camera_off")
            else if (card.effectsActive) conclaveString("ds_state_on") else conclaveString("ds_state_off"),
            icon = ConclaveIcons.MoodFill1,
            visual = if (card.effectsActive) ConclaveCallControlVisual.Engaged else ConclaveCallControlVisual.On,
            checked = card.effectsActive,
            identifier = "lobby.effects",
            onToggle = { onEffects() },
            width = 56.dp,
            enabled = !card.isCameraBlocked,
        )
    }
}

private fun lobbyToggleStateText(stateText: String, stateReason: String): String =
    if (stateReason.isEmpty()) stateText else "$stateText, $stateReason"

@Composable
internal fun LocalPreviewSurface(sessionId: Int, modifier: Modifier = Modifier) {
    val controller = LocalPreviewController.shared
    key(sessionId) {
        AndroidView(
            factory = { context -> controller.makePreviewView(context).also { controller.attach(it) } },
            modifier = modifier.fillMaxSize().testTag("lobby.preview.surface"),
            onRelease = { view -> controller.detach(view) },
        )
    }
}
