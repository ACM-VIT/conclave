import SwiftUI
import Observation

struct DetachedSelfViewOverlay: View {
    @Bindable var viewModel: MeetingViewModel
    var isCompact = false
    var edgeInsets = EdgeInsets(top: 16.0, leading: 16.0, bottom: 16.0, trailing: 16.0)
    @State private var dragTranslation: CGSize = .zero
    @State private var isDragging = false

    private var overlaySize: CGSize {
        switch viewModel.state.resolvedSelfViewMode {
        case .floating:
            return MeetingDetachedSelfLayout.floatingSize(isCompact: isCompact)
        case .minimized:
            return CGSize(width: 92.0, height: 36.0)
        case .auto, .tile:
            return .zero
        }
    }

    private var dragScale: CGFloat {
#if SKIP
        return 1.0
#else
        return isDragging ? 1.035 : 1.0
#endif
    }

    var body: some View {
        GeometryReader { geometry in
            let translation = clampedDragTranslation(in: geometry.size)
            let origin = viewModel.state.selfViewCorner.origin(
                in: geometry.size,
                overlaySize: overlaySize,
                edgeInsets: edgeInsets
            )
            let offset = CGSize(
                width: origin.x + translation.width,
                height: origin.y + translation.height
            )

            ZStack(alignment: .topLeading) {
                overlayContent
                    .frame(width: overlaySize.width, height: overlaySize.height)
                    .clipped()
                    #if !SKIP
                    .contentShape(Rectangle())
                    #endif
                    .scaleEffect(dragScale)
                    .offset(offset)
                    .zIndex(20.0)
                    .gesture(dragGesture(in: geometry.size))
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
            #if !SKIP
            .animation(.interactiveSpring(response: 0.24, dampingFraction: 0.86), value: viewModel.state.selfViewCorner)
            .animation(.interactiveSpring(response: 0.18, dampingFraction: 0.82), value: isDragging)
            #endif
        }
    }

    @ViewBuilder
    private var overlayContent: some View {
        switch viewModel.state.resolvedSelfViewMode {
        case .floating:
            #if SKIP
            localTile
            #else
            localTile
                .shadow(color: ACMColors.blackOverlay(0.35), radius: 16, x: 0, y: 8)
            #endif
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
        #if SKIP
        let trackWrapper = localVideoTrack as? VideoTrackWrapper
        return ZStack(alignment: .topTrailing) {
            DetachedSelfVideoTile(
                displayName: viewModel.displayNameForUser(viewModel.state.userId),
                isMuted: viewModel.state.isMuted,
                isCameraOff: viewModel.state.isCameraOff,
                isHandRaised: viewModel.state.isHandRaised,
                isGhost: viewModel.state.isGhostMode,
                isSpeaking: viewModel.state.isEffectiveActiveSpeaker(viewModel.state.userId),
                avatarSize: MeetingDetachedSelfLayout.floatingAvatarSize(isCompact: isCompact),
                trackId: trackWrapper?.id,
                hasTrack: trackWrapper?.rtcVideoTrack != nil,
                localCameraFacing: viewModel.localCameraFacing,
                trackWrapper: trackWrapper
            )
            .equatable()

            selfCameraSwitchButton
        }
        #else
        let captureSession = (!viewModel.state.isCameraOff && localVideoTrack == nil) ? viewModel.webRTCClient.getCaptureSession() : nil
        return ZStack(alignment: .topTrailing) {
            VideoGridItem(
                displayName: viewModel.displayNameForUser(viewModel.state.userId),
                isMuted: viewModel.state.isMuted,
                isCameraOff: viewModel.state.isCameraOff,
                isHandRaised: viewModel.state.isHandRaised,
                isGhost: viewModel.state.isGhostMode,
                isSpeaking: viewModel.state.isEffectiveActiveSpeaker(viewModel.state.userId),
                isLocal: true,
                isThumbnail: true,
                avatarSizeOverride: MeetingDetachedSelfLayout.floatingAvatarSize(isCompact: isCompact),
                usePlatformOverlaySurface: true,
                localCameraFacing: viewModel.localCameraFacing,
                captureSession: captureSession,
                localVideoTrack: localVideoTrack
            )

            selfCameraSwitchButton
        }
        #endif
    }

    @ViewBuilder
    private var selfCameraSwitchButton: some View {
        if !viewModel.state.isCameraOff && viewModel.canSwitchLocalCamera() {
            Button {
                viewModel.switchLocalCamera()
            } label: {
                ACMSystemIcon.icon("arrow.triangle.2.circlepath.camera.fill", android: "camera.flip", size: 14, tint: "white")
                    .foregroundStyle(Color.white)
                    .frame(width: 30, height: 30)
                    .acmColorBackground(ACMColors.blackOverlay(0.56))
                    .clipShape(Circle())
                    .overlay {
                        Circle()
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.white.opacity(0.18))
                    }
            }
            .buttonStyle(.plain)
            .padding(6)
            .accessibilityLabel("Switch camera")
        }
    }

    private func dragGesture(in containerSize: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 1.0)
            .onChanged { value in
                if !isDragging {
                    isDragging = true
                }
                dragTranslation = clampedTranslation(value.translation, in: containerSize)
            }
            .onEnded { value in
                let finalTranslation = clampedTranslation(value.translation, in: containerSize)
                let targetCorner = viewModel.state.selfViewCorner.snappedCorner(
                    after: finalTranslation,
                    in: containerSize,
                    overlaySize: overlaySize,
                    edgeInsets: edgeInsets
                )
                #if SKIP
                viewModel.setSelfViewCorner(targetCorner)
                dragTranslation = .zero
                isDragging = false
                #else
                withAnimation(.interactiveSpring(response: 0.24, dampingFraction: 0.86)) {
                    viewModel.setSelfViewCorner(targetCorner)
                    dragTranslation = .zero
                    isDragging = false
                }
                #endif
            }
    }

    private func clampedDragTranslation(in containerSize: CGSize) -> CGSize {
        clampedTranslation(dragTranslation, in: containerSize)
    }

    private func clampedTranslation(_ translation: CGSize, in containerSize: CGSize) -> CGSize {
        guard overlaySize.width > 0.0, overlaySize.height > 0.0 else { return .zero }
        let origin = viewModel.state.selfViewCorner.origin(
            in: containerSize,
            overlaySize: overlaySize,
            edgeInsets: edgeInsets
        )
        let minX = edgeInsets.leading - origin.x
        let maxX = max(
            minX,
            containerSize.width - overlaySize.width - edgeInsets.trailing - origin.x
        )
        let minY = edgeInsets.top - origin.y
        let maxY = max(
            minY,
            containerSize.height - overlaySize.height - edgeInsets.bottom - origin.y
        )
        return CGSize(
            width: min(max(translation.width, minX), maxX),
            height: min(max(translation.height, minY), maxY)
        )
    }
}

#if SKIP
private struct DetachedSelfVideoTile: View, Equatable {
    let displayName: String
    let isMuted: Bool
    let isCameraOff: Bool
    let isHandRaised: Bool
    let isGhost: Bool
    let isSpeaking: Bool
    let avatarSize: CGFloat
    let trackId: String?
    let hasTrack: Bool
    let localCameraFacing: LocalCameraFacing
    let trackWrapper: VideoTrackWrapper?

    var body: some View {
        VideoGridItem(
            displayName: displayName,
            isMuted: isMuted,
            isCameraOff: isCameraOff,
            isHandRaised: isHandRaised,
            isGhost: isGhost,
            isSpeaking: isSpeaking,
            isLocal: true,
            isThumbnail: true,
            avatarSizeOverride: avatarSize,
            usePlatformOverlaySurface: true,
            localCameraFacing: localCameraFacing,
            localVideoTrack: trackWrapper
        )
    }

    static func == (lhs: DetachedSelfVideoTile, rhs: DetachedSelfVideoTile) -> Bool {
        lhs.displayName == rhs.displayName &&
            lhs.isMuted == rhs.isMuted &&
            lhs.isCameraOff == rhs.isCameraOff &&
            lhs.isHandRaised == rhs.isHandRaised &&
            lhs.isGhost == rhs.isGhost &&
            lhs.isSpeaking == rhs.isSpeaking &&
            lhs.avatarSize == rhs.avatarSize &&
            lhs.trackId == rhs.trackId &&
            lhs.hasTrack == rhs.hasTrack &&
            lhs.localCameraFacing == rhs.localCameraFacing
    }
}
#endif

enum MeetingDetachedSelfLayout {
    static let regularFloatingSize = CGSize(width: 150.0, height: 88.0)
    static let compactFloatingSize = CGSize(width: 136.0, height: 80.0)
    static let regularFloatingAvatarSize: CGFloat = 32.0
    static let compactFloatingAvatarSize: CGFloat = 28.0
    static let compactBottomInset: CGFloat = 132.0

    static func floatingSize(isCompact: Bool) -> CGSize {
        isCompact ? compactFloatingSize : regularFloatingSize
    }

    static func floatingAvatarSize(isCompact: Bool) -> CGFloat {
        isCompact ? compactFloatingAvatarSize : regularFloatingAvatarSize
    }

    static func edgeInsets(isCompact: Bool, top: CGFloat = 16.0, horizontal: CGFloat = 16.0) -> EdgeInsets {
        EdgeInsets(
            top: top,
            leading: horizontal,
            bottom: isCompact ? compactBottomInset : 16.0,
            trailing: horizontal
        )
    }

    static func spotlightEdgeInsets(isCompact: Bool, top: CGFloat = 16.0, horizontal: CGFloat = 16.0) -> EdgeInsets {
        EdgeInsets(
            top: top,
            leading: horizontal,
            bottom: isCompact ? compactBottomInset : 16.0,
            trailing: horizontal
        )
    }
}

private extension MeetingSelfViewCorner {
    func origin(in containerSize: CGSize, overlaySize: CGSize, edgeInsets: EdgeInsets) -> CGPoint {
        let minX = edgeInsets.leading
        let minY = edgeInsets.top
        let maxX = max(minX, containerSize.width - overlaySize.width - edgeInsets.trailing)
        let maxY = max(minY, containerSize.height - overlaySize.height - edgeInsets.bottom)
        switch self {
        case .topLeft:
            return CGPoint(x: minX, y: minY)
        case .topRight:
            return CGPoint(x: maxX, y: minY)
        case .bottomLeft:
            return CGPoint(x: minX, y: maxY)
        case .bottomRight:
            return CGPoint(x: maxX, y: maxY)
        }
    }

    func snappedCorner(
        after translation: CGSize,
        in containerSize: CGSize,
        overlaySize: CGSize,
        edgeInsets: EdgeInsets
    ) -> MeetingSelfViewCorner {
        let origin = origin(in: containerSize, overlaySize: overlaySize, edgeInsets: edgeInsets)
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
