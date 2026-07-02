import SwiftUI

/// Live transcript panel. Renders speaker-grouped captions streamed from the
/// transcript worker, with start/stop controls for participants who have the
/// capability. Presented as a sheet, consistent with chat and participants.
struct TranscriptPanelView: View {
    @Bindable var viewModel: MeetingViewModel
    @Environment(\.dismiss) private var dismiss

    private var state: TranscriptState { viewModel.transcriptState }

    var body: some View {
        VStack(spacing: 0) {
            header
            controlBar
            Rectangle().fill(ACMColors.border).frame(height: 1)
            contentBody(for: state)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .acmColorBackground(ACMColors.bg)
        .onAppear {
            viewModel.openTranscriptStream()
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: ACMSpacing.sm) {
            HStack(spacing: 7) {
                Circle()
                    .fill(statusDotColor)
                    .frame(width: 8, height: 8)
                Text("Transcript")
                    .font(ACMFont.trial(18, weight: .semibold))
                    .foregroundStyle(ACMColors.text)
            }

            Spacer()

            Button {
                dismiss()
            } label: {
                Text("Done")
                    .font(ACMFont.trial(16, weight: .medium))
                    .foregroundStyle(ACMColors.primaryOrange)
                    .frame(height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Done")
        }
        .padding(.horizontal, ACMSpacing.lg)
        .padding(.top, ACMSpacing.md)
        .padding(.bottom, ACMSpacing.sm)
    }

    private var statusDotColor: Color {
        if state.isLive { return ACMColors.success }
        switch state.connectionStatus {
        case .connected: return ACMColors.textMuted
        case .connecting: return ACMColors.primaryOrange
        case .error: return ACMColors.error
        case .idle: return ACMColors.textFaint
        }
    }

    // MARK: - Controls

    @ViewBuilder
    private var controlBar: some View {
        HStack(spacing: ACMSpacing.sm) {
            if state.isLive {
                HStack(spacing: 6) {
                    Circle().fill(ACMColors.success).frame(width: 7, height: 7)
                    Text(liveLabel)
                        .font(ACMFont.trial(12, weight: .semibold))
                        .foregroundStyle(ACMColors.textMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: ACMSpacing.xs)
            } else if state.connectionStatus == .connecting || state.isBusy {
                HStack(spacing: 6) {
                    ProgressView().tint(ACMColors.primaryOrange)
                    Text(state.sessionStatus == "starting" ? "Starting transcription" : "Connecting")
                        .font(ACMFont.trial(12, weight: .medium))
                        .foregroundStyle(ACMColors.textMuted)
                }
                Spacer(minLength: ACMSpacing.xs)
            } else {
                Text(state.canStart ? "Start a live transcript for the room." : "Transcription is off.")
                    .font(ACMFont.trial(12))
                    .foregroundStyle(ACMColors.textFaint)
                Spacer(minLength: ACMSpacing.xs)
            }

            controlButton
        }
        .padding(.horizontal, ACMSpacing.lg)
        .padding(.vertical, ACMSpacing.sm)
    }

    private var liveLabel: String {
        if let controller = state.controllerName, !controller.isEmpty {
            return "Live - \(controller)"
        }
        return "Live"
    }

    @ViewBuilder
    private var controlButton: some View {
        if state.isBusy {
            EmptyView()
        } else if state.isLive {
            if state.canStop {
                Button {
                    viewModel.stopTranscription()
                } label: {
                    controlLabel("Stop", tint: ACMColors.error)
                }
                .buttonStyle(.plain)
            }
        } else if state.canStart {
            Button {
                viewModel.startTranscription()
            } label: {
                controlLabel("Start", tint: ACMColors.primaryOrange)
            }
            .buttonStyle(.plain)
        }
    }

    private func controlLabel(_ title: String, tint: Color) -> some View {
        Text(title)
            .font(ACMFont.trial(13, weight: .semibold))
            .foregroundStyle(Color.white)
            .padding(.horizontal, ACMSpacing.md)
            .frame(height: 34)
            .background(tint, in: Capsule())
    }

    // MARK: - Body

    @ViewBuilder
    private func contentBody(for state: TranscriptState) -> some View {
        if let error = state.errorMessage, state.orderedSegments.isEmpty {
            centered {
                VStack(spacing: ACMSpacing.sm) {
                    ACMSystemIcon.icon("exclamationmark.triangle.fill", android: "warning", size: 22, tint: "danger")
                        .foregroundStyle(ACMColors.error)
                    Text(error)
                        .font(ACMFont.trial(13))
                        .foregroundStyle(ACMColors.textMuted)
                        .multilineTextAlignment(.center)
                }
            }
        } else if state.orderedSegments.isEmpty {
            centered {
                Text(state.isLive ? "Listening…" : "Start transcription to see live captions here.")
                    .font(ACMFont.trial(13))
                    .foregroundStyle(ACMColors.textFaint)
                    .multilineTextAlignment(.center)
            }
        } else {
            transcriptScroll
        }
    }

    private var transcriptScroll: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: ACMSpacing.md) {
                    ForEach(state.groupedSegments) { group in
                        transcriptGroupView(group)
                    }
                    Color.clear
                        .frame(height: transcriptBottomScrollClearance)
                        .id("transcript-bottom")
                }
                .padding(.horizontal, ACMSpacing.lg)
                .padding(.top, ACMSpacing.md)
            }
            .onChange(of: state.scrollTrigger) {
                proxy.scrollTo("transcript-bottom", anchor: .bottom)
            }
        }
    }

    private var transcriptBottomScrollClearance: CGFloat {
        #if SKIP
        return ACMSpacing.xxxl * 3
        #else
        return ACMSpacing.md
        #endif
    }

    private func transcriptGroupView(_ group: TranscriptGroup) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Circle()
                    .fill(ACMColors.avatarColor(for: group.speakerUserId.isEmpty ? group.speakerDisplayName : group.speakerUserId))
                    .frame(width: 9, height: 9)
                Text(group.speakerDisplayName)
                    .font(ACMFont.trial(13, weight: .semibold))
                    .foregroundStyle(ACMColors.text)
                    .lineLimit(1)
            }

            Text(group.text)
                .font(ACMFont.trial(14))
                .foregroundStyle(group.isFinal ? ACMColors.textMuted : ACMColors.textFaint)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func centered<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack {
            Spacer(minLength: 0)
            content()
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, ACMSpacing.lg)
    }
}
