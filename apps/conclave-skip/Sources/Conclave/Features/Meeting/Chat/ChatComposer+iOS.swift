#if os(iOS) && !SKIP
import Accessibility
import GameController
import SwiftUI

// S40 6 (CHT-2): the composer on iOS, in the FND-3 composer bar (iOS 26 `safeAreaBar` with the glass cluster from
// the one sanctioned composer glass file, Owner OQ2 (2026-10-26); the opaque bordered field under Reduce Transparency
// and on iOS 17 to 25). Keystrokes stay in view state; the draft is written to `ChatDraftStore` after 500 ms idle and
// on disappear (R40-7), never to the view model. Every send goes through `chat.send` (ChatComposerPolicy.route, D24);
// no send, command or recipient haptic (Q11). Photos, GIFs, voice and the link preview are CHT-4 to CHT-6: the attach
// control appears once `composer.attachKinds` names an item, so this slice shows the field cluster alone.

struct ChatComposer: View {
    let chat: ChatPresenter
    let actions: ChatRowActions
    @State private var text = ""
    @State private var loadedKey = ""
    @State private var hasLoaded = false
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
            ChatComposerModeRow(chat: chat, composer: composer, draft: text)
            if composer.inlineNotice != ChatFailure.none {
                ConclaveComposerStatusLine(text: ChatCopy.failureReason(composer.inlineNotice), identifier: "chat.composer.notice")
            }
            if !ChatCopy.gateLine(composer.gate).isEmpty {
                ConclaveComposerStatusLine(text: ChatCopy.gateLine(composer.gate), identifier: "chat.composer.gate")
            }
        } field: {
            ConclaveComposerField(identifier: "chat.composer.cluster") {
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
                ConclaveComposerSendButton(title: ConclaveStrings.text("Send"), isEnabled: canSend(composer),
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
            postPolite(ChatCopy.failureReason(notice))
        }
        .onDisappear {
            chat.drafts.setText(text, for: loadedKey)
        }
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
        ChatComposerPolicy.canSend(text: text, gate: composer.gate, isVoiceMode: composer.isVoiceMode)
    }

    private func disabledReason(_ composer: ChatComposerSnapshot, count: Int, limit: Int) -> String {
        if composer.gate == ChatSendGate.reconnecting || composer.gate == ChatSendGate.offline
            || composer.gate == ChatSendGate.notJoined {
            return ConclaveStrings.text("Reconnecting")
        }
        if count > limit { return ConclaveStrings.format("%lld characters over the limit", count - limit) }
        return ConclaveStrings.text("Type a message")
    }

    /// The field's value names the mode, so the label stays "Message" (6 i).
    private func modeValue(_ composer: ChatComposerSnapshot) -> String {
        var parts: [String] = []
        if let recipient = composer.privateTo { parts.append(ConclaveStrings.format("Private to %@", recipient.name)) }
        if let reply = composer.reply { parts.append(ChatCopy.replyTitle(reply)) }
        return parts.joined(separator: ", ")
    }

    private func send() {
        let result = chat.send(text: text)
        if result == ChatSendResult.dispatched {
            text = ""
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
#endif
