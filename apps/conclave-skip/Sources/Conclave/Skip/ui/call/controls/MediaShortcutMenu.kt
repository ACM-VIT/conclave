package conclave.module

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.vector.ImageVector

/*
 * S30 2 d (CTL-4): the Android Camera long-press shortcut, the FND-2 ConclaveDropdownMenu above the control (flat:
 * extraSmall shape, surfaceContainer, no elevation, a 1 dp outlineVariant border; Back and outside taps dismiss it):
 * "Flip camera" while the camera is on and the device can flip (disabled with its reason while the call reconnects, and
 * while a flip is in flight), then "Effects" when the native panel exists. Items come from the shared shortcut snapshot
 * (`controls.shortcuts` through MediaShortcutsCache, CL14); the menu content composes only while expanded. A flip plays
 * `selectionChanged` from the touched item, only when the presenter dispatched it (RECONCILE R13, H2 row 23); Effects
 * opens its panel from the call and plays nothing. The open menu keeps chrome visible (CC16 `camera.menu`). The Mic long
 * press opens the route sheet instead (AudioRouteSheet.kt); Android has no Mic menu (S30 2 b). Resolved strings sit in
 * vals before any `semantics {}` block (CL14).
 */

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

/** The Camera menu words (S30 2 g) and the S30 7 reason lines of a disabled Flip. */
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

/** Canonical S30 2 e flip-camera and CL11 Effects concepts. */
internal fun mediaShortcutIcon(id: String): ImageVector? = when (id) {
    MediaShortcutItemID.flipCamera.rawValue -> ConclaveIcons.CameraswitchFill0
    MediaShortcutItemID.effects.rawValue -> ConclaveIcons.AutoAwesomeFill0
    else -> null
}

/** The TalkBack label of one Camera shortcut item (S30 2 g: `ds_flip_camera`, `ctl_effects`). */
@Composable
internal fun mediaShortcutActionLabel(kind: MediaShortcutItemID): String = when (kind) {
    MediaShortcutItemID.effects -> conclaveString("ctl_effects")
    else -> conclaveString("ds_flip_camera")
}
