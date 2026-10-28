package conclave.module

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/*
 * ENT-4 (S10 7 b, d, e, f, g, h, i): permission priming in context on Android, handwritten Compose Material 3. The first
 * tap on a lobby toggle asks through PermissionHelper's serialized queue (one prompt at a time, 120 s timeout). After a
 * first refusal the system still allows one more prompt, so a warning ConclaveBanner under the card explains and offers
 * Allow (the same toggle intent again, which asks) and Not now (hides the row for this lobby); after a permanent
 * denial the row's action becomes Open settings (ACTION_APPLICATION_DETAILS_SETTINGS through PermissionHelper). The
 * camera's Open settings and restricted states live in the card overlay (in-call theme, FilledTonalButton), never in
 * a second row. Which row shows is PermissionPrimingPolicy's call (shared with iOS). No haptics: the system dialog
 * was the interaction (7 e, h). Returning from Settings re-reads the permissions on ON_RESUME (7 d).
 */

/** The rows under the card, microphone first. Not now is per lobby route (it resets when another lobby opens). */
@Composable
internal fun PermissionPrimingRows(premeeting: PremeetingPresenter, routeId: Int) {
    val media = premeeting.lobbyMedia?.takeIf { it.routeId == routeId } ?: return
    var microphoneDismissed by remember(routeId) { mutableStateOf(false) }
    var cameraDismissed by remember(routeId) { mutableStateOf(false) }
    val rows = PermissionPrimingPolicy.rows(
        media = media,
        supportsRationale = PermissionPrimingPolicy.platformSupportsRationale,
        microphoneRationaleDismissed = microphoneDismissed,
        cameraRationaleDismissed = cameraDismissed,
    )
    for (model in rows) {
        val camera = model.kind == LobbyMediaKind.camera
        key(model.kind) {
            PermissionPrimingRow(
                model = model,
                onAllow = { if (camera) premeeting.setCameraIntent(true) else premeeting.setMicIntent(true) },
                onNotNow = { if (camera) cameraDismissed = true else microphoneDismissed = true },
                onOpenSettings = { premeeting.openSystemSettings() },
            )
        }
    }
}

/**
 * One priming row: `ConclaveBanner(kind = warning, text, actions)` (S10 7 d). Rationale: the reason with Allow and
 * Not now; permanently denied: title and body with Open settings; restricted: title and body, no action. The banner
 * text is a polite live region, so the row is announced once when it appears (7 i).
 */
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
            if (camera) conclaveString("pm_camera_denied_title") + "\n" + conclaveString("pm_camera_restricted")
            else conclaveString("pm_mic_denied_title") + "\n" + conclaveString("pm_mic_restricted")
        else ->
            if (camera) conclaveString("pm_camera_denied_title") + "\n" + conclaveString("pm_camera_denied_body")
            else conclaveString("pm_mic_denied_title") + "\n" + conclaveString("pm_mic_denied_body")
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
    ConclaveBanner(
        kind = ConclaveBannerKind.Warning,
        text = text,
        identifier = PermissionPrimingUi.rowIdentifier(model.kind),
        inCall = false,
        modifier = modifier.padding(horizontal = 16.dp),
        actions = actions,
    )
}

/**
 * S10 7 d: the camera overlay inside the card (composed in HostingTheme(inCall = true) by the card): title, body and a
 * tonal Open settings; restricted has no button. One traversal group whose title is a polite live region, so it is
 * announced once when it appears.
 */
@Composable
internal fun PermissionPrimingCardOverlay(priming: PermissionPrimingKind, onOpenSettings: () -> Unit, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    Column(
        modifier = modifier.padding(20.dp).semantics { isTraversalGroup = true }.testTag("lobby.camera.denied"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(ConclaveIcons.VideocamOffFill1, contentDescription = null, tint = scheme.onSurface)
        Text(
            conclaveString("pm_camera_denied_title"),
            style = MaterialTheme.typography.titleMedium,
            color = scheme.onSurface,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        Text(
            if (priming == PermissionPrimingKind.restricted) conclaveString("pm_camera_restricted")
            else conclaveString("pm_camera_denied_body"),
            style = MaterialTheme.typography.bodyMedium,
            color = scheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (priming == PermissionPrimingKind.openSettings || priming == PermissionPrimingKind.rationale) {
            FilledTonalButton(onClick = onOpenSettings, modifier = Modifier.testTag("lobby.camera.openSettings")) {
                Text(conclaveString("ds_open_settings"))
            }
        }
    }
}

/**
 * S10 7 d "Return: re-read on ON_RESUME": coming back from Settings (or a split-screen Settings pane, which never stops
 * the activity) re-reads the permissions through the lobby's appearance path. The first resume after composition is
 * skipped: the lobby's own appearance has just read them.
 */
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

/** The toggle's state description reason (S10 7 i: "stateDescription adds the same reason"); "" for none. */
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
    /** The microphone keeps ENT-3's test tags (`lobby.microphone.denied`, `lobby.microphone.openSettings`). */
    fun identifierBase(kind: LobbyMediaKind): String =
        if (kind == LobbyMediaKind.camera) "lobby.camera" else "lobby.microphone"

    fun rowIdentifier(kind: LobbyMediaKind): String =
        if (kind == LobbyMediaKind.camera) "lobby.camera.permission" else "lobby.microphone.denied"
}
