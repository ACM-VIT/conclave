#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct EmojiShortcodeTests {
    @Test func replacesSupportedShortcutsIncludingSeveralInOneMessage() {
        #expect(EmojiShortcodes.replace(":cry:") == "😢")
        #expect(EmojiShortcodes.replace("ship it :rocket: :tada: :+1:") == "ship it 🚀 🎉 👍")
        #expect(EmojiShortcodes.replace(":fire::fire:") == "🔥🔥")
        #expect(EmojiShortcodes.replace(":Smile:") == "😄")
    }

    @Test func leavesUnknownAndMalformedShortcutsAsTyped() {
        #expect(EmojiShortcodes.replace(":notanemoji:") == ":notanemoji:")
        #expect(EmojiShortcodes.replace(":smile") == ":smile")
        #expect(EmojiShortcodes.replace(": smile :") == ": smile :")
        #expect(EmojiShortcodes.replace("::") == "::")
        #expect(EmojiShortcodes.replace("meet at 10:30:15") == "meet at 10:30:15")
        #expect(EmojiShortcodes.replace(":constructor:") == ":constructor:")
        #expect(EmojiShortcodes.emoji(forShortcode: "__proto__") == nil)
    }

    @Test func aClosingColonOfAnUnknownNameStartsAKnownOne() {
        #expect(EmojiShortcodes.replace(":nope:smile:") == ":nope😄")
        #expect(EmojiShortcodes.replace(":" + String(repeating: "a", count: 41) + ":smile:")
                == ":" + String(repeating: "a", count: 41) + "😄")
    }

    @Test func doesNotTouchLinks() {
        #expect(EmojiShortcodes.replace("see https://example.com/a:smile:b :smile:") == "see https://example.com/a:smile:b 😄")
        #expect(EmojiShortcodes.replace("avery@example.com:smile:") == "avery@example.com😄")
    }

    @Test func keepsExistingUnicodeEmojiAndPlainTextUnchanged() {
        #expect(EmojiShortcodes.replace("already 😄 here") == "already 😄 here")
        #expect(EmojiShortcodes.replace("no colons") == "no colons")
        #expect(EmojiShortcodes.replace("😀:smile:😀") == "😀😄😀")
        #expect(EmojiShortcodes.replace("x :heart: y") == "x ❤️ y")
    }

    @Test func matchesWebWhenACombiningMarkFollowsTheClosingColon() {
        #expect(EmojiShortcodes.replace(":smile:\u{301}") == "😄\u{301}")
    }

    @Test func keepsADirectMessageRecipientExactlyAsTyped() {
        #expect(EmojiShortcodes.replaceInMessage("@sam:cry: secret :cry:") == "@sam:cry: secret 😢")
        #expect(EmojiShortcodes.replaceInMessage("/dm sam:cry: hi :wave:") == "/dm sam:cry: hi 👋")
        #expect(EmojiShortcodes.replaceInMessage("hello :wave:") == "hello 👋")
        #expect(EmojiShortcodes.replaceInMessage("  @sam:cry: hi :cry:") == "  @sam:cry: hi 😢")
        #expect(EmojiShortcodes.replaceInMessage("/DM sam:cry: :wave:") == "/DM sam:cry: 👋")
        #expect(EmojiShortcodes.replaceInMessage("/dm :wave:") == "/dm :wave:")
        #expect(EmojiShortcodes.replaceInMessage("@ :wave:") == "@ 👋")
    }

    @Test func outgoingTextLeavesSpokenAndGifMessagesAsTyped() {
        #expect(EmojiShortcodes.outgoing("/tts hi :wave:", hasGif: false) == "/tts hi :wave:")
        #expect(EmojiShortcodes.outgoing("/TTS :wave:", hasGif: false) == "/TTS :wave:")
        #expect(EmojiShortcodes.outgoing("/ttsx :wave:", hasGif: false) == "/ttsx 👋")
        #expect(EmojiShortcodes.outgoing("party :tada:", hasGif: true) == "party :tada:")
        #expect(EmojiShortcodes.outgoing("/me waves :wave:", hasGif: false) == "/me waves 👋")
    }

    @Test func chatRowsShowShortcutsTypedOnAnotherClientAsEmoji() {
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([
            ChatPoliciesTests.peer("s-1", "nice :tada: see https://x.io/a:smile:", at: 0),
            ChatMessageInput.make(id: "s-2", senderId: ChatPoliciesTests.avery, senderName: "Avery Lee", content: "/me waves :wave:",
                                  timestampMillis: ChatPoliciesTests.base + 1),
            ChatMessageInput.make(id: "s-3", senderId: ChatPoliciesTests.avery, senderName: "Avery Lee", content: "hi :wave:",
                                  timestampMillis: ChatPoliciesTests.base + 2, isTts: true),
        ]))
        let text = ChatPoliciesTests.row(chat, "s-1")
        #expect(text.plainText == "nice 🎉 see https://x.io/a:smile:")
        #expect(text.spans.map { $0.text } == ["nice 🎉 see ", "https://x.io/a:smile", ":"])
        #expect(text.spans.map { $0.kind } == [ChatSpanKind.text, ChatSpanKind.link, ChatSpanKind.text])
        #expect(ChatPoliciesTests.row(chat, "s-2").plainText.hasSuffix("waves :wave:"))
        #expect(ChatPoliciesTests.row(chat, "s-3").plainText.contains(":wave:"))
    }
}

#if os(macOS)

@MainActor
struct EmojiShortcodeSendTests {
    private func joinedViewModel() -> MeetingViewModel {
        let viewModel = isolatedViewModel()
        viewModel.state = MeetingState(userId: "local@example.com#local-session", sessionId: "local-session")
        viewModel.state.sfuUserId = "local@example.com"
        viewModel.state.displayName = "Local"
        viewModel.state.roomId = "room-a"
        viewModel.state.connectionState = ConnectionState.joined
        return viewModel
    }

    @Test func aSentMessageCarriesTheEmojiToEveryClient() async {
        let viewModel = joinedViewModel()
        viewModel.performChatCommand(ChatCommandRequest.make(.send, text: "ship it :rocket: :+1:",
                                                             emoji: ChatRouteKind.publicText.rawValue))
        #expect(viewModel.state.chatMessages.first?.content == "ship it 🚀 👍")
        #expect(await settle { viewModel.state.chatMessages.first?.delivery == .delivered })
        #expect(viewModel.state.chatMessages.first?.content == "ship it 🚀 👍")
    }

    @Test func aSpokenMessageIsSentAsTyped() async {
        let viewModel = joinedViewModel()
        viewModel.performChatCommand(ChatCommandRequest.make(.send, text: "/tts hi :wave:", emoji: ChatRouteKind.command.rawValue))
        #expect(await settle { viewModel.state.chatMessages.first?.delivery == .delivered })
        let content = viewModel.state.chatMessages.first?.content ?? ""
        #expect(content.hasSuffix("hi :wave:") && !content.contains("👋"))
    }
}

#endif
#endif
