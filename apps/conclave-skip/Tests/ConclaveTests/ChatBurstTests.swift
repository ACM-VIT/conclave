#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ClosedChatWorkTests {
    typealias Chat = ChatPoliciesTests

    private func history(_ count: Int) -> [ChatMessageInput] {
        var messages: [ChatMessageInput] = []
        for index in 0..<count {
            messages.append(Chat.peer("h-" + String(index), "message " + String(index), at: Double(index)))
        }
        return messages
    }

    @Test func newMessagesWhileClosedBuildNoRowsButStillPlaceTheUnreadDivider() {
        var messages = history(500)
        let chat = Chat.presenter(Chat.inputs(messages))
        let built = chat.rebuildCount
        for index in 0..<5 {
            messages.append(Chat.peer("n-" + String(index), "new " + String(index), at: 1_000.0 + Double(index), history: false))
            chat.apply(Chat.inputs(messages), change: .messages)
        }
        messages.append(Chat.own("o-1", clientId: "c-1", "mine", at: 2_000))
        chat.apply(Chat.inputs(messages), change: .messages)
        #expect(chat.rebuildCount == built)
        #expect(chat.hasDeferredRows)
        #expect(chat.pendingUnreadCount == 5)

        chat.openPanel()
        #expect(!chat.hasDeferredRows)
        #expect(chat.rebuildCount > built)
        let rowIds = chat.timeline.rowIds
        let divider = rowIds.firstIndex(of: "unread")
        #expect(divider != nil)
        #expect(divider.map { rowIds[$0 + 1] } == "n-0")
        #expect(rowIds.last == "c-1")
        #expect(chat.announcement == nil)
    }

    @Test func aClosedChatParsesNothingUntilItOpens() {
        var messages = history(50)
        let chat = Chat.presenter(Chat.inputs(messages))
        let parsed = chat.emojiParseCount
        for index in 0..<30 {
            messages.append(Chat.peer("n-" + String(index), "hi :wave: " + String(index), at: 1_000.0 + Double(index),
                                      history: false))
            chat.apply(Chat.inputs(messages), change: .messages)
        }
        #expect(chat.emojiParseCount == parsed)
        chat.openPanel()
        #expect(chat.emojiParseCount == parsed + 30)
    }

    @Test func theUnreadDividerSitsAtTheFirstMessageThatArrivedUnreadEvenWhenAnOlderOneArrivesLater() {
        var messages = history(3)
        let chat = Chat.presenter(Chat.inputs(messages))
        messages.append(Chat.peer("late", "sent second", at: 200, history: false))
        chat.apply(Chat.inputs(messages), change: .messages)
        messages.append(Chat.peer("early", "sent first", at: 150, history: false))
        chat.apply(Chat.inputs(messages), change: .messages)
        chat.openPanel()
        let rowIds = chat.timeline.rowIds
        let divider = rowIds.firstIndex(of: "unread")
        #expect(divider.map { rowIds[$0 + 1] } == "late")
        #expect(rowIds.firstIndex(of: "early").map { $0 < divider ?? 0 } == true)
    }

    @Test func readingTheClosedTimelineCatchesUpWithoutCountingAnythingTwice() {
        var messages = history(3)
        let chat = Chat.presenter(Chat.inputs(messages))
        messages.append(Chat.peer("n-0", "new", at: 100, history: false))
        chat.apply(Chat.inputs(messages), change: .messages)
        #expect(chat.timeline.rowIds.contains("n-0"))
        #expect(chat.rows.entry(for: "n-0").row.plainText == "new")
        #expect(!chat.hasDeferredRows)
        messages.append(Chat.peer("n-1", "newer", at: 101, history: false))
        chat.apply(Chat.inputs(messages), change: .messages)
        #expect(chat.pendingUnreadCount == 2)
    }

    @Test func hidingAndShowingTheReplyAuthorWhileClosedDropsTheReplyFromTheChipAndTheSend() {
        var messages = history(2)
        let chat = Chat.presenter(Chat.inputs(messages))
        var log: [ChatCommandRequest] = []
        chat.onCommand = { log.append($0) }
        chat.openPanel()
        chat.beginReply(rowId: "h-1")
        #expect(chat.composer.reply?.messageId == "h-1")
        chat.closePanel()
        messages.append(Chat.peer("n-0", "new", at: 100, from: Chat.sam, name: "Sam Rivera", history: false))
        chat.apply(Chat.inputs(messages), change: .messages)
        chat.hideSender(userId: Chat.avery)
        chat.showSender(userId: Chat.avery)
        chat.openPanel()
        #expect(chat.composer.reply == nil)
        chat.send(text: "hello")
        #expect(log.last?.kind == .send)
        #expect(log.last?.rowId == "")
        #expect(log.last?.messageId == "")
    }

    @Test func aCompleteAssistantAnswerWithoutProcessStateCountsAsUnreadWhileClosed() {
        var messages = history(1)
        let chat = Chat.presenter(Chat.inputs(messages))
        messages.append(ChatMessageInput.make(id: "answer", senderId: ConclaveAssistantChatIdentity.userId, senderName: "Conclave",
                                              isAssistant: true, content: "Here is the answer.", timestampMillis: Chat.base + 100))
        chat.apply(Chat.inputs(messages), change: .messages)
        #expect(chat.pendingUnreadCount == 1)
        messages[messages.count - 1] = ChatMessageInput.make(id: "answer", senderId: ConclaveAssistantChatIdentity.userId,
                                                             senderName: "Conclave", isAssistant: true,
                                                             content: "Here is the answer.", timestampMillis: Chat.base + 100,
                                                             assistant: ChatAssistantInput.make(reasoningDone: true, isDone: true))
        chat.apply(Chat.inputs(messages), change: .messages)
        #expect(chat.pendingUnreadCount == 1)
        chat.openPanel()
        let rowIds = chat.timeline.rowIds
        let divider = rowIds.firstIndex(of: "unread")
        #expect(divider.map { rowIds[$0 + 1] } == "answer")
    }

    @Test func openingAfterAClosedBurstRebuildsOnce() {
        var messages = history(3)
        let chat = Chat.presenter(Chat.inputs(messages))
        for index in 0..<10 {
            messages.append(Chat.peer("n-" + String(index), "new " + String(index), at: 100.0 + Double(index), history: false))
            chat.apply(Chat.inputs(messages), change: .messages)
        }
        let built = chat.rebuildCount
        chat.openPanel()
        chat.route(to: .none, targetId: "")
        #expect(chat.rebuildCount == built + 1)
        #expect(chat.timeline.rowIds.contains("unread"))
    }

    @Test func resetForgetsTheLastCallsEmojiText() {
        let messages = [Chat.peer("h-0", "hi :wave:", at: 0), Chat.peer("h-1", "bye :wave:", at: 1)]
        let chat = Chat.presenter(Chat.inputs(messages))
        let parsed = chat.emojiParseCount
        #expect(parsed == 2)
        chat.reset()
        chat.apply(Chat.inputs(messages), change: .messages)
        #expect(chat.emojiParseCount == parsed + 2)
    }

    @Test func anOpenChatStillRebuildsAndAnnouncesEachMessage() {
        var messages = history(3)
        let chat = Chat.presenter(Chat.inputs(messages))
        chat.openPanel()
        let built = chat.rebuildCount
        messages.append(Chat.peer("n-0", "hello there", at: 100, history: false))
        chat.apply(Chat.inputs(messages), change: .messages)
        #expect(chat.rebuildCount == built + 1)
        #expect(chat.announcement?.kind == "newMessage")
    }
}
#endif
