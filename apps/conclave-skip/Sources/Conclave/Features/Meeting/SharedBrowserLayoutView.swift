import SwiftUI
import Observation

struct SharedBrowserLayoutView: View {
    @Bindable var viewModel: MeetingViewModel
    let isCompact: Bool

    @State private var navInput = ""

    private let controlsOverlap: CGFloat = 8

    var body: some View {
        GeometryReader { geo in
            let browserURL = viewModel.resolvedBrowserNoVncURL()
            if isCompact {
                compactLayout(size: geo.size, browserURL: browserURL)
            } else {
                regularLayout(browserURL: browserURL)
            }
        }
        .onAppear {
            navInput = viewModel.state.browserURL ?? ""
        }
        .onChange(of: viewModel.state.browserURL) { _, newValue in
            navInput = newValue ?? ""
        }
    }

    private func compactLayout(size: CGSize, browserURL: String?) -> some View {
        let availableHeight = size.height - controlsOverlap
        return VStack(spacing: 8) {
            browserCard(browserURL: browserURL)
                .frame(maxWidth: .infinity)
                .frame(height: availableHeight * 0.74)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    if viewModel.state.shouldShowSelfTile {
                        localThumbnail
                    }
                    ForEach(viewModel.state.visibleTileParticipants.prefix(max(0, viewModel.state.viewMaxTiles - (viewModel.state.shouldShowSelfTile ? 1 : 0)))) { participant in
                        remoteThumbnail(participant: participant)
                    }
                }
                .padding(.horizontal, 8)
            }
            .frame(height: 84)
        }
        .frame(width: size.width, height: availableHeight, alignment: .top)
        .padding(8)
    }

    private func regularLayout(browserURL: String?) -> some View {
        HStack(spacing: 8) {
            browserCard(browserURL: browserURL)

            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 8) {
                    if viewModel.state.shouldShowSelfTile {
                        localThumbnail
                    }
                    ForEach(viewModel.state.visibleTileParticipants.prefix(max(0, viewModel.state.viewMaxTiles - (viewModel.state.shouldShowSelfTile ? 1 : 0)))) { participant in
                        remoteThumbnail(participant: participant)
                    }
                }
                .padding(8)
            }
            .frame(width: 148)
            .acmColorBackground(ACMColors.bgAlt)
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        }
        .padding(8)
    }

    private func browserCard(browserURL: String?) -> some View {
        VStack(spacing: 0) {
            if viewModel.state.isAdmin && !viewModel.state.isWebinarAttendee {
                browserToolbar
            }

            ZStack {
                Color.black

                if let browserURL {
                    NativeWebView(urlString: browserURL)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    browserLoadingView
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            browserStatusBar
        }
        .acmColorBackground(ACMColors.surface)
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .strokeBorder(lineWidth: 1)
                .foregroundStyle(ACMColors.border)
        }
        .overlay {
            if viewModel.state.shouldShowDetachedSelfView && !viewModel.state.shouldShowSelfTile {
                DetachedSelfViewOverlay(viewModel: viewModel)
                    .padding(16)
            }
        }
    }

    private var browserToolbar: some View {
        HStack(spacing: ACMSpacing.sm) {
            HStack(spacing: ACMSpacing.xs) {
                ACMSystemIcon.icon("globe", android: "public", size: 16, tint: "muted")
                    .foregroundStyle(ACMColors.textMuted)
                TextField("", text: $navInput, prompt: Text("Navigate to a URL").foregroundStyle(ACMColors.textFaint))
                    .textFieldStyle(.plain)
                    .font(ACMFont.trial(14))
                    .foregroundStyle(ACMColors.text)
                    .tint(ACMColors.primaryOrange)
#if !SKIP
#if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
#endif
#endif
                    .autocorrectionDisabled(true)
            }
            .padding(.horizontal, ACMSpacing.sm)
            .frame(height: 38)
            .acmColorBackground(ACMColors.bgAlt)
            .clipShape(Capsule())
            .overlay {
                Capsule()
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.border)
            }

            Button {
                submitNavigation()
            } label: {
                HStack(spacing: 5) {
                    if viewModel.state.isBrowserNavigating {
                        ProgressView()
#if SKIP
                            .progressViewStyle(.circular)
#endif
                            .tint(Color.white)
                            .frame(width: 14, height: 14)
                    } else {
                        Text("Go")
                            .font(ACMFont.trial(13, weight: .medium))
                    }
                }
                .foregroundStyle(Color.white)
                .frame(width: 52, height: 38)
                .acmColorBackground(canNavigate ? ACMColors.primaryOrange : ACMColors.surfaceRaised)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!canNavigate)
        }
        .padding(.horizontal, ACMSpacing.sm)
        .padding(.vertical, ACMSpacing.xs)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(ACMColors.border)
                .frame(height: 1)
        }
    }

    private var browserLoadingView: some View {
        VStack(spacing: ACMSpacing.md) {
            Circle()
                .fill(ACMColors.primaryOrangeFaint)
                .frame(width: 64, height: 64)
                .overlay {
                    ACMSystemIcon.icon("globe", android: "public", size: 28, tint: "accent")
                        .foregroundStyle(ACMColors.primaryOrange)
                }

            HStack(spacing: ACMSpacing.xs) {
                ProgressView()
#if SKIP
                    .progressViewStyle(.circular)
#endif
                    .tint(ACMColors.textMuted)
                    .frame(width: 18, height: 18)
                Text("Starting browser")
                    .font(ACMFont.trial(14))
                    .foregroundStyle(ACMColors.textMuted)
            }
        }
    }

    private var browserStatusBar: some View {
        HStack(spacing: ACMSpacing.sm) {
            ACMSystemIcon.icon("globe", android: "public", size: 15, tint: "muted")
                .foregroundStyle(ACMColors.textMuted)

            Text(displayBrowserHost)
                .font(ACMFont.trial(12, weight: .medium))
                .foregroundStyle(ACMColors.text)
                .lineLimit(1)

            Spacer()

            if canToggleBrowserAudio {
                browserAudioButton
            }

            Circle()
                .fill(ACMColors.success)
                .frame(width: 7, height: 7)
            Text("\(browserControllerName) is sharing")
                .font(ACMFont.trial(12))
                .foregroundStyle(ACMColors.textMuted)
                .lineLimit(1)
        }
        .padding(.horizontal, ACMSpacing.sm)
        .frame(height: 38)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(ACMColors.border)
                .frame(height: 1)
        }
    }

    private var browserAudioButton: some View {
        let isMuted = viewModel.state.isBrowserAudioMuted
        let label = isMuted ? "Unmute shared browser audio" : "Mute shared browser audio"

        return Button {
            viewModel.toggleBrowserAudio()
        } label: {
            ZStack {
                ACMSystemIcon.icon(
                    isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill",
                    android: isMuted ? "volume.off" : "volume",
                    size: 14,
                    tint: isMuted ? "accent" : "text"
                )
                .foregroundStyle(isMuted ? ACMColors.primaryOrange : ACMColors.text)

#if SKIP
                ACMAndroidSemanticText(label)
#endif
            }
            .frame(width: 30, height: 30)
            .acmGlassCapsule(interactive: true)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var canNavigate: Bool {
        !viewModel.state.isBrowserNavigating &&
        !navInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canToggleBrowserAudio: Bool {
        viewModel.state.connectionState == .joined &&
        !viewModel.state.isWebinarAttendee &&
        (viewModel.state.hasBrowserAudio || viewModel.state.isBrowserActive)
    }

    private var displayBrowserHost: String {
        let value = viewModel.state.browserURL ?? ""
        if let host = URLComponents(string: value)?.host, !host.isEmpty {
            return host
        }
        return value.isEmpty ? "Shared browser" : value
    }

    private var browserControllerName: String {
        if let userId = viewModel.state.browserControllerUserId, !userId.isEmpty {
            return viewModel.displayNameForUser(userId)
        }
        return "Host"
    }

    private var thumbnailWidth: CGFloat { isCompact ? 120.0 : 124.0 }
    private var thumbnailHeight: CGFloat { isCompact ? 68.0 : 70.0 }

    private var localThumbnail: some View {
        let localVideoTrack = viewModel.webRTCClient.getLocalVideoTrack()
        let captureSession = (!viewModel.state.isCameraOff && localVideoTrack == nil) ? viewModel.webRTCClient.getCaptureSession() : nil
        return VideoGridItem(
            displayName: viewModel.state.displayName,
            isMuted: viewModel.state.isMuted,
            isCameraOff: viewModel.state.isCameraOff,
            isHandRaised: viewModel.state.isHandRaised,
            isGhost: viewModel.state.isGhostMode,
            isSpeaking: viewModel.state.effectiveActiveSpeakerId.map { viewModel.state.isLocalParticipantUserId($0) } == true,
            isLocal: true,
            isThumbnail: true,
            captureSession: captureSession,
            localVideoTrack: localVideoTrack
        )
        .frame(width: thumbnailWidth, height: thumbnailHeight)
    }

    private func remoteThumbnail(participant: Participant) -> some View {
        VideoGridItem(
            displayName: viewModel.displayNameForUser(participant.id),
            isMuted: participant.isMuted,
            isCameraOff: participant.isCameraOff,
            isHandRaised: participant.isHandRaised,
            isGhost: participant.isGhost,
            isSpeaking: viewModel.state.effectiveActiveSpeakerId == participant.id,
            isLocal: false,
            connectionStatus: participant.connectionStatus,
            isThumbnail: true,
            trackWrapper: viewModel.webRTCClient.remoteVideoTracks[participant.id]
        )
        .frame(width: thumbnailWidth, height: thumbnailHeight)
    }

    private func submitNavigation() {
        viewModel.navigateSharedBrowser(url: navInput)
    }
}
