package conclave.module

import androidx.compose.material3.TextFieldDefaults
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import android.view.KeyEvent as NativeKeyEvent

/**
 * T3B-1, the Android half (T3BorrowComposerComponentTests is the Swift half): the composer field's hardware keys (the
 * screen's hook first, then Enter and NumPadEnter once per press with auto-repeats consumed, Shift+Enter a newline),
 * the IME Send rule on the TextFieldState overload (Q13), the disabled Send reason, the counter bands through the
 * transpiled shared policy, and the attach slot height. The Conclave test classpath has no Compose UI test artifacts,
 * so the composables are covered through their pure helpers and real android.view.KeyEvent instances.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class T3BorrowComposerFieldTests {
    private fun key(action: Int, code: Int, repeat: Int = 0, shift: Boolean = false): KeyEvent {
        val meta = if (shift) NativeKeyEvent.META_SHIFT_ON or NativeKeyEvent.META_SHIFT_LEFT_ON else 0
        return KeyEvent(NativeKeyEvent(0L, 0L, action, code, repeat, meta))
    }

    private val down = NativeKeyEvent.ACTION_DOWN
    private val up = NativeKeyEvent.ACTION_UP

    @Test fun enterSendsOncePerPressAndConsumesRepeats() {
        var sends = 0
        val onSend = { sends += 1 }
        assertTrue(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_ENTER), true, onSend, null))
        assertEquals(1, sends)
        // A held Enter: the auto-repeats are consumed (no newline reaches the field) and nothing more is sent.
        assertTrue(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_ENTER, repeat = 1), true, onSend, null))
        assertTrue(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_ENTER, repeat = 12), true, onSend, null))
        assertEquals(1, sends)
        // KeyUp passes through, as before.
        assertFalse(conclaveComposerKey(key(up, NativeKeyEvent.KEYCODE_ENTER), true, onSend, null))
        // A disabled Send: Enter is still consumed, so a blocked press never inserts a newline, and nothing is sent.
        assertTrue(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_ENTER), false, onSend, null))
        assertEquals(1, sends)
        // Shift+Enter falls through to the field as a newline, held or not.
        assertFalse(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_ENTER, shift = true), true, onSend, null))
        assertFalse(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_ENTER, repeat = 3, shift = true), true, onSend, null))
        assertEquals(1, sends)
    }

    @Test fun numPadEnterIsItsOwnBranch() {
        var sends = 0
        val onSend = { sends += 1 }
        assertTrue(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_NUMPAD_ENTER), true, onSend, null))
        assertTrue(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_NUMPAD_ENTER, repeat = 2), true, onSend, null))
        assertFalse(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_NUMPAD_ENTER, shift = true), true, onSend, null))
        assertFalse(conclaveComposerKey(key(up, NativeKeyEvent.KEYCODE_NUMPAD_ENTER), true, onSend, null))
        assertEquals(1, sends)
        // Other keys are the field's.
        assertFalse(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_A), true, onSend, null))
        assertFalse(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_DPAD_DOWN), true, onSend, null))
        assertEquals(1, sends)
    }

    @Test fun screenKeysRunFirstOnKeyDownAndKeyUp() {
        var sends = 0
        val onSend = { sends += 1 }
        val seen = mutableListOf<String>()
        // A screen with its suggestion list open: it takes Enter (insert the row), the arrows and Escape, both phases.
        val listOpen: (KeyEvent) -> Boolean = { event ->
            val native = event.nativeKeyEvent
            seen.add("${native.keyCode}:${native.action}")
            native.keyCode == NativeKeyEvent.KEYCODE_ENTER || native.keyCode == NativeKeyEvent.KEYCODE_ESCAPE ||
                native.keyCode == NativeKeyEvent.KEYCODE_DPAD_DOWN
        }
        assertTrue(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_ENTER), true, onSend, listOpen))
        assertEquals("the screen inserted a suggestion instead of sending", 0, sends)
        assertTrue(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_DPAD_DOWN, repeat = 4), true, onSend, listOpen))
        assertTrue(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_ESCAPE), true, onSend, listOpen))
        assertTrue(conclaveComposerKey(key(up, NativeKeyEvent.KEYCODE_ESCAPE), true, onSend, listOpen))
        assertEquals(listOf("${NativeKeyEvent.KEYCODE_ENTER}:$down", "${NativeKeyEvent.KEYCODE_DPAD_DOWN}:$down",
            "${NativeKeyEvent.KEYCODE_ESCAPE}:$down", "${NativeKeyEvent.KEYCODE_ESCAPE}:$up"), seen)
        // A screen that passes leaves Enter to the field's own rule.
        val listHidden: (KeyEvent) -> Boolean = { false }
        assertTrue(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_ENTER), true, onSend, listHidden))
        assertEquals(1, sends)
        assertFalse(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_ESCAPE), true, onSend, listHidden))
        assertFalse(conclaveComposerKey(key(up, NativeKeyEvent.KEYCODE_ESCAPE), true, onSend, listHidden))
    }

    @Test fun imeSendRunsOnlyWhileSendIsEnabled() {
        var sends = 0
        var defaults = 0
        conclaveComposerImeSend(true) { sends += 1 }.onKeyboardAction { defaults += 1 }
        conclaveComposerImeSend(false) { sends += 1 }.onKeyboardAction { defaults += 1 }
        assertEquals(1, sends)
        // No default action: a blocked IME Send keeps the draft and the keyboard.
        assertEquals(0, defaults)
        // P6 (fix pass): a blocked IME Send goes to onSendBlocked once (the screen posts the reason) and never to onSend;
        // an enabled one never calls onSendBlocked (Q13 unchanged).
        var blocked = 0
        conclaveComposerImeSend(false, { blocked += 1 }) { sends += 1 }.onKeyboardAction { defaults += 1 }
        assertEquals(1, blocked)
        assertEquals(1, sends)
        conclaveComposerImeSend(true, { blocked += 1 }) { sends += 1 }.onKeyboardAction { defaults += 1 }
        assertEquals(1, blocked)
        assertEquals(2, sends)
        assertEquals(0, defaults)
    }

    @Test fun disabledSendCarriesItsReason() {
        assertEquals("Type a message", conclaveSendStateDescription(false, "Type a message"))
        assertEquals("Reconnecting", conclaveSendStateDescription(false, "Reconnecting"))
        assertNull(conclaveSendStateDescription(true, "Type a message"))
        assertNull(conclaveSendStateDescription(false, ""))
    }

    @Test fun counterBandsMatchSwift() {
        assertEquals(ConclaveCounterBand.hidden, ConclaveComposerCounterPolicy.band(count = 899, limit = 1000, visibleFrom = 900))
        assertEquals(ConclaveCounterBand.near, ConclaveComposerCounterPolicy.band(count = 900, limit = 1000, visibleFrom = 900))
        assertEquals(ConclaveCounterBand.near, ConclaveComposerCounterPolicy.band(count = 1000, limit = 1000, visibleFrom = 900))
        assertEquals(ConclaveCounterBand.over, ConclaveComposerCounterPolicy.band(count = 1001, limit = 1000, visibleFrom = 900))
        assertEquals(ConclaveCounterBand.near, ConclaveComposerCounterPolicy.band(count = 0, limit = 500, visibleFrom = 0))
        assertTrue(ConclaveComposerCounterPolicy.announces(previous = ConclaveCounterBand.hidden, next = ConclaveCounterBand.near))
        assertTrue(ConclaveComposerCounterPolicy.announces(previous = ConclaveCounterBand.hidden, next = ConclaveCounterBand.over))
        assertTrue(ConclaveComposerCounterPolicy.announces(previous = ConclaveCounterBand.near, next = ConclaveCounterBand.over))
        assertTrue(ConclaveComposerCounterPolicy.announces(previous = ConclaveCounterBand.over, next = ConclaveCounterBand.near))
        assertFalse(ConclaveComposerCounterPolicy.announces(previous = ConclaveCounterBand.near, next = ConclaveCounterBand.near))
        assertFalse(ConclaveComposerCounterPolicy.announces(previous = ConclaveCounterBand.over, next = ConclaveCounterBand.over))
        assertFalse(ConclaveComposerCounterPolicy.announces(previous = ConclaveCounterBand.near, next = ConclaveCounterBand.hidden))
        assertFalse(ConclaveComposerCounterPolicy.announces(previous = ConclaveCounterBand.over, next = ConclaveCounterBand.hidden))
    }

    @Test fun attachSlotIsTheOneLineFieldHeight() {
        // The 48 dp attach button is centred on the 56 dp single-line field and stays in its bottom band as it grows.
        assertEquals(56.dp, TextFieldDefaults.MinHeight)
        assertEquals(4.0, ConclaveComposerMetrics.fieldTrailingGap, 0.0)
        assertEquals(6, ConclaveComposerMetrics.maximumLines)
    }
}
