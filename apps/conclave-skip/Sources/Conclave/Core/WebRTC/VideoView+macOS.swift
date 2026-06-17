#if os(macOS) && !SKIP
import SwiftUI

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
    }

    @ViewBuilder
    var aspectAdjustedContent: some View {
        // Fill the frame the parent assigns (grid cell / stage / thumbnail).
        ZStack { videoContent; overlays }
    }

    @ViewBuilder
    var videoContent: some View {
        if isCameraOff {
            avatarView
        } else if isLocal {
            Color.black
        } else {
            Color.black
        }
    }

    var avatarView: some View {
        GeometryReader { geo in
            let avatarSize = min(max((geo.size.width + geo.size.height) * 0.10, 44.0), 240.0)
            ZStack {
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

            nameLabel
        }
    }

    var ghostOverlay: some View {
        ZStack {
            ACMColors.blackOverlay(0.4)

            VStack(spacing: 8) {
                Image(systemName: "theatermasks.fill")
                    .font(.system(size: 48))
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
                Image(systemName: "hand.raised.fill")
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
                        Image(systemName: "mic.slash.fill")
                            .font(.system(size: 10, weight: .semibold))
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
#endif
