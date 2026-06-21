import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Chat Overlay

struct ChatOverlayView: View {
    @Bindable var viewModel: MeetingViewModel
    @State private var messageText = ""
    @FocusState private var isInputFocused: Bool
    private let maxChatInputLength = 1000

    private var messageTextBinding: Binding<String> {
        Binding(
            get: { messageText },
            set: { messageText = String($0.prefix(maxChatInputLength)) }
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
        #if SKIP
        return 56.0
        #else
        return 40.0
        #endif
    }

    private var mentionContext: ChatMentionContext? {
        guard !isChatDisabled, viewModel.state.isDmEnabled else { return nil }
        let value = messageText.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("@") {
            let query = String(value.dropFirst())
            guard !query.contains(where: { $0.isWhitespace }) else { return nil }
            return ChatMentionContext(mode: .at, query: query)
        }

        let lowercased = value.lowercased()
        guard lowercased == "/dm" || lowercased.hasPrefix("/dm ") else { return nil }
        let query = value.count > 3
            ? String(value.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            : ""
        guard !query.contains(where: { $0.isWhitespace }) else { return nil }
        return ChatMentionContext(mode: .dm, query: query)
    }

    private var mentionSuggestions: [ChatMentionSuggestion] {
        guard let context = mentionContext else { return [] }
        let query = context.query.lowercased()
        let normalizedQuery = ChatMentionSuggestion.normalizeToken(query)
        return viewModel.state.sortedParticipants
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
        let timeline = (viewModel.state.chatMessages.map { ChatTimelineEntry.message($0) }
            + viewModel.state.systemMessages.map { ChatTimelineEntry.system($0) })
            .sorted { $0.timestamp < $1.timestamp }
        let canSendMessage = !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isChatDisabled

        VStack(spacing: 0) {
            HStack {
                Text("Chat")
                    .font(ACMFont.trial(16, weight: .semibold))
                    .foregroundStyle(ACMColors.text)

                Spacer()

                Button {
                    viewModel.toggleChat()
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
            
            ScrollViewReader { proxy in
                ScrollView {
                    if timeline.isEmpty {
                        ChatEmptyStateView()
                    } else {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(timeline) { entry in
                                switch entry {
                                case .message(let message):
                                    let isFromCurrentUser = viewModel.state.isLocalParticipantUserId(message.userId)
                                    if let actionText = ChatMessagePresentation.actionText(from: message.content) {
                                        ChatActionMessageRow(
                                            message: message,
                                            isFromCurrentUser: isFromCurrentUser,
                                            actionText: actionText
                                        )
                                        .id(entry.id)
                                    } else {
                                        ChatBubbleView(
                                            message: message,
                                            isFromCurrentUser: isFromCurrentUser
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
                .onChange(of: timeline.count) { _, _ in
                    if let last = timeline.last {
                        withAnimation(Animation.easeOut(duration: 0.12)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }

            VStack(spacing: 10) {
                if !mentionSuggestions.isEmpty, let context = mentionContext {
                    ChatMentionSuggestionsView(
                        suggestions: mentionSuggestions,
                        onSelect: { suggestion in
                            applyMentionSuggestion(suggestion, mode: context.mode)
                        }
                    )
                } else if !commandSuggestions.isEmpty {
                    ChatCommandSuggestionsView(
                        commands: commandSuggestions,
                        onSelect: applyCommandSuggestion
                    )
                }

                HStack(spacing: 10) {
                    TextField(placeholder, text: messageTextBinding)
                        .textFieldStyle(.plain)
                        .font(ACMFont.trial(14))
                        .foregroundStyle(ACMColors.text)
                        .tint(ACMColors.primaryOrange)
                        .padding(.horizontal, 14)
                        .frame(height: inputHeight)
                        .acmColorBackground(ACMColors.bgAlt)
                        .overlay {
                            Capsule().strokeBorder(lineWidth: 1).foregroundStyle(ACMColors.border)
                        }
                        .clipShape(Capsule())
                        .focused($isInputFocused)
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
                    .disabled(!canSendMessage)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .overlay(alignment: .top) {
                Rectangle().fill(ACMColors.border).frame(height: 1)
            }
        }
        .acmColorBackground(ACMColors.surface)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.border)
        }
        .padding()
    }
    
    func sendMessage() {
        let trimmed = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isChatDisabled else { return }
        viewModel.sendChatMessage(trimmed)
        messageText = ""
    }

    private func applyCommandSuggestion(_ command: ChatCommand) {
        messageText = command.insertText
        focusInput()
    }

    private func applyMentionSuggestion(_ suggestion: ChatMentionSuggestion, mode: ChatMentionMode) {
        switch mode {
        case .at:
            messageText = "@\(suggestion.mentionToken) "
        case .dm:
            messageText = "/dm \(suggestion.mentionToken) "
        }
        focusInput()
    }

    private func focusInput() {
        isInputFocused = true
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
}

// MARK: - Chat Suggestions

private enum ChatMentionMode {
    case at
    case dm
}

private struct ChatMentionContext {
    let mode: ChatMentionMode
    let query: String
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
    let onSelect: (ChatMentionSuggestion) -> Void

    var body: some View {
        ChatSuggestionsContainer(maxHeight: 154) {
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
    let onSelect: (ChatCommand) -> Void

    var body: some View {
        ChatSuggestionsContainer(maxHeight: 190) {
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
        return userId.isEmpty ? "Guest" : userId
    }

    static func directMessageLabel(for message: ChatMessage, isFromCurrentUser: Bool) -> String? {
        guard message.isDirect else { return nil }
        if isFromCurrentUser {
            let name = message.dmTargetDisplayName ?? message.dmTargetUserId ?? "user"
            return "Private to \(name)"
        }
        return "Private message"
    }

    static func actionText(from content: String) -> String? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowercased = trimmed.lowercased()

        if lowercased.hasPrefix("/me ") {
            let text = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        }
        if lowercased.hasPrefix("/action ") {
            let text = String(trimmed.dropFirst(8)).trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        }
        if trimmed.hasPrefix("* ") {
            let text = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        }
        return nil
    }
}

struct ChatActionMessageRow: View {
    let message: ChatMessage
    let isFromCurrentUser: Bool
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

            Text(actionLine)
                .font(ACMFont.trial(12))
                .foregroundStyle(ACMColors.textMuted)
                .multilineTextAlignment(.center)
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
            }

            if let directMessageLabel {
                Text(directMessageLabel)
                    .font(ACMFont.trial(11, weight: .medium))
                    .foregroundStyle(ACMColors.handRaised)
            }

            Text(message.content)
                .font(ACMFont.trial(14))
                .foregroundStyle(isFromCurrentUser ? Color.white : ACMColors.text)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .acmColorBackground(isFromCurrentUser ? ACMColors.primaryOrange : ACMColors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                .overlay {
                    if message.isDirect {
                        RoundedRectangle(cornerRadius: ACMRadius.md)
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.handRaisedBorder)
                    }
                }
                .frame(maxWidth: 260, alignment: isFromCurrentUser ? .trailing : .leading)
        }
        .frame(maxWidth: .infinity, alignment: isFromCurrentUser ? .trailing : .leading)
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
