import Foundation

enum ReplacementProducerCleanupPolicy {
    static func shouldCloseUncommittedReplacement(
        replacementProducerId: String?,
        currentProducerId: String?
    ) -> Bool {
        let replacement = replacementProducerId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !replacement.isEmpty else { return false }
        let current = currentProducerId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return replacement != current
    }
}

enum CallAudioRoutePolicy {
    static func shouldDefaultToSpeaker(
        selectedOutputId: String?,
        hasExternalOutputRoute: Bool
    ) -> Bool {
        let selectedOutputId = selectedOutputId?.trimmingCharacters(in: .whitespacesAndNewlines)
        if selectedOutputId == "speaker" {
            return true
        }
        if selectedOutputId == "receiver" {
            return false
        }
        if selectedOutputId?.isEmpty == false {
            return false
        }
        return !hasExternalOutputRoute
    }
}

#if os(iOS) && !SKIP && canImport(WebRTC)
import Combine
@preconcurrency import AVFoundation
import AudioToolbox
import Mediasoup
import WebRTC

// MARK: - Video Track Wrapper

@MainActor
final class VideoTrackWrapper: ObservableObject, Identifiable {
    let id: String
    let userId: String
    let isLocal: Bool

    @Published var rtcVideoTrack: RTCVideoTrack?

    @Published var isEnabled: Bool = true

    init(id: String, userId: String, isLocal: Bool, track: RTCVideoTrack? = nil) {
        self.id = id
        self.userId = userId
        self.isLocal = isLocal
        self.rtcVideoTrack = track
    }

    func setTrack(_ track: RTCVideoTrack?) {
        self.rtcVideoTrack = track
        self.isEnabled = track?.isEnabled ?? false
    }
}

// MARK: - WebRTC Client (Mediasoup)

@MainActor
final class WebRTCClient: NSObject, ObservableObject {

    // MARK: - Published State

    @Published private(set) var localVideoTrack: VideoTrackWrapper?
    var onLocalAudioEnabledChanged: ((Bool) -> Void)?
    var onLocalVideoEnabledChanged: ((Bool) -> Void)?
    var onTransportConnectionStateChanged: ((String, String) -> Void)?
    var onCallAudioRouteChanged: (() -> Void)?
    var onLocalAudioProducerLost: (() -> Void)?
    var onLocalVideoProducerLost: (() -> Void)?

    /// When true, mutating localAudioEnabled/localVideoEnabled does NOT fire the
    /// onLocal*EnabledChanged callbacks. The binding handlers hop through
    /// `Task { @MainActor }` (async), so on the reconnect-rejoin path a cleanup()
    /// that fired them would land AFTER the VM restored the user's mute/camera
    /// intent and flip it back - leaving an unmuted user rejoining muted. The
    /// rejoin teardown sets this via cleanup(notifyLocalState: false).
    private var suppressLocalStateCallbacks = false
    private(set) var localAudioEnabled: Bool = false {
        didSet { if !suppressLocalStateCallbacks { onLocalAudioEnabledChanged?(localAudioEnabled) } }
    }
    var hasLocalAudioProducer: Bool {
        isUsableProducer(audioProducer) &&
            sendTransport?.closed == false &&
            rtcLocalAudioTrack != nil
    }
    var isLocalAudioPublishingHealthy: Bool {
        hasLocalAudioProducer &&
            localAudioEnabled &&
            rtcLocalAudioTrack?.isEnabled == true
    }
    private(set) var localVideoEnabled: Bool = false {
        didSet { if !suppressLocalStateCallbacks { onLocalVideoEnabledChanged?(localVideoEnabled) } }
    }
    var hasLocalVideoProducer: Bool {
        isUsableProducer(videoProducer) &&
            sendTransport?.closed == false &&
            rtcLocalVideoTrack != nil &&
            videoCapturer != nil &&
            videoSource != nil
    }
    @Published private(set) var remoteVideoTracks: [String: VideoTrackWrapper] = [:]
    @Published private(set) var connectionState: RTCPeerConnectionState = .new

    // MARK: - Mediasoup Core

    var device: Device?
    private var runtimeIceServersJSON: String?
    private var configurationGeneration = 0
    /// True once configure() has set up the mediasoup Device for a session and
    /// before cleanup() tears it down. Lets the rejoin path detect a still-live
    /// prior session that must be torn down before reconfiguring.
    var isConfigured: Bool { device != nil }

    func hasBrokenTransport() -> Bool {
        transportConnectionStates.values.contains { state in
            state == "failed" || state == "disconnected" || state == "closed"
        }
    }

    var sendTransport: SendTransport?
    var receiveTransport: ReceiveTransport?
    var sendTransportId: String?
    var receiveTransportId: String?
    private var transportConnectionStates: [String: String] = [:]

    var audioProducer: Producer?
    var videoProducer: Producer?
    var screenProducer: Producer?

    struct ConsumerInfo {
        let consumer: Consumer
        let producerId: String
        let userId: String
        let kind: String
        let type: String
        // Key under which the video track is stored in remoteVideoTracks:
        // "{userId}" for webcam, "{userId}-screen" for a screen-share - so a
        // user's webcam and screen tracks coexist instead of overwriting.
        var trackKey: String = ""
    }

    var consumers: [String: ConsumerInfo] = [:]
    private var remoteConsumerPreferenceSignatures: [String: String] = [:]
    private var remoteConsumerLayerPreferenceUnsupportedIds: Set<String> = []
    private var remoteConsumerPreferenceInFlightIds: Set<String> = []
    private var remoteConsumerPreferenceRetryTask: Task<Void, Never>?
    private var remoteVideoReceiveEnabled = true
    private static let maxRemoteConsumerPreferenceUpdatesPerCycle = 8
    private static let remoteConsumerPreferenceEmitSpacingNanoseconds: UInt64 = 75_000_000
    private static let remoteConsumerPreferenceRetryDelayNanoseconds: UInt64 = 1_000_000_000

    /// The consumer id we hold for a remote producer (the consumers map is keyed
    /// by consumer id, not producer id). Used by the producer-sync safety net to
    /// re-assert resume on a consumer that may have been left server-paused.
    func consumerId(forProducer producerId: String) -> String? {
        for (id, info) in consumers where info.producerId == producerId {
            return id
        }
        return nil
    }

    func closeConsumers(exceptProducerIds producerIds: [String]) {
        let activeProducerIds = Set(producerIds)
        let staleConsumers = consumers.filter { _, info in
            !activeProducerIds.contains(info.producerId)
        }

        for (consumerId, info) in staleConsumers {
            removeConsumer(consumerId: consumerId, info: info, closeConsumer: true)
        }
    }

    func closeConsumers(userIdPrefix: String) {
        let prefix = userIdPrefix.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prefix.isEmpty else { return }

        let matchingConsumers = consumers.filter { _, info in
            info.userId.hasPrefix(prefix) || info.trackKey.hasPrefix(prefix)
        }

        for (consumerId, info) in matchingConsumers {
            removeConsumer(consumerId: consumerId, info: info, closeConsumer: true)
        }
    }

    func applyConsumerTelemetry(_ notification: ConsumerTelemetryNotification) {
        guard let info = consumers[notification.consumerId],
              info.producerId == notification.producerId else { return }

        if notification.event == "closed" {
            removeConsumer(
                consumerId: notification.consumerId,
                info: info,
                closeConsumer: true,
                notifyServer: false
            )
            return
        }

        remoteConsumerPreferenceSignatures[notification.consumerId] = RemoteConsumerPreference(
            spatialLayer: notification.preferredLayers?.spatialLayer,
            temporalLayer: notification.preferredLayers?.temporalLayer,
            priority: notification.priority,
            paused: notification.paused
        ).signature

        if notification.paused || notification.producerPaused {
            videoFreezeStats.removeValue(forKey: notification.consumerId)
        }
    }

    private func removeConsumer(
        consumerId: String,
        info: ConsumerInfo,
        closeConsumer: Bool,
        notifyServer: Bool = true
    ) {
        if closeConsumer {
            info.consumer.close()
            if notifyServer {
                socketManager?.closeConsumer(consumerId: consumerId)
            }
        }
        consumers.removeValue(forKey: consumerId)
        videoFreezeStats.removeValue(forKey: consumerId)
        remoteConsumerPreferenceSignatures.removeValue(forKey: consumerId)
        remoteConsumerLayerPreferenceUnsupportedIds.remove(consumerId)
        remoteConsumerPreferenceInFlightIds.remove(consumerId)

        let key = info.trackKey.isEmpty ? info.userId : info.trackKey
        if info.kind == "video", !key.isEmpty {
            remoteVideoTracks.removeValue(forKey: key)
        }
    }

    private struct RemoteConsumerPreference {
        let spatialLayer: Int?
        let temporalLayer: Int?
        let priority: Int
        let paused: Bool

        var signature: String {
            [
                spatialLayer.map(String.init) ?? "-",
                temporalLayer.map(String.init) ?? "-",
                String(priority),
                paused ? "1" : "0"
            ].joined(separator: ":")
        }

        var hasLayerPreference: Bool {
            spatialLayer != nil
        }

        var withoutLayerPreference: RemoteConsumerPreference {
            RemoteConsumerPreference(
                spatialLayer: nil,
                temporalLayer: nil,
                priority: priority,
                paused: paused
            )
        }
    }

    private struct PendingRemoteConsumerPreferenceUpdate {
        let consumerId: String
        let effectivePreference: RemoteConsumerPreference
        let previousSignature: String?
        let signature: String
        let urgency: Int
    }

    private struct InitialConsumerPreference {
        let spatialLayer: Int?
        let temporalLayer: Int?
        let priority: Int?
    }

    private func initialWebcamConsumerPreference(
        preferHighWebcamLayer: Bool
    ) -> InitialConsumerPreference {
        if preferHighWebcamLayer {
            switch currentLocalBandwidthQuality {
            case .good:
                return InitialConsumerPreference(
                    spatialLayer: 2,
                    temporalLayer: 2,
                    priority: 180
                )
            case .fair:
                return InitialConsumerPreference(
                    spatialLayer: 1,
                    temporalLayer: 2,
                    priority: 150
                )
            case .poor:
                return InitialConsumerPreference(
                    spatialLayer: 0,
                    temporalLayer: 1,
                    priority: 120
                )
            case .emergency:
                return InitialConsumerPreference(
                    spatialLayer: 0,
                    temporalLayer: 0,
                    priority: 145
                )
            case .unknown:
                break
            }
        }

        let temporalLayer: Int
        switch currentLocalBandwidthQuality {
        case .emergency, .poor:
            temporalLayer = 0
        default:
            temporalLayer = 1
        }

        let priority: Int
        switch currentLocalBandwidthQuality {
        case .good:
            priority = 100
        case .fair:
            priority = 90
        default:
            priority = 70
        }

        return InitialConsumerPreference(
            spatialLayer: 0,
            temporalLayer: temporalLayer,
            priority: priority
        )
    }

    private func initialScreenConsumerPreference(
        connectionQuality: ConnectionQuality
    ) -> InitialConsumerPreference {
        let temporalLayer: Int
        switch connectionQuality {
        case .emergency:
            temporalLayer = 1
        case .poor:
            temporalLayer = 1
        default:
            temporalLayer = 2
        }

        return InitialConsumerPreference(
            spatialLayer: 0,
            temporalLayer: temporalLayer,
            priority: 240
        )
    }

    private func initialConsumerPreference(
        producerKind: String?,
        producerType: String,
        preferHighWebcamLayer: Bool,
        initialReceiveConnectionQuality: ConnectionQuality
    ) -> InitialConsumerPreference {
        if producerKind == "audio" {
            return InitialConsumerPreference(
                spatialLayer: nil,
                temporalLayer: nil,
                priority: 255
            )
        }

        guard producerKind == "video" else {
            return InitialConsumerPreference(
                spatialLayer: nil,
                temporalLayer: nil,
                priority: nil
            )
        }

        if producerType == ProducerType.screen.rawValue {
            return initialScreenConsumerPreference(
                connectionQuality: initialReceiveConnectionQuality
            )
        }

        guard producerType == ProducerType.webcam.rawValue else {
            return InitialConsumerPreference(
                spatialLayer: nil,
                temporalLayer: nil,
                priority: nil
            )
        }

        return initialWebcamConsumerPreference(
            preferHighWebcamLayer: preferHighWebcamLayer
        )
    }

    private func isUnsupportedConsumerLayerPreferenceError(_ error: Error) -> Bool {
        let message = String(describing: error).lowercased()
        return message.contains("layer") ||
            message.contains("support") ||
            message.contains("simulcast") ||
            message.contains("svc")
    }

    private func isConsumerControlRateLimitError(_ error: Error) -> Bool {
        let message = String(describing: error).lowercased()
        return message.contains("too many consumer control requests") ||
            message.contains("retry shortly")
    }

    private func remoteConsumerPreferenceUrgency(
        info: ConsumerInfo,
        preference: RemoteConsumerPreference,
        focusedUserIds: Set<String>,
        visibleUserIds: Set<String>
    ) -> Int {
        if info.kind == "audio" { return 1000 }
        if info.type == ProducerType.screen.rawValue { return 990 }
        if focusedUserIds.contains(info.userId) { return 850 }
        if visibleUserIds.contains(info.userId) { return 750 }
        if !preference.paused { return 600 }
        return 250
    }

    private func scheduleRemoteConsumerPreferenceRetry(
        focusedUserIds: Set<String>,
        visibleUserIds: Set<String>,
        connectionQuality: ConnectionQuality,
        videoQuality: VideoQuality
    ) {
        guard remoteConsumerPreferenceRetryTask == nil else { return }

        remoteConsumerPreferenceRetryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: WebRTCClient.remoteConsumerPreferenceRetryDelayNanoseconds)
            guard let self, !Task.isCancelled else { return }
            self.remoteConsumerPreferenceRetryTask = nil
            await self.applyRemoteConsumerBandwidthPolicy(
                focusedUserIds: focusedUserIds,
                visibleUserIds: visibleUserIds,
                connectionQuality: connectionQuality,
                videoQuality: videoQuality,
                receiveVideo: self.remoteVideoReceiveEnabled
            )
        }
    }

    func applyRemoteConsumerBandwidthPolicy(
        focusedUserIds: Set<String>,
        visibleUserIds: Set<String>,
        connectionQuality: ConnectionQuality,
        videoQuality: VideoQuality,
        receiveVideo: Bool = true
    ) async {
        remoteVideoReceiveEnabled = receiveVideo
        guard let socketManager else { return }

        let shouldReceiveVideo = receiveVideo
        let consumerSnapshot = consumers
        let emergencyKeepWebcamUserId: String? = {
            guard connectionQuality == .emergency else { return nil }
            let webcamInfos = consumerSnapshot.values
                .filter { $0.kind == "video" && $0.type == ProducerType.webcam.rawValue }
                .sorted { $0.userId < $1.userId }
            if let focused = webcamInfos.first(where: { focusedUserIds.contains($0.userId) }) {
                return focused.userId
            }
            if let visible = webcamInfos.first(where: { visibleUserIds.contains($0.userId) }) {
                return visible.userId
            }
            return nil
        }()
        var pendingUpdates: [PendingRemoteConsumerPreferenceUpdate] = []
        for (consumerId, info) in consumerSnapshot {
            guard consumers[consumerId] != nil else { continue }
            guard let preference = remoteConsumerPreference(
                for: info,
                focusedUserIds: focusedUserIds,
                visibleUserIds: visibleUserIds,
                emergencyKeepWebcamUserId: emergencyKeepWebcamUserId,
                connectionQuality: connectionQuality,
                videoQuality: videoQuality,
                receiveVideo: shouldReceiveVideo
            ) else { continue }
            guard !remoteConsumerPreferenceInFlightIds.contains(consumerId) else { continue }

            let effectivePreference = remoteConsumerLayerPreferenceUnsupportedIds.contains(consumerId)
                ? preference.withoutLayerPreference
                : preference
            let previousSignature = remoteConsumerPreferenceSignatures[consumerId]
            let signature = effectivePreference.signature
            guard previousSignature != signature else { continue }

            pendingUpdates.append(PendingRemoteConsumerPreferenceUpdate(
                consumerId: consumerId,
                effectivePreference: effectivePreference,
                previousSignature: previousSignature,
                signature: signature,
                urgency: remoteConsumerPreferenceUrgency(
                    info: info,
                    preference: effectivePreference,
                    focusedUserIds: focusedUserIds,
                    visibleUserIds: visibleUserIds
                )
            ))
        }

        pendingUpdates.sort {
            if $0.urgency != $1.urgency {
                return $0.urgency > $1.urgency
            }
            return $0.consumerId < $1.consumerId
        }

        let updatesToSend = Array(pendingUpdates.prefix(Self.maxRemoteConsumerPreferenceUpdatesPerCycle))
        if pendingUpdates.count > updatesToSend.count {
            scheduleRemoteConsumerPreferenceRetry(
                focusedUserIds: focusedUserIds,
                visibleUserIds: visibleUserIds,
                connectionQuality: connectionQuality,
                videoQuality: videoQuality
            )
        }

        for (index, update) in updatesToSend.enumerated() {
            if Task.isCancelled { return }
            if index > 0 {
                try? await Task.sleep(nanoseconds: Self.remoteConsumerPreferenceEmitSpacingNanoseconds)
            }

            let consumerId = update.consumerId
            guard consumers[consumerId] != nil else { continue }
            remoteConsumerPreferenceInFlightIds.insert(consumerId)
            defer {
                remoteConsumerPreferenceInFlightIds.remove(consumerId)
            }

            do {
                try await socketManager.setConsumerPreferences(
                    consumerId: consumerId,
                    spatialLayer: update.effectivePreference.spatialLayer,
                    temporalLayer: update.effectivePreference.temporalLayer,
                    priority: update.effectivePreference.priority,
                    paused: update.effectivePreference.paused,
                    requestKeyFrame: update.previousSignature != nil && !update.effectivePreference.paused
                )
                if consumers[consumerId] != nil {
                    remoteConsumerPreferenceSignatures[consumerId] = update.signature
                }
            } catch {
                if isConsumerControlRateLimitError(error) {
                    scheduleRemoteConsumerPreferenceRetry(
                        focusedUserIds: focusedUserIds,
                        visibleUserIds: visibleUserIds,
                        connectionQuality: connectionQuality,
                        videoQuality: videoQuality
                    )
                    continue
                }

                if update.effectivePreference.hasLayerPreference,
                   isUnsupportedConsumerLayerPreferenceError(error) {
                    remoteConsumerLayerPreferenceUnsupportedIds.insert(consumerId)
                    let fallbackPreference = update.effectivePreference.withoutLayerPreference
                    do {
                        try await socketManager.setConsumerPreferences(
                            consumerId: consumerId,
                            spatialLayer: fallbackPreference.spatialLayer,
                            temporalLayer: fallbackPreference.temporalLayer,
                            priority: fallbackPreference.priority,
                            paused: fallbackPreference.paused,
                            requestKeyFrame: update.previousSignature != nil && !fallbackPreference.paused
                        )
                        if consumers[consumerId] != nil {
                            remoteConsumerPreferenceSignatures[consumerId] = fallbackPreference.signature
                        }
                    } catch {
                        if isConsumerControlRateLimitError(error) {
                            scheduleRemoteConsumerPreferenceRetry(
                                focusedUserIds: focusedUserIds,
                                visibleUserIds: visibleUserIds,
                                connectionQuality: connectionQuality,
                                videoQuality: videoQuality
                            )
                            continue
                        }
                        debugLog("[WebRTC] Failed to apply fallback consumer bandwidth policy: \(error)")
                    }
                    continue
                }
                debugLog("[WebRTC] Failed to apply consumer bandwidth policy: \(error)")
            }
        }
    }

    private func remoteConsumerPreference(
        for info: ConsumerInfo,
        focusedUserIds: Set<String>,
        visibleUserIds: Set<String>,
        emergencyKeepWebcamUserId: String?,
        connectionQuality: ConnectionQuality,
        videoQuality: VideoQuality,
        receiveVideo: Bool
    ) -> RemoteConsumerPreference? {
        if info.kind == "audio" {
            return RemoteConsumerPreference(
                spatialLayer: nil,
                temporalLayer: nil,
                priority: 255,
                paused: false
            )
        }

        guard info.kind == "video" else { return nil }

        if !receiveVideo {
            return RemoteConsumerPreference(
                spatialLayer: 0,
                temporalLayer: 0,
                priority: 8,
                paused: true
            )
        }

        if info.type == ProducerType.screen.rawValue {
            let temporalLayer: Int
            switch connectionQuality {
            case .emergency:
                temporalLayer = 1
            case .poor:
                temporalLayer = 1
            default:
                temporalLayer = 2
            }
            return RemoteConsumerPreference(
                spatialLayer: 0,
                temporalLayer: temporalLayer,
                priority: 240,
                paused: false
            )
        }

        guard info.type == ProducerType.webcam.rawValue else { return nil }

        let isFocused = focusedUserIds.contains(info.userId)
        let isVisible = isFocused || visibleUserIds.contains(info.userId)
        let isEmergency = connectionQuality == .emergency
        let emergencyKeepVideo = isEmergency && emergencyKeepWebcamUserId == info.userId
        let isPoor = isEmergency || connectionQuality == .poor
        let isFair = connectionQuality == .fair
        let isConstrained = isPoor || isFair || videoQuality == .low

        if isEmergency && !emergencyKeepVideo {
            return RemoteConsumerPreference(
                spatialLayer: 0,
                temporalLayer: 0,
                priority: 8,
                paused: true
            )
        }

        if !isVisible && (isPoor || videoQuality == .low) {
            return RemoteConsumerPreference(
                spatialLayer: 0,
                temporalLayer: 0,
                priority: 8,
                paused: true
            )
        }

        if isFocused {
            return RemoteConsumerPreference(
                spatialLayer: isEmergency ? 0 : (isConstrained ? 1 : 2),
                temporalLayer: isEmergency ? 0 : (isPoor ? 1 : 2),
                priority: isEmergency ? 145 : (isConstrained ? 150 : 180),
                paused: false
            )
        }

        if isVisible {
            return RemoteConsumerPreference(
                spatialLayer: isConstrained ? 0 : 1,
                temporalLayer: isEmergency ? 0 : (isPoor ? 1 : 2),
                priority: isEmergency ? 70 : (isConstrained ? 80 : 105),
                paused: false
            )
        }

        return RemoteConsumerPreference(
            spatialLayer: 0,
            temporalLayer: 1,
            priority: 35,
            paused: false
        )
    }

    // MARK: - RTP Capabilities (from server)

    var serverRtpCapabilities: RtpCapabilities?

    // MARK: - Media Sources and Tracks

    static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        let videoEncoderFactory = RTCDefaultVideoEncoderFactory()
        let videoDecoderFactory = RTCDefaultVideoDecoderFactory()
        return RTCPeerConnectionFactory(
            encoderFactory: videoEncoderFactory,
            decoderFactory: videoDecoderFactory
        )
    }()

    var videoSource: RTCVideoSource?
    var audioSource: RTCAudioSource?
    var videoCapturer: RTCCameraVideoCapturer?
    var rtcLocalVideoTrack: RTCVideoTrack?
    var rtcLocalAudioTrack: RTCAudioTrack?

    // MARK: - Camera State

    var currentCameraPosition: AVCaptureDevice.Position = .front
    var currentCameraFacing: LocalCameraFacing {
        currentCameraPosition == .front ? .front : .back
    }
    var captureSession: AVCaptureSession?
    private var currentVideoQuality: VideoQuality = .standard
    private var currentLocalBandwidthQuality: ConnectionQuality = .unknown
    private var audioProducerBandwidthQuality: ConnectionQuality = .unknown
    private var screenProducerBandwidthQuality: ConnectionQuality = .unknown
    private var audioBandwidthRefreshInFlight = false
    private var screenBandwidthRefreshInFlight = false
    private var audioCaptureReassertionTask: Task<Void, Never>?
    private var audioCaptureRestartTask: Task<Void, Never>?
    private var callAudioRouteNotificationTask: Task<Void, Never>?
    private var lastAppliedLocalBandwidthSignature: String?
    private var lastForwardedScreenFrameNs: UInt64 = 0
    private static let screenShareScalabilityMode = "L1T3"
    private static let screenShareTemporalLayerCount = 3

    private struct WebcamCaptureProfile {
        let width: Int32
        let height: Int32
        let fps: Float64
    }

    private struct WebcamEncodingSpec {
        let rid: String
        let scaleResolutionDownBy: Double
        let maxBitrateBps: Int
        let maxFramerate: Double
    }

    private struct ScreenShareEncodingCap {
        let maxBitrateBps: Int
        let maxFramerate: Double
    }

    private struct OpusCodecOptions: Encodable {
        let opusStereo: Bool
        let opusFec: Bool
        let opusDtx: Bool
        let opusMaxAverageBitrate: Int
        let opusPtime: Int
    }

    // MARK: - Audio Session

    var audioSession = AVAudioSession.sharedInstance()
    private var selectedAudioInputId: String?
    private var selectedAudioOutputId: String?
    private var localAudioTrackSequence = 0
    private var localVideoTrackSequence = 0
    private var screenVideoTrackSequence = 0

    // MARK: - Socket Manager Reference

    weak var socketManager: SocketIOManager?

    // MARK: - Setup

    func configure(socketManager: SocketIOManager, rtpCapabilities: RtpCapabilities, iceServersJSON: String?) {
        configurationGeneration += 1
        self.socketManager = socketManager
        self.serverRtpCapabilities = rtpCapabilities
        let trimmedIceServers = iceServersJSON?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.runtimeIceServersJSON = (trimmedIceServers?.isEmpty == false) ? trimmedIceServers : nil

        self.device = nil
        let device = Device(pcFactory: Self.factory)
        do {
            let capabilities = try encodeJSONString(rtpCapabilities)
            try device.load(with: capabilities)
            self.device = device
        } catch {
            debugLog("[WebRTC] Failed to load device capabilities: \(error)")
        }
    }

    // MARK: - Transport Creation

    func createTransports() async throws {
        try await createSendTransportIfNeeded()
        try await createReceiveTransportIfNeeded()
        debugLog("[WebRTC] Transports ready: send=\(sendTransportId ?? "nil"), recv=\(receiveTransportId ?? "nil")")
    }

    func createReceiveTransport() async throws {
        try await createReceiveTransportIfNeeded()
    }

    private func createSendTransportIfNeeded() async throws {
        guard let socket = socketManager,
              let device = device else {
            throw WebRTCError.notConfigured
        }
        if let sendTransport,
           sendTransport.closed == false,
           sendTransportId != nil {
            return
        }

        let generation = configurationGeneration
        let producerTransportParams = try await socket.createProducerTransport()
        guard generation == configurationGeneration else { throw WebRTCError.staleConfiguration }

        let nextSendTransport = try device.createSendTransport(
            id: producerTransportParams.id,
            iceParameters: try encodeJSONString(producerTransportParams.iceParameters),
            iceCandidates: try encodeJSONString(producerTransportParams.iceCandidates),
            dtlsParameters: try encodeJSONString(producerTransportParams.dtlsParameters),
            sctpParameters: nil,
            iceServers: runtimeIceServersJSON,
            appData: nil
        )
        nextSendTransport.delegate = self

        guard generation == configurationGeneration else {
            nextSendTransport.close()
            throw WebRTCError.staleConfiguration
        }

        sendTransport?.close()
        sendTransportId = producerTransportParams.id
        sendTransport = nextSendTransport

        debugLog("[WebRTC] Send transport ready: \(producerTransportParams.id)")
    }

    private func createReceiveTransportIfNeeded() async throws {
        guard let socket = socketManager,
              let device = device else {
            throw WebRTCError.notConfigured
        }
        if let receiveTransport,
           receiveTransport.closed == false,
           receiveTransportId != nil {
            return
        }

        let generation = configurationGeneration
        let consumerTransportParams = try await socket.createConsumerTransport()
        guard generation == configurationGeneration else { throw WebRTCError.staleConfiguration }

        let nextReceiveTransport = try device.createReceiveTransport(
            id: consumerTransportParams.id,
            iceParameters: try encodeJSONString(consumerTransportParams.iceParameters),
            iceCandidates: try encodeJSONString(consumerTransportParams.iceCandidates),
            dtlsParameters: try encodeJSONString(consumerTransportParams.dtlsParameters),
            sctpParameters: nil,
            iceServers: runtimeIceServersJSON,
            appData: nil
        )
        nextReceiveTransport.delegate = self

        guard generation == configurationGeneration else {
            nextReceiveTransport.close()
            throw WebRTCError.staleConfiguration
        }

        receiveTransport?.close()
        receiveTransportId = consumerTransportParams.id
        receiveTransport = nextReceiveTransport

        debugLog("[WebRTC] Receive transport ready: \(consumerTransportParams.id)")
    }

    func restartIce() async -> Bool {
        let producerReady = sendTransport != nil && sendTransportId != nil
        let consumerReady = receiveTransport != nil && receiveTransportId != nil
        guard producerReady || consumerReady else { return false }

        let producerRestarted = producerReady ? await restartIce(transportKind: "producer") : true
        let consumerRestarted = consumerReady ? await restartIce(transportKind: "consumer") : true
        return producerRestarted && consumerRestarted
    }

    func restartIce(transportKind: String) async -> Bool {
        guard let socket = socketManager else { return false }

        do {
            switch transportKind {
            case "producer":
                guard let transport = sendTransport, let transportId = sendTransportId else { return false }
                let response = try await socket.restartIce(transport: transportKind, transportId: transportId)
                let iceParameters = try encodeJSONString(response.iceParameters)
                try transport.restartICE(with: iceParameters)
            case "consumer":
                guard let transport = receiveTransport, let transportId = receiveTransportId else { return false }
                let response = try await socket.restartIce(transport: transportKind, transportId: transportId)
                let iceParameters = try encodeJSONString(response.iceParameters)
                try transport.restartICE(with: iceParameters)
            default:
                return false
            }
            debugLog("[WebRTC] \(transportKind) transport ICE restart succeeded")
            return true
        } catch {
            debugLog("[WebRTC] \(transportKind) transport ICE restart failed: \(error)")
            return false
        }
    }

    // MARK: - Produce Local Media

    func startProducingAudio() async throws {
        try await createSendTransportIfNeeded()
        guard let sendTransport = sendTransport else {
            throw WebRTCError.noTransport
        }
        let generation = configurationGeneration
        if hasLocalAudioProducer {
            try await setAudioEnabled(true)
            return
        }
        if audioProducer != nil || rtcLocalAudioTrack != nil || audioSource != nil {
            audioProducer?.close()
            audioProducer = nil
            audioProducerBandwidthQuality = .unknown
            audioCaptureReassertionTask?.cancel()
            audioCaptureReassertionTask = nil
            audioCaptureRestartTask?.cancel()
            audioCaptureRestartTask = nil
            rtcLocalAudioTrack?.isEnabled = false
            rtcLocalAudioTrack = nil
            audioSource = nil
            let previousSuppressLocalStateCallbacks = suppressLocalStateCallbacks
            suppressLocalStateCallbacks = true
            localAudioEnabled = false
            suppressLocalStateCallbacks = previousSuppressLocalStateCallbacks
        }

        try await ensureMicrophonePermission()
        guard generation == configurationGeneration else { throw WebRTCError.staleConfiguration }
        try configureCallAudioSession()

        let microphone = createMicrophoneAudioTrack()
        let producer = try createMicrophoneProducer(on: sendTransport, track: microphone.track)
        producer.resume()

        audioSource = microphone.source
        rtcLocalAudioTrack = microphone.track
        audioProducer = producer
        audioProducerBandwidthQuality = currentLocalBandwidthQuality
        localAudioEnabled = true
        scheduleLocalAudioCaptureReassertion()
        await markMicrophoneProducerUnmuted(producer.id, reason: "audio start")

        debugLog("[WebRTC] Audio producer created: \(producer.id)")
    }

    private func createMicrophoneAudioTrack() -> (source: RTCAudioSource, track: RTCAudioTrack) {
        let audioConstraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: [
                "googEchoCancellation": "true",
                "googAutoGainControl": "true",
                "googNoiseSuppression": "true",
                "googHighpassFilter": "true"
            ]
        )

        let source = Self.factory.audioSource(with: audioConstraints)
        localAudioTrackSequence += 1
        let track = Self.factory.audioTrack(with: source, trackId: "audio\(localAudioTrackSequence)")
        track.isEnabled = true
        return (source, track)
    }

    private func nextLocalVideoTrackId() -> String {
        localVideoTrackSequence += 1
        return "video\(localVideoTrackSequence)"
    }

    private func createMicrophoneProducer(
        on sendTransport: SendTransport,
        track: RTCAudioTrack
    ) throws -> Producer {
        let appData = try encodeJSONString(ProducerAppData(type: ProducerType.webcam.rawValue, paused: false))
        let producer = try requireRegisteredProducer(
            sendTransport.createProducer(
                for: track,
                encodings: nil,
                codecOptions: microphoneOpusCodecOptionsJSON(),
                codec: nil,
                appData: appData
            ),
            label: "microphone"
        )
        producer.delegate = self
        return producer
    }

    private func markMicrophoneProducerUnmuted(_ producerId: String, reason: String) async {
        do {
            try await socketManager?.toggleMute(producerId: producerId, paused: false)
        } catch {
            debugLog("[WebRTC] Failed to confirm microphone producer unmuted after \(reason): \(error)")
        }
    }

    private func microphoneOpusCodecOptionsJSON() throws -> String {
        try encodeJSONString(
            OpusCodecOptions(
                opusStereo: false,
                opusFec: true,
                opusDtx: true,
                opusMaxAverageBitrate: opusMaxAverageBitrate(connectionQuality: currentLocalBandwidthQuality),
                opusPtime: 20
            )
        )
    }

    private func opusMaxAverageBitrate(connectionQuality: ConnectionQuality) -> Int {
        switch connectionQuality {
        case .emergency:
            return 24_000
        case .poor:
            return 32_000
        case .fair:
            return 48_000
        case .good, .unknown:
            return 96_000
        }
    }

    private func ensureMicrophonePermission() async throws {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted:
                return
            case .denied:
                throw WebRTCError.permissionDenied
            case .undetermined:
                let granted = await withCheckedContinuation { continuation in
                    AVAudioApplication.requestRecordPermission { granted in
                        continuation.resume(returning: granted)
                    }
                }
                guard granted else { throw WebRTCError.permissionDenied }
            @unknown default:
                throw WebRTCError.permissionDenied
            }
        } else {
            switch audioSession.recordPermission {
            case .granted:
                return
            case .denied:
                throw WebRTCError.permissionDenied
            case .undetermined:
                let granted = await withCheckedContinuation { continuation in
                    audioSession.requestRecordPermission { granted in
                        continuation.resume(returning: granted)
                    }
                }
                guard granted else { throw WebRTCError.permissionDenied }
            @unknown default:
                throw WebRTCError.permissionDenied
            }
        }
    }

    func startProducingVideo() async throws {
        try await createSendTransportIfNeeded()
        guard let sendTransport = sendTransport else {
            throw WebRTCError.noTransport
        }
        let generation = configurationGeneration
        if hasLocalVideoProducer {
            try await setVideoEnabled(true)
            return
        }
        if videoProducer != nil || rtcLocalVideoTrack != nil || localVideoTrack != nil || videoSource != nil {
            videoProducer?.close()
            videoProducer = nil
            rtcLocalVideoTrack?.isEnabled = false
            rtcLocalVideoTrack = nil
            localVideoTrack?.isEnabled = false
            localVideoTrack = nil
            await videoCapturer?.stopCapture()
            videoCapturer = nil
            videoSource = nil
            localVideoEnabled = false
        }

        let status = AVCaptureDevice.authorizationStatus(for: .video)
        if status == .notDetermined {
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            if !granted {
                throw WebRTCError.permissionDenied
            }
        } else if status != .authorized {
            throw WebRTCError.permissionDenied
        }
        guard generation == configurationGeneration else { throw WebRTCError.staleConfiguration }

        let source = Self.factory.videoSource()
        let capturer = RTCCameraVideoCapturer(delegate: source)
        videoSource = source
        videoCapturer = capturer

        var pendingProducer: Producer?
        do {
            try startCameraCapture()

            let track = Self.factory.videoTrack(with: source, trackId: nextLocalVideoTrackId())
            track.isEnabled = true

            let appData = try encodeJSONString(ProducerAppData(type: ProducerType.webcam.rawValue, paused: false))
            let producer = try requireRegisteredProducer(
                sendTransport.createProducer(
                    for: track,
                    encodings: webcamEncodings(
                        for: currentVideoQuality,
                        connectionQuality: currentLocalBandwidthQuality
                    ),
                    codecOptions: nil,
                    codec: preferredVideoCodecJSON(),
                    appData: appData
                ),
                label: "camera"
            )
            pendingProducer = producer
            producer.delegate = self
            producer.resume()
            try? producer.setMaxSpatialLayer(
                webcamMaxSpatialLayer(
                    for: currentVideoQuality,
                    connectionQuality: currentLocalBandwidthQuality
                )
            )

            rtcLocalVideoTrack = track
            videoProducer = producer
            pendingProducer = nil
            localVideoEnabled = true

            let trackWrapper = VideoTrackWrapper(
                id: producer.id,
                userId: "local",
                isLocal: true,
                track: track
            )
            localVideoTrack = trackWrapper

            debugLog("[WebRTC] Video producer created: \(producer.id)")
        } catch {
            pendingProducer?.close()
            await capturer.stopCapture()
            videoCapturer = nil
            videoSource = nil
            rtcLocalVideoTrack = nil
            localVideoTrack = nil
            localVideoEnabled = false
            throw error
        }
    }

    func startCameraCapture() throws {
        guard let capturer = videoCapturer else { return }

        guard let camera = getCameraDevice(position: currentCameraPosition) else {
            throw WebRTCError.noCameraAvailable
        }

        let profile = webcamCaptureProfile(
            for: currentVideoQuality,
            connectionQuality: currentLocalBandwidthQuality
        )
        let format = try selectFormat(for: camera, targetWidth: profile.width, targetHeight: profile.height)
        let fps = try selectFPS(for: format, targetFPS: profile.fps)

        capturer.startCapture(with: camera, format: format, fps: Int(fps))
    }

    private func webcamCaptureProfile(
        for quality: VideoQuality,
        connectionQuality: ConnectionQuality = .unknown
    ) -> WebcamCaptureProfile {
        if connectionQuality == .emergency {
            return WebcamCaptureProfile(width: 640, height: 360, fps: 8)
        }
        if connectionQuality == .poor {
            return WebcamCaptureProfile(width: 640, height: 360, fps: 12)
        }
        if connectionQuality == .fair || quality == .low {
            return WebcamCaptureProfile(width: 640, height: 360, fps: 20)
        }

        switch quality {
        case .low:
            return WebcamCaptureProfile(width: 640, height: 360, fps: 20)
        case .standard:
            return WebcamCaptureProfile(width: 1280, height: 720, fps: 30)
        }
    }

    private func webcamEncodingSpecs(for quality: VideoQuality) -> [WebcamEncodingSpec] {
        switch quality {
        case .low:
            return [
                WebcamEncodingSpec(rid: "q", scaleResolutionDownBy: 2, maxBitrateBps: 65_000, maxFramerate: 8),
                WebcamEncodingSpec(rid: "h", scaleResolutionDownBy: 1, maxBitrateBps: 120_000, maxFramerate: 12),
                WebcamEncodingSpec(rid: "f", scaleResolutionDownBy: 1, maxBitrateBps: 180_000, maxFramerate: 15)
            ]
        case .standard:
            return [
                WebcamEncodingSpec(rid: "q", scaleResolutionDownBy: 4, maxBitrateBps: 90_000, maxFramerate: 12),
                WebcamEncodingSpec(rid: "h", scaleResolutionDownBy: 2, maxBitrateBps: 260_000, maxFramerate: 20),
                WebcamEncodingSpec(rid: "f", scaleResolutionDownBy: 1, maxBitrateBps: 1_500_000, maxFramerate: 30)
            ]
        }
    }

    private func webcamEncodingSpecs(
        for quality: VideoQuality,
        connectionQuality: ConnectionQuality
    ) -> [WebcamEncodingSpec] {
        let base = webcamEncodingSpecs(for: quality)
        let constrainedScaleResolutionDownBy = { (index: Int, spec: WebcamEncodingSpec) -> Double in
            guard index == 0 else { return spec.scaleResolutionDownBy }
            switch connectionQuality {
            case .emergency, .poor:
                // Native capture stays at 640x360 on constrained links for
                // broad device-format support. Keep the only active layer at
                // 320x180 instead of double-scaling standard quality to 160x90.
                return min(spec.scaleResolutionDownBy, 2)
            default:
                return spec.scaleResolutionDownBy
            }
        }
        switch connectionQuality {
        case .emergency:
            let bitrateCaps = [65_000, 90_000, 120_000]
            let framerateCaps: [Double] = [8, 8, 8]
            return base.enumerated().map { index, spec in
                WebcamEncodingSpec(
                    rid: spec.rid,
                    scaleResolutionDownBy: constrainedScaleResolutionDownBy(index, spec),
                    maxBitrateBps: min(spec.maxBitrateBps, bitrateCaps[min(index, bitrateCaps.count - 1)]),
                    maxFramerate: min(spec.maxFramerate, framerateCaps[min(index, framerateCaps.count - 1)])
                )
            }
        case .poor:
            let bitrateCaps = [120_000, 160_000, 180_000]
            let framerateCaps: [Double] = [12, 12, 15]
            return base.enumerated().map { index, spec in
                WebcamEncodingSpec(
                    rid: spec.rid,
                    scaleResolutionDownBy: constrainedScaleResolutionDownBy(index, spec),
                    maxBitrateBps: min(spec.maxBitrateBps, bitrateCaps[min(index, bitrateCaps.count - 1)]),
                    maxFramerate: min(spec.maxFramerate, framerateCaps[min(index, framerateCaps.count - 1)])
                )
            }
        case .fair:
            let bitrateCaps = [90_000, 220_000, 420_000]
            let framerateCaps: [Double] = [10, 15, 20]
            return base.enumerated().map { index, spec in
                WebcamEncodingSpec(
                    rid: spec.rid,
                    scaleResolutionDownBy: spec.scaleResolutionDownBy,
                    maxBitrateBps: min(spec.maxBitrateBps, bitrateCaps[min(index, bitrateCaps.count - 1)]),
                    maxFramerate: min(spec.maxFramerate, framerateCaps[min(index, framerateCaps.count - 1)])
                )
            }
        case .good, .unknown:
            return base
        }
    }

    private func webcamEncodings(
        for quality: VideoQuality,
        connectionQuality: ConnectionQuality = .unknown
    ) -> [RTCRtpEncodingParameters] {
        webcamEncodingSpecs(for: quality, connectionQuality: connectionQuality).enumerated().map { index, spec in
            let encoding = RTCRtpEncodingParameters()
            encoding.rid = spec.rid
            encoding.isActive = shouldSendWebcamEncoding(
                layerIndex: index,
                quality: quality,
                connectionQuality: connectionQuality
            )
            encoding.scaleResolutionDownBy = NSNumber(value: spec.scaleResolutionDownBy)
            encoding.maxBitrateBps = NSNumber(value: spec.maxBitrateBps)
            encoding.maxFramerate = NSNumber(value: spec.maxFramerate)
            encoding.networkPriority = spec.rid == "f" ? .low : .veryLow
            return encoding
        }
    }

    private func webcamMaxSpatialLayer(
        for quality: VideoQuality,
        connectionQuality: ConnectionQuality = .unknown
    ) -> Int {
        let base: Int
        switch quality {
        case .low:
            base = 1
        case .standard:
            base = 2
        }
        if connectionQuality == .emergency || connectionQuality == .poor {
            return 0
        }
        if connectionQuality == .fair || quality == .low {
            return min(base, 1)
        }
        return base
    }

    private func shouldSendWebcamEncoding(
        layerIndex: Int,
        quality: VideoQuality,
        connectionQuality: ConnectionQuality
    ) -> Bool {
        if connectionQuality == .good || connectionQuality == .unknown {
            return true
        }

        return layerIndex <= webcamMaxSpatialLayer(
            for: quality,
            connectionQuality: connectionQuality
        )
    }

    private func screenShareEncodingCap(
        connectionQuality: ConnectionQuality
    ) -> ScreenShareEncodingCap {
        switch connectionQuality {
        case .emergency:
            return ScreenShareEncodingCap(maxBitrateBps: 220_000, maxFramerate: 3)
        case .poor:
            return ScreenShareEncodingCap(maxBitrateBps: 450_000, maxFramerate: 5)
        case .fair:
            return ScreenShareEncodingCap(maxBitrateBps: 1_200_000, maxFramerate: 12)
        case .good, .unknown:
            return ScreenShareEncodingCap(maxBitrateBps: 2_500_000, maxFramerate: 24)
        }
    }

    var screenShareCaptureMaxFramerate: Double {
        screenShareEncodingCap(connectionQuality: currentLocalBandwidthQuality).maxFramerate
    }

    private func screenShareEncoding(
        connectionQuality: ConnectionQuality = .unknown
    ) -> RTCRtpEncodingParameters {
        let cap = screenShareEncodingCap(connectionQuality: connectionQuality)
        let encoding = RTCRtpEncodingParameters()
        encoding.isActive = true
        encoding.maxBitrateBps = NSNumber(value: cap.maxBitrateBps)
        encoding.maxFramerate = NSNumber(value: cap.maxFramerate)
        encoding.numTemporalLayers = NSNumber(value: Self.screenShareTemporalLayerCount)
        encoding.networkPriority = .high
        return encoding
    }

    private func screenShareEncodings(
        connectionQuality: ConnectionQuality = .unknown
    ) -> [RTCRtpEncodingParameters] {
        let encoding = screenShareEncoding(connectionQuality: connectionQuality)
        return [encoding]
    }

    func getCameraDevice(position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        let discoverySession = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .builtInDualCamera, .builtInTrueDepthCamera],
            mediaType: .video,
            position: position
        )
        return discoverySession.devices.first
    }

    func selectFormat(for device: AVCaptureDevice, targetWidth: Int32, targetHeight: Int32) throws -> AVCaptureDevice.Format {
        let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
        guard var selectedFormat = formats.first else {
            throw WebRTCError.noCameraAvailable
        }

        var minDiff = Int32.max

        for format in formats {
            let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            let diff = abs(dimensions.width - targetWidth) + abs(dimensions.height - targetHeight)
            if diff < minDiff {
                minDiff = diff
                selectedFormat = format
            }
        }

        return selectedFormat
    }

    func selectFPS(for format: AVCaptureDevice.Format, targetFPS: Float64) throws -> Float64 {
        var maxFrameRate: Float64 = 0
        for range in format.videoSupportedFrameRateRanges {
            maxFrameRate = max(maxFrameRate, range.maxFrameRate)
        }
        guard maxFrameRate >= 1 else {
            throw WebRTCError.noCameraAvailable
        }
        return max(1, min(targetFPS, maxFrameRate))
    }

    // MARK: - Consume Remote Media

    func consumeProducer(
        producerId: String,
        producerUserId: String,
        producerKind: String? = nil,
        producerType: String = "webcam",
        preferHighWebcamLayer: Bool = false,
        initialReceiveConnectionQuality: ConnectionQuality = .unknown
    ) async throws {
        try await createReceiveTransportIfNeeded()
        guard let socket = socketManager,
              let rtpCaps = serverRtpCapabilities,
              let receiveTransport = receiveTransport,
              let receiveTransportId = receiveTransportId else {
            throw WebRTCError.notConfigured
        }

        let initialPreference = initialConsumerPreference(
            producerKind: producerKind,
            producerType: producerType,
            preferHighWebcamLayer: preferHighWebcamLayer,
            initialReceiveConnectionQuality: initialReceiveConnectionQuality
        )

        let response = try await socket.consume(
            producerId: producerId,
            rtpCapabilities: rtpCaps,
            transportId: receiveTransportId,
            preferredSpatialLayer: initialPreference.spatialLayer,
            preferredTemporalLayer: initialPreference.temporalLayer,
            priority: initialPreference.priority
        )

        let kind: MediaKind = response.kind == "video" ? .video : .audio
        let rtpParameters = try encodeJSONString(response.rtpParameters)

        let consumer = try receiveTransport.consume(
            consumerId: response.id,
            producerId: response.producerId,
            kind: kind,
            rtpParameters: rtpParameters,
            appData: nil
        )
        consumer.delegate = self
        consumer.resume()

        // A user can produce a webcam AND a screen-share at once - store them
        // under distinct keys so one never overwrites the other.
        let isScreenVideo = (producerType == "screen" && response.kind == "video")
        let trackKey = isScreenVideo ? "\(producerUserId)-screen" : producerUserId

        consumers[response.id] = ConsumerInfo(
            consumer: consumer,
            producerId: response.producerId,
            userId: producerUserId,
            kind: response.kind,
            type: producerType,
            trackKey: trackKey
        )

        // Request a keyframe on the initial video consume so the decoder gets a
        // fresh IDR immediately instead of showing nothing/garbage until the
        // producer's next natural keyframe.
        if response.kind == "video",
           producerType == ProducerType.webcam.rawValue {
            let initialPreference = initialWebcamConsumerPreference(
                preferHighWebcamLayer: preferHighWebcamLayer
            )
            try? await socket.setConsumerPreferences(
                consumerId: response.id,
                spatialLayer: initialPreference.spatialLayer,
                temporalLayer: initialPreference.temporalLayer,
                requestKeyFrame: false
            )
        }
        try await socket.resumeConsumer(consumerId: response.id, requestKeyFrame: response.kind == "video")

        if response.kind == "video", let videoTrack = consumer.track as? RTCVideoTrack {
            let trackWrapper = VideoTrackWrapper(
                id: response.id,
                userId: trackKey,
                isLocal: false,
                track: videoTrack
            )
            remoteVideoTracks[trackKey] = trackWrapper
        }

        debugLog("[WebRTC] Consuming \(producerType) producer \(producerId) for user \(producerUserId)")
    }

    func closeConsumer(producerId: String, userId: String) {
        if producerId.isEmpty {
            let consumerIds = consumers
                .filter { consumerMatchesUser($0.value, userId: userId) }
                .map { $0.key }
            for id in consumerIds {
                if let info = consumers[id] {
                    removeConsumer(consumerId: id, info: info, closeConsumer: true)
                }
            }
        } else if let entry = consumers.first(where: { $0.value.producerId == producerId }) {
            removeConsumer(consumerId: entry.key, info: entry.value, closeConsumer: true)
        }

        // User left entirely (empty producerId path) - clear both their slots.
        if producerId.isEmpty, !userId.isEmpty {
            for key in Array(remoteVideoTracks.keys) where trackKeyMatchesUser(key, userId: userId) {
                remoteVideoTracks.removeValue(forKey: key)
            }
        }
    }

    private func consumerMatchesUser(_ info: ConsumerInfo, userId: String) -> Bool {
        trackKeyMatchesUser(info.userId, userId: userId) ||
            trackKeyMatchesUser(info.trackKey, userId: userId)
    }

    private func trackKeyMatchesUser(_ trackKey: String, userId: String) -> Bool {
        let normalizedTarget = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedTrackKey = trackKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTarget.isEmpty, !normalizedTrackKey.isEmpty else { return false }
        if normalizedTrackKey == normalizedTarget {
            return true
        }

        let screenSuffix = "-\(ProducerType.screen.rawValue)"
        let targetHasScreenSuffix = normalizedTarget.hasSuffix(screenSuffix)
        let trackHasScreenSuffix = normalizedTrackKey.hasSuffix(screenSuffix)
        let targetIdentity = targetHasScreenSuffix
            ? String(normalizedTarget.dropLast(screenSuffix.count))
            : normalizedTarget
        let trackIdentity = trackHasScreenSuffix
            ? String(normalizedTrackKey.dropLast(screenSuffix.count))
            : normalizedTrackKey
        if targetIdentity == trackIdentity {
            return true
        }

        let targetKey = stableRemoteTrackUserKey(for: targetIdentity)
        let trackKey = stableRemoteTrackUserKey(for: trackIdentity)
        guard !targetKey.isEmpty, targetKey == trackKey else { return false }
        let targetHasSessionSuffix = targetIdentity.contains("#")
        let trackHasSessionSuffix = trackIdentity.contains("#")
        return !targetHasSessionSuffix || !trackHasSessionSuffix
    }

    func hasAudioConsumer(userIdPrefix: String) -> Bool {
        consumers.values.contains { info in
            info.kind == "audio" && info.userId.hasPrefix(userIdPrefix)
        }
    }

    func setAudioConsumersEnabled(userIdPrefix: String, enabled: Bool) {
        for info in consumers.values where info.kind == "audio" && info.userId.hasPrefix(userIdPrefix) {
            (info.consumer.track as? RTCAudioTrack)?.isEnabled = enabled
        }
    }

    // MARK: - Media Control

    func setAudioEnabled(_ enabled: Bool) async throws {
        guard let socket = socketManager else { throw WebRTCError.notConfigured }
        guard let producer = audioProducer else { throw WebRTCError.noTransport }

        let generation = configurationGeneration
        let previous = localAudioEnabled
        do {
            if enabled {
                try await ensureMicrophonePermission()
                guard generation == configurationGeneration else { throw WebRTCError.staleConfiguration }
                try configureCallAudioSession()
                producer.resume()
            } else {
                producer.pause()
                audioCaptureReassertionTask?.cancel()
                audioCaptureReassertionTask = nil
                audioCaptureRestartTask?.cancel()
                audioCaptureRestartTask = nil
            }
            try await socket.toggleMute(producerId: producer.id, paused: !enabled)
            rtcLocalAudioTrack?.isEnabled = enabled
            localAudioEnabled = enabled
            if enabled {
                scheduleLocalAudioCaptureReassertion()
            }
        } catch {
            guard generation == configurationGeneration else { throw error }
            if previous {
                producer.resume()
                do {
                    try configureCallAudioSession()
                    scheduleLocalAudioCaptureReassertion()
                } catch {
                    debugLog("[WebRTC] Failed to restore audio session after toggle failure: \(error)")
                }
            } else {
                producer.pause()
            }
            rtcLocalAudioTrack?.isEnabled = previous
            localAudioEnabled = previous
            debugLog("[WebRTC] Failed to toggle audio: \(error)")
            throw error
        }
    }

    func reassertLocalAudioProducerUnmuted() async throws {
        guard let socket = socketManager else { throw WebRTCError.notConfigured }
        guard let producer = audioProducer else { throw WebRTCError.noTransport }
        guard hasLocalAudioProducer, localAudioEnabled else { return }

        try configureCallAudioSession()
        producer.resume()
        rtcLocalAudioTrack?.isEnabled = true
        try await socket.toggleMute(producerId: producer.id, paused: false)
        scheduleLocalAudioCaptureReassertion()
    }

    func setVideoEnabled(_ enabled: Bool) async throws {
        guard let socket = socketManager else { throw WebRTCError.notConfigured }
        guard let producer = videoProducer else { throw WebRTCError.noTransport }

        let previous = localVideoEnabled
        do {
            if enabled {
                let status = AVCaptureDevice.authorizationStatus(for: .video)
                guard status == .authorized else {
                    throw WebRTCError.permissionDenied
                }
                if !localVideoEnabled {
                    try startCameraCapture()
                }
                producer.resume()
            } else {
                producer.pause()
            }
            try await socket.toggleCamera(producerId: producer.id, paused: !enabled)
            rtcLocalVideoTrack?.isEnabled = enabled
            localVideoEnabled = enabled
            localVideoTrack?.isEnabled = enabled

            if !enabled {
                await videoCapturer?.stopCapture()
            }
        } catch {
            if previous {
                producer.resume()
            } else {
                producer.pause()
                await videoCapturer?.stopCapture()
            }
            rtcLocalVideoTrack?.isEnabled = previous
            localVideoTrack?.isEnabled = previous
            localVideoEnabled = previous
            debugLog("[WebRTC] Failed to toggle video: \(error)")
            throw error
        }
    }

    func closeLocalAudioProducer() async {
        guard let producerId = audioProducer?.id else { return }

        _ = await closeLocalMedia(
            kind: "audio",
            type: ProducerType.webcam.rawValue,
            producerId: producerId
        )

        do {
            try await socketManager?.closeProducer(producerId: producerId)
        } catch {
            debugLog("[WebRTC] Failed to notify SFU of closed audio producer: \(error)")
        }
    }

    func closeLocalVideoProducer() async {
        guard let producerId = videoProducer?.id else {
            await clearLocalWebcamCaptureState()
            return
        }

        _ = await closeLocalMedia(
            kind: "video",
            type: ProducerType.webcam.rawValue,
            producerId: producerId
        )

        do {
            try await socketManager?.closeProducer(producerId: producerId)
        } catch {
            debugLog("[WebRTC] Failed to notify SFU of closed video producer: \(error)")
        }
    }

    private func clearLocalWebcamCaptureState() async {
        videoProducer?.close()
        videoProducer = nil
        rtcLocalVideoTrack?.isEnabled = false
        rtcLocalVideoTrack = nil
        localVideoTrack?.isEnabled = false
        localVideoTrack = nil
        await videoCapturer?.stopCapture()
        videoCapturer = nil
        videoSource = nil
        localVideoEnabled = false
    }

    func closeLocalScreenProducer() async {
        let producerId = screenProducer?.id

        await stopScreenSharing()

        guard let producerId else { return }

        do {
            try await socketManager?.closeProducer(producerId: producerId)
        } catch {
            debugLog("[WebRTC] Failed to notify SFU of closed screen producer: \(error)")
        }
    }

    func closeLocalMedia(kind: String, type: String, producerId: String?) async -> Bool {
        let isWebcam = type == ProducerType.webcam.rawValue
        let isScreen = type == ProducerType.screen.rawValue

        if kind == "audio", isWebcam, matchesProducer(audioProducer, producerId: producerId) {
            audioProducer?.close()
            audioProducer = nil
            audioProducerBandwidthQuality = .unknown
            rtcLocalAudioTrack?.isEnabled = false
            rtcLocalAudioTrack = nil
            audioSource = nil
            localAudioEnabled = false
            return true
        }

        if kind == "video", isWebcam, matchesProducer(videoProducer, producerId: producerId) {
            videoProducer?.close()
            videoProducer = nil
            rtcLocalVideoTrack?.isEnabled = false
            localVideoTrack?.isEnabled = false
            localVideoTrack = nil
            rtcLocalVideoTrack = nil
            await videoCapturer?.stopCapture()
            videoCapturer = nil
            videoSource = nil
            localVideoEnabled = false
            return true
        }

        if kind == "video", isScreen, matchesProducer(screenProducer, producerId: producerId) {
            await stopScreenSharing()
            return true
        }

        return false
    }

    private func matchesProducer(_ producer: Producer?, producerId: String?) -> Bool {
        guard let producer else { return false }
        return producerId == nil || producer.id == producerId
    }

    private func isUsableProducer(_ producer: Producer?) -> Bool {
        guard let producer,
              !producer.closed,
              !producer.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }
        return true
    }

    private func requireRegisteredProducer(_ producer: Producer, label: String) throws -> Producer {
        guard isUsableProducer(producer) else {
            producer.close()
            throw WebRTCError.connectionFailed("SFU did not acknowledge \(label) producer")
        }
        return producer
    }

    private func preferredVideoCodecJSON(mimeType: String = "video/VP8") -> String? {
        guard
            let capabilitiesJSON = try? device?.rtpCapabilities(),
            let data = capabilitiesJSON.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let codecs = object["codecs"] as? [[String: Any]]
        else {
            return nil
        }

        guard
            let codec = codecs.first(where: { codec in
                let kind = codec["kind"] as? String
                let codecMimeType = codec["mimeType"] as? String
                let isVideo = kind == nil || kind?.caseInsensitiveCompare("video") == .orderedSame
                let matchesMimeType = codecMimeType?.caseInsensitiveCompare(mimeType) == .orderedSame
                return isVideo && matchesMimeType
            }),
            let codecData = try? JSONSerialization.data(withJSONObject: codec),
            let codecJSON = String(data: codecData, encoding: .utf8)
        else {
            return nil
        }

        return codecJSON
    }

    func updateVideoQuality(_ quality: VideoQuality) {
        currentVideoQuality = quality
        lastAppliedLocalBandwidthSignature = nil
        applyLocalBandwidthProfile(connectionQuality: currentLocalBandwidthQuality)
    }

    func applyLocalBandwidthProfile(connectionQuality: ConnectionQuality) {
        let signature = "\(currentVideoQuality.rawValue):\(connectionQuality.rawValue)"
        guard lastAppliedLocalBandwidthSignature != signature else { return }
        currentLocalBandwidthQuality = connectionQuality
        lastAppliedLocalBandwidthSignature = signature

        if let audioProducer, !audioProducer.closed {
            let audioBitrate = opusMaxAverageBitrate(connectionQuality: connectionQuality)
            audioProducer.updateSenderParameters { parameters in
                var next = parameters
                if var encodings = next.encodings, !encodings.isEmpty {
                    for index in encodings.indices {
                        encodings[index].isActive = true
                        encodings[index].maxBitrateBps = audioBitrate
                    }
                    next.encodings = encodings
                }
                return next
            }
        }

        if let producer = videoProducer {
            let specs = webcamEncodingSpecs(
                for: currentVideoQuality,
                connectionQuality: connectionQuality
            )

            try? producer.setMaxSpatialLayer(
                webcamMaxSpatialLayer(
                    for: currentVideoQuality,
                    connectionQuality: connectionQuality
                )
            )
            producer.updateSenderParameters { parameters in
                var next = parameters
                next.degradationPreference = .maintainFramerate
                if var encodings = next.encodings, !encodings.isEmpty {
                    for index in encodings.indices {
                        let spec = specs[min(index, specs.count - 1)]
                        encodings[index].isActive = self.shouldSendWebcamEncoding(
                            layerIndex: index,
                            quality: self.currentVideoQuality,
                            connectionQuality: connectionQuality
                        )
                        encodings[index].maxBitrateBps = spec.maxBitrateBps
                        encodings[index].maxFramerate = spec.maxFramerate
                        encodings[index].scaleResolutionDownBy = spec.scaleResolutionDownBy
                    }
                    next.encodings = encodings
                }
                return next
            }

            if localVideoEnabled, videoCapturer != nil {
                try? startCameraCapture()
            }
        }

        if let screenProducer, !screenProducer.closed {
            let cap = screenShareEncodingCap(connectionQuality: connectionQuality)
            ScreenCaptureManager.shared.updateMaxFrameRate(cap.maxFramerate)
            resetScreenFrameLimiter()
            screenProducer.updateSenderParameters { parameters in
                var next = parameters
                next.degradationPreference = .maintainResolution
                if var encodings = next.encodings, !encodings.isEmpty {
                    for index in encodings.indices {
                        encodings[index].isActive = true
                        encodings[index].maxBitrateBps = cap.maxBitrateBps
                        encodings[index].maxFramerate = cap.maxFramerate
                    }
                    next.encodings = encodings
                }
                return next
            }
        }
    }

    func refreshLocalAudioProducerForBandwidthProfile(connectionQuality: ConnectionQuality) async {
        guard !audioBandwidthRefreshInFlight else { return }
        guard audioCaptureRestartTask == nil else { return }
        guard shouldRefreshAudioProducerForBandwidthProfile(connectionQuality) else { return }
        guard
            let socketManager,
            let sendTransport,
            let oldProducer = audioProducer
        else { return }

        audioBandwidthRefreshInFlight = true
        let previousSuppressLocalStateCallbacks = suppressLocalStateCallbacks
        suppressLocalStateCallbacks = true
        var pendingProducer: Producer?
        var pendingTrack: RTCAudioTrack?
        defer {
            suppressLocalStateCallbacks = previousSuppressLocalStateCallbacks
            audioBandwidthRefreshInFlight = false
            if !localAudioEnabled {
                onLocalAudioEnabledChanged?(false)
            }
        }

        do {
            try configureCallAudioSession()
            let oldTrack = rtcLocalAudioTrack
            let microphone = createMicrophoneAudioTrack()
            pendingTrack = microphone.track
            let nextProducer = try createMicrophoneProducer(on: sendTransport, track: microphone.track)
            pendingProducer = nextProducer
            nextProducer.resume()

            audioSource = microphone.source
            rtcLocalAudioTrack = microphone.track
            audioProducer = nextProducer
            audioProducerBandwidthQuality = connectionQuality
            localAudioEnabled = true
            microphone.track.isEnabled = true
            scheduleLocalAudioCaptureReassertion(forceCaptureRestart: true)
            await markMicrophoneProducerUnmuted(nextProducer.id, reason: "bandwidth refresh")
            pendingProducer = nil
            pendingTrack = nil

            do {
                try await socketManager.closeProducer(producerId: oldProducer.id)
            } catch {
                debugLog("[WebRTC] Failed to notify SFU of refreshed microphone producer close: \(error)")
            }
            oldProducer.close()
            oldTrack?.isEnabled = false
            debugLog("[WebRTC] Refreshed microphone producer for \(connectionQuality.rawValue) bandwidth")
        } catch {
            pendingProducer?.close()
            pendingTrack?.isEnabled = false
            debugLog("[WebRTC] Failed to refresh microphone producer for bandwidth: \(error)")
        }
    }

    func refreshLocalVideoProducerForBandwidthProfile(connectionQuality: ConnectionQuality) async {
        // iOS exposes live RTCRtpSender parameters, so applyLocalBandwidthProfile
        // already updates webcam bitrate/FPS/layer caps without a producer churn.
    }

    func refreshLocalScreenProducerForBandwidthProfile(connectionQuality: ConnectionQuality) async {
        guard !screenBandwidthRefreshInFlight else { return }
        guard shouldRefreshScreenProducerForBandwidthProfile(connectionQuality) else { return }
        guard
            let socketManager,
            let sendTransport,
            let oldProducer = screenProducer,
            let screenTrack = rtcScreenTrack
        else {
            return
        }

        screenBandwidthRefreshInFlight = true
        defer { screenBandwidthRefreshInFlight = false }

        do {
            let appData = try encodeJSONString(ProducerAppData(type: ProducerType.screen.rawValue, paused: false))
            let producer = try requireRegisteredProducer(
                sendTransport.createProducer(
                    for: screenTrack,
                    encoding: screenShareEncoding(connectionQuality: connectionQuality),
                    scalabilityMode: Self.screenShareScalabilityMode,
                    codecOptions: nil,
                    codec: preferredVideoCodecJSON(),
                    appData: appData
                ),
                label: "screen"
            )
            producer.delegate = self
            producer.resume()
            screenProducer = producer
            screenProducerBandwidthQuality = connectionQuality
            ScreenCaptureManager.shared.updateMaxFrameRate(
                screenShareEncodingCap(connectionQuality: connectionQuality).maxFramerate
            )
            resetScreenFrameLimiter()

            do {
                try await socketManager.closeProducer(producerId: oldProducer.id)
            } catch {
                debugLog("[WebRTC] Failed to notify SFU of refreshed screen producer close: \(error)")
            }
            oldProducer.close()
            debugLog("[WebRTC] Refreshed screen producer for \(connectionQuality.rawValue) bandwidth")
        } catch {
            debugLog("[WebRTC] Failed to refresh screen producer for bandwidth: \(error)")
        }
    }

    private func shouldRefreshAudioProducerForBandwidthProfile(_ connectionQuality: ConnectionQuality) -> Bool {
        guard connectionQuality != .unknown else { return false }
        guard hasLocalAudioProducer, localAudioEnabled, rtcLocalAudioTrack?.isEnabled == true else {
            return false
        }
        return connectionQuality != audioProducerBandwidthQuality
    }

    private func shouldRefreshScreenProducerForBandwidthProfile(_ connectionQuality: ConnectionQuality) -> Bool {
        guard connectionQuality != .unknown else { return false }
        guard screenProducer != nil, rtcScreenTrack != nil else { return false }
        return connectionQuality != screenProducerBandwidthQuality
    }

    private func connectionQualityRank(_ quality: ConnectionQuality) -> Int {
        switch quality {
        case .unknown:
            return 0
        case .good:
            return 1
        case .fair:
            return 2
        case .poor:
            return 3
        case .emergency:
            return 4
        }
    }

    func canSwitchCamera() -> Bool {
        getCameraDevice(position: .front) != nil && getCameraDevice(position: .back) != nil
    }

    func setPreferredCameraFacing(_ facing: LocalCameraFacing) {
        guard !localVideoEnabled,
              videoCapturer == nil else { return }
        let position: AVCaptureDevice.Position = facing == .front ? .front : .back
        guard getCameraDevice(position: position) != nil else { return }
        currentCameraPosition = position
    }

    func switchCamera() async throws {
        let previousPosition = currentCameraPosition
        let nextPosition: AVCaptureDevice.Position = previousPosition == .front ? .back : .front
        guard getCameraDevice(position: nextPosition) != nil else {
            throw WebRTCError.noCameraAvailable
        }

        currentCameraPosition = nextPosition
        guard videoCapturer != nil, localVideoEnabled else { return }

        do {
            await videoCapturer?.stopCapture()
            try startCameraCapture()
        } catch {
            currentCameraPosition = previousPosition
            try? startCameraCapture()
            throw error
        }
    }

    // MARK: - Get Video Track for Rendering

    func getLocalVideoTrack() -> RTCVideoTrack? {
        return rtcLocalVideoTrack
    }

    func remoteVideoTrack(forUserId userId: String) -> VideoTrackWrapper? {
        let normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return nil }
        if let track = remoteVideoTracks[normalized] {
            return track
        }

        let wantsScreenTrack = normalized.hasSuffix("-\(ProducerType.screen.rawValue)")
        let userKey = stableRemoteTrackUserKey(for: normalized, removeScreenSuffix: wantsScreenTrack)
        guard !userKey.isEmpty else { return nil }

        return remoteVideoTracks.first { element in
            let candidateIsScreenTrack = element.key.hasSuffix("-\(ProducerType.screen.rawValue)")
            guard candidateIsScreenTrack == wantsScreenTrack else { return false }
            return stableRemoteTrackUserKey(for: element.key, removeScreenSuffix: candidateIsScreenTrack) == userKey
        }?.value
    }

    private func stableRemoteTrackUserKey(for userId: String, removeScreenSuffix: Bool = false) -> String {
        var normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        if removeScreenSuffix {
            normalized = String(normalized.dropLast("-\(ProducerType.screen.rawValue)".count))
        }
        return normalized.components(separatedBy: "#").first ?? normalized
    }

    // MARK: - Active Speaker (audio levels)

    /// Reads `audioLevel` (0.0-1.0, RMS-derived) from local producer and remote
    /// consumer WebRTC stats. The shared VM picks the loudest above a threshold.
    func sampleAudioLevels(localUserId: String? = nil) -> [String: Double] {
        var levels: [String: Double] = [:]
        for (_, info) in consumers where info.kind == "audio" {
            let statsJson = info.consumer.stats
            if let level = Self.parseInboundAudioLevel(statsJson) {
                levels[info.userId] = max(levels[info.userId] ?? 0, level)
            }
        }
        let normalizedLocalUserId = localUserId?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let normalizedLocalUserId,
           !normalizedLocalUserId.isEmpty,
           localAudioEnabled,
           rtcLocalAudioTrack?.isEnabled == true,
           let audioProducer,
           let level = Self.parseAudioLevel(audioProducer.stats) {
            levels[normalizedLocalUserId] = max(levels[normalizedLocalUserId] ?? 0, level)
        }
        return levels
    }

    private static func parseInboundAudioLevel(_ statsJson: String) -> Double? {
        parseAudioLevel(statsJson, requiredType: "inbound-rtp")
    }

    private static func parseAudioLevel(_ statsJson: String, requiredType: String? = nil) -> Double? {
        guard let data = statsJson.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return nil
        }
        var best: Double?
        for obj in array {
            if let requiredType, (obj["type"] as? String) != requiredType {
                continue
            }
            guard let value = statsNumber(obj, "audioLevel") else {
                continue
            }
            if let currentBest = best, value <= currentBest {
                continue
            } else {
                best = value
            }
        }
        return best
    }

    // MARK: - Video freeze watchdog

    // Last decode progress + consecutive stall count per remote video consumer.
    private var videoFreezeStats: [String: (frames: Double, bytes: Double, stalls: Int)] = [:]

    private static func statsNumber(_ obj: [String: Any], _ key: String) -> Double? {
        if let d = obj[key] as? Double { return d }
        if let i = obj[key] as? Int { return Double(i) }
        if let n = obj[key] as? NSNumber { return n.doubleValue }
        return nil
    }

    // MARK: - Connection quality

    private static let outgoingBandwidthFairBps = 500_000.0
    private static let outgoingBandwidthPoorBps = 240_000.0
    private static let outgoingBandwidthEmergencyBps = 120_000.0
    private static let incomingBandwidthFairBps = 500_000.0
    private static let incomingBandwidthPoorBps = 240_000.0
    private static let incomingBandwidthEmergencyBps = 120_000.0
    private static let availableBitrateSaturationRatio = 0.7

    private struct ConnectionStatsSample {
        let rttMs: Double?
        let inboundJitterMs: Double?
        let inboundJitterWeight: Double
        let inboundPacketsLost: Double
        let inboundPacketsReceived: Double
        let remoteInboundJitterMs: Double?
        let remoteInboundJitterWeight: Double
        let remoteInboundPacketsLost: Double
        let remoteInboundPacketsReceived: Double
        let remoteInboundLossFraction: Double?
        let availableOutgoingBitrate: Double?
        let availableIncomingBitrate: Double?
        let outboundMediaBytes: Double?
        let inboundMediaBytes: Double?
        let outboundVideoQualityLimitationReason: String?
    }

    private struct MediaCounterSample {
        let timestampMs: Double
        let mediaBytes: Double?
    }

    private struct DirectionConnectionStats {
        var rttMs: Double?
        var jitterWeightedMs = 0.0
        var jitterWeight = 0.0
        var packetsLost = 0.0
        var packetsReceived = 0.0
        var lossFraction: Double?
        var availableBitrate: Double?
        var mediaBytes: Double?
        var outboundVideoQualityLimitationReason: String?

        var jitterMs: Double? {
            jitterWeight > 0 ? jitterWeightedMs / jitterWeight : nil
        }

        mutating func mergeRtt(_ value: Double?) {
            guard let value else { return }
            rttMs = max(rttMs ?? 0, value)
        }

        mutating func mergeJitter(_ value: Double?, weight: Double) {
            guard let value else { return }
            let safeWeight = max(1.0, weight)
            jitterWeightedMs += value * safeWeight
            jitterWeight += safeWeight
        }

        mutating func mergePacketCounters(lost: Double, received: Double) {
            packetsLost += lost
            packetsReceived += received
        }

        mutating func mergeLossFraction(_ value: Double?) {
            guard let value else { return }
            lossFraction = max(lossFraction ?? 0, value)
        }

    }

    private var previousPublishConnectionLossSample: (packetsLost: Double, packetsReceived: Double)?
    private var previousReceiveConnectionLossSample: (packetsLost: Double, packetsReceived: Double)?
    private var previousPublishMediaCounterSample: MediaCounterSample?
    private var previousReceiveMediaCounterSample: MediaCounterSample?

    func sampleConnectionQuality() -> ConnectionQuality {
        sampleConnectionQualitySample().overallQuality
    }

    func sampleConnectionQualitySample() -> ConnectionQualitySample {
        var publish = DirectionConnectionStats()
        var receive = DirectionConnectionStats()
        var hasPublishStats = false
        var hasReceiveStats = false

        if let sendTransport, !sendTransport.closed,
           let sample = Self.parseConnectionStats(sendTransport.stats) {
            hasPublishStats = true
            publish.mergeRtt(sample.rttMs)
            publish.mergeJitter(
                sample.remoteInboundJitterMs,
                weight: sample.remoteInboundJitterWeight
            )
            publish.mergePacketCounters(
                lost: sample.remoteInboundPacketsLost,
                received: sample.remoteInboundPacketsReceived
            )
            publish.mergeLossFraction(sample.remoteInboundLossFraction)
            publish.availableBitrate = Self.minPositiveNullable(
                publish.availableBitrate,
                sample.availableOutgoingBitrate
            )
            publish.mediaBytes = Self.addNullable(publish.mediaBytes, sample.outboundMediaBytes)
            publish.outboundVideoQualityLimitationReason = Self.selectQualityLimitationReason(
                publish.outboundVideoQualityLimitationReason,
                sample.outboundVideoQualityLimitationReason
            )
        } else {
            previousPublishConnectionLossSample = nil
            previousPublishMediaCounterSample = nil
        }

        if let receiveTransport, !receiveTransport.closed,
           let sample = Self.parseConnectionStats(receiveTransport.stats) {
            hasReceiveStats = true
            receive.mergeRtt(sample.rttMs)
            receive.mergeJitter(
                sample.inboundJitterMs,
                weight: sample.inboundJitterWeight
            )
            receive.mergePacketCounters(
                lost: sample.inboundPacketsLost,
                received: sample.inboundPacketsReceived
            )
            receive.availableBitrate = Self.minPositiveNullable(
                receive.availableBitrate,
                sample.availableIncomingBitrate
            )
            receive.mediaBytes = Self.addNullable(receive.mediaBytes, sample.inboundMediaBytes)
        } else {
            previousReceiveConnectionLossSample = nil
            previousReceiveMediaCounterSample = nil
        }

        guard hasPublishStats || hasReceiveStats else {
            return ConnectionQualitySample(
                publishQuality: .unknown,
                receiveQuality: .unknown,
                overallQuality: .unknown,
                screenSharePublishQuality: .unknown
            )
        }

        let nowMs = Date().timeIntervalSince1970 * 1000
        let publishPacketLoss = publish.lossFraction ?? Self.windowedPacketLoss(
            current: (
                packetsLost: publish.packetsLost,
                packetsReceived: publish.packetsReceived
            ),
            previous: previousPublishConnectionLossSample
        )
        let receivePacketLoss = Self.windowedPacketLoss(
            current: (
                packetsLost: receive.packetsLost,
                packetsReceived: receive.packetsReceived
            ),
            previous: previousReceiveConnectionLossSample
        )
        if hasPublishStats {
            previousPublishConnectionLossSample = (publish.packetsLost, publish.packetsReceived)
        }
        if hasReceiveStats {
            previousReceiveConnectionLossSample = (receive.packetsLost, receive.packetsReceived)
        }

        let publishMediaSample = MediaCounterSample(timestampMs: nowMs, mediaBytes: publish.mediaBytes)
        let receiveMediaSample = MediaCounterSample(timestampMs: nowMs, mediaBytes: receive.mediaBytes)
        let publishMediaBitrate = Self.windowedBitrate(
            currentBytes: publishMediaSample.mediaBytes,
            previousBytes: previousPublishMediaCounterSample?.mediaBytes,
            elapsedMs: previousPublishMediaCounterSample.map {
                publishMediaSample.timestampMs - $0.timestampMs
            } ?? 0
        )
        let receiveMediaBitrate = Self.windowedBitrate(
            currentBytes: receiveMediaSample.mediaBytes,
            previousBytes: previousReceiveMediaCounterSample?.mediaBytes,
            elapsedMs: previousReceiveMediaCounterSample.map {
                receiveMediaSample.timestampMs - $0.timestampMs
            } ?? 0
        )
        if hasPublishStats {
            previousPublishMediaCounterSample = publishMediaSample
        }
        if hasReceiveStats {
            previousReceiveMediaCounterSample = receiveMediaSample
        }

        let publishTransportQuality = hasPublishStats ? Self.deriveConnectionQuality(
            rttMs: publish.rttMs,
            packetLoss: publishPacketLoss,
            jitterMs: publish.jitterMs
        ) : .unknown
        let receiveTransportQuality = hasReceiveStats ? Self.deriveConnectionQuality(
            rttMs: receive.rttMs,
            packetLoss: receivePacketLoss,
            jitterMs: receive.jitterMs
        ) : .unknown
        let publishBandwidthQuality = Self.deriveAvailableBitrateQuality(
            availableBitrate: publish.availableBitrate,
            mediaBitrate: publishMediaBitrate,
            fairBitrate: Self.outgoingBandwidthFairBps,
            poorBitrate: Self.outgoingBandwidthPoorBps,
            emergencyBitrate: Self.outgoingBandwidthEmergencyBps,
            encoderLimited: Self.hasEncoderQualityLimitation(
                publish.outboundVideoQualityLimitationReason
            )
        )
        let receiveBandwidthQuality = Self.deriveAvailableBitrateQuality(
            availableBitrate: receive.availableBitrate,
            mediaBitrate: receiveMediaBitrate,
            fairBitrate: Self.incomingBandwidthFairBps,
            poorBitrate: Self.incomingBandwidthPoorBps,
            emergencyBitrate: Self.incomingBandwidthEmergencyBps,
            encoderLimited: false
        )

        let publishQuality = Self.worstConnectionQuality(
            publishTransportQuality,
            publishBandwidthQuality
        )
        let receiveQuality = Self.worstConnectionQuality(
            receiveTransportQuality,
            receiveBandwidthQuality
        )
        let screenSharePublishQuality = ScreenSharePublishProfilePolicy.quality(
            availableOutgoingBitrate: publish.availableBitrate,
            emergencyMode: publishQuality == .emergency
        )
        return ConnectionQualitySample(
            publishQuality: publishQuality,
            receiveQuality: receiveQuality,
            overallQuality: Self.worstConnectionQuality(publishQuality, receiveQuality),
            screenSharePublishQuality: screenSharePublishQuality
        )
    }

    private static func parseConnectionStats(_ statsJson: String) -> ConnectionStatsSample? {
        guard let data = statsJson.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return nil
        }

        var rttMs: Double?
        var candidatePairRttMs: Double?
        var inboundJitterWeightedMs = 0.0
        var inboundJitterWeight = 0.0
        var inboundPacketsLost = 0.0
        var inboundPacketsReceived = 0.0
        var remoteInboundJitterWeightedMs = 0.0
        var remoteInboundJitterWeight = 0.0
        var remoteInboundPacketsLost = 0.0
        var remoteInboundPacketsReceived = 0.0
        var remoteInboundLossFraction: Double?
        var availableOutgoingBitrate: Double?
        var availableIncomingBitrate: Double?
        var outboundMediaBytes: Double?
        var inboundMediaBytes: Double?
        var outboundVideoQualityLimitationReason: String?
        var foundMetric = false

        for obj in array {
            switch obj["type"] as? String {
            case "candidate-pair":
                let nominated = (obj["nominated"] as? Bool) == true || (obj["state"] as? String) == "succeeded"
                if nominated, let rtt = statsNumber(obj, "currentRoundTripTime") {
                    candidatePairRttMs = max(candidatePairRttMs ?? 0, rtt * 1000)
                    foundMetric = true
                }
                if nominated, let outgoing = statsNumber(obj, "availableOutgoingBitrate"), outgoing > 0 {
                    availableOutgoingBitrate = minPositiveNullable(
                        availableOutgoingBitrate,
                        outgoing
                    )
                    foundMetric = true
                }
                if nominated, let incoming = statsNumber(obj, "availableIncomingBitrate"), incoming > 0 {
                    availableIncomingBitrate = minPositiveNullable(
                        availableIncomingBitrate,
                        incoming
                    )
                    foundMetric = true
                }
            case "inbound-rtp":
                let received = statsNumber(obj, "packetsReceived")
                if let jitter = statsNumber(obj, "jitter") {
                    let weight = max(1.0, received ?? 1.0)
                    inboundJitterWeightedMs += jitter * 1000 * weight
                    inboundJitterWeight += weight
                    foundMetric = true
                }
                if let lost = statsNumber(obj, "packetsLost") {
                    inboundPacketsLost += max(0, lost)
                    foundMetric = true
                }
                if let received {
                    inboundPacketsReceived += max(0, received)
                    foundMetric = true
                }
                if isMediaRtpStats(obj), let bytes = statsNumber(obj, "bytesReceived") {
                    inboundMediaBytes = addNullable(inboundMediaBytes, bytes)
                    foundMetric = true
                }
            case "remote-inbound-rtp":
                if let rtt = statsNumber(obj, "roundTripTime") {
                    rttMs = max(rttMs ?? 0, rtt * 1000)
                    foundMetric = true
                }
                let received = statsNumber(obj, "packetsReceived")
                if let jitter = statsNumber(obj, "jitter") {
                    let weight = max(1.0, received ?? 1.0)
                    remoteInboundJitterWeightedMs += jitter * 1000 * weight
                    remoteInboundJitterWeight += weight
                    foundMetric = true
                }
                if let lost = statsNumber(obj, "packetsLost") {
                    remoteInboundPacketsLost += max(0, lost)
                    foundMetric = true
                }
                if let received {
                    remoteInboundPacketsReceived += max(0, received)
                    foundMetric = true
                }
                if let fractionLost = normalizeFractionLost(statsNumber(obj, "fractionLost")) {
                    remoteInboundLossFraction = max(remoteInboundLossFraction ?? 0, fractionLost)
                    foundMetric = true
                }
            case "outbound-rtp":
                if isMediaRtpStats(obj), let bytes = statsNumber(obj, "bytesSent") {
                    outboundMediaBytes = addNullable(outboundMediaBytes, bytes)
                    foundMetric = true
                }
                if statsMediaKind(obj) == "video",
                   let reason = obj["qualityLimitationReason"] as? String {
                    outboundVideoQualityLimitationReason = selectQualityLimitationReason(
                        outboundVideoQualityLimitationReason,
                        reason
                    )
                    foundMetric = true
                }
            default:
                continue
            }
        }

        if let candidatePairRttMs {
            rttMs = max(rttMs ?? 0, candidatePairRttMs)
        }

        guard foundMetric else { return nil }
        let inboundJitterMs = inboundJitterWeight > 0 ? inboundJitterWeightedMs / inboundJitterWeight : nil
        let remoteInboundJitterMs = remoteInboundJitterWeight > 0 ? remoteInboundJitterWeightedMs / remoteInboundJitterWeight : nil
        return ConnectionStatsSample(
            rttMs: rttMs,
            inboundJitterMs: inboundJitterMs,
            inboundJitterWeight: inboundJitterWeight,
            inboundPacketsLost: inboundPacketsLost,
            inboundPacketsReceived: inboundPacketsReceived,
            remoteInboundJitterMs: remoteInboundJitterMs,
            remoteInboundJitterWeight: remoteInboundJitterWeight,
            remoteInboundPacketsLost: remoteInboundPacketsLost,
            remoteInboundPacketsReceived: remoteInboundPacketsReceived,
            remoteInboundLossFraction: remoteInboundLossFraction,
            availableOutgoingBitrate: availableOutgoingBitrate,
            availableIncomingBitrate: availableIncomingBitrate,
            outboundMediaBytes: outboundMediaBytes,
            inboundMediaBytes: inboundMediaBytes,
            outboundVideoQualityLimitationReason: outboundVideoQualityLimitationReason
        )
    }

    private static func normalizeFractionLost(_ value: Double?) -> Double? {
        guard let value, value >= 0 else {
            return nil
        }
        if value > 1, value <= 255 {
            return min(value / 255, 1)
        }
        return min(value, 1)
    }

    private static func windowedPacketLoss(
        current: (packetsLost: Double, packetsReceived: Double),
        previous: (packetsLost: Double, packetsReceived: Double)?
    ) -> Double? {
        guard let previous else {
            return nil
        }
        let deltaLost = max(0, current.packetsLost - previous.packetsLost)
        let deltaReceived = max(0, current.packetsReceived - previous.packetsReceived)
        let deltaTotal = deltaLost + deltaReceived
        return deltaTotal > 0 ? deltaLost / deltaTotal : 0
    }

    private static func deriveConnectionQuality(rttMs: Double?, packetLoss: Double?, jitterMs: Double?) -> ConnectionQuality {
        if rttMs == nil && packetLoss == nil && jitterMs == nil {
            return .unknown
        }

        if (rttMs ?? 0) >= 850 || (packetLoss ?? 0) >= 0.15 || (jitterMs ?? 0) >= 120 {
            return .emergency
        }
        if (rttMs ?? 0) >= 500 || (packetLoss ?? 0) >= 0.08 || (jitterMs ?? 0) >= 60 {
            return .poor
        }
        if (rttMs ?? 0) >= 250 || (packetLoss ?? 0) >= 0.05 || (jitterMs ?? 0) >= 30 {
            return .fair
        }
        return .good
    }

    private static func deriveAvailableBitrateQuality(
        availableBitrate: Double?,
        mediaBitrate: Double?,
        fairBitrate: Double,
        poorBitrate: Double,
        emergencyBitrate: Double,
        encoderLimited: Bool
    ) -> ConnectionQuality {
        guard let availableBitrate, availableBitrate > 0, availableBitrate <= fairBitrate else {
            return .unknown
        }
        guard isLowAvailableBitrate(
            availableBitrate: availableBitrate,
            mediaBitrate: mediaBitrate,
            encoderLimited: encoderLimited
        ) else {
            return .unknown
        }

        if availableBitrate <= emergencyBitrate {
            return .emergency
        }
        if availableBitrate <= poorBitrate {
            return .poor
        }
        return .fair
    }

    private static func isLowAvailableBitrate(
        availableBitrate: Double,
        mediaBitrate: Double?,
        encoderLimited: Bool
    ) -> Bool {
        if encoderLimited {
            return true
        }
        guard let mediaBitrate, mediaBitrate > 0 else {
            return false
        }
        return mediaBitrate >= availableBitrate * availableBitrateSaturationRatio
    }

    private static func worstConnectionQuality(_ qualities: ConnectionQuality...) -> ConnectionQuality {
        qualities.max { qualityRank($0) < qualityRank($1) } ?? .unknown
    }

    private static func qualityRank(_ quality: ConnectionQuality) -> Int {
        switch quality {
        case .unknown: return 0
        case .good: return 1
        case .fair: return 2
        case .poor: return 3
        case .emergency: return 4
        }
    }

    private static func statsMediaKind(_ obj: [String: Any]) -> String? {
        ((obj["kind"] as? String) ?? (obj["mediaType"] as? String))?.lowercased()
    }

    private static func isMediaRtpStats(_ obj: [String: Any]) -> Bool {
        let kind = statsMediaKind(obj)
        return kind == "audio" || kind == "video"
    }

    private static func addNullable(_ current: Double?, _ next: Double?) -> Double? {
        guard let next else {
            return current
        }
        guard let current else {
            return next
        }
        return current + next
    }

    private static func minPositiveNullable(_ current: Double?, _ next: Double?) -> Double? {
        guard let next, next > 0 else {
            return current
        }
        guard let current, current > 0 else {
            return next
        }
        return min(current, next)
    }

    private static func windowedBitrate(
        currentBytes: Double?,
        previousBytes: Double?,
        elapsedMs: Double
    ) -> Double? {
        guard let currentBytes,
              let previousBytes,
              elapsedMs >= 250 else {
            return nil
        }
        let deltaBytes = currentBytes - previousBytes
        guard deltaBytes >= 0 else {
            return nil
        }
        return (deltaBytes * 8_000) / elapsedMs
    }

    private static func hasEncoderQualityLimitation(_ reason: String?) -> Bool {
        guard let reason else {
            return false
        }
        let normalized = reason.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !normalized.isEmpty && normalized != "none"
    }

    private static func selectQualityLimitationReason(_ current: String?, _ next: String?) -> String? {
        guard let next else {
            return current
        }
        guard let current else {
            return next
        }
        return qualityLimitationRank(next) > qualityLimitationRank(current) ? next : current
    }

    private static func qualityLimitationRank(_ reason: String?) -> Int {
        switch reason?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "bandwidth": return 3
        case "cpu": return 2
        case "other": return 1
        default: return 0
        }
    }

    private static func parseInboundVideoDecode(_ statsJson: String) -> (frames: Double, bytes: Double)? {
        guard let data = statsJson.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return nil
        }
        for obj in array {
            guard (obj["type"] as? String) == "inbound-rtp" else { continue }
            let kind = (obj["kind"] as? String) ?? (obj["mediaType"] as? String)
            guard kind == "video",
                  let frames = statsNumber(obj, "framesDecoded"),
                  let bytes = statsNumber(obj, "bytesReceived") else {
                continue
            }
            return (frames: frames, bytes: bytes)
        }
        return nil
    }

    /// Mirrors the web freeze watchdog: for each remote VIDEO consumer, if
    /// framesDecoded stays flat while real media still flows (bytesReceived
    /// climbs >= threshold) across 2 consecutive checks, the decoder is stuck on
    /// a stale frame - request a keyframe (PLI) so it un-freezes. A frozen decoder
    /// that keeps receiving RTP is invisible to track-mute callbacks, so this is
    /// the only path that recovers it. Driven from the VM poll (~every 2s).
    func checkVideoFreezes() async {
        let minStallByteDelta: Double = 8000
        let stallSamplesBeforePLI = 2
        var active = Set<String>()
        for (consumerId, info) in consumers where info.kind == "video" {
            active.insert(consumerId)
            guard let sample = Self.parseInboundVideoDecode(info.consumer.stats) else { continue }
            let prev = videoFreezeStats[consumerId]
            var stalls = 0
            if let prev = prev {
                let stuck = sample.frames == prev.frames
                    && (sample.bytes - prev.bytes) >= minStallByteDelta
                stalls = stuck ? prev.stalls + 1 : 0
            }
            if stalls >= stallSamplesBeforePLI {
                // Still frozen - request a keyframe. Do NOT reset the stall
                // counter: if this PLI is lost on a congested link, the next
                // ~2s poll still sees frames flat and re-requests immediately,
                // instead of waiting out two fresh stall windows (~4s of dead
                // video). The counter resets to 0 naturally once frames advance.
                try? await socketManager?.resumeConsumer(consumerId: consumerId, requestKeyFrame: true)
            }
            videoFreezeStats[consumerId] = (frames: sample.frames, bytes: sample.bytes, stalls: stalls)
        }
        for key in Array(videoFreezeStats.keys) where !active.contains(key) {
            videoFreezeStats.removeValue(forKey: key)
            remoteConsumerPreferenceSignatures.removeValue(forKey: key)
            remoteConsumerLayerPreferenceUnsupportedIds.remove(key)
            remoteConsumerPreferenceInFlightIds.remove(key)
        }
    }

    // MARK: - Cleanup

    func cleanup(notifyLocalState: Bool = true) async {
        configurationGeneration += 1
        await videoCapturer?.stopCapture()
        videoCapturer = nil

        audioProducer?.close()
        videoProducer?.close()
        screenProducer?.close()
        audioProducer = nil
        videoProducer = nil
        screenProducer = nil
        currentLocalBandwidthQuality = .unknown
        audioProducerBandwidthQuality = .unknown
        screenProducerBandwidthQuality = .unknown
        audioBandwidthRefreshInFlight = false
        screenBandwidthRefreshInFlight = false
        audioCaptureReassertionTask?.cancel()
        audioCaptureReassertionTask = nil
        audioCaptureRestartTask?.cancel()
        audioCaptureRestartTask = nil
        callAudioRouteNotificationTask?.cancel()
        callAudioRouteNotificationTask = nil
        lastAppliedLocalBandwidthSignature = nil
        resetScreenFrameLimiter()

        for (_, info) in consumers {
            info.consumer.close()
        }
        consumers.removeAll()
        videoFreezeStats.removeAll()
        remoteConsumerPreferenceSignatures.removeAll()
        remoteConsumerLayerPreferenceUnsupportedIds.removeAll()
        remoteConsumerPreferenceInFlightIds.removeAll()
        remoteConsumerPreferenceRetryTask?.cancel()
        remoteConsumerPreferenceRetryTask = nil
        previousPublishConnectionLossSample = nil
        previousReceiveConnectionLossSample = nil
        previousPublishMediaCounterSample = nil
        previousReceiveMediaCounterSample = nil

        rtcLocalVideoTrack?.isEnabled = false
        rtcLocalAudioTrack?.isEnabled = false
        rtcLocalVideoTrack = nil
        rtcLocalAudioTrack = nil
        videoSource = nil
        audioSource = nil

        // Reset the produce-state flags. The VM (and this client) is now a
        // process-wide singleton reused across calls, so leaving them stale-true
        // would make the NEXT join's unmute / camera-on take the resume branch
        // (`guard let producer = audioProducer else { return }`) against a
        // now-nil producer - silently producing nothing (inaudible / black tile,
        // no error). They're otherwise only cleared by onTransportClose, which
        // cannot fire here since the producers are nilled before the transport
        // closes. Resetting them makes a reused client create fresh producers.
        // On a rejoin (notifyLocalState:false) suppress the change callbacks so
        // their async @MainActor hop doesn't land after the VM restores the
        // user's mute/camera intent and flip it back.
        suppressLocalStateCallbacks = !notifyLocalState
        localAudioEnabled = false
        localVideoEnabled = false
        suppressLocalStateCallbacks = false

        localVideoTrack = nil
        remoteVideoTracks.removeAll()

        sendTransport?.close()
        receiveTransport?.close()
        sendTransport = nil
        receiveTransport = nil
        transportConnectionStates.removeAll()
        device = nil
        runtimeIceServersJSON = nil

        try? audioSession.setActive(false)

        debugLog("[WebRTC] Cleanup complete")
    }

    // MARK: - Legacy Camera Session (for preview without producing)

    func getCaptureSession() -> AVCaptureSession? {
        if captureSession == nil {
            setupPreviewCaptureSession()
        }
        return captureSession
    }

    func setupPreviewCaptureSession() {
        let session = AVCaptureSession()
        session.sessionPreset = .medium

        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
            return
        }

        guard let input = try? AVCaptureDeviceInput(device: device) else {
            return
        }

        if session.canAddInput(input) {
            session.addInput(input)
        }

        session.startRunning()

        self.captureSession = session
    }

    func stopPreviewSession() {
        captureSession?.stopRunning()
        captureSession = nil
    }

    // MARK: - JSON Helpers

    func encodeJSONString<T: Encodable>(_ value: T) throws -> String {
        let data = try JSONEncoder().encode(value)
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    func decodeJSONString<T: Decodable>(_ string: String, as type: T.Type) throws -> T {
        let data = string.data(using: .utf8) ?? Data()
        return try JSONDecoder().decode(T.self, from: data)
    }

}

// MARK: - Mediasoup Delegates

extension WebRTCClient: SendTransportDelegate, ReceiveTransportDelegate, ProducerDelegate, ConsumerDelegate {
    nonisolated func onConnect(transport: any Transport, dtlsParameters: String) {
        Task { @MainActor in
            guard let socket = self.socketManager else { return }
            do {
                let params = try self.decodeJSONString(dtlsParameters, as: DtlsParameters.self)
                if transport.id == self.sendTransportId {
                    try await socket.connectProducerTransport(transportId: transport.id, dtlsParameters: params)
                } else {
                    try await socket.connectConsumerTransport(transportId: transport.id, dtlsParameters: params)
                }
            } catch {
                debugLog("[WebRTC] Transport connect failed: \(error)")
            }
        }
    }

    nonisolated func onConnectionStateChange(transport: any Transport, connectionState: TransportConnectionState) {
        Task { @MainActor in
            let stateName: String
            switch connectionState {
            case .connected, .completed:
                self.connectionState = .connected
                stateName = "connected"
            case .failed:
                self.connectionState = .failed
                stateName = "failed"
            case .disconnected:
                self.connectionState = .disconnected
                stateName = "disconnected"
            case .closed:
                self.connectionState = .closed
                stateName = "closed"
            case .new, .checking:
                self.connectionState = .new
                stateName = "new"
            @unknown default:
                self.connectionState = .failed
                stateName = "failed"
            }

            let transportKind: String
            if transport.id == self.sendTransportId {
                transportKind = "producer"
            } else if transport.id == self.receiveTransportId {
                transportKind = "consumer"
            } else {
                return
            }
            self.transportConnectionStates[transport.id] = stateName
            self.onTransportConnectionStateChanged?(transportKind, stateName)
        }
    }

    nonisolated func onProduce(
        transport: any Transport,
        kind: MediaKind,
        rtpParameters: String,
        appData: String,
        callback: @escaping (String?) -> Void
    ) {
        Task { @MainActor in
            guard let socket = self.socketManager else {
                callback(nil)
                return
            }
            do {
                let params = try self.decodeJSONString(rtpParameters, as: RtpParameters.self)
                let appDataPayload = try? self.decodeJSONString(appData, as: ProducerAppData.self)
                let type = ProducerType(rawValue: appDataPayload?.type ?? "webcam") ?? .webcam
                let producerId = try await socket.produce(
                    transportId: transport.id,
                    kind: kind == .audio ? "audio" : "video",
                    rtpParameters: params,
                    type: type,
                    paused: appDataPayload?.paused ?? false
                )
                callback(producerId)
            } catch {
                debugLog("[WebRTC] Produce failed: \(error)")
                callback(nil)
            }
        }
    }

    nonisolated func onProduceData(
        transport: any Transport,
        sctpParameters: String,
        label: String,
        protocol dataProtocol: String,
        appData: String,
        callback: @escaping (String?) -> Void
    ) {
        callback(nil)
    }

    nonisolated func onTransportClose(in producer: Producer) {
        Task { @MainActor in
            if producer.id == self.audioProducer?.id {
                self.audioProducer = nil
                self.audioProducerBandwidthQuality = .unknown
                self.audioCaptureReassertionTask?.cancel()
                self.audioCaptureReassertionTask = nil
                self.audioCaptureRestartTask?.cancel()
                self.audioCaptureRestartTask = nil
                let previousSuppressLocalStateCallbacks = self.suppressLocalStateCallbacks
                self.suppressLocalStateCallbacks = true
                self.localAudioEnabled = false
                self.suppressLocalStateCallbacks = previousSuppressLocalStateCallbacks
                self.onLocalAudioProducerLost?()
            } else if producer.id == self.videoProducer?.id {
                self.videoProducer = nil
                let previousSuppressLocalStateCallbacks = self.suppressLocalStateCallbacks
                self.suppressLocalStateCallbacks = true
                self.localVideoEnabled = false
                self.suppressLocalStateCallbacks = previousSuppressLocalStateCallbacks
                self.onLocalVideoProducerLost?()
            } else if producer.id == self.screenProducer?.id {
                self.screenProducer = nil
                self.screenProducerBandwidthQuality = .unknown
                self.resetScreenFrameLimiter()
            }
        }
    }

    nonisolated func onTransportClose(in consumer: Consumer) {
        Task { @MainActor in
            let entry = self.consumers.first { $0.value.consumer.id == consumer.id }
            if let entry {
                self.consumers.removeValue(forKey: entry.key)
                self.videoFreezeStats.removeValue(forKey: entry.key)
                self.remoteConsumerPreferenceSignatures.removeValue(forKey: entry.key)
                self.remoteConsumerLayerPreferenceUnsupportedIds.remove(entry.key)
                self.remoteConsumerPreferenceInFlightIds.remove(entry.key)
                if entry.value.kind == "video" {
                    let trackKey = entry.value.trackKey.isEmpty ? entry.value.userId : entry.value.trackKey
                    if !trackKey.isEmpty {
                        self.remoteVideoTracks.removeValue(forKey: trackKey)
                    }
                }
            }
        }
    }
}

// MARK: - Audio Device Routing (iOS)

extension WebRTCClient {
    func activateCallAudioSession() {
        do {
            try configureCallAudioSession()
            scheduleLocalAudioCaptureReassertion()
        } catch {
            debugLog("[WebRTC] activate call audio session failed: \(error)")
        }
    }

    func recoverCallAudioSessionAfterRouteChange() {
        do {
            try configureCallAudioSession()
            scheduleLocalAudioCaptureReassertion(forceCaptureRestart: true)
        } catch {
            debugLog("[WebRTC] recover call audio route failed: \(error)")
        }
    }

    func currentCallAudioSessionOptions() -> AVAudioSession.CategoryOptions {
        callAudioSessionOptions()
    }

    private func configureCallAudioSession() throws {
        try audioSession.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: callAudioSessionOptions()
        )
        try audioSession.setActive(true)
        try applySelectedAudioRoutes()
    }

    private func reassertLocalAudioCaptureState() {
        guard localAudioEnabled else { return }
        guard hasLocalAudioProducer else {
            onLocalAudioProducerLost?()
            return
        }
        rtcLocalAudioTrack?.isEnabled = true
        audioProducer?.resume()
    }

    private func scheduleLocalAudioCaptureReassertion(forceCaptureRestart: Bool = false) {
        audioCaptureReassertionTask?.cancel()
        reassertLocalAudioCaptureState()
        if forceCaptureRestart {
            restartLocalAudioCaptureAfterRouteChange()
        }
        audioCaptureReassertionTask = Task { @MainActor [weak self] in
            for delay in [250_000_000, 1_000_000_000, 2_500_000_000, 5_000_000_000] as [UInt64] {
                try? await Task.sleep(nanoseconds: delay)
                guard let self, !Task.isCancelled, self.localAudioEnabled else { return }
                do {
                    try self.configureCallAudioSession()
                } catch {
                    debugLog("[WebRTC] delayed audio session reassert failed: \(error)")
                }
                self.reassertLocalAudioCaptureState()
            }
        }
    }

    private func restartLocalAudioCaptureAfterRouteChange() {
        guard localAudioEnabled,
              hasLocalAudioProducer,
              !audioBandwidthRefreshInFlight,
              audioCaptureRestartTask == nil,
              let track = rtcLocalAudioTrack else { return }
        let generation = configurationGeneration
        track.isEnabled = false
        audioCaptureRestartTask = Task { @MainActor [weak self, weak track] in
            try? await Task.sleep(nanoseconds: 80_000_000)
            guard let self else { return }
            defer { self.audioCaptureRestartTask = nil }
            guard !Task.isCancelled,
                  self.configurationGeneration == generation,
                  self.localAudioEnabled,
                  self.hasLocalAudioProducer,
                  let track,
                  self.rtcLocalAudioTrack === track else { return }
            await self.recreateLocalAudioProducerAfterRouteChange(previousTrack: track)
        }
    }

    private func recreateLocalAudioProducerAfterRouteChange(previousTrack: RTCAudioTrack) async {
        guard
            localAudioEnabled,
            hasLocalAudioProducer,
            !audioBandwidthRefreshInFlight,
            let socketManager,
            let sendTransport,
            let oldProducer = audioProducer
        else {
            previousTrack.isEnabled = true
            reassertLocalAudioCaptureState()
            return
        }

        let generation = configurationGeneration
        var pendingProducer: Producer?
        var pendingTrack: RTCAudioTrack?
        do {
            try configureCallAudioSession()
            guard generation == configurationGeneration, localAudioEnabled, hasLocalAudioProducer else {
                previousTrack.isEnabled = true
                reassertLocalAudioCaptureState()
                return
            }

            let microphone = createMicrophoneAudioTrack()
            pendingTrack = microphone.track
            let nextProducer = try createMicrophoneProducer(on: sendTransport, track: microphone.track)
            pendingProducer = nextProducer
            nextProducer.resume()

            guard generation == configurationGeneration, localAudioEnabled else {
                await closeUncommittedReplacementProducer(
                    pendingProducer,
                    socketManager: socketManager,
                    reason: "route recovery abort"
                )
                pendingProducer = nil
                pendingTrack?.isEnabled = false
                previousTrack.isEnabled = true
                reassertLocalAudioCaptureState()
                return
            }

            audioSource = microphone.source
            rtcLocalAudioTrack = microphone.track
            audioProducer = nextProducer
            audioProducerBandwidthQuality = currentLocalBandwidthQuality
            localAudioEnabled = true
            microphone.track.isEnabled = true
            scheduleLocalAudioCaptureReassertion()
            await markMicrophoneProducerUnmuted(nextProducer.id, reason: "route recovery")
            pendingProducer = nil
            pendingTrack = nil

            do {
                try await socketManager.closeProducer(producerId: oldProducer.id)
            } catch {
                debugLog("[WebRTC] Failed to notify SFU of route-recovered microphone producer close: \(error)")
            }
            oldProducer.close()
            previousTrack.isEnabled = false
            debugLog("[WebRTC] Recreated microphone producer after audio route change")
        } catch {
            await closeUncommittedReplacementProducer(
                pendingProducer,
                socketManager: socketManager,
                reason: "route recovery failure"
            )
            pendingProducer = nil
            pendingTrack?.isEnabled = false
            previousTrack.isEnabled = true
            reassertLocalAudioCaptureState()
            debugLog("[WebRTC] Failed to recreate microphone producer after audio route change: \(error)")
        }
    }

    private func closeUncommittedReplacementProducer(
        _ producer: Producer?,
        socketManager: SocketIOManager,
        reason: String
    ) async {
        guard let producer else { return }
        if ReplacementProducerCleanupPolicy.shouldCloseUncommittedReplacement(
            replacementProducerId: producer.id,
            currentProducerId: audioProducer?.id
        ) {
            do {
                try await socketManager.closeProducer(producerId: producer.id)
            } catch {
                debugLog("[WebRTC] Failed to notify SFU of uncommitted microphone producer close after \(reason): \(error)")
            }
        }
        producer.close()
    }

    private func callAudioSessionOptions() -> AVAudioSession.CategoryOptions {
        CallAudioSession.voiceCallCategoryOptions(defaultToSpeaker: shouldDefaultCallAudioToSpeaker())
    }

    private func shouldDefaultCallAudioToSpeaker() -> Bool {
        CallAudioRoutePolicy.shouldDefaultToSpeaker(
            selectedOutputId: selectedAudioOutputId,
            hasExternalOutputRoute: hasExternalCallOutputRoute()
        )
    }

    private func hasExternalCallOutputRoute() -> Bool {
        let externalOutputPorts: Set<AVAudioSession.Port> = [
            .bluetoothHFP,
            .bluetoothA2DP,
            .headphones,
            .usbAudio,
            .carAudio
        ]
        return audioSession.currentRoute.outputs.contains { externalOutputPorts.contains($0.portType) }
    }

    private func appendAudioDevice(_ device: AudioDevice, to devices: inout [AudioDevice], seenIds: inout Set<String>) {
        guard seenIds.insert(device.id).inserted else { return }
        devices.append(device)
    }

    /// Microphone inputs reported by AVAudioSession (built-in mic, wired headset,
    /// any connected Bluetooth HFP device). The port UID is the stable selection id.
    func availableAudioInputs() -> [AudioDevice] {
        let inputs = audioSession.availableInputs ?? []
        return inputs.map { AudioDevice(id: $0.uid, label: $0.portName) }
    }

    /// Output routes. Built-in Speaker / Receiver (earpiece) are always offered;
    /// any connected Bluetooth/wired output is added from the active route. The
    /// id is a synthetic key we interpret in `selectAudioOutput`.
    func availableAudioOutputs() -> [AudioDevice] {
        var devices: [AudioDevice] = [
            AudioDevice(id: "speaker", label: "Speaker"),
            AudioDevice(id: "receiver", label: "Earpiece")
        ]
        var seenIds = Set(devices.map(\.id))
        for input in audioSession.availableInputs ?? [] {
            switch input.portType {
            case .bluetoothHFP, .headsetMic, .usbAudio, .carAudio:
                appendAudioDevice(AudioDevice(id: input.uid, label: input.portName), to: &devices, seenIds: &seenIds)
            default:
                break
            }
        }
        for output in audioSession.currentRoute.outputs {
            switch output.portType {
            case .bluetoothHFP, .bluetoothA2DP:
                appendAudioDevice(AudioDevice(id: output.uid, label: output.portName), to: &devices, seenIds: &seenIds)
            case .headphones, .usbAudio, .carAudio:
                appendAudioDevice(AudioDevice(id: output.uid, label: output.portName), to: &devices, seenIds: &seenIds)
            default:
                break
            }
        }
        return devices
    }

    func currentAudioInputId() -> String? {
        if let selectedAudioInputId,
           availableAudioInputs().contains(where: { $0.id == selectedAudioInputId }) {
            return selectedAudioInputId
        }
        return audioSession.preferredInput?.uid ?? audioSession.currentRoute.inputs.first?.uid
    }

    func currentAudioOutputId() -> String? {
        if let selectedAudioOutputId,
           availableAudioOutputs().contains(where: { $0.id == selectedAudioOutputId }) {
            return selectedAudioOutputId
        }
        guard let output = audioSession.currentRoute.outputs.first else { return "receiver" }
        switch output.portType {
        case .builtInSpeaker: return "speaker"
        case .builtInReceiver: return "receiver"
        default: return output.uid
        }
    }

    func selectAudioInput(_ deviceId: String) {
        let trimmed = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if trimmed.isEmpty {
                selectedAudioInputId = nil
                try applySelectedAudioRoutes()
                reassertAudioAfterRouteSelection()
                return
            }
            guard let input = (audioSession.availableInputs ?? []).first(where: { $0.uid == trimmed }) else { return }
            selectedAudioInputId = input.uid
            try applySelectedAudioRoutes()
            reassertAudioAfterRouteSelection()
        } catch {
            debugLog("[WebRTC] setPreferredInput failed: \(error)")
        }
    }

    func selectAudioOutput(_ deviceId: String) {
        let trimmed = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            selectedAudioOutputId = trimmed.isEmpty ? nil : trimmed
            try configureCallAudioSession()
            reassertAudioAfterRouteSelection()
        } catch {
            debugLog("[WebRTC] selectAudioOutput failed: \(error)")
        }
    }

    private func reassertAudioAfterRouteSelection() {
        guard localAudioEnabled else { return }
        reassertLocalAudioCaptureState()
        scheduleLocalAudioCaptureReassertion(forceCaptureRestart: true)
        notifyCallAudioRouteChanged()
    }

    private func notifyCallAudioRouteChanged() {
        guard localAudioEnabled,
              onCallAudioRouteChanged != nil,
              callAudioRouteNotificationTask == nil else { return }
        callAudioRouteNotificationTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 50_000_000)
            guard let self, !Task.isCancelled else { return }
            self.callAudioRouteNotificationTask = nil
            self.onCallAudioRouteChanged?()
        }
    }

    private func preferredCallInput(for outputId: String?) -> AVAudioSessionPortDescription? {
        let inputs = audioSession.availableInputs ?? []
        if let outputId,
           let matchingInput = inputs.first(where: { $0.uid == outputId }) {
            return matchingInput
        }
        if outputId != nil {
            return inputs.first(where: { $0.portType == .builtInMic }) ?? inputs.first
        }

        let externalCallInputs: [AVAudioSession.Port] = [
            .bluetoothHFP,
            .headsetMic,
            .usbAudio,
            .carAudio
        ]
        for portType in externalCallInputs {
            if let input = inputs.first(where: { $0.portType == portType }) {
                return input
            }
        }

        return inputs.first(where: { $0.portType == .builtInMic })
    }

    private func applySelectedAudioRoutes() throws {
        normalizeSelectedAudioRoutes()

        if let selectedAudioInputId {
            if let input = (audioSession.availableInputs ?? []).first(where: { $0.uid == selectedAudioInputId }) {
                try audioSession.setPreferredInput(input)
            } else {
                self.selectedAudioInputId = nil
                try audioSession.setPreferredInput(preferredCallInput(for: selectedAudioOutputId))
            }
        } else {
            try audioSession.setPreferredInput(preferredCallInput(for: selectedAudioOutputId))
        }

        switch selectedAudioOutputId {
        case nil:
            try audioSession.overrideOutputAudioPort(.none)
        case .some("speaker"):
            try audioSession.overrideOutputAudioPort(.speaker)
        case .some("receiver"):
            try audioSession.overrideOutputAudioPort(.none)
        case .some(let outputId):
            try audioSession.overrideOutputAudioPort(.none)
            if let input = (audioSession.availableInputs ?? []).first(where: { $0.uid == outputId }) {
                try audioSession.setPreferredInput(input)
            }
        }
    }

    private func normalizeSelectedAudioRoutes() {
        let inputs = audioSession.availableInputs ?? []
        if let selectedAudioInputId,
           !inputs.contains(where: { $0.uid == selectedAudioInputId }) {
            self.selectedAudioInputId = nil
        }

        if let selectedAudioOutputId,
           selectedAudioOutputId != "speaker",
           selectedAudioOutputId != "receiver",
           !availableAudioOutputs().contains(where: { $0.id == selectedAudioOutputId }) {
            self.selectedAudioOutputId = nil
        }
    }

    /// Plays a short system sound through the current output route so the user can
    /// confirm the selected speaker is audible (mirrors web's "Test speaker").
    func testSpeaker() {
        // 1057 is the short "Tink" UI sound; routes through the active session.
        AudioServicesPlaySystemSound(SystemSoundID(1057))
    }
}

// MARK: - ICE Server Model

private struct IceServer: Encodable {
    let urls: [String]
    let username: String?
    let credential: String?
}

// MARK: - Errors

// MARK: - Screen Sharing

extension WebRTCClient {
    var screenCapturer: RTCVideoCapturer? {
        return screenVideoCapturer
    }

    private func nextScreenVideoTrackId() -> String {
        screenVideoTrackSequence += 1
        return "screen\(screenVideoTrackSequence)"
    }
    
    private var screenVideoCapturer: RTCVideoCapturer? {
        get { objc_getAssociatedObject(self, &screenCapturerKey) as? RTCVideoCapturer }
        set { objc_setAssociatedObject(self, &screenCapturerKey, newValue, .OBJC_ASSOCIATION_RETAIN) }
    }
    
    func startScreenSharing() async throws {
        try await createSendTransportIfNeeded()
        guard let sendTransport = sendTransport else {
            throw WebRTCError.noTransport
        }
        
        let screenSource = Self.factory.videoSource()
        resetScreenFrameLimiter()
        ScreenCaptureManager.shared.updateMaxFrameRate(screenShareCaptureMaxFramerate)
        self.screenVideoSource = screenSource
        self.screenVideoCapturer = RTCVideoCapturer(delegate: screenSource)
        
        let screenTrack = Self.factory.videoTrack(with: screenSource, trackId: nextScreenVideoTrackId())
        screenTrack.isEnabled = true
        self.rtcScreenTrack = screenTrack

        do {
            let appData = try encodeJSONString(ProducerAppData(type: ProducerType.screen.rawValue, paused: false))
            let producer = try requireRegisteredProducer(
                sendTransport.createProducer(
                    for: screenTrack,
                    encoding: screenShareEncoding(
                        connectionQuality: currentLocalBandwidthQuality
                    ),
                    scalabilityMode: Self.screenShareScalabilityMode,
                    codecOptions: nil,
                    codec: preferredVideoCodecJSON(),
                    appData: appData
                ),
                label: "screen"
            )
            producer.delegate = self
            producer.resume()

            screenProducer = producer
            screenProducerBandwidthQuality = currentLocalBandwidthQuality

            debugLog("[WebRTC] Screen sharing producer created: \(producer.id)")
        } catch {
            screenTrack.isEnabled = false
            rtcScreenTrack = nil
            screenVideoSource = nil
            screenVideoCapturer = nil
            screenProducer = nil
            resetScreenFrameLimiter()
            throw error
        }
    }
    
    func stopScreenSharing() async {
        screenProducer?.close()
        screenProducer = nil
        screenProducerBandwidthQuality = .unknown
        
        rtcScreenTrack?.isEnabled = false
        rtcScreenTrack = nil
        screenVideoSource = nil
        screenVideoCapturer = nil
        resetScreenFrameLimiter()
        
        debugLog("[WebRTC] Screen sharing stopped")
    }
    
    /// Feed a video frame from screen capture to WebRTC
    func feedScreenFrame(_ frame: RTCVideoFrame) {
        guard let source = screenVideoSource,
              let capturer = screenVideoCapturer else { return }
        guard shouldForwardScreenFrame() else { return }
        source.capturer(capturer, didCapture: frame)
    }

    private func shouldForwardScreenFrame(
        nowNanoseconds: UInt64 = DispatchTime.now().uptimeNanoseconds
    ) -> Bool {
        let maxFramerate = max(1.0, screenShareCaptureMaxFramerate)
        let minIntervalNs = UInt64(1_000_000_000.0 / maxFramerate)
        if lastForwardedScreenFrameNs != 0,
           nowNanoseconds - lastForwardedScreenFrameNs < minIntervalNs {
            return false
        }
        lastForwardedScreenFrameNs = nowNanoseconds
        return true
    }

    private func resetScreenFrameLimiter() {
        lastForwardedScreenFrameNs = 0
    }
    
    private var screenVideoSource: RTCVideoSource? {
        get { objc_getAssociatedObject(self, &screenSourceKey) as? RTCVideoSource }
        set { objc_setAssociatedObject(self, &screenSourceKey, newValue, .OBJC_ASSOCIATION_RETAIN) }
    }
    
    fileprivate var rtcScreenTrack: RTCVideoTrack? {
        get { objc_getAssociatedObject(self, &screenTrackKey) as? RTCVideoTrack }
        set { objc_setAssociatedObject(self, &screenTrackKey, newValue, .OBJC_ASSOCIATION_RETAIN) }
    }
}

private var screenCapturerKey: UInt8 = 0
private var screenSourceKey: UInt8 = 0
private var screenTrackKey: UInt8 = 0

enum WebRTCError: LocalizedError {
    case notConfigured
    case staleConfiguration
    case noTransport
    case permissionDenied
    case noCameraAvailable
    case connectionFailed(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "WebRTC client not configured"
        case .staleConfiguration:
            return "WebRTC session was replaced"
        case .noTransport:
            return "Transport not created"
        case .permissionDenied:
            return "Camera/microphone permission denied"
        case .noCameraAvailable:
            return "No camera available"
        case .connectionFailed(let reason):
            return "Connection failed: \(reason)"
        }
    }
}
#endif
