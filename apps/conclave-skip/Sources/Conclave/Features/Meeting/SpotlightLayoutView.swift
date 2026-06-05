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
        viewModel.state.pinnedUserId ?? viewModel.state.userId
    }

    // Everyone except the pinned tile, local first.
    private var othersIds: [String] {
        var ids: [String] = []
        if viewModel.state.userId != pinnedId {
            ids.append(viewModel.state.userId)
        }
        for participant in viewModel.state.sortedParticipants where participant.id != pinnedId {
            ids.append(participant.id)
        }
        return ids
    }

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 8) {
                // Stage — the pinned participant, with an unpin affordance. The
                // unpin pill is an .overlay (not a topTrailing ZStack) so Skip
                // does not ghost its ComposeView icon at the stage corner.
                tileFor(userId: pinnedId)
                    .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
                    .overlay {
                        RoundedRectangle(cornerRadius: ACMRadius.lg)
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.border)
                    }
                    .overlay(alignment: .topTrailing) {
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
                    .frame(maxWidth: .infinity)

                // Filmstrip — tap a thumbnail to spotlight that participant.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(othersIds, id: \.self) { id in
                            Button {
                                viewModel.togglePin(id)
                            } label: {
                                tileFor(userId: id)
                                    .frame(width: 124, height: 76)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 8)
                }
                .frame(height: 84)
            }
            .frame(width: geo.size.width, height: geo.size.height - controlsOverlap, alignment: .top)
            .padding(8)
        }
    }

    @ViewBuilder
    func tileFor(userId: String) -> some View {
        if userId == viewModel.state.userId {
            VideoGridItem(
                displayName: viewModel.state.displayName,
                isMuted: viewModel.state.isMuted,
                isCameraOff: viewModel.state.isCameraOff,
                isHandRaised: viewModel.state.isHandRaised,
                isGhost: viewModel.state.isGhostMode,
                isSpeaking: viewModel.state.activeSpeakerId == viewModel.state.userId,
                isLocal: true,
                captureSession: viewModel.webRTCClient.getCaptureSession(),
                localVideoTrack: viewModel.webRTCClient.getLocalVideoTrack()
            )
        } else if let participant = viewModel.state.participants[userId] {
            VideoGridItem(
                displayName: viewModel.displayNameForUser(participant.id),
                isMuted: participant.isMuted,
                isCameraOff: participant.isCameraOff,
                isHandRaised: participant.isHandRaised,
                isGhost: participant.isGhost,
                isSpeaking: viewModel.state.activeSpeakerId == participant.id,
                isLocal: false,
                trackWrapper: viewModel.webRTCClient.remoteVideoTracks[participant.id]
            )
        } else {
            Color.black
        }
    }
}

