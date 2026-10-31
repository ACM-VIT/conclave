#if os(iOS) && !SKIP
import Accessibility
import GameController
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ChatComposer: View {
    let chat: ChatPresenter
    let actions: ChatRowActions
    @State private var text = ""
    @State private var loadedKey = ""
    @State private var hasLoaded = false
    @State private var showsPhotoPicker = false
    @State private var pickedItem: PhotosPickerItem? = nil
    @State private var pasteboardHasImage = false

    @State private var dismissedPreviewURL = ""

    @State private var hasHardwareKeyboard = false

    @State private var highlightedId = ""
    @State private var highlightQueryKey = ""

    @State private var dismissedSuggestionKey = ""

    @State private var photoIntakeInFlight = false

    @State private var focusMemo = ChatComposerFocusMemo()

    @State private var keyMemo = ChatComposerKeyMemo()
    @FocusState private var focused: Bool
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @Environment(\.verticalSizeClass) private var verticalSizeClass

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

            if !ChatCopy.gateLine(composer.gateLine).isEmpty {
                ConclaveComposerStatusLine(text: ChatCopy.gateLine(composer.gateLine), identifier: "chat.composer.gate")
            }
        } field: {
            ConclaveComposerField(identifier: "chat.composer.cluster") {
                if showsPhotoPicker {
                    ConclaveComposerDismissButton(
                        title: ConclaveStrings.format("Close %@", ConclaveStrings.text("Photo Library")),
                        identifier: "chat.photos.close", action: { showsPhotoPicker = false })
                } else {
                    ChatAttachMenu(chat: chat, composer: composer, onPhoto: { openPhotoLibrary() }, onGifs: { openGifs() })
                }
            } field: {
                TextField(ChatCopy.placeholder(composer), text: $text, axis: .vertical)
                    .lineLimit(1...ConclaveComposerMetrics.maximumLines)
                    .textInputAutocapitalization(.sentences)
                    .focused($focused)
                    .disabled(composer.gate == ChatSendGate.locked)
                    .onKeyPress(.return, phases: [.down, .repeat]) { press in

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
            if showsPhotoPicker {
                let isCompactHeight = verticalSizeClass == .compact
                PhotosPicker(selection: $pickedItem, matching: .images, preferredItemEncoding: .current) {
                    Text(ConclaveStrings.text("Photo Library"))
                }
                .photosPickerStyle(.inline)
                .photosPickerAccessoryVisibility(.hidden, edges: .all)
                .photosPickerDisabledCapabilities(.selectionActions)
                .containerRelativeFrame(.vertical) { length, _ in
                    ChatPhotoPickerSizing.height(available: length, isCompactHeight: isCompactHeight)
                }
                .accessibilityIdentifier("chat.photos.inline")
            }
        }
        .task(id: composer.draftKey) {
            switchDraft(to: composer.draftKey)
        }
        .task(id: text) {

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
            if now {
                showsPhotoPicker = false
                actions.composerDidFocus()
            }
        }
        .onChange(of: composer.inlineNotice) { _, notice in
            guard notice != ChatFailure.none else { return }
            postPolite(ChatMediaCopy.failureReason(notice))
        }
        .onAppear {

            restoreFocus(wasFocused: focusMemo.takeGifs())
        }
        .onDisappear {
            chat.drafts.setText(text, for: loadedKey)
        }

        .onChange(of: showsPhotoPicker) { _, showing in

            if !showing { restoreFocus(wasFocused: focusMemo.takePhotoPicker()) }
        }
        .onGeometryChange(for: CGFloat.self) { proxy in proxy.size.height } action: { _ in
            followPhotoPickerResize()
        }
        .onChange(of: pickedItem) { _, item in
            guard let item else { return }
            pickedItem = nil
            showsPhotoPicker = false
            guard acceptsPhotoIntake() else { return }
            photoIntakeInFlight = true
            Task { @MainActor in
                defer { photoIntakeInFlight = false }
                guard let file = try? await item.loadTransferable(type: ChatPickedImageFile.self) else { return }
                chat.attachPhoto(fileURL: file.url.absoluteString, mimeType: file.mimeType, fileName: file.fileName)
            }
        }

        .dropDestination(for: ChatPickedImageFile.self) { files, _ in
            acceptDroppedPhotos(files)
        }

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

    @discardableResult
    private func refreshHardwareKeyboard() -> Bool {
        let attached = GCKeyboard.coalesced != nil
        if hasHardwareKeyboard != attached { hasHardwareKeyboard = attached }
        return attached
    }

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

    private func hardwareTabOrEscapeRepeat(_ press: KeyPress, isComposing: Bool) -> KeyPress.Result {
        guard !isComposing, refreshHardwareKeyboard(), keyMemo.handledKey == press.key else { return .ignored }
        return .handled
    }

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

    private func openPhotoLibrary() {
        focusMemo.photoPickerWasFocused = focused
        focused = false
        showsPhotoPicker = true
    }

    private func openGifs() {
        focusMemo.gifsWasFocused = focused
        actions.openGifs()
    }

    private func followPhotoPickerResize() {
        guard focusMemo.laidOutWithPhotoPicker != showsPhotoPicker else { return }
        focusMemo.laidOutWithPhotoPicker = showsPhotoPicker
        actions.composerDidResize()
    }

    private func restoreFocus(wasFocused: Bool) {
        guard ChatComposerPolicy.restoresComposerFocus(wasFocused: wasFocused, assistiveTechRunning: voiceOverEnabled) else { return }
        if !focused { focused = true }
    }

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

        photoIntakeInFlight = true
        ChatPickedImageFile.attachFirst(providers, to: chat) {
            photoIntakeInFlight = false
        }
    }

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

private final class ChatComposerFocusMemo {
    var photoPickerWasFocused = false
    var gifsWasFocused = false
    var laidOutWithPhotoPicker = false

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

private final class ChatComposerKeyMemo {
    var handledKey: KeyEquivalent? = nil
}

private enum ChatPhotoPickerSizing {
    static let regularMinimum: CGFloat = 320
    static let regularMaximum: CGFloat = 480
    static let regularShare: CGFloat = 0.5
    static let regularReserve: CGFloat = 160
    static let compactHeight: CGFloat = 220
    static let compactReserve: CGFloat = 120

    static func height(available: CGFloat, isCompactHeight: Bool) -> CGFloat {
        let preferred = isCompactHeight ? compactHeight
            : min(max(regularMinimum, available * regularShare), regularMaximum)
        let reserve = isCompactHeight ? compactReserve : regularReserve
        return max(0, min(preferred, available - reserve))
    }
}

private struct ChatComposerSuggestions {
    let trigger: ChatSuggestionTrigger
    let queryKey: String
    let mentions: [ChatMentionOption]
    let commands: [ChatCommandRow]
    let items: [ChatSuggestionItem]
    let isPrivateMode: Bool

    let isVisible: Bool

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

                        guard !highlight.isEmpty else { return }
                        proxy.scrollTo(highlight)
                    }
                }
            }
        }
        .onChange(of: count) { _, next in

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

    private func insertText(_ itemId: String) -> String {
        for item in suggestions.items where item.id == itemId {
            return item.insertText
        }
        return ""
    }
}

private struct ChatSuggestionHighlight: View {
    let isHighlighted: Bool

    var body: some View {
        if isHighlighted {
            RoundedRectangle(cornerRadius: CGFloat(DesignTokens.radiusSmall), style: .continuous)
                .fill(Color(uiColor: .systemFill))
        }
    }
}

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

    @objc fileprivate func conclaveReportFirstResponder(_ sender: Any?) {
        ChatFirstResponderReport.responder = self
    }
}

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

    static func discard(_ files: [ChatPickedImageFile]) {
        for file in files {
            try? FileManager.default.removeItem(at: file.url)
        }
    }
}
#endif
