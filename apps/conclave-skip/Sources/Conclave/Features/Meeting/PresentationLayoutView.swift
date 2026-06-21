import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Presentation Layout

struct PresentationLayoutView: View {
    @Bindable var viewModel: MeetingViewModel
    let isCompact: Bool
    let containerSize: CGSize

    private let controlsOverlap: CGFloat = 8

    var body: some View {
        if isCompact {
            compactLayout
        } else {
            regularLayout
        }
    }

    // MARK: Phone portrait: screenshare top, horizontal filmstrip below

    var compactLayout: some View {
        GeometryReader { geo in
            // Reserve clearance for the floating controls bar so the filmstrip
            // never hides behind it.
            let avail = geo.size.height - controlsOverlap
            VStack(spacing: 8) {
                screenshareView
                    .frame(maxWidth: .infinity)
                    .frame(height: avail * 0.74)
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                    .overlay {
                        RoundedRectangle(cornerRadius: ACMRadius.lg)
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.border)
                    }

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
            .frame(width: geo.size.width, height: avail, alignment: .top)
            .padding(8)
        }
    }

    // MARK: Tablet / landscape: side-by-side

    var regularLayout: some View {
        HStack(spacing: 8) {
            screenshareView
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.lg)
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.creamFaint)
                }

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

    // MARK: Shared components

    @ViewBuilder
    var screenshareView: some View {
        ZStack {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .fill(Color.black)

            if let screenShareUserId = viewModel.state.activeScreenShareUserId {
                if let trackWrapper = viewModel.webRTCClient.remoteVideoTracks["\(screenShareUserId)-screen"] {
                    // .fit = letterbox the shared screen on the black fill so a
                    // landscape-desktop or portrait-phone capture is never cropped.
                    RemoteVideoView(trackWrapper: trackWrapper, contentMode: .fit)
                        .overlay {
                            // Persistent presenter attribution (always know who's
                            // sharing) — same flat name-plate tokens as the tiles.
                            VStack {
                                Spacer()
                                HStack {
                                    Text("\(viewModel.displayNameForUser(screenShareUserId)) is presenting")
                                        .font(ACMFont.trial(12, weight: .medium))
                                        .foregroundStyle(ACMColors.text)
                                        .lineLimit(1)
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 5)
                                        .acmColorBackground(ACMColors.scrim)
                                        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.sm))
                                    Spacer()
                                }
                                .padding(ACMSpacing.sm)
                            }
                        }
                } else {
                    VStack(spacing: 8) {
                        ACMSystemIcon.icon("rectangle.on.rectangle", android: "screen.share", size: 40, tint: "muted")
                            .foregroundStyle(ACMColors.textMuted)

                        Text("\(viewModel.displayNameForUser(screenShareUserId)) is presenting")
                            .font(ACMFont.trial(14))
                            .foregroundStyle(ACMColors.textFaint)
                    }
                }
            }
        }
        .overlay {
            if viewModel.state.shouldShowDetachedSelfView && !viewModel.state.shouldShowSelfTile {
                DetachedSelfViewOverlay(viewModel: viewModel)
                    .padding(16)
            }
        }
    }

    private var thumbnailWidth: CGFloat { isCompact ? 120.0 : 124.0 }
    private var thumbnailHeight: CGFloat { isCompact ? 68.0 : 70.0 }

    var localThumbnail: some View {
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

    func remoteThumbnail(participant: Participant) -> some View {
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
}
