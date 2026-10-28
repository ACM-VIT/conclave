package conclave.module

import android.content.ClipboardManager
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ChatBridgeTests {
    private val local = "jordan@example.com#s1"
    private val avery = "avery@example.com#w1"
    private val base = 1_800_014_400_000.0

    private fun roster() = skip.lib.Array(listOf(
        ChatRosterEntry(userId = local, name = "Jordan Lee", isPresent = true),
        ChatRosterEntry(userId = avery, name = "Avery Lee", isPresent = true),
    ))

    private fun inputs(messages: List<ChatMessageInput>) = ChatInputs.make(callSession = 1, roomId = "room-a", localUserId = local,
        localName = "Jordan Lee", messages = skip.lib.Array(messages), gate = ChatSendGate.allowed, roster = roster(),
        assistant = AssistantAvailability.available)

    private fun peer(id: String, text: String, offset: Double, reactions: List<ChatReactionInput> = emptyList()) =
        ChatMessageInput.make(id = id, senderId = avery, senderName = "Avery Lee", content = text, timestampMillis = base + offset,
            reactions = skip.lib.Array(reactions), isHistory = true)

    private fun presenter(messages: List<ChatMessageInput>): ChatPresenter {
        val chat = ChatPresenter()
        chat.now = { base + 600_000.0 }
        chat.apply(inputs(messages), ChatInputChange.messages)
        return chat
    }

    private fun spans(text: String): List<String> = ChatLinkifyPolicy.spans(text).toList().map { span ->
        if (span.kind == ChatSpanKind.link) "link(${span.text}|${span.url})" else "text(${span.text})"
    }

    @Test
    fun linkifyMatchesTheWebVectorsLikeSwift() {
        assertEquals(listOf("text(Visit )", "link(https://example.com/a?b=1|https://example.com/a?b=1)", "text(.)"),
            spans("Visit https://example.com/a?b=1."))
        assertEquals(listOf("text(go to )", "link(docs.example.com/agenda|https://docs.example.com/agenda)", "text(,)", "text( then)"),
            spans("go to docs.example.com/agenda, then"))
        assertEquals(listOf("link(www.Example.com|https://www.Example.com)"), spans("www.Example.com"))
        assertEquals(listOf("text((see )", "link(https://x.io/y|https://x.io/y)", "text())"), spans("(see https://x.io/y)"))
        assertEquals(listOf("text(1.5 and e.g. a.b.c)"), spans("1.5 and e.g. a.b.c"))
        assertEquals(listOf("text(avery@)", "link(example.com|https://example.com)"), spans("avery@example.com"))
        assertEquals(listOf("text(https://user@host.example)"), spans("https://user@host.example"))
        assertEquals(listOf("text()"), spans(""))
    }

    @Test
    fun utf16CountsMatchTheSfu() {
        assertEquals(1200, ChatComposerPolicy.limitLength(text = "👍".repeat(600), isVoice = false))
        assertEquals(11, ChatComposerPolicy.utf16Length("👨‍👩‍👧‍👦"))
        assertEquals(4, ChatComposerPolicy.utf16Length("🇺🇸"))
        assertEquals(999, ChatComposerPolicy.limitLength(text = "a".repeat(988) + "👨‍👩‍👧‍👦", isVoice = false))
        assertTrue(ChatComposerPolicy.isOverLimit(text = "/tts " + "c".repeat(501), isVoiceMode = false))
    }

    @Test
    fun routeOrderMatchesSwift() {
        val privateMode = ChatComposerMode(privateToUserId = avery, isVoiceMode = false, privateEnabled = true, voiceEnabled = true)
        assertEquals(ChatFailure.assistantIsPublic, ChatComposerPolicy.route(draft = "@Conclave hi", mode = privateMode).failure)
        assertEquals(ChatRouteKind.command, ChatComposerPolicy.route(draft = "/leave", mode = privateMode).kind)
        assertEquals(ChatFailure.privateTextOnly, ChatComposerPolicy.route(draft = "/tts x", mode = privateMode).failure)
        assertEquals("/dm $avery hello", ChatComposerPolicy.route(draft = "hello", mode = privateMode).wireText)
        assertEquals(ChatRouteKind.assistant, ChatComposerPolicy.route(draft = "@Conclave hi", mode = ChatComposerMode.everyone).kind)
    }

    @Test
    fun rowIdentitySurvivesTheAcknowledgement() {
        val sending = ChatMessageInput.make(id = "optimistic-1", clientId = "optimistic-1", senderId = local, senderName = "Jordan Lee",
            isOwn = true, content = "hello", timestampMillis = base, delivery = ChatDelivery.sending)
        val chat = presenter(listOf(sending))
        val entry = chat.rows.entry("optimistic-1")
        assertEquals(ChatDelivery.sending, entry.row.delivery)
        val acked = ChatMessageInput.make(id = "s-1", clientId = "optimistic-1", senderId = local, senderName = "Jordan Lee",
            isOwn = true, content = "hello", timestampMillis = base)
        chat.apply(inputs(listOf(acked)), ChatInputChange.messages)
        assertSame(entry, chat.rows.entry("optimistic-1"))
        assertEquals("s-1", entry.row.serverId)
        assertEquals("optimistic-1", chat.rows.rowId("s-1"))
        assertEquals(listOf("optimistic-1"), chat.timeline.rowIds.toList())
    }

    @Test
    fun reactionsToggleWithTheServerIdAndRespectTheCap() {
        val log = mutableListOf<ChatCommandRequest>()
        val chat = presenter(listOf(peer("s-1", "hi", 0.0, listOf(ChatReactionInput(emoji = "👍",
            userIds = skip.lib.Array(listOf(avery, local)), includesMe = true)))))
        chat.onCommand = { log.add(it) }
        val chip = chat.rows.entry("s-1").row.reactions.toList().first()
        assertTrue(chip.isMine)
        assertEquals(listOf("", "Avery Lee"), chip.names.toList())
        chat.toggleReaction("s-1", "😂")
        assertEquals(ChatCommandKind.react, log.last().kind)
        assertEquals("s-1", log.last().messageId)
        val toggled = ChatReactionRules.toggled(skip.lib.Array(listOf(ChatMessageReaction(emoji = "👍", userIds = skip.lib.Array(listOf("a"))))),
            "👍", "me")
        assertEquals(listOf("a", "me"), toggled.toList().first().userIds.toList())
        assertEquals(2, chat.reactors("s-1", "👍").count)
        assertFalse(chat.rows.entry("s-1").row.canReport)
    }

    @Test
    fun hidingASenderRemovesTheirRowsUntilShow() {
        val chat = presenter(listOf(peer("s-1", "one", 0.0), peer("s-2", "two", 1000.0)))
        chat.hideSender(avery)
        val hidden = chat.timeline.rowIds.toList()
        assertEquals(listOf("hidden:$avery"), hidden)
        assertEquals(ChatNotice.senderHidden, chat.rows.entry("hidden:$avery").row.notice)
        chat.showSender(avery)
        assertEquals(listOf("s-1", "s-2"), chat.timeline.rowIds.toList())
    }

    @Test
    fun theTimelineCacheReversesOncePerRevision() {
        val chat = presenter(listOf(peer("s-1", "one", 0.0), peer("s-2", "two", 1000.0)))
        val cache = ChatTimelineCache(chat)
        val first = cache.current()
        assertEquals(listOf("s-2", "s-1"), first.ids)
        assertEquals(listOf(ChatRowKind.text, ChatRowKind.text), first.kinds)
        assertSame(first, cache.current())
        chat.apply(inputs(listOf(peer("s-1", "one", 0.0), peer("s-2", "two", 1000.0), peer("s-3", "three", 2000.0))),
            ChatInputChange.messages)
        val second = cache.current()
        assertEquals("s-3", second.ids.first())
        assertTrue(second !== first)
    }

    @Test
    fun copyWritesTheClipboardAndShowsTheSnackbarBeforeApi33() {
        val context = RuntimeEnvironment.getApplication()
        val chat = presenter(listOf(peer("s-1", "copy me", 0.0)))
        val actions = ChatRowActions(chat, context)
        actions.copy("s-1")
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        assertEquals("copy me", clipboard.primaryClip?.getItemAt(0)?.text.toString())
        assertEquals(1, actions.copiedRequest)
        assertNotNull(chat.announcement)
    }

    @Test
    fun theFixtureDriverLogsCommandsWithoutACore() {
        val shell = MeetingShellPresenter()
        val driver = ChatFixtureDriver.installOnStage(ChatFixtureState.busy, shell)
        assertTrue(shell.chat.timeline.rowIds.count > 20)
        assertEquals(MeetingPanel.chat, shell.panels.snapshot.current?.panel)
        shell.chat.retry("c-15")
        assertTrue(driver.actionsReadout.contains("retry rowId=c-15"))
        ChatDiagnostics.driver = null
        ChatDiagnostics.counters = null
    }
}
