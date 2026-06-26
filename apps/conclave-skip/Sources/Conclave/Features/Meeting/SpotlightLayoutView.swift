import SwiftUI
import Observation
#if canImport(UIKit) && !SKIP
import UIKit
#endif

// MARK: - Spotlight Layout (pinned participant on stage + filmstrip)

struct SpotlightLayoutView: View {
    @Bindable var viewModel: MeetingViewModel
    let isCompact: Bool
    let containerSize: CGSize

    private let controlsOverlap: CGFloat = 8
    private var detachedSelfEdgeInsets: EdgeInsets {
        MeetingDetachedSelfLayout.spotlightEdgeInsets(isCompact: isCompact)
    }

    var body: some View {
        GeometryReader { geo in
            let snapshot = viewModel.state.spotlightSnapshot()
            let usesSidebarRail = snapshot.usesSidebarRail && !isCompact
            let visibleHeight = MeetingStageLayout.visibleHeight(
                containerHeight: geo.size.height,
                controlsOverlap: controlsOverlap
            )
            Group {
                if usesSidebarRail {
                    HStack(spacing: 8) {
                        stageView(pinnedId: snapshot.pinnedUserId)
                        if snapshot.hasRailTiles {
                            verticalRail(othersIds: snapshot.railUserIds)
                        }
                    }
                } else {
                    VStack(spacing: 8) {
                        stageView(pinnedId: snapshot.pinnedUserId)
                        if snapshot.hasRailTiles {
                            horizontalRail(othersIds: snapshot.railUserIds)
                        }
                    }
                }
            }
            .frame(width: geo.size.width, height: visibleHeight, alignment: .top)
            .padding(8)
        }
    }

    private func stageView(pinnedId: String) -> some View {
        tileFor(userId: pinnedId)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.lg)
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(ACMColors.border)
            }
            .overlay(alignment: .topTrailing) {
                if viewModel.state.pinnedUserId != nil {
                    Button {
                        viewModel.clearPin()
                    } label: {
                        HStack(spacing: 5) {
                            ACMSystemIcon.icon("pin.slash.fill", android: "pin.off", size: 12, tint: "white")
                            Text("Unpin")
                                .font(ACMFont.trial(12, weight: .medium))
                        }
                        .foregroundStyle(Color.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .acmColorBackground(ACMColors.scrim)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .padding(10)
                }
            }
            .overlay {
                if viewModel.state.shouldShowDetachedSelfView && !viewModel.state.isLocalParticipantUserId(pinnedId) {
                    DetachedSelfViewOverlay(viewModel: viewModel, isCompact: isCompact, edgeInsets: detachedSelfEdgeInsets)
                }
            }
    }

    private func horizontalRail(othersIds: [String]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(othersIds, id: \.self) { id in
                    railButton(userId: id)
                }
            }
            .padding(.horizontal, 8)
        }
        .frame(height: 84)
    }

    private func verticalRail(othersIds: [String]) -> some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 8) {
                ForEach(othersIds, id: \.self) { id in
                    railButton(userId: id)
                }
            }
            .padding(8)
        }
        .frame(width: 148)
        .acmColorBackground(ACMColors.bgAlt)
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
    }

    private func railButton(userId: String) -> some View {
        Button {
            viewModel.togglePin(userId)
        } label: {
            tileFor(userId: userId, isThumbnail: true)
                .frame(width: 124, height: 76)
                .padding(2)
                .acmColorBackground(ACMColors.surface)
                .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    func tileFor(userId: String, isThumbnail: Bool = false) -> some View {
        if viewModel.state.isLocalParticipantUserId(userId) {
            let localVideoTrack = viewModel.webRTCClient.getLocalVideoTrack()
            let captureSession = (!viewModel.state.isCameraOff && localVideoTrack == nil) ? viewModel.webRTCClient.getCaptureSession() : nil
            VideoGridItem(
                displayName: viewModel.displayNameForUser(viewModel.state.userId),
                isMuted: viewModel.state.isMuted,
                isCameraOff: viewModel.state.isCameraOff,
                isHandRaised: viewModel.state.isHandRaised,
                isGhost: viewModel.state.isGhostMode,
                isSpeaking: viewModel.state.isEffectiveActiveSpeaker(viewModel.state.userId),
                isLocal: true,
                isThumbnail: isThumbnail,
                avatarSizeOverride: isThumbnail ? 34.0 : nil,
                localCameraFacing: viewModel.localCameraFacing,
                captureSession: captureSession,
                localVideoTrack: localVideoTrack
            )
        } else if let participant = viewModel.state.participant(for: userId) {
            VideoGridItem(
                displayName: viewModel.displayNameForUser(participant.id),
                isMuted: participant.isMuted,
                isCameraOff: participant.isCameraOff,
                isHandRaised: participant.isHandRaised,
                isGhost: participant.isGhost,
                isSpeaking: viewModel.state.isEffectiveActiveSpeaker(participant.id),
                isLocal: false,
                connectionStatus: participant.connectionStatus,
                isThumbnail: isThumbnail,
                avatarSizeOverride: isThumbnail ? 34.0 : nil,
                trackWrapper: viewModel.webRTCClient.remoteVideoTrack(forUserId: participant.id)
            )
        } else {
            VideoGridItem(
                displayName: viewModel.displayNameForUser(userId),
                isMuted: true,
                isCameraOff: true,
                isHandRaised: false,
                isGhost: false,
                isSpeaking: false,
                isLocal: false,
                isThumbnail: isThumbnail,
                avatarSizeOverride: isThumbnail ? 34.0 : nil
            )
            .opacity(0.75)
        }
    }
}
