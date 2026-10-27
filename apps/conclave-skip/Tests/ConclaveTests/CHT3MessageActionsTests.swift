#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// CHT-3 (OUT/PLAN-screens.md section 5; S40 5, 3 reaction chips, 0.8 CH3, CH21; RECONCILE OQ5): the web reaction
/// rules, the chips, the presenter's toggle and reactor list, hiding and showing a sender, Report kept hidden
/// (`canReport` false), the action and accessibility sources on both platforms and the socket wiring. The Kotlin half is
/// in T/Skip/ChatBridgeTests.kt.
@MainActor
struct CHT3MessageActionsTests {
    // MARK: CH3 rules (meeting-core and apps/web chat-reactions.ts)

    @Test func reactionRulesMirrorTheWeb() {
        #expect(ChatReactionRules.emojis == ["👍", "👏", "😂", "❤️", "🎉", "😮", "😢", "🤔"])
        #expect(ChatReactionRules.quickEmojis == ["👍", "❤️", "😂", "🎉", "😮"])
        #expect(Set(ChatReactionRules.quickEmojis + ChatReactionRules.moreEmojis) == Set(ChatReactionRules.emojis))
        #expect(ChatReactionRules.maxDistinctPerMessage == 12)
        let added = ChatReactionRules.toggled([], emoji: "👍", userId: "me")
        #expect(added == [ChatMessageReaction(emoji: "👍", userIds: ["me"])])
        let joined = ChatReactionRules.toggled([ChatMessageReaction(emoji: "👍", userIds: ["a"])], emoji: "👍", userId: "me")
        #expect(joined == [ChatMessageReaction(emoji: "👍", userIds: ["a", "me"])])
        #expect(ChatReactionRules.toggled(joined, emoji: "👍", userId: "me") == [ChatMessageReaction(emoji: "👍", userIds: ["a"])])
        #expect(ChatReactionRules.toggled(added, emoji: "👍", userId: "me").isEmpty)
        var full: [ChatMessageReaction] = []
        for index in 0..<12 {
            full.append(ChatMessageReaction(emoji: "e" + String(index), userIds: ["x"]))
        }
        #expect(ChatReactionRules.toggled(full, emoji: "👍", userId: "me") == full)
        #expect(ChatReactionRules.toggled(full, emoji: "e3", userId: "me").first(where: { $0.emoji == "e3" })?.userIds == ["x", "me"])
        #expect(ChatReactionRules.canReact(serverId: "s-1", isDirect: false, gate: .open, reactionsEnabled: true, isHost: false))
        #expect(!ChatReactionRules.canReact(serverId: "optimistic-1", isDirect: false, gate: .open, reactionsEnabled: true, isHost: false))
        #expect(!ChatReactionRules.canReact(serverId: "local-1", isDirect: false, gate: .open, reactionsEnabled: true, isHost: false))
        #expect(!ChatReactionRules.canReact(serverId: "s-1", isDirect: true, gate: .open, reactionsEnabled: true, isHost: false))
        #expect(!ChatReactionRules.canReact(serverId: "s-1", isDirect: false, gate: .locked, reactionsEnabled: true, isHost: false))
        #expect(ChatReactionRules.canReact(serverId: "s-1", isDirect: false, gate: .open, reactionsEnabled: false, isHost: true))
        #expect(ChatReactionRules.nameKey("🤔") == "thinking" && ChatReactionRules.nameKey("🔥").isEmpty)
    }

    @Test func chipsNameYouFirstAndCountTheRest() {
        let names = ["a": "Avery", "b": "Sam", "c": "Priya", "d": "Morgan"]
        let chips = ChatReactionRules.chips([
            ChatReactionInput(emoji: "👍", userIds: ["a", "me", "b", "c", "d"], includesMe: true),
            ChatReactionInput(emoji: "😂", userIds: ["b"], includesMe: false),
            ChatReactionInput(emoji: "🎉", userIds: [], includesMe: false),
        ]) { id in id == "me" ? "" : (names[id] ?? "") }
        #expect(chips.count == 2)
        #expect(chips[0].names == ["", "Avery", "Sam"] && chips[0].remaining == 2 && chips[0].isMine && chips[0].count == 5)
        #expect(chips[1].names == ["Sam"] && chips[1].remaining == 0 && !chips[1].isMine)
    }

    // MARK: The presenter's toggle and reactor list

    @Test func aToggleSendsTheServerIdAndRespectsTheCap() {
        var log: [ChatCommandRequest] = []
        var cap: [ChatReactionInput] = []
        for index in 0..<12 {
            cap.append(ChatReactionInput(emoji: "e" + String(index), userIds: [ChatPoliciesTests.sam], includesMe: false))
        }
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([
            ChatPoliciesTests.peer("s-1", "hi", at: 0),
            ChatPoliciesTests.peer("s-2", "full", at: 1000, reactions: cap),
            ChatPoliciesTests.peer("s-3", "private", at: 2000, isDirect: true),
            ChatPoliciesTests.own("s-4", clientId: "optimistic-4", "mine", at: 3000),
        ]))
        chat.onCommand = { log.append($0) }
        chat.toggleReaction(rowId: "s-1", emoji: "👍")
        #expect(log.last == ChatCommandRequest.make(.react, rowId: "s-1", messageId: "s-1", emoji: "👍"))
        #expect(ChatPoliciesTests.row(chat, "s-2").isAtReactionCap)
        let before = log.count
        chat.toggleReaction(rowId: "s-2", emoji: "👍")
        #expect(log.count == before)
        chat.toggleReaction(rowId: "s-2", emoji: "e1")
        #expect(log.count == before + 1)
        chat.toggleReaction(rowId: "s-3", emoji: "👍")
        #expect(log.count == before + 1)
        // An acknowledged own message reacts with its server id, never the client row id.
        chat.toggleReaction(rowId: "optimistic-4", emoji: "😂")
        #expect(log.last?.messageId == "s-4" && log.last?.rowId == "optimistic-4")
    }

    @Test func theViewerListsEveryReactorYouFirst() {
        var ids = [ChatPoliciesTests.avery, ChatPoliciesTests.sam]
        for index in 0..<4 {
            ids.append("guest" + String(index) + "@example.com#g")
        }
        ids.append(ChatPoliciesTests.local)
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([
            ChatPoliciesTests.peer("s-1", "hi", at: 0, reactions: [ChatReactionInput(emoji: "👍", userIds: ids, includesMe: true)]),
        ]))
        let reactors = chat.reactors(rowId: "s-1", emoji: "👍")
        #expect(reactors.count == 7)
        #expect(reactors.first?.userId == ChatPoliciesTests.local)
        #expect(reactors[1].name == "Avery Lee" && reactors[2].name == "Sam Rivera")
        #expect(reactors[3].name == "guest0")
        let chip = ChatPoliciesTests.row(chat, "s-1").reactions.first
        #expect(chip?.names.count == 3 && chip?.remaining == 4)
    }

    // MARK: CH21 hide and show a sender (Q2b, OQ5)

    @Test func hidingASenderRemovesTheirRowsAndShowRestoresThemInOrder() {
        let messages = [
            ChatPoliciesTests.peer("s-1", "one", at: 0),
            ChatPoliciesTests.peer("s-2", "two", at: 1000, from: ChatPoliciesTests.sam, name: "Sam Rivera"),
            ChatPoliciesTests.peer("s-3", "three", at: 2000),
        ]
        var log: [ChatCommandRequest] = []
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs(messages))
        chat.onCommand = { log.append($0) }
        let original = chat.timeline.rowIds
        chat.hideSender(userId: ChatPoliciesTests.avery)
        let hiddenIds = chat.timeline.rowIds
        #expect(!hiddenIds.contains("s-1") && !hiddenIds.contains("s-3") && hiddenIds.contains("s-2"))
        let notice = ChatPoliciesTests.row(chat, "hidden:" + ChatPoliciesTests.avery)
        #expect(notice.kind == .system && notice.notice == .senderHidden && notice.noticeArgument == "Avery Lee")
        #expect(chat.isSenderHidden(ChatPoliciesTests.avery))
        #expect(log.last?.kind == .hideSender)
        // New messages from a hidden sender stay out (no rows, no unread).
        var more = messages
        more.append(ChatPoliciesTests.peer("s-4", "four", at: 3000, history: false))
        chat.apply(ChatPoliciesTests.inputs(more), change: .messages)
        #expect(!chat.timeline.rowIds.contains("s-4") && chat.pendingUnreadCount == 0)
        chat.showSender(userId: ChatPoliciesTests.avery)
        #expect(chat.timeline.rowIds == original + ["s-4"])
        #expect(!chat.isSenderHidden(ChatPoliciesTests.avery))
        // Never yourself or the assistant; reset clears the set.
        chat.hideSender(userId: ChatPoliciesTests.local)
        chat.hideSender(userId: ConclaveAssistantChatIdentity.userId)
        #expect(chat.hiddenSenderIds.isEmpty)
        chat.hideSender(userId: ChatPoliciesTests.sam)
        chat.reset()
        #expect(chat.hiddenSenderIds.isEmpty)
    }

    @Test func reportStaysHiddenUntilTheWp10Backend() throws {
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([ChatPoliciesTests.peer("s-1", "hi", at: 0)]))
        #expect(!ChatPoliciesTests.row(chat, "s-1").canReport)
        let ios = try chatSource("Sources/Conclave/Features/Meeting/Chat/MessageActions+iOS.swift")
        #expect(!ios.contains("Report"))
        let sheet = try chatSource("Sources/Conclave/Skip/ui/chat/MessageActionsSheet.kt")
        #expect(!sheet.contains("chat_action_report"))
    }

    // MARK: Action sources (5 c, 5 d, 5 i)

    @Test func theIosMenuAndActionsFollowTheMenuOrder() throws {
        let menu = try chatSource("Sources/Conclave/Features/Meeting/Chat/MessageActions+iOS.swift")
        #expect(menu.contains(".controlGroupStyle(.palette)"))
        #expect(menu.contains("ChatReactionRules.quickEmojis") && menu.contains("Menu(ConclaveStrings.text(\"More Reactions\"))"))
        #expect(menu.contains("Button(ConclaveStrings.text(\"Delete\"), role: .destructive)"))
        let order = ["\"Reply\"", "\"Send Private Message\"", "\"Copy\"", "\"Copy Link\"", "\"View Reactions\"", "\"Hide Messages from %@\""]
        var cursor = menu.startIndex
        for label in order {
            guard let range = menu.range(of: label, range: cursor..<menu.endIndex) else {
                Issue.record("menu misses \(label) in order")
                return
            }
            cursor = range.upperBound
        }
        let row = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatRow+iOS.swift")
        let actionOrder = ["\"Reply\"", "\"Add Reaction\"", "\"Send Private Message\"", "\"Copy\"", "\"Copy Link\"",
                           "\"View Reactions\"", "\"Hide Messages from %@\"", "\"Try Again\"", "\"Delete\"", "\"Go to Original Message\""]
        guard let start = row.range(of: "struct ChatRowAccessibilityActions") else {
            Issue.record("no accessibility actions")
            return
        }
        cursor = start.upperBound
        for label in actionOrder {
            guard let range = row.range(of: label, range: cursor..<row.endIndex) else {
                Issue.record("accessibility actions miss \(label) in order")
                return
            }
            cursor = range.upperBound
        }
        #expect(row.contains(".contextMenu {\n            MessageMenu(row: row, actions: actions)\n        } preview: {"))
        #expect(row.contains(".swipeActions(edge: .leading, allowsFullSwipe: true)"))
        let viewer = try chatSource("Sources/Conclave/Features/Meeting/Chat/ReactionsViewer+iOS.swift")
        #expect(viewer.contains(".listStyle(.insetGrouped)") && viewer.contains("chat.reactors(rowId: rowId, emoji: chip.emoji)"))
    }

    @Test func theAndroidSheetMenuAndViewerFollowTheirContainers() throws {
        let sheet = try chatSource("Sources/Conclave/Skip/ui/chat/MessageActionsSheet.kt")
        #expect(sheet.contains("rememberModalBottomSheetState(skipPartiallyExpanded = true)"))
        #expect(sheet.contains("NativeSemanticsPopupRoot(\"chat.actions.sheet\")") && sheet.contains("NativeSemanticsPopupRoot(\"chat.actions.menu\")"))
        #expect(sheet.contains("testTagsAsResourceId = true") && sheet.contains("maxItemsInEachRow = 8"))
        #expect(sheet.contains("haptics.gesture(FeedbackKind.reactionSent)"))
        let row = try chatSource("Sources/Conclave/Skip/ui/chat/ChatRow.kt")
        #expect(row.contains("haptics.gesture(FeedbackKind.longPress)") && row.contains("FeedbackKind.swipeThresholdCrossed"))
        #expect(row.contains("enableDismissFromEndToStart = false") && row.contains("scope.launch { state.reset() }"))
        #expect(row.contains("onLongPress = { _ -> actions.openViewer(row.id) }"))
        let viewer = try chatSource("Sources/Conclave/Skip/ui/chat/ReactionsViewer.kt")
        #expect(viewer.contains("PrimaryScrollableTabRow") && viewer.contains("presenter.reactors(rowId, chip.emoji)"))
        let panel = try chatSource("Sources/Conclave/Skip/ui/chat/ChatPanel.kt")
        #expect(panel.contains("if (!sidePane && actions.menuRowId.isNotEmpty())"))
        #expect(panel.contains("isNested = viewerInPane"))
    }

    @Test func theReactionWireIsConnectedOnEveryPlatform() throws {
        let ios = try chatSource("Sources/Conclave/Core/Networking/SocketIOManager.swift")
        #expect(ios.contains("func toggleChatReaction(messageId: String, emoji: String) async throws -> [ChatMessageReaction]"))
        #expect(ios.contains("emit(event: SocketEvent.chatReact, payload: request)"))
        let symbol = try chatSource("Sources/Conclave/Core/Networking/SocketIOManager+Android.swift")
        #expect(symbol.contains("var onChatReactionChanged: ((ChatReactionChangedNotification) -> Void)?"))
        #expect(symbol.contains("func toggleChatReaction(messageId: String, emoji: String) async throws -> [ChatMessageReaction] { fatalError() }"))
        let kotlin = try chatSource("Sources/Conclave/Skip/SocketIOManager+Android.kt")
        #expect(kotlin.contains("emit(SocketEvent.chatReact, payload)"))
        let vm = try chatSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")
        #expect(vm.contains("socketManager.onChatReactionChanged = { [weak self] notification in"))
        #expect(vm.contains("socketManager.toggleChatReaction(messageId: messageId, emoji: emoji)"))
    }
}
#endif
