#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// CHT-7 (OUT/PLAN-screens.md section 5; S40 4, 0.8 CH7 and CH8, Q3, Q4): Conclave AI rows. The incremental stream
/// parser and its collector (a failure is never an answer), the history without private messages, the transcript
/// context, the failure kinds, the web task rules, the row state policy and the first sentence, the core store (the
/// asker's stream, the web relay throttle, the 100 ms refresh coalescing, relayed packets for everyone else, Try Again),
/// the presenter's typed row entries (deltas never touch the timeline, one completion announcement, the iOS 17 follow
/// counter), the `stream:3tasks` fixture through the real store, and the view, service and Android client sources (no
/// shimmer or pulse, streamed reads on both platforms, the standalone markdown renderer). The last two tests need HD
/// requests B6-T4 R1 and R2 (the relay packet fields and the view model's assistant region) and stay red until the
/// integrator applies them. The Kotlin half is T/Skip/CHT7AssistantBridgeTests.kt. No network, socket or audio.
@MainActor
struct CHT7AssistantRowTests {
    static let local = "jordan@example.com#s1"
    static let avery = "avery@example.com#w1"
    /// Noon UTC, as in ChatPoliciesTests.
    static let base = 1_800_014_400_000.0

    // MARK: Stream parser and collector (CH7)

    @Test func theParserReadsFramesInAnySlicing() {
        let parser = NativeConclaveAssistantStreamParser()
        var kinds: [String] = []
        let chunks = [": open\n\n: " + String(repeating: " ", count: 64) + "\n\n",
                      "data: {\"type\":\"task\",\"task\":{\"id\":\"w\",\"kind\":\"web_search\",\"status\":\"running\",\"query\":\"q4\"}}\r",
                      "\n\r\ndata: {\"type\":\"delta\",\"del", "ta\":\"Hel\"}\n\n",
                      "data: {\"type\":\"reasoning\",\"done\":true}\n\ndata: {\"type\":\"delta\",\"delta\":\"lo\"}"]
        for chunk in chunks {
            for event in parser.append(chunk) {
                kinds.append(event.kind.rawValue + ":" + event.delta)
            }
        }
        #expect(kinds == ["task:", "delta:Hel", "reasoning:"])
        let tail = parser.finish()
        #expect(tail.count == 1 && tail[0].kind == .delta && tail[0].delta == "lo")
        #expect(parser.finish().isEmpty)
    }

    @Test func everyEventKindDecodesAndUnknownOnesAreSkipped() {
        let task = NativeConclaveAssistantStreamParser.event(fromFrame:
            "data: {\"type\":\"task\",\"task\":{\"id\":\"t1\",\"kind\":\"transcript\",\"status\":\"done\"}}")
        #expect(task?.kind == .task && task?.task?.id == "t1" && task?.task?.status == "done" && task?.task?.query == nil)
        let reasoning = NativeConclaveAssistantStreamParser.event(fromFrame: "data: {\"type\":\"reasoning\",\"delta\":\"Hmm\"}")
        #expect(reasoning?.kind == .reasoning && reasoning?.delta == "Hmm" && reasoning?.isReasoningDone == false)
        let failure = NativeConclaveAssistantStreamParser.event(fromFrame: "data: {\"type\":\"error\",\"error\":\"Boom\"}")
        #expect(failure?.kind == .error && failure?.error == "Boom")
        #expect(NativeConclaveAssistantStreamParser.event(fromFrame: "data: {\"type\":\"approval\",\"approval\":{}}")?.kind == .approval)
        #expect(NativeConclaveAssistantStreamParser.event(fromFrame: "data: {\"type\":\"ping\"}") == nil)
        #expect(NativeConclaveAssistantStreamParser.event(fromFrame: ": comment") == nil)
        #expect(NativeConclaveAssistantStreamParser.event(fromFrame: "{\"type\":\"done\"}")?.kind == .done)
    }

    @Test func aFailureEventFailsTheAnswerEvenAfterText() throws {
        let collector = NativeConclaveAssistantStreamCollector()
        collector.apply(Self.event(.delta, delta: "Partial answer"))
        collector.apply(Self.event(.error, error: "Conclave could not answer right now."))
        var failed = false
        do {
            _ = try collector.result()
        } catch {
            failed = true
            #expect(error.localizedDescription == "Conclave could not answer right now.")
        }
        #expect(failed, "S40 CH8: a failure is never shown as an answer")

        let empty = NativeConclaveAssistantStreamCollector()
        empty.apply(Self.event(.done))
        #expect(try empty.result().content == "", "a completed answer without text is the empty kind, not a throw")

        let cut = NativeConclaveAssistantStreamCollector()
        var cutFailed = false
        do { _ = try cut.result() } catch { cutFailed = true }
        #expect(cutFailed, "no text and no completion fails")

        let relay = Self.packet(content: "Final text.", done: true)
        let finished = NativeConclaveAssistantStreamCollector()
        finished.apply(Self.event(.delta, delta: "Draft "))
        finished.apply(NativeConclaveAssistantStreamEvent(kind: .done, delta: "", isReasoningDone: false, task: nil, error: "",
                                                          relay: relay))
        let result = try finished.result()
        #expect(result.content == "Final text." && result.relay?.signature == "signed")
    }

    // MARK: History and transcript (Q4, CH7)

    @Test func theHistoryLeavesOutPrivateMessagesAndFailures() {
        let image = ChatImageAttachment(id: "i", url: "https://x/i.png", fileName: "i.png", mimeType: "image/png", size: 10)
        let gif = ChatGifAttachment(id: "g", title: "Party", url: "https://x/g.gif", previewUrl: nil, pageUrl: nil, width: nil,
                                    height: nil, kind: "gif", videoUrl: nil, source: "klipy")
        let failed = ChatSendStatus(delivery: .failed, failure: ChatFailure.timedOut.rawValue, serverText: "", isRetryable: true)
        let messages = [
            ChatMessage(id: "m1", userId: Self.avery, displayName: "Avery Lee", content: "Agenda?"),
            ChatMessage(id: "m2", userId: Self.avery, displayName: "Avery Lee", content: "secret", isDirect: true,
                        dmTargetUserId: Self.local),
            ChatMessage(id: "m3", userId: Self.avery, displayName: "Avery Lee", content: "photo", image: image),
            ChatMessage(id: "m4", userId: Self.avery, displayName: "Avery Lee", content: "Party", gif: gif),
            ChatMessage(id: "m5", userId: Self.local, displayName: "Jordan Lee", content: "lost", sendStatus: failed),
            ChatMessage(id: "m6", userId: Self.local, displayName: "Jordan Lee", content: "   "),
            ChatMessage(id: "a1", userId: ConclaveAssistantChatIdentity.userId, displayName: "Conclave AI",
                        content: "Conclave could not answer right now."),
            ChatMessage(id: "a2", userId: ConclaveAssistantChatIdentity.userId, displayName: "Conclave AI", content: "Budget first."),
        ]
        let items = ConclaveAssistantHistoryPolicy.items(messages: messages, excludedIds: ["a1"])
        #expect(items == [
            ConclaveAssistantHistoryItem(name: "Avery Lee", isAssistant: false, content: "Agenda?"),
            ConclaveAssistantHistoryItem(name: "Conclave AI", isAssistant: true, content: "Budget first."),
        ])
    }

    @Test func theTranscriptGoesAlongOnlyWhileLiveNotesRun() {
        let segments = [
            TranscriptSegmentModel(itemId: "1", sequence: 1, speakerUserId: Self.avery, speakerDisplayName: "Avery Lee",
                                   text: "Budget is fine", startMs: 65_000, isFinal: true),
            TranscriptSegmentModel(itemId: "2", sequence: 2, speakerUserId: Self.local, speakerDisplayName: "Jordan Lee",
                                   text: " ", startMs: 70_000, isFinal: false),
            TranscriptSegmentModel(itemId: "3", sequence: 3, speakerUserId: Self.local, speakerDisplayName: "Jordan Lee",
                                   text: "Great", startMs: 86_399_000 + 86_400_000, isFinal: true),
        ]
        #expect(ConclaveAssistantTranscriptPolicy.context(segments: segments, sessionStatus: "idle")
                == ConclaveAssistantTranscriptContext(transcript: "", isActive: false))
        let live = ConclaveAssistantTranscriptPolicy.context(segments: segments, sessionStatus: "live")
        #expect(live.isActive && live.transcript == "[00:01:05] Avery Lee: Budget is fine\n[23:59:59] Jordan Lee: Great")
        #expect(ConclaveAssistantTranscriptPolicy.context(segments: segments, sessionStatus: "paused").isActive)
        #expect(!ConclaveAssistantTranscriptPolicy.isActive(sessionStatus: "stopping"))
    }

    @Test func failuresMapToKindsNeverToRawText() {
        #expect(ConclaveAssistantFailurePolicy.kind(for: NativeConclaveAssistantError(message: "x", requiresApiKey: true)) == .needsKey)
        #expect(ConclaveAssistantFailurePolicy.kind(message: "Enter an OpenAI API key to use Conclave AI in this room.") == .needsKey)
        #expect(ConclaveAssistantFailurePolicy.kind(message: "Conclave assistant authorization is invalid or expired.") == .expired)
        #expect(ConclaveAssistantFailurePolicy.kind(message: "Conclave is being asked too quickly") == .rateLimited)
        #expect(ConclaveAssistantFailurePolicy.kind(message: "Watch-only attendees cannot ask Conclave") == .unavailable)
        #expect(ConclaveAssistantFailurePolicy.kind(message: "Chat is locked by the host") == .unavailable)
        #expect(ConclaveAssistantFailurePolicy.kind(message: "Ask Conclave a question.") == .empty)
        #expect(ConclaveAssistantFailurePolicy.kind(message: "The Internet connection appears to be offline.") == .generic)
    }

    // MARK: Shared policies

    @Test func stepsMergeLikeTheWeb() {
        var tasks: [AssistantTask] = []
        tasks = AssistantTaskPolicy.merge(tasks, AssistantTask(id: "w", kind: .webSearch, isDone: false, query: "q4 roadmap"))
        tasks = AssistantTaskPolicy.merge(tasks, AssistantTask(id: "start", kind: .reasoning, isDone: false, query: ""))
        tasks = AssistantTaskPolicy.merge(tasks, AssistantTask(id: "w", kind: .webSearch, isDone: true, query: ""))
        tasks = AssistantTaskPolicy.merge(tasks, AssistantTask(id: "w", kind: .webSearch, isDone: false, query: ""))
        #expect(tasks.count == 2 && tasks[0].isDone && tasks[0].query == "q4 roadmap", "done is sticky, the query stays")
        #expect(AssistantTaskPolicy.listed(tasks).map { $0.id } == ["w"])
        #expect(AssistantTaskPolicy.completed(tasks).allSatisfy { $0.isDone })
        let relayed = AssistantTaskPolicy.merged([], relayed: [
            ConclaveAssistantRelayTask(id: "b", kind: "browser", status: "running", query: "example.com"),
            ConclaveAssistantRelayTask(id: "x", kind: "future_tool", status: "done"),
            ConclaveAssistantRelayTask(id: "", kind: "answer", status: "done"),
        ])
        #expect(relayed == [AssistantTask(id: "b", kind: .browser, isDone: false, query: "example.com")])
        #expect(AssistantTaskKind.fromWire("github_issue") == .githubIssue && AssistantTaskKind.githubIssue.wireValue == "github_issue")
        #expect(!AssistantTaskKind.answer.isListed && AssistantTaskKind.transcript.isListed)
    }

    @Test func theRowStateFollowsTheProcessState() {
        let step = AssistantTask(id: "w", kind: .webSearch, isDone: false, query: "")
        #expect(AssistantRowPolicy.state(input: nil, content: "") == .thinking)
        #expect(AssistantRowPolicy.state(input: nil, content: "History answer") == .done)
        #expect(AssistantRowPolicy.state(input: ChatAssistantInput.make(), content: "") == .thinking)
        #expect(AssistantRowPolicy.state(input: ChatAssistantInput.make(tasks: [AssistantTask(id: "s", kind: .reasoning, isDone: false,
                                                                                             query: "")]), content: "") == .thinking,
                "the start step is not listed, so the row still thinks")
        #expect(AssistantRowPolicy.state(input: ChatAssistantInput.make(tasks: [step]), content: "") == .streaming)
        #expect(AssistantRowPolicy.state(input: ChatAssistantInput.make(reasoning: "Hmm"), content: "") == .streaming)
        #expect(AssistantRowPolicy.state(input: ChatAssistantInput.make(), content: "Hel") == .streaming)
        #expect(AssistantRowPolicy.state(input: ChatAssistantInput.make(isDone: true), content: "Hello") == .done)
        #expect(AssistantRowPolicy.state(input: ChatAssistantInput.make(isDone: true), content: " ") == .error)
        #expect(AssistantRowPolicy.errorKind(input: ChatAssistantInput.make(isDone: true), content: "") == .empty)
        #expect(AssistantRowPolicy.state(input: ChatAssistantInput.make(errorKind: .generic), content: "Partial") == .error)
        #expect(AssistantRowPolicy.state(input: ChatAssistantInput.make(errorKind: .needsKey), content: "") == .needsKey)
        #expect(AssistantRowPolicy.canRetry(isAsker: true, state: .error, errorKind: .generic))
        #expect(AssistantRowPolicy.canRetry(isAsker: true, state: .error, errorKind: .empty))
        #expect(!AssistantRowPolicy.canRetry(isAsker: true, state: .error, errorKind: .unavailable))
        #expect(!AssistantRowPolicy.canRetry(isAsker: false, state: .error, errorKind: .generic), "Try Again is the asker's")
        #expect(!AssistantRowPolicy.canRetry(isAsker: true, state: .needsKey, errorKind: .needsKey))
    }

    @Test func theAnnouncementReadsTheFirstSentenceAsPlainText() {
        #expect(AssistantRowPolicy.firstSentence("## Summary\n- Launch moved to **Nov 4**") == "Summary")
        #expect(AssistantRowPolicy.firstSentence("The agenda has **three** items. Budget first.") == "The agenda has three items.")
        #expect(AssistantRowPolicy.firstSentence("Version 1.5 ships today! Yay") == "Version 1.5 ships today!")
        #expect(AssistantRowPolicy.firstSentence("See [the plan](https://x.io) now") == "See the plan now")
        let long = String(repeating: "word ", count: 80)
        #expect(AssistantRowPolicy.firstSentence(long).count <= AssistantRowPolicy.announcementLimit)
        #expect(AssistantRowPolicy.firstSentence("") == "")
        #expect(StreamingMarkdownParser.plainText(in: "# Title\n\nLine one\nline two\n\n---\n```\ncode\n```") ==
                "Title\nLine one line two\ncode")
    }

    // MARK: The core store (CH7, CH8)

    @Test func theAskersStreamUpdatesTheStateAndThrottlesRelays() {
        let clock = CHT7Clock()
        let store = Self.store(clock)
        var refreshes = 0
        store.onChange = { refreshes += 1 }
        store.begin(answerId: "a", question: "Roadmap?", questionMessageId: "q")
        #expect(refreshes == 1 && store.isAsker(answerId: "a"))
        #expect(AssistantRowPolicy.state(input: store.input(forMessageId: "a"), content: store.content(forMessageId: "a", messageContent: "")) == .thinking)

        clock.value = 10
        let firstTask = store.handle(NativeConclaveAssistantStreamEvent(
            kind: .task, delta: "", isReasoningDone: false,
            task: ConclaveAssistantRelayTask(id: "w", kind: "web_search", status: "running", query: "q4"), error: "",
            relay: Self.packet(content: "", done: false)), answerId: "a")
        #expect(firstTask != nil, "the first packet goes to the room at once")
        #expect(refreshes == 2, "a step is a process change: refresh at once")

        clock.value = 20
        #expect(store.handle(Self.event(.delta, delta: "Hel", relay: Self.packet(content: "Hel", done: false)), answerId: "a") == nil,
                "text growth waits for 350 ms or 160 characters")
        #expect(refreshes == 2, "text growth inside 100 ms is held")
        clock.value = 130
        _ = store.handle(Self.event(.delta, delta: "lo", relay: Self.packet(content: "Hello", done: false)), answerId: "a")
        #expect(refreshes == 3, "the held refresh goes out after 100 ms")
        clock.value = 400
        #expect(store.handle(Self.event(.delta, delta: "!", relay: Self.packet(content: "Hello!", done: false)), answerId: "a") != nil)
        clock.value = 410
        let long = String(repeating: "x", count: 170)
        #expect(store.handle(Self.event(.delta, delta: long, relay: Self.packet(content: "Hello!" + long, done: false)), answerId: "a") != nil,
                "160 more characters relay at once")
        #expect(store.content(forMessageId: "a", messageContent: "") == "Hello!" + long, "the asker's live text is authoritative")

        clock.value = 1_000
        _ = store.handle(Self.event(.reasoning, delta: "Thinking it over"), answerId: "a")
        clock.value = 4_000
        _ = store.handle(NativeConclaveAssistantStreamEvent(kind: .reasoning, delta: "", isReasoningDone: true, task: nil, error: "",
                                                            relay: nil), answerId: "a")
        clock.value = 4_100
        #expect(store.handle(Self.event(.done, relay: Self.packet(content: "Final.", done: true)), answerId: "a") != nil,
                "the final packet always relays")
        let input = store.input(forMessageId: "a")
        #expect(input?.isDone == true && input?.reasoningDone == true && input?.thoughtSeconds == 3)
        #expect(input?.tasks.allSatisfy { $0.isDone } == true && input?.isAsker == true)
        #expect(store.content(forMessageId: "a", messageContent: "") == "Final.")
        store.finish(answerId: "a", content: "")
        #expect(store.content(forMessageId: "a", messageContent: "") == "Final.", "an empty result keeps the streamed text")
        #expect(store.retryRecord(answerId: "a") == nil)
    }

    @Test func relayedPacketsDescribeEveryoneElsesAnswer() {
        let clock = CHT7Clock()
        let store = Self.store(clock)
        store.applyRelay(answerId: "r", reasoning: "Looking", reasoningDone: false,
                         tasks: [ConclaveAssistantRelayTask(id: "w", kind: "web_search", status: "running", query: "q")],
                         done: false, errored: false)
        var input = store.input(forMessageId: "r")
        #expect(input?.isAsker == false && input?.reasoning == "Looking" && input?.tasks.count == 1)
        #expect(store.content(forMessageId: "r", messageContent: "Relayed text") == "Relayed text", "the text is the message's")
        store.applyRelay(answerId: "r", reasoning: "Look", reasoningDone: true,
                         tasks: [ConclaveAssistantRelayTask(id: "w", kind: "web_search", status: "done")], done: true, errored: false)
        input = store.input(forMessageId: "r")
        #expect(input?.reasoning == "Looking" && input?.reasoningDone == true && input?.isDone == true && input?.tasks[0].isDone == true)
        store.applyRelay(answerId: "i", reasoning: "", reasoningDone: false, tasks: [], done: true, errored: true)
        #expect(store.input(forMessageId: "i")?.errorKind == .generic, "the SFU's interrupted notice ends the row as an error")
        #expect(store.retryRecord(answerId: "i") == nil, "only the asker retries")
        store.begin(answerId: "mine", question: "Q", questionMessageId: "q")
        store.applyRelay(answerId: "mine", reasoning: "spoof", reasoningDone: true, tasks: [], done: true, errored: true)
        #expect(store.input(forMessageId: "mine")?.reasoning == "" && store.input(forMessageId: "mine")?.isDone == false)
    }

    @Test func tryAgainExistsOnlyForTheAskersRetryableFailure() {
        let store = Self.store(CHT7Clock())
        store.begin(answerId: "a", question: "Roadmap?", questionMessageId: "q-1")
        store.fail(answerId: "a", kind: .generic)
        #expect(store.retryRecord(answerId: "a") == ConclaveAssistantRetryRecord(answerId: "a", question: "Roadmap?", questionMessageId: "q-1"))
        #expect(store.failedAnswerIds() == ["a"])
        store.begin(answerId: "b", question: "Q", questionMessageId: "q-2")
        store.fail(answerId: "b", kind: .unavailable)
        #expect(store.retryRecord(answerId: "b") == nil)
        store.begin(answerId: "a", question: "Roadmap?", questionMessageId: "q-1")
        #expect(store.retryRecord(answerId: "a") == nil && store.failedAnswerIds() == ["b"], "Try Again starts the answer afresh")
        store.reset()
        #expect(!store.hasAnswer("a") && store.input(forMessageId: "b") == nil)
    }

    // MARK: The presenter's assistant rows (S40 4 k, 4 i, 2 c)

    @Test func deltasRewriteOneEntryAndNeverTheTimeline() {
        let chat = Self.presenter([Self.answer("", input: ChatAssistantInput.make(isAsker: true))])
        #expect(chat.rows.entry(for: "ans").assistant?.state == .thinking)
        let publishes = chat.timelinePublishCount
        chat.apply(Self.inputs([Self.answer("## Summary\n\nLaunch moved", input: ChatAssistantInput.make(isAsker: true))]),
                   change: .assistant)
        let streaming = chat.rows.entry(for: "ans").assistant
        #expect(streaming?.state == .streaming && streaming?.blocks.count == 2)
        let committed = streaming?.blocks.first
        chat.apply(Self.inputs([Self.answer("## Summary\n\nLaunch moved to Nov 4", input: ChatAssistantInput.make(isAsker: true))]),
                   change: .assistant)
        let grown = chat.rows.entry(for: "ans").assistant
        #expect(grown?.blocks.first == committed, "committed blocks keep their id and value")
        #expect(grown?.blocks.last?.isStreamingTail == true && grown?.blocks.last?.text == "Launch moved to Nov 4")
        #expect(chat.timelinePublishCount == publishes, "the timeline does not change on deltas")
        let row = chat.rows.entry(for: "ans").row
        #expect(!row.canReply && !row.canReact && row.spans.isEmpty, "an answer is replied to and linkified once done")
    }

    @Test func aFailureIsARowStateNeverAnAnswerBody() {
        let chat = Self.presenter([Self.answer("Partial text", input: ChatAssistantInput.make(errorKind: .generic, isAsker: true))])
        let entry = chat.rows.entry(for: "ans")
        #expect(entry.assistant?.state == .error && entry.assistant?.errorKind == .generic && entry.assistant?.canRetry == true)
        #expect(entry.assistant?.blocks.isEmpty == true && entry.row.plainText.isEmpty && !entry.row.canCopy)
        var log: [ChatCommandRequest] = []
        chat.onCommand = { log.append($0) }
        chat.retryAssistant(rowId: "ans")
        #expect(log.map { $0.logLine } == ["retryAssistant rowId=ans messageId=ans"])
        let receiver = Self.presenter([Self.answer("Conclave was interrupted.", input: ChatAssistantInput.make(isDone: true, errorKind: .generic))])
        receiver.onCommand = { log.append($0) }
        receiver.retryAssistant(rowId: "ans")
        #expect(log.count == 1, "no Try Again for someone else's answer")
        #expect(receiver.rows.entry(for: "ans").assistant?.canRetry == false)
    }

    @Test func aCompletedAnswerIsAnnouncedOnce() {
        let chat = Self.presenter([Self.answer("", input: ChatAssistantInput.make())])
        chat.panelDidOpen(destination: .none, targetId: "")
        chat.apply(Self.inputs([Self.answer("The agenda has three items. More", input: ChatAssistantInput.make())]), change: .assistant)
        #expect(chat.announcement?.kind != "newMessage", "an open panel announces the answer when it completes, not when it appears")
        chat.apply(Self.inputs([Self.answer("The agenda has three items. More", input: ChatAssistantInput.make(isDone: true))]),
                   change: .assistant)
        let announcement = chat.announcement
        #expect(announcement?.kind == "assistantAnswered" && announcement?.text == "The agenda has three items.")
        chat.apply(Self.inputs([Self.answer("The agenda has three items. More!", input: ChatAssistantInput.make(isDone: true))]),
                   change: .assistant)
        #expect(chat.announcement?.id == announcement?.id, "never one per change")
        #expect(chat.rows.entry(for: "ans").row.canReply, "a finished answer can be replied to")
    }

    @Test func theIOS17FollowCounterMovesAtMostEvery250Milliseconds() {
        let clock = CHT7Clock()
        let chat = ChatPresenter()
        chat.now = { Self.base + clock.value }
        chat.apply(Self.inputs([Self.answer("", input: ChatAssistantInput.make())]), change: .messages)
        let start = chat.tailGrowth
        var text = "A"
        for step in 1...6 {
            clock.value = Double(step) * 100
            text += " word"
            chat.apply(Self.inputs([Self.answer(text, input: ChatAssistantInput.make())]), change: .assistant)
        }
        #expect(chat.tailGrowth - start <= 3, "600 ms of deltas move the counter at most every 250 ms")
        let before = chat.tailGrowth
        clock.value = 650
        chat.apply(Self.inputs([Self.answer(text, input: ChatAssistantInput.make(isDone: true))]), change: .assistant)
        #expect(chat.tailGrowth == before + 1, "completion always moves it")
    }

    // MARK: Fixture (S40 0.9 stream:3tasks)

    @Test func streamThreeTasksPlaysThroughTheRealStore() {
        let steps = ChatFixtureScript.streamScript()
        var listedIds: [String] = []
        var deltas = 0
        for step in steps {
            if let task = step.event.task, let kind = AssistantTaskKind.fromWire(task.kind), kind.isListed, !listedIds.contains(task.id) {
                listedIds.append(task.id)
            }
            if step.event.kind == .delta { deltas += 1 }
        }
        #expect(listedIds.count == 3 && deltas == 10 && steps.last?.event.kind == .done)

        let store = Self.store(CHT7Clock())
        let chat = ChatPresenter()
        chat.now = { Self.base + 600_000 }
        store.begin(answerId: "ans", question: "Roadmap?", questionMessageId: "")
        for step in steps {
            _ = store.handle(step.event, answerId: "ans")
        }
        let input = store.input(forMessageId: "ans")
        #expect(AssistantTaskPolicy.listed(input?.tasks ?? []).count == 3 && input?.isDone == true)
        chat.apply(Self.inputs([Self.answer(store.content(forMessageId: "ans", messageContent: ""), input: input)]), change: .assistant)
        let model = chat.rows.entry(for: "ans").assistant
        #expect(model?.state == .done && model?.tasks.count == 3 && model?.blocks.contains { $0.kind == .codeFence } == true)
        #expect(model?.reasoning == "Checking the roadmap doc, the notes and the shared browser.")
    }

    @Test func theBusyFixtureShowsEveryAssistantStateButApproval() {
        let shell = MeetingShellPresenter()
        let driver = ChatFixtureDriver.installOnStage(state: .busy, shell: shell)
        defer {
            ChatDiagnostics.driver = nil
            ChatDiagnostics.counters = nil
        }
        #expect(shell.chat.rows.entry(for: "s-a1").assistant?.state == .thinking)
        #expect(shell.chat.rows.entry(for: "s-a2").assistant?.state == .streaming)
        #expect(shell.chat.rows.entry(for: "s-a2").assistant?.tasks.count == 2)
        #expect(shell.chat.rows.entry(for: "s-a3").assistant?.state == .done)
        #expect(shell.chat.rows.entry(for: "s-13").assistant?.state == .done, "history answers are done")
        #expect(shell.chat.rows.entry(for: "s-a4").assistant?.canRetry == true)
        #expect(shell.chat.rows.entry(for: "s-a3").assistant?.approval == nil, "approval stays gated (W10-2)")
        shell.chat.retryAssistant(rowId: "s-a4")
        #expect(driver.actionsReadout.contains("retryAssistant rowId=s-a4"))
        #expect(ChatFixtureScriptName(rawValue: "stream:3tasks") == .stream3tasks)
    }

    // MARK: Sources

    @Test func theRowsStayStaticAndTheRendererStandsAlone() throws {
        let iosRow = try chatSource("Sources/Conclave/Features/Meeting/Chat/AssistantRow+iOS.swift")
        let iosMarkdown = try chatSource("Sources/Conclave/Features/Meeting/Chat/AssistantMarkdown+iOS.swift")
        let kotlinRow = try chatSource("Sources/Conclave/Skip/ui/chat/AssistantRow.kt")
        let kotlinMarkdown = try chatSource("Sources/Conclave/Skip/ui/chat/AssistantMarkdown.kt")
        for text in [iosRow, iosMarkdown, kotlinRow, kotlinMarkdown] {
            for forbidden in ["NativeTextShimmer", "NativeStreamingMarkdownView", "repeatForever", "symbolEffect", "infiniteRepeatable",
                              "rememberInfiniteTransition", "Gradient", "haptics.gesture(FeedbackKind.reactionSent)"] {
                #expect(!text.contains(forbidden), "R13: no shimmer, pulse or loop (\(forbidden))")
            }
            #expect(!chatHasDash(text))
        }
        #expect(iosRow.contains("ProgressView()") && iosRow.contains("DisclosureGroup(isExpanded:"))
        #expect(iosRow.contains("actions.openAssistantLink(url)") && iosRow.contains("actions.retryAssistant(row.id)"))
        #expect(kotlinRow.contains("CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp"))
        #expect(kotlinRow.contains("AnimatedVisibility(visible = expanded, enter = expandVertically()"))
        #expect(kotlinRow.contains("if (reduceMotion)") && kotlinRow.contains("role = Role.Button"))
        // TRN-2 reuses the renderers: no chat presenter or chat actions inside them.
        for text in [iosMarkdown, kotlinMarkdown] {
            #expect(!text.contains("ChatPresenter") && !text.contains("ChatRowActions"))
        }
        #expect(iosMarkdown.contains("struct AssistantMarkdownView: View") && iosMarkdown.contains(".accessibilityAddTraits(.isHeader)"))
        #expect(kotlinMarkdown.contains("internal fun AssistantMarkdown(") && kotlinMarkdown.contains("LinkAnnotation.Url(url"))
        #expect(kotlinMarkdown.contains("semantics { heading() }") && kotlinMarkdown.contains("horizontalScroll(rememberScrollState())"))
        let row = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatRow+iOS.swift")
        #expect(row.contains("AssistantRowView(entry: entry, actions: actions"))
        let kotlinChatRow = try chatSource("Sources/Conclave/Skip/ui/chat/ChatRow.kt")
        #expect(kotlinChatRow.contains("ChatRowKind.assistant -> ChatSwipeToReply(row, actions) { AssistantRow(entry, actions, sidePane, maxBubble) }"))
        let panel = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatPanel+iOS.swift")
        #expect(panel.contains("This link opens a website outside Conclave. Only open links you trust."))
        let timeline = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatTimeline+iOS.swift")
        #expect(timeline.contains("ChatStreamingFollow17(chat: chat, proxy: proxy, isAtBottom: isAtBottom)"))
    }

    @Test func bothPlatformsReadTheStreamAsItArrives() throws {
        let service = try chatSource("Sources/Conclave/Core/Networking/NativeConclaveAssistantService.swift")
        #expect(service.contains("URLSession.shared.bytes(for: request)"))
        #expect(service.contains("AndroidNativeHttpClient.requestAssistantStream("))
        #expect(service.contains("withTaskCancellationHandler(operation:") && service.contains("AndroidNativeHttpClient.cancelAssistantStream("))
        #expect(service.contains("typealias NativeConclaveAssistantEventHandler = @MainActor (NativeConclaveAssistantStreamEvent) -> Void"))
        #expect(service.contains("onEvent: @escaping NativeConclaveAssistantEventHandler"))
        let client = try chatSource("Sources/Conclave/Skip/AndroidNativeHttpClient.kt")
        #expect(client.contains("fun requestAssistantStream(") && client.contains("onChunk: (String) -> Unit"))
        #expect(client.contains("onDone: (String?, String?) -> Unit") && client.contains("fun cancelAssistantStream(requestId: String)"))
        #expect(client.contains("source.readUtf8Line()") && client.contains("fun requestAssistant("))
        let shimmerHost = try chatSource("Sources/Conclave/Shared/NativeStreamingMarkdown.swift")
        #expect(shimmerHost.contains("struct NativeTextShimmer: View"), "the legacy screens keep their shimmer")
    }

    /// Red until the integrator merges HD/strings/B6-T4.json (request R6).
    @Test func assistantStringsAreInBothCatalogs() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(
            with: Data(chatSource("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let keys = try #require(catalog["strings"] as? [String: Any])
        for key in ["Conclave", "AI", "Thinking", "Thinking\u{2026}", "Thought for %llds", "Thought Process", "Working", "Actions",
                    "Searching the web", "Searched the web", "Reading the transcript", "Read the meeting transcript",
                    "Preparing a GitHub issue", "Finished the GitHub issue request", "Using the shared browser",
                    "Used the shared browser", "Conclave couldn't answer right now.", "Conclave AI isn't available in this room.",
                    "Conclave's authorization expired. Try again.", "Conclave is being asked too quickly. Try again in a moment.",
                    "I didn't catch anything to answer.", "Conclave answered: %@", "Try Again", "Open External Link?",
                    "This link opens a website outside Conclave. Only open links you trust."] {
            #expect(keys[key] != nil, "missing iOS key \(key)")
        }
        let xml = try chatSource("Android/app/src/main/res/values/strings.xml")
        for name in ["chat_assistant_name", "chat_assistant_tag", "chat_assistant_thinking", "chat_assistant_reasoning_live",
                     "chat_assistant_thought_for", "chat_assistant_thought", "chat_assistant_working", "chat_assistant_actions",
                     "chat_task_web_running", "chat_task_web_done", "chat_task_transcript_running", "chat_task_transcript_done",
                     "chat_task_github_running", "chat_task_github_done", "chat_task_browser_running", "chat_task_browser_done",
                     "chat_assistant_error_generic", "chat_assistant_unavailable", "chat_assistant_error_expired",
                     "chat_assistant_error_rate", "chat_assistant_empty", "chat_ax_assistant_answered", "chat_assistant_expand",
                     "chat_assistant_collapse", "chat_assistant_expanded", "chat_assistant_collapsed", "ds_try_again",
                     "chat_link_body", "chat_link_body_app", "chat_action_copy_link"] {
            #expect(xml.contains("name=\"" + name + "\""), "missing Android name \(name)")
        }
    }

    // MARK: The core half (HD/requests/B6-T4.md R1, R2; red until the integrator applies them)

    /// The asker forwards the route's packet unchanged: the process fields survive a decode and encode (the SFU checks the
    /// signature over them), and an absent query stays absent.
    @Test func theRelayPacketKeepsItsSignedProcessFields() throws {
        let json = """
        {"id":"a","roomId":"r","channelId":"c","requesterUserId":"u","questionMessageId":"q","content":"Hi","done":false,\
        "timestamp":1,"expiresAt":2,"signature":"s","reasoning":"Hmm","reasoningDone":true,\
        "tasks":[{"id":"w","kind":"web_search","status":"done"}],"errored":false}
        """
        let packet = try JSONDecoder().decode(ConclaveAssistantRelayPacket.self, from: Data(json.utf8))
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(packet)) as? [String: Any])
        #expect(object["reasoning"] as? String == "Hmm" && object["reasoningDone"] as? Bool == true)
        let tasks = try #require(object["tasks"] as? [[String: Any]])
        #expect(tasks.count == 1 && tasks[0]["kind"] as? String == "web_search" && tasks[0]["query"] == nil)
    }

    @Test func theCoreStreamsRelaysAndRetriesTheAnswer() throws {
        let viewModel = try chatSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(viewModel.contains("NativeConclaveAssistantService.ask("))
        #expect(viewModel.contains("conclaveAssistant.handle(event, answerId: answerId)"))
        #expect(viewModel.contains("socketManager.relayConclaveAnswer(relay)"))
        #expect(viewModel.contains("ConclaveAssistantHistoryPolicy.items(messages: state.chatMessages"))
        #expect(viewModel.contains("ConclaveAssistantTranscriptPolicy.context("))
        #expect(viewModel.contains("conclaveAssistant.fail(answerId: answerId, kind: ConclaveAssistantFailurePolicy.kind(for: error))"))
        #expect(viewModel.contains("case .retryAssistant:") && viewModel.contains("socketManager.onConclaveAssistantPacket"))
        #expect(viewModel.contains("assistant: isAssistant ? conclaveAssistant.input(forMessageId: message.id) : nil"))
        #expect(viewModel.contains("cancelConclaveAssistantRequests()"))
        let messages = try chatSource("Sources/Conclave/Core/Models/SocketMessages.swift")
        #expect(messages.contains("var tasks: [ConclaveAssistantRelayTask]? = nil"))
        let ios = try chatSource("Sources/Conclave/Core/Networking/SocketIOManager.swift")
        #expect(ios.contains("self.onConclaveAssistantPacket?(packet)"))
        let kotlin = try chatSource("Sources/Conclave/Skip/SocketIOManager+Android.kt")
        #expect(kotlin.contains("decodeConclaveAssistantPacket(args.firstOrNull())"))
        #expect(kotlin.contains("payload.put(\"reasoningDone\", true)") && kotlin.contains("payload.put(\"tasks\", array)"))
    }

    // MARK: Helpers

    static func event(_ kind: NativeConclaveAssistantStreamEventKind, delta: String = "", error: String = "",
                      relay: ConclaveAssistantRelayPacket? = nil) -> NativeConclaveAssistantStreamEvent {
        NativeConclaveAssistantStreamEvent(kind: kind, delta: delta, isReasoningDone: false, task: nil, error: error, relay: relay)
    }

    static func packet(content: String, done: Bool) -> ConclaveAssistantRelayPacket {
        ConclaveAssistantRelayPacket(id: "a", roomId: "room-a", channelId: "room:room-a", requesterUserId: local,
                                     questionMessageId: "q", content: content, done: done, timestamp: base, expiresAt: base + 60_000,
                                     signature: "signed")
    }

    static func store(_ clock: CHT7Clock) -> ConclaveAssistantStore {
        let store = ConclaveAssistantStore()
        store.schedulesTimers = false
        store.now = { clock.value }
        return store
    }

    static func answer(_ content: String, input: ChatAssistantInput?) -> ChatMessageInput {
        ChatMessageInput.make(id: "ans", senderId: ConclaveAssistantChatIdentity.userId, senderName: ConclaveAssistantChatIdentity.displayName,
                              isAssistant: true, content: content, timestampMillis: base, assistant: input)
    }

    static func inputs(_ messages: [ChatMessageInput]) -> ChatInputs {
        ChatInputs.make(callSession: 1, roomId: "room-a", localUserId: local, localName: "Jordan Lee", messages: messages,
                        gate: .allowed, roster: [ChatRosterEntry(userId: local, name: "Jordan Lee", isPresent: true),
                                              ChatRosterEntry(userId: avery, name: "Avery Lee", isPresent: true)],
                        assistant: .available)
    }

    static func presenter(_ messages: [ChatMessageInput]) -> ChatPresenter {
        let chat = ChatPresenter()
        chat.now = { base + 600_000 }
        chat.apply(inputs(messages), change: .messages)
        return chat
    }
}

/// A test clock the store and presenter read.
final class CHT7Clock {
    var value = 0.0
}
#endif
