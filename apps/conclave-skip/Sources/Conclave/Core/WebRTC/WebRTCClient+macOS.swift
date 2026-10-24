#if os(macOS) && !SKIP
import Foundation

@MainActor
final class VideoTrackWrapper: Identifiable {
    let id: String
    let userId: String
    let isLocal: Bool
    let consumerGeneration: Int

    var rtcVideoTrack: Any?
    var isEnabled: Bool = false

    init(
        id: String,
        userId: String,
        isLocal: Bool,
        track: Any? = nil,
        consumerGeneration: Int = 0
    ) {
        self.id = id
        self.userId = userId
        self.isLocal = isLocal
        self.rtcVideoTrack = track
        self.consumerGeneration = consumerGeneration
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

    /// Host-test seam (this macOS stub only; iOS and Android never compile
    /// it). The media calls the local toggles and a join attempt await pass
    /// through this gate, so a test can hold one mid-await, as a slow SFU
    /// acknowledgement would, and later release or fail it.
    var testCallGate: (@MainActor (String) async throws -> Void)?
    /// Host-test seam: whether `closeLocalMedia(kind:...)` finds a local
    /// producer of that kind (the stub has none by default).
    var testClosesLocalMedia: (@MainActor (String) -> Bool)?
    /// Host-test seam modelling the real clients' media session: `configure`
    /// and `cleanup` bump it at entry, a teardown or close drops the local
    /// producers, and a start commits its producer only if no teardown
    /// landed while it was held.
    private(set) var configurationGeneration = 0

    private(set) var localAudioEnabled: Bool = false
    var hasLocalAudioProducer = false
    var isLocalAudioPublishingHealthy: Bool { false }
    private(set) var localVideoEnabled: Bool = false
    var hasLocalVideoProducer = false
    var currentCameraFacing: LocalCameraFacing { .front }
    var remoteVideoTracks: [String: VideoTrackWrapper] = [:]
    var isConfigured = false
    func hasBrokenTransport() -> Bool { false }

    func configure(socketManager: SocketIOManager, rtpCapabilities: RtpCapabilities, iceServersJSON: String?) {
        configurationGeneration += 1
    }
    func createTransports() async throws { }
    func createReceiveTransport() async throws { }
    func restartIce() async -> Bool { false }
    func restartIce(transportKind: String) async -> Bool { false }
    func consumeProducer(producerId: String, producerUserId: String, producerKind: String? = nil, producerType: String = "webcam", preferHighWebcamLayer: Bool = false, initialReceiveConnectionQuality: ConnectionQuality = .unknown, roomId: String? = nil, meetingLifecycleGeneration: Int = 0) async throws { }
    func closeConsumer(producerId: String, userId: String) { }
    func applyRemoteConsumerBandwidthPolicy(
        focusedUserIds: Set<String>,
        visibleUserIds: Set<String>,
        connectionQuality: ConnectionQuality,
        videoQuality: VideoQuality,
        receiveVideo: Bool
    ) async { }
    func updateVideoQuality(_ quality: VideoQuality) { }
    func updateMediaPublishConfiguration(
        cameraWidth: Int,
        cameraHeight: Int,
        cameraFrameRate: Int,
        cameraMaxBitrateBps: Int,
        cameraContentHint: String,
        cameraDegradationPreference: String,
        screenMaxWidth: Int,
        screenMaxHeight: Int,
        screenFrameRate: Int,
        screenMaxBitrateBps: Int,
        screenContentHint: String,
        screenDegradationPreference: String
    ) { }
    func refreshLocalMediaForQualitySettings() async { }
    func applyLocalBandwidthProfile(connectionQuality: ConnectionQuality) { }
    func refreshLocalAudioProducerForBandwidthProfile(connectionQuality: ConnectionQuality) async { }
    func refreshLocalVideoProducerForBandwidthProfile(connectionQuality: ConnectionQuality) async { }
    func refreshLocalScreenProducerForBandwidthProfile(connectionQuality: ConnectionQuality) async { }
    func activateCallAudioSession() { }
    func startProducingAudio() async throws {
        let generation = configurationGeneration
        try await testCallGate?("startProducingAudio")
        if generation == configurationGeneration { hasLocalAudioProducer = true }
    }
    func startProducingVideo() async throws {
        let generation = configurationGeneration
        try await testCallGate?("startProducingVideo")
        if generation == configurationGeneration { hasLocalVideoProducer = true }
    }
    func cleanup(notifyLocalState: Bool = true, preserveCallAudioRouting: Bool = false) async {
        configurationGeneration += 1
        hasLocalAudioProducer = false
        hasLocalVideoProducer = false
        try? await testCallGate?("cleanup(notifyLocalState: \(notifyLocalState))")
    }
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
    func hasConsumerGeneration(forProducer producerId: String) -> Bool { false }
    func waitForFirstDecodedVideoFrame(consumerId: String, timeoutMilliseconds: Int) async throws -> Bool { false }
    func cancelFirstDecodedVideoFrameObservation(consumerId: String) { }
    func closeConsumer(consumerId: String) { }
    func closeConsumers(exceptProducerIds producerIds: [String]) { }
    func closeConsumers(userIdPrefix: String) { }
    func applyConsumerTelemetry(_ notification: ConsumerTelemetryNotification) { }
    func handleWebcamReceiverCapacityProof(
        _ notification: WebcamReceiverCapacityProofNotification,
        expectedRoomId: String
    ) { }
    func invalidateWebcamReceiverCapacityAuthority() { }
    func consumeIntentionalLocalVideoProducerClose(producerId: String) -> Bool { false }
    func consumeIntentionalLocalAudioProducerClose(producerId: String) -> Bool { false }
    func hasAudioConsumer(userIdPrefix: String) -> Bool { false }
    func setAudioConsumersEnabled(userIdPrefix: String, enabled: Bool) { }
    func setAudioEnabled(_ enabled: Bool) async throws { try await testCallGate?("setAudioEnabled(\(enabled))") }
    func suspendLocalAudioForRecovery() {
        localAudioEnabled = false
        onLocalAudioEnabledChanged?(false)
    }
    func reassertLocalAudioProducerUnmuted() async throws { try await testCallGate?("reassertLocalAudioProducerUnmuted") }
    func setVideoEnabled(_ enabled: Bool) async throws { try await testCallGate?("setVideoEnabled(\(enabled))") }
    func suspendLocalVideoForRecovery() async { try? await testCallGate?("suspendLocalVideoForRecovery") }
    func canSwitchCamera() -> Bool { false }
    func setPreferredCameraFacing(_ facing: LocalCameraFacing) { }
    func switchCamera() async throws { }
    func closeLocalAudioProducer() async {
        hasLocalAudioProducer = false
        try? await testCallGate?("closeLocalAudioProducer")
    }
    func closeLocalVideoProducer() async {
        hasLocalVideoProducer = false
        try? await testCallGate?("closeLocalVideoProducer")
    }
    func closeLocalScreenProducer() async { }
    func closeLocalMedia(kind: String, type: String, producerId: String? = nil) async -> Bool {
        guard testClosesLocalMedia?(kind) == true else { return false }
        if kind == "audio" {
            hasLocalAudioProducer = false
        } else if type == ProducerType.webcam.rawValue {
            hasLocalVideoProducer = false
        }
        return true
    }

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
