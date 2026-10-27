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
// no send, command or recipient haptic (Q11). CHT-4 and CHT-5: the attach control joins the cluster (Photo Library and
// GIFs and Stickers; an item unavailable in the mode stays in the menu, disabled with its reason), the attachment chip
// and the link preview sit above the field, the system paste control appears while the pasteboard holds an image (no
// paste prompt), iPad drops land as files, and every photo reaches the presenter as a file copied into the caches
// directory off the main actor (CH6). Voice is CHT-6.

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
    @FocusState private var focused: Bool

    var body: some View {
        let composer = chat.composer
        #if DEBUG
        let _ = ChatDiagnostics.counters?.bump("chat.recompose.composer")
        #endif
        let limit = ChatComposerPolicy.limit(text: text, isVoiceMode: composer.isVoiceMode)
        let count = ChatComposerPolicy.limitLength(text: text, isVoice: composer.isVoiceMode)
        ConclaveComposerStack(identifier: "chat.composer") {
            ChatSuggestionList(draft: text, composer: composer) { replacement in
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
                && composer.gate == ChatSendGate.open {
                PasteButton(supportedContentTypes: [UTType.image]) { providers in
                    ChatPickedImageFile.attachFirst(providers, to: chat)
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
            if !ChatCopy.gateLine(composer.gate).isEmpty {
                ConclaveComposerStatusLine(text: ChatCopy.gateLine(composer.gate), identifier: "chat.composer.gate")
            }
        } field: {
            ConclaveComposerField(identifier: "chat.composer.cluster") {
                ChatAttachMenu(chat: chat, composer: composer, onPhoto: { showsPhotoPicker = true }, onGifs: { actions.openGifs() })
            } field: {
                TextField(ChatCopy.placeholder(composer), text: $text, axis: .vertical)
                    .lineLimit(1...ConclaveComposerMetrics.maximumLines)
                    .textInputAutocapitalization(.sentences)
                    .focused($focused)
                    .disabled(composer.gate == ChatSendGate.locked)
                    .onKeyPress(.return, phases: .down) { press in
                        // Hardware Return sends and Shift+Return inserts a newline; the software keyboard's Return stays
                        // a newline (the Messages convention, Q13).
                        guard GCKeyboard.coalesced != nil, !press.modifiers.contains(.shift) else { return .ignored }
                        send()
                        return .handled
                    }
                    .accessibilityLabel(ConclaveStrings.text("Message"))
                    .accessibilityValue(modeValue(composer))
                    .accessibilityHint(ConclaveStrings.text("Type @ to mention someone or / for commands."))
                    .accessibilityIdentifier("chat.composer.field")
            } send: {
                ConclaveComposerSendButton(title: VoiceCopy.sendTitle(isVoiceMode: composer.isVoiceMode), isEnabled: canSend(composer),
                                           disabledReason: disabledReason(composer, count: count, limit: limit),
                                           identifier: "chat.composer.send", action: send)
            }
        } footer: {
            ConclaveCharacterCounter(count: count, limit: limit,
                                     visibleFrom: composer.isVoiceMode ? 0 : ConclaveComposerCounterPolicy.visibleFrom(limit: limit),
                                     identifier: "chat.composer.counter")
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
        .onChange(of: text) { _, _ in
            chat.clearInlineNotice()
        }
        .onChange(of: actions.focusRequest) { _, _ in
            let insert = actions.pendingInsert
            actions.pendingInsert = ""
            if !insert.isEmpty {
                text = text.isEmpty ? insert : text + " " + insert
            }
            focused = true
        }
        .onChange(of: composer.inlineNotice) { _, notice in
            guard notice != ChatFailure.none else { return }
            postPolite(ChatMediaCopy.failureReason(notice))
        }
        .onDisappear {
            chat.drafts.setText(text, for: loadedKey)
        }
        // CH6: the picker item is loaded as a file copied into the caches directory (HEIC arrives as JPEG with the
        // compatible encoding); cancelling the picker changes nothing.
        .photosPicker(isPresented: $showsPhotoPicker, selection: $pickedItem, matching: .images, preferredItemEncoding: .compatible)
        .onChange(of: pickedItem) { _, item in
            guard let item else { return }
            pickedItem = nil
            Task { @MainActor in
                guard let file = try? await item.loadTransferable(type: ChatPickedImageFile.self) else { return }
                chat.attachPhoto(fileURL: file.url.absoluteString, mimeType: file.mimeType, fileName: file.fileName)
            }
        }
        // iPad drag and drop of images, as files (CH6).
        .dropDestination(for: ChatPickedImageFile.self) { files, _ in
            guard let file = files.first else { return false }
            chat.attachPhoto(fileURL: file.url.absoluteString, mimeType: file.mimeType, fileName: file.fileName)
            return true
        }
        // The paste control shows only while the pasteboard holds an image; `hasImages` shows no paste prompt.
        .task {
            refreshPasteboard()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)) { _ in
            refreshPasteboard()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            refreshPasteboard()
        }
    }

    private func refreshPasteboard() {
        let hasImage = UIPasteboard.general.hasImages
        if pasteboardHasImage != hasImage { pasteboardHasImage = hasImage }
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

    private func canSend(_ composer: ChatComposerSnapshot) -> Bool {
        ChatComposerPolicy.canSend(text: text, gate: composer.gate, isVoiceMode: composer.isVoiceMode,
                                   attachment: composer.attachment)
    }

    private func disabledReason(_ composer: ChatComposerSnapshot, count: Int, limit: Int) -> String {
        if composer.gate == ChatSendGate.reconnecting || composer.gate == ChatSendGate.offline
            || composer.gate == ChatSendGate.notJoined {
            return ConclaveStrings.text("Reconnecting")
        }
        if count > limit { return ConclaveStrings.format("%lld characters over the limit", count - limit) }
        if composer.attachment.blocksSend { return ConclaveStrings.text("Uploading photo") }
        return ConclaveStrings.text("Type a message")
    }

    /// The field's value names the mode, so the label stays "Message" (6 i).
    private func modeValue(_ composer: ChatComposerSnapshot) -> String {
        var parts: [String] = []
        if let recipient = composer.privateTo { parts.append(ConclaveStrings.format("Private to %@", recipient.name)) }
        if let reply = composer.reply { parts.append(ChatCopy.replyTitle(reply)) }
        if composer.isVoiceMode { parts.append(VoiceCopy.accessibilityValue) }
        return parts.joined(separator: ", ")
    }

    private func send() {
        let result = dismissedPreviewURL.isEmpty ? chat.send(text: text)
            : chat.send(text: text, suppressEmbedsFor: dismissedPreviewURL)
        if result == ChatSendResult.dispatched {
            text = ""
            dismissedPreviewURL = ""
            chat.drafts.setText("", for: loadedKey)
        }
    }

    private func postPolite(_ message: String) {
        guard !message.isEmpty else { return }
        var attributed = AttributedString(message)
        attributed.accessibilitySpeechAnnouncementPriority = .low
        AccessibilityNotification.Announcement(attributed).post()
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
/// bar (never a popover), 4.5 rows then scrolling; unavailable rows dimmed with their reason.
private struct ChatSuggestionList: View {
    let draft: String
    let composer: ChatComposerSnapshot
    let onPick: (String) -> Void
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 44

    var body: some View {
        let mentions = ChatComposerPolicy.mentionSuggestions(draft: draft, options: composer.mentionOptions)
        let commands = mentions.isEmpty ? ChatComposerPolicy.commandSuggestions(draft: draft, rows: composer.commandRows) : []
        let count = mentions.isEmpty ? commands.count : mentions.count
        Group {
            if count > 0 {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(mentions) { option in
                            mentionRow(option)
                        }
                        ForEach(commands) { row in
                            commandRow(row)
                        }
                    }
                }
                .frame(maxHeight: rowHeight * CGFloat(ChatComposerPolicy.suggestionVisibleRows))
                .fixedSize(horizontal: false, vertical: true)
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
        let dimmed = option.isAssistant && composer.privateTo != nil
        return Button {
            onPick(ChatComposerPolicy.insertingMention(draft: draft, token: option.token))
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
                    Text(option.isYou ? ConclaveStrings.format("%@ (You)", option.name)
                            : (option.isAssistant ? ConclaveStrings.text("Conclave AI") : option.name))
                        .font(.body)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(option.isAssistant
                            ? (dimmed ? ConclaveStrings.text("Conclave AI replies are public. Switch to Everyone to ask.")
                                : ConclaveStrings.text("Ask the meeting AI. Everyone sees the reply."))
                            : "@" + option.token)
                        .font(.footnote)
                        .foregroundStyle(HostingTheme.secondaryText)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(dimmed)
        .opacity(dimmed ? HostingTheme.disabledOpacity : 1)
        .accessibilityIdentifier("chat.suggestion." + option.id)
    }

    private func commandRow(_ row: ChatCommandRow) -> some View {
        Button {
            onPick(ChatComposerPolicy.insertingCommand(row.id))
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: CGFloat(DesignTokens.space8)) {
                Text(row.usage)
                    .font(.body.monospaced())
                    .foregroundStyle(.primary)
                Text(row.isAvailable ? ChatCopy.commandDescription(row.id) : ChatCopy.commandReason(row.reason))
                    .font(.footnote)
                    .foregroundStyle(HostingTheme.secondaryText)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
            .frame(minHeight: rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!row.isAvailable)
        .opacity(row.isAvailable ? 1 : HostingTheme.disabledOpacity)
        .accessibilityIdentifier("chat.suggestion." + row.id)
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
        .disabled(composer.gate != ChatSendGate.open)
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
    static func attachFirst(_ providers: [NSItemProvider], to chat: ChatPresenter) {
        guard let provider = providers.first else { return }
        _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
            guard let url, let file = try? ChatPickedImageFile.copyIntoCaches(url) else { return }
            Task { @MainActor in
                chat.attachPhoto(fileURL: file.url.absoluteString, mimeType: file.mimeType, fileName: file.fileName)
            }
        }
    }
}
#endif
