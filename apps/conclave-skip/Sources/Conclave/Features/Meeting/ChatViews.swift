import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Chat Overlay

struct ChatOverlayView: View {
    @Bindable var viewModel: MeetingViewModel
    @State var messageText = ""
    @FocusState var isInputFocused: Bool
    
    var body: some View {
        let isChatDisabled = viewModel.state.isChatLocked && !viewModel.state.isAdmin
        // Merge user messages and system notes (slash-command feedback) into one
        // timestamp-ordered timeline so executed commands show a confirmation.
        let timeline = (viewModel.state.chatMessages.map { ChatTimelineEntry.message($0) }
            + viewModel.state.systemMessages.map { ChatTimelineEntry.system($0) })
            .sorted { $0.timestamp < $1.timestamp }
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
                                    ChatBubbleView(
                                        message: message,
                                        isFromCurrentUser: message.userId == viewModel.state.userId
                                    )
                                    .id(entry.id)
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
            
            HStack(spacing: 10) {
                TextField(isChatDisabled ? "Chat locked by host" : "Message", text: $messageText)
                    .textFieldStyle(.plain)
                    .font(ACMFont.trial(14))
                    .foregroundStyle(ACMColors.text)
                    .tint(ACMColors.primaryOrange)
                    .padding(.horizontal, 14)
                    .frame(height: 40)
                    .acmColorBackground(ACMColors.bgAlt)
                    .overlay {
                        Capsule().strokeBorder(lineWidth: 1).foregroundStyle(ACMColors.border)
                    }
                    .clipShape(Capsule())
#if !SKIP
                    .focused($isInputFocused)
#endif
                    .submitLabel(SubmitLabel.send)
                    .onSubmit {
                        sendMessage()
                    }
                    .disabled(isChatDisabled)

                Button {
                    sendMessage()
                } label: {
                    ACMSystemIcon.icon("arrow.up", android: "send", size: 16)
                        .foregroundStyle(messageText.isEmpty ? ACMColors.textFaint : Color.white)
                        .frame(width: 40, height: 40)
                        .acmColorBackground(messageText.isEmpty ? ACMColors.surfaceRaised : ACMColors.primaryOrange)
                        .clipShape(Circle())
                }
                .disabled(messageText.isEmpty || isChatDisabled)
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
        guard !trimmed.isEmpty else { return }
        viewModel.sendChatMessage(trimmed)
        messageText = ""
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

// MARK: - Chat Bubble

struct ChatBubbleView: View {
    let message: ChatMessage
    let isFromCurrentUser: Bool
    
    var body: some View {
        VStack(alignment: isFromCurrentUser ? .trailing : .leading, spacing: 4) {
            // Metadata on a single quiet row (name is muted-neutral, not accent;
            // time shares the row instead of stamping a third line per bubble).
            HStack(spacing: 6) {
                if !isFromCurrentUser {
                    Text(message.displayName)
                        .font(ACMFont.trial(12, weight: .medium))
                        .foregroundStyle(ACMColors.textMuted)
                }
                Text(message.timestamp, style: .time)
                    .font(ACMFont.trial(11))
                    .foregroundStyle(ACMColors.textFaint)
            }

            Text(message.content)
                .font(ACMFont.trial(14))
                .foregroundStyle(isFromCurrentUser ? Color.white : ACMColors.text)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                // Received bubble is surfaceRaised so it reads against the
                // surface panel (was surface = invisible).
                .acmColorBackground(isFromCurrentUser ? ACMColors.primaryOrange : ACMColors.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
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

