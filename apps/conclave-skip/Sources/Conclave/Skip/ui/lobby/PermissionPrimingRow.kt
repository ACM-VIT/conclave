package conclave.module

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

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
