package conclave.module

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontWeight
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * CHT-7 (S40 4, CH7, CH8) through the transpiled stream parser and collector, the task and row policies, the core
 * assistant store and the presenter, plus the handwritten markdown inline builder. The Swift half is
 * T/CHT7AssistantRowTests.swift; the same vectors give the same results on both platforms: frames parse in any slicing,
 * a failure is a row state and never an answer body, relays follow the web throttle, the `stream:3tasks` fixture plays
 * through the real store, and the busy fixture shows every state but approval (W10-2). Pure: no composition, network or
 * socket.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class CHT7AssistantBridgeTests {
    private val local = "jordan@example.com#s1"
    private val base = 1_800_014_400_000.0

    private class Clock {
        var value = 0.0
    }

    private fun store(clock: Clock): ConclaveAssistantStore {
        val store = ConclaveAssistantStore()
        store.schedulesTimers = false
        store.now = { clock.value }
        return store
    }

    private fun packet(content: String, done: Boolean) = ConclaveAssistantRelayPacket(
        id = "a", roomId = "room-a", channelId = "room:room-a", requesterUserId = local, questionMessageId = "q",
        content = content, done = done, timestamp = base, expiresAt = base + 60_000.0, signature = "signed",
    )

    private fun event(kind: NativeConclaveAssistantStreamEventKind, delta: String = "", relay: ConclaveAssistantRelayPacket? = null) =
        NativeConclaveAssistantStreamEvent(kind = kind, delta = delta, isReasoningDone = false, task = null, error = "", relay = relay)

    private fun answer(content: String, input: ChatAssistantInput?) = ChatMessageInput.make(
        id = "ans", senderId = ConclaveAssistantChatIdentity.userId, senderName = ConclaveAssistantChatIdentity.displayName,
        isAssistant = true, content = content, timestampMillis = base, assistant = input,
    )

    private fun inputs(messages: List<ChatMessageInput>) = ChatInputs.make(callSession = 1, roomId = "room-a", localUserId = local,
        localName = "Jordan Lee", messages = skip.lib.Array(messages), gate = ChatSendGate.open,
        roster = skip.lib.Array(listOf(ChatRosterEntry(userId = local, name = "Jordan Lee", isPresent = true))),
        assistant = AssistantAvailability.available)

    private fun presenter(messages: List<ChatMessageInput>): ChatPresenter {
        val chat = ChatPresenter()
        chat.now = { base + 600_000.0 }
        chat.apply(inputs(messages), ChatInputChange.messages)
        return chat
    }

    @Test
    fun framesParseInAnySlicingLikeSwift() {
        val parser = NativeConclaveAssistantStreamParser()
        val kinds = mutableListOf<String>()
        val chunks = listOf(
            ": open\n\n: " + " ".repeat(64) + "\n\n",
            "data: {\"type\":\"task\",\"task\":{\"id\":\"w\",\"kind\":\"web_search\",\"status\":\"running\",\"query\":\"q4\"}}\r",
            "\n\r\ndata: {\"type\":\"delta\",\"del", "ta\":\"Hel\"}\n\n",
            "data: {\"type\":\"reasoning\",\"done\":true}\n\ndata: {\"type\":\"delta\",\"delta\":\"lo\"}",
        )
        for (chunk in chunks) {
            for (parsed in parser.append(chunk)) kinds.add(parsed.kind.rawValue + ":" + parsed.delta)
        }
        assertEquals(listOf("task:", "delta:Hel", "reasoning:"), kinds)
        val tail = parser.finish()
        assertEquals(1, tail.count)
        assertEquals("lo", tail[0].delta)
        assertNull(NativeConclaveAssistantStreamParser.event("data: {\"type\":\"ping\"}"))
        assertEquals("q4", NativeConclaveAssistantStreamParser.event(
            "data: {\"type\":\"task\",\"task\":{\"id\":\"w\",\"kind\":\"web_search\",\"status\":\"running\",\"query\":\"q4\"}}")?.task?.query)
    }

    @Test
    fun aFailureEventFailsTheAnswerEvenAfterText() {
        val collector = NativeConclaveAssistantStreamCollector()
        collector.apply(event(NativeConclaveAssistantStreamEventKind.delta, delta = "Partial"))
        collector.apply(NativeConclaveAssistantStreamEvent(kind = NativeConclaveAssistantStreamEventKind.error, delta = "",
            isReasoningDone = false, task = null, error = "Conclave could not answer right now.", relay = null))
        var failed = false
        try {
            collector.result()
        } catch (error: Throwable) {
            failed = true
        }
        assertTrue("S40 CH8: a failure is never shown as an answer", failed)
        val empty = NativeConclaveAssistantStreamCollector()
        empty.apply(event(NativeConclaveAssistantStreamEventKind.done))
        assertEquals("", empty.result().content)
    }

    @Test
    fun policiesMatchSwift() {
        var tasks = skip.lib.Array<AssistantTask>()
        tasks = AssistantTaskPolicy.merge(tasks, AssistantTask(id = "w", kind = AssistantTaskKind.webSearch, isDone = false, query = "q4 roadmap"))
        tasks = AssistantTaskPolicy.merge(tasks, AssistantTask(id = "w", kind = AssistantTaskKind.webSearch, isDone = true, query = ""))
        tasks = AssistantTaskPolicy.merge(tasks, AssistantTask(id = "w", kind = AssistantTaskKind.webSearch, isDone = false, query = ""))
        assertTrue(tasks[0].isDone)
        assertEquals("q4 roadmap", tasks[0].query)
        assertNull(AssistantTaskKind.fromWire("future_tool"))
        assertEquals(AssistantRowState.thinking, AssistantRowPolicy.state(input = ChatAssistantInput.make(), content = ""))
        assertEquals(AssistantRowState.streaming, AssistantRowPolicy.state(input = ChatAssistantInput.make(reasoning = "Hmm"), content = ""))
        assertEquals(AssistantRowState.done, AssistantRowPolicy.state(input = null, content = "History"))
        assertEquals(AssistantRowState.error, AssistantRowPolicy.state(input = ChatAssistantInput.make(isDone = true), content = ""))
        assertEquals(AssistantErrorKind.empty, AssistantRowPolicy.errorKind(input = ChatAssistantInput.make(isDone = true), content = ""))
        assertFalse(AssistantRowPolicy.canRetry(isAsker = false, state = AssistantRowState.error, errorKind = AssistantErrorKind.generic))
        assertEquals("Summary", AssistantRowPolicy.firstSentence("## Summary\n- Launch moved to **Nov 4**"))
        assertEquals("The agenda has three items.", AssistantRowPolicy.firstSentence("The agenda has **three** items. Budget first."))
        assertEquals(AssistantErrorKind.expired, ConclaveAssistantFailurePolicy.kind(message = "Conclave assistant authorization is invalid or expired."))
        assertEquals("[00:01:05] Avery Lee: Budget is fine", ConclaveAssistantTranscriptPolicy.context(
            segments = skip.lib.Array(listOf(TranscriptSegmentModel(itemId = "1", sequence = 1, speakerUserId = "avery",
                speakerDisplayName = "Avery Lee", text = "Budget is fine", startMs = 65_000.0, isFinal = true))),
            sessionStatus = "live").transcript)
    }

    @Test
    fun theStoreThrottlesRelaysAndCoalescesRefreshes() {
        val clock = Clock()
        val store = store(clock)
        var refreshes = 0
        store.onChange = { refreshes += 1 }
        store.begin(answerId = "a", question = "Roadmap?", questionMessageId = "q")
        clock.value = 10.0
        val first = store.handle(NativeConclaveAssistantStreamEvent(kind = NativeConclaveAssistantStreamEventKind.task, delta = "",
            isReasoningDone = false, task = ConclaveAssistantRelayTask(id = "w", kind = "web_search", status = "running", query = "q4"),
            error = "", relay = packet("", false)), "a")
        assertNotNull(first)
        assertEquals(2, refreshes)
        clock.value = 20.0
        assertNull(store.handle(event(NativeConclaveAssistantStreamEventKind.delta, "Hel", packet("Hel", false)), "a"))
        assertEquals(2, refreshes)
        clock.value = 400.0
        assertNotNull(store.handle(event(NativeConclaveAssistantStreamEventKind.delta, "lo", packet("Hello", false)), "a"))
        assertEquals("Hello", store.content("a", ""))
        clock.value = 500.0
        assertNotNull(store.handle(event(NativeConclaveAssistantStreamEventKind.done, relay = packet("Hello.", true)), "a"))
        assertTrue(store.input("a")?.isDone == true)
        store.applyRelay(answerId = "a", reasoning = "spoof", reasoningDone = true, tasks = skip.lib.Array(), done = true, errored = true)
        assertEquals(AssistantErrorKind.none, store.input("a")?.errorKind)
        store.begin(answerId = "b", question = "Q", questionMessageId = "q2")
        store.fail(answerId = "b", kind = AssistantErrorKind.generic)
        assertEquals("q2", store.retryRecord("b")?.questionMessageId)
        store.applyRelay(answerId = "r", reasoning = "", reasoningDone = false, tasks = skip.lib.Array(), done = true, errored = true)
        assertNull(store.retryRecord("r"))
        assertEquals(AssistantErrorKind.generic, store.input("r")?.errorKind)
    }

    @Test
    fun aFailureIsARowStateAndDeltasLeaveTheTimelineAlone() {
        val failed = presenter(listOf(answer("Partial", ChatAssistantInput.make(errorKind = AssistantErrorKind.generic, isAsker = true))))
        val entry = failed.rows.entry("ans")
        assertEquals(AssistantRowState.error, entry.assistant?.state)
        assertTrue(entry.assistant?.canRetry == true)
        assertEquals("", entry.row.plainText)
        assertEquals(0, entry.assistant?.blocks?.count ?: -1)

        val chat = presenter(listOf(answer("", ChatAssistantInput.make())))
        val publishes = chat.timelinePublishCount
        chat.apply(inputs(listOf(answer("## Summary\n\nLaunch", ChatAssistantInput.make()))), ChatInputChange.assistant)
        val first = chat.rows.entry("ans").assistant?.blocks?.get(0)
        chat.apply(inputs(listOf(answer("## Summary\n\nLaunch moved", ChatAssistantInput.make()))), ChatInputChange.assistant)
        assertEquals(first, chat.rows.entry("ans").assistant?.blocks?.get(0))
        assertEquals(publishes, chat.timelinePublishCount)
        chat.panelDidOpen(ChatDestination.none, "")
        chat.apply(inputs(listOf(answer("Launch moved. Details", ChatAssistantInput.make(isDone = true)))), ChatInputChange.assistant)
        assertEquals("assistantAnswered", chat.announcement?.kind)
        assertEquals("Launch moved.", chat.announcement?.text)
    }

    @Test
    fun streamThreeTasksAndTheBusyFixture() {
        val store = store(Clock())
        store.begin(answerId = "ans", question = "Roadmap?", questionMessageId = "")
        for (step in ChatFixtureScript.streamScript()) store.handle(step.event, "ans")
        val input = store.input("ans")
        assertEquals(3, AssistantTaskPolicy.listed(input?.tasks ?: skip.lib.Array()).count)
        val chat = presenter(listOf(answer(store.content("ans", ""), input)))
        val model = chat.rows.entry("ans").assistant
        assertEquals(AssistantRowState.done, model?.state)
        assertTrue(model?.blocks?.toList()?.any { it.kind == StreamingMarkdownBlockKind.codeFence } == true)

        val shell = MeetingShellPresenter()
        ChatFixtureDriver.installOnStage(ChatFixtureState.busy, shell)
        assertEquals(AssistantRowState.thinking, shell.chat.rows.entry("s-a1").assistant?.state)
        assertEquals(AssistantRowState.streaming, shell.chat.rows.entry("s-a2").assistant?.state)
        assertEquals(AssistantRowState.done, shell.chat.rows.entry("s-a3").assistant?.state)
        assertTrue(shell.chat.rows.entry("s-a4").assistant?.canRetry == true)
        assertNull(shell.chat.rows.entry("s-a3").assistant?.approval)
        ChatDiagnostics.driver = null
        ChatDiagnostics.counters = null
    }

    @Test
    fun inlineMarkdownBuildsStylesAndLinks() {
        val opened = mutableListOf<String>()
        val text = assistantAnnotatedText("**Bold** and [the plan](https://x.io) `code`", false, Color.Red, SpanStyle(),
            { url -> opened.add(url) })
        assertEquals("Bold and the plan code", text.text)
        val links = text.getLinkAnnotations(0, text.length)
        assertEquals(1, links.size)
        assertEquals("https://x.io", (links[0].item as LinkAnnotation.Url).url)
        assertTrue(text.spanStyles.any { it.item.fontWeight == FontWeight.Bold })
        // The streaming tail reads an unclosed marker as open, so the text does not jump when it closes.
        assertEquals("Bold so far", assistantAnnotatedText("**Bold so far", true, Color.Red, SpanStyle(), { }).text)
    }
}
