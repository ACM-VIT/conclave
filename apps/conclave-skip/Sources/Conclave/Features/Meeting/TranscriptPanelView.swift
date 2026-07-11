import SwiftUI
import Observation

private enum TranscriptPanelTab: String, Identifiable {
    case transcript
    case ask
    case minutes

    var id: String { rawValue }

    var label: String {
        switch self {
        case .transcript: return "Transcript"
        case .ask: return "Ask"
        case .minutes: return "Minutes"
        }
    }

    var iosIcon: String {
        switch self {
        case .transcript: return "doc.text"
        case .ask: return "text.bubble"
        case .minutes: return "list.bullet.clipboard"
        }
    }

    var androidIcon: String {
        switch self {
        case .transcript: return "description"
        case .ask: return "chat"
        case .minutes: return "list"
        }
    }
}

@Observable
private final class TranscriptPanelNavigationState {
    var activeTab: TranscriptPanelTab = .transcript

    func select(_ tab: TranscriptPanelTab) {
        guard activeTab != tab else { return }
        activeTab = tab
    }
}

/// Native sibling of the web transcript panel. The root observes only session
/// lifecycle; transcript deltas, Q&A streaming, and minutes updates are read by
/// separate leaf views so SkipUI does not rebuild the controls on every token.
struct TranscriptPanelView: View {
    @Bindable var viewModel: MeetingViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var navigation = TranscriptPanelNavigationState()
    @State private var copyState = 0

    private var state: TranscriptState { viewModel.transcriptState }

    var body: some View {
        VStack(spacing: 0) {
            TranscriptPanelHeader(
                state: state,
                navigation: navigation,
                onClose: { dismiss() }
            )

            panelDivider
            TranscriptErrorBanner(state: state)

            if state.isRunning {
                TranscriptRunningPanel(
                    state: state,
                    navigation: navigation,
                    copyState: copyState,
                    onPause: { viewModel.pauseTranscription() },
                    onResume: { viewModel.resumeTranscription() },
                    onStop: { viewModel.stopTranscription() },
                    onAsk: { question in viewModel.askTranscript(question) },
                    onRefreshMinutes: { viewModel.refreshTranscriptMinutes() },
                    onCopy: { copyTranscript() },
                    onShare: { shareTranscript() }
                )
            } else {
                TranscriptStartStage(
                    state: state,
                    onStart: { options in
                        viewModel.startTranscription(options: options)
                    }
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .acmColorBackground(ACMColors.surface)
        .onAppear {
            viewModel.openTranscriptStream()
        }
        .onChange(of: state.canAsk ? "ask-enabled" : "ask-disabled") {
            if !state.canAsk && navigation.activeTab == .ask {
                navigation.select(.transcript)
            }
        }
        .onChange(of: state.sessionStatus) {
            if !state.isRunning {
                navigation.select(.transcript)
            }
        }
    }

    private var panelDivider: some View {
        Rectangle()
            .fill(ACMColors.borderSubtle)
            .frame(height: 1)
    }

    private func transcriptMarkdown() -> String {
        TranscriptPresentationPolicy.exportMarkdown(
            roomId: viewModel.state.roomId,
            segments: state.orderedSegments,
            minutes: state.minutes
        )
    }

    private func copyTranscript() {
        guard state.hasExportContent else { return }
        let markdown = transcriptMarkdown()
        #if SKIP
        ClipboardHelper.copyToClipboard(text: markdown, label: "Transcript")
        #elseif canImport(UIKit)
        UIPasteboard.general.string = markdown
        HapticManager.shared.trigger(.success)
        #endif
        copyState = 1
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(1_400_000_000))
            copyState = 0
        }
    }

    private func shareTranscript() {
        guard state.hasExportContent else { return }
        _ = MeetingShare.shareText(
            transcriptMarkdown(),
            title: "Conclave transcript"
        )
    }
}

// MARK: - Header

private struct TranscriptPanelHeader: View {
    @Bindable var state: TranscriptState
    @Bindable var navigation: TranscriptPanelNavigationState
    let onClose: () -> Void

    private static let fullTabs: [TranscriptPanelTab] = [.transcript, .ask, .minutes]
    private static let viewOnlyTabs: [TranscriptPanelTab] = [.transcript, .minutes]

    private var tabs: [TranscriptPanelTab] {
        state.canAsk ? Self.fullTabs : Self.viewOnlyTabs
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: ACMSpacing.sm) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text("Transcript")
                            .font(ACMFont.trial(15, weight: .semibold))
                            .foregroundStyle(ACMColors.text)

                        Text("BETA")
                            .font(ACMFont.trial(9.5, weight: .semibold))
                            .foregroundStyle(ACMColors.primaryOrange)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2.5)
                            .acmColorBackground(ACMColors.primaryOrange.opacity(0.10))
                            .overlay {
                                RoundedRectangle(cornerRadius: 6)
                                    .strokeBorder(ACMColors.primaryOrange.opacity(0.30), lineWidth: 1)
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }

                    if state.isRunning, let controller = state.controllerName, !controller.isEmpty {
                        Text("Hosted by \(controller)")
                            .font(ACMFont.trial(11.5))
                            .foregroundStyle(ACMColors.textMuted)
                            .lineLimit(1)
                    } else if state.capabilitiesKnown && !state.canStart && !state.canTakeover {
                        Text("View only")
                            .font(ACMFont.trial(11.5))
                            .foregroundStyle(ACMColors.textMuted)
                    }
                }

                Spacer(minLength: 0)

                Button(action: onClose) {
                    ACMSystemIcon.icon("xmark", android: "close", size: 17, tint: "muted")
                        .foregroundStyle(ACMColors.textMuted)
                        .frame(width: 34, height: 34)
                        .acmColorBackground(ACMColors.subtleFill)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close transcript")
            }

            if state.isRunning {
                HStack(spacing: 8) {
                    ForEach(tabs) { tab in
                        Button {
                            navigation.select(tab)
                        } label: {
                            HStack(spacing: 6) {
                                ACMSystemIcon.icon(
                                    tab.iosIcon,
                                    android: tab.androidIcon,
                                    size: 13,
                                    tint: navigation.activeTab == tab ? "text" : "muted"
                                )
                                .foregroundStyle(navigation.activeTab == tab ? ACMColors.text : ACMColors.textMuted)

                                Text(tab.label)
                                    .font(ACMFont.trial(12, weight: .semibold))
                                    .foregroundStyle(navigation.activeTab == tab ? ACMColors.text : ACMColors.textMuted)
                                    .lineLimit(1)
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: 32)
                            .acmColorBackground(navigation.activeTab == tab ? ACMColors.subtleFillHover : Color.clear)
                            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Show \(tab.label.lowercased())")
                    }
                }
                .padding(.top, 10)
            }
        }
        .padding(.horizontal, ACMSpacing.md)
        .padding(.top, ACMSpacing.sm)
        .padding(.bottom, ACMSpacing.sm)
    }
}

private struct TranscriptErrorBanner: View {
    @Bindable var state: TranscriptState

    @ViewBuilder
    var body: some View {
        if let message = state.errorMessage, !message.isEmpty {
            HStack(alignment: .top, spacing: 8) {
                ACMSystemIcon.icon("exclamationmark.triangle.fill", android: "warning", size: 12, tint: "error")
                    .foregroundStyle(ACMColors.error)
                    .padding(.top, 1)
                Text(message)
                    .font(ACMFont.trial(12))
                    .foregroundStyle(acmColor(red: 255.0, green: 180.0, blue: 173.0))
                    .lineSpacing(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, ACMSpacing.md)
            .padding(.vertical, 9)
            .acmColorBackground(ACMColors.error.opacity(0.10))
            .overlay(alignment: .bottom) {
                Rectangle().fill(ACMColors.error.opacity(0.20)).frame(height: 1)
            }
        }
    }
}

// MARK: - Running session

private struct TranscriptRunningPanel: View {
    @Bindable var state: TranscriptState
    @Bindable var navigation: TranscriptPanelNavigationState
    let copyState: Int
    let onPause: () -> Void
    let onResume: () -> Void
    let onStop: () -> Void
    let onAsk: (String) -> Bool
    let onRefreshMinutes: () -> Void
    let onCopy: () -> Void
    let onShare: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            TranscriptStatusBar(
                state: state,
                onPause: onPause,
                onResume: onResume,
                onStop: onStop
            )
            .frame(height: 44)

            Rectangle().fill(ACMColors.borderSubtle).frame(height: 1)

            activeContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            TranscriptExportBar(
                state: state,
                copyState: copyState,
                onCopy: onCopy,
                onShare: onShare
            )
            .frame(height: 62)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var activeContent: some View {
        switch navigation.activeTab {
        case .transcript:
            TranscriptCaptionsTab(state: state)
        case .ask:
            TranscriptAskTab(state: state, onAsk: onAsk)
        case .minutes:
            TranscriptMinutesTab(state: state, onRefresh: onRefreshMinutes)
        }
    }
}

private struct TranscriptStatusBar: View {
    @Bindable var state: TranscriptState
    let onPause: () -> Void
    let onResume: () -> Void
    let onStop: () -> Void

    var body: some View {
        HStack(spacing: ACMSpacing.sm) {
            HStack(spacing: 7) {
                if state.sessionStatus == "paused" {
                    Circle().fill(ACMColors.handRaised).frame(width: 7, height: 7)
                } else if state.isLive {
                    Circle().fill(ACMColors.success).frame(width: 7, height: 7)
                } else {
                    ProgressView()
                        .tint(ACMColors.textMuted)
                        .scaleEffect(0.7)
                }

                Text(statusLabel)
                    .font(ACMFont.trial(11.5))
                    .foregroundStyle(ACMColors.textMuted)
                    .lineLimit(1)
            }

            Spacer(minLength: ACMSpacing.xs)

            if state.canPause {
                Button {
                    if state.sessionStatus == "paused" {
                        onResume()
                    } else {
                        onPause()
                    }
                } label: {
                    HStack(spacing: 5) {
                        ACMSystemIcon.icon(
                            state.sessionStatus == "paused" ? "play.fill" : "pause.fill",
                            android: state.sessionStatus == "paused" ? "play" : "pause",
                            size: 12,
                            tint: state.sessionStatus == "paused" ? "amber" : "muted"
                        )
                        .foregroundStyle(state.sessionStatus == "paused" ? ACMColors.handRaised : ACMColors.textMuted)
                        Text(state.sessionStatus == "paused" ? "Resume" : "Pause")
                            .font(ACMFont.trial(11.5, weight: .semibold))
                            .foregroundStyle(state.sessionStatus == "paused" ? ACMColors.handRaised : ACMColors.textMuted)
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 28)
                    .acmColorBackground(state.sessionStatus == "paused" ? ACMColors.handRaised.opacity(0.12) : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
                .buttonStyle(.plain)
            }

            if state.canStop {
                Button(action: onStop) {
                    HStack(spacing: 5) {
                        ACMSystemIcon.icon("stop.fill", android: "stop", size: 10, tint: "error")
                        Text("Stop")
                            .font(ACMFont.trial(11.5, weight: .semibold))
                    }
                    .foregroundStyle(acmColor(red: 255.0, green: 180.0, blue: 173.0))
                    .padding(.horizontal, 9)
                    .frame(height: 28)
                    .acmColorBackground(ACMColors.error.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop transcript")
            }
        }
        .padding(.horizontal, ACMSpacing.md)
    }

    private var statusLabel: String {
        if state.sessionStatus == "paused" { return "Paused" }
        if !state.isLive { return "Connecting" }
        return state.canStop ? "Listening to the room" : "Following live"
    }
}

// MARK: - Transcript tab

private struct TranscriptCaptionsTab: View {
    @Bindable var state: TranscriptState

    @ViewBuilder
    var body: some View {
        if state.groupedSegments.isEmpty {
            ListeningFallbackView()
        } else {
            transcriptScroll
        }
    }

    private var transcriptScroll: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
                    ForEach(state.groupedSegments) { group in
                        if state.pauseMarkerIds.contains(group.id) {
                            pauseMarker(group.firstStartMs)
                        }
                        TranscriptGroupCard(group: group)
                    }
                    Color.clear
                        .frame(height: ACMSpacing.xl)
                        .id("transcript-bottom")
                }
                .padding(.horizontal, ACMSpacing.md)
                .padding(.top, ACMSpacing.md)
            }
            .onChange(of: state.scrollTrigger) {
                proxy.scrollTo("transcript-bottom", anchor: .bottom)
            }
        }
    }

    private func pauseMarker(_ startMs: Double) -> some View {
        HStack(spacing: 10) {
            Rectangle().fill(ACMColors.borderSubtle).frame(height: 1)
            Text(TranscriptPresentationPolicy.clockTimestamp(fromMs: startMs))
                .font(ACMFont.trial(10))
                .foregroundStyle(ACMColors.textFaint)
            Rectangle().fill(ACMColors.borderSubtle).frame(height: 1)
        }
        .padding(.horizontal, 2)
    }
}

private struct ListeningFallbackView: View {
    private static let barHeights: [CGFloat] = [8.0, 14.0, 20.0, 12.0, 22.0, 16.0, 10.0, 18.0, 22.0, 13.0, 8.0]
    private let liveAccent = acmColor(red: 79.0, green: 156.0, blue: 249.0)

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .bottom, spacing: 3) {
                ForEach(Array(Self.barHeights.enumerated()), id: \.offset) { _, height in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(liveAccent.opacity(0.8))
                        .frame(width: 2.5, height: height)
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 14)
            .acmColorBackground(liveAccent.opacity(0.06))
            .overlay {
                Capsule().strokeBorder(liveAccent.opacity(0.20), lineWidth: 1)
            }
            .clipShape(Capsule())

            Text("Listening for the room")
                .font(ACMFont.trial(15, weight: .semibold))
                .foregroundStyle(ACMColors.text)
                .padding(.top, 18)

            Text("As people speak, their words appear here live, captioned for everyone.")
                .font(ACMFont.trial(12.5))
                .foregroundStyle(ACMColors.textMuted)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .padding(.top, 6)
                .frame(maxWidth: 270)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.horizontal, ACMSpacing.xl)
        .padding(.top, ACMSpacing.xxxl)
    }
}

private struct TranscriptGroupCard: View {
    let group: TranscriptGroup
    private let liveAccent = acmColor(red: 79.0, green: 156.0, blue: 249.0)

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(group.speakerDisplayName)
                    .font(ACMFont.trial(12, weight: .semibold))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text(TranscriptPresentationPolicy.clockTimestamp(fromMs: group.firstStartMs))
                    .font(ACMFont.trial(10.5))
                    .foregroundStyle(ACMColors.textFaint)
            }

            HStack(alignment: .bottom, spacing: 5) {
                Text(group.text)
                    .font(ACMFont.trial(13.5))
                    .foregroundStyle(group.isFinal ? ACMColors.text : ACMColors.textMuted)
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !group.isFinal {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(liveAccent.opacity(0.8))
                        .frame(width: 2, height: 12)
                        .padding(.bottom, 2)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .acmColorBackground(group.isFinal ? ACMColors.subtleFill : liveAccent.opacity(0.06))
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md)
                    .strokeBorder(group.isFinal ? ACMColors.borderSubtle : liveAccent.opacity(0.35), lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Ask tab

private struct TranscriptAskTab: View {
    @Bindable var state: TranscriptState
    let onAsk: (String) -> Bool
    @State private var question = ""

    var body: some View {
        VStack(spacing: 0) {
            if state.qaMessages.isEmpty {
                TranscriptAskEmptyState(onSuggestion: { suggestion in
                    question = suggestion
                })
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: ACMSpacing.sm) {
                            ForEach(state.qaMessages) { message in
                                TranscriptQAMessageRow(message: message)
                            }
                            Color.clear.frame(height: 8).id("qa-bottom")
                        }
                        .padding(.horizontal, ACMSpacing.md)
                        .padding(.vertical, ACMSpacing.md)
                    }
                    .onChange(of: qaScrollTrigger) {
                        proxy.scrollTo("qa-bottom", anchor: .bottom)
                    }
                }
            }

            HStack(spacing: 8) {
                TextField(
                    "",
                    text: $question,
                    prompt: Text("Ask about this meeting").foregroundStyle(ACMColors.textFaint)
                )
#if !SKIP
#if os(iOS)
                .textInputAutocapitalization(.sentences)
#endif
#endif
                .submitLabel(SubmitLabel.send)
                .onSubmit { submit() }
                .font(ACMFont.trial(13))
                .foregroundStyle(ACMColors.text)
                .tint(ACMColors.primaryOrange)
                .padding(.horizontal, 12)
                .frame(height: 40)
                .acmColorBackground(ACMColors.fieldBackground)
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.md)
                        .strokeBorder(ACMColors.borderSubtle, lineWidth: 1)
                }
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))

                Button(action: submit) {
                    ACMSystemIcon.icon("arrow.up", android: "send", size: 15, tint: canSend ? "text" : "faint")
                        .foregroundStyle(canSend ? ACMColors.white : ACMColors.textFaint)
                        .frame(width: 40, height: 40)
                        .acmColorBackground(canSend ? ACMColors.primaryOrange : ACMColors.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel("Ask about the transcript")
            }
            .padding(.horizontal, ACMSpacing.md)
            .padding(.vertical, 10)
            .overlay(alignment: .top) {
                Rectangle().fill(ACMColors.borderSubtle).frame(height: 1)
            }
        }
    }

    private var trimmedQuestion: String {
        question.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSend: Bool {
        !trimmedQuestion.isEmpty && state.canAsk && state.connectionStatus == .connected
    }

    private var qaScrollTrigger: String {
        guard let last = state.qaMessages.last else { return "0" }
        return "\(state.qaMessages.count)-\(last.id)-\(last.content.count)-\(last.status.rawValue)"
    }

    private func submit() {
        let next = trimmedQuestion
        guard !next.isEmpty, onAsk(next) else { return }
        question = ""
    }
}

private struct TranscriptAskEmptyState: View {
    let onSuggestion: (String) -> Void
    private static let suggestions = [
        "What decisions have we made?",
        "Summarize the discussion",
        "What are the action items?"
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ACMSystemIcon.icon("text.bubble", android: "chat", size: 23, tint: "muted")
                    .foregroundStyle(ACMColors.textMuted)
                    .frame(width: 48, height: 48)
                    .acmColorBackground(ACMColors.subtleFill)
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))

                Text("Ask the meeting")
                    .font(ACMFont.trial(15, weight: .semibold))
                    .foregroundStyle(ACMColors.text)
                    .padding(.top, 16)

                Text("Get answers grounded in what people actually said.")
                    .font(ACMFont.trial(12.5))
                    .foregroundStyle(ACMColors.textMuted)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                    .frame(maxWidth: 260)
                    .padding(.top, 6)

                VStack(spacing: 8) {
                    ForEach(Self.suggestions, id: \.self) { suggestion in
                        Button {
                            onSuggestion(suggestion)
                        } label: {
                            Text(suggestion)
                                .font(ACMFont.trial(12))
                                .foregroundStyle(ACMColors.textMuted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12)
                                .frame(height: 38)
                                .acmColorBackground(ACMColors.subtleFill)
                                .overlay {
                                    RoundedRectangle(cornerRadius: ACMRadius.md)
                                        .strokeBorder(ACMColors.borderSubtle, lineWidth: 1)
                                }
                                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(maxWidth: 300)
                .padding(.top, 20)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, ACMSpacing.xl)
            .padding(.top, ACMSpacing.xxxl)
            .padding(.bottom, ACMSpacing.xl)
        }
    }
}

private struct TranscriptQAMessageRow: View {
    let message: TranscriptQAMessageModel

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if message.role == .user {
                Spacer(minLength: 44)
            }

            VStack(alignment: .leading, spacing: 6) {
                if message.status == .streaming && message.content.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView().tint(ACMColors.textMuted).scaleEffect(0.75)
                        NativeTextShimmer(
                            text: "Thinking",
                            font: ACMFont.trial(12),
                            duration: 2.0,
                            spread: 2.0
                        )
                    }
                } else if message.status == .error {
                    Text(message.error ?? "Conclave could not answer right now.")
                        .font(ACMFont.trial(12.5))
                        .foregroundStyle(acmColor(red: 255.0, green: 180.0, blue: 173.0))
                } else if message.role == .assistant {
                    NativeStreamingMarkdownView(
                        markdown: message.content,
                        isStreaming: message.status == .streaming,
                        fontSize: 13,
                        blockSpacing: 7
                    )
                } else {
                    Text(message.content)
                        .font(ACMFont.trial(13))
                        .foregroundStyle(message.role == .user ? ACMColors.white : ACMColors.text)
                        .lineSpacing(3)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .acmColorBackground(message.role == .user ? ACMColors.primaryOrange : ACMColors.subtleFill)
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md)
                    .strokeBorder(message.role == .user ? Color.clear : ACMColors.borderSubtle, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))

            if message.role == .assistant {
                Spacer(minLength: 44)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Minutes tab

private struct TranscriptMinutesTab: View {
    @Bindable var state: TranscriptState
    let onRefresh: () -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
                HStack(spacing: 8) {
                    if state.minutesStatus == .pending || state.minutesStatus == .generating {
                        ProgressView().tint(ACMColors.textMuted).scaleEffect(0.7)
                        NativeTextShimmer(
                            text: "Updating minutes",
                            font: ACMFont.trial(11.5),
                            duration: 2.0,
                            spread: 2.0
                        )
                    } else {
                        Circle().fill(ACMColors.success).frame(width: 6, height: 6)
                        Text(state.minutes.updatedAt > 0 ? "Minutes are up to date" : "Minutes build automatically")
                            .font(ACMFont.trial(11.5))
                            .foregroundStyle(ACMColors.textMuted)
                    }

                    Spacer(minLength: 0)

                    if state.canAsk {
                        Button(action: onRefresh) {
                            ACMSystemIcon.icon("arrow.clockwise", android: "refresh", size: 13, tint: "muted")
                                .foregroundStyle(ACMColors.textMuted)
                                .frame(width: 30, height: 30)
                                .acmColorBackground(ACMColors.subtleFill)
                                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Refresh minutes")
                    }
                }

                if state.minutes.hasContent {
                    if !state.minutes.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        TranscriptSummarySection(summary: state.minutes.summary)
                    }
                    TranscriptMinutesSection(title: "Topics", iosIcon: "tag", androidIcon: "list", entries: state.minutes.topics)
                    TranscriptMinutesSection(title: "Decisions", iosIcon: "checkmark.circle", androidIcon: "check", entries: state.minutes.decisions)
                    TranscriptMinutesSection(title: "Action items", iosIcon: "checklist", androidIcon: "list", entries: state.minutes.actionItems)
                    TranscriptMinutesSection(title: "Open questions", iosIcon: "questionmark.circle", androidIcon: "info", entries: state.minutes.openQuestions)
                    TranscriptMinutesSection(title: "Follow-ups", iosIcon: "arrow.turn.up.right", androidIcon: "arrow.forward", entries: state.minutes.followUps)
                } else {
                    TranscriptMinutesEmptyState()
                }

                Color.clear.frame(height: ACMSpacing.xl)
            }
            .padding(.horizontal, ACMSpacing.md)
            .padding(.top, ACMSpacing.md)
        }
    }
}

private struct TranscriptSummarySection: View {
    let summary: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Summary")
                .font(ACMFont.trial(12, weight: .semibold))
                .foregroundStyle(ACMColors.text)
            Text(summary)
                .font(ACMFont.trial(13))
                .foregroundStyle(ACMColors.textMuted)
                .lineSpacing(3)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .acmColorBackground(ACMColors.subtleFill)
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.md)
                .strokeBorder(ACMColors.borderSubtle, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
    }
}

private struct TranscriptMinutesSection: View {
    let title: String
    let iosIcon: String
    let androidIcon: String
    let entries: [TranscriptMinutesEntryModel]

    @ViewBuilder
    var body: some View {
        if !entries.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 7) {
                    ACMSystemIcon.icon(iosIcon, android: androidIcon, size: 13, tint: "muted")
                        .foregroundStyle(ACMColors.textMuted)
                    Text(title)
                        .font(ACMFont.trial(12, weight: .semibold))
                        .foregroundStyle(ACMColors.text)
                }

                ForEach(entries) { entry in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.text)
                            .font(ACMFont.trial(12.5))
                            .foregroundStyle(ACMColors.textMuted)
                            .lineSpacing(2)

                        if let owner = entry.owner, !owner.isEmpty {
                            Text(entry.due?.isEmpty == false ? "\(owner) · \(entry.due ?? "")" : owner)
                                .font(ACMFont.trial(10.5, weight: .medium))
                                .foregroundStyle(ACMColors.textFaint)
                        } else if let due = entry.due, !due.isEmpty {
                            Text(due)
                                .font(ACMFont.trial(10.5, weight: .medium))
                                .foregroundStyle(ACMColors.textFaint)
                        }
                    }
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(ACMColors.borderSubtle).frame(width: 2)
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .acmColorBackground(ACMColors.subtleFill)
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md)
                    .strokeBorder(ACMColors.borderSubtle, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        }
    }
}

private struct TranscriptMinutesEmptyState: View {
    var body: some View {
        VStack(spacing: 0) {
            ACMSystemIcon.icon("list.bullet.clipboard", android: "list", size: 23, tint: "muted")
                .foregroundStyle(ACMColors.textMuted)
                .frame(width: 48, height: 48)
                .acmColorBackground(ACMColors.subtleFill)
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))

            Text("Minutes are taking shape")
                .font(ACMFont.trial(15, weight: .semibold))
                .foregroundStyle(ACMColors.text)
                .padding(.top, 16)

            Text("Topics, decisions, and action items appear here as the conversation develops.")
                .font(ACMFont.trial(12.5))
                .foregroundStyle(ACMColors.textMuted)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .frame(maxWidth: 270)
                .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, ACMSpacing.xxxl)
    }
}

// MARK: - Export bar

private struct TranscriptExportBar: View {
    @Bindable var state: TranscriptState
    let copyState: Int
    let onCopy: () -> Void
    let onShare: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            exportButton(
                title: copyState == 1 ? "Copied" : "Copy",
                iosIcon: copyState == 1 ? "checkmark" : "doc.on.doc",
                androidIcon: copyState == 1 ? "check" : "copy",
                action: onCopy
            )
            exportButton(
                title: "Share",
                iosIcon: "square.and.arrow.up",
                androidIcon: "share",
                action: onShare
            )
        }
        .padding(.horizontal, ACMSpacing.sm)
        .overlay(alignment: .top) {
            Rectangle().fill(ACMColors.borderSubtle).frame(height: 1)
        }
        .acmColorBackground(ACMColors.surface)
    }

    private func exportButton(
        title: String,
        iosIcon: String,
        androidIcon: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                ACMSystemIcon.icon(iosIcon, android: androidIcon, size: 13, tint: state.hasExportContent ? "muted" : "faint")
                    .foregroundStyle(state.hasExportContent ? ACMColors.textMuted : ACMColors.textFaint)
                Text(title)
                    .font(ACMFont.trial(12, weight: .semibold))
                    .foregroundStyle(state.hasExportContent ? ACMColors.textMuted : ACMColors.textFaint)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 36)
            .acmColorBackground(state.hasExportContent ? ACMColors.subtleFill : ACMColors.fieldBackground)
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.sm)
                    .strokeBorder(ACMColors.borderSubtle, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
        }
        .buttonStyle(.plain)
        .disabled(!state.hasExportContent)
    }
}

// MARK: - Start stage

private struct TranscriptStartStage: View {
    @Bindable var state: TranscriptState
    let onStart: (TranscriptStartOptions) -> Void
    @State private var provider: TranscriptProvider
    @State private var assistantModel: String
    @State private var apiKey = ""
    @State private var assistantApiKey = ""
    @State private var didEditConfiguration = false

    private let liveAccent = acmColor(red: 79.0, green: 156.0, blue: 249.0)

    init(state: TranscriptState, onStart: @escaping (TranscriptStartOptions) -> Void) {
        self.state = state
        self.onStart = onStart
        _provider = State(initialValue: TranscriptConfiguration.provider(for: state.sessionTranscriptModel))
        _assistantModel = State(initialValue: TranscriptConfiguration.normalizedAssistantModel(state.sessionQaModel))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Text("Live notes")
                    .font(ACMFont.trial(13, weight: .medium))
                    .foregroundStyle(liveAccent)

                Text(needsTakeover ? "Pick up the live notes" : "Turn on live notes")
                    .font(ACMFont.trial(25, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .multilineTextAlignment(.center)
                    .padding(.top, 10)

                Text(startBlurb)
                    .font(ACMFont.trial(13.5))
                    .foregroundStyle(ACMColors.textMuted)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                    .padding(.top, 12)
                    .frame(maxWidth: 300)

                if !state.capabilitiesKnown {
                    HStack(spacing: 8) {
                        ProgressView().tint(ACMColors.textMuted).scaleEffect(0.75)
                        Text("Loading transcript controls")
                            .font(ACMFont.trial(12.5))
                            .foregroundStyle(ACMColors.textMuted)
                    }
                    .padding(.top, 28)
                } else if isViewOnly {
                    HStack(spacing: 8) {
                        ACMSystemIcon.icon("lock.fill", android: "lock", size: 13, tint: "accent")
                            .foregroundStyle(ACMColors.primaryOrange)
                        Text("View only")
                            .font(ACMFont.trial(12.5, weight: .semibold))
                            .foregroundStyle(ACMColors.text)
                    }
                    .padding(.horizontal, 14)
                    .frame(height: 40)
                    .acmColorBackground(ACMColors.subtleFill)
                    .overlay {
                        RoundedRectangle(cornerRadius: ACMRadius.md)
                            .strokeBorder(ACMColors.borderSubtle, lineWidth: 1)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                    .padding(.top, 28)
                } else {
                    configurationForm
                        .padding(.top, 26)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, ACMSpacing.lg)
            .padding(.top, ACMSpacing.xxl)
            .padding(.bottom, ACMSpacing.xxl)
        }
        .onChange(of: "\(state.sessionTranscriptModel)|\(state.sessionQaModel)") {
            guard !didEditConfiguration else { return }
            provider = TranscriptConfiguration.provider(for: state.sessionTranscriptModel)
            assistantModel = TranscriptConfiguration.normalizedAssistantModel(state.sessionQaModel)
        }
    }

    private var configurationForm: some View {
        VStack(alignment: .leading, spacing: ACMSpacing.sm) {
            configurationLabel("Provider")
            HStack(spacing: 4) {
                ForEach(TranscriptConfiguration.providers) { option in
                    Button {
                        provider = option
                        didEditConfiguration = true
                    } label: {
                        Text(option.label)
                            .font(ACMFont.trial(12, weight: .semibold))
                            .foregroundStyle(provider == option ? ACMColors.white : ACMColors.textMuted)
                            .frame(maxWidth: .infinity)
                            .frame(height: 32)
                            .acmColorBackground(provider == option ? ACMColors.primaryOrange : Color.clear)
                            .clipShape(RoundedRectangle(cornerRadius: 7))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(4)
            .acmColorBackground(ACMColors.fieldBackground)
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md)
                    .strokeBorder(ACMColors.borderSubtle, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))

            configurationLabel("Assistant")
                .padding(.top, 2)
            HStack(spacing: 4) {
                ForEach(TranscriptConfiguration.assistantModels) { model in
                    Button {
                        assistantModel = model.id
                        didEditConfiguration = true
                    } label: {
                        Text(model.shortLabel)
                            .font(ACMFont.trial(11.5, weight: .semibold))
                            .foregroundStyle(assistantModel == model.id ? ACMColors.text : ACMColors.textMuted)
                            .frame(maxWidth: .infinity)
                            .frame(height: 32)
                            .acmColorBackground(assistantModel == model.id ? ACMColors.subtleFillHover : Color.clear)
                            .clipShape(RoundedRectangle(cornerRadius: 7))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(model.label)
                }
            }
            .padding(4)
            .acmColorBackground(ACMColors.fieldBackground)
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md)
                    .strokeBorder(ACMColors.borderSubtle, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))

            if let providerCovered = state.globalKeyAvailable(for: provider) {
                if !providerCovered {
                    transcriptKeyField
                }
                if needsAssistantKey {
                    assistantKeyField
                }

                Button {
                    onStart(TranscriptStartOptions(
                        apiKey: apiKey,
                        assistantApiKey: assistantApiKey,
                        transcriptModel: provider.transcriptModel,
                        qaModel: assistantModel
                    ))
                } label: {
                    HStack(spacing: 8) {
                        if state.isBusy {
                            ProgressView().tint(ACMColors.white).scaleEffect(0.8)
                        }
                        Text(startCTA)
                            .font(ACMFont.trial(13.5, weight: .semibold))
                            .foregroundStyle(canSubmit ? ACMColors.white : ACMColors.textFaint)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                    .acmColorBackground(canSubmit ? ACMColors.primaryOrange : ACMColors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity)
                .disabled(!canSubmit)
                .accessibilityLabel(startCTA)

                coverageCaption
            } else {
                HStack(spacing: 7) {
                    ProgressView().tint(ACMColors.textMuted).scaleEffect(0.7)
                    Text("Checking key coverage")
                        .font(ACMFont.trial(11))
                        .foregroundStyle(ACMColors.textFaint)
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: 320)
    }

    private func configurationLabel(_ title: String) -> some View {
        Text(title)
            .font(ACMFont.trial(11))
            .foregroundStyle(ACMColors.textMuted)
            .padding(.horizontal, 2)
    }

    private var transcriptKeyField: some View {
        SecureField(
            "",
            text: $apiKey,
            prompt: Text("\(provider.label) API key").foregroundStyle(ACMColors.textFaint)
        )
#if !SKIP
#if os(iOS)
        .textInputAutocapitalization(.never)
#endif
        .autocorrectionDisabled(true)
#endif
        .font(ACMFont.trial(12.5))
        .foregroundStyle(ACMColors.text)
        .padding(.horizontal, 12)
        .frame(height: 42)
        .acmColorBackground(ACMColors.fieldBackground)
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.md)
                .strokeBorder(ACMColors.borderSubtle, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
    }

    private var assistantKeyField: some View {
        SecureField(
            "",
            text: $assistantApiKey,
            prompt: Text("OpenAI key for Ask and Minutes").foregroundStyle(ACMColors.textFaint)
        )
#if !SKIP
#if os(iOS)
        .textInputAutocapitalization(.never)
#endif
        .autocorrectionDisabled(true)
#endif
        .font(ACMFont.trial(12.5))
        .foregroundStyle(ACMColors.text)
        .padding(.horizontal, 12)
        .frame(height: 42)
        .acmColorBackground(ACMColors.fieldBackground)
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.md)
                .strokeBorder(ACMColors.borderSubtle, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
    }

    private var coverageCaption: some View {
        HStack(alignment: .top, spacing: 6) {
            ACMSystemIcon.icon(
                isOnTheHouse ? "checkmark.circle" : "lock.fill",
                android: isOnTheHouse ? "check" : "lock",
                size: 11,
                tint: "faint"
            )
            .foregroundStyle(ACMColors.textFaint)
            Text(coverageText)
                .font(ACMFont.trial(11))
                .foregroundStyle(ACMColors.textFaint)
                .multilineTextAlignment(.center)
                .lineSpacing(2)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.horizontal, 4)
    }

    private var needsTakeover: Bool { state.sessionStatus == "takeover_needed" }
    private var isViewOnly: Bool { !state.canStart && !state.canTakeover }
    private var providerCovered: Bool { state.globalKeyAvailable(for: provider) == true }
    private var assistantCovered: Bool { state.globalKeyAvailable(for: .openAI) == true }
    private var needsAssistantKey: Bool { provider == .sarvam && !assistantCovered }
    private var isOnTheHouse: Bool { providerCovered && (provider == .openAI || assistantCovered) }

    private var hasRequiredKeys: Bool {
        (providerCovered || !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) &&
            (!needsAssistantKey || !assistantApiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private var canSubmit: Bool {
        let permitted = needsTakeover ? state.canTakeover : state.canStart
        return permitted && hasRequiredKeys && !state.isBusy
    }

    private var startBlurb: String {
        if isViewOnly && state.capabilitiesKnown {
            return "Follow the live transcript and minutes once someone with controls turns them on."
        }
        if needsTakeover {
            return "The last host stepped away. Resume the transcript, questions, and meeting minutes."
        }
        return "Transcribe the room, ask it questions, and get minutes as the meeting happens."
    }

    private var startCTA: String {
        if state.isBusy { return "Starting" }
        return needsTakeover ? "Resume notes" : "Start notes"
    }

    private var coverageText: String {
        if isOnTheHouse { return "Covered by Conclave. No key needed." }
        if providerCovered && needsAssistantKey {
            return "Sarvam is covered. Add an OpenAI key for Ask and Minutes."
        }
        return "Keys are used only for this session and are never stored."
    }
}
