import SwiftUI
import Observation

struct DetachedSelfViewOverlay: View {
    @Bindable var viewModel: MeetingViewModel
    @State private var dragTranslation: CGSize = .zero
    @State private var isDragging = false

    private var overlaySize: CGSize {
        switch viewModel.state.resolvedSelfViewMode {
        case .floating:
            return CGSize(width: 132.0, height: 78.0)
        case .minimized:
            return CGSize(width: 92.0, height: 36.0)
        case .auto, .tile:
            return .zero
        }
    }

    var body: some View {
        GeometryReader { geometry in
            overlayContent
                .frame(width: overlaySize.width, height: overlaySize.height)
                #if !SKIP
                .contentShape(Rectangle())
                #endif
                .scaleEffect(isDragging ? 1.035 : 1.0)
                .offset(clampedDragTranslation(in: geometry.size))
                .gesture(dragGesture(in: geometry.size))
                .frame(
                    maxWidth: .infinity,
                    maxHeight: .infinity,
                    alignment: viewModel.state.selfViewCorner.overlayAlignment
                )
                .animation(.interactiveSpring(response: 0.24, dampingFraction: 0.86), value: viewModel.state.selfViewCorner)
                .animation(.interactiveSpring(response: 0.18, dampingFraction: 0.82), value: isDragging)
        }
    }

    @ViewBuilder
    private var overlayContent: some View {
        switch viewModel.state.resolvedSelfViewMode {
        case .floating:
            localTile
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
    }

    private func dragGesture(in containerSize: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 3.0)
            .onChanged { value in
                isDragging = true
                dragTranslation = clampedTranslation(value.translation, in: containerSize)
            }
            .onEnded { value in
                let finalTranslation = clampedTranslation(value.translation, in: containerSize)
                let targetCorner = viewModel.state.selfViewCorner.snappedCorner(
                    after: finalTranslation,
                    in: containerSize,
                    overlaySize: overlaySize
                )
                withAnimation(.interactiveSpring(response: 0.24, dampingFraction: 0.86)) {
                    viewModel.setSelfViewCorner(targetCorner)
                    dragTranslation = .zero
                    isDragging = false
                }
            }
    }

    private func clampedDragTranslation(in containerSize: CGSize) -> CGSize {
        clampedTranslation(dragTranslation, in: containerSize)
    }

    private func clampedTranslation(_ translation: CGSize, in containerSize: CGSize) -> CGSize {
        guard overlaySize.width > 0.0, overlaySize.height > 0.0 else { return .zero }
        let origin = viewModel.state.selfViewCorner.origin(in: containerSize, overlaySize: overlaySize)
        let minX = -origin.x
        let maxX = max(0.0, containerSize.width - overlaySize.width - origin.x)
        let minY = -origin.y
        let maxY = max(0.0, containerSize.height - overlaySize.height - origin.y)
        return CGSize(
            width: min(max(translation.width, minX), maxX),
            height: min(max(translation.height, minY), maxY)
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

    func origin(in containerSize: CGSize, overlaySize: CGSize) -> CGPoint {
        let maxX = max(0.0, containerSize.width - overlaySize.width)
        let maxY = max(0.0, containerSize.height - overlaySize.height)
        switch self {
        case .topLeft:
            return CGPoint(x: 0.0, y: 0.0)
        case .topRight:
            return CGPoint(x: maxX, y: 0.0)
        case .bottomLeft:
            return CGPoint(x: 0.0, y: maxY)
        case .bottomRight:
            return CGPoint(x: maxX, y: maxY)
        }
    }

    func snappedCorner(after translation: CGSize, in containerSize: CGSize, overlaySize: CGSize) -> MeetingSelfViewCorner {
        let origin = origin(in: containerSize, overlaySize: overlaySize)
        let centerX = origin.x + translation.width + overlaySize.width / 2.0
        let centerY = origin.y + translation.height + overlaySize.height / 2.0
        let isLeft = centerX < containerSize.width / 2.0
        let isTop = centerY < containerSize.height / 2.0
        if isTop {
            return isLeft ? .topLeft : .topRight
        }
        return isLeft ? .bottomLeft : .bottomRight
    }
}
