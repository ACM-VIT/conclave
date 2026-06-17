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

    var body: some View {
        // Render the remote track on Android via the Compose SurfaceViewRenderer
        // (was a black stub) so remote video — incl. a screen-share — appears.
        AndroidVideoView(trackWrapper: trackWrapper, isMirrored: false, contentMode: contentMode)
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
    // Fills the tile (immersive solo avatar) when set AND camera off; video keeps 16:9.
    var fillStage: Bool = false

    var captureSession: Any? = nil
    var localVideoTrack: Any? = nil
    var trackWrapper: VideoTrackWrapper? = nil

    var body: some View {
        aspectAdjustedContent
            .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
            .overlay {
                RoundedRectangle(cornerRadius: ACMRadius.lg)
                    .strokeBorder(lineWidth: isSpeaking ? 2.0 : 1.0)
                    .foregroundStyle(isSpeaking ? ACMColors.primaryOrange : ACMColors.creamFaint)
            }
            // Ease the flat 2px orange active-speaker border in/out so it reads as
            // responsive rather than snapping (Zoom/Teams do ~120ms). No glow.
            .animation(.easeOut(duration: 0.12), value: isSpeaking)
    }

    @ViewBuilder
    var aspectAdjustedContent: some View {
        // Fill the frame the parent assigns (grid cell / stage / thumbnail).
        // Video crops to fill; the avatar centres. No 16:9 letterbox gaps.
        ZStack { videoContent; overlays }
    }

    @ViewBuilder
    var videoContent: some View {
        if isCameraOff {
            avatarView
        } else if isLocal, let wrapper = localVideoTrack as? VideoTrackWrapper {
            AndroidVideoView(trackWrapper: wrapper, isMirrored: true)
        } else if let wrapper = trackWrapper {
            AndroidVideoView(trackWrapper: wrapper, isMirrored: false)
        } else {
            Color.black
        }
    }

    var avatarView: some View {
        // Fixed avatar size (large on the solo/spotlight stage, compact in a grid
        // cell). Avoids a nested GeometryReader per tile — on Android those
        // stacked GeometryReaders re-trigger Skip's ComposeView ghosting (a faint
        // duplicate of the controls bar appeared across the top of the grid).
        let avatarSize: CGFloat = fillStage ? 200.0 : 84.0
        return ZStack {
            ACMColors.bgAlt

            Circle()
                .fill(ACMColors.avatarColor(for: displayName))
                .frame(width: avatarSize, height: avatarSize)
                .overlay {
                    Text(String(displayName.prefix(1)).uppercased())
                        .font(.system(size: avatarSize * 0.40, weight: .bold))
                        .foregroundStyle(Color.white)
                }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    var overlays: some View {
        ZStack {
            if isGhost {
                ghostOverlay
            }

            if isHandRaised {
                handRaisedBadge
            }

            nameLabel
        }
    }

    var ghostOverlay: some View {
        ZStack {
            ACMColors.blackOverlay(0.4)

            VStack(spacing: 8) {
                ACMSystemIcon.icon("theatermasks.fill", android: "ghost", size: 48)
                    .foregroundStyle(ACMColors.primaryPink)

                Text("Ghost")
                    .font(ACMFont.trial(11, weight: .medium))
                    .foregroundStyle(ACMColors.primaryPink)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
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
                ACMSystemIcon.icon("hand.raised.fill", android: "raise.hand", size: 14)
                    .foregroundStyle(ACMColors.handRaised)
                    .padding(8)
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
        .padding(12)
    }

    var nameLabel: some View {
        VStack {
            Spacer()

            HStack {
                HStack(spacing: 5) {
                    if isMuted {
                        ACMSystemIcon.icon("mic.slash.fill", android: "mic.off", size: 10)
                            .foregroundStyle(ACMColors.error)
                    }

                    Text(isLocal ? "You" : displayName)
                        .font(ACMFont.trial(12, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .acmColorBackground(ACMColors.scrim)
                .clipShape(RoundedRectangle(cornerRadius: 8))

                Spacer()
            }
            .padding(10)
        }
    }
}

struct AndroidVideoView: View {
    let trackWrapper: VideoTrackWrapper
    var isMirrored: Bool
    var contentMode: VideoContentMode = .fill

    var body: some View {
        let fit = (contentMode == VideoContentMode.fit)
        ComposeView { _ in
            #if SKIP
            VideoTrackView(track: trackWrapper.rtcVideoTrack as? org.webrtc.VideoTrack, mirror: isMirrored, fit: fit)
            #else
            VideoTrackView(track: nil, mirror: isMirrored, fit: fit)
            #endif
        }
    }
}
#endif
