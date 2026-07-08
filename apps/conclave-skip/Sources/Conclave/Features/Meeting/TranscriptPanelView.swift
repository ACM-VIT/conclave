import SwiftUI

/// Live transcript panel, matching the web `TranscriptPanel`: a start-stage
/// hero when nothing is running, then a status row + speaker-grouped caption
/// cards with live tinting, pause markers, and copy/export. Ask/Minutes tabs
/// are web-only until the native worker client speaks those message types.
struct TranscriptPanelView: View {
    @Bindable var viewModel: MeetingViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var copyState = 0  // 0 idle, 1 copied

    private var state: TranscriptState { viewModel.transcriptState }

    /// Calm blue used by the web transcript for "live" affordances - a
    /// functional state color (like success green), not a second brand accent.
    private var liveAccent: Color { acmColor(red: 79.0, green: 156.0, blue: 249.0) }

    private var isRunning: Bool {
        state.sessionStatus == "starting" ||
            state.sessionStatus == "live" ||
            state.sessionStatus == "paused" ||
            state.sessionStatus == "stopping"
    }

    private var needsTakeover: Bool { state.sessionStatus == "takeover_needed" }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(ACMColors.border).frame(height: 1)

            if let error = state.errorMessage {
                errorBanner(error)
            }

            if isRunning {
                statusRow
                Rectangle().fill(ACMColors.border).frame(height: 1)
                contentBody
                if !state.orderedSegments.isEmpty {
                    footer
                }
            } else {
                StartStageView(
                    canStart: state.canStart,
                    needsTakeover: needsTakeover,
                    isBusy: state.isBusy,
                    accent: liveAccent,
                    onStart: { viewModel.startTranscription() }
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .acmColorBackground(ACMColors.bg)
        .onAppear {
            viewModel.openTranscriptStream()
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .center, spacing: ACMSpacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text("Transcript")
                        .font(ACMFont.trial(17, weight: .semibold))
                        .foregroundStyle(ACMColors.text)
                    Text("BETA")
                        .font(ACMFont.trial(9.5, weight: .semibold))
                        .foregroundStyle(ACMColors.primaryOrange)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2.5)
                        .acmColorBackground(ACMColors.primaryOrange.opacity(0.10))
                        .overlay {
                            RoundedRectangle(cornerRadius: 6)
                                .strokeBorder(lineWidth: 1)
                                .foregroundStyle(ACMColors.primaryOrange.opacity(0.30))
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                if isRunning, let controller = state.controllerName, !controller.isEmpty {
                    Text("Hosted by \(controller)")
                        .font(ACMFont.trial(11.5))
                        .foregroundStyle(ACMColors.textMuted)
                        .lineLimit(1)
                }
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
            .accessibilityLabel("Close transcript")
        }
        .padding(.horizontal, ACMSpacing.lg)
        .padding(.top, ACMSpacing.md)
        .padding(.bottom, ACMSpacing.sm)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            ACMSystemIcon.icon("exclamationmark.triangle.fill", android: "warning", size: 12, tint: "error")
                .foregroundStyle(ACMColors.error)
            Text(message)
                .font(ACMFont.trial(12))
                .foregroundStyle(ACMColors.error)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, ACMSpacing.lg)
        .padding(.vertical, 8)
        .acmColorBackground(ACMColors.error.opacity(0.10))
    }

    // MARK: - Status row (running)

    private var statusRow: some View {
        HStack(spacing: ACMSpacing.sm) {
            HStack(spacing: 7) {
                if state.sessionStatus == "paused" {
                    Circle().fill(ACMColors.handRaised).frame(width: 7, height: 7)
                } else if state.isLive {
                    Circle().fill(ACMColors.success).frame(width: 7, height: 7)
                } else {
                    ProgressView()
                        .tint(liveAccent)
                        .scaleEffect(0.7)
                }
                Text(statusLabel)
                    .font(ACMFont.trial(12))
                    .foregroundStyle(ACMColors.textMuted)
                    .lineLimit(1)
            }

            Spacer(minLength: ACMSpacing.xs)

            if state.canStop {
                Button {
                    viewModel.stopTranscription()
                } label: {
                    HStack(spacing: 6) {
                        ACMSystemIcon.icon("stop.fill", android: "stop", size: 10, tint: "error")
                            .foregroundStyle(ACMColors.error)
                        Text("Stop")
                            .font(ACMFont.trial(12, weight: .semibold))
                            .foregroundStyle(ACMColors.error)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 28)
                    .acmColorBackground(ACMColors.error.opacity(0.10))
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop transcription")
            }
        }
        .padding(.horizontal, ACMSpacing.lg)
        .padding(.vertical, 8)
    }

    private var statusLabel: String {
        if state.sessionStatus == "paused" { return "Paused" }
        if !state.isLive { return "Connecting" }
        return state.canStop ? "Listening to the room" : "Following live"
    }

    // MARK: - Content

    @ViewBuilder
    private var contentBody: some View {
        if state.orderedSegments.isEmpty {
            ListeningFallbackView(accent: liveAccent)
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
                        TranscriptGroupCard(group: group, accent: liveAccent)
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

    private var transcriptBottomScrollClearance: CGFloat {
        #if SKIP
        return ACMSpacing.xxxl * 3
        #else
        return ACMSpacing.md
        #endif
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: ACMSpacing.sm) {
            Button {
                copyTranscript()
            } label: {
                HStack(spacing: 7) {
                    ACMSystemIcon.icon("doc.on.doc", android: "copy", size: 13)
                        .foregroundStyle(ACMColors.textMuted)
                    Text(copyState == 1 ? "Copied" : "Copy transcript")
                        .font(ACMFont.trial(12.5, weight: .semibold))
                        .foregroundStyle(ACMColors.text)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 38)
                .acmColorBackground(ACMColors.subtleFill)
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.md)
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.borderSubtle)
                }
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Copy transcript")
        }
        .padding(.horizontal, ACMSpacing.lg)
        .padding(.vertical, ACMSpacing.sm)
        .overlay(alignment: .top) {
            Rectangle().fill(ACMColors.border).frame(height: 1)
        }
    }

    private func copyTranscript() {
        let markdown = TranscriptPresentationPolicy.exportMarkdown(
            roomId: viewModel.state.roomId,
            segments: state.orderedSegments
        )
        guard !markdown.isEmpty else { return }
        #if SKIP
        ClipboardHelper.copyToClipboard(text: markdown, label: "Transcript")
        #elseif canImport(UIKit)
        UIPasteboard.general.string = markdown
        #endif
        copyState = 1
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            copyState = 0
        }
    }
}

// MARK: - Start stage

/// Centered hero for turning on live notes - the native sibling of the web
/// StartStage, minus provider pickers (native uses the room's shared key).
private struct StartStageView: View {
    let canStart: Bool
    let needsTakeover: Bool
    let isBusy: Bool
    let accent: Color
    let onStart: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)

            VStack(spacing: 0) {
                Text("Live notes")
                    .font(ACMFont.trial(13, weight: .medium))
                    .foregroundStyle(accent)

                Text(needsTakeover ? "Pick up the live notes" : "Turn on live notes")
                    .font(ACMFont.trial(25, weight: .medium))
                    .foregroundStyle(ACMColors.text)
                    .multilineTextAlignment(.center)
                    .padding(.top, 10)

                Text(startBlurb)
                    .font(ACMFont.trial(13))
                    .foregroundStyle(ACMColors.textMuted)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                    .padding(.top, 12)
                    .frame(maxWidth: 290)

                if canStart {
                    Button {
                        onStart()
                    } label: {
                        HStack(spacing: 8) {
                            if isBusy {
                                ProgressView()
                                    .tint(Color.white)
                                    .scaleEffect(0.8)
                            }
                            Text(startCta)
                                .font(ACMFont.trial(14, weight: .semibold))
                                .foregroundStyle(Color.white)
                        }
                        .frame(maxWidth: 300)
                        .frame(height: 46)
                        .acmColorBackground(ACMColors.primaryOrange)
                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                    }
                    .buttonStyle(.plain)
                    .disabled(isBusy)
                    .opacity(isBusy ? 0.75 : 1.0)
                    .padding(.top, 26)
                    .accessibilityLabel(startCta)

                    HStack(spacing: 6) {
                        ACMSystemIcon.icon("checkmark.circle", android: "check.circle", size: 11)
                            .foregroundStyle(ACMColors.textFaint)
                        Text("Covered by Conclave. No key needed.")
                            .font(ACMFont.trial(11))
                            .foregroundStyle(ACMColors.textFaint)
                    }
                    .padding(.top, 12)
                } else {
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
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.borderSubtle)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
                    .padding(.top, 26)
                }
            }
            .frame(maxWidth: .infinity)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, ACMSpacing.xl)
    }

    private var startBlurb: String {
        if !canStart {
            return "Follow the live transcript once someone with controls turns it on."
        }
        if needsTakeover {
            return "The last host stepped away. Resume it with Conclave's shared key."
        }
        return "Transcribe the room and follow every word live, captioned for everyone."
    }

    private var startCta: String {
        if isBusy { return "Starting" }
        return needsTakeover ? "Resume notes" : "Start notes"
    }
}

// MARK: - Listening fallback

/// Live-but-quiet empty state: a static waveform in a blue-tinted pill, the
/// native sibling of the web's animated equalizer.
private struct ListeningFallbackView: View {
    let accent: Color

    private let barHeights: [CGFloat] = [8.0, 14.0, 20.0, 12.0, 22.0, 16.0, 10.0, 18.0, 22.0, 13.0, 8.0]

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)

            HStack(alignment: .bottom, spacing: 3) {
                ForEach(Array(barHeights.enumerated()), id: \.offset) { _, height in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(accent.opacity(0.8))
                        .frame(width: 2.5, height: height)
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 14)
            .acmColorBackground(accent.opacity(0.06))
            .overlay {
                Capsule().strokeBorder(lineWidth: 1).foregroundStyle(accent.opacity(0.20))
            }
            .clipShape(Capsule())

            Text("Listening for the room")
                .font(ACMFont.trial(14, weight: .semibold))
                .foregroundStyle(ACMColors.text)
                .padding(.top, 18)

            Text("As people speak, their words appear here live, captioned for everyone.")
                .font(ACMFont.trial(12.5))
                .foregroundStyle(ACMColors.textMuted)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .padding(.top, 6)
                .frame(maxWidth: 250)

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, ACMSpacing.xl)
    }
}

// MARK: - Group card

/// One speaker run: name + clock header above a carded caption body. Live
/// (unfinalized) groups tint blue and end with a caret bar, like the web.
private struct TranscriptGroupCard: View {
    let group: TranscriptGroup
    let accent: Color

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
                    RoundedRectangle(cornerRadius: 1.0)
                        .fill(accent.opacity(0.8))
                        .frame(width: 2.0, height: 12.0)
                        .padding(.bottom, 2.0)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .acmColorBackground(group.isFinal ? ACMColors.subtleFill : accent.opacity(0.06))
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.md)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(group.isFinal ? ACMColors.borderSubtle : accent.opacity(0.35))
            }
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.md))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
