import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Presentation Layout

enum PresentationCompactLayout {
    static let stripHeight: CGFloat = 84.0
    static let spacing: CGFloat = 8.0
    static let verticalPadding: CGFloat = 16.0

    static func screenShareHeight(availableHeight: CGFloat) -> CGFloat {
        let available = max(0.0, availableHeight)
        let preferredHeight = available * 0.74
        let maxFittingHeight = max(0.0, available - stripHeight - spacing - verticalPadding)
        return min(preferredHeight, maxFittingHeight)
    }
}

struct PresentationLayoutView: View {
    @Bindable var viewModel: MeetingViewModel
    let isCompact: Bool
    let containerSize: CGSize

    private let controlsOverlap: CGFloat = 8
    private var detachedSelfEdgeInsets: EdgeInsets {
        MeetingDetachedSelfLayout.edgeInsets(isCompact: isCompact)
    }

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
            let avail = MeetingStageLayout.visibleHeight(
                containerHeight: geo.size.height,
                controlsOverlap: controlsOverlap
            )
            let strip = viewModel.state.tileStripSnapshot()
            VStack(spacing: 8) {
                screenshareView
                    .frame(maxWidth: .infinity)
                    .frame(height: PresentationCompactLayout.screenShareHeight(availableHeight: avail))
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                    .overlay {
                        RoundedRectangle(cornerRadius: ACMRadius.lg)
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.border)
                    }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        if strip.shouldShowSelfTile {
                            localThumbnail
                        }
                        ForEach(strip.participants) { participant in
                            remoteThumbnail(participant: participant)
                        }
                    }
                    .padding(.horizontal, 8)
                }
                .frame(height: PresentationCompactLayout.stripHeight)
            }
            .padding(8)
            .frame(width: geo.size.width, height: avail, alignment: .top)
        }
    }

    // MARK: Tablet / landscape: side-by-side

    var regularLayout: some View {
        let strip = viewModel.state.tileStripSnapshot()
        return HStack(spacing: 8) {
            screenshareView
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                .overlay {
                    RoundedRectangle(cornerRadius: ACMRadius.lg)
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.creamFaint)
                }

            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 8) {
                    if strip.shouldShowSelfTile {
                        localThumbnail
                    }
                    ForEach(strip.participants) { participant in
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

            if let screenShareUserId = viewModel.state.presentationScreenShareUserId {
                if let trackWrapper = viewModel.webRTCClient.remoteVideoTrack(forUserId: "\(screenShareUserId)-screen") {
                    // .fit = letterbox the shared screen on the black fill so a
                    // landscape-desktop or portrait-phone capture is never cropped.
                    RemoteVideoView(
                        trackWrapper: trackWrapper,
                        contentMode: .fit,
                        fallbackDisplayName: viewModel.displayNameForUser(screenShareUserId)
                    )
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
                DetachedSelfViewOverlay(viewModel: viewModel, isCompact: isCompact, edgeInsets: detachedSelfEdgeInsets)
            }
        }
    }

    private var thumbnailWidth: CGFloat { isCompact ? 120.0 : 124.0 }
    private var thumbnailHeight: CGFloat { isCompact ? 68.0 : 70.0 }

    var localThumbnail: some View {
        let localVideoTrack = viewModel.webRTCClient.getLocalVideoTrack()
        let captureSession = (!viewModel.state.isCameraOff && localVideoTrack == nil) ? viewModel.webRTCClient.getCaptureSession() : nil
        return VideoGridItem(
            displayName: viewModel.displayNameForUser(viewModel.state.userId),
            isMuted: viewModel.state.isMuted,
            isCameraOff: viewModel.state.isCameraOff,
            isHandRaised: viewModel.state.isHandRaised,
            isGhost: viewModel.state.isGhostMode,
            isSpeaking: viewModel.state.isEffectiveActiveSpeaker(viewModel.state.userId),
            isLocal: true,
            isThumbnail: true,
            avatarSizeOverride: 34.0,
            localCameraFacing: viewModel.localCameraFacing,
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
            isSpeaking: viewModel.state.isEffectiveActiveSpeaker(participant.id),
            isLocal: false,
            connectionStatus: participant.connectionStatus,
            isThumbnail: true,
            avatarSizeOverride: 34.0,
            trackWrapper: viewModel.webRTCClient.remoteVideoTrack(forUserId: participant.id)
        )
        .frame(width: thumbnailWidth, height: thumbnailHeight)
    }
}
