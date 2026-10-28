package conclave.module

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
import androidx.compose.ui.unit.coerceIn
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import androidx.compose.ui.viewinterop.AndroidView

/*
 * ENT-3 (S10 6 d L1, L2; 7 d; Q16): the dark preview card on Android, composed inside HostingTheme(inCall = true) by
 * LobbyScreen. It takes the cached LobbyCardUi (LobbyUiCache) and plain callbacks, so presence, name, route or issue
 * changes never recompose it (6 k). The video area holds the LocalPreviewSurface (keyed by the preview session), the
 * camera-off avatar, the starting spinner, the unavailable caption or the denied overlay; the "You" chip; the flip
 * button while live (a solid scrim circle, never glass). The strip holds the R01 labelled toggles (Off #F2B8B5) and
 * the Effects slot only while an engine publishes it (R31). ENT-4 (S10 7 d, f, i): the toggles draw the displayed state
 * (Off while a tap cannot grant it), their state descriptions add the permission reason (`stateReason`, HD request
 * B7-T8 R2), and the camera overlay is PermissionPrimingCardOverlay.
 */

@Composable
internal fun LobbyPreviewCard(
    card: LobbyCardUi,
    wide: Boolean,
    onMic: (Boolean) -> Unit,
    onCamera: (Boolean) -> Unit,
    onFlip: () -> Unit,
    onEffects: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val ext = LocalConclaveExtendedColors.current
    val scheme = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(DesignTokens.radiusTile.dp)
    val screenHeight = LocalConfiguration.current.screenHeightDp.dp
    BoxWithConstraints(modifier.fillMaxWidth().testTag("lobby.card")) {
        val natural = if (wide) maxWidth * (9f / 16f) else maxWidth * (4f / 3f)
        val videoHeight = natural.coerceIn(200.dp, max(200.dp, screenHeight * 0.52f))
        Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, ext.border, shape)) {
            LobbyPreviewVideo(card, onFlip, onOpenSettings, Modifier.fillMaxWidth().height(videoHeight).background(ext.tile))
            Row(
                modifier = Modifier.fillMaxWidth().background(scheme.surfaceContainer).padding(vertical = 12.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.Top,
            ) {
                LobbyToggles(card, onMic, onCamera, onEffects)
            }
        }
    }
}

@Composable
private fun LobbyPreviewVideo(card: LobbyCardUi, onFlip: () -> Unit, onOpenSettings: () -> Unit, modifier: Modifier) {
    val scheme = MaterialTheme.colorScheme
    val ext = LocalConclaveExtendedColors.current
    val previewLabel = conclaveString("pm_your_preview")
    val previewValue = when {
        card.preview == PreviewState.live && card.isFrontCamera -> conclaveString("ds_front")
        card.preview == PreviewState.live -> conclaveString("ds_back_camera")
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
            when {
                card.showsSurface -> LocalPreviewSurface(card.previewSessionId)
                card.showsCameraOverlay -> Unit
                else -> LobbyCameraOffContent(card)
            }
            if (card.preview == PreviewState.interrupted) {
                Text(
                    conclaveString("pm_camera_paused"),
                    style = MaterialTheme.typography.bodyMedium,
                    color = scheme.onSurface,
                    modifier = Modifier.clip(CircleShape).background(ext.labelScrim).padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
        }
        if (card.showsCameraOverlay) {
            // ENT-4 (S10 7 d): Open settings or restricted inside the card; the rationale asks from a row instead.
            PermissionPrimingCardOverlay(card.cameraPriming, onOpenSettings, Modifier.align(Alignment.Center))
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
                modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp), identifier = "lobby.flip")
        }
    }
}

@Composable
private fun LobbyCameraOffContent(card: LobbyCardUi) {
    val scheme = MaterialTheme.colorScheme
    val unavailable = card.preview == PreviewState.unavailable || card.cameraPermission == MediaPermissionState.unavailable
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.padding(horizontal = 24.dp).clearAndSetSemantics { },
    ) {
        ConclaveAvatar(
            identity = ConclaveAvatarIdentity.make(name = card.avatarName, id = if (card.avatarSeed.isEmpty()) null else card.avatarSeed),
            diameter = 76.dp,
        )
        if (card.preview == PreviewState.starting) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = scheme.onSurface)
        } else {
            Text(
                if (unavailable) conclaveString("pm_camera_unavailable") else conclaveString("pm_camera_off"),
                style = MaterialTheme.typography.bodyMedium,
                color = scheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** L2: Mic then Camera (then Effects), each a Role.Switch with its state description; the caption is visual only. */
@Composable
private fun LobbyToggles(card: LobbyCardUi, onMic: (Boolean) -> Unit, onCamera: (Boolean) -> Unit, onEffects: () -> Unit) {
    ConclaveLabelledCallToggle(
        label = conclaveString("ds_microphone"),
        stateText = if (card.micOn) conclaveString("ds_state_on") else conclaveString("ds_state_muted"),
        icon = if (card.micOn) ConclaveIcons.MicFill1 else ConclaveIcons.MicOffFill1,
        visual = if (card.micOn) ConclaveCallControlVisual.On else ConclaveCallControlVisual.Off,
        checked = card.micOn,
        identifier = "lobby.mic",
        onToggle = { onMic(it) },
        width = 56.dp,
        feedback = LobbyToggleFeedbackPolicy.kind(isOn = card.micOn, permission = card.micPermission,
            onKind = FeedbackKind.micOn, offKind = FeedbackKind.micOff, canAskAgain = card.canAskAgainMicrophone),
        stateReason = permissionReasonText(LobbyMediaKind.microphone, card.micReason),
    )
    ConclaveLabelledCallToggle(
        label = conclaveString("ds_camera"),
        stateText = if (card.cameraOn) conclaveString("ds_state_on") else conclaveString("ds_state_off"),
        icon = if (card.cameraOn) ConclaveIcons.VideocamFill1 else ConclaveIcons.VideocamOffFill1,
        visual = if (card.cameraOn) ConclaveCallControlVisual.On else ConclaveCallControlVisual.Off,
        checked = card.cameraOn,
        identifier = "lobby.camera",
        onToggle = { onCamera(it) },
        width = 56.dp,
        enabled = card.cameraPermission != MediaPermissionState.unavailable,
        feedback = LobbyToggleFeedbackPolicy.kind(isOn = card.cameraOn, permission = card.cameraPermission,
            onKind = FeedbackKind.cameraOn, offKind = FeedbackKind.cameraOff, canAskAgain = card.canAskAgainCamera),
        stateReason = permissionReasonText(LobbyMediaKind.camera, card.cameraReason),
    )
    if (card.showsEffects) {
        ConclaveLabelledCallToggle(
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

// MARK: The preview surface (WP3 LocalPreviewSurface)

/**
 * The Android preview surface: a PreviewView owned by the one LocalPreviewController (frames reach it only, never a
 * producer), keyed by the preview session so nothing but a new session recreates it. The non-lazy lobby Column never
 * disposes it on scroll (F00 P5).
 */
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
