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

    var body: some View {
        Color.black
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

    var captureSession: Any? = nil
    var localVideoTrack: Any? = nil
    var trackWrapper: VideoTrackWrapper? = nil

    var body: some View {
        ZStack {
            videoContent
            overlays
        }
        .aspectRatio(16.0 / 9.0, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: ACMRadius.lg))
        .overlay {
            RoundedRectangle(cornerRadius: ACMRadius.lg)
                .strokeBorder(lineWidth: isSpeaking ? 2.0 : 1.0)
                .foregroundStyle(isSpeaking ? ACMColors.primaryOrange : ACMColors.creamFaint)
        }
        .shadow(
            color: isSpeaking ? ACMColors.primaryOrangeSoft : Color.clear,
            radius: isSpeaking ? 15.0 : 0.0
        )
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
        ZStack {
            ACMGradients.cardBackground

            Circle()
                .fill(ACMGradients.avatarBackground)
                .frame(width: 64, height: 64)
                .overlay {
                    Circle()
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.creamSubtle)
                }
                .overlay {
                    Text(String(displayName.prefix(1)).uppercased())
                        .font(ACMFont.trial(24, weight: .bold))
                        .foregroundStyle(ACMColors.cream)
                }
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

            nameLabel
        }
    }

    var ghostOverlay: some View {
        ZStack {
            ACMColors.blackOverlay(0.4)

            VStack(spacing: 8) {
                ACMSystemIcon.image("theatermasks.fill", androidName: "Icons.Filled.Face")
                    .font(.system(size: 48))
                    .foregroundStyle(ACMColors.primaryPink)
                    .shadow(color: ACMColors.primaryPinkSoft, radius: 16.0)

                Text("GHOST")
                    .font(ACMFont.mono(10))
                    .tracking(2)
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
                ACMSystemIcon.image("hand.raised.fill", androidName: "Icons.Filled.ThumbUp")
                    .font(.system(size: 14))
                    .foregroundStyle(ACMColors.handRaised)
                    .padding(8)
                    .acmColorBackground(ACMColors.handRaisedBackground)
                    .overlay {
                        Circle()
                            .strokeBorder(lineWidth: 1)
                            .foregroundStyle(ACMColors.handRaisedBorder)
                    }
                    .clipShape(Circle())
                    .shadow(color: ACMColors.handRaisedShadow, radius: 8.0)

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
                HStack(spacing: 6) {
                    Text(displayName.uppercased())
                        .font(ACMFont.mono(11))
                        .foregroundStyle(ACMColors.cream)
                        .tracking(1)
                        .lineLimit(1)

                    if isLocal {
                        Text("YOU")
                            .font(ACMFont.mono(9))
                            .foregroundStyle(ACMColors.primaryOrangeDim)
                            .tracking(2)
                    }

                    if isMuted {
                        ACMSystemIcon.image("mic.slash.fill", androidName: "Icons.Filled.Close")
                            .font(.system(size: 10))
                            .foregroundStyle(ACMColors.primaryOrange)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .acmColorBackground(ACMColors.blackOverlay(0.7))
                .acmMaterialBackground(opacity: 0.3)
                .overlay {
                    Capsule()
                        .strokeBorder(lineWidth: 1)
                        .foregroundStyle(ACMColors.creamFaint)
                }
                .clipShape(Capsule())

                Spacer()
            }
            .padding(12)
        }
    }
}

struct AndroidVideoView: View {
    let trackWrapper: VideoTrackWrapper
    var isMirrored: Bool

    var body: some View {
        ComposeView { _ in
            #if SKIP
            VideoTrackView(track: trackWrapper.rtcVideoTrack as? org.webrtc.VideoTrack, mirror: isMirrored)
            #else
            VideoTrackView(track: nil, mirror: isMirrored)
            #endif
        }
    }
}
#endif
