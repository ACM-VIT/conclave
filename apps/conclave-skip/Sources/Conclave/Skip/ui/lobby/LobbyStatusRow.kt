package conclave.module

import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
internal fun LobbyStatusRows(premeeting: PremeetingPresenter, routeId: Int) {
    val status = premeeting.lobbyStatus?.takeIf { it.routeId == routeId }
    val media = premeeting.lobbyMedia?.takeIf { it.routeId == routeId }
    var settled by remember(routeId) { mutableStateOf(false) }
    LaunchedEffect(routeId) { settled = true }
    val rows = LobbyStatusPolicy.rows(
        status = status,
        media = media,
        supportsRationale = PermissionPrimingPolicy.platformSupportsRationale,
        offersAppInfo = LobbyStatusPolicy.platformOffersAppInfo,
    ).toList()
    for (model in rows) {
        key(model.kind) {
            LobbyStatusRow(
                model = model,
                announces = settled,
                onAllow = { if (model.mediaKind == LobbyMediaKind.camera) premeeting.setCameraIntent(true) else premeeting.setMicIntent(true) },
                onOpenSettings = { premeeting.openSystemSettings() },
                modifier = if (model.kind == LobbyStatusRowKind.camera) {
                    Modifier.semantics { isTraversalGroup = true }.testTag("lobby.camera.denied")
                } else Modifier,
            )
        }
    }
}

@Composable
internal fun LobbyStatusRow(
    model: LobbyStatusRowModel,
    announces: Boolean,
    onAllow: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    val line = lobbyStatusRowLine(model)
    val icon = LobbyStatusRowUi.icon(model.kind)
    val base = LobbyStatusRowUi.actionBase(model.kind)
    val action = when (model.action) {
        LobbyStatusRowAction.allow -> LobbyStatusActionUi(
            title = conclaveString("pm_allow"),
            identifier = "$base.allow",
            clickLabel = if (model.mediaKind == LobbyMediaKind.camera) conclaveString("pm_status_allow_camera_label")
            else conclaveString("pm_status_allow_mic_label"),
            onClick = onAllow,
        )
        LobbyStatusRowAction.openSettings -> LobbyStatusActionUi(
            title = conclaveString("ds_open_settings"),
            identifier = "$base.openSettings",
            clickLabel = null,
            onClick = onOpenSettings,
        )
        else -> null
    }
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val stacked = LocalDensity.current.fontScale > 1.3f || maxWidth < 320.dp
        ListItem(
            headlineContent = {
                Text(line, style = MaterialTheme.typography.bodyMedium,
                    modifier = if (announces) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier)
            },
            leadingContent = { Icon(icon, contentDescription = null) },
            supportingContent = if (action != null && stacked) { { LobbyStatusAction(action) } } else null,
            trailingContent = if (action != null && !stacked) { { LobbyStatusAction(action) } } else null,
            colors = ListItemDefaults.colors(containerColor = scheme.surface, headlineColor = scheme.onSurfaceVariant),
            modifier = Modifier.testTag(LobbyStatusRowUi.identifier(model.kind)),
        )
    }
}

@Composable
private fun LobbyStatusAction(action: LobbyStatusActionUi) {
    val label = action.clickLabel
    TextButton(
        onClick = action.onClick,
        modifier = Modifier.testTag(action.identifier)
            .then(if (label != null) Modifier.semantics { onClick(label = label) { action.onClick(); true } } else Modifier),
    ) { Text(action.title) }
}

private class LobbyStatusActionUi(
    val title: String,
    val identifier: String,
    val clickLabel: String?,
    val onClick: () -> Unit,
)

@Composable
private fun lobbyStatusRowLine(model: LobbyStatusRowModel): String = when (model.kind) {
    LobbyStatusRowKind.issue -> conclaveString("pm_status_app_suspended")
    LobbyStatusRowKind.media ->
        if (model.restricted) conclaveString("pm_status_media_restricted") else conclaveString("pm_status_media_off")
    LobbyStatusRowKind.camera ->
        if (model.restricted) conclaveString("pm_status_camera_restricted") else conclaveString("pm_camera_denied_title")
    LobbyStatusRowKind.microphone ->
        if (model.restricted) conclaveString("pm_status_mic_restricted") else conclaveString("pm_mic_denied_title")
}

internal object LobbyStatusRowUi {

    fun identifier(kind: LobbyStatusRowKind): String = when (kind) {
        LobbyStatusRowKind.issue -> "lobby.issue"
        LobbyStatusRowKind.media -> "lobby.media.permission"
        LobbyStatusRowKind.camera -> PermissionPrimingUi.rowIdentifier(LobbyMediaKind.camera)
        LobbyStatusRowKind.microphone -> PermissionPrimingUi.rowIdentifier(LobbyMediaKind.microphone)
    }

    fun actionBase(kind: LobbyStatusRowKind): String = when (kind) {
        LobbyStatusRowKind.issue -> "lobby.issue"
        LobbyStatusRowKind.media -> "lobby.media"
        LobbyStatusRowKind.camera -> PermissionPrimingUi.identifierBase(LobbyMediaKind.camera)
        LobbyStatusRowKind.microphone -> PermissionPrimingUi.identifierBase(LobbyMediaKind.microphone)
    }

    fun icon(kind: LobbyStatusRowKind): ImageVector = when (kind) {
        LobbyStatusRowKind.issue -> ConclaveIcons.InfoFill0
        LobbyStatusRowKind.camera -> ConclaveIcons.VideocamOffFill1
        LobbyStatusRowKind.microphone, LobbyStatusRowKind.media -> ConclaveIcons.MicOffFill1
    }
}
