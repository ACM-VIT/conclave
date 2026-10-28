#if os(iOS) && !SKIP
import Accessibility
import GameController
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// S40 6 (CHT-2): the composer on iOS, in the FND-3 composer bar (iOS 26 `safeAreaBar` with the glass cluster from
// the one sanctioned composer glass file, Owner OQ2 (2026-10-26); the opaque bordered field under Reduce Transparency
// and on iOS 17 to 25). Keystrokes stay in view state; the draft is written to `ChatDraftStore` after 500 ms idle and
// on disappear (R40-7), never to the view model. Every send goes through `chat.send` (ChatComposerPolicy.route, D24);
// no send, command, attach or recipient haptic (Q11). CHT-4 and CHT-5: the attach control joins the cluster (Photo
// Library and GIFs and Stickers; an item unavailable in the mode stays in the menu, disabled with its reason), the
// attachment chip and the link preview sit above the field, the system paste control appears while the pasteboard
// holds an image (no paste prompt), iPad drops land as files, and every photo reaches the presenter as a file copied
// into the caches directory off the main actor (CH6). Voice is CHT-6.
//
// T3 borrow (R/t3-borrow/PLAN.md, patterns only, written fresh): P1 hardware keys for the suggestion list (Up and
// Down move a flat highlight with wrap-around, skipping dimmed rows; Return and Tab insert; a row whose insert text
// equals the draft sends; Escape hides the list for this trigger), only while a hardware keyboard is attached, so
// touch behaviour never changes; P2 no hardware key acts while an IME composes, and a held Return sends once; P3 the
// field gets focus back after Photo Library or the GIF page only when it had it and VoiceOver is off (AX12); P4 one
// photo intake at a time; P6 one Send reason from `ChatComposerPolicy.sendBlock`; P7 the gate line reads the delayed
// `composer.gateLine`; P8 a focus gain tells the timeline (`composerDidFocus`); P9 the counter announces its bands.

struct ChatComposer: View {
    let chat: ChatPresenter
    let actions: ChatRowActions
    @State private var text = ""
    @State private var loadedKey = ""
    @State private var hasLoaded = false
    @State private var showsPhotoPicker = false
    @State private var pickedItem: PhotosPickerItem? = nil
    @State private var pasteboardHasImage = false
    /// CHT-5: the composer preview the person removed; the next send carries `suppressEmbeds` (6 c).
    @State private var dismissedPreviewURL = ""
    /// P1: set from `GCKeyboard.coalesced` on appear and on connect and disconnect; no highlight, trait or key
    /// handling without it.
    @State private var hasHardwareKeyboard = false
    /// P1: the highlighted row id and the query it belongs to; the body derives the effective highlight.
    @State private var highlightedId = ""
    @State private var highlightQueryKey = ""
    /// P1: the trigger key Escape dismissed ("" when none).
    @State private var dismissedSuggestionKey = ""
    /// P4: a paste or picker copy still running; every other intake is refused meanwhile.
    @State private var photoIntakeInFlight = false
    /// P3: whether the field had focus when Photo Library or the GIF page opened. A plain box (never observed), so the
    /// GIF return can read it from `onAppear` without invalidating the body.
    @State private var focusMemo = ChatComposerFocusMemo()
    /// P1: the Tab or Escape whose press the list used, so its held repeats are swallowed too. A plain box (never
    /// observed), written and read in the key handlers only.
    @State private var keyMemo = ChatComposerKeyMemo()
    @FocusState private var focused: Bool
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled

    var body: some View {
        let composer = chat.composer
        #if DEBUG
        let _ = ChatDiagnostics.counters?.bump("chat.recompose.composer")
        #endif
        let limit = ChatComposerPolicy.limit(text: text, isVoiceMode: composer.isVoiceMode)
        let count = ChatComposerPolicy.limitLength(text: text, isVoice: composer.isVoiceMode)
        let block = ChatComposerPolicy.sendBlock(text: text, gate: composer.gate, isVoiceMode: composer.isVoiceMode,
                                                 attachment: composer.attachment)
        let suggestions = ChatComposerSuggestions.make(draft: text, composer: composer, dismissedKey: dismissedSuggestionKey,
                                                       highlightedId: highlightedId, highlightQueryKey: highlightQueryKey,
                                                       showsHighlight: hasHardwareKeyboard)
        ConclaveComposerStack(identifier: "chat.composer") {
            ChatSuggestionList(suggestions: suggestions, isPrivateMode: composer.privateTo != nil) { replacement in
                text = replacement
            }
            if let reply = composer.reply {
                ConclaveComposerReplyBar(title: ChatCopy.replyTitle(reply), preview: ChatCopy.replyPreview(reply),
                                         cancelTitle: ConclaveStrings.text("Cancel Reply"), identifier: "chat.composer.reply",
                                         onCancel: { chat.cancelReply() })
            }
            ChatAttachmentRow(chat: chat, attachment: composer.attachment)
            if pasteboardHasImage && composer.attachment.phase == ChatAttachmentPhase.none
                && ChatComposerPolicy.attachItemReason(kind: "photo", isPrivateMode: composer.privateTo != nil,
                                                       photosEnabled: composer.photosEnabled, voiceEnabled: composer.voiceEnabled).isEmpty
                && composer.gate == ChatSendGate.allowed {
                PasteButton(supportedContentTypes: [UTType.image]) { providers in
                    pasteImage(providers)
                }
                .labelStyle(.titleAndIcon)
                .buttonBorderShape(.capsule)
                .accessibilityHint(ConclaveStrings.text("Adds the copied image as a photo"))
                .accessibilityIdentifier("chat.composer.paste")
            }
            ChatComposerLinkPreview(chat: chat, draft: text, dismissedURL: $dismissedPreviewURL)
            ChatComposerModeRow(chat: chat, composer: composer, draft: text)
            ChatVoiceModeRow(chat: chat, composer: composer, draft: text)
            if composer.inlineNotice != ChatFailure.none {
                ConclaveComposerStatusLine(text: ChatMediaCopy.failureReason(composer.inlineNotice), identifier: "chat.composer.notice")
            }
            // P7: the line follows the delayed gate (shown after 400 ms closed, held at least 400 ms); Send and its
            // reason follow the real gate at once.
            if !ChatCopy.gateLine(composer.gateLine).isEmpty {
                ConclaveComposerStatusLine(text: ChatCopy.gateLine(composer.gateLine), identifier: "chat.composer.gate")
            }
        } field: {
            ConclaveComposerField(identifier: "chat.composer.cluster") {
                ChatAttachMenu(chat: chat, composer: composer, onPhoto: { openPhotoLibrary() }, onGifs: { openGifs() })
            } field: {
                TextField(ChatCopy.placeholder(composer), text: $text, axis: .vertical)
                    .lineLimit(1...ConclaveComposerMetrics.maximumLines)
                    .textInputAutocapitalization(.sentences)
                    .focused($focused)
                    .disabled(composer.gate == ChatSendGate.locked)
                    .onKeyPress(.return, phases: [.down, .repeat]) { press in
                        // Hardware Return sends and Shift+Return inserts a newline; the software keyboard's Return
                        // stays a newline (the Messages convention, Q13). A held Return sends once (P2).
                        hardwareReturn(press, suggestions: suggestions, isComposing: ChatTextInputProbe.isComposing())
                    }
                    .onKeyPress(keys: [.upArrow, .downArrow], phases: [.down, .repeat]) { press in
                        hardwareArrow(press, suggestions: suggestions, isComposing: ChatTextInputProbe.isComposing())
                    }
                    .onKeyPress(keys: [.tab, .escape], phases: .down) { press in
                        hardwareTabOrEscape(press, suggestions: suggestions, isComposing: ChatTextInputProbe.isComposing())
                    }
                    .onKeyPress(keys: [.tab, .escape], phases: .repeat) { press in
                        hardwareTabOrEscapeRepeat(press, isComposing: ChatTextInputProbe.isComposing())
                    }
                    .accessibilityLabel(ConclaveStrings.text("Message"))
                    .accessibilityValue(modeValue(composer))
                    .accessibilityHint(ConclaveStrings.text("Type @ to mention someone or / for commands."))
                    .accessibilityIdentifier("chat.composer.field")
            } send: {
                ConclaveComposerSendButton(title: VoiceCopy.sendTitle(isVoiceMode: composer.isVoiceMode),
                                           isEnabled: block == ChatSendBlock.none,
                                           disabledReason: ChatCopy.sendBlockReason(block, overBy: count - limit,
                                                                                    attachment: composer.attachment),
                                           identifier: "chat.composer.send", action: { send() })
            }
        } footer: {
            ConclaveCharacterCounter(count: count, limit: limit,
                                     visibleFrom: composer.isVoiceMode ? 0 : ConclaveComposerCounterPolicy.visibleFrom(limit: limit),
                                     identifier: "chat.composer.counter", announcesBands: true)
        }
        .task(id: composer.draftKey) {
            switchDraft(to: composer.draftKey)
        }
        .task(id: text) {
            // R40-7: written after 500 ms idle (the task restarts on every keystroke), never per keystroke.
            try? await Task.sleep(nanoseconds: UInt64(ChatDraftStore.writeDelayMillis * 1_000_000))
            if Task.isCancelled { return }
            chat.drafts.setText(text, for: loadedKey)
        }
        .onChange(of: text) { _, next in
            chat.clearInlineNotice()
            syncSuggestionState(draft: next)
        }
        .onChange(of: actions.focusRequest) { _, _ in
            let insert = actions.pendingInsert
            actions.pendingInsert = ""
            if !insert.isEmpty {
                text = text.isEmpty ? insert : text + " " + insert
            }
            focused = true
        }
        .onChange(of: focused) { _, now in
            // P8 (S40 2 c): the timeline follows a focus gain only when the newest row is visible.
            if now { actions.composerDidFocus() }
        }
        .onChange(of: composer.inlineNotice) { _, notice in
            guard notice != ChatFailure.none else { return }
            postPolite(ChatMediaCopy.failureReason(notice))
        }
        .onAppear {
            // P3: back from the GIF page (popped after a pick or by Back). Reads and clears the plain box only.
            restoreFocus(wasFocused: focusMemo.takeGifs())
        }
        .onDisappear {
            chat.drafts.setText(text, for: loadedKey)
        }
        // CH6: the picker item is loaded as a file copied into the caches directory (HEIC arrives as JPEG with the
        // compatible encoding); cancelling the picker changes nothing.
        .photosPicker(isPresented: $showsPhotoPicker, selection: $pickedItem, matching: .images, preferredItemEncoding: .compatible)
        .onChange(of: showsPhotoPicker) { _, showing in
            // P3: the picker closed by pick or cancel.
            if !showing { restoreFocus(wasFocused: focusMemo.takePhotoPicker()) }
        }
        .onChange(of: pickedItem) { _, item in
            guard let item else { return }
            pickedItem = nil
            guard acceptsPhotoIntake() else { return }
            photoIntakeInFlight = true
            Task { @MainActor in
                defer { photoIntakeInFlight = false }
                guard let file = try? await item.loadTransferable(type: ChatPickedImageFile.self) else { return }
                chat.attachPhoto(fileURL: file.url.absoluteString, mimeType: file.mimeType, fileName: file.fileName)
            }
        }
        // iPad drag and drop of images, as files (CH6). P4: refused (and the copies deleted) while a photo exists or
        // another intake is still copying.
        .dropDestination(for: ChatPickedImageFile.self) { files, _ in
            acceptDroppedPhotos(files)
        }
        // The paste control shows only while the pasteboard holds an image; `hasImages` shows no paste prompt.
        .task {
            refreshPasteboard()
            refreshHardwareKeyboard()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)) { _ in
            refreshPasteboard()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            refreshPasteboard()
        }
        .onReceive(NotificationCenter.default.publisher(for: .GCKeyboardDidConnect)) { _ in
            refreshHardwareKeyboard()
        }
        .onReceive(NotificationCenter.default.publisher(for: .GCKeyboardDidDisconnect)) { _ in
            refreshHardwareKeyboard()
        }
    }

    private func refreshPasteboard() {
        let hasImage = UIPasteboard.general.hasImages
        if pasteboardHasImage != hasImage { pasteboardHasImage = hasImage }
    }

    /// P1: the live hardware keyboard check, mirrored into state for the highlight. Called from event handlers only.
    @discardableResult
    private func refreshHardwareKeyboard() -> Bool {
        let attached = GCKeyboard.coalesced != nil
        if hasHardwareKeyboard != attached { hasHardwareKeyboard = attached }
        return attached
    }

    /// R40-7: drafts are keyed by room and recipient. A switch saves the current text under the old key and loads the
    /// new key's draft; when the new key has none, the text you were writing moves with you.
    private func switchDraft(to key: String) {
        guard key != loadedKey || !hasLoaded else { return }
        let stored = chat.drafts.text(for: key)
        if hasLoaded {
            if stored.isEmpty {
                chat.drafts.setText("", for: loadedKey)
            } else {
                chat.drafts.setText(text, for: loadedKey)
                text = stored
            }
        } else {
            text = stored
        }
        loadedKey = key
        hasLoaded = true
    }

    // MARK: Hardware keys (T3 borrow P1, P2)

    /// P1, P2: Return in the order `ChatComposerPolicy.returnKeyAction` gives (composing, software keyboard and Shift
    /// pass through; a repeat is swallowed; a highlighted row inserts unless it equals the draft; otherwise send).
    private func hardwareReturn(_ press: KeyPress, suggestions: ChatComposerSuggestions, isComposing: Bool) -> KeyPress.Result {
        let action = ChatComposerPolicy.returnKeyAction(isHardwareKeyboard: refreshHardwareKeyboard(),
                                                        isShift: press.modifiers.contains(.shift), isComposing: isComposing,
                                                        isRepeat: press.phase.contains(.repeat),
                                                        suggestionsVisible: suggestions.isVisible,
                                                        highlightedInsert: suggestions.highlightedInsert, draft: text)
        switch action {
        case .ignore:
            return .ignored
        case .consume:
            return .handled
        case .insertSuggestion:
            text = suggestions.highlightedInsert
            return .handled
        case .send:
            sendFromKeyboard()
            return .handled
        }
    }

    /// P1: Up and Down move the highlight (wrap-around, dimmed rows skipped) while the list shows; otherwise the
    /// caret moves as usual. Each move is announced politely with the row's title and second line.
    private func hardwareArrow(_ press: KeyPress, suggestions: ChatComposerSuggestions, isComposing: Bool) -> KeyPress.Result {
        guard !isComposing, refreshHardwareKeyboard(), suggestions.isVisible else { return .ignored }
        let delta = press.key == .upArrow ? -1 : 1
        let next = ChatComposerPolicy.movedHighlight(currentId: suggestions.highlight, items: suggestions.items, delta: delta)
        guard !next.isEmpty else { return .ignored }
        highlightedId = next
        highlightQueryKey = suggestions.queryKey
        postPolite(suggestions.announcement(for: next))
        return .handled
    }

    /// P1: Tab inserts the highlighted row like Return (never a send); Escape hides the list for this trigger. Both
    /// act on the press only (`phases: .down`); a press they used is remembered, so its held repeats are swallowed by
    /// `hardwareTabOrEscapeRepeat` and a held Tab never inserts and then moves focus (Android consumes them the same way).
    private func hardwareTabOrEscape(_ press: KeyPress, suggestions: ChatComposerSuggestions, isComposing: Bool) -> KeyPress.Result {
        let result = tabOrEscapeAction(press, suggestions: suggestions, isComposing: isComposing)
        keyMemo.handledKey = result == .handled ? press.key : nil
        return result
    }

    private func tabOrEscapeAction(_ press: KeyPress, suggestions: ChatComposerSuggestions, isComposing: Bool) -> KeyPress.Result {
        guard !isComposing, refreshHardwareKeyboard(), suggestions.isVisible else { return .ignored }
        if press.key == .escape {
            dismissedSuggestionKey = suggestions.trigger.key
            return .handled
        }
        let insert = suggestions.highlightedInsert
        guard !insert.isEmpty, !press.modifiers.contains(.shift) else { return .ignored }
        text = insert
        return .handled
    }

    /// P1: the repeats of a held Tab or Escape. Swallowed only when the list used that key's press (it never acts
    /// again); every other repeat goes to the field and the system as usual.
    private func hardwareTabOrEscapeRepeat(_ press: KeyPress, isComposing: Bool) -> KeyPress.Result {
        guard !isComposing, refreshHardwareKeyboard(), keyMemo.handledKey == press.key else { return .ignored }
        return .handled
    }

    /// P1: after every draft change, keep the Escape dismissal only for the same trigger and drop a highlight that
    /// belongs to another query (both value guarded; this is an event handler, never the body).
    private func syncSuggestionState(draft: String) {
        let trigger = ChatComposerPolicy.suggestionTrigger(draft: draft)
        let kept = ChatComposerPolicy.dismissedKey(after: trigger, current: dismissedSuggestionKey)
        if kept != dismissedSuggestionKey { dismissedSuggestionKey = kept }
        let query = ChatComposerPolicy.highlightQueryKey(trigger)
        if !highlightedId.isEmpty && query != highlightQueryKey {
            highlightedId = ""
            highlightQueryKey = query
        }
    }

    // MARK: Send (P6)

    /// The field's value names the mode, so the label stays "Message" (6 i).
    private func modeValue(_ composer: ChatComposerSnapshot) -> String {
        var parts: [String] = []
        if let recipient = composer.privateTo { parts.append(ConclaveStrings.format("Private to %@", recipient.name)) }
        if let reply = composer.reply { parts.append(ChatCopy.replyTitle(reply)) }
        if composer.isVoiceMode { parts.append(VoiceCopy.accessibilityValue) }
        return parts.joined(separator: ", ")
    }

    private func send() {
        _ = dispatchSend()
    }

    /// Sends the draft; the field clears only when the presenter dispatched it. The keyboard stays up (P3).
    private func dispatchSend() -> ChatSendResult {
        let result = dismissedPreviewURL.isEmpty ? chat.send(text: text)
            : chat.send(text: text, suppressEmbedsFor: dismissedPreviewURL)
        if result == ChatSendResult.dispatched {
            text = ""
            dismissedPreviewURL = ""
            chat.drafts.setText("", for: loadedKey)
        }
        return result
    }

    /// P6: a hardware Return. A gate or photo block (refused silently by the presenter) posts its reason politely once
    /// per press; route and limit blocks announce their own inline notice; an empty draft posts nothing.
    private func sendFromKeyboard() {
        let composer = chat.composer
        let block = ChatComposerPolicy.sendBlock(text: text, gate: composer.gate, isVoiceMode: composer.isVoiceMode,
                                                 attachment: composer.attachment)
        let overBy = ChatComposerPolicy.limitLength(text: text, isVoice: composer.isVoiceMode)
            - ChatComposerPolicy.limit(text: text, isVoiceMode: composer.isVoiceMode)
        let noticeBefore = composer.inlineNotice
        let result = dispatchSend()
        guard result == ChatSendResult.blocked, chat.composer.inlineNotice == noticeBefore,
              ChatComposerPolicy.announcesBlockedSend(block) else { return }
        postPolite(ChatCopy.sendBlockReason(block, overBy: overBy, attachment: composer.attachment))
    }

    // MARK: Focus (P3)

    private func openPhotoLibrary() {
        focusMemo.photoPickerWasFocused = focused
        showsPhotoPicker = true
    }

    private func openGifs() {
        focusMemo.gifsWasFocused = focused
        actions.openGifs()
    }

    /// P3: verify first. UIKit often gives the field its first responder back after a dismissal by itself (cell R6),
    /// so this only sets focus once when it is still missing, when the field had it before and VoiceOver is off
    /// (AX12: under VoiceOver focus returns to the invoker). No sleeps and no retry loop.
    private func restoreFocus(wasFocused: Bool) {
        guard ChatComposerPolicy.restoresComposerFocus(wasFocused: wasFocused, assistiveTechRunning: voiceOverEnabled) else { return }
        if !focused { focused = true }
    }

    // MARK: Photo intake (P4)

    /// P4: a paste, picker or drop is accepted only while the presenter can take a photo and no other copy is running;
    /// otherwise it is refused at once with the notice that applies ("Send one attachment at a time.").
    private func acceptsPhotoIntake() -> Bool {
        if !photoIntakeInFlight && chat.canAcceptPhoto { return true }
        let composer = chat.composer
        let notice = ChatComposerPolicy.photoIntakeNotice(gate: composer.gate, isPrivateMode: composer.privateTo != nil,
                                                          photosEnabled: composer.photosEnabled,
                                                          hasAttachment: composer.attachment.phase != ChatAttachmentPhase.none,
                                                          inFlight: photoIntakeInFlight)
        if notice != ChatFailure.none { chat.rejectPhoto(notice) }
        return false
    }

    private func pasteImage(_ providers: [NSItemProvider]) {
        guard acceptsPhotoIntake() else { return }
        // Set before the asynchronous copy starts, so a second paste or a drop meanwhile is refused.
        photoIntakeInFlight = true
        ChatPickedImageFile.attachFirst(providers, to: chat) {
            photoIntakeInFlight = false
        }
    }

    /// The drop already copied its files into caches; a refused drop deletes them and returns false. Only the first
    /// image is taken (one photo per message); the rest are deleted and the notice says why.
    private func acceptDroppedPhotos(_ files: [ChatPickedImageFile]) -> Bool {
        guard let file = files.first else { return false }
        guard acceptsPhotoIntake() else {
            ChatPickedImageFile.discard(files)
            return false
        }
        ChatPickedImageFile.discard(Array(files.dropFirst()))
        chat.attachPhoto(fileURL: file.url.absoluteString, mimeType: file.mimeType, fileName: file.fileName)
        if files.count > 1 { chat.rejectPhoto(ChatFailure.oneAttachment) }
        return true
    }

    private func postPolite(_ message: String) {
        guard !message.isEmpty else { return }
        var attributed = AttributedString(message)
        attributed.accessibilitySpeechAnnouncementPriority = .low
        AccessibilityNotification.Announcement(attributed).post()
    }
}

/// P3: the focus the field had when a picker opened. A plain reference held in `@State`: writing it never invalidates
/// the body (the appearance-callback rule, AGENTS.md), and each value is read once.
private final class ChatComposerFocusMemo {
    var photoPickerWasFocused = false
    var gifsWasFocused = false

    func takePhotoPicker() -> Bool {
        let value = photoPickerWasFocused
        photoPickerWasFocused = false
        return value
    }

    func takeGifs() -> Bool {
        let value = gifsWasFocused
        gifsWasFocused = false
        return value
    }
}

/// P1: the hardware Tab or Escape whose press the suggestion list used (nil when the last press passed through). A plain
/// reference held in `@State`, like `ChatComposerFocusMemo`: the key handlers write and read it, the body never does.
private final class ChatComposerKeyMemo {
    var handledKey: KeyEquivalent? = nil
}

/// P1: the suggestion state the composer body derives once per draft (pure; nothing here writes state). The list,
/// the key handlers and the announcements all read this one value.
private struct ChatComposerSuggestions {
    let trigger: ChatSuggestionTrigger
    let queryKey: String
    let mentions: [ChatMentionOption]
    let commands: [ChatCommandRow]
    let items: [ChatSuggestionItem]
    let isPrivateMode: Bool
    /// False when nothing matches or Escape dismissed this trigger.
    let isVisible: Bool
    /// The effective highlight: "" without a hardware keyboard, while hidden or when no row is available.
    let highlight: String

    var highlightedInsert: String {
        ChatComposerPolicy.insertText(forHighlight: highlight, items: items)
    }

    static func make(draft: String, composer: ChatComposerSnapshot, dismissedKey: String, highlightedId: String,
                     highlightQueryKey: String, showsHighlight: Bool) -> ChatComposerSuggestions {
        let trigger = ChatComposerPolicy.suggestionTrigger(draft: draft)
        let queryKey = ChatComposerPolicy.highlightQueryKey(trigger)
        let isPrivateMode = composer.privateTo != nil
        let mentions = ChatComposerPolicy.mentionSuggestions(draft: draft, options: composer.mentionOptions)
        let commands = mentions.isEmpty ? ChatComposerPolicy.commandSuggestions(draft: draft, rows: composer.commandRows) : []
        let items = ChatComposerPolicy.suggestionItemsFor(mentions: mentions, commands: commands, draft: draft,
                                                          isPrivateMode: isPrivateMode)
        let isVisible = !items.isEmpty && !ChatComposerPolicy.isDismissed(trigger: trigger, dismissedKey: dismissedKey)
        let highlight = isVisible && showsHighlight
            ? ChatComposerPolicy.resolvedHighlight(currentId: highlightedId, items: items, highlightQuery: highlightQueryKey,
                                                   currentQuery: queryKey)
            : ""
        return ChatComposerSuggestions(trigger: trigger, queryKey: queryKey, mentions: mentions, commands: commands, items: items,
                                       isPrivateMode: isPrivateMode, isVisible: isVisible, highlight: highlight)
    }

    /// The polite text for an arrow move onto `itemId`: the row's title and its second line.
    func announcement(for itemId: String) -> String {
        for option in mentions where ChatComposerPolicy.mentionItemId(option.id) == itemId {
            return ChatCopy.suggestionAnnouncement(title: ChatCopy.mentionTitle(option),
                                                   detail: ChatCopy.mentionDetail(option, isPrivateMode: isPrivateMode))
        }
        for row in commands where ChatComposerPolicy.commandItemId(row.id) == itemId {
            return ChatCopy.suggestionAnnouncement(title: row.usage, detail: ChatCopy.commandDetail(row))
        }
        return ""
    }
}

/// 6 c recipient row and the implicit private line: the recipient menu shows only when private messages are on and
/// someone else is here; "Will be sent privately to %@" reads the shared implicit-target rule (the SFU's lookup).
private struct ChatComposerModeRow: View {
    let chat: ChatPresenter
    let composer: ChatComposerSnapshot
    let draft: String

    var body: some View {
        if composer.privateEnabled && !composer.recipients.isEmpty {
            Menu {
                Picker(ConclaveStrings.text("Send To"), selection: Binding(
                    get: { composer.privateTo?.userId ?? "" },
                    set: { chat.setPrivateTo(userId: $0) })) {
                    Text(ConclaveStrings.text("Everyone")).tag("")
                    Section(ConclaveStrings.text("Send Privately To")) {
                        ForEach(composer.recipients) { recipient in
                            Text(recipient.name).tag(recipient.userId)
                        }
                    }
                }
            } label: {
                if let recipient = composer.privateTo {
                    Label(ConclaveStrings.format("Private to %@", recipient.name), systemImage: ChatSymbols.privateMessage)
                } else {
                    Label(ConclaveStrings.text("To: Everyone"), systemImage: ChatSymbols.everyone)
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .tint(.primary)
            .accessibilityIdentifier("chat.composer.recipient")
        }
        if composer.privateTo == nil {
            let implicit = ChatComposerPolicy.implicitPrivateTarget(draft: draft, options: composer.recipients, localUserId: "",
                                                                    privateEnabled: composer.privateEnabled)
            if let recipient = implicit.recipient {
                ConclaveComposerStatusLine(text: ConclaveStrings.format("Will be sent privately to %@", recipient.name),
                                           identifier: "chat.composer.implicit")
            } else if implicit.failure != ChatFailure.none {
                ConclaveComposerStatusLine(text: ChatCopy.failureReason(implicit.failure), identifier: "chat.composer.implicit")
            }
        }
    }
}

/// 6 c suggestions: commands for a bare `/word`, mentions for a trailing `@word` (a mention wins); a list inside the
/// bar (never a popover) on the flat secondary surface, 4.5 rows then scrolling; unavailable rows dimmed with their
/// reason. P1: with a hardware keyboard one row carries the flat `systemFill` highlight (never coral) and the
/// selected trait; rows appear without animation (6 h) and a press never takes focus from the field.
private struct ChatSuggestionList: View {
    let suggestions: ChatComposerSuggestions
    let isPrivateMode: Bool
    let onPick: (String) -> Void
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 44

    var body: some View {
        let count = suggestions.isVisible ? suggestions.items.count : 0
        Group {
            if count > 0 {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(suggestions.mentions) { option in
                                mentionRow(option)
                            }
                            ForEach(suggestions.commands) { row in
                                commandRow(row)
                            }
                        }
                        .padding(CGFloat(DesignTokens.space4))
                    }
                    .frame(maxHeight: rowHeight * CGFloat(ChatComposerPolicy.suggestionVisibleRows) + CGFloat(DesignTokens.space8))
                    .fixedSize(horizontal: false, vertical: true)
                    .background(Color(uiColor: .secondarySystemBackground),
                                in: RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusMedium), style: .continuous))
                    .onChange(of: suggestions.highlight) { _, highlight in
                        // Keeps the highlighted row on screen past the 4.5 visible rows (no animation, 6 h).
                        guard !highlight.isEmpty else { return }
                        proxy.scrollTo(highlight)
                    }
                }
            }
        }
        .onChange(of: count) { _, next in
            // 6 i: a polite "%lld suggestions" when the list appears or changes size.
            guard next > 0 else { return }
            var attributed = AttributedString(ConclaveStrings.format("%lld suggestions", next))
            attributed.accessibilitySpeechAnnouncementPriority = .low
            AccessibilityNotification.Announcement(attributed).post()
        }
    }

    private func mentionRow(_ option: ChatMentionOption) -> some View {
        let itemId = ChatComposerPolicy.mentionItemId(option.id)
        let dimmed = option.isAssistant && isPrivateMode
        let isHighlighted = itemId == suggestions.highlight
        return Button {
            onPick(insertText(itemId))
        } label: {
            HStack(spacing: CGFloat(DesignTokens.space8)) {
                if option.isAssistant {
                    Image(systemName: ConclaveSymbols.message)
                        .foregroundStyle(HostingTheme.coralText)
                        .frame(width: 24, height: 24)
                        .accessibilityHidden(true)
                } else {
                    ConclaveAvatar(name: option.name, id: option.id, size: .mention)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text(ChatCopy.mentionTitle(option))
                        .font(.body)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(ChatCopy.mentionDetail(option, isPrivateMode: isPrivateMode))
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.secondaryText)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, CGFloat(DesignTokens.space8))
            .frame(minHeight: rowHeight)
            .background { ChatSuggestionHighlight(isHighlighted: isHighlighted) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(dimmed)
        .opacity(dimmed ? HostingTheme.disabledOpacity : 1)
        .accessibilityAddTraits(isHighlighted ? [.isSelected] : [])
        .accessibilityIdentifier("chat.suggestion." + option.id)
        .id(itemId)
    }

    private func commandRow(_ row: ChatCommandRow) -> some View {
        let itemId = ChatComposerPolicy.commandItemId(row.id)
        let isHighlighted = itemId == suggestions.highlight
        return Button {
            onPick(insertText(itemId))
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: CGFloat(DesignTokens.space8)) {
                Text(row.usage)
                    .font(.body.monospaced())
                    .foregroundStyle(.primary)
                Text(ChatCopy.commandDetail(row))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, CGFloat(DesignTokens.space8))
            .frame(minHeight: rowHeight)
            .background { ChatSuggestionHighlight(isHighlighted: isHighlighted) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!row.isAvailable)
        .opacity(row.isAvailable ? 1 : HostingTheme.disabledOpacity)
        .accessibilityAddTraits(isHighlighted ? [.isSelected] : [])
        .accessibilityIdentifier("chat.suggestion." + row.id)
        .id(itemId)
    }

    /// The draft after a tap on a row: its item's insert text (`insertingMention` replaces the trailing `@query`,
    /// `insertingCommand` gives the command's insert text), the same text Return and Tab insert.
    private func insertText(_ itemId: String) -> String {
        for item in suggestions.items where item.id == itemId {
            return item.insertText
        }
        return ""
    }
}

/// P1: the highlighted row's flat fill (`systemFill`, small continuous radius; never coral, no animation).
private struct ChatSuggestionHighlight: View {
    let isHighlighted: Bool

    var body: some View {
        if isHighlighted {
            RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous)
                .fill(Color(uiColor: .systemFill))
        }
    }
}

/// S40 6 c attach control: a Menu whose label is the add-attachment glyph in the 44 pt glass circle (the cluster draws
/// the material). Items unavailable in the current mode stay in the menu, disabled, with the reason as a second line.
private struct ChatAttachMenu: View {
    let chat: ChatPresenter
    let composer: ChatComposerSnapshot
    let onPhoto: () -> Void
    let onGifs: () -> Void

    var body: some View {
        Menu {
            ForEach(composer.attachKinds, id: \.self) { kind in
                item(kind)
            }
        } label: {
            Image(systemName: ChatMediaSymbols.addAttachment)
                .font(.title3)
                .frame(width: CGFloat(ConclaveComposerMetrics.attachDiameter), height: CGFloat(ConclaveComposerMetrics.attachDiameter))
                .contentShape(Circle())
        }
        .disabled(composer.gate != ChatSendGate.allowed)
        .accessibilityLabel(ConclaveStrings.text("Add Attachment"))
        .accessibilityIdentifier("chat.composer.attach")
    }

    @ViewBuilder
    private func item(_ kind: String) -> some View {
        let reason = ChatComposerPolicy.attachItemReason(kind: kind, isPrivateMode: composer.privateTo != nil,
                                                         photosEnabled: composer.photosEnabled, voiceEnabled: composer.voiceEnabled)
        if kind == "photo" {
            Button(action: onPhoto) {
                Text(ConclaveStrings.text("Photo Library"))
                if !reason.isEmpty { Text(ChatMediaCopy.attachReason(reason)) }
                Image(systemName: ChatMediaSymbols.photo)
            }
            .disabled(!reason.isEmpty || composer.attachment.phase != ChatAttachmentPhase.none)
            .accessibilityIdentifier("chat.composer.attach.photo")
        } else if kind == "gif" {
            Button(action: onGifs) {
                Text(ConclaveStrings.text("GIFs and Stickers"))
                if !reason.isEmpty { Text(ChatMediaCopy.attachReason(reason)) }
                Image(systemName: ChatMediaSymbols.gif)
            }
            .disabled(!reason.isEmpty)
            .accessibilityIdentifier("chat.composer.attach.gif")
        } else if kind == VoiceMessagePolicy.attachKind {
            ChatVoiceAttachItem(chat: chat, composer: composer)
        }
    }
}

/// S40 6 c attachment chip (FND-3 component): the thumbnail from the local file, "Photo", the status line ("Preparing",
/// "Uploading 42%", "Ready to send" or the reason), the system linear indicator while preparing or uploading, Try Again
/// after a failure, and Remove. Absent while there is no photo.
private struct ChatAttachmentRow: View {
    let chat: ChatPresenter
    let attachment: ChatAttachmentState

    var body: some View {
        if let phase = ChatAttachmentRow.componentPhase(attachment.phase) {
            ConclaveComposerAttachmentChip(
                title: ConclaveStrings.text("Photo"),
                status: ChatMediaCopy.attachmentStatus(attachment),
                phase: phase,
                progress: attachment.phase == ChatAttachmentPhase.uploading && attachment.progress >= 0 ? attachment.progress : nil,
                removeTitle: ConclaveStrings.text("Remove Photo"),
                identifier: "chat.composer.attachment",
                thumbnail: {
                    ChatImageBox(url: attachment.thumbnailKey, width: CGFloat(ConclaveComposerMetrics.attachmentThumbnail),
                                 height: CGFloat(ConclaveComposerMetrics.attachmentThumbnail))
                },
                onRemove: { chat.removeAttachment() },
                onRetry: { chat.retryAttachment() }
            )
        }
    }

    static func componentPhase(_ phase: ChatAttachmentPhase) -> ConclaveAttachmentPhase? {
        switch phase {
        case .preparing: return ConclaveAttachmentPhase.preparing
        case .uploading: return ConclaveAttachmentPhase.uploading
        case .ready: return ConclaveAttachmentPhase.ready
        case .failed: return ConclaveAttachmentPhase.failed
        case .none: return nil
        }
    }
}

/// T3 borrow P2: whether the focused text input holds marked text (an IME composition, for example Japanese or
/// Chinese candidates). Every hardware key handler stays out of the way while it does, so the IME gets Return, the
/// arrows, Tab and Escape. The first responder is found with a public responder-chain action sent to a nil target
/// (UIKit delivers it to the first responder); the weak box never retains it.
@MainActor
private enum ChatTextInputProbe {
    static func isComposing() -> Bool {
        ChatFirstResponderReport.responder = nil
        _ = UIApplication.shared.sendAction(#selector(UIResponder.conclaveReportFirstResponder(_:)), to: nil, from: nil, for: nil)
        let responder = ChatFirstResponderReport.responder
        ChatFirstResponderReport.responder = nil
        guard let input = responder as? UITextInput else { return false }
        return input.markedTextRange != nil
    }
}

@MainActor
private enum ChatFirstResponderReport {
    static weak var responder: UIResponder?
}

extension UIResponder {
    /// T3 borrow P2: the first responder reports itself to `ChatTextInputProbe`.
    @objc fileprivate func conclaveReportFirstResponder(_ sender: Any?) {
        ChatFirstResponderReport.responder = self
    }
}

/// CH6: a picked, pasted or dropped image as a file. The import copies the file into the caches directory inside the
/// transfer (off the main actor), so no image bytes ever cross the main actor; the presenter gets the file URL.
struct ChatPickedImageFile: Transferable {
    let url: URL
    let mimeType: String
    let fileName: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: UTType.image) { received in
            try ChatPickedImageFile.copyIntoCaches(received.file)
        }
    }

    static func copyIntoCaches(_ source: URL) throws -> ChatPickedImageFile {
        let folder = URL(fileURLWithPath: ChatPhotoPreparer.outputDirectory(), isDirectory: true)
        let ext = source.pathExtension.isEmpty ? "jpg" : source.pathExtension.lowercased()
        let destination = folder.appendingPathComponent(UUID().uuidString + "." + ext)
        try FileManager.default.copyItem(at: source, to: destination)
        let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? "image/jpeg"
        return ChatPickedImageFile(url: destination, mimeType: mime, fileName: source.lastPathComponent)
    }

    /// The paste control's payload: the first image provider's file, copied while the system's temporary file exists.
    /// `completion` runs on the main actor after the hand-over or a failure (P4 clears its in-flight flag there).
    static func attachFirst(_ providers: [NSItemProvider], to chat: ChatPresenter, completion: @escaping @MainActor () -> Void) {
        guard let provider = providers.first else {
            Task { @MainActor in completion() }
            return
        }
        _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
            var copied: ChatPickedImageFile? = nil
            if let url { copied = try? ChatPickedImageFile.copyIntoCaches(url) }
            let picked = copied
            Task { @MainActor in
                if let file = picked {
                    chat.attachPhoto(fileURL: file.url.absoluteString, mimeType: file.mimeType, fileName: file.fileName)
                }
                completion()
            }
        }
    }

    /// P4: deletes copies a refused (or surplus) drop already made in caches.
    static func discard(_ files: [ChatPickedImageFile]) {
        for file in files {
            try? FileManager.default.removeItem(at: file.url)
        }
    }
}
#endif
