#if os(iOS) && !SKIP
import SwiftUI
#if canImport(WebRTC)
import UIKit
import WebRTC
#endif

// S20 14 c (WP3 bridge for the native call root behind the Debug `call` flag). The only stage file that reaches the
// live media client: it resolves the bound track by user id whenever the slot's `RendererBinding.videoKey` changes,
// and one `RTCMTLVideoView` per slot is created once and re-attached only when the track instance changes, so a
// consumer swap never recreates the surface (RR1, SC10's iOS half). Main thread only; never touches a sink inside a
// frame callback (RR6). The fixture never uses it (probes only).

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
                          fit: fit, isMirrored: isMirrored)
        #else
        Color.clear
        #endif
    }
}

#if canImport(WebRTC)
enum StageLiveTracks {
    /// The bound track for a slot, or nil while the binding is empty (camera off, no consumer yet).
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

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView()
        view.clipsToBounds = true
        view.isUserInteractionEnabled = false
        view.accessibilityIgnoresInvertColors = true
        apply(to: view)
        context.coordinator.attach(track: track, to: view)
        return view
    }

    func updateUIView(_ uiView: RTCMTLVideoView, context: Context) {
        context.coordinator.attach(track: track, to: uiView)
        apply(to: uiView)
    }

    static func dismantleUIView(_ uiView: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.attach(track: nil, to: uiView)
    }

    private func apply(to view: RTCMTLVideoView) {
        let mode: UIView.ContentMode = fit == StageVideoFit.fit ? .scaleAspectFit : .scaleAspectFill
        if view.videoContentMode != mode { view.videoContentMode = mode }
        let transform = isMirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity
        if view.transform != transform { view.transform = transform }
    }

    final class Coordinator {
        weak var attachedTrack: RTCVideoTrack?

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
