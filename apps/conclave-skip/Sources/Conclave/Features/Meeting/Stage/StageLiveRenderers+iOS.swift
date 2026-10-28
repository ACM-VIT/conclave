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

    var body: some View {
        #if canImport(WebRTC)
        StageVideoSurface(track: StageLiveTracks.track(userId: userId, isLocal: isLocal, isShare: isShare, videoKey: videoKey),
                          fit: fit, isMirrored: isMirrored, slotId: slotId)
        #else
        Color.clear
        #endif
    }
}

#if canImport(WebRTC)
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
