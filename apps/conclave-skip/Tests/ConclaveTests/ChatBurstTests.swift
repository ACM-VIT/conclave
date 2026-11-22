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

        chat.panelDidOpen(destination: .none, targetId: "")
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
        chat.panelDidOpen(destination: .none, targetId: "")
        #expect(chat.emojiParseCount == parsed + 30)
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

    @Test func anOpenChatStillRebuildsAndAnnouncesEachMessage() {
        var messages = history(3)
        let chat = Chat.presenter(Chat.inputs(messages))
        chat.panelDidOpen(destination: .none, targetId: "")
        let built = chat.rebuildCount
        messages.append(Chat.peer("n-0", "hello there", at: 100, history: false))
        chat.apply(Chat.inputs(messages), change: .messages)
        #expect(chat.rebuildCount == built + 1)
        #expect(chat.announcement?.kind == "newMessage")
    }
}
#endif
