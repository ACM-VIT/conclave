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

/**
 * T3B-2 (R/t3-borrow/PLAN.md section 4; P1, P2, P4, P6 on Android). The Conclave test classpath has no Compose UI test
 * artifacts (no performKeyInput), and under Robolectric only the first composition in a JVM keeps recomposing (see
 * PanelStageBridgeTests), so the composer's own key handler (ChatComposerKeys, the code the field's onHardwareKey
 * calls) is driven here with real Android key events against the transpiled fixture presenter and policy: arrows wrap
 * and skip, Enter and Tab insert, an exact match sends, Escape hides the list and is consumed with its release, Escape
 * with the list hidden falls through to Back, a held Enter sends once, and a touch configuration selects and consumes
 * nothing. Plus the TextFieldState draft helpers, the clip image URIs and the Send reason resources. The Swift half
 * is T/T3BorrowComposerPolicyTests.swift.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class T3BorrowComposerBridgeTests {
    private fun event(code: Int, action: Int, repeat: Int = 0, meta: Int = 0): KeyEvent =
        KeyEvent(android.view.KeyEvent(0L, 0L, action, code, repeat, meta))

    private fun down(code: Int, repeat: Int = 0, meta: Int = 0) = event(code, android.view.KeyEvent.ACTION_DOWN, repeat, meta)

    private fun up(code: Int) = event(code, android.view.KeyEvent.ACTION_UP)

    /** The composer's key path without a composition: the fixture presenter, one ChatComposerKeys and a draft. */
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
        // Up from row 1 wraps to the last row.
        val fresh = Harness(ChatFixtureState.suggestionsCommands, "/")
        assertTrue(fresh.press(down(android.view.KeyEvent.KEYCODE_DPAD_UP)))
        assertEquals(rows.last(), fresh.model().highlight)
        // A new letter resets the highlight to the first row of the new query.
        h.type("/c")
        assertEquals(h.available()[0], h.model().highlight)
        assertEquals("", h.keys.announcedId)
        // Arrows with the list hidden move the caret (not consumed).
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
        // "/help" now equals the highlighted row's insert text: Return sends (exact match, a Conclave decision).
        assertTrue(h.model().visible)
        assertTrue(h.press(down(android.view.KeyEvent.KEYCODE_ENTER)))
        assertEquals(1, h.sends)
        assertEquals(1, h.inserted.size)
        // Tab inserts like Return; Shift+Tab is left to focus navigation.
        val t = Harness(ChatFixtureState.suggestionsCommands, "/ca")
        assertFalse(t.press(down(android.view.KeyEvent.KEYCODE_TAB, meta = android.view.KeyEvent.META_SHIFT_ON)))
        assertTrue(t.press(down(android.view.KeyEvent.KEYCODE_TAB)))
        assertEquals(listOf("/camera "), t.inserted)
        assertTrue("a held Tab only swallows its repeat", t.press(down(android.view.KeyEvent.KEYCODE_TAB, repeat = 1)))
        assertEquals(1, t.inserted.size)
        // Mentions insert "@token " and never send.
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
        // With the list hidden, Escape is not consumed (it falls back to Back, which closes the panel).
        assertFalse(h.press(down(android.view.KeyEvent.KEYCODE_ESCAPE)))
        assertFalse(h.press(up(android.view.KeyEvent.KEYCODE_ESCAPE)))
        // More letters in the same token keep it hidden; the trigger going and coming back shows it again.
        h.type("/h")
        assertFalse(h.model().visible)
        h.type("")
        h.type("/")
        assertTrue(h.model().visible)
        // A plain draft never consumes Escape.
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
        // To a key with a draft: the current text is saved under the old key and the stored draft loads.
        chatSwitchDraft(state, drafts, "room-a|", true, "room-a|avery")
        assertEquals("for avery", state.text.toString())
        assertEquals("hello all", drafts.text("room-a|"))
        assertEquals("the caret is at the end", 9, state.selection.start)
        // To a key with none: the text moves along and the old key is cleared.
        chatSwitchDraft(state, drafts, "room-a|avery", true, "room-a|robin")
        assertEquals("for avery", state.text.toString())
        assertEquals("", drafts.text("room-a|avery"))
        // A suggestion pick replaces the draft with the row's insert text; a focus request appends after a space.
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
        // The transpiled policy answers like Swift.
        val none = ChatAttachmentState.none
        assertEquals(ChatSendBlock.reconnecting, ChatComposerPolicy.sendBlock("hi", ChatSendGate.reconnecting, false, none))
        assertEquals(ChatSendBlock.empty, ChatComposerPolicy.sendBlock(" ", ChatSendGate.open, false, none))
        assertEquals(ChatSendBlock.overLimit, ChatComposerPolicy.sendBlock("a".repeat(1001), ChatSendGate.open, false, none))
        assertEquals(ChatSendBlock.none, ChatComposerPolicy.sendBlock("hi", ChatSendGate.open, false, none))
        assertTrue(ChatComposerPolicy.canSend("hi", ChatSendGate.open, false, none))
        assertFalse(ChatComposerPolicy.canSend("hi", ChatSendGate.offline, false))
        assertTrue(ChatComposerPolicy.announcesBlockedSend(ChatSendBlock.offline))
        assertFalse(ChatComposerPolicy.announcesBlockedSend(ChatSendBlock.empty))
        assertEquals(ChatFailure.oneAttachment,
            ChatComposerPolicy.photoIntakeNotice(ChatSendGate.open, false, true, true, false))
        assertFalse(ChatComposerPolicy.composerMenuIsFocusable(true, false))
        assertTrue(ChatComposerPolicy.composerMenuIsFocusable(true, true))
        assertFalse(ChatFocusCapture.capture(wasFocused = true, imeVisible = true, touchExploration = false).menuFocusable)
        assertFalse(ChatComposerPolicy.restoresComposerFocus(true, true))
        assertEquals("mention:3", ChatComposerPolicy.suggestionTrigger("hi @av").key)
        assertEquals(ChatReturnKeyAction.consume,
            ChatComposerPolicy.returnKeyAction(true, false, false, true, false, "", "hello"))
    }

    /**
     * P3 (fix pass): the side pane's in-pane GIF page removes the composer from the composition, so the capture the
     * composer took when the picker opened lives on the panel's ChatRowActions; the composer composed when the page
     * closes takes it exactly once and restores focus only when the field had it and TalkBack is off.
     */
    @Test
    fun theGifPickersFocusCaptureOutlivesTheComposer() {
        val actions = ChatRowActions(ChatPresenter(), RuntimeEnvironment.getApplication())
        assertNull("a plain open restores nothing (S40 Q11)", actions.takeGifsFocusCapture())
        val capture = ChatFocusCapture.capture(wasFocused = true, imeVisible = true, touchExploration = false)
        actions.gifsFocusCapture = capture
        actions.openGifs()
        // The first composer is gone; the GIF page closes and a new composer starts with fresh local memory.
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
