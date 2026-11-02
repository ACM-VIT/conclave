#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct T3BorrowComposerPolicyTests {
    private static let iosComposer = "Sources/Conclave/Features/Meeting/Chat/ChatComposer+iOS.swift"
    private static let androidComposer = "Sources/Conclave/Skip/ui/chat/ChatComposer.kt"
    private static let iosCopy = "Sources/Conclave/Features/Meeting/Chat/ChatCopy+iOS.swift"
    private static let policy = "Sources/Conclave/Features/Meeting/Chat/ChatComposerPolicy.swift"

    private func item(_ id: String, _ available: Bool = true) -> ChatSuggestionItem {
        ChatSuggestionItem(id: id, insertText: "/" + id, isAvailable: available)
    }

    @Test func triggersFollowTheTrailingToken() {
        let mention = ChatComposerPolicy.suggestionTrigger(draft: "hi @av")
        #expect(mention == ChatSuggestionTrigger(kind: .mention, start: 3, query: "av"))
        #expect(mention.key == "mention:3")
        let command = ChatComposerPolicy.suggestionTrigger(draft: "/ra")
        #expect(command == ChatSuggestionTrigger(kind: .command, start: 0, query: "ra"))
        #expect(command.key == "command:0")
        for draft in ["/camera on", "a@b", "", "hi there", "hi @av "] {
            #expect(ChatComposerPolicy.suggestionTrigger(draft: draft) == ChatSuggestionTrigger.none, "\(draft)")
        }
        #expect(ChatComposerPolicy.suggestionTrigger(draft: "@") == ChatSuggestionTrigger(kind: .mention, start: 0, query: ""))
        #expect(ChatComposerPolicy.suggestionTrigger(draft: "/") == ChatSuggestionTrigger(kind: .command, start: 0, query: ""))
        #expect(ChatComposerPolicy.suggestionTrigger(draft: "hi @Av").query == "av")
    }

    @Test func escapeHidesTheListForThisTriggerUntilTheTriggerGoes() {
        var dismissed = ""

        dismissed = ChatComposerPolicy.suggestionTrigger(draft: "hi @av").key

        var trigger = ChatComposerPolicy.suggestionTrigger(draft: "hi @ave")
        dismissed = ChatComposerPolicy.dismissedKey(after: trigger, current: dismissed)
        #expect(ChatComposerPolicy.isDismissed(trigger: trigger, dismissedKey: dismissed))

        trigger = ChatComposerPolicy.suggestionTrigger(draft: "hi ")
        dismissed = ChatComposerPolicy.dismissedKey(after: trigger, current: dismissed)
        #expect(dismissed.isEmpty && !ChatComposerPolicy.isDismissed(trigger: trigger, dismissedKey: dismissed))

        trigger = ChatComposerPolicy.suggestionTrigger(draft: "hi @")
        dismissed = ChatComposerPolicy.dismissedKey(after: trigger, current: dismissed)
        #expect(!ChatComposerPolicy.isDismissed(trigger: trigger, dismissedKey: dismissed))

        let other = ChatComposerPolicy.dismissedKey(after: ChatComposerPolicy.suggestionTrigger(draft: "/h"), current: "mention:3")
        #expect(other.isEmpty)
        #expect(!ChatComposerPolicy.isDismissed(trigger: ChatSuggestionTrigger.none, dismissedKey: "none:0"))
    }

    @Test func arrowsWrapBothWaysAndSkipUnavailableRows() {
        let items = [item("a"), item("b", false), item("c")]
        #expect(ChatComposerPolicy.movedHighlight(currentId: "a", items: items, delta: 1) == "c")
        #expect(ChatComposerPolicy.movedHighlight(currentId: "c", items: items, delta: 1) == "a")
        #expect(ChatComposerPolicy.movedHighlight(currentId: "a", items: items, delta: -1) == "c")
        #expect(ChatComposerPolicy.movedHighlight(currentId: "c", items: items, delta: -1) == "a")
        #expect(ChatComposerPolicy.movedHighlight(currentId: "", items: items, delta: 1) == "a")
        #expect(ChatComposerPolicy.movedHighlight(currentId: "", items: items, delta: -1) == "c")
        #expect(ChatComposerPolicy.movedHighlight(currentId: "a", items: [item("a")], delta: 1) == "a")
        #expect(ChatComposerPolicy.movedHighlight(currentId: "", items: [item("x", false), item("y", false)], delta: 1) == "")
        #expect(ChatComposerPolicy.movedHighlight(currentId: "", items: [], delta: 1) == "")
    }

    @Test func theHighlightResetsOnAQueryChangeAndSurvivesARefilter() {
        let items = [item("help"), item("dm"), item("tts")]
        #expect(ChatComposerPolicy.resolvedHighlight(currentId: "", items: items, highlightQuery: "", currentQuery: "q") == "help")
        #expect(ChatComposerPolicy.resolvedHighlight(currentId: "tts", items: items, highlightQuery: "q", currentQuery: "q") == "tts")
        #expect(ChatComposerPolicy.resolvedHighlight(currentId: "tts", items: items, highlightQuery: "q", currentQuery: "q2") == "help")

        let refiltered = [item("dm"), item("tts")]
        #expect(ChatComposerPolicy.resolvedHighlight(currentId: "tts", items: refiltered, highlightQuery: "q", currentQuery: "q") == "tts")
        #expect(ChatComposerPolicy.resolvedHighlight(currentId: "help", items: refiltered, highlightQuery: "q", currentQuery: "q") == "dm")
        #expect(ChatComposerPolicy.resolvedHighlight(currentId: "dm", items: [item("dm", false), item("tts")], highlightQuery: "q",
                                                     currentQuery: "q") == "tts")
        #expect(ChatComposerPolicy.resolvedHighlight(currentId: "", items: [item("x", false)], highlightQuery: "", currentQuery: "") == "")
        let trigger = ChatComposerPolicy.suggestionTrigger(draft: "hi @av")
        #expect(ChatComposerPolicy.highlightQueryKey(trigger) == "mention:3|av")
        #expect(ChatComposerPolicy.insertText(forHighlight: "dm", items: items) == "/dm")
        #expect(ChatComposerPolicy.insertText(forHighlight: "dm", items: [item("dm", false)]).isEmpty)
        #expect(ChatComposerPolicy.insertText(forHighlight: "", items: items).isEmpty)
    }

    @Test func suggestionItemsKeepTheExistingFunctionsOrder() throws {
        let rows = ChatComposerPolicy.commandRows(privateEnabled: true, voiceEnabled: true, isPrivateMode: false)
        let commands = ChatComposerPolicy.suggestionItems(draft: "/", mentionOptions: [], commandRows: rows, isPrivateMode: false)
        #expect(commands.map { $0.id } == ChatComposerPolicy.commandSuggestions(draft: "/", rows: rows).map { "c:" + $0.id })
        #expect(commands.first == ChatSuggestionItem(id: "c:help", insertText: "/help", isAvailable: true))

        try #require(commands.count > 1)
        #expect(commands[1].insertText == "/dm ")
        let chat = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([]))
        let options = chat.composer.mentionOptions
        let mentions = ChatComposerPolicy.suggestionItems(draft: "hi @", mentionOptions: options, commandRows: rows, isPrivateMode: false)
        #expect(mentions.map { $0.id } == ChatComposerPolicy.mentionSuggestions(draft: "hi @", options: options).map { "m:" + $0.id })
        #expect(mentions.allSatisfy { $0.insertText.hasPrefix("hi @") && $0.insertText.hasSuffix(" ") })

        let privateItems = ChatComposerPolicy.suggestionItems(draft: "hi @", mentionOptions: options, commandRows: rows, isPrivateMode: true)
        #expect(privateItems.first?.isAvailable == false && privateItems.dropFirst().allSatisfy { $0.isAvailable })
        try #require(privateItems.count > 1)
        let firstPerson = privateItems[1].id
        #expect(ChatComposerPolicy.resolvedHighlight(currentId: "", items: privateItems, highlightQuery: "", currentQuery: "") == firstPerson)

        let off = ChatComposerPolicy.commandRows(privateEnabled: false, voiceEnabled: true, isPrivateMode: false)
        let offItems = ChatComposerPolicy.suggestionItems(draft: "/", mentionOptions: [], commandRows: off, isPrivateMode: false)
        #expect(ChatComposerPolicy.movedHighlight(currentId: "c:help", items: offItems, delta: 1) == "c:tts")

        let fromLists = ChatComposerPolicy.suggestionItemsFor(mentions: ChatComposerPolicy.mentionSuggestions(draft: "hi @", options: options),
                                                              commands: [], draft: "hi @", isPrivateMode: false)
        #expect(fromLists == mentions)
    }

    @Test func theReturnTableHasOneOrder() {
        func action(hardware: Bool = true, shift: Bool = false, composing: Bool = false, repeated: Bool = false,
                    visible: Bool = false, insert: String = "", draft: String = "hello") -> ChatReturnKeyAction {
            ChatComposerPolicy.returnKeyAction(isHardwareKeyboard: hardware, isShift: shift, isComposing: composing, isRepeat: repeated,
                                               suggestionsVisible: visible, highlightedInsert: insert, draft: draft)
        }

        #expect(action(composing: true) == .ignore)
        #expect(action(composing: true, repeated: true, visible: true, insert: "/help") == .ignore)

        #expect(action(hardware: false) == .ignore)
        #expect(action(hardware: false, visible: true, insert: "/help", draft: "/") == .ignore)
        #expect(action(shift: true) == .ignore)
        #expect(action(shift: true, repeated: true) == .ignore)

        #expect(action(repeated: true) == .consume)
        #expect(action(repeated: true, visible: true, insert: "/help", draft: "/") == .consume)

        #expect(action(visible: true, insert: "/help", draft: "/") == .insertSuggestion)
        #expect(action(visible: true, insert: "/raise", draft: "/raise") == .send)
        #expect(action(visible: true, insert: "/raise", draft: " /raise ") == .send)
        #expect(action(visible: true, insert: "hi @averylee ", draft: "hi @averylee") == .insertSuggestion)
        #expect(action(visible: true, insert: "", draft: "/") == .send)
        #expect(action(visible: false, insert: "/help", draft: "/") == .send)
        #expect(action() == .send)
    }

    @Test func sendBlockIsTheOneSourceOfCanSend() {
        let texts = ["", "   ", "hello", String(repeating: "a", count: 1001), "/tts " + String(repeating: "b", count: 501), "/tts hi"]
        let attachments = [
            ChatAttachmentState.none,
            ChatAttachmentState(phase: .preparing, progress: -1, thumbnailKey: "file:///a.jpg", failure: .none),
            ChatAttachmentState(phase: .uploading, progress: 0.4, thumbnailKey: "file:///a.jpg", failure: .none),
            ChatAttachmentState(phase: .ready, progress: 1, thumbnailKey: "file:///a.jpg", failure: .none),
            ChatAttachmentState(phase: .ready, progress: 1, thumbnailKey: "", failure: .none),
            ChatAttachmentState(phase: .failed, progress: 0, thumbnailKey: "file:///a.jpg", failure: .photoBlocked),
        ]
        var rows = 0
        for text in texts {
            for gate in ChatSendGate.allCases {
                for voice in [false, true] {
                    for attachment in attachments {
                        let block = ChatComposerPolicy.sendBlock(text: text, gate: gate, isVoiceMode: voice, attachment: attachment)
                        #expect((block == ChatSendBlock.none) == ChatComposerPolicy.canSend(text: text, gate: gate, isVoiceMode: voice,
                                                                               attachment: attachment), "\(text) \(gate) \(voice)")
                        rows += 1
                    }
                    let plain = ChatComposerPolicy.sendBlock(text: text, gate: gate, isVoiceMode: voice, attachment: .none)
                    #expect((plain == ChatSendBlock.none) == ChatComposerPolicy.canSend(text: text, gate: gate, isVoiceMode: voice))
                }
            }
        }
        #expect(rows == 6 * 6 * 2 * 6)
        let ready = attachments[3]

        #expect(ChatComposerPolicy.sendBlock(text: "", gate: .reconnecting, isVoiceMode: false, attachment: attachments[2]) == .reconnecting)
        #expect(ChatComposerPolicy.sendBlock(text: "hi", gate: .notJoined, isVoiceMode: false, attachment: .none) == .notJoined)
        #expect(ChatComposerPolicy.sendBlock(text: "hi", gate: .offline, isVoiceMode: false, attachment: .none) == .offline)
        #expect(ChatComposerPolicy.sendBlock(text: "hi", gate: .locked, isVoiceMode: false, attachment: .none) == .locked)
        #expect(ChatComposerPolicy.sendBlock(text: "hi", gate: .attendee, isVoiceMode: false, attachment: .none) == .attendee)
        #expect(ChatComposerPolicy.sendBlock(text: texts[3], gate: .allowed, isVoiceMode: false, attachment: attachments[5]) == .photoFailed)
        #expect(ChatComposerPolicy.sendBlock(text: texts[3], gate: .allowed, isVoiceMode: false, attachment: attachments[1]) == .photoPending)
        #expect(ChatComposerPolicy.sendBlock(text: "", gate: .allowed, isVoiceMode: false, attachment: ready) == ChatSendBlock.none)
        #expect(ChatComposerPolicy.sendBlock(text: texts[3], gate: .allowed, isVoiceMode: false, attachment: ready) == .overLimit)
        #expect(ChatComposerPolicy.sendBlock(text: "  ", gate: .allowed, isVoiceMode: false, attachment: .none) == .empty)
        #expect(ChatComposerPolicy.sendBlock(text: texts[3], gate: .allowed, isVoiceMode: false, attachment: .none) == .overLimit)
        #expect(ChatComposerPolicy.sendBlock(text: texts[4], gate: .allowed, isVoiceMode: false, attachment: .none) == .overLimit)
        #expect(ChatComposerPolicy.sendBlock(text: "hello", gate: .allowed, isVoiceMode: false, attachment: .none) == ChatSendBlock.none)
        #expect(ChatComposerPolicy.gateBlock(.allowed) == ChatSendBlock.none)
    }

    @Test func aBlockedReturnAnnouncesOnlyGateAndPhotoBlocks() {
        let announced: [ChatSendBlock] = [.notJoined, .reconnecting, .offline, .locked, .photoPending, .photoFailed]
        for block in ChatSendBlock.allCases {
            #expect(ChatComposerPolicy.announcesBlockedSend(block) == announced.contains(block), "\(block)")
        }
        #expect(!ChatComposerPolicy.announcesBlockedSend(.empty) && !ChatComposerPolicy.announcesBlockedSend(.overLimit))
    }

    @Test func thePresenterRefusesGateBlocksSilentlyAndLimitBlocksWithANotice() {
        let closed = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([], gate: .reconnecting))
        #expect(closed.send(text: "hi") == .blocked && closed.composer.inlineNotice == ChatFailure.none)
        #expect(closed.send(text: "   ") == .empty)
        let open = ChatPoliciesTests.presenter(ChatPoliciesTests.inputs([]))
        #expect(open.send(text: String(repeating: "a", count: 1001)) == .blocked && open.composer.inlineNotice == .tooLong)
    }

    @Test func aRefusedPhotoIntakeNamesWhy() {
        func notice(gate: ChatSendGate = .allowed, isPrivate: Bool = false, photos: Bool = true, attached: Bool = false,
                    inFlight: Bool = false) -> ChatFailure {
            ChatComposerPolicy.photoIntakeNotice(gate: gate, isPrivateMode: isPrivate, photosEnabled: photos, hasAttachment: attached,
                                                 inFlight: inFlight)
        }
        #expect(notice() == ChatFailure.none)
        #expect(notice(attached: true) == .oneAttachment)
        #expect(notice(inFlight: true) == .oneAttachment)
        #expect(notice(isPrivate: true, attached: true) == .privateTextOnly)
        #expect(notice(photos: false) == .photosDisabled)
        #expect(notice(gate: .reconnecting, attached: true) == ChatFailure.none)
        #expect(notice(gate: .locked) == ChatFailure.none)
    }

    @Test func menusDecideFocusAtOpenAndFocusReturnsOnlyWhenItWasThere() {
        #expect(!ChatComposerPolicy.composerMenuIsFocusable(imeWasVisible: true, touchExploration: false))
        #expect(ChatComposerPolicy.composerMenuIsFocusable(imeWasVisible: true, touchExploration: true))
        #expect(ChatComposerPolicy.composerMenuIsFocusable(imeWasVisible: false, touchExploration: false))
        #expect(ChatComposerPolicy.composerMenuIsFocusable(imeWasVisible: false, touchExploration: true))
        #expect(ChatComposerPolicy.restoresComposerFocus(wasFocused: true, assistiveTechRunning: false))
        #expect(!ChatComposerPolicy.restoresComposerFocus(wasFocused: true, assistiveTechRunning: true))
        #expect(!ChatComposerPolicy.restoresComposerFocus(wasFocused: false, assistiveTechRunning: false))
    }

}
#endif
