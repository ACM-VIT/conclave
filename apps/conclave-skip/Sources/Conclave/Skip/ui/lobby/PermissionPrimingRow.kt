package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

@Composable
internal fun PermissionPrimingRows(premeeting: PremeetingPresenter, routeId: Int) {
    val media = premeeting.lobbyMedia?.takeIf { it.routeId == routeId } ?: return
    var microphoneDismissed by remember(routeId) { mutableStateOf(false) }
    var cameraDismissed by remember(routeId) { mutableStateOf(false) }
    val rowModels = PermissionPrimingPolicy.rows(
        media = media,
        supportsRationale = PermissionPrimingPolicy.platformSupportsRationale,
        microphoneRationaleDismissed = microphoneDismissed,
        cameraRationaleDismissed = cameraDismissed,
    ).toList()
    val cameraModel = PermissionPrimingPolicy.model(
        kind = LobbyMediaKind.camera,
        permission = media.cameraPermission,
        canAskAgain = media.canAskAgainCamera,
        supportsRationale = PermissionPrimingPolicy.platformSupportsRationale,
        rationaleDismissed = cameraDismissed,
    )
    val rows = if (cameraModel.placement == PermissionPrimingPlacement.card) rowModels + cameraModel else rowModels
    for (model in rows) {
        val camera = model.kind == LobbyMediaKind.camera
        key(model.kind) {
            Column(
                if (model.placement == PermissionPrimingPlacement.card) {
                    Modifier.semantics { isTraversalGroup = true }.testTag("lobby.camera.denied")
                } else Modifier,
            ) {
                PermissionPrimingRow(
                    model = model,
                    onAllow = { if (camera) premeeting.setCameraIntent(true) else premeeting.setMicIntent(true) },
                    onNotNow = { if (camera) cameraDismissed = true else microphoneDismissed = true },
                    onOpenSettings = { premeeting.openSystemSettings() },
                )
            }
        }
    }
}

@Composable
internal fun PermissionPrimingRow(
    model: PermissionPrimingModel,
    onAllow: () -> Unit,
    onNotNow: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val camera = model.kind == LobbyMediaKind.camera
    val base = PermissionPrimingUi.identifierBase(model.kind)
    val text = when (model.priming) {
        PermissionPrimingKind.rationale ->
            if (camera) conclaveString("pm_camera_rationale") else conclaveString("pm_mic_rationale")
        PermissionPrimingKind.restricted ->
            if (camera) conclaveString("pm_camera_restricted") else conclaveString("pm_mic_restricted")
        else ->
            if (camera) conclaveString("pm_camera_denied_title") else conclaveString("pm_mic_denied_title")
    }
    val actions = when (model.priming) {
        PermissionPrimingKind.rationale -> listOf(
            ConclaveBannerAction(conclaveString("pm_allow"), "$base.allow", onClick = onAllow),
            ConclaveBannerAction(conclaveString("ds_not_now"), "$base.notNow", onClick = onNotNow),
        )
        PermissionPrimingKind.openSettings -> listOf(
            ConclaveBannerAction(conclaveString("ds_open_settings"), "$base.openSettings", onClick = onOpenSettings),
        )
        else -> emptyList()
    }
    val fontScale = LocalDensity.current.fontScale
    BoxWithConstraints(
        modifier.padding(horizontal = 16.dp, vertical = 4.dp).fillMaxWidth()
            .semantics { isTraversalGroup = true }.testTag(PermissionPrimingUi.rowIdentifier(model.kind)),
    ) {
        if (model.priming == PermissionPrimingKind.rationale || fontScale > 1.3f || maxWidth < 320.dp) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                PermissionPrimingMessage(camera, text)
                PermissionPrimingActions(actions)
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PermissionPrimingMessage(camera, text, Modifier.weight(1f))
                PermissionPrimingActions(actions, Modifier.widthIn(max = 160.dp))
            }
        }
    }
}

@Composable
private fun PermissionPrimingMessage(camera: Boolean, text: String, modifier: Modifier = Modifier) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(if (camera) ConclaveIcons.VideocamOffFill1 else ConclaveIcons.MicOffFill1,
            contentDescription = null, tint = color, modifier = Modifier.size(18.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = color,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PermissionPrimingActions(actions: List<ConclaveBannerAction>, modifier: Modifier = Modifier) {
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (action in actions) {
            TextButton(onClick = action.onClick, modifier = Modifier.testTag(action.identifier)) {
                Text(action.title, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@Composable
internal fun PermissionPrimingResumeEffect(premeeting: PremeetingPresenter, routeId: Int) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, premeeting, routeId) {
        var paused = false
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) {
                paused = true
            } else if (event == Lifecycle.Event.ON_RESUME && paused) {
                paused = false
                premeeting.lobbyDidAppear(routeId = routeId)
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
}

@Composable
internal fun permissionReasonText(kind: LobbyMediaKind, reason: PermissionPrimingKind): String {
    val camera = kind == LobbyMediaKind.camera
    return when (reason) {
        PermissionPrimingKind.openSettings ->
            if (camera) conclaveString("pm_camera_access_off_reason") else conclaveString("pm_mic_access_off_reason")
        PermissionPrimingKind.restricted ->
            if (camera) conclaveString("pm_camera_restricted") else conclaveString("pm_mic_restricted")
        else -> ""
    }
}

internal object PermissionPrimingUi {

    fun identifierBase(kind: LobbyMediaKind): String =
        if (kind == LobbyMediaKind.camera) "lobby.camera" else "lobby.microphone"

    fun rowIdentifier(kind: LobbyMediaKind): String =
        if (kind == LobbyMediaKind.camera) "lobby.camera.permission" else "lobby.microphone.denied"
}
