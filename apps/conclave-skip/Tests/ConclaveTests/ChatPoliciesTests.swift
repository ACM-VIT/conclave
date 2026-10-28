#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// CHT-1 (OUT/PLAN-screens.md section 5; S40 0.5, 0.8 CH1, CH2, CH10, CH12 to CH15, CH17, 2, 3): the shared chat
/// models and policies, the presenter's rows, identity, grouping, unread capture and capabilities, the core's
/// reconstruction sites and the panel sources. The Kotlin half is T/Skip/ChatBridgeTests.kt; the composer is
/// T/CHT2ComposerPolicyTests.swift and the actions T/CHT3MessageActionsTests.swift.
@MainActor
struct ChatPoliciesTests {
    static let local = "jordan@example.com#s1"
    static let avery = "avery@example.com#w1"
    static let sam = "sam@example.com#w2"
    /// Noon UTC, so base and base + 10 minutes share a local day in every time zone from UTC-12 to UTC+14.
    static let base = 1_800_014_400_000.0

    static func roster() -> [ChatRosterEntry] {
        [
            ChatRosterEntry(userId: local, name: "Jordan Lee", isPresent: true),
            ChatRosterEntry(userId: avery, name: "Avery Lee", isPresent: true),
            ChatRosterEntry(userId: sam, name: "Sam Rivera", isPresent: true),
        ]
    }

    static func inputs(_ messages: [ChatMessageInput], localRows: [ChatLocalRow] = [], gate: ChatSendGate = .allowed,
                       isLocked: Bool = false, isHost: Bool = false, reactionsEnabled: Bool = true,
                       privateEnabled: Bool = true) -> ChatInputs {
        ChatInputs.make(callSession: 1, roomId: "room-a", localUserId: local, localName: "Jordan Lee", messages: messages,
                        localRows: localRows, isLocked: isLocked, privateEnabled: privateEnabled, reactionsEnabled: reactionsEnabled,
                        gate: gate, isHost: isHost, roster: roster(), assistant: .available)
    }

    static func peer(_ id: String, _ text: String, at offset: Double, from userId: String = avery, name: String = "Avery Lee",
                     reply: ChatReplyRef? = nil, isDirect: Bool = false, history: Bool = true,
                     reactions: [ChatReactionInput] = []) -> ChatMessageInput {
        ChatMessageInput.make(id: id, senderId: userId, senderName: name, content: text, timestampMillis: base + offset,
                              isDirect: isDirect, dmTargetUserId: isDirect ? local : "", dmTargetName: isDirect ? "Jordan Lee" : "",
                              reply: reply, reactions: reactions, isHistory: history)
    }

    static func own(_ id: String, clientId: String, _ text: String, at offset: Double,
                    delivery: ChatDelivery = .delivered, failure: ChatFailure = .none, retryable: Bool = false) -> ChatMessageInput {
        ChatMessageInput.make(id: id, clientId: clientId, senderId: local, senderName: "Jordan Lee", isOwn: true, content: text,
                              timestampMillis: base + offset, delivery: delivery, failure: failure, isRetryable: retryable)
    }

    static func presenter(_ inputs: ChatInputs) -> ChatPresenter {
        let chat = ChatPresenter()
        chat.now = { base + 600_000 }
        chat.sleep = { _ in }
        chat.apply(inputs, change: .messages)
        return chat
    }

    static func row(_ chat: ChatPresenter, _ id: String) -> ChatRowModel {
        chat.rows.entry(for: id).row
    }

    // MARK: CH17 linkify parity with the web (getChatMessageSegments)

    private func spans(_ text: String) -> [String] {
        ChatLinkifyPolicy.spans(text).map { span in
            span.kind == .link ? "link(\(span.text)|\(span.url))" : "text(\(span.text))"
        }
    }

    @Test func linkifyMatchesTheWebVectors() {
        #expect(spans("Visit https://example.com/a?b=1.") == ["text(Visit )", "link(https://example.com/a?b=1|https://example.com/a?b=1)", "text(.)"])
        #expect(spans("go to docs.example.com/agenda, then") == ["text(go to )", "link(docs.example.com/agenda|https://docs.example.com/agenda)", "text(,)", "text( then)"])
        #expect(spans("www.Example.com") == ["link(www.Example.com|https://www.Example.com)"])
        #expect(spans("HTTP://LOUD.EXAMPLE") == ["link(HTTP://LOUD.EXAMPLE|HTTP://LOUD.EXAMPLE)"])
        #expect(spans("(see https://x.io/y)") == ["text((see )", "link(https://x.io/y|https://x.io/y)", "text())"])
        #expect(spans("1.5 and e.g. a.b.c") == ["text(1.5 and e.g. a.b.c)"])
        // Web quirks kept for parity: a bare file name is a domain, and only the email's domain part matches.
        #expect(spans("file.txt") == ["link(file.txt|https://file.txt)"])
        #expect(spans("avery@example.com") == ["text(avery@)", "link(example.com|https://example.com)"])
        // A match holding "@" (behind a scheme) stays text.
        #expect(spans("https://user@host.example") == ["text(https://user@host.example)"])
        #expect(spans("") == ["text()"])
        #expect(spans("no links here") == ["text(no links here)"])
        #expect(spans("http:// nothing") == ["text(http:// nothing)"])
    }

    @Test func mentionsResolveAgainstKnownTokensAndYou() {
        let result = ChatMentionPolicy.applyMentions(ChatLinkifyPolicy.spans("hi @averylee and @jordanlee. @nobody"),
                                                     knownTokens: ["averylee"], youToken: "jordanlee")
        #expect(result.map { $0.kind } == [.text, .mention, .text, .mentionYou, .text])
        #expect(result.map { $0.text } == ["hi ", "@averylee", " and ", "@jordanlee", ". @nobody"])
        #expect(ChatMentionPolicy.normalizedToken(" Avery Lee! ") == "averylee")
        #expect(ChatMentionPolicy.firstLink(ChatLinkifyPolicy.spans("a docs.example.com b x.io")) == "https://docs.example.com")
    }

    // MARK: CH15 grouping and CH1 identity

    @Test func groupingFollowsTheWebTwoMinuteRule() {
        let replyRef = ChatReplyRef(messageId: "s-1", authorName: "Avery Lee", isAuthorYou: false, preview: "first", media: "",
                                    isPrivate: false)
        let chat = Self.presenter(Self.inputs([
            Self.peer("s-1", "first", at: 0),
            Self.peer("s-2", "second", at: 60_000),
            Self.peer("s-3", "late", at: 300_000),
            Self.peer("s-4", "with reply", at: 310_000, reply: replyRef),
            Self.peer("s-5", "/me waves", at: 320_000),
            Self.peer("s-6", "after action", at: 330_000),
            Self.peer("s-7", "private now", at: 340_000, isDirect: true),
            Self.peer("s-8", "other sender", at: 350_000, from: Self.sam, name: "Sam Rivera"),
        ]))
        #expect(Self.row(chat, "s-1").isGroupStart && !Self.row(chat, "s-1").isGroupEnd)
        #expect(!Self.row(chat, "s-2").isGroupStart && Self.row(chat, "s-2").isGroupEnd)
        #expect(Self.row(chat, "s-3").isGroupStart)
        #expect(Self.row(chat, "s-4").isGroupStart)
        #expect(Self.row(chat, "s-5").kind == .action && Self.row(chat, "s-5").plainText == "waves")
        #expect(Self.row(chat, "s-6").isGroupStart)
        #expect(Self.row(chat, "s-7").isGroupStart && Self.row(chat, "s-7").privacy == .privateReceived)
        #expect(Self.row(chat, "s-8").isGroupStart)
    }

    @Test func rowIdentitySurvivesTheAcknowledgementAndAHistoryRebuild() {
        let chat = Self.presenter(Self.inputs([Self.own("optimistic-1", clientId: "optimistic-1", "hello", at: 0, delivery: .sending)]))
        let sending = chat.rows.entry(for: "optimistic-1")
        #expect(sending.row.serverId.isEmpty && sending.row.delivery == .sending)
        #expect(!sending.row.canReact && !sending.row.canReply)
        #expect(chat.slowTasksStarted == 1)
        chat.apply(Self.inputs([Self.own("s-1", clientId: "optimistic-1", "hello", at: 0)]), change: .messages)
        #expect(chat.timeline.rowIds == ["optimistic-1"])
        #expect(chat.rows.entry(for: "optimistic-1") === sending)
        #expect(sending.row.serverId == "s-1" && sending.row.delivery == .delivered && sending.row.canReact)
        #expect(chat.rows.rowId(forMessageId: "s-1") == "optimistic-1")
        // A history rebuild after a reconnect carries the server id only; the row keeps its client id.
        chat.apply(Self.inputs([]), change: .messages)
        chat.apply(Self.inputs([ChatMessageInput.make(id: "s-1", senderId: Self.local, senderName: "Jordan Lee", isOwn: true,
                                                      content: "hello", timestampMillis: Self.base, isHistory: true)]),
                   change: .messages)
        #expect(chat.timeline.rowIds == ["optimistic-1"])
    }

    @Test func aPeerReplyToYourOwnMessageJumpsToTheOwnRow() {
        let replyRef = ChatReplyRef(messageId: "s-1", authorName: "Jordan Lee", isAuthorYou: true, preview: "hello", media: "",
                                    isPrivate: false)
        let chat = Self.presenter(Self.inputs([
            Self.own("s-1", clientId: "optimistic-1", "hello", at: 0),
            Self.peer("s-2", "replying", at: 1000, reply: replyRef, history: false),
        ]))
        #expect(Self.row(chat, "s-2").canJumpToReply)
        chat.jumpTo(messageId: "s-1")
        #expect(chat.timeline.focusId == "optimistic-1")
        #expect(chat.timeline.focusRequest == 1)
        let gone = Self.presenter(Self.inputs([Self.peer("s-9", "orphan", at: 0, reply: replyRef)]))
        #expect(!Self.row(gone, "s-9").canJumpToReply)
    }

    @Test func sendingTurnsSlowOnceThroughOnePresenterTask() {
        let chat = Self.presenter(Self.inputs([Self.own("optimistic-1", clientId: "optimistic-1", "hi", at: 0, delivery: .sending)]))
        #expect(Self.row(chat, "optimistic-1").delivery == .sending)
        chat.markSlow(rowId: "optimistic-1")
        #expect(Self.row(chat, "optimistic-1").delivery == .sendingSlow)
        chat.apply(Self.inputs([Self.own("optimistic-1", clientId: "optimistic-1", "hi", at: 0, delivery: .failed,
                                         failure: .timedOut, retryable: true)]), change: .messages)
        let failed = Self.row(chat, "optimistic-1")
        #expect(failed.delivery == .failed && failed.canRetry && failed.canDelete && failed.failure == .timedOut)
        // A row that is no longer sending never turns slow again.
        chat.markSlow(rowId: "optimistic-1")
        #expect(Self.row(chat, "optimistic-1").delivery == .failed)
    }

    // MARK: CH12 unread capture, 2 c structure

    @Test func unreadRowsAreCapturedOnOpenAndTheDividerLeavesOnClose() {
        var messages = [Self.peer("s-1", "old", at: 0)]
        let chat = Self.presenter(Self.inputs(messages))
        messages.append(Self.own("s-2", clientId: "c-2", "mine", at: 1000))
        messages.append(Self.peer("s-3", "new one", at: 2000, history: false))
        messages.append(Self.peer("s-4", "new two", at: 3000, history: false))
        messages.append(Self.peer("s-5", "history", at: 4000, history: true))
        chat.apply(Self.inputs(messages), change: .messages)
        #expect(chat.pendingUnreadCount == 2)
        chat.panelDidOpen(destination: .none, targetId: "")
        let ids = chat.timeline.rowIds
        let divider = ids.firstIndex(of: "unread")
        #expect(divider != nil)
        if let divider { #expect(ids[divider + 1] == "s-3") }
        #expect(chat.timeline.firstUnreadId == "s-3")
        chat.panelDidClose()
        #expect(!chat.timeline.rowIds.contains("unread"))
        chat.panelDidOpen(destination: .none, targetId: "")
        #expect(!chat.timeline.rowIds.contains("unread"))
    }

    @Test func anOpenPanelAnnouncesNewRemoteMessagesAndCoalescesBursts() {
        var messages = [Self.peer("s-1", "old", at: 0)]
        let chat = Self.presenter(Self.inputs(messages))
        chat.panelDidOpen(destination: .none, targetId: "")
        messages.append(Self.peer("s-2", "Can you share the deck?", at: 1000, history: false))
        chat.apply(Self.inputs(messages), change: .messages)
        #expect(chat.announcement?.kind == "newMessage" && chat.announcement?.name == "Avery Lee")
        messages.append(Self.peer("s-3", "again", at: 2000, history: false))
        chat.apply(Self.inputs(messages), change: .messages)
        #expect(chat.announcement?.kind == "newMessages" && chat.announcement?.count == 2)
    }

    @Test func daySeparatorsMarkOnlyDayChanges() {
        let today = Self.base + 600_000
        let yesterday = today - 86_400_000
        let chat = ChatPresenter()
        chat.now = { today }
        chat.apply(Self.inputs([
            ChatMessageInput.make(id: "s-1", senderId: Self.avery, senderName: "Avery Lee", content: "old", timestampMillis: yesterday),
            ChatMessageInput.make(id: "s-2", senderId: Self.avery, senderName: "Avery Lee", content: "new", timestampMillis: today),
        ]), change: .messages)
        let ids = chat.timeline.rowIds
        #expect(ids.count == 4)
        #expect(ids[0] == "day:" + String(ChatDayPolicy.dayKey(millis: yesterday)))
        #expect(ids[2] == "day:" + String(ChatDayPolicy.dayKey(millis: today)))
        let todayOnly = Self.presenter(Self.inputs([Self.peer("s-1", "now", at: 600_000)]))
        #expect(todayOnly.timeline.rowIds == ["s-1"])
    }

    @Test func localRowsKeepTheirNoticeAndTone() {
        let chat = Self.presenter(Self.inputs([], localRows: [
            ChatLocalRow(id: "l-1", text: "You're already muted.", notice: .alreadyMuted, isError: false, timestampMillis: Self.base),
            ChatLocalRow(id: "l-2", text: "Command /camera failed: x", notice: .none, isError: true, timestampMillis: Self.base + 1),
        ]))
        #expect(Self.row(chat, "local:l-1").kind == .system && Self.row(chat, "local:l-1").notice == .alreadyMuted)
        #expect(Self.row(chat, "local:l-2").systemTone == .error)
        #expect(!chat.timeline.isEmpty)
        #expect(Self.presenter(Self.inputs([])).timeline.isEmpty)
    }

    @Test func capabilitiesFollowTheGateThePoliciesAndTheRowKind() {
        let messages = [
            Self.peer("s-1", "public https://x.io", at: 0),
            Self.peer("s-2", "private", at: 1000, isDirect: true),
            Self.own("optimistic-3", clientId: "optimistic-3", "sending", at: 2000, delivery: .sending),
            ChatMessageInput.make(id: "s-4", senderId: ConclaveAssistantChatIdentity.userId, senderName: "Conclave AI",
                                  isAssistant: true, content: "answer", timestampMillis: Self.base + 3000),
        ]
        let open = Self.presenter(Self.inputs(messages))
        let peer = Self.row(open, "s-1")
        #expect(peer.canReply && peer.canReact && peer.canMessagePrivately && peer.canHideSender && peer.canCopy && peer.canCopyLink)
        #expect(!peer.canReport)
        #expect(!Self.row(open, "s-2").canReact && Self.row(open, "s-2").canReply)
        #expect(!Self.row(open, "optimistic-3").canReply && !Self.row(open, "optimistic-3").canReact)
        let assistant = Self.row(open, "s-4")
        #expect(assistant.kind == .assistant && !assistant.canHideSender && !assistant.canMessagePrivately && assistant.canReply)
        let locked = Self.presenter(Self.inputs(messages, gate: .locked, isLocked: true))
        #expect(!Self.row(locked, "s-1").canReply && !Self.row(locked, "s-1").canReact && Self.row(locked, "s-1").canCopy)
        let reactionsOff = Self.presenter(Self.inputs(messages, reactionsEnabled: false))
        #expect(!Self.row(reactionsOff, "s-1").canReact)
        let host = Self.presenter(Self.inputs(messages, isHost: true, reactionsEnabled: false))
        #expect(Self.row(host, "s-1").canReact)
        for rowId in open.timeline.rowIds {
            #expect(!Self.row(open, rowId).canReport)
        }
    }

    @Test func thePanelSnapshotCarriesTheLockAndTheGate() {
        let guest = Self.presenter(Self.inputs([], gate: .locked, isLocked: true))
        #expect(guest.panel.isLocked && !guest.panel.isHost && guest.panel.gate == .locked)
        let host = Self.presenter(Self.inputs([], isLocked: true, isHost: true))
        #expect(host.panel.isLocked && host.panel.isHost && host.composer.isLockedForOthers)
    }

    @Test func aNewCallSessionAndResetLeaveNoRowsOrDrafts() {
        let chat = Self.presenter(Self.inputs([Self.peer("s-1", "hi", at: 0)]))
        chat.drafts.setText("draft", for: "room-a|")
        chat.hideSender(userId: Self.avery)
        chat.reset()
        #expect(chat.timeline.isEmpty && chat.drafts.count == 0 && chat.hiddenSenderIds.isEmpty)
        chat.apply(Self.inputs([Self.peer("s-1", "hi", at: 0)]), change: .messages)
        let next = ChatInputs.make(callSession: 2, roomId: "room-b", localUserId: Self.local, localName: "Jordan Lee",
                                   gate: .allowed, roster: Self.roster())
        chat.apply(next, change: .messages)
        #expect(chat.timeline.isEmpty)
    }

    // MARK: CH10 failure mapping

    @Test func chatFailuresMapFromTheServerTextAndTheClassifier() {
        let table: [(String, ChatFailure)] = [
            ("you are sending messages too quickly", .rateLimited),
            ("message too long (max 1000 characters)", .tooLong),
            ("tts messages are limited to 500 characters.", .voiceTooLong),
            ("tts is disabled by the host in this room.", .voiceDisabled),
            ("chat is locked by the host", .locked),
            ("watch-only attendees cannot send chat messages", .attendee),
            ("private messages are disabled by the host.", .privateDisabled),
            ("multiple users match \"sam\". use a more specific username.", .privateTargetAmbiguous),
            ("you cannot private message yourself.", .privateSelf),
            ("private message target is no longer available.", .privateTargetLeft),
            ("user \"x\" not found for private message.", .privateTargetMissing),
            ("private replies must stay in the same private thread.", .replyPrivateThread),
            ("reply target is no longer available.", .replyUnavailable),
            ("not in a room", .notConnected),
            ("something else", .unknown),
        ]
        for (text, expected) in table {
            #expect(ChatFailurePolicy.failure(serverMessage: text) == expected, "\(text)")
        }
        #expect(ChatFailurePolicy.failure(category: .timedOut, serverText: "") == .timedOut)
        #expect(ChatFailurePolicy.failure(category: .offline, serverText: "") == .notConnected)
        #expect(ChatFailurePolicy.failure(category: .rejectedByServer, serverText: "Chat is locked by the host") == .locked)
        #expect(ChatFailurePolicy.isRetryable(.timedOut) && ChatFailurePolicy.isRetryable(.rateLimited))
        #expect(!ChatFailurePolicy.isRetryable(.tooLong) && !ChatFailurePolicy.isRetryable(.privateTargetLeft))
        #expect(ChatFailurePolicy.showsReason(.rateLimited) && !ChatFailurePolicy.showsReason(.timedOut))
    }

    // MARK: CH1 to CH3 through the wire models and every reconstruction site

    @Test func notificationReactionsReachTheChatMessage() throws {
        let json = """
        {"id":"s-1","userId":"avery@example.com#w1","displayName":"Avery","content":"hi","timestamp":1000,
         "reactions":[{"emoji":"👍","userIds":["a","b"]}]}
        """
        let notification = try JSONDecoder().decode(ChatMessageNotification.self, from: Data(json.utf8))
        let message = notification.chatMessage(taggedRoomId: "room-a")
        #expect(message.reactions == [ChatMessageReaction(emoji: "👍", userIds: ["a", "b"])])
        #expect(message.clientId == nil && message.sendStatus == nil && message.delivery == .delivered)
        let plain = try JSONDecoder().decode(ChatMessageNotification.self,
                                             from: Data(#"{"id":"s-2","userId":"u","content":"x","timestamp":1}"#.utf8))
        #expect(plain.chatMessage(taggedRoomId: nil).reactions.isEmpty)
    }

    @Test func everyReconstructionSiteCarriesTheNewFields() throws {
        let vm = try chatSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        // normalizedChatMessage (both branches) and refreshChatDisplayName pass the three fields through.
        #expect(vm.components(separatedBy: "clientId: message.clientId,\n            sendStatus: message.sendStatus,\n            reactions: message.reactions").count - 1 == 2)
        #expect(vm.components(separatedBy: "clientId: message.clientId,\n                sendStatus: message.sendStatus,\n                reactions: message.reactions").count - 1 == 1)
        #expect(vm.contains("clientId: incoming.clientId ?? existing.clientId"))
        #expect(vm.contains("reactions: incoming.reactions.isEmpty ? existing.reactions : incoming.reactions"))
        #expect(vm.contains("clientId: optimisticId,\n            sendStatus: ChatSendStatus.sending"))
        #expect(vm.contains("private func rebuiltChatMessage("))
        // The echo and the acknowledgement keep the client id (CH1).
        #expect(vm.contains("rebuiltChatMessage(normalized, clientId: optimisticId, sendStatus: nil"))
        #expect(vm.contains("rebuiltChatMessage(normalized, clientId: optimisticMessageId, sendStatus: nil"))
        let kotlin = try chatSource("Sources/Conclave/Skip/SocketIOManager+Android.kt")
        #expect(kotlin.contains("reactions = decodeChatReactionsArray(obj.optJSONArray(\"reactions\"))"))
        #expect(kotlin.contains("replyTo = null,\n            reactions = null"))
        #expect(kotlin.contains("reactions = reactions ?: skip.lib.Array()"))
        #expect(kotlin.contains("decodeChatReactionChanged(args.firstOrNull())"))
        #expect(kotlin.contains("internal suspend fun toggleChatReaction(messageId: String, emoji: String)"))
        let messages = try chatSource("Sources/Conclave/Core/Models/SocketMessages.swift")
        #expect(messages.contains("reactions: reactions ?? []"))
    }

    // MARK: Sources (S40 1 l 7, 3, CH22)

    @Test func chatSourcesStayInsideTheirRules() throws {
        let legacy = ["ChatMentionCandidate", "ChatMentionSuggestion", "ChatTimelineEntry", "ChatGroupingPolicy", "ChatComposerLayout",
                      "ChatMessageRow", "ChatTimelineView", "ChatComposerView", "ChatEmptyStateView", "ChatReplyQuoteView"]
        let files = try chatFiles(under: "Sources/Conclave/Features/Meeting/Chat", extensions: ["swift"])
        #expect(files.count >= 12)
        for file in files {
            let text = try chatSource(file)
            for forbidden in [".fullScreenCover", "presentationBackground", "presentationCornerRadius", "NavigationStack",
                              ".medium", "glassEffect", "GlassEffectContainer", "MeetingViewModel", "MeetingState", "Gradient",
                              "gradient", "sensoryFeedback"] {
                #expect(!text.contains(forbidden), "\(file) uses \(forbidden)")
            }
            for name in legacy {
                #expect(!text.contains("struct " + name + " ") && !text.contains("enum " + name + " ")
                        && !text.contains("class " + name + " "), "\(file) redeclares \(name)")
            }
            #expect(!chatHasDash(text), "\(file) contains an en or em dash")
            if file.hasSuffix("+iOS.swift") {
                #expect(text.hasPrefix("#if os(iOS) && !SKIP\n") || text.hasPrefix("#if DEBUG && os(iOS) && !SKIP\n"), "\(file)")
            }
        }
        for file in try chatFiles(under: "Sources/Conclave/Skip/ui/chat", extensions: ["kt"]) {
            let text = try chatSource(file)
            #expect(!text.contains("verticalScroll"), "\(file) wraps the chat list in verticalScroll")
            #expect(!text.contains("Gradient") && !text.contains("gradient"), "\(file)")
            #expect(!text.contains("dynamicLightColorScheme") && !text.contains("dynamicDarkColorScheme"), "\(file)")
            #expect(!text.contains("Color(0x"), "\(file) uses a color literal")
            #expect(!text.contains("fontFamily ="), "\(file)")
            #expect(!text.contains("chat_action_report"), "\(file) shows Report")
            #expect(!chatHasDash(text), "\(file) contains an en or em dash")
        }
        // Readouts and counters only in Debug blocks or the fixture (CH22).
        let row = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatRow+iOS.swift")
        #expect(row.contains("#if DEBUG\n        let _ = ChatDiagnostics.counters?.bump"))
        let timeline = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatTimeline+iOS.swift")
        #expect(timeline.contains(".defaultScrollAnchor(.bottom)") && timeline.contains(".scrollDismissesKeyboard(.interactively)"))
        #expect(timeline.contains("onScrollGeometryChange") && timeline.contains("ChatBottomSentinelState"))
        let android = try chatSource("Sources/Conclave/Skip/ui/chat/ChatTimeline.kt")
        #expect(android.contains("reverseLayout = true") && android.contains("contentType = { reversed.kinds[it] }"))
        #expect(android.contains("key = { reversed.ids[it] }") && android.contains("imeNestedScroll()"))
        let panel = try chatSource("Sources/Conclave/Skip/ui/chat/ChatPanel.kt")
        #expect(panel.contains("contentMode = InCallPageContent.lazyList") && panel.contains("hasComposer = !viewerInPane"))
    }

    @Test func rowsOwnOneSummaryElementAndKeepControlsSeparate() throws {
        let ios = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatRow+iOS.swift")
        #expect(ios.contains(".accessibilityLabel(ChatCopy.rowLabel(row))"))
        #expect(ios.contains(".accessibilityActions {\n            ChatRowAccessibilityActions(row: row, actions: actions)"))
        #expect(!ios.contains("accessibilityElement(children: .combine)\n            ChatBubble"))
        #expect(!ios.contains(".textSelection"))
        #expect(ios.contains("ConclaveChatBubble(tone: row.bubbleTone"))
        let kotlin = try chatSource("Sources/Conclave/Skip/ui/chat/ChatRow.kt")
        #expect(kotlin.contains("onLongClick(label = menuLabel)") && kotlin.contains("this.customActions = customActions"))
        #expect(kotlin.contains("detectTapGestures(onLongPress"))
        #expect(kotlin.contains("LinkAnnotation.Url("))
    }
}

#if os(macOS)
/// The core half of CHT-1 to CHT-3 on the macOS host (S40 CH1, CH2, CH3, CH12, CH13, S30 CC5).
@MainActor
struct ChatViewModelWiringTests {
    private func joinedViewModel() -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        return viewModel
    }

    @Test func theAcknowledgementKeepsTheClientId() async {
        let viewModel = joinedViewModel()
        viewModel.performChatCommand(ChatCommandRequest.make(.send, text: "hello native", emoji: ChatRouteKind.publicText.rawValue))
        #expect(viewModel.state.chatMessages.count == 1)
        let clientId = viewModel.state.chatMessages.first?.clientId ?? ""
        #expect(clientId.hasPrefix("optimistic-"))
        #expect(viewModel.state.chatMessages.first?.delivery == .sending)
        #expect(viewModel.chat.timeline.rowIds == [clientId])
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(viewModel.state.chatMessages.count == 1)
        #expect(viewModel.state.chatMessages.first?.clientId == clientId)
        #expect(!(viewModel.state.chatMessages.first?.id.hasPrefix("optimistic-") ?? true))
        #expect(viewModel.state.chatMessages.first?.delivery == .delivered)
        #expect(viewModel.chat.timeline.rowIds == [clientId])
    }

    @Test func aFailedSendStaysWithItsTextAndRetries() async {
        let viewModel = joinedViewModel()
        viewModel.socketManager.testSendChatError = ChatWiringHostError("Timed out waiting for the SFU")
        viewModel.performChatCommand(ChatCommandRequest.make(.send, text: "this times out", emoji: ChatRouteKind.publicText.rawValue))
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(viewModel.state.chatMessages.count == 1)
        let failed = viewModel.state.chatMessages.first
        #expect(failed?.delivery == .failed)
        #expect(failed?.sendStatus?.failure == ChatFailure.timedOut.rawValue && failed?.sendStatus?.isRetryable == true)
        #expect(failed?.content == "this times out")
        #expect(viewModel.state.errorMessage == nil)
        let clientId = failed?.clientId ?? ""
        #expect(viewModel.chat.rows.entry(for: clientId).row.canRetry)
        viewModel.socketManager.testSendChatError = nil
        viewModel.performChatCommand(ChatCommandRequest.make(.retry, rowId: clientId))
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(viewModel.state.chatMessages.first?.delivery == .delivered)
        #expect(viewModel.state.chatMessages.first?.clientId == clientId)
    }

    @Test func deleteRemovesOnlyAFailedRow() async {
        let viewModel = joinedViewModel()
        viewModel.socketManager.testSendChatError = ChatWiringHostError("Message too long (max 1000 characters)")
        viewModel.performChatCommand(ChatCommandRequest.make(.send, text: "nope", emoji: ChatRouteKind.publicText.rawValue))
        try? await Task.sleep(nanoseconds: 50_000_000)
        let clientId = viewModel.state.chatMessages.first?.clientId ?? ""
        #expect(viewModel.state.chatMessages.first?.sendStatus?.isRetryable == false)
        viewModel.performChatCommand(ChatCommandRequest.make(.discard, rowId: clientId))
        #expect(viewModel.state.chatMessages.isEmpty)
    }

    @Test func aReactionTogglesOptimisticallyAndRollsBackOnFailure() async {
        let viewModel = joinedViewModel()
        viewModel.state.chatMessages = [ChatMessage(id: "s-1", userId: "remote@example.com#w", displayName: "Remote",
                                                    content: "hi", roomId: "room-a")]
        viewModel.socketManager.testChatReactionError = ChatWiringHostError("Reactions disabled by host")
        viewModel.toggleChatReaction(messageId: "s-1", emoji: "👍")
        #expect(viewModel.state.chatMessages.first?.reactions == [ChatMessageReaction(emoji: "👍", userIds: ["local@example.com"])])
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(viewModel.state.chatMessages.first?.reactions.isEmpty == true)
        #expect(viewModel.state.systemMessages.last?.notice == ChatNotice.reactionFailed.rawValue)
        viewModel.socketManager.testChatReactionError = nil
        viewModel.socketManager.testChatReactionResult = [ChatMessageReaction(emoji: "👍", userIds: ["local@example.com", "x"])]
        viewModel.toggleChatReaction(messageId: "s-1", emoji: "👍")
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(viewModel.state.chatMessages.first?.reactions.first?.userIds.count == 2)
        #expect(viewModel.chat.rows.entry(for: "s-1").row.reactions.first?.isMine == true)
        #expect(viewModel.socketManager.onChatReactionChanged != nil)
    }

    @Test func chatRefreshesOnlyForChatFields() {
        let viewModel = joinedViewModel()
        viewModel.state.participants = ["remote@example.com#w": Participant(id: "remote@example.com#w", displayName: "Remote")]
        let before = viewModel.chatRefreshCount
        viewModel.state.participants["remote@example.com#w"]?.isMuted = false
        viewModel.state.participants["remote@example.com#w"]?.isHandRaised = true
        #expect(viewModel.chatRefreshCount == before)
        viewModel.state.displayNames = ["remote@example.com#w": "Remote Person"]
        #expect(viewModel.chatRefreshCount == before + 1)
        viewModel.state.isChatLocked = true
        #expect(viewModel.chatRefreshCount == before + 2)
        viewModel.state.chatMessages.append(ChatMessage(id: "s-9", userId: "remote@example.com#w", displayName: "Remote",
                                                        content: "x", roomId: "room-a"))
        #expect(viewModel.chatRefreshCount == before + 3)
        #expect(viewModel.chat.timeline.rowIds.contains("s-9"))
    }

    @Test func isChatOpenFollowsTheNativeChatPanel() {
        let viewModel = joinedViewModel()
        viewModel.state.unreadChatCount = 4
        viewModel.shell.panels.present(.chat, from: .call)
        #expect(viewModel.state.isChatOpen)
        #expect(viewModel.state.unreadChatCount == 0)
        guard let current = viewModel.shell.panels.snapshot.current else {
            Issue.record("no current panel")
            return
        }
        viewModel.shell.panels.dismiss(cancelPending: true)
        #expect(!viewModel.state.isChatOpen)
        viewModel.shell.panels.didDismiss(session: viewModel.shell.panels.snapshot.session, presentationID: current.presentationID)
        #expect(!viewModel.state.isChatOpen)
    }

    @Test func nativeCommandsRunTheGuardedBranches() async {
        let viewModel = joinedViewModel()
        viewModel.state.isMuted = true
        viewModel.performChatCommand(ChatCommandRequest.make(.send, text: "/mute", emoji: ChatRouteKind.command.rawValue))
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(viewModel.state.isMuted)
        #expect(viewModel.state.systemMessages.last?.notice == ChatNotice.alreadyMuted.rawValue)
        #expect(viewModel.state.chatMessages.isEmpty)
    }
}

/// The texts of the iOS `SocketError` cases (`timeout` and `serverError`), which exist only in the iOS build; the macOS
/// host classifies an error by its text, like `PresenterHostError` in PresenterSessionTests.
private struct ChatWiringHostError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
#endif

// MARK: Helpers (private to this file)

private func chatPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

func chatSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: chatPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

func chatFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = chatPackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

func chatHasDash(_ text: String) -> Bool {
    text.unicodeScalars.contains { $0.value == 0x2013 || $0.value == 0x2014 }
}
#endif
