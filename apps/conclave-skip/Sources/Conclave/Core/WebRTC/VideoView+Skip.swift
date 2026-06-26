#if SKIP
import SwiftUI
#if SKIP
import org.webrtc.__
#endif

struct LocalVideoView: View {
    let captureSession: Any?
    var isMirrored: Bool = true

    var body: some View {
        Color.black
    }
}

struct RTCLocalVideoView: View {
    let videoTrack: Any?
    var isMirrored: Bool = true

    var body: some View {
        Color.black
    }
}

struct RemoteVideoView: View {
    let trackWrapper: VideoTrackWrapper
    var contentMode: VideoContentMode = .fill
    var fallbackDisplayName: String = "Guest"

    var body: some View {
        ZStack {
            AndroidVideoView(trackWrapper: trackWrapper, isMirrored: false, contentMode: contentMode)
            if trackWrapper.rtcVideoTrack == nil {
                VideoTrackFallbackView(
                    displayName: MeetingState.mediaFallbackDisplayName(
                        fallbackDisplayName,
                        userId: trackWrapper.userId
                    ),
                    isEnabled: trackWrapper.isEnabled
                )
            }
        }
    }
}

private struct VideoTrackFallbackView: View {
    let displayName: String
    let isEnabled: Bool

    private var resolvedDisplayName: String {
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Guest" : trimmed
    }

    var body: some View {
        GeometryReader { geo in
            let avatarSize = min(max(min(geo.size.width, geo.size.height) * 0.28, 44.0), 112.0)

            ZStack {
                ACMColors.bgAlt

                Circle()
                    .fill(ACMColors.avatarColor(for: resolvedDisplayName))
                    .frame(width: avatarSize, height: avatarSize)
                    .overlay {
                        Text(String(resolvedDisplayName.prefix(1)).uppercased())
                            .font(.system(size: avatarSize * 0.40, weight: .bold))
                            .foregroundStyle(Color.white)
                    }

                if isEnabled {
                    ProgressView()
                        #if SKIP
                        .progressViewStyle(.circular)
                        #endif
                        .tint(Color.white)
                        .scaleEffect(0.8)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .padding(12)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }
}

struct VideoGridItem: View {
    let displayName: String
    let isMuted: Bool
    let isCameraOff: Bool
    let isHandRaised: Bool
    let isGhost: Bool
    let isSpeaking: Bool
    let isLocal: Bool
    var connectionStatus: ParticipantConnectionStatus? = nil
    // Expands camera-off avatars on stage while leaving video aspect handling to the renderer.
    var fillStage: Bool = false
    var isThumbnail: Bool = false
    var avatarSizeOverride: CGFloat? = nil
    var usePlatformOverlaySurface: Bool = false
    var localCameraFacing: LocalCameraFacing = .front

    var captureSession: Any? = nil
    var localVideoTrack: Any? = nil
    var trackWrapper: VideoTrackWrapper? = nil

    private var resolvedDisplayName: String {
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return trimmed
        }
        return isLocal ? "You" : "Guest"
    }

    private var avatarInitial: String {
        String(resolvedDisplayName.prefix(1)).uppercased()
    }

    var body: some View {
        aspectAdjustedContent
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .acmColorBackground(ACMColors.bgAlt)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.lg)
                    .strokeBorder(lineWidth: isSpeaking ? 2.0 : 1.0)
                    .foregroundStyle(isSpeaking ? ACMColors.primaryOrange : ACMColors.creamFaint)
            }
    }

    @ViewBuilder
    var aspectAdjustedContent: some View {
        // Fill the frame the parent assigns (grid cell / stage / thumbnail).
        // Video crops to fill; the avatar centres. No 16:9 letterbox gaps.
        ZStack { videoContent; overlays }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    var videoContent: some View {
        if isCameraOff {
            avatarView
        } else if isLocal,
                  let wrapper = localVideoTrack as? VideoTrackWrapper {
            androidVideoSlot(trackWrapper: wrapper, isMirrored: localCameraFacing.shouldMirrorLocalVideo)
        } else if let wrapper = trackWrapper {
            androidVideoSlot(trackWrapper: wrapper, isMirrored: false)
        } else {
            avatarView
        }
    }

    @ViewBuilder
    func androidVideoSlot(trackWrapper: VideoTrackWrapper, isMirrored: Bool) -> some View {
        ZStack {
            AndroidVideoView(
                trackWrapper: trackWrapper,
                isMirrored: isMirrored,
                useOverlaySurface: usePlatformOverlaySurface
            )
            if trackWrapper.rtcVideoTrack == nil {
                avatarView
            }
        }
    }

    var avatarView: some View {
        GeometryReader { geo in
            let labelClearance: CGFloat = isThumbnail ? 30.0 : 44.0
            let shortestSide = min(geo.size.width, max(1.0, geo.size.height - labelClearance))
            let minAvatarSize = min(isThumbnail ? 24.0 : 44.0, shortestSide)
            let maxAvatarSize = min(isThumbnail ? 40.0 : (fillStage ? 220.0 : 104.0), shortestSide)
            let proportionalSize = shortestSide * (isThumbnail ? 0.46 : 0.42)
            let avatarSize = min(max(avatarSizeOverride ?? proportionalSize, minAvatarSize), maxAvatarSize)

            ZStack {
                ACMColors.bgAlt

                Circle()
                    .fill(ACMColors.avatarColor(for: resolvedDisplayName))
                    .frame(width: avatarSize, height: avatarSize)
                    .overlay {
                        Text(avatarInitial)
                            .font(.system(size: avatarSize * 0.40, weight: .bold))
                            .foregroundStyle(Color.white)
                    }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    var overlays: some View {
        ZStack {
            if isGhost {
                ghostOverlay
            }

            if isHandRaised {
                handRaisedBadge
            }

            if let connectionStatus, !isLocal {
                connectionStatusBadge(connectionStatus)
            }

            nameLabel
        }
    }

    var ghostOverlay: some View {
        ZStack {
            ACMColors.blackOverlay(0.4)

            VStack(spacing: isThumbnail ? 4.0 : 8.0) {
                ACMSystemIcon.icon("theatermasks.fill", android: "ghost", size: isThumbnail ? 24.0 : 48.0)
                    .foregroundStyle(ACMColors.primaryPink)

                Text("Ghost")
                    .font(ACMFont.trial(isThumbnail ? 10.0 : 11.0, weight: .medium))
                    .foregroundStyle(ACMColors.primaryPink)
                    .padding(.horizontal, isThumbnail ? 8.0 : 12.0)
                    .padding(.vertical, isThumbnail ? 3.0 : 4.0)
                    .acmColorBackground(ACMColors.blackOverlay(0.6))
                    .overlay {
                        Capsule()
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.primaryPinkFaint)
                    }
                    .clipShape(Capsule())
            }
        }
    }

    var handRaisedBadge: some View {
        VStack {
            HStack {
                ACMSystemIcon.icon("hand.raised.fill", android: "raise.hand", size: isThumbnail ? 12.0 : 14.0)
                    .foregroundStyle(ACMColors.handRaised)
                    .padding(isThumbnail ? 6.0 : 8.0)
                    .acmColorBackground(ACMColors.handRaisedBackground)
                    .overlay {
                        Circle()
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.handRaisedBorder)
                    }
                    .clipShape(Circle())

                Spacer()
            }
            Spacer()
        }
        .padding(isThumbnail ? 6.0 : 12.0)
    }

    func connectionStatusBadge(_ status: ParticipantConnectionStatus) -> some View {
        let isReconnecting = status.state == .reconnecting
        let label = isReconnecting ? "Reconnecting" : "Back online"
        let tint = isReconnecting ? ACMColors.primaryOrange : ACMColors.success
        let androidTint = isReconnecting ? "accent" : "success"
        let icon = isReconnecting ? "exclamationmark.triangle.fill" : "checkmark.circle.fill"
        let androidIcon = isReconnecting ? "warning" : "check"

        return VStack {
            HStack {
                Spacer()

                HStack(spacing: isThumbnail ? 4.0 : 6.0) {
                    ACMSystemIcon.icon(icon, android: androidIcon, size: isThumbnail ? 12.0 : 14.0, tint: androidTint)
                        .foregroundStyle(tint)

                    Text(label)
                        .font(ACMFont.trial(isThumbnail ? 10.0 : 11.0, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                }
                .padding(.horizontal, isThumbnail ? 8.0 : 10.0)
                .padding(.vertical, isThumbnail ? 4.0 : 5.0)
                .acmColorBackground(ACMColors.scrim)
                .overlay {
                    Capsule()
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.creamFaint)
                }
                .clipShape(Capsule())

                Spacer()
            }
            .padding(.top, isThumbnail ? 6.0 : 10.0)

            Spacer()
        }
    }

    var nameLabel: some View {
        VStack {
            Spacer()

            HStack {
                HStack(spacing: 5) {
                    if isMuted {
                        ACMSystemIcon.icon("mic.slash.fill", android: "mic.off", size: isThumbnail ? 9.0 : 10.0)
                            .foregroundStyle(ACMColors.error)
                    }

                    Text(isLocal ? "You" : resolvedDisplayName)
                        .font(ACMFont.trial(isThumbnail ? 11.0 : 12.0, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                }
                .frame(maxWidth: isThumbnail ? 112.0 : 220.0, alignment: .leading)
                .shadow(color: ACMColors.blackOverlay(0.9), radius: 2.0, x: 0.0, y: 1.0)

                Spacer()
            }
            .padding(isThumbnail ? 6.0 : 10.0)
        }
    }
}

struct AndroidVideoView: View {
    let trackWrapper: VideoTrackWrapper
    var isMirrored: Bool
    var contentMode: VideoContentMode = .fill
    var useOverlaySurface = false
    var rendererKey: Any? = nil

    var body: some View {
        let fit = (contentMode == VideoContentMode.fit)
        let stableRendererKey = rendererKey ?? trackWrapper.id
        ComposeView { _ in
            #if SKIP
            VideoTrackView(
                track: trackWrapper.rtcVideoTrack as? org.webrtc.VideoTrack,
                mirror: isMirrored,
                fit: fit,
                useOverlaySurface: useOverlaySurface,
                rendererKey: stableRendererKey
            )
            #else
            VideoTrackView(track: nil, mirror: isMirrored, fit: fit)
            #endif
        }
    }
}
#endif
