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

/*
 * S30 1 d, 1 g (CTL-5): the Android hardware keyboard table, the twin of the iOS `CommandMenu("Call")`: Ctrl+D (mute or
 * unmute), Ctrl+E (camera), Ctrl+Alt+H (raise or lower hand), Ctrl+Shift+C (show chat), Ctrl+Shift+P (show
 * participants), Ctrl+Shift+S (share screen), Ctrl+Shift+L (lock meeting, hosts). Gated by `controls.commands` (visible
 * and enabled per item) and dispatched through `controls.perform`; keyboard commands play no haptic. The call root
 * installs `Modifier.callControlsKeyboardShortcuts(controls)` (HD/requests/B6-T3.md); MainActivity lists the same table
 * in the Keyboard Shortcuts Helper through `callControlsKeyboardShortcutGroup` (build owner, S10 C15).
 */

/** The command a key-down maps to, or null (the modifiers must match exactly, so Ctrl+Shift+D is not Ctrl+D). */
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

/** Consumes a matching key-down only when the presenter accepted the command (a hidden or disabled one passes through). */
internal fun Modifier.callControlsKeyboardShortcuts(controls: CallControlsPresenter?): Modifier =
    if (controls == null) this else onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        val command = callControlsCommandFor(event.key, event.isCtrlPressed, event.isShiftPressed, event.isAltPressed)
            ?: return@onPreviewKeyEvent false
        controls.perform(command) != ControlTapResult.ignored
    }

/** The Keyboard Shortcuts Helper group for the visible commands (`Activity.onProvideKeyboardShortcuts`). */
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

/** S30 1 g Android helper labels. */
internal fun callControlsShortcutLabel(command: CallCommandID): String = when (command) {
    CallCommandID.microphone -> "ctl_kb_mic"
    CallCommandID.camera -> "ctl_kb_camera"
    CallCommandID.hand -> "ctl_kb_hand"
    CallCommandID.chat -> "ctl_kb_chat"
    CallCommandID.participants -> "ctl_kb_people"
    CallCommandID.screenShare -> "ctl_kb_share"
    CallCommandID.lockMeeting -> "ctl_kb_lock"
}
