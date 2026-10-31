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

        assertTrue(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_ENTER, repeat = 1), true, onSend, null))
        assertTrue(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_ENTER, repeat = 12), true, onSend, null))
        assertEquals(1, sends)

        assertFalse(conclaveComposerKey(key(up, NativeKeyEvent.KEYCODE_ENTER), true, onSend, null))

        assertTrue(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_ENTER), false, onSend, null))
        assertEquals(1, sends)

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

        assertFalse(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_A), true, onSend, null))
        assertFalse(conclaveComposerKey(key(down, NativeKeyEvent.KEYCODE_DPAD_DOWN), true, onSend, null))
        assertEquals(1, sends)
    }

    @Test fun screenKeysRunFirstOnKeyDownAndKeyUp() {
        var sends = 0
        val onSend = { sends += 1 }
        val seen = mutableListOf<String>()

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

        assertEquals(0, defaults)

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

        assertEquals(56.dp, TextFieldDefaults.MinHeight)
        assertEquals(4.0, ConclaveComposerMetrics.fieldTrailingGap, 0.0)
        assertEquals(6, ConclaveComposerMetrics.maximumLines)
    }
}
