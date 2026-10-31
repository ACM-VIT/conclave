package conclave.module

import android.content.Context
import android.view.KeyEvent as AndroidKeyEvent
import android.view.KeyboardShortcutGroup
import android.view.KeyboardShortcutInfo
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type

internal fun callControlsCommandFor(key: Key, ctrl: Boolean, shift: Boolean, alt: Boolean): CallCommandID? {
    if (!ctrl) return null
    return when {
        key == Key.D && !shift && !alt -> CallCommandID.microphone
        key == Key.E && !shift && !alt -> CallCommandID.camera
        key == Key.H && alt && !shift -> CallCommandID.hand
        key == Key.C && shift && !alt -> CallCommandID.chat
        key == Key.P && shift && !alt -> CallCommandID.participants
        key == Key.S && shift && !alt -> CallCommandID.screenShare
        key == Key.L && shift && !alt -> CallCommandID.lockMeeting
        else -> null
    }
}

internal fun Modifier.callControlsKeyboardShortcuts(controls: CallControlsPresenter?): Modifier =
    if (controls == null) this else onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        val command = callControlsCommandFor(event.key, event.isCtrlPressed, event.isShiftPressed, event.isAltPressed)
            ?: return@onPreviewKeyEvent false
        controls.perform(command) != ControlTapResult.ignored
    }

internal fun callControlsKeyboardShortcutGroup(context: Context, controls: CallControlsPresenter): KeyboardShortcutGroup {
    val infos = mutableListOf<KeyboardShortcutInfo>()
    for (item in controls.commands.items) {
        if (!item.isVisible) continue
        val (keyCode, modifiers) = when (item.command) {
            CallCommandID.microphone -> AndroidKeyEvent.KEYCODE_D to AndroidKeyEvent.META_CTRL_ON
            CallCommandID.camera -> AndroidKeyEvent.KEYCODE_E to AndroidKeyEvent.META_CTRL_ON
            CallCommandID.hand -> AndroidKeyEvent.KEYCODE_H to (AndroidKeyEvent.META_CTRL_ON or AndroidKeyEvent.META_ALT_ON)
            CallCommandID.chat -> AndroidKeyEvent.KEYCODE_C to (AndroidKeyEvent.META_CTRL_ON or AndroidKeyEvent.META_SHIFT_ON)
            CallCommandID.participants -> AndroidKeyEvent.KEYCODE_P to (AndroidKeyEvent.META_CTRL_ON or AndroidKeyEvent.META_SHIFT_ON)
            CallCommandID.screenShare -> AndroidKeyEvent.KEYCODE_S to (AndroidKeyEvent.META_CTRL_ON or AndroidKeyEvent.META_SHIFT_ON)
            CallCommandID.lockMeeting -> AndroidKeyEvent.KEYCODE_L to (AndroidKeyEvent.META_CTRL_ON or AndroidKeyEvent.META_SHIFT_ON)
        }
        infos.add(KeyboardShortcutInfo(conclaveStringOf(context, callControlsShortcutLabel(item.command)), keyCode, modifiers))
    }
    return KeyboardShortcutGroup(conclaveStringOf(context, "ctl_kb_group"), infos)
}

internal fun callControlsShortcutLabel(command: CallCommandID): String = when (command) {
    CallCommandID.microphone -> "ctl_kb_mic"
    CallCommandID.camera -> "ctl_kb_camera"
    CallCommandID.hand -> "ctl_kb_hand"
    CallCommandID.chat -> "ctl_kb_chat"
    CallCommandID.participants -> "ctl_kb_people"
    CallCommandID.screenShare -> "ctl_kb_share"
    CallCommandID.lockMeeting -> "ctl_kb_lock"
}
