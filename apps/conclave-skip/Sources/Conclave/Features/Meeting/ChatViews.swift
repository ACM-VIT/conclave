import Foundation
import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

enum ChatSubmitReplyPolicy {
    static func shouldClearReplyAfterSubmit(_ text: String, isDmEnabled: Bool) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if ChatCommandParser.parseDirectMessage(trimmed) != nil, !isDmEnabled {
            return false
        }
        if let command = ChatCommandParser.parse(trimmed)?.command {
            return command == .dm || command == .clear
        }
        return true
    }

    static func shouldClearDraftAfterSubmit(_ text: String, isDmEnabled: Bool) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if ChatCommandParser.parseDirectMessage(trimmed) != nil, !isDmEnabled {
            return false
        }
        return true
    }
}

enum ChatComposerLayout {
    static func inputHeight(isAndroid: Bool) -> CGFloat {
        isAndroid ? 36.0 : 40.0
    }

    static func inputHorizontalPadding(isAndroid: Bool) -> CGFloat {
        isAndroid ? 12.0 : 14.0
    }

    static func inputVerticalPadding(isAndroid: Bool) -> CGFloat {
        0.0
    }

    static func composerHorizontalPadding(isAndroid: Bool) -> CGFloat {
        isAndroid ? 12.0 : 16.0
    }

    static func composerVerticalPadding(isAndroid: Bool) -> CGFloat {
        isAndroid ? 4.0 : 14.0
    }

    static func composerMinHeight(isAndroid: Bool) -> CGFloat {
        inputHeight(isAndroid: isAndroid) + (isAndroid ? 8.0 : 24.0)
    }
}

enum ChatFocusReportPolicy {
    static func shouldReport(next: Bool, lastReported: Bool) -> Bool {
        next != lastReported
    }
}

enum ChatTimelineScrollPolicy {
    static let delayedScrollNanoseconds = UInt64(160_000_000)

    static func shouldScheduleDelayedScroll(entryCount: Int) -> Bool {
        entryCount > 0
    }

    static func shouldScrollToLatest(previousEntryId: String?, currentEntryId: String?) -> Bool {
        guard let currentEntryId, !currentEntryId.isEmpty else { return false }
        return currentEntryId != previousEntryId
    }
}

// MARK: - Chat Overlay

struct ChatOverlayView: View {
    @Bindable var viewModel: MeetingViewModel
    var onFocusChanged: (Bool) -> Void = { _ in }
    @State private var messageText = ""
    @State private var replyTarget: ChatReplyPreview?
    @State private var lastReportedFocus = false
    @FocusState private var isInputFocused: Bool
    private let maxChatInputLength = 1000

    private var messageTextBinding: Binding<String> {
        Binding(
            get: { messageText },
            set: { newValue in
                messageText = String(newValue.prefix(maxChatInputLength))
                markComposerActive()
            }
        )
    }

    private var isGhostChatDisabled: Bool {
        viewModel.state.isGhostMode
    }

    private var isWatchOnlyChatDisabled: Bool {
        viewModel.state.isWebinarAttendee
    }

    private var isHostChatLocked: Bool {
        viewModel.state.isChatLocked && !viewModel.state.isAdmin
    }

    private var isConnectionChatDisabled: Bool {
        viewModel.state.connectionState != .joined
    }

    private var isChatDisabled: Bool {
        isConnectionChatDisabled || isGhostChatDisabled || isWatchOnlyChatDisabled || isHostChatLocked
    }

    private var placeholder: String {
        if isConnectionChatDisabled {
            return "Chat unavailable until joined"
        }
        if isGhostChatDisabled {
            return "Ghost mode: chat disabled"
        }
        if isWatchOnlyChatDisabled {
            return "Watch-only: chat disabled"
        }
        if isHostChatLocked {
            return "Chat locked by host"
        }
        return "Message"
    }

    private var commandSuggestions: [ChatCommand] {
        guard !isChatDisabled, messageText.hasPrefix("/") else { return [] }
        let raw = String(messageText.dropFirst())
        guard !raw.contains(where: { $0.isWhitespace }) else { return [] }
        return ChatCommandParser.matchesPartialCommand(messageText)
    }

    private var inputHeight: CGFloat {
        ChatComposerLayout.inputHeight(isAndroid: isAndroidComposerLayout)
    }

    private var inputHorizontalPadding: CGFloat {
        ChatComposerLayout.inputHorizontalPadding(isAndroid: isAndroidComposerLayout)
    }

    private var inputVerticalPadding: CGFloat {
        ChatComposerLayout.inputVerticalPadding(isAndroid: isAndroidComposerLayout)
    }

    private var composerHorizontalPadding: CGFloat {
        ChatComposerLayout.composerHorizontalPadding(isAndroid: isAndroidComposerLayout)
    }

    private var composerVerticalPadding: CGFloat {
        ChatComposerLayout.composerVerticalPadding(isAndroid: isAndroidComposerLayout)
    }

    private var mentionSuggestionsMaxHeight: CGFloat {
        #if SKIP
        return isInputFocused ? 108.0 : 154.0
        #else
        return 154.0
        #endif
    }

    private var commandSuggestionsMaxHeight: CGFloat {
        #if SKIP
        return isInputFocused ? 128.0 : 190.0
        #else
        return 190.0
        #endif
    }

    private var composerMinHeight: CGFloat {
        ChatComposerLayout.composerMinHeight(isAndroid: isAndroidComposerLayout)
    }

    private var isAndroidComposerLayout: Bool {
        #if SKIP
        return true
        #else
        return false
        #endif
    }

    private var mentionContext: ChatMentionContext? {
        ChatMentionContextPolicy.context(
            for: messageText,
            isChatDisabled: isChatDisabled,
            isDmEnabled: viewModel.state.isDmEnabled
        )
    }

    private var mentionSuggestions: [ChatMentionSuggestion] {
        guard let context = mentionContext else { return [] }
        let query = context.query.lowercased()
        let normalizedQuery = ChatMentionSuggestion.normalizeToken(query)
        return viewModel.state.presentParticipants
            .map { participant in
                let displayName = viewModel.state.displayName(for: participant.id)
                return ChatMentionSuggestion(
                    userId: participant.id,
                    displayName: displayName,
                    mentionToken: ChatMentionSuggestion.token(userId: participant.id, displayName: displayName)
                )
            }
            .filter { suggestion in
                guard !query.isEmpty else { return true }
                let displayNameMatch = suggestion.displayName.lowercased().contains(query)
                let tokenMatch = !normalizedQuery.isEmpty && suggestion.mentionToken.contains(normalizedQuery)
                return displayNameMatch || tokenMatch
            }
            .sorted { left, right in
                if !normalizedQuery.isEmpty {
                    let leftStartsWith = left.mentionToken.hasPrefix(normalizedQuery)
                    let rightStartsWith = right.mentionToken.hasPrefix(normalizedQuery)
                    if leftStartsWith != rightStartsWith {
                        return leftStartsWith
                    }
                }
                return left.displayName.lowercased() < right.displayName.lowercased()
            }
    }

    var body: some View {
        let canSendMessage = !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isChatDisabled

        VStack(spacing: 0) {
            HStack {
                Text("Chat")
                    .font(ACMFont.trial(16, weight: .semibold))
                    .foregroundStyle(ACMColors.text)

                Spacer()

                Button {
                    closeChat()
                } label: {
                    ACMSystemIcon.icon("xmark", android: "close", size: 13)
                        .foregroundStyle(ACMColors.textMuted)
                        .frame(width: 30, height: 30)
                        .acmColorBackground(ACMColors.surfaceRaised)
                        .clipShape(Circle())
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .overlay(alignment: .bottom) {
                Rectangle().fill(ACMColors.border).frame(height: 1)
            }

            ChatTimelineView(
                chatMessages: viewModel.state.chatMessages,
                systemMessages: viewModel.state.systemMessages,
                localUserId: viewModel.state.userId,
                localSfuUserId: viewModel.state.sfuUserId,
                isInputFocused: isInputFocused,
                mentionSuggestionsCount: mentionSuggestions.count,
                commandSuggestionsCount: commandSuggestions.count,
                isCurrentUser: { userId in
                    viewModel.state.isLocalIdentityUserId(userId)
                },
                onReply: { message in
                    beginReply(to: message)
                }
            )
            .equatable()
            .frame(minHeight: 0, maxHeight: .infinity)

            VStack(spacing: 10) {
                if let replyTarget {
                    ChatReplyComposerView(
                        replyTo: replyTarget,
                        isReplyFromCurrentUser: viewModel.state.isLocalIdentityUserId(replyTarget.userId),
                        onCancel: { self.replyTarget = nil }
                    )
                }

                if !mentionSuggestions.isEmpty, let context = mentionContext {
                    ChatMentionSuggestionsView(
                        suggestions: mentionSuggestions,
                        maxHeight: mentionSuggestionsMaxHeight,
                        onSelect: { suggestion in
                            applyMentionSuggestion(suggestion, context: context)
                        }
                    )
                } else if !commandSuggestions.isEmpty {
                    ChatCommandSuggestionsView(
                        commands: commandSuggestions,
                        maxHeight: commandSuggestionsMaxHeight,
                        onSelect: applyCommandSuggestion
                    )
                }

                HStack(spacing: 10) {
                    TextField(placeholder, text: messageTextBinding)
                        .textFieldStyle(.plain)
                        .font(ACMFont.trial(14))
                        .foregroundStyle(ACMColors.text)
                        .tint(ACMColors.primaryOrange)
                        .padding(.horizontal, inputHorizontalPadding)
                        #if SKIP
                        .padding(.vertical, inputVerticalPadding)
                        .frame(height: inputHeight, alignment: .center)
                        #else
                        .frame(height: inputHeight)
                        #endif
                        .acmColorBackground(ACMColors.bgAlt)
                        .overlay {
                            Capsule().strokeBorder(lineWidth: 1).foregroundStyle(ACMColors.border)
                        }
                        .clipShape(Capsule())
                        .focused($isInputFocused)
                        .onTapGesture {
                            markComposerActive()
                        }
                        .lineLimit(1)
                        .submitLabel(SubmitLabel.send)
                        .onSubmit {
                            sendMessage()
                        }
                        .disabled(isChatDisabled)

                    Button {
                        sendMessage()
                    } label: {
                        ACMSystemIcon.icon("arrow.up", android: "send", size: 16)
                            .foregroundStyle(canSendMessage ? Color.white : ACMColors.textFaint)
                            .frame(width: inputHeight, height: inputHeight)
                            .acmColorBackground(canSendMessage ? ACMColors.primaryOrange : ACMColors.surfaceRaised)
                            .clipShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .frame(width: inputHeight, height: inputHeight)
                        #if !SKIP
                        .contentShape(Circle())
                        #endif
                        .disabled(!canSendMessage)
                }
                .frame(height: inputHeight)
                .onTapGesture {
                    markComposerActive()
                }
            }
            .padding(.horizontal, composerHorizontalPadding)
            .padding(.vertical, composerVerticalPadding)
            .overlay(alignment: .top) {
                Rectangle().fill(ACMColors.border).frame(height: 1)
            }
            .frame(minHeight: composerMinHeight)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .acmColorBackground(ACMColors.surface)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.border)
        }
        #if SKIP
        .onChange(of: isInputFocused ? "focused" : "blurred") { _, _ in
            reportFocus(isInputFocused)
        }
        #else
        .onChange(of: isInputFocused) { _, focused in
            reportFocus(focused)
        }
        #endif
        .onChange(of: messageText) { _, newValue in
            guard !newValue.isEmpty else { return }
            markComposerActive()
        }
        .onDisappear {
            reportFocus(false)
        }
    }

    func sendMessage() {
        let trimmed = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isChatDisabled else { return }
        let activeReply = replyTarget
        let shouldClearDraft = ChatSubmitReplyPolicy.shouldClearDraftAfterSubmit(trimmed, isDmEnabled: viewModel.state.isDmEnabled)
        if ChatSubmitReplyPolicy.shouldClearReplyAfterSubmit(trimmed, isDmEnabled: viewModel.state.isDmEnabled) {
            replyTarget = nil
        }
        viewModel.sendChatMessage(trimmed, replyTo: activeReply)
        if shouldClearDraft {
            messageText = ""
        } else {
            focusInput()
        }
    }

    private func closeChat() {
        isInputFocused = false
        reportFocus(false)
        withAnimation(.easeInOut(duration: 0.12)) {
            viewModel.toggleChat()
        }
    }

    private func markComposerActive() {
        #if SKIP
        guard !isChatDisabled else { return }
        reportFocus(true)
        #endif
    }

    private func reportFocus(_ focused: Bool) {
        guard ChatFocusReportPolicy.shouldReport(next: focused, lastReported: lastReportedFocus) else { return }
        lastReportedFocus = focused
        onFocusChanged(focused)
    }

    private func beginReply(to message: ChatMessage) {
        replyTarget = ChatReplyPreview(
            id: message.id,
            userId: message.userId,
            displayName: message.displayName,
            content: replyPreviewContent(for: message),
            hasGif: message.gif != nil,
            isDirect: message.isDirect,
            dmTargetUserId: message.dmTargetUserId
        )
        focusInput()
    }

    private func replyPreviewContent(for message: ChatMessage) -> String {
        if let gif = message.gif {
            let title = gif.title.trimmingCharacters(in: .whitespacesAndNewlines)
            return title.isEmpty ? "GIF" : title
        }
        let content = message.content.trimmingCharacters(in: .whitespacesAndNewlines)
        if content.isEmpty {
            return "Message"
        }
        return String(content.prefix(180))
    }

    private func applyCommandSuggestion(_ command: ChatCommand) {
        messageText = command.insertText
        focusInput()
    }

    private func applyMentionSuggestion(_ suggestion: ChatMentionSuggestion, context: ChatMentionContext) {
        switch context.mode {
        case .at:
            messageText = "\(context.replacementPrefix)@\(suggestion.mentionToken) "
        case .dm:
            messageText = "/dm \(suggestion.mentionToken) "
        }
        focusInput()
    }

    private func focusInput() {
        isInputFocused = true
    }
}

private struct ChatTimelineView: View, Equatable {
    let chatMessages: [ChatMessage]
    let systemMessages: [SystemMessage]
    let localUserId: String
    let localSfuUserId: String?
    let isInputFocused: Bool
    let mentionSuggestionsCount: Int
    let commandSuggestionsCount: Int
    let isCurrentUser: (String) -> Bool
    let onReply: (ChatMessage) -> Void
    @State private var delayedScrollTask: Task<Void, Never>?

    private var timeline: [ChatTimelineEntry] {
        (chatMessages.map { ChatTimelineEntry.message($0) }
            + systemMessages.map { ChatTimelineEntry.system($0) })
            .sorted { $0.timestamp < $1.timestamp }
    }

    static func == (lhs: ChatTimelineView, rhs: ChatTimelineView) -> Bool {
        lhs.chatMessages == rhs.chatMessages &&
            lhs.systemMessages == rhs.systemMessages &&
            lhs.localUserId == rhs.localUserId &&
            lhs.localSfuUserId == rhs.localSfuUserId &&
            lhs.isInputFocused == rhs.isInputFocused &&
            lhs.mentionSuggestionsCount == rhs.mentionSuggestionsCount &&
            lhs.commandSuggestionsCount == rhs.commandSuggestionsCount
    }

    var body: some View {
        let entries = timeline
        let latestEntryId = entries.last?.id
        ScrollViewReader { proxy in
            ScrollView {
                if entries.isEmpty {
                    ChatEmptyStateView()
                } else {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(entries) { entry in
                            switch entry {
                            case .message(let message):
                                let isFromCurrentUser = isCurrentUser(message.userId)
                                let isReplyFromCurrentUser = message.replyTo.map { reply in
                                    isCurrentUser(reply.userId)
                                } == true
                                if let actionText = ChatMessagePresentation.actionText(from: message.content) {
                                    ChatActionMessageRow(
                                        message: message,
                                        isFromCurrentUser: isFromCurrentUser,
                                        isReplyFromCurrentUser: isReplyFromCurrentUser,
                                        onReply: onReply,
                                        actionText: actionText
                                    )
                                    .id(entry.id)
                                } else {
                                    ChatBubbleView(
                                        message: message,
                                        isFromCurrentUser: isFromCurrentUser,
                                        isReplyFromCurrentUser: isReplyFromCurrentUser,
                                        onReply: onReply
                                    )
                                    .id(entry.id)
                                }
                            case .system(let system):
                                SystemMessageRow(message: system)
                                    .id(entry.id)
                            }
                        }
                    }
                    .padding()
                }
            }
            .onChange(of: latestEntryId) { previousEntryId, currentEntryId in
                guard ChatTimelineScrollPolicy.shouldScrollToLatest(
                    previousEntryId: previousEntryId,
                    currentEntryId: currentEntryId
                ) else {
                    return
                }
                scrollToLatestMessage(in: entries, proxy: proxy)
                scheduleDelayedScroll(in: entries, proxy: proxy)
            }
            .onAppear {
                scrollToLatestMessage(in: entries, proxy: proxy, animated: false)
                scheduleDelayedScroll(in: entries, proxy: proxy, animated: false)
            }
            .onDisappear {
                cancelDelayedScroll()
            }
            #if SKIP
            .onChange(of: isInputFocused ? "focused" : "blurred") { _, _ in
                guard isInputFocused else { return }
                scrollToLatestMessage(in: entries, proxy: proxy)
                scheduleDelayedScroll(in: entries, proxy: proxy)
            }
            #else
            .onChange(of: isInputFocused) { _, focused in
                guard focused else { return }
                scrollToLatestMessage(in: entries, proxy: proxy)
                scheduleDelayedScroll(in: entries, proxy: proxy)
            }
            #endif
            .onChange(of: mentionSuggestionsCount) { _, _ in
                guard isInputFocused else { return }
                scrollToLatestMessage(in: entries, proxy: proxy)
            }
            .onChange(of: commandSuggestionsCount) { _, _ in
                guard isInputFocused else { return }
                scrollToLatestMessage(in: entries, proxy: proxy)
            }
        }
    }

    private func scheduleDelayedScroll(
        in timeline: [ChatTimelineEntry],
        proxy: ScrollViewProxy,
        animated: Bool = true
    ) {
        cancelDelayedScroll()
        guard ChatTimelineScrollPolicy.shouldScheduleDelayedScroll(entryCount: timeline.count) else { return }

        delayedScrollTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: ChatTimelineScrollPolicy.delayedScrollNanoseconds)
            guard !Task.isCancelled else { return }
            scrollToLatestMessage(in: timeline, proxy: proxy, animated: animated)
        }
    }

    private func cancelDelayedScroll() {
        delayedScrollTask?.cancel()
        delayedScrollTask = nil
    }

    private func scrollToLatestMessage(
        in timeline: [ChatTimelineEntry],
        proxy: ScrollViewProxy,
        animated: Bool = true
    ) {
        guard let last = timeline.last else { return }
        guard animated else {
            proxy.scrollTo(last.id, anchor: .bottom)
            return
        }
        withAnimation(Animation.easeOut(duration: 0.12)) {
            proxy.scrollTo(last.id, anchor: .bottom)
        }
    }
}

struct ChatPreviewOverlayView: View {
    let messages: [ChatMessage]
    let onDismiss: (String) -> Void

    private var visibleMessages: [ChatMessage] {
        Array(messages.suffix(3))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(visibleMessages) { message in
                ChatPreviewRow(message: message, onDismiss: onDismiss)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }
}

private struct ChatPreviewRow: View {
    let message: ChatMessage
    let onDismiss: (String) -> Void

    private var previewLabel: String {
        ChatMessagePresentation.displayName(for: message, isFromCurrentUser: false)
    }

    private var actionText: String? {
        ChatMessagePresentation.actionText(from: message.content)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ACMSystemIcon.icon(message.isDirect ? "lock.fill" : "message.fill", android: message.isDirect ? "lock" : "chat", size: 13)
                .foregroundStyle(message.isDirect ? ACMColors.handRaised : ACMColors.primaryOrange)
                .frame(width: 26, height: 26)
                .acmColorBackground(ACMColors.surfaceRaised)
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(previewLabel)
                        .font(ACMFont.trial(12, weight: .semibold))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)

                    if message.isDirect {
                        Text("Private")
                            .font(ACMFont.trial(11, weight: .medium))
                            .foregroundStyle(ACMColors.handRaised)
                            .lineLimit(1)
                    }
                }

                if let actionText {
                    Text(actionText)
                        .font(ACMFont.trial(12))
                        .italic()
                        .foregroundStyle(ACMColors.textMuted)
                        .lineLimit(2)
                } else if let gif = message.gif {
                    Text("\(ChatGifAttachmentPresentation.previewLabel(for: gif)): \(gifTitle(gif))")
                        .font(ACMFont.trial(12))
                        .foregroundStyle(ACMColors.textMuted)
                        .lineLimit(2)
                } else {
                    Text(message.content)
                        .font(ACMFont.trial(12))
                        .foregroundStyle(ACMColors.textMuted)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                onDismiss(message.id)
            } label: {
                ACMSystemIcon.icon("xmark", android: "close", size: 10)
                    .foregroundStyle(ACMColors.textFaint)
                    .frame(width: 24, height: 24)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .acmColorBackground(ACMColors.surface.opacity(0.96))
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.border)
        }
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        .shadow(color: .black.opacity(0.24), radius: 14, x: 0, y: 8)
    }

    private func gifTitle(_ gif: ChatGifAttachment) -> String {
        let title = gif.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? "GIF" : title
    }
}

// MARK: - Chat Suggestions

enum ChatMentionMode: Equatable {
    case at
    case dm
}

struct ChatMentionContext: Equatable {
    let mode: ChatMentionMode
    let query: String
    let replacementPrefix: String

    init(mode: ChatMentionMode, query: String, replacementPrefix: String = "") {
        self.mode = mode
        self.query = query
        self.replacementPrefix = replacementPrefix
    }
}

enum ChatMentionContextPolicy {
    static func context(
        for text: String,
        isChatDisabled: Bool,
        isDmEnabled: Bool
    ) -> ChatMentionContext? {
        guard !isChatDisabled, isDmEnabled else { return nil }

        if let atContext = trailingAtMentionContext(in: text) {
            return atContext
        }

        let value = trimLeadingWhitespace(text)
        guard value.lowercased().hasPrefix("/dm") else { return nil }
        let query = trimLeadingWhitespace(String(value.dropFirst(3)))
        guard !containsWhitespace(query) else { return nil }
        return ChatMentionContext(mode: .dm, query: query.lowercased())
    }

    static func replacedTrailingAtMention(in text: String, with mentionToken: String) -> String? {
        guard let context = trailingAtMentionContext(in: text) else { return nil }
        return "\(context.replacementPrefix)@\(mentionToken) "
    }

    private static func trailingAtMentionContext(in text: String) -> ChatMentionContext? {
        let trailingTokenStart = lastTokenStartIndex(in: text)
        let trailingToken = String(text[trailingTokenStart...])
        guard trailingToken.hasPrefix("@") else { return nil }
        let query = String(trailingToken.dropFirst())
        guard !containsWhitespace(query) else { return nil }
        let prefix = String(text[..<trailingTokenStart])
        return ChatMentionContext(mode: .at, query: query.lowercased(), replacementPrefix: prefix)
    }

    private static func lastTokenStartIndex(in text: String) -> String.Index {
        var index = text.endIndex
        while index > text.startIndex {
            let previous = text.index(before: index)
            let character = text[previous]
            if character.isWhitespace || character.isNewline {
                break
            }
            index = previous
        }
        return index
    }

    private static func trimLeadingWhitespace(_ value: String) -> String {
        var trimmed = ""
        var didFindContent = false
        for character in value {
            if !didFindContent && (character.isWhitespace || character.isNewline) {
                continue
            }
            didFindContent = true
            trimmed += String(character)
        }
        return trimmed
    }

    private static func containsWhitespace(_ value: String) -> Bool {
        value.contains { character in
            character.isWhitespace || character.isNewline
        }
    }
}

private struct ChatMentionSuggestion: Identifiable, Equatable {
    let userId: String
    let displayName: String
    let mentionToken: String

    var id: String { userId }

    static func token(userId: String, displayName: String) -> String {
        let displayNameToken = normalizeToken(displayName)
        if !displayNameToken.isEmpty {
            return displayNameToken
        }

        let base = userId.components(separatedBy: "#").first ?? userId
        let handle = base.components(separatedBy: "@").first ?? base
        return normalizeToken(handle).isEmpty ? normalizeToken(base) : normalizeToken(handle)
    }

    static func normalizeToken(_ value: String) -> String {
        let allowed = "abcdefghijklmnopqrstuvwxyz0123456789._-"
        var normalized: [String] = []
        for character in value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() where allowed.contains(character) {
            normalized.append("\(character)")
        }
        return normalized.joined()
    }
}

private struct ChatMentionSuggestionsView: View {
    let suggestions: [ChatMentionSuggestion]
    let maxHeight: CGFloat
    let onSelect: (ChatMentionSuggestion) -> Void

    var body: some View {
        ChatSuggestionsContainer(maxHeight: maxHeight) {
            ForEach(suggestions) { suggestion in
                Button {
                    onSelect(suggestion)
                } label: {
                    HStack(spacing: 10) {
                        Text(String(suggestion.displayName.prefix(1)).uppercased())
                            .font(ACMFont.trial(11, weight: .bold))
                            .foregroundStyle(Color.white)
                            .frame(width: 24, height: 24)
                            .acmColorBackground(ACMColors.avatarColor(for: suggestion.userId))
                            .clipShape(Circle())

                        VStack(alignment: .leading, spacing: 2) {
                            Text(suggestion.displayName)
                                .font(ACMFont.trial(13, weight: .medium))
                                .foregroundStyle(ACMColors.text)
                                .lineLimit(1)

                            Text("@\(suggestion.mentionToken)")
                                .font(ACMFont.trial(11))
                                .foregroundStyle(ACMColors.textFaint)
                                .lineLimit(1)
                        }

                        Spacer(minLength: 8)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private struct ChatCommandSuggestionsView: View {
    let commands: [ChatCommand]
    let maxHeight: CGFloat
    let onSelect: (ChatCommand) -> Void

    var body: some View {
        ChatSuggestionsContainer(maxHeight: maxHeight) {
            ForEach(commands, id: \.rawValue) { command in
                Button {
                    onSelect(command)
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        ACMSystemIcon.icon(command.icon, android: command.icon, size: 15)
                            .foregroundStyle(ACMColors.primaryOrange)
                            .frame(width: 24, height: 24)

                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 8) {
                                Text("/\(command.rawValue)")
                                    .font(ACMFont.trial(13, weight: .medium))
                                    .foregroundStyle(ACMColors.text)

                                Text(command.usage)
                                    .font(ACMFont.trial(10))
                                    .foregroundStyle(ACMColors.textFaint)
                                    .lineLimit(1)
                            }

                            Text(command.description)
                                .font(ACMFont.trial(11))
                                .foregroundStyle(ACMColors.textMuted)
                                .lineLimit(1)
                        }

                        Spacer(minLength: 8)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private struct ChatSuggestionsContainer<Content: View>: View {
    let maxHeight: CGFloat
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                content
            }
        }
        .frame(maxHeight: maxHeight)
        .acmColorBackground(ACMColors.bgAlt)
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.md)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.border)
        }
    }
}

// MARK: - System Message Row

/// A centered, muted note for slash-command feedback (e.g. "You used /raise").
struct SystemMessageRow: View {
    let message: SystemMessage

    var body: some View {
        Text(message.displayText)
            .font(ACMFont.trial(12))
            .foregroundStyle(ACMColors.textMuted)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 2)
    }
}

private enum ChatMessagePresentation {
    static func displayName(for message: ChatMessage, isFromCurrentUser: Bool) -> String {
        if isFromCurrentUser {
            return "You"
        }
        let displayName = message.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !displayName.isEmpty {
            return displayName
        }
        let userId = message.userId.trimmingCharacters(in: .whitespacesAndNewlines)
        return MeetingState.fallbackDisplayName(for: userId)
    }

    static func directMessageLabel(for message: ChatMessage, isFromCurrentUser: Bool) -> String? {
        guard message.isDirect else { return nil }
        if isFromCurrentUser {
            let displayName = message.dmTargetDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let name = displayName.isEmpty
                ? MeetingState.fallbackDisplayName(for: message.dmTargetUserId ?? "")
                : displayName
            return "Private to \(name)"
        }
        return "Private message"
    }

    static func replyDisplayName(for reply: ChatReplyPreview, isFromCurrentUser: Bool) -> String {
        if isFromCurrentUser {
            return "You"
        }
        let displayName = reply.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !displayName.isEmpty {
            return displayName
        }
        return MeetingState.fallbackDisplayName(for: reply.userId)
    }

    static func actionText(from content: String) -> String? {
        ChatMessageContentPolicy.actionText(from: content)
    }
}

struct ChatActionMessageRow: View {
    let message: ChatMessage
    let isFromCurrentUser: Bool
    let isReplyFromCurrentUser: Bool
    let onReply: (ChatMessage) -> Void
    let actionText: String

    private var directMessageLabel: String? {
        ChatMessagePresentation.directMessageLabel(for: message, isFromCurrentUser: isFromCurrentUser)
    }

    var body: some View {
        VStack(spacing: 3) {
            if let directMessageLabel {
                Text(directMessageLabel)
                    .font(ACMFont.trial(11, weight: .medium))
                    .foregroundStyle(ACMColors.handRaised)
            }

            if let replyTo = message.replyTo {
                ChatReplyQuoteView(
                    replyTo: replyTo,
                    isFromCurrentUser: isFromCurrentUser,
                    isReplyFromCurrentUser: isReplyFromCurrentUser
                )
            }

            HStack(spacing: 6) {
                Text(actionLine)
                    .font(ACMFont.trial(12))
                    .foregroundStyle(ACMColors.textMuted)
                    .multilineTextAlignment(.center)

                ChatReplyButton {
                    onReply(message)
                }
            }
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .padding(.vertical, 2)
    }

    private var actionLine: String {
        "\(ChatMessagePresentation.displayName(for: message, isFromCurrentUser: isFromCurrentUser)) \(actionText)"
    }
}

// MARK: - Chat Bubble

struct ChatBubbleView: View {
    let message: ChatMessage
    let isFromCurrentUser: Bool
    let isReplyFromCurrentUser: Bool
    let onReply: (ChatMessage) -> Void

    private var directMessageLabel: String? {
        ChatMessagePresentation.directMessageLabel(for: message, isFromCurrentUser: isFromCurrentUser)
    }

    var body: some View {
        VStack(alignment: isFromCurrentUser ? .trailing : .leading, spacing: 4) {
            HStack(spacing: 6) {
                if !isFromCurrentUser {
                    Text(ChatMessagePresentation.displayName(for: message, isFromCurrentUser: false))
                        .font(ACMFont.trial(12, weight: .medium))
                        .foregroundStyle(ACMColors.textMuted)
                }
                Text(message.timestamp, style: .time)
                    .font(ACMFont.trial(11))
                    .foregroundStyle(ACMColors.textFaint)

                ChatReplyButton {
                    onReply(message)
                }
            }

            if let directMessageLabel {
                Text(directMessageLabel)
                    .font(ACMFont.trial(11, weight: .medium))
                    .foregroundStyle(ACMColors.handRaised)
            }

            if let replyTo = message.replyTo {
                ChatReplyQuoteView(
                    replyTo: replyTo,
                    isFromCurrentUser: isFromCurrentUser,
                    isReplyFromCurrentUser: isReplyFromCurrentUser
                )
            }

            if let gif = message.gif {
                ChatGifAttachmentView(gif: gif)
                    .overlay {
                        if message.isDirect {
                            RoundedRectangle(cornerRadius: ACMRadius.md)
                                .strokeBorder(lineWidth: 1)
                                .foregroundStyle(ACMColors.handRaisedBorder)
                        }
                    }
                    .frame(maxWidth: 260, alignment: isFromCurrentUser ? .trailing : .leading)
            } else {
                ChatMessageTextBubble(
                    content: message.content,
                    isFromCurrentUser: isFromCurrentUser,
                    isDirect: message.isDirect
                )
                .frame(maxWidth: 260, alignment: isFromCurrentUser ? .trailing : .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: isFromCurrentUser ? .trailing : .leading)
    }
}

struct ChatMessageTextBubble: View {
    let content: String
    let isFromCurrentUser: Bool
    let isDirect: Bool

    private var links: [ChatMessageLink] {
        Array(ChatMessageLinkParser.links(in: content).prefix(3))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: links.isEmpty ? 0.0 : 8.0) {
            Text(content)
                .font(ACMFont.trial(14))
                .foregroundStyle(isFromCurrentUser ? Color.white : ACMColors.text)

            if !links.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(links) { link in
                        ChatMessageLinkChip(link: link, isFromCurrentUser: isFromCurrentUser)
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .acmColorBackground(isFromCurrentUser ? ACMColors.primaryOrange : ACMColors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        .overlay {
            if isDirect {
                RoundedRectangle(cornerRadius: ACMRadius.md)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.handRaisedBorder)
            }
        }
    }
}

private struct ChatMessageLinkChip: View {
    let link: ChatMessageLink
    let isFromCurrentUser: Bool

    var body: some View {
        Link(destination: link.url) {
            HStack(spacing: 6) {
                ACMSystemIcon.icon("link", android: "link", size: 12)
                    .foregroundStyle(isFromCurrentUser ? Color.white.opacity(0.82) : ACMColors.primaryOrange)
                Text(link.display)
                    .font(ACMFont.trial(12, weight: .medium))
                    .foregroundStyle(isFromCurrentUser ? Color.white : ACMColors.text)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(.horizontal, 9.0)
            .padding(.vertical, 6.0)
            .acmColorBackground(isFromCurrentUser ? Color.black.opacity(0.16) : ACMColors.bgAlt)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

struct ChatMessageLink: Identifiable, Equatable {
    let display: String
    let url: URL

    var id: String {
        "\(display)|\(url.absoluteString)"
    }
}

enum ChatMessageLinkParser {
    static func links(in content: String) -> [ChatMessageLink] {
        var seen = Set<String>()
        var links: [ChatMessageLink] = []
        let normalizedContent = content
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\t", with: " ")
        for token in normalizedContent.components(separatedBy: " ") {
            guard let link = link(from: token),
                  seen.insert(link.url.absoluteString).inserted else {
                continue
            }
            links.append(link)
        }
        return links
    }

    private static func link(from token: String) -> ChatMessageLink? {
        var display = token.trimmingCharacters(in: .whitespaces)
        guard !display.isEmpty else { return nil }
        while let first = display.first, leadingURLPunctuation.contains(first) {
            display = String(display.dropFirst())
        }
        while let last = display.last, trailingURLPunctuation.contains(last) {
            display = String(display.prefix(max(0, display.count - 1)))
        }
        guard !display.isEmpty, !display.contains("@"), looksLikeURL(display) else { return nil }
        let href = display.lowercased().hasPrefix("http://") || display.lowercased().hasPrefix("https://")
            ? display
            : "https://\(display)"
        guard let url = URL(string: href),
              url.scheme == "http" || url.scheme == "https",
              url.host?.isEmpty == false else { return nil }
        return ChatMessageLink(display: display, url: url)
    }

    private static func looksLikeURL(_ value: String) -> Bool {
        let lowercased = value.lowercased()
        if lowercased.hasPrefix("http://") || lowercased.hasPrefix("https://") || lowercased.hasPrefix("www.") {
            return true
        }
        let slashParts = lowercased.components(separatedBy: "/")
        let pathless = slashParts.isEmpty ? lowercased : slashParts[0]
        let colonParts = pathless.components(separatedBy: ":")
        let host = colonParts.isEmpty ? pathless : colonParts[0]
        let parts = host.components(separatedBy: ".")
        guard parts.count >= 2,
              let tld = parts.last,
              tld.count >= 2 else {
            return false
        }
        for part in parts where part.isEmpty {
            return false
        }
        for character in tld where !asciiLetters.contains(character) {
            return false
        }
        for character in host {
            guard asciiLetters.contains(character) ||
                asciiNumbers.contains(character) ||
                character == "-" ||
                character == "." else {
                return false
            }
        }
        return true
    }

    private static let leadingURLPunctuation = "([<{\"'"
    private static let trailingURLPunctuation = ")]}>\"',.!?;:"
    private static let asciiLetters = "abcdefghijklmnopqrstuvwxyz"
    private static let asciiNumbers = "0123456789"
}

struct ChatGifAttachmentView: View {
    let gif: ChatGifAttachment

    private var imageURL: URL? {
        URL(string: ChatGifAttachmentPresentation.imageURLString(for: gif))
    }

    private var title: String {
        ChatGifAttachmentPresentation.title(for: gif)
    }

    private var mediaWidth: CGFloat {
        ChatGifAttachmentPresentation.mediaWidth
    }

    private var mediaHeight: CGFloat {
        ChatGifAttachmentPresentation.mediaHeight(for: gif, width: mediaWidth)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let imageURL {
                AsyncImage(url: imageURL) { image in
                    image
                        .resizable()
                        .scaledToFit()
                } placeholder: {
                    ProgressView()
                        .tint(ACMColors.primaryOrange)
                        .frame(width: mediaWidth, height: mediaHeight)
                }
                .frame(width: mediaWidth, height: mediaHeight)
            } else {
                Text(title)
                    .font(ACMFont.trial(14, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
            }
        }
        .acmColorBackground(ChatGifAttachmentPresentation.isSticker(gif) ? Color.clear : Color.black.opacity(0.25))
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        .overlay(alignment: .bottomLeading) {
            Text(ChatGifAttachmentPresentation.badgeText(for: gif))
                .font(ACMFont.trial(9, weight: .semibold))
                .foregroundStyle(Color.white.opacity(0.78))
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .background(Color.black.opacity(0.35))
                .clipShape(Capsule())
                .padding(8)
        }
        .accessibilityLabel(title)
    }
}

enum ChatGifAttachmentPresentation {
    static let mediaWidth: CGFloat = 240
    private static let defaultMediaHeight: CGFloat = 150
    private static let minMediaHeight: CGFloat = 96
    private static let maxMediaHeight: CGFloat = 220
    private static let minAspectRatio: Double = 0.35
    private static let maxAspectRatio: Double = 3.0

    static func title(for gif: ChatGifAttachment) -> String {
        let trimmed = gif.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "GIF" : trimmed
    }

    static func kind(for gif: ChatGifAttachment) -> String {
        gif.kind?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "gif"
    }

    static func isSticker(_ gif: ChatGifAttachment) -> Bool {
        kind(for: gif) == "sticker"
    }

    static func isClip(_ gif: ChatGifAttachment) -> Bool {
        kind(for: gif) == "clip" &&
            !(gif.videoUrl?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }

    static func imageURLString(for gif: ChatGifAttachment) -> String {
        if isClip(gif),
           let preview = gif.previewUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
           !preview.isEmpty {
            return preview
        }
        return gif.url.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func aspectRatio(for gif: ChatGifAttachment) -> Double? {
        guard let width = gif.width,
              let height = gif.height,
              width.isFinite,
              height.isFinite,
              width > 0,
              height > 0 else {
            return nil
        }
        return min(max(width / height, minAspectRatio), maxAspectRatio)
    }

    static func mediaHeight(for gif: ChatGifAttachment, width: CGFloat = mediaWidth) -> CGFloat {
        guard let aspectRatio = aspectRatio(for: gif) else {
            return defaultMediaHeight
        }
        let height = width / CGFloat(aspectRatio)
        return min(max(height, minMediaHeight), maxMediaHeight)
    }

    static func badgeText(for gif: ChatGifAttachment) -> String {
        isClip(gif) ? "CLIP" : "KLIPY"
    }

    static func previewLabel(for gif: ChatGifAttachment) -> String {
        switch kind(for: gif) {
        case "sticker":
            return "Sticker"
        case "clip":
            return "Clip"
        default:
            return "GIF"
        }
    }
}

struct ChatReplyButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ACMSystemIcon.icon("arrowshape.turn.up.left", android: "reply", size: 12)
                .foregroundStyle(ACMColors.textMuted)
                .frame(width: 26, height: 26)
                .acmColorBackground(ACMColors.surfaceRaised)
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
    }
}

struct ChatReplyComposerView: View {
    let replyTo: ChatReplyPreview
    let isReplyFromCurrentUser: Bool
    let onCancel: () -> Void

    private var previewText: String {
        replyTo.hasGif ? "GIF" : replyTo.content
    }

    var body: some View {
        HStack(spacing: 10) {
            Rectangle()
                .fill(ACMColors.primaryOrange)
                .frame(width: 3)
                .clipShape(Capsule())

            VStack(alignment: .leading, spacing: 2) {
                Text(ChatMessagePresentation.replyDisplayName(for: replyTo, isFromCurrentUser: isReplyFromCurrentUser))
                    .font(ACMFont.trial(11, weight: .semibold))
                    .foregroundStyle(ACMColors.primaryOrange)
                    .lineLimit(1)

                Text(previewText)
                    .font(ACMFont.trial(12))
                    .foregroundStyle(ACMColors.textMuted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button(action: onCancel) {
                ACMSystemIcon.icon("xmark", android: "close", size: 11)
                    .foregroundStyle(ACMColors.textMuted)
                    .frame(width: 28, height: 28)
                    .acmColorBackground(ACMColors.surfaceRaised)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .acmColorBackground(ACMColors.bgAlt)
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.md)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.border)
        }
    }
}

struct ChatReplyQuoteView: View {
    let replyTo: ChatReplyPreview
    let isFromCurrentUser: Bool
    let isReplyFromCurrentUser: Bool

    private var previewText: String {
        replyTo.hasGif ? "GIF" : replyTo.content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(ChatMessagePresentation.replyDisplayName(for: replyTo, isFromCurrentUser: isReplyFromCurrentUser))
                .font(ACMFont.trial(11, weight: .semibold))
                .foregroundStyle(isFromCurrentUser ? Color.white : ACMColors.primaryOrange)
                .lineLimit(1)

            Text(previewText)
                .font(ACMFont.trial(12))
                .foregroundStyle(isFromCurrentUser ? Color.white.opacity(0.75) : ACMColors.textMuted)
                .lineLimit(2)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .frame(maxWidth: 260, alignment: .leading)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(isFromCurrentUser ? Color.white.opacity(0.7) : ACMColors.primaryOrange)
                .frame(width: 3)
        }
        .acmColorBackground(isFromCurrentUser ? Color.black.opacity(0.16) : ACMColors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
    }
}

// MARK: - Chat Empty State

struct ChatEmptyStateView: View {
    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            
            ACMSystemIcon.icon("bubble.left", android: "chat.outline", size: 32)
                .foregroundStyle(ACMColors.textFaint)

            VStack(spacing: 8) {
                Text("No messages yet")
                    .font(ACMFont.trial(16, weight: .medium))
                    .foregroundStyle(ACMColors.text)

                Text("Start the conversation")
                    .font(ACMFont.trial(14))
                    .foregroundStyle(ACMColors.textMuted)
            }
            
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
}
