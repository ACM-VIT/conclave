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

    var testCallGate: (@MainActor (String) async throws -> Void)?

    var testClosesLocalMedia: (@MainActor (String) -> Bool)?

    private(set) var configurationGeneration = 0

    var testCallLog: (@MainActor (String) -> Void)?

    var testModelsLocalAudioState = false

    var testReportsLocalVideoState = false

    var testCanSwitchCamera = false

    private(set) var testLocalMediaReportCount = 0
    private var testLocalAudioMuteIntent = 0
    private var testLocalAudioLive = false

    private(set) var localAudioEnabled: Bool = false
    var hasLocalAudioProducer = false
    var isLocalAudioPublishingHealthy: Bool {
        testModelsLocalAudioState && hasLocalAudioProducer && testLocalAudioLive
    }
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
        receiveVideo: Bool,
        dataSaver: Bool = false
    ) async {
        testLastReceiveDataSaver = dataSaver
    }
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
        let muteIntent = testLocalAudioMuteIntent
        try await testCallGate?("startProducingAudio")
        guard generation == configurationGeneration else { return }
        guard testModelsLocalAudioState else {
            hasLocalAudioProducer = true
            return
        }

        guard muteIntent == testLocalAudioMuteIntent else { return }
        hasLocalAudioProducer = true
        testCommitLiveMicrophone()
    }
    func startProducingVideo() async throws {
        let generation = configurationGeneration
        try await testCallGate?("startProducingVideo")
        guard generation == configurationGeneration else { return }
        hasLocalVideoProducer = true
        testReportLocalVideo(true)
    }
    func cleanup(notifyLocalState: Bool = true, preserveCallAudioRouting: Bool = false) async {
        configurationGeneration += 1
        hasLocalAudioProducer = false
        hasLocalVideoProducer = false
        testLocalAudioLive = false
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
    func setAudioEnabled(_ enabled: Bool) async throws {
        let muteIntent = testLocalAudioMuteIntent
        if !enabled, testModelsLocalAudioState {

            testApplyLocalMute()
        }
        try await testCallGate?("setAudioEnabled(\(enabled))")
        guard testModelsLocalAudioState, enabled, hasLocalAudioProducer,
              muteIntent == testLocalAudioMuteIntent else { return }
        testCommitLiveMicrophone()
    }
    func suspendLocalAudioForRecovery() {
        testCallLog?("suspendLocalAudioForRecovery")
        if testModelsLocalAudioState {
            testApplyLocalMute()
            return
        }
        localAudioEnabled = false
        testReportLocalAudio(false)
    }
    func reassertLocalAudioProducerUnmuted() async throws { try await testCallGate?("reassertLocalAudioProducerUnmuted") }
    func setVideoEnabled(_ enabled: Bool) async throws { try await testCallGate?("setVideoEnabled(\(enabled))") }
    func suspendLocalVideoForRecovery() async {
        testReportLocalVideo(false)
        try? await testCallGate?("suspendLocalVideoForRecovery")
    }
    func canSwitchCamera() -> Bool { testCanSwitchCamera }
    func setPreferredCameraFacing(_ facing: LocalCameraFacing) { }
    func switchCamera() async throws { try await testCallGate?("switchCamera") }
    func closeLocalAudioProducer() async {
        hasLocalAudioProducer = false
        testLocalAudioLive = false
        try? await testCallGate?("closeLocalAudioProducer")
    }
    func closeLocalVideoProducer() async {
        hasLocalVideoProducer = false
        testReportLocalVideo(false)
        try? await testCallGate?("closeLocalVideoProducer")
    }
    func closeLocalScreenProducer() async { }

    func testUnsupportedScreenShare() async { try? await testCallGate?("screenShare") }
    func closeLocalMedia(kind: String, type: String, producerId: String? = nil) async -> Bool {

        let isScreen = type == ProducerType.screen.rawValue
        let name = isScreen ? "screen" : kind
        guard testClosesLocalMedia?(name) == true else {
            testCallLog?("closeLocalMedia(\(name))")
            return false
        }
        switch name {
        case "audio":
            hasLocalAudioProducer = false
            testLocalAudioLive = false
        case "video":
            hasLocalVideoProducer = false
            testReportLocalVideo(false)
        default:

            break
        }

        try? await testCallGate?("closeLocalMedia(\(name))")
        return true
    }

    private func testApplyLocalMute() {
        testLocalAudioMuteIntent += 1
        testLocalAudioLive = false
        localAudioEnabled = false
        testReportLocalAudio(false)
    }

    private func testCommitLiveMicrophone() {
        testCallLog?("microphoneLive")
        testLocalAudioLive = true
        localAudioEnabled = true
        testReportLocalAudio(true)
    }

    private func testReportLocalAudio(_ enabled: Bool) {
        guard let listener = onLocalAudioEnabledChanged else { return }
        testLocalMediaReportCount += 1
        listener(enabled)
    }

    private func testReportLocalVideo(_ enabled: Bool) {
        guard testReportsLocalVideoState else { return }
        localVideoEnabled = enabled
        guard let listener = onLocalVideoEnabledChanged else { return }
        testLocalMediaReportCount += 1
        listener(enabled)
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

    var supportsLiveNoiseSuppressionChange: Bool { false }
    func applyNoiseSuppression(_ enabled: Bool) async -> Bool { false }
    func sampleLocalMicrophoneLevel() -> Double { 0 }
    func playTestTone() { }

    private(set) var testLastReceiveDataSaver = false

    var testConnectionStats: ConnectionStatsCounters?
    var mirrorsLocalVideo: Bool {
        LocalVideoMirrorPolicy.mirrors(isFront: currentCameraFacing == .front, preference: LocalVideoMirrorPreference.shared.isOn)
    }
    func cameraCaptureCapability() -> CameraCaptureCapability { CameraCaptureCapability.unknown }
    func sampleConnectionStatsCounters() -> ConnectionStatsCounters? { testConnectionStats }
}
#endif
