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
    var onTransportConnectionStateChanged: ((String, String) -> Void)?

    private(set) var localAudioEnabled: Bool = false
    private(set) var localVideoEnabled: Bool = false
    var remoteVideoTracks: [String: VideoTrackWrapper] = [:]
    var isConfigured: Bool { fatalError() }
    func hasBrokenTransport() -> Bool { fatalError() }

    func configure(socketManager: SocketIOManager, rtpCapabilities: RtpCapabilities, iceServersJSON: String?) { fatalError() }
    func createTransports() async throws { fatalError() }
    func restartIce() async -> Bool { fatalError() }
    func restartIce(transportKind: String) async -> Bool { fatalError() }
    func consumeProducer(producerId: String, producerUserId: String, producerKind: String? = nil, producerType: String = "webcam", preferHighWebcamLayer: Bool = false) async throws { fatalError() }
    func closeConsumer(producerId: String, userId: String) { fatalError() }
    func applyRemoteConsumerBandwidthPolicy(
        focusedUserIds: Set<String>,
        visibleUserIds: Set<String>,
        connectionQuality: ConnectionQuality,
        videoQuality: VideoQuality
    ) async { fatalError() }
    func updateVideoQuality(_ quality: VideoQuality) { fatalError() }
    func applyLocalBandwidthProfile(connectionQuality: ConnectionQuality) { fatalError() }
    func refreshLocalAudioProducerForBandwidthProfile(connectionQuality: ConnectionQuality) async { fatalError() }
    func refreshLocalVideoProducerForBandwidthProfile(connectionQuality: ConnectionQuality) async { fatalError() }
    func refreshLocalScreenProducerForBandwidthProfile(connectionQuality: ConnectionQuality) async { fatalError() }
    func startProducingAudio() async throws { fatalError() }
    func startProducingVideo() async throws { fatalError() }
    func cleanup(notifyLocalState: Bool = true) async { fatalError() }
    func checkVideoFreezes() async { fatalError() }
    func refreshVideoDecoders(userId: String? = nil) async { fatalError() }
    func sampleConnectionQuality() -> ConnectionQuality { fatalError() }
    func sampleConnectionQualitySample() -> ConnectionQualitySample { fatalError() }
    func consumerId(forProducer producerId: String) -> String? { fatalError() }
    func closeConsumers(exceptProducerIds producerIds: [String]) { fatalError() }
    func hasAudioConsumer(userIdPrefix: String) -> Bool { fatalError() }
    func setAudioConsumersEnabled(userIdPrefix: String, enabled: Bool) { fatalError() }
    func setAudioEnabled(_ enabled: Bool) async throws { fatalError() }
    func setVideoEnabled(_ enabled: Bool) async throws { fatalError() }
    func closeLocalVideoProducer() async { fatalError() }
    func closeLocalScreenProducer() async { fatalError() }
    func closeLocalMedia(kind: String, type: String, producerId: String? = nil) async -> Bool { fatalError() }
    func startScreenSharing() async throws { fatalError() }
    func stopScreenSharing() async { fatalError() }

    func getCaptureSession() -> Any? { nil }
    func getLocalVideoTrack() -> Any? { nil }

    func sampleAudioLevels(localUserId: String? = nil) -> [String: Double] { fatalError() }

    func availableAudioInputs() -> [AudioDevice] { fatalError() }
    func availableAudioOutputs() -> [AudioDevice] { fatalError() }
    func currentAudioInputId() -> String? { fatalError() }
    func currentAudioOutputId() -> String? { fatalError() }
    func selectAudioInput(_ deviceId: String) { fatalError() }
    func selectAudioOutput(_ deviceId: String) { fatalError() }
    func testSpeaker() { fatalError() }
}
#endif
