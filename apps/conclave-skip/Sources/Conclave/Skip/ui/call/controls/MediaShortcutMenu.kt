package conclave.module

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.vector.ImageVector

@Composable
internal fun CameraShortcutMenu(controls: CallControlsPresenter, shortcuts: MediaShortcutsUi, expanded: Boolean, onDismiss: () -> Unit) {
    val stage = controls.stage
    val haptics = rememberConclaveHaptics()
    val titles = rememberMediaShortcutTitles()
    val open = expanded && shortcuts.hasEnabledCameraItem
    DisposableEffect(open) {
        if (open) stage.setTransientChrome(id = ChromeAutoHidePolicy.cameraMenu, open = true)
        onDispose {
            if (open) stage.setTransientChrome(id = ChromeAutoHidePolicy.cameraMenu, open = false)
        }
    }
    ConclaveDropdownMenu(
        expanded = open,
        onDismissRequest = onDismiss,
        sections = if (open) MediaShortcutPolicy.cameraMenuSections(shortcuts.snapshot.camera, titles = titles).toList() else emptyList(),
        identifier = MediaShortcutMenuIds.CAMERA_MENU,
        onSelect = { item ->
            onDismiss()
            val kind = MediaShortcutItemID.init(rawValue = item.id)
            if (kind != null) {
                val result = controls.selectShortcut(kind)
                val feedback = MediaShortcutPolicy.gestureKind(kind, result = result)
                if (feedback != null) haptics.gesture(feedback)
            }
        },
        icon = { item -> mediaShortcutIcon(item.id) },
    )
}

internal object MediaShortcutMenuIds {
    const val CAMERA_MENU = "camera.menu"
}

@Composable
internal fun rememberMediaShortcutTitles(): MediaShortcutTitles {
    val flip = conclaveString("ds_flip_camera")
    val effects = conclaveString("ctl_effects")
    val reconnecting = conclaveString("ctl_reason_reconnecting")
    val offline = conclaveString("ctl_reason_offline")
    return remember(flip, effects, reconnecting, offline) {
        MediaShortcutTitles(flipCamera = flip, effects = effects, reconnecting = reconnecting, offline = offline)
    }
}

internal fun mediaShortcutIcon(id: String): ImageVector? = when (id) {
    MediaShortcutItemID.flipCamera.rawValue -> ConclaveIcons.CameraswitchFill0
    MediaShortcutItemID.effects.rawValue -> ConclaveIcons.AutoAwesomeFill0
    else -> null
}

@Composable
internal fun mediaShortcutActionLabel(kind: MediaShortcutItemID): String = when (kind) {
    MediaShortcutItemID.effects -> conclaveString("ctl_effects")
    else -> conclaveString("ds_flip_camera")
}
