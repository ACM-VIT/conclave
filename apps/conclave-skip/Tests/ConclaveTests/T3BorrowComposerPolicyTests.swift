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

    @Test func everyIOSHardwareKeyHandlerStepsAsideWhileAnIMEComposes() throws {
        let ios = try chatSource(Self.iosComposer)
        let handlers = ios.components(separatedBy: ".onKeyPress(").dropFirst()
        #expect(handlers.count == 4)
        for handler in handlers {
            let closure = handler.prefix(400)
            #expect(closure.contains("ChatTextInputProbe.isComposing()"), "an onKeyPress handler skips the IME probe")
        }
        #expect(ios.contains(".onKeyPress(.return, phases: [.down, .repeat])"))
        #expect(ios.contains(".onKeyPress(keys: [.upArrow, .downArrow], phases: [.down, .repeat])"))
        #expect(ios.contains(".onKeyPress(keys: [.tab, .escape], phases: .down)"))

        #expect(ios.contains(".onKeyPress(keys: [.tab, .escape], phases: .repeat) { press in\n                        hardwareTabOrEscapeRepeat(press, isComposing: ChatTextInputProbe.isComposing())"))
        #expect(ios.contains("keyMemo.handledKey = result == .handled ? press.key : nil"))
        #expect(ios.contains("guard !isComposing, refreshHardwareKeyboard(), keyMemo.handledKey == press.key else { return .ignored }"))
        #expect(ios.contains("private final class ChatComposerKeyMemo {"))
        #expect(ios.contains("return input.markedTextRange != nil"))
        #expect(ios.contains("UIApplication.shared.sendAction(#selector(UIResponder.conclaveReportFirstResponder(_:)), to: nil, from: nil, for: nil)"))
        #expect(ios.contains("static weak var responder: UIResponder?"))

        #expect(ios.contains("let attached = GCKeyboard.coalesced != nil"))
        #expect(ios.contains("publisher(for: .GCKeyboardDidConnect)") && ios.contains("publisher(for: .GCKeyboardDidDisconnect)"))
        #expect(ios.contains("showsHighlight: hasHardwareKeyboard"))
        #expect(ios.contains("isHardwareKeyboard: refreshHardwareKeyboard()"))
    }

    @Test func theIOSListIsFlatWithAQuietHighlightAndNoMotion() throws {
        let ios = try chatSource(Self.iosComposer)
        #expect(ios.contains(".background(Color(uiColor: .secondarySystemBackground),\n                                in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous))"))
        #expect(ios.contains("RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous)\n                .fill(Color(uiColor: .systemFill))"))
        #expect(ios.components(separatedBy: ".accessibilityAddTraits(isHighlighted ? [.isSelected] : [])").count - 1 == 2)

        guard let start = ios.range(of: "private struct ChatSuggestionHighlight: View {"),
              let end = ios.range(of: "private struct ChatAttachMenu: View {", range: start.upperBound..<ios.endIndex) else {
            Issue.record("highlight view not found")
            return
        }
        let highlight = String(ios[start.lowerBound..<end.lowerBound])
        #expect(!highlight.contains("coral") && !highlight.contains("tint"))
        for motion in ["withAnimation", ".animation(", ".transition("] {
            #expect(!ios.contains(motion), "the composer animates with \(motion)")
        }

        #expect(ios.contains("postPolite(suggestions.announcement(for: next))"))
        #expect(ios.contains("attributed.accessibilitySpeechAnnouncementPriority = .low"))
    }

    @Test func theIOSFocusRestoreChecksVoiceOverAndNeverSleeps() throws {
        let ios = try chatSource(Self.iosComposer)
        #expect(ios.contains("@Environment(\\.accessibilityVoiceOverEnabled) private var voiceOverEnabled"))
        guard let start = ios.range(of: "private func restoreFocus(wasFocused: Bool) {"),
              let end = ios.range(of: "private func acceptsPhotoIntake() -> Bool {", range: start.upperBound..<ios.endIndex) else {
            Issue.record("restoreFocus not found")
            return
        }
        let body = String(ios[start.lowerBound..<end.lowerBound])
        #expect(body.contains("assistiveTechRunning: voiceOverEnabled"))
        #expect(body.contains("if !focused { focused = true }"))
        for forbidden in ["Task.sleep", "asyncAfter", "Timer", "for _ in"] {
            #expect(!body.contains(forbidden), "the restore uses \(forbidden)")
        }
        #expect(ios.contains("if !showing { restoreFocus(wasFocused: focusMemo.takePhotoPicker()) }"))
        #expect(ios.contains("restoreFocus(wasFocused: focusMemo.takeGifs())"))
        #expect(ios.contains("private final class ChatComposerFocusMemo {"))
    }

    @Test func theIOSComposerUsesTheSharedReasonGateLineFocusAndIntake() throws {
        let ios = try chatSource(Self.iosComposer)
        #expect(ios.contains("isEnabled: block == ChatSendBlock.none"))
        #expect(ios.contains("disabledReason: ChatCopy.sendBlockReason(block, overBy: count - limit,"))
        #expect(ios.contains("ChatComposerPolicy.announcesBlockedSend(block) else { return }"))
        #expect(ios.contains("guard result == ChatSendResult.blocked, chat.composer.inlineNotice == noticeBefore,"))
        #expect(!ios.contains("ConclaveStrings.text(\"Reconnecting\")"), "the reason lives in ChatCopy.sendBlockReason")
        #expect(ios.contains("ChatCopy.gateLine(composer.gateLine)") && !ios.contains("ChatCopy.gateLine(composer.gate)"))
        #expect(ios.contains("if now {\n                showsPhotoPicker = false\n                actions.composerDidFocus()\n            }"))
        #expect(ios.contains("identifier: \"chat.composer.counter\", announcesBands: true)"))
        #expect(ios.contains("if !photoIntakeInFlight && chat.canAcceptPhoto { return true }"))
        #expect(ios.contains("photoIntakeInFlight = true\n        ChatPickedImageFile.attachFirst(providers, to: chat) {"))
        #expect(ios.contains("guard acceptsPhotoIntake() else {\n            ChatPickedImageFile.discard(files)\n            return false"))

        #expect(ios.contains("ConclaveComposerField(identifier: \"chat.composer.cluster\")"))
        #expect(ios.contains("ConclaveComposerStack(identifier: \"chat.composer\")"))
        #expect(ios.contains("chat.send(text: text)") && ios.contains("GCKeyboard.coalesced != nil"))
        var cursor = ios.startIndex
        while let range = ios.range(of: "chat.attachPhoto(", range: cursor..<ios.endIndex) {
            #expect(ios[range.upperBound...].hasPrefix("fileURL: file.url.absoluteString"))
            cursor = range.upperBound
        }
    }

    @Test func theIOSSendReasonsHaveOneCopyRowPerCase() throws {
        let copy = try chatSource(Self.iosCopy)
        guard let start = copy.range(of: "static func sendBlockReason(_ block: ChatSendBlock, overBy: Int, attachment: ChatAttachmentState) -> String {"),
              let end = copy.range(of: "static func placeholder(_ composer: ChatComposerSnapshot) -> String {",
                                   range: start.upperBound..<copy.endIndex) else {
            Issue.record("sendBlockReason not found")
            return
        }
        let body = String(copy[start.lowerBound..<end.lowerBound])
        for row in ["case .none, .attendee: return \"\"",
                    "case .empty: return ConclaveStrings.text(\"Type a message\")",
                    "case .notJoined: return ConclaveStrings.text(\"Not joined yet\")",
                    "case .reconnecting: return ConclaveStrings.text(\"Reconnecting\")",
                    "case .offline: return ConclaveStrings.text(\"Offline\")",
                    "case .locked: return ConclaveStrings.text(\"Chat locked by host\")",
                    "case .overLimit: return ConclaveStrings.format(\"%lld characters over the limit\", max(overBy, 1))",
                    "case .photoPending: return ConclaveStrings.text(\"Uploading photo\")",
                    "case .photoFailed: return ChatMediaCopy.attachmentStatus(attachment)"] {
            #expect(body.contains(row), "\(row)")
        }
        #expect(body.components(separatedBy: "case .").count - 1 == ChatSendBlock.allCases.count - 1)
    }

    @Test func theAndroidComposerTakesKeysMenusAndContentTheBorrowedWay() throws {
        let kotlin = try chatSource(Self.androidComposer)

        #expect(kotlin.components(separatedBy: "contentReceiver(").count - 1 == 1)
        #expect(!kotlin.contains("dragAndDropTarget("))
        #expect(kotlin.contains("Column(Modifier.fillMaxWidth().testTag(\"chat.composer\").contentReceiver(receiver)"))
        #expect(kotlin.contains("val draftState = rememberTextFieldState()") && kotlin.contains("state = draftState,"))
        #expect(kotlin.contains("snapshotFlow { draftState.text.toString() }") && kotlin.contains("presenter.clearInlineNotice()"))
        #expect(kotlin.contains("return transferableContent.consume { item -> item.uri != null }"))
        #expect(kotlin.contains("if (photoIntakeInFlight || !presenter.canAcceptPhoto) {"))
        #expect(kotlin.contains("@OptIn(ExperimentalFoundationApi::class)\n@Composable\ninternal fun ChatComposer("))
        #expect(kotlin.components(separatedBy: "@OptIn(ExperimentalLayoutApi::class)\n@Composable\nprivate fun Chat").count - 1 == 2)
        #expect(!kotlin.contains("@file:OptIn"))

        let lines = kotlin.components(separatedBy: "\n")
        let popupLines = lines.filter { $0.contains("PopupProperties(focusable = false)") }
        #expect(popupLines.count == 2)
        #expect(popupLines.allSatisfy { $0.contains("if (capture.menuFocusable)") })
        #expect(kotlin.components(separatedBy: "BackHandler(enabled = expanded && !capture.menuFocusable)").count - 1 == 2)
        #expect(kotlin.contains("capture = ChatFocusCapture.capture(isFieldFocused(), imeVisible, chatTouchExplorationOn(context))"))
        #expect(kotlin.contains("if (ChatComposerPolicy.restoresComposerFocus(capture.wasFocused, chatTouchExplorationOn(context))) {"))
        #expect(kotlin.contains("if (capture.imeWasVisible) keyboard?.show()"))

        #expect(kotlin.contains("LocalConfiguration.current.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO"))
        #expect(kotlin.contains("val isRepeat = event.nativeKeyEvent.repeatCount > 0"))
        #expect(kotlin.contains("ChatReturnKeyAction.consume -> true"))
        #expect(kotlin.contains("if (event.type == KeyEventType.KeyUp) return consumedDowns.remove(key)"))
        for key in ["Key.DirectionUp", "Key.DirectionDown", "Key.Tab", "Key.Escape", "Key.Enter, Key.NumPadEnter"] {
            #expect(kotlin.contains(key), "\(key)")
        }
        #expect(kotlin.contains("Modifier.semantics { selected = true }") && kotlin.contains("scheme.surfaceContainerHighest, MaterialTheme.shapes.small"))
        #expect(kotlin.contains("color = scheme.surfaceContainerLow,") && kotlin.contains("shape = MaterialTheme.shapes.medium,"))

        #expect(kotlin.contains("sendDisabledReason = sendReason,") && kotlin.contains("onHardwareKey = { event ->"))
        #expect(kotlin.contains("ChatCopyAndroid.gateLine(composer.gateLine)") && !kotlin.contains("ChatCopyAndroid.gateLine(composer.gate)"))
        #expect(kotlin.contains("if (now && !focusMemory.fieldFocused) actions.composerDidFocus()"))
        #expect(kotlin.contains("\"chat.composer.counter\", Modifier.align(Alignment.End), announcesBands = true)"))

        #expect(kotlin.contains("fieldModifier = Modifier.focusRequester(focus).onFocusChanged { state ->"))
        #expect(!kotlin.contains("modifier = Modifier.focusRequester(focus)"))

        #expect(kotlin.contains("onSendBlocked = sendFromKeyboard,"))
        #expect(kotlin.contains("ChatBlockedSendAnnouncer(blockedPress, chatSendBlockReason(blockedBlock, count - limit, composer.attachment))"))
        #expect(kotlin.contains("LaunchedEffect(press) {\n        if (press > 0 && reason.isNotEmpty()) {\n            @Suppress(\"DEPRECATION\")\n            view.announceForAccessibility(reason)"))
        #expect(!kotlin.contains("key(press)"))

        #expect(kotlin.contains("if (moveText.isNotEmpty()) contentDescription = moveText"))
        #expect(!kotlin.contains("if (moveText.isNotEmpty()) {"))

        #expect(kotlin.contains("actions.gifsFocusCapture = capture"))
        #expect(kotlin.contains("if (!actions.showsGifs) actions.takeGifsFocusCapture()?.let { restoreFocus(it) }"))

        #expect(kotlin.contains("ConclaveComposerField(") && kotlin.contains("presenter.send(text, \"\")"))
        #expect(kotlin.contains("ActivityResultContracts.PickVisualMedia()") && kotlin.contains("ChatPhotoFiles.copyToCache(context, uri)"))
        #expect(kotlin.contains("PipManager.suppressForExternalHandoff(ExternalHandoffKind.photoPicker)") && !kotlin.contains("readBytes"))
    }

    @Test func theAndroidSendReasonsHaveOneResourcePerCase() throws {
        let kotlin = try chatSource(Self.androidComposer)
        for row in ["ChatSendBlock.none, ChatSendBlock.attendee, ChatSendBlock.photoFailed -> \"\"",
                    "ChatSendBlock.empty -> \"chat_send_reason_empty\"",
                    "ChatSendBlock.notJoined -> \"chat_send_reason_not_joined\"",
                    "ChatSendBlock.reconnecting -> \"ds_state_reconnecting\"",
                    "ChatSendBlock.offline -> \"chat_send_reason_offline\"",
                    "ChatSendBlock.locked -> \"chat_placeholder_locked\"",
                    "ChatSendBlock.overLimit -> \"ds_char_over_limit\"",
                    "ChatSendBlock.photoPending -> \"chat_send_reason_uploading\"",
                    "if (block == ChatSendBlock.photoFailed) return ChatMediaCopyAndroid.attachmentStatus(attachment)",
                    "return conclavePlural(\"ds_char_over_limit\", over, over)"] {
            #expect(kotlin.contains(row), "\(row)")
        }
    }

    @Test func theOwnedFilesKeepTheOwnerRules() throws {
        let files = [Self.iosComposer, Self.androidComposer, Self.iosCopy, Self.policy,
                     "Tests/ConclaveTests/T3BorrowComposerPolicyTests.swift", "Tests/ConclaveTests/Skip/T3BorrowComposerBridgeTests.kt"]
        let haptics = ["sensoryFeedback", "conclaveGestureFeedback", "haptics.gesture", "performHapticFeedback", "HapticFeedback"]
        for file in files {
            let text = try chatSource(file)
            #expect(!chatHasDash(text), "\(file) contains an en or em dash")
            #expect(!text.lowercased().contains("gradi" + "ent"), "\(file)")
            #expect(!text.contains("onIme" + "Send"), "\(file)")
            guard !file.hasPrefix("Tests/") else { continue }
            for token in haptics + ["glassEffect", "GlassEffectContainer"] {
                #expect(!text.contains(token), "\(file) uses \(token)")
            }
        }
    }
}
#endif
