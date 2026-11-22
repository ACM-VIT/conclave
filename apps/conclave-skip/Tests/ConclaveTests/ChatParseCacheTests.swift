#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ChatParseCacheTests {
    typealias Chat = ChatPoliciesTests

    @Test func eachMessageIsParsedForEmojiAndLinksOnceNotOnEveryNewMessage() {
        var messages: [ChatMessageInput] = []
        for index in 0..<300 {
            messages.append(Chat.peer("h-" + String(index), "see :smile: at 10:30 on example.com", at: Double(index)))
        }
        let chat = Chat.presenter(Chat.inputs(messages))
        chat.panelDidOpen(destination: .none, targetId: "")
        let parsed = chat.emojiParseCount
        #expect(parsed == 300)
        for index in 0..<20 {
            messages.append(Chat.peer("n-" + String(index), "new :smile: " + String(index), at: 1_000.0 + Double(index),
                                      history: false))
            chat.apply(Chat.inputs(messages), change: .messages)
        }
        #expect(chat.emojiParseCount == parsed + 20)
        #expect(chat.rows.entry(for: "n-19").row.plainText == "new 😄 19")
        #expect(chat.rows.entry(for: "h-0").row.spans.contains { $0.kind == .link && $0.url == "https://example.com" })
    }
}
#endif
