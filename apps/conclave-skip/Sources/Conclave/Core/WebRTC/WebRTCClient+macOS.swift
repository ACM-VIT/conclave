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
    /// producer of that kind, "audio" or "video", or "screen" for a screen
    /// producer (the stub has none by default).
    var testClosesLocalMedia: (@MainActor (String) -> Bool)?
    /// Host-test seam modelling the real clients' media session: `configure`
    /// and `cleanup` bump it at entry, a teardown or close drops the local
    /// producers, and a start commits its producer only if no teardown
    /// landed while it was held.
    private(set) var configurationGeneration = 0
    /// Host-test seam: synchronous media calls, which cannot pass the async
    /// gate, are reported here.
    var testCallLog: (@MainActor (String) -> Void)?
    /// Host-test seam modelling the real clients' microphone (off by
    /// default). An unmute or a microphone start commits a live microphone
    /// after its gate only if no local mute (`setAudioEnabled(false)`,
    /// `suspendLocalAudioForRecovery()`) landed meanwhile, as both clients
    /// fence by `localAudioMuteIntentGeneration`, and it reports that through
    /// `onLocalAudioEnabledChanged`, as they do.
    var testModelsLocalAudioState = false
    /// Host-test seam modelling the real clients' camera state reports (off
    /// by default): a committed camera start reports on, and a close or a
    /// suspend reports off, through `onLocalVideoEnabledChanged`. Unlike the
    /// real clients, a start here does not cancel itself on a camera-off; the
    /// view model must not rely on that.
    var testReportsLocalVideoState = false
    /// Host-test seam: whether `canSwitchCamera()` finds a second camera.
    var testCanSwitchCamera = false
    /// Host-test seam: local state reports this stub made to a listener, so
    /// a test can wait until the view model has handled every one.
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
        // Both clients drop a start that a mute overtook.
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
            // Both clients silence a mute before its acknowledgement.
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
    /// Host-test seam: the one awaited media-layer call of the host build's
    /// screen-share toggle, which has no screen capture.
    func testUnsupportedScreenShare() async { try? await testCallGate?("screenShare") }
    func closeLocalMedia(kind: String, type: String, producerId: String? = nil) async -> Bool {
        // A screen producer is "screen" to the seam and in the call log.
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
            // The stub models no screen capture state.
            break
        }
        // The iOS client awaits the capture stop after clearing the producer.
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

    // S60 C6-1, C6-6, C6-7 (SET-2): the silent host has no microphone and plays nothing.
    var supportsLiveNoiseSuppressionChange: Bool { false }
    func applyNoiseSuppression(_ enabled: Bool) async -> Bool { false }
    func sampleLocalMicrophoneLevel() -> Double { 0 }
    func playTestTone() { }

    // S60 C6-3, C6-5, C6-9, D11 (SET-3): the silent host has no camera and no transports.
    /// Host-test seam: the Data Saver value of the last receive policy pass (C6-5).
    private(set) var testLastReceiveDataSaver = false
    /// Host-test seam: the reading `sampleConnectionStatsCounters()` returns (nil = no stats).
    var testConnectionStats: ConnectionStatsCounters?
    var mirrorsLocalVideo: Bool {
        LocalVideoMirrorPolicy.mirrors(isFront: currentCameraFacing == .front, preference: LocalVideoMirrorPreference.shared.isOn)
    }
    func cameraCaptureCapability() -> CameraCaptureCapability { CameraCaptureCapability.unknown }
    func sampleConnectionStatsCounters() -> ConnectionStatsCounters? { testConnectionStats }
}
#endif
