#if os(macOS) && !SKIP
import Foundation

@MainActor
final class VideoTrackWrapper: Identifiable {
    let id: String
    let userId: String
    let isLocal: Bool

    var rtcVideoTrack: Any?
    var isEnabled: Bool = false

    init(id: String, userId: String, isLocal: Bool, track: Any? = nil) {
        self.id = id
        self.userId = userId
        self.isLocal = isLocal
        self.rtcVideoTrack = track
    }

    func setTrack(_ track: Any?) {
        self.rtcVideoTrack = track
    }
}

@MainActor
final class WebRTCClient {
    var onLocalAudioEnabledChanged: ((Bool) -> Void)?
    var onLocalVideoEnabledChanged: ((Bool) -> Void)?

    private(set) var localAudioEnabled: Bool = false
    private(set) var localVideoEnabled: Bool = false
    var remoteVideoTracks: [String: VideoTrackWrapper] = [:]

    func configure(socketManager: SocketIOManager, rtpCapabilities: RtpCapabilities) { }
    func createTransports() async throws { }
    func consumeProducer(producerId: String, producerUserId: String) async throws { }
    func closeConsumer(producerId: String, userId: String) { }
    func updateVideoQuality(_ quality: VideoQuality) { }
    func startProducingAudio() async throws { }
    func startProducingVideo() async throws { }
    func cleanup() async { }
    func setAudioEnabled(_ enabled: Bool) async { }
    func setVideoEnabled(_ enabled: Bool) async { }

    func getCaptureSession() -> Any? { nil }
    func getLocalVideoTrack() -> Any? { nil }
}
#endif
