#if os(iOS) && !SKIP
import SwiftUI
#if canImport(WebRTC)
import UIKit
import WebRTC
#endif

struct StageLiveVideo: View {
    let slotId: String
    let userId: String
    let isLocal: Bool
    let isShare: Bool
    let videoKey: String
    let fit: StageVideoFit
    let isMirrored: Bool
    let avatarSeed: String
    let isSpotlight: Bool

    var body: some View {
        #if canImport(WebRTC)
        if !isLocal, !isShare, !videoKey.isEmpty,
           let wrapper = MeetingViewModel.shared.webRTCClient.remoteVideoTrack(forUserId: userId) {
            StageLiveRemoteVideo(wrapper: wrapper, slotId: slotId, fit: fit, avatarSeed: avatarSeed, isSpotlight: isSpotlight)
        } else {
            StageVideoSurface(track: StageLiveTracks.track(userId: userId, isLocal: isLocal, isShare: isShare, videoKey: videoKey),
                              fit: fit, isMirrored: isMirrored, slotId: slotId)
        }
        #else
        Color.clear
        #endif
    }
}

#if canImport(WebRTC)
private struct StageLiveRemoteVideo: View {
    @ObservedObject var wrapper: VideoTrackWrapper
    let slotId: String
    let fit: StageVideoFit
    let avatarSeed: String
    let isSpotlight: Bool

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                StageVideoSurface(track: wrapper.rtcVideoTrack, fit: fit, isMirrored: false, slotId: slotId)
                if !wrapper.isReceivingFrames {
                    let density = TileChromePolicy.density(width: Double(proxy.size.width), height: Double(proxy.size.height),
                                                           isSpotlight: isSpotlight)
                    HostingTheme.token(DesignTokens.iosInCallTile)
                    ConclaveAvatar(identity: ConclaveAvatarIdentity.fromSeed(avatarSeed), size: .tile,
                                   diameter: CGFloat(TileChromePolicy.avatarSize(density)))
                }
            }
        }
    }
}

enum StageLiveTracks {

    @MainActor
    static func track(userId: String, isLocal: Bool, isShare: Bool, videoKey: String) -> RTCVideoTrack? {
        if videoKey.isEmpty { return nil }
        let client = MeetingViewModel.shared.webRTCClient
        if isLocal && !isShare {
            return client.getLocalVideoTrack()
        }
        let consumerUserId = isShare ? userId + "-screen" : userId
        return client.remoteVideoTrack(forUserId: consumerUserId)?.rtcVideoTrack
    }
}

struct StageVideoSurface: UIViewRepresentable {
    let track: RTCVideoTrack?
    let fit: StageVideoFit
    let isMirrored: Bool

    var slotId: String = ""

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView()
        view.backgroundColor = UIColor(HostingTheme.token(DesignTokens.iosInCallStage))
        view.clipsToBounds = true
        view.isUserInteractionEnabled = false
        view.accessibilityIgnoresInvertColors = true
        apply(to: view)

        view.delegate = context.coordinator.sizes
        context.coordinator.sizes.configure(slotId: slotId, store: context.environment.rendererFrameSizes)
        context.coordinator.attach(track: track, to: view)
        return view
    }

    func updateUIView(_ uiView: RTCMTLVideoView, context: Context) {
        context.coordinator.attach(track: track, to: uiView)
        context.coordinator.sizes.configure(slotId: slotId, store: context.environment.rendererFrameSizes)
        apply(to: uiView)
    }

    static func dismantleUIView(_ uiView: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.attach(track: nil, to: uiView)
        coordinator.sizes.detach()
    }

    private func apply(to view: RTCMTLVideoView) {
        let mode: UIView.ContentMode = fit == StageVideoFit.fit ? .scaleAspectFit : .scaleAspectFill
        if view.videoContentMode != mode { view.videoContentMode = mode }
        let transform = isMirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity
        if view.transform != transform { view.transform = transform }
    }

    final class Coordinator {
        weak var attachedTrack: RTCVideoTrack?

        let sizes = RendererFrameSizeObserver()

        func attach(track: RTCVideoTrack?, to view: RTCMTLVideoView) {
            if attachedTrack === track { return }
            attachedTrack?.remove(view)
            attachedTrack = track
            track?.add(view)
        }
    }
}
#endif
#endif
