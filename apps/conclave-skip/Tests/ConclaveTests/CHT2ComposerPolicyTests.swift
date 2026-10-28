#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct CHT2ComposerPolicyTests {
    private let privateMode = ChatComposerMode(privateToUserId: "avery@example.com#w1", isVoiceMode: false, privateEnabled: true,
                                               voiceEnabled: true)

    @Test func everyDraftTakesTheSameRouteOrder() {
        let route = ChatComposerPolicy.route
        #expect(route("@Conclave hi", privateMode) == ChatRoute(kind: .blocked, wireText: "", failure: .assistantIsPublic))
        #expect(route("/leave", privateMode) == ChatRoute(kind: .command, wireText: "/leave", failure: .none))
        #expect(route("/mute", privateMode).kind == .command)
        #expect(route("/tts x", privateMode) == ChatRoute(kind: .blocked, wireText: "", failure: .privateTextOnly))
        #expect(route("hello", privateMode) == ChatRoute(kind: .privateText, wireText: "/dm avery@example.com#w1 hello", failure: .none))
        #expect(route("@Conclave hi", .everyone) == ChatRoute(kind: .assistant, wireText: "@Conclave hi", failure: .none))
        #expect(route("  hello  ", .everyone) == ChatRoute(kind: .publicText, wireText: "hello", failure: .none))

        #expect(route("/word hi", .everyone).kind == .publicText)
        #expect(route("   ", .everyone).kind == .blocked)
        let voice = ChatComposerMode(privateToUserId: "", isVoiceMode: true, privateEnabled: true, voiceEnabled: true)
        #expect(route("read this", voice) == ChatRoute(kind: .voice, wireText: "/tts read this", failure: .none))
        let voicePrivate = ChatComposerMode(privateToUserId: "u", isVoiceMode: true, privateEnabled: true, voiceEnabled: true)
        #expect(route("read this", voicePrivate).failure == .privateTextOnly)
        let privateOff = ChatComposerMode(privateToUserId: "", isVoiceMode: false, privateEnabled: false, voiceEnabled: true)
        #expect(route("@avery hello", privateOff).failure == .privateDisabled)
        #expect(route("/dm avery hello", privateOff).kind == .command)
    }

    @Test func aBlockedSendDispatchesNothingKeepsTheDraftAndNamesTheReason() {
        var log: [ChatCommandRequest] = []
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([]))
        chat.onCommand = { log.append($0) }
        chat.setPrivateTo(userId: ChatPoliciesTests.avery)
        #expect(chat.composer.privateTo?.name == "Avery Lee")
        #expect(chat.send(text: "@Conclave hi") == .blocked)
        #expect(log.isEmpty && chat.composer.inlineNotice == .assistantIsPublic)
        chat.clearInlineNotice()
        #expect(chat.composer.inlineNotice == .none)
        #expect(chat.send(text: "/leave") == .dispatched)
        #expect(log.last?.emoji == ChatRouteKind.command.rawValue && log.last?.text == "/leave")
        #expect(chat.send(text: "/tts x") == .blocked && chat.composer.inlineNotice == .privateTextOnly)
        #expect(chat.send(text: "psst") == .dispatched)
        #expect(log.last?.emoji == ChatRouteKind.privateText.rawValue)
        #expect(log.last?.text == "/dm " + ChatPoliciesTests.avery + " psst" && log.last?.userId == ChatPoliciesTests.avery)
        chat.setPrivateTo(userId: "")
        #expect(chat.send(text: "@Conclave summarize") == .dispatched && log.last?.emoji == ChatRouteKind.assistant.rawValue)
        #expect(chat.send(text: "") == .empty)
        let gated = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([], gate: .reconnecting))
        gated.onCommand = { log.append($0) }
        let before = log.count
        #expect(gated.send(text: "hello") == .blocked && log.count == before)
    }

    @Test func aReplyClearsAfterASendThatConsumedItAndStaysForCommands() {
        var log: [ChatCommandRequest] = []
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([ChatPoliciesTests.peer("s-1", "hi", at: 0)]))
        chat.onCommand = { log.append($0) }
        chat.beginReply(rowId: "s-1")
        #expect(chat.composer.reply?.messageId == "s-1" && chat.composer.reply?.authorName == "Avery Lee")
        chat.send(text: "/help")
        #expect(chat.composer.reply != nil && log.last?.rowId == "s-1")
        chat.send(text: "answer")
        #expect(chat.composer.reply == nil && log.last?.messageId == "s-1")

        let privateChat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([ChatPoliciesTests.peer("s-2", "secret", at: 0, isDirect: true)]))
        privateChat.beginReply(rowId: "s-2")
        #expect(privateChat.composer.privateTo?.userId == ChatPoliciesTests.avery && privateChat.composer.reply?.isPrivate == true)
    }

    @Test func limitsCountUtf16UnitsLikeTheSfu() {
        let thumbs = String(repeating: "👍", count: 600)
        #expect(ChatComposerPolicy.limitLength(text: thumbs, isVoice: false) == 1200)
        #expect(ChatComposerPolicy.isOverLimit(text: thumbs, isVoiceMode: false))
        let family = "👨‍👩‍👧‍👦"
        #expect(ChatComposerPolicy.utf16Length(family) == 11)
        #expect(ChatComposerPolicy.utf16Length("🇺🇸") == 4)
        let nearLimit = String(repeating: "a", count: 988) + family
        #expect(ChatComposerPolicy.limitLength(text: nearLimit, isVoice: false) == 999)
        #expect(!ChatComposerPolicy.isOverLimit(text: nearLimit, isVoiceMode: false))

        #expect(ChatComposerPolicy.limitLength(text: "/dm avery " + String(repeating: "b", count: 1000), isVoice: false) == 1000)
        let voice = "/tts " + String(repeating: "c", count: 501)
        #expect(ChatComposerPolicy.limit(text: voice, isVoiceMode: false) == 500)
        #expect(ChatComposerPolicy.isOverLimit(text: voice, isVoiceMode: false))
        #expect(ChatComposerPolicy.limit(text: "anything", isVoiceMode: true) == 500)
        #expect(!ChatComposerPolicy.canSend(text: thumbs, gate: .allowed, isVoiceMode: false))
        #expect(ChatComposerPolicy.canSend(text: "hi", gate: .allowed, isVoiceMode: false))
        #expect(!ChatComposerPolicy.canSend(text: "hi", gate: .offline, isVoiceMode: false))
        #expect(ConclaveComposerCounterPolicy.visibleFrom(limit: 1000) == 900)
    }

    @Test func implicitPrivateTargetsFollowTheSfuLookupOrder() {
        let avery = ChatRecipient(userId: "avery@example.com#w1", name: "Avery Lee", avatarSeed: "")
        let sam = ChatRecipient(userId: "sam@example.com#w2", name: "Sam Rivera", avatarSeed: "")
        let options = [avery, sam]
        let local = "jordan@example.com#s1"
        #expect(ChatComposerPolicy.implicitPrivateTarget(draft: "@averylee hello", options: options, localUserId: local,
                                                         privateEnabled: true).recipient == avery)
        #expect(ChatComposerPolicy.implicitPrivateTarget(draft: "@avery hello", options: options, localUserId: local,
                                                         privateEnabled: true).recipient == avery)
        #expect(ChatComposerPolicy.implicitPrivateTarget(draft: "/dm sam@example.com hi", options: options, localUserId: local,
                                                         privateEnabled: true).recipient == sam)
        let twins = [sam, ChatRecipient(userId: "sam@other.org#w3", name: "Sam Rivera", avatarSeed: "")]
        #expect(ChatComposerPolicy.implicitPrivateTarget(draft: "@samrivera hi", options: twins, localUserId: local,
                                                         privateEnabled: true).failure == .privateTargetAmbiguous)
        let withSelf = options + [ChatRecipient(userId: local, name: "Jordan Lee", avatarSeed: "")]
        #expect(ChatComposerPolicy.implicitPrivateTarget(draft: "@jordanlee hi", options: withSelf, localUserId: local,
                                                         privateEnabled: true).failure == .privateSelf)
        #expect(ChatComposerPolicy.implicitPrivateTarget(draft: "@avery hi", options: options, localUserId: local,
                                                         privateEnabled: false).failure == .privateDisabled)
        #expect(!ChatComposerPolicy.implicitPrivateTarget(draft: "hello @avery", options: options, localUserId: local,
                                                          privateEnabled: true).isPrivateSyntax)
        #expect(ChatComposerPolicy.implicitPrivateTarget(draft: "@Conclave hi", options: options, localUserId: local,
                                                         privateEnabled: true) == ChatImplicitTarget.none)
    }

    @Test func suggestionsOfferCommandsForABareSlashAndMentionsForATrailingAt() throws {
        let rows = ChatComposerPolicy.commandRows(privateEnabled: true, voiceEnabled: true, isPrivateMode: false)
        #expect(rows.count == 12 && rows.map { $0.id } == ChatCommand.primaryCommands.map { $0.rawValue })
        #expect(ChatComposerPolicy.commandSuggestions(draft: "/", rows: rows).count == 12)
        #expect(ChatComposerPolicy.commandSuggestions(draft: "/ca", rows: rows).map { $0.id } == ["camera"])
        #expect(ChatComposerPolicy.commandSuggestions(draft: "/camera on", rows: rows).isEmpty)
        #expect(ChatComposerPolicy.commandSuggestions(draft: "hello", rows: rows).isEmpty)
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([]))
        let options = chat.composer.mentionOptions
        #expect(options.first?.isAssistant == true)

        try #require(options.count == 4)
        #expect(options[1].isYou)
        #expect(ChatComposerPolicy.mentionSuggestions(draft: "hi @av", options: options).first?.name == "Avery Lee")
        #expect(ChatComposerPolicy.mentionSuggestions(draft: "hi @", options: options).count == 4)
        #expect(ChatComposerPolicy.mentionSuggestions(draft: "hi there", options: options).isEmpty)
        #expect(ChatComposerPolicy.insertingMention(draft: "hi @av", token: "averylee") == "hi @averylee ")
        #expect(ChatComposerPolicy.insertingCommand("dm") == "/dm ")
        #expect(ChatComposerPolicy.insertingCommand("help") == "/help")
    }

    @Test func commandRowsDimWithTheirReason() {
        let off = ChatComposerPolicy.commandRows(privateEnabled: false, voiceEnabled: false, isPrivateMode: false)
        #expect(off.first(where: { $0.id == "dm" })?.reason == "privateDisabled")
        #expect(off.first(where: { $0.id == "tts" })?.reason == "voiceDisabled")
        let privateMode = ChatComposerPolicy.commandRows(privateEnabled: true, voiceEnabled: true, isPrivateMode: true)
        #expect(privateMode.first(where: { $0.id == "tts" })?.reason == "privateTextOnly")
        #expect(privateMode.first(where: { $0.id == "leave" })?.isAvailable == true)
    }

    @Test func draftsAreKeyedByRoomAndRecipientAndDroppedOnReset() {
        let store = ChatDraftStore()
        store.setText("hello", for: "room-a|")
        store.setText("psst", for: "room-a|avery")
        #expect(store.text(for: "room-a|") == "hello" && store.text(for: "room-a|avery") == "psst" && store.count == 2)
        store.setText("", for: "room-a|")
        #expect(store.count == 1 && store.text(for: "room-a|") == "")
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([]))
        #expect(chat.composer.draftKey == "room-a|")
        chat.setPrivateTo(userId: ChatPoliciesTests.avery)
        #expect(chat.composer.draftKey == "room-a|" + ChatPoliciesTests.avery)
        chat.drafts.setText("kept", for: chat.composer.draftKey)
        chat.panelDidClose()
        chat.panelDidOpen(destination: .none, targetId: "")
        #expect(chat.drafts.text(for: chat.composer.draftKey) == "kept")
        chat.reset()
        #expect(chat.drafts.count == 0)
    }

    @Test func theComposerUsesTheSharedComponentAndPlaysNoSendHaptic() throws {
        let ios = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatComposer+iOS.swift")
        #expect(ios.contains("ConclaveComposerField(identifier: \"chat.composer.cluster\")"))
        #expect(ios.contains("ConclaveComposerStack(identifier: \"chat.composer\")"))
        #expect(ios.contains("chat.send(text: text)"))
        #expect(ios.contains("GCKeyboard.coalesced != nil"))
        let panel = try chatSource("Sources/Conclave/Features/Meeting/Chat/ChatPanel+iOS.swift")
        #expect(panel.contains(".conclaveComposerBar {"))
        let kotlin = try chatSource("Sources/Conclave/Skip/ui/chat/ChatComposer.kt")
        #expect(kotlin.contains("ConclaveComposerField(") && kotlin.contains("presenter.send(text, \"\")"))
        for text in [ios, kotlin] {
            for forbidden in ["sensoryFeedback", "conclaveGestureFeedback", "haptics.gesture", "performHapticFeedback", "glassEffect"] {
                #expect(!text.contains(forbidden), "composer uses \(forbidden)")
            }
        }
    }

    @Test func nativeCommandsKeepTheirGuardedDirectionalBranches() throws {
        let vm = try chatSource("Sources/Conclave/Features/Meeting/MeetingViewModel.swift")

        guard let start = vm.range(of: "private func sendNativeChat("),
              let end = vm.range(of: "private func sendRetainedChat(", range: start.upperBound..<vm.endIndex) else {
            Issue.record("sendNativeChat not found")
            return
        }
        let body = String(vm[start.lowerBound..<end.lowerBound])
        #expect(body.contains("if let parsed = ChatCommandParser.parse(trimmed) {\n                executeChatCommand(parsed)"))
        for forbidden in ["toggleMute()", "toggleCamera()", "toggleHandRaise", "shell.", "state.errorMessage"] {
            #expect(!body.contains(forbidden), "sendNativeChat uses \(forbidden)")
        }
        let flat = vm.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        #expect(flat.contains("if isMuteToggleInFlight, !state.isMuted { applyLocalMuteNow(context: currentSocketEventContext())"))
        #expect(vm.contains("applyLocalCameraOffNow(context: currentCallActionContext())"))
    }
}
#endif
