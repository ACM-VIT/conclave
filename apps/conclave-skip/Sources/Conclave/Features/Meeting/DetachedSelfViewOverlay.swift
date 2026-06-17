import SwiftUI
import Observation

struct DetachedSelfViewOverlay: View {
    @Bindable var viewModel: MeetingViewModel

    var body: some View {
        overlayContent
            .frame(
                maxWidth: .infinity,
                maxHeight: .infinity,
                alignment: viewModel.state.selfViewCorner.overlayAlignment
            )
            .animation(.easeInOut(duration: 0.16), value: viewModel.state.selfViewCorner)
    }

    @ViewBuilder
    private var overlayContent: some View {
        switch viewModel.state.resolvedSelfViewMode {
        case .floating:
            localTile
                .frame(width: 132, height: 78)
                .shadow(color: ACMColors.blackOverlay(0.35), radius: 16, x: 0, y: 8)
        case .minimized:
            Button {
                viewModel.setSelfViewMode(.floating)
            } label: {
                HStack(spacing: 6) {
                    ACMSystemIcon.icon("person.crop.circle", android: "account", size: 16, tint: "text")
                        .foregroundStyle(ACMColors.text)
                    Text("You")
                        .font(ACMFont.trial(12, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                }
                .padding(.horizontal, 12)
                .frame(height: 36)
                .acmColorBackground(ACMColors.scrim)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
        case .auto, .tile:
            EmptyView()
        }
    }

    private var localTile: some View {
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
    }
}

private extension MeetingSelfViewCorner {
    var overlayAlignment: Alignment {
        switch self {
        case .topLeft:
            return .topLeading
        case .topRight:
            return .topTrailing
        case .bottomLeft:
            return .bottomLeading
        case .bottomRight:
            return .bottomTrailing
        }
    }
}
