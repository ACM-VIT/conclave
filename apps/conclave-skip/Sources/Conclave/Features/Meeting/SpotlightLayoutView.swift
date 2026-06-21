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

    private var pinnedId: String {
        viewModel.state.spotlightUserId ?? viewModel.state.userId
    }

    private var othersIds: [String] {
        var ids: [String] = []
        if !viewModel.state.isLocalParticipantUserId(pinnedId) && viewModel.state.shouldShowSelfTile {
            ids.append(viewModel.state.userId)
        }
        for participant in viewModel.state.visibleTileParticipants where participant.id != pinnedId {
            ids.append(participant.id)
        }
        return Array(ids.prefix(max(0, stageRailTileLimit - 1)))
    }

    private var usesSidebarRail: Bool {
        viewModel.state.usesSidebarLayout && !isCompact
    }

    private var stageRailTileLimit: Int {
        if viewModel.state.usesSidebarLayout {
            return MeetingViewConstants.clampStageRailTiles(viewModel.state.viewMaxTiles)
        }
        return MeetingViewConstants.clampTiles(viewModel.state.viewMaxTiles)
    }

    var body: some View {
        GeometryReader { geo in
            Group {
                if usesSidebarRail {
                    HStack(spacing: 8) {
                        stageView
                        verticalRail
                    }
                } else {
                    VStack(spacing: 8) {
                        stageView
                        horizontalRail
                    }
                }
            }
            .frame(width: geo.size.width, height: geo.size.height - controlsOverlap, alignment: .top)
            .padding(8)
            .overlay {
                if viewModel.state.shouldShowDetachedSelfView && !viewModel.state.isLocalParticipantUserId(pinnedId) {
                    DetachedSelfViewOverlay(viewModel: viewModel)
                        .padding(.trailing, usesSidebarRail ? 164.0 : 16.0)
                        .padding(.leading, 16.0)
                        .padding(.top, 16.0)
                        .padding(.bottom, 16.0)
                }
            }
        }
    }

    private var stageView: some View {
        tileFor(userId: pinnedId)
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
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var horizontalRail: some View {
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

    private var verticalRail: some View {
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
                displayName: viewModel.state.displayName,
                isMuted: viewModel.state.isMuted,
                isCameraOff: viewModel.state.isCameraOff,
                isHandRaised: viewModel.state.isHandRaised,
                isGhost: viewModel.state.isGhostMode,
                isSpeaking: viewModel.state.effectiveActiveSpeakerId.map { viewModel.state.isLocalParticipantUserId($0) } == true,
                isLocal: true,
                isThumbnail: isThumbnail,
                captureSession: captureSession,
                localVideoTrack: localVideoTrack
            )
        } else if let participant = viewModel.state.participants[userId] {
            VideoGridItem(
                displayName: viewModel.displayNameForUser(participant.id),
                isMuted: participant.isMuted,
                isCameraOff: participant.isCameraOff,
                isHandRaised: participant.isHandRaised,
                isGhost: participant.isGhost,
                isSpeaking: viewModel.state.effectiveActiveSpeakerId == participant.id,
                isLocal: false,
                connectionStatus: participant.connectionStatus,
                isThumbnail: isThumbnail,
                trackWrapper: viewModel.webRTCClient.remoteVideoTracks[participant.id]
            )
        } else {
            Color.black
        }
    }
}
