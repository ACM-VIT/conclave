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
    var onTransportConnectionStateChanged: ((String, String) -> Void)?
    var onCallAudioRouteChanged: (() -> Void)?
    var onLocalAudioProducerLost: (() -> Void)?
    var onLocalVideoProducerLost: (() -> Void)?

    private(set) var localAudioEnabled: Bool = false
    var hasLocalAudioProducer: Bool { false }
    var isLocalAudioPublishingHealthy: Bool { false }
    private(set) var localVideoEnabled: Bool = false
    var hasLocalVideoProducer: Bool { false }
    var currentCameraFacing: LocalCameraFacing { .front }
    var remoteVideoTracks: [String: VideoTrackWrapper] = [:]
    var isConfigured: Bool { false }
    func hasBrokenTransport() -> Bool { false }

    func configure(socketManager: SocketIOManager, rtpCapabilities: RtpCapabilities, iceServersJSON: String?) { }
    func createTransports() async throws { }
    func createReceiveTransport() async throws { }
    func restartIce() async -> Bool { false }
    func restartIce(transportKind: String) async -> Bool { false }
    func consumeProducer(producerId: String, producerUserId: String, producerKind: String? = nil, producerType: String = "webcam", preferHighWebcamLayer: Bool = false, initialReceiveConnectionQuality: ConnectionQuality = .unknown) async throws { }
    func closeConsumer(producerId: String, userId: String) { }
    func applyRemoteConsumerBandwidthPolicy(
        focusedUserIds: Set<String>,
        visibleUserIds: Set<String>,
        connectionQuality: ConnectionQuality,
        videoQuality: VideoQuality,
        receiveVideo: Bool
    ) async { }
    func updateVideoQuality(_ quality: VideoQuality) { }
    func applyLocalBandwidthProfile(connectionQuality: ConnectionQuality) { }
    func refreshLocalAudioProducerForBandwidthProfile(connectionQuality: ConnectionQuality) async { }
    func refreshLocalVideoProducerForBandwidthProfile(connectionQuality: ConnectionQuality) async { }
    func refreshLocalScreenProducerForBandwidthProfile(connectionQuality: ConnectionQuality) async { }
    func activateCallAudioSession() { }
    func startProducingAudio() async throws { }
    func startProducingVideo() async throws { }
    func cleanup(notifyLocalState: Bool = true) async { }
    func checkVideoFreezes() async { }
    func sampleConnectionQuality() -> ConnectionQuality { .unknown }
    func sampleConnectionQualitySample() -> ConnectionQualitySample {
        ConnectionQualitySample(
            publishQuality: .unknown,
            receiveQuality: .unknown,
            overallQuality: .unknown,
            screenSharePublishQuality: .unknown
        )
    }
    func consumerId(forProducer producerId: String) -> String? { nil }
    func closeConsumers(exceptProducerIds producerIds: [String]) { }
    func closeConsumers(userIdPrefix: String) { }
    func applyConsumerTelemetry(_ notification: ConsumerTelemetryNotification) { }
    func hasAudioConsumer(userIdPrefix: String) -> Bool { false }
    func setAudioConsumersEnabled(userIdPrefix: String, enabled: Bool) { }
    func setAudioEnabled(_ enabled: Bool) async throws { }
    func reassertLocalAudioProducerUnmuted() async throws { }
    func setVideoEnabled(_ enabled: Bool) async throws { }
    func canSwitchCamera() -> Bool { false }
    func setPreferredCameraFacing(_ facing: LocalCameraFacing) { }
    func switchCamera() async throws { }
    func closeLocalAudioProducer() async { }
    func closeLocalVideoProducer() async { }
    func closeLocalScreenProducer() async { }
    func closeLocalMedia(kind: String, type: String, producerId: String? = nil) async -> Bool { false }

    func getCaptureSession() -> Any? { nil }
    func getLocalVideoTrack() -> Any? { nil }
    func remoteVideoTrack(forUserId userId: String) -> VideoTrackWrapper? {
        let normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return nil }
        return remoteVideoTracks[normalized]
    }

    func sampleAudioLevels(localUserId: String? = nil) -> [String: Double] { [:] }

    func availableAudioInputs() -> [AudioDevice] { [] }
    func availableAudioOutputs() -> [AudioDevice] { [] }
    func currentAudioInputId() -> String? { nil }
    func currentAudioOutputId() -> String? { nil }
    func selectAudioInput(_ deviceId: String) { }
    func selectAudioOutput(_ deviceId: String) { }
    func testSpeaker() { }
}
#endif
