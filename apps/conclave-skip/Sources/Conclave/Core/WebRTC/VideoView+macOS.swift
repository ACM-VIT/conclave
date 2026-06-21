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
    var connectionStatus: ParticipantConnectionStatus? = nil
    var fillStage: Bool = false
    var isThumbnail: Bool = false

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
            let minAvatarSize: CGFloat = isThumbnail ? 34.0 : 44.0
            let maxAvatarSize: CGFloat = isThumbnail ? 48.0 : 240.0
            let avatarSize = min(max((geo.size.width + geo.size.height) * 0.10, minAvatarSize), maxAvatarSize)
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
                Image(systemName: "theatermasks.fill")
                    .font(.system(size: isThumbnail ? 24.0 : 48.0))
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
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: isThumbnail ? 12.0 : 14.0))
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
                        Image(systemName: "mic.slash.fill")
                            .font(.system(size: isThumbnail ? 9.0 : 10.0, weight: .semibold))
                            .foregroundStyle(ACMColors.error)
                    }

                    Text(isLocal ? "You" : displayName)
                        .font(ACMFont.trial(isThumbnail ? 11.0 : 12.0, weight: .medium))
                        .foregroundStyle(ACMColors.text)
                        .lineLimit(1)
                }
                .padding(.horizontal, isThumbnail ? 8.0 : 10.0)
                .padding(.vertical, isThumbnail ? 4.0 : 5.0)
                .acmColorBackground(ACMColors.scrim)
                .clipShape(RoundedRectangle(cornerRadius: isThumbnail ? 7.0 : 8.0))

                Spacer()
            }
            .padding(isThumbnail ? 6.0 : 10.0)
        }
    }
}
#endif
