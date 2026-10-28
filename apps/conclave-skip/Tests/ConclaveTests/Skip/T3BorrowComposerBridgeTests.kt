package conclave.module

import android.content.ClipData
import android.content.ClipDescription
import android.net.Uri
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.ui.input.key.KeyEvent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class T3BorrowComposerBridgeTests {
    private fun event(code: Int, action: Int, repeat: Int = 0, meta: Int = 0): KeyEvent =
        KeyEvent(android.view.KeyEvent(0L, 0L, action, code, repeat, meta))

    private fun down(code: Int, repeat: Int = 0, meta: Int = 0) = event(code, android.view.KeyEvent.ACTION_DOWN, repeat, meta)

    private fun up(code: Int) = event(code, android.view.KeyEvent.ACTION_UP)

    private class Harness(state: ChatFixtureState, var draft: String, val hardware: Boolean = true) {
        val shell = MeetingShellPresenter()
        val driver = ChatFixtureDriver.installOnStage(state, shell)
        val keys = ChatComposerKeys()
        val inserted = mutableListOf<String>()
        var sends = 0

        fun model(): ChatSuggestionsModel = ChatSuggestionsModel.make(draft, shell.chat.composer, keys, hardware)

        fun available(): List<String> = model().items.toList().filter { it.isAvailable }.map { it.id }

        fun type(text: String) {
            draft = text
            keys.syncDraft(text)
        }

        fun press(key: KeyEvent): Boolean = keys.onKey(key, hardware, draft, model(), { text ->
            inserted.add(text)
            type(text)
        }, { sends += 1 })
    }

    @After
    fun clearDiagnostics() {
        ChatDiagnostics.driver = null
        ChatDiagnostics.counters = null
    }

    @Test
    fun arrowsMoveTheHighlightWrapAndAnnounceOnlyOnMoves() {
        val h = Harness(ChatFixtureState.suggestionsCommands, "/")
        val start = h.model()
        assertTrue(start.visible)
        val rows = h.available()
        assertTrue(rows.size >= 3)
        assertEquals("the first available row is highlighted", rows[0], start.highlight)
        assertEquals("nothing is announced before a move", "", h.keys.announcedId)
        assertTrue(h.press(down(android.view.KeyEvent.KEYCODE_DPAD_DOWN)))
        assertTrue("a consumed press consumes its release", h.press(up(android.view.KeyEvent.KEYCODE_DPAD_DOWN)))
        assertTrue(h.press(down(android.view.KeyEvent.KEYCODE_DPAD_DOWN)))
        assertEquals("Down twice highlights row 3", rows[2], h.model().highlight)
        assertEquals(rows[2], h.keys.announcedId)

        val fresh = Harness(ChatFixtureState.suggestionsCommands, "/")
        assertTrue(fresh.press(down(android.view.KeyEvent.KEYCODE_DPAD_UP)))
        assertEquals(rows.last(), fresh.model().highlight)

        h.type("/c")
        assertEquals(h.available()[0], h.model().highlight)
        assertEquals("", h.keys.announcedId)

        val plain = Harness(ChatFixtureState.suggestionsCommands, "hello")
        assertFalse(plain.model().visible)
        assertFalse(plain.press(down(android.view.KeyEvent.KEYCODE_DPAD_DOWN)))
    }

    @Test
    fun enterAndTabInsertTheHighlightAndAnExactMatchSends() {
        val h = Harness(ChatFixtureState.suggestionsCommands, "/")
        val firstInsert = h.model().highlightedInsert
        assertEquals("/help", firstInsert)
        assertTrue(h.press(down(android.view.KeyEvent.KEYCODE_ENTER)))
        assertEquals(listOf("/help"), h.inserted)
        assertEquals(0, h.sends)

        assertTrue(h.model().visible)
        assertTrue(h.press(down(android.view.KeyEvent.KEYCODE_ENTER)))
        assertEquals(1, h.sends)
        assertEquals(1, h.inserted.size)

        val t = Harness(ChatFixtureState.suggestionsCommands, "/ca")
        assertFalse(t.press(down(android.view.KeyEvent.KEYCODE_TAB, meta = android.view.KeyEvent.META_SHIFT_ON)))
        assertTrue(t.press(down(android.view.KeyEvent.KEYCODE_TAB)))
        assertEquals(listOf("/camera "), t.inserted)
        assertTrue("a held Tab only swallows its repeat", t.press(down(android.view.KeyEvent.KEYCODE_TAB, repeat = 1)))
        assertEquals(1, t.inserted.size)

        val m = Harness(ChatFixtureState.suggestionsMentions, "@")
        assertTrue(m.model().visible)
        assertTrue(m.press(down(android.view.KeyEvent.KEYCODE_NUMPAD_ENTER)))
        assertEquals(1, m.inserted.size)
        assertTrue(m.inserted[0].startsWith("@") && m.inserted[0].endsWith(" "))
        assertEquals(0, m.sends)
    }

    @Test
    fun escapeHidesTheListForThisTriggerAndFallsThroughOnceHidden() {
        val h = Harness(ChatFixtureState.suggestionsCommands, "/")
        assertTrue(h.press(down(android.view.KeyEvent.KEYCODE_ESCAPE)))
        assertFalse(h.model().visible)
        assertTrue("the release is consumed too, so the Escape-to-Back fallback stays quiet",
            h.press(up(android.view.KeyEvent.KEYCODE_ESCAPE)))

        assertFalse(h.press(down(android.view.KeyEvent.KEYCODE_ESCAPE)))
        assertFalse(h.press(up(android.view.KeyEvent.KEYCODE_ESCAPE)))

        h.type("/h")
        assertFalse(h.model().visible)
        h.type("")
        h.type("/")
        assertTrue(h.model().visible)

        assertFalse(Harness(ChatFixtureState.suggestionsCommands, "hello").press(down(android.view.KeyEvent.KEYCODE_ESCAPE)))
    }

    @Test
    fun aHeldEnterSendsOnceAndShiftEnterIsANewline() {
        val h = Harness(ChatFixtureState.suggestionsCommands, "hello")
        assertTrue(h.press(down(android.view.KeyEvent.KEYCODE_ENTER)))
        assertEquals(1, h.sends)
        assertTrue("an auto-repeat is consumed without sending", h.press(down(android.view.KeyEvent.KEYCODE_ENTER, repeat = 1)))
        assertTrue(h.press(down(android.view.KeyEvent.KEYCODE_ENTER, repeat = 5)))
        assertEquals(1, h.sends)
        assertFalse(h.press(down(android.view.KeyEvent.KEYCODE_ENTER, meta = android.view.KeyEvent.META_SHIFT_ON)))
        assertTrue(h.press(down(android.view.KeyEvent.KEYCODE_NUMPAD_ENTER)))
        assertEquals(2, h.sends)
    }

    @Test
    fun aTouchConfigurationSelectsAndConsumesNothing() {
        val h = Harness(ChatFixtureState.suggestionsCommands, "/", hardware = false)
        val model = h.model()
        assertTrue(model.visible)
        assertEquals("no row is selected on touch", "", model.highlight)
        for (code in listOf(android.view.KeyEvent.KEYCODE_DPAD_DOWN, android.view.KeyEvent.KEYCODE_TAB,
                android.view.KeyEvent.KEYCODE_ESCAPE, android.view.KeyEvent.KEYCODE_ENTER)) {
            assertFalse(h.press(down(code)))
            assertFalse(h.press(up(code)))
        }
        assertEquals(0, h.sends)
        assertTrue(h.inserted.isEmpty())
        assertTrue(h.model().visible)
    }

    @Test
    fun clipImageUrisTakeOnlyImageItemsWithAUri() {
        val photo = Uri.parse("content://media/external/images/1")
        val image = ClipData(ClipDescription("sticker", arrayOf("image/png")), ClipData.Item(photo))
        assertEquals(listOf(photo), chatImageUris(image))
        val second = Uri.parse("content://media/external/images/2")
        val two = ClipData(ClipDescription("photos", arrayOf("image/*")), ClipData.Item(photo))
        two.addItem(ClipData.Item(second))
        assertEquals(listOf(photo, second), chatImageUris(two))
        val mixed = ClipData(ClipDescription("mixed", arrayOf("image/jpeg", "text/plain")), ClipData.Item("caption"))
        mixed.addItem(ClipData.Item(photo))
        assertEquals(listOf(photo), chatImageUris(mixed))
        assertTrue(chatImageUris(ClipData.newPlainText("text", "hello")).isEmpty())
        assertTrue(chatImageUris(ClipData.newRawUri("file", photo)).isEmpty())
    }

    @Test
    fun draftsSwitchAndSuggestionsInsertOnTheTextFieldState() {
        val drafts = ChatDraftStore()
        drafts.setText("for avery", "room-a|avery")
        val state = TextFieldState()
        chatSwitchDraft(state, drafts, "", false, "room-a|")
        assertEquals("", state.text.toString())
        state.setTextAndPlaceCursorAtEnd("hello all")

        chatSwitchDraft(state, drafts, "room-a|", true, "room-a|avery")
        assertEquals("for avery", state.text.toString())
        assertEquals("hello all", drafts.text("room-a|"))
        assertEquals("the caret is at the end", 9, state.selection.start)

        chatSwitchDraft(state, drafts, "room-a|avery", true, "room-a|robin")
        assertEquals("for avery", state.text.toString())
        assertEquals("", drafts.text("room-a|avery"))

        val insert = ChatComposerPolicy.insertingMention("hi @av", "averylee")
        state.setTextAndPlaceCursorAtEnd(insert)
        assertEquals("hi @averylee ", state.text.toString())
        assertEquals(insert.length, state.selection.end)
        chatAppendInsert(state, "@Conclave ")
        assertEquals("hi @averylee  @Conclave ", state.text.toString())
        val empty = TextFieldState()
        chatAppendInsert(empty, "@Conclave ")
        assertEquals("@Conclave ", empty.text.toString())
        chatAppendInsert(empty, "")
        assertEquals("@Conclave ", empty.text.toString())
    }

    @Test
    fun sendReasonsMapToOneResourceAndTheSharedBlock() {
        assertEquals("", chatSendBlockReasonName(ChatSendBlock.none))
        assertEquals("", chatSendBlockReasonName(ChatSendBlock.attendee))
        assertEquals("", chatSendBlockReasonName(ChatSendBlock.photoFailed))
        assertEquals("chat_send_reason_empty", chatSendBlockReasonName(ChatSendBlock.empty))
        assertEquals("chat_send_reason_not_joined", chatSendBlockReasonName(ChatSendBlock.notJoined))
        assertEquals("ds_state_reconnecting", chatSendBlockReasonName(ChatSendBlock.reconnecting))
        assertEquals("chat_send_reason_offline", chatSendBlockReasonName(ChatSendBlock.offline))
        assertEquals("chat_placeholder_locked", chatSendBlockReasonName(ChatSendBlock.locked))
        assertEquals("ds_char_over_limit", chatSendBlockReasonName(ChatSendBlock.overLimit))
        assertEquals("chat_send_reason_uploading", chatSendBlockReasonName(ChatSendBlock.photoPending))

        val none = ChatAttachmentState.none
        assertEquals(ChatSendBlock.reconnecting, ChatComposerPolicy.sendBlock("hi", ChatSendGate.reconnecting, false, none))
        assertEquals(ChatSendBlock.empty, ChatComposerPolicy.sendBlock(" ", ChatSendGate.allowed, false, none))
        assertEquals(ChatSendBlock.overLimit, ChatComposerPolicy.sendBlock("a".repeat(1001), ChatSendGate.allowed, false, none))
        assertEquals(ChatSendBlock.none, ChatComposerPolicy.sendBlock("hi", ChatSendGate.allowed, false, none))
        assertTrue(ChatComposerPolicy.canSend("hi", ChatSendGate.allowed, false, none))
        assertFalse(ChatComposerPolicy.canSend("hi", ChatSendGate.offline, false))
        assertTrue(ChatComposerPolicy.announcesBlockedSend(ChatSendBlock.offline))
        assertFalse(ChatComposerPolicy.announcesBlockedSend(ChatSendBlock.empty))
        assertEquals(ChatFailure.oneAttachment,
            ChatComposerPolicy.photoIntakeNotice(ChatSendGate.allowed, false, true, true, false))
        assertFalse(ChatComposerPolicy.composerMenuIsFocusable(true, false))
        assertTrue(ChatComposerPolicy.composerMenuIsFocusable(true, true))
        assertFalse(ChatFocusCapture.capture(wasFocused = true, imeVisible = true, touchExploration = false).menuFocusable)
        assertFalse(ChatComposerPolicy.restoresComposerFocus(true, true))
        assertEquals("mention:3", ChatComposerPolicy.suggestionTrigger("hi @av").key)
        assertEquals(ChatReturnKeyAction.consume,
            ChatComposerPolicy.returnKeyAction(true, false, false, true, false, "", "hello"))
    }

    @Test
    fun theGifPickersFocusCaptureOutlivesTheComposer() {
        val actions = ChatRowActions(ChatPresenter(), RuntimeEnvironment.getApplication())
        assertNull("a plain open restores nothing (S40 Q11)", actions.takeGifsFocusCapture())
        val capture = ChatFocusCapture.capture(wasFocused = true, imeVisible = true, touchExploration = false)
        actions.gifsFocusCapture = capture
        actions.openGifs()

        actions.closeGifs()
        assertFalse(actions.showsGifs)
        val taken = actions.takeGifsFocusCapture()
        assertEquals(capture, taken)
        assertNull("taken once", actions.takeGifsFocusCapture())
        assertTrue(ChatComposerPolicy.restoresComposerFocus(taken!!.wasFocused, false))
        assertTrue(taken.imeWasVisible)
        assertFalse(ChatComposerPolicy.restoresComposerFocus(taken.wasFocused, true))
        val unfocused = ChatFocusCapture.capture(wasFocused = false, imeVisible = false, touchExploration = false)
        actions.gifsFocusCapture = unfocused
        assertFalse(ChatComposerPolicy.restoresComposerFocus(actions.takeGifsFocusCapture()!!.wasFocused, false))
    }
}
