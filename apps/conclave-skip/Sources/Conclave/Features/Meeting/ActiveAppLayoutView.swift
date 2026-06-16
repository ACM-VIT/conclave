import SwiftUI
import Observation

struct ActiveAppLayoutView: View {
    @Bindable var viewModel: MeetingViewModel
    let isCompact: Bool

    private let controlsOverlap: CGFloat = 8

    var body: some View {
        GeometryReader { geo in
            if isCompact {
                compactLayout(size: geo.size)
            } else {
                regularLayout
            }
        }
    }

    private func compactLayout(size: CGSize) -> some View {
        let availableHeight = size.height - controlsOverlap
        return VStack(spacing: 8) {
            appStage
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

    private var regularLayout: some View {
        HStack(spacing: 8) {
            appStage

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

    private var appStage: some View {
        ZStack {
            ACMColors.surface

            VStack(spacing: ACMSpacing.lg) {
                Circle()
                    .fill(ACMColors.primaryOrangeFaint)
                    .frame(width: 76, height: 76)
                    .overlay {
                        ACMSystemIcon.icon(appIcon.ios, android: appIcon.android, size: 34, tint: "accent")
                            .foregroundStyle(ACMColors.primaryOrange)
                    }

                VStack(spacing: ACMSpacing.xs) {
                    Text("\(activeAppName) active")
                        .font(ACMFont.trial(22, weight: .semibold))
                        .foregroundStyle(ACMColors.text)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)

                    Text(statusText)
                        .font(ACMFont.trial(13))
                        .foregroundStyle(ACMColors.textMuted)
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                        .frame(maxWidth: 340)
                }

                if viewModel.state.isAdmin && !viewModel.state.isWebinarAttendee {
                    HStack(spacing: ACMSpacing.sm) {
                        Button {
                            viewModel.toggleAppsLock()
                        } label: {
                            HStack(spacing: 6) {
                                ACMSystemIcon.icon(
                                    viewModel.state.isAppsLocked ? "lock.open.fill" : "lock.fill",
                                    android: viewModel.state.isAppsLocked ? "lock.open" : "lock",
                                    size: 14,
                                    tint: viewModel.state.isAppsLocked ? "accent" : "text"
                                )
                                Text(viewModel.state.isAppsLocked ? "Unlock" : "Lock")
                                    .font(ACMFont.trial(13, weight: .medium))
                            }
                            .foregroundStyle(viewModel.state.isAppsLocked ? ACMColors.primaryOrange : ACMColors.text)
                            .padding(.horizontal, 14)
                            .frame(height: 38)
                            .acmColorBackground(ACMColors.surfaceRaised)
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(viewModel.state.isAppsActionInFlight)

                        Button {
                            viewModel.closeActiveApp()
                        } label: {
                            HStack(spacing: 6) {
                                ACMSystemIcon.icon("xmark", android: "close", size: 14, tint: "error")
                                Text("Close")
                                    .font(ACMFont.trial(13, weight: .medium))
                            }
                            .foregroundStyle(ACMColors.error)
                            .padding(.horizontal, 14)
                            .frame(height: 38)
                            .acmColorBackground(ACMColors.surfaceRaised)
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(viewModel.state.isAppsActionInFlight)
                    }
                }
            }
            .padding(ACMSpacing.lg)
        }
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

    private var activeAppName: String {
        viewModel.state.activeAppName ?? "Shared app"
    }

    private var statusText: String {
        if viewModel.state.isAppsLocked {
            return "Editing is locked by the host."
        }
        if viewModel.state.isWhiteboardActive {
            return "The whiteboard is live for this room. Native editing is not available in this build."
        }
        return "This shared app is live for this room."
    }

    private var appIcon: (ios: String, android: String) {
        switch viewModel.state.activeAppId {
        case "whiteboard":
            return ("pencil", "forum")
        case "dev-playground":
            return ("chevron.left.forwardslash.chevron.right", "info")
        default:
            return ("app.fill", "info")
        }
    }

    private var thumbnailWidth: CGFloat { isCompact ? 120.0 : 124.0 }
    private var thumbnailHeight: CGFloat { isCompact ? 68.0 : 70.0 }

    private var localThumbnail: some View {
        VideoGridItem(
            displayName: viewModel.state.displayName,
            isMuted: viewModel.state.isMuted,
            isCameraOff: viewModel.state.isCameraOff,
            isHandRaised: viewModel.state.isHandRaised,
            isGhost: viewModel.state.isGhostMode,
            isSpeaking: viewModel.state.effectiveActiveSpeakerId.map { viewModel.state.isLocalParticipantUserId($0) } == true,
            isLocal: true,
            captureSession: viewModel.webRTCClient.getCaptureSession(),
            localVideoTrack: viewModel.webRTCClient.getLocalVideoTrack()
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
            trackWrapper: viewModel.webRTCClient.remoteVideoTracks[participant.id]
        )
        .frame(width: thumbnailWidth, height: thumbnailHeight)
    }
}
