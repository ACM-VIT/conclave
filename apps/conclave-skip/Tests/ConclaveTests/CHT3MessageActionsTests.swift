#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct CHT3MessageActionsTests {

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
        #expect(ChatReactionRules.canReact(serverId: "s-1", isDirect: false, gate: .allowed, reactionsEnabled: true, isHost: false))
        #expect(!ChatReactionRules.canReact(serverId: "optimistic-1", isDirect: false, gate: .allowed, reactionsEnabled: true, isHost: false))
        #expect(!ChatReactionRules.canReact(serverId: "local-1", isDirect: false, gate: .allowed, reactionsEnabled: true, isHost: false))
        #expect(!ChatReactionRules.canReact(serverId: "s-1", isDirect: true, gate: .allowed, reactionsEnabled: true, isHost: false))
        #expect(!ChatReactionRules.canReact(serverId: "s-1", isDirect: false, gate: .locked, reactionsEnabled: true, isHost: false))
        #expect(ChatReactionRules.canReact(serverId: "s-1", isDirect: false, gate: .allowed, reactionsEnabled: false, isHost: true))
        #expect(ChatReactionRules.nameKey("🤔") == "thinking" && ChatReactionRules.nameKey("🔥").isEmpty)
    }

    @Test func chipsNameYouFirstAndCountTheRest() throws {
        let names = ["a": "Avery", "b": "Sam", "c": "Priya", "d": "Morgan"]
        let chips = ChatReactionRules.chips([
            ChatReactionInput(emoji: "👍", userIds: ["a", "me", "b", "c", "d"], includesMe: true),
            ChatReactionInput(emoji: "😂", userIds: ["b"], includesMe: false),
            ChatReactionInput(emoji: "🎉", userIds: [], includesMe: false),
        ]) { id in id == "me" ? "" : (names[id] ?? "") }

        try #require(chips.count == 2)
        #expect(chips[0].names == ["", "Avery", "Sam"] && chips[0].remaining == 2 && chips[0].isMine && chips[0].count == 5)
        #expect(chips[1].names == ["Sam"] && chips[1].remaining == 0 && !chips[1].isMine)
    }

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

        chat.toggleReaction(rowId: "optimistic-4", emoji: "😂")
        #expect(log.last?.messageId == "s-4" && log.last?.rowId == "optimistic-4")
    }

    @Test func theViewerListsEveryReactorYouFirst() throws {
        var ids = [ChatPoliciesTests.avery, ChatPoliciesTests.sam]
        for index in 0..<4 {
            ids.append("guest" + String(index) + "@example.com#g")
        }
        ids.append(ChatPoliciesTests.local)
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([
            ChatPoliciesTests.peer("s-1", "hi", at: 0, reactions: [ChatReactionInput(emoji: "👍", userIds: ids, includesMe: true)]),
        ]))
        let reactors = chat.reactors(rowId: "s-1", emoji: "👍")

        try #require(reactors.count == 7)
        #expect(reactors.first?.userId == ChatPoliciesTests.local)
        #expect(reactors[1].name == "Avery Lee" && reactors[2].name == "Sam Rivera")
        #expect(reactors[3].name == "guest0")
        let chip = ChatPoliciesTests.row(chat, "s-1").reactions.first
        #expect(chip?.names.count == 3 && chip?.remaining == 4)
    }

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

        var more = messages
        more.append(ChatPoliciesTests.peer("s-4", "four", at: 3000, history: false))
        chat.apply(ChatPoliciesTests.inputs(more), change: .messages)
        #expect(!chat.timeline.rowIds.contains("s-4") && chat.pendingUnreadCount == 0)
        chat.showSender(userId: ChatPoliciesTests.avery)
        #expect(chat.timeline.rowIds == original + ["s-4"])
        #expect(!chat.isSenderHidden(ChatPoliciesTests.avery))

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
    }

}
#endif
