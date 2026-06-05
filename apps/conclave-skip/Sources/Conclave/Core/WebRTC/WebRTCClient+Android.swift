// SKIP SYMBOLFILE
#if SKIP
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

    func configure(socketManager: SocketIOManager, rtpCapabilities: RtpCapabilities) { fatalError() }
    func createTransports() async throws { fatalError() }
    func consumeProducer(producerId: String, producerUserId: String, producerType: String = "webcam") async throws { fatalError() }
    func closeConsumer(producerId: String, userId: String) { fatalError() }
    func updateVideoQuality(_ quality: VideoQuality) { fatalError() }
    func startProducingAudio() async throws { fatalError() }
    func startProducingVideo() async throws { fatalError() }
    func cleanup() async { fatalError() }
    func setAudioEnabled(_ enabled: Bool) async { fatalError() }
    func setVideoEnabled(_ enabled: Bool) async { fatalError() }

    func getCaptureSession() -> Any? { nil }
    func getLocalVideoTrack() -> Any? { nil }

    func sampleAudioLevels() -> [String: Double] { fatalError() }

    func availableAudioInputs() -> [AudioDevice] { fatalError() }
    func availableAudioOutputs() -> [AudioDevice] { fatalError() }
    func currentAudioInputId() -> String? { fatalError() }
    func currentAudioOutputId() -> String? { fatalError() }
    func selectAudioInput(_ deviceId: String) { fatalError() }
    func selectAudioOutput(_ deviceId: String) { fatalError() }
    func testSpeaker() { fatalError() }
}
#endif
