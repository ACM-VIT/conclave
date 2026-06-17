#if os(iOS) && !SKIP && canImport(WebRTC)
//
//  WebRTCClient.swift
//  Conclave
//
//  Mediasoup client bridge for SwiftUI
//

import Foundation
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

    /// When true, mutating localAudioEnabled/localVideoEnabled does NOT fire the
    /// onLocal*EnabledChanged callbacks. The binding handlers hop through
    /// `Task { @MainActor }` (async), so on the reconnect-rejoin path a cleanup()
    /// that fired them would land AFTER the VM restored the user's mute/camera
    /// intent and flip it back — leaving an unmuted user rejoining muted. The
    /// rejoin teardown sets this via cleanup(notifyLocalState: false).
    private var suppressLocalStateCallbacks = false
    private(set) var localAudioEnabled: Bool = false {
        didSet { if !suppressLocalStateCallbacks { onLocalAudioEnabledChanged?(localAudioEnabled) } }
    }
    private(set) var localVideoEnabled: Bool = false {
        didSet { if !suppressLocalStateCallbacks { onLocalVideoEnabledChanged?(localVideoEnabled) } }
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
        // "{userId}" for webcam, "{userId}-screen" for a screen-share — so a
        // user's webcam and screen tracks coexist instead of overwriting.
        var trackKey: String = ""
    }

    var consumers: [String: ConsumerInfo] = [:]

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
            info.consumer.close()
            consumers.removeValue(forKey: consumerId)
            videoFreezeStats.removeValue(forKey: consumerId)

            let key = info.trackKey.isEmpty ? info.userId : info.trackKey
            if !key.isEmpty {
                remoteVideoTracks.removeValue(forKey: key)
            }
        }
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
    var captureSession: AVCaptureSession?

    // MARK: - Audio Session

    var audioSession = AVAudioSession.sharedInstance()

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
        guard let socket = socketManager,
              let device = device else {
            throw WebRTCError.notConfigured
        }

        let iceServers = runtimeIceServersJSON ?? resolveIceServersJSON()

        let generation = configurationGeneration
        let producerTransportParams = try await socket.createProducerTransport()
        guard generation == configurationGeneration else { throw WebRTCError.staleConfiguration }
        let consumerTransportParams = try await socket.createConsumerTransport()
        guard generation == configurationGeneration else { throw WebRTCError.staleConfiguration }

        let nextSendTransport = try device.createSendTransport(
            id: producerTransportParams.id,
            iceParameters: try encodeJSONString(producerTransportParams.iceParameters),
            iceCandidates: try encodeJSONString(producerTransportParams.iceCandidates),
            dtlsParameters: try encodeJSONString(producerTransportParams.dtlsParameters),
            sctpParameters: nil,
            iceServers: iceServers,
            appData: nil
        )
        nextSendTransport.delegate = self

        let nextReceiveTransport = try device.createReceiveTransport(
            id: consumerTransportParams.id,
            iceParameters: try encodeJSONString(consumerTransportParams.iceParameters),
            iceCandidates: try encodeJSONString(consumerTransportParams.iceCandidates),
            dtlsParameters: try encodeJSONString(consumerTransportParams.dtlsParameters),
            sctpParameters: nil,
            iceServers: iceServers,
            appData: nil
        )
        nextReceiveTransport.delegate = self

        guard generation == configurationGeneration else {
            nextSendTransport.close()
            nextReceiveTransport.close()
            throw WebRTCError.staleConfiguration
        }

        sendTransport?.close()
        receiveTransport?.close()
        sendTransportId = producerTransportParams.id
        receiveTransportId = consumerTransportParams.id
        sendTransport = nextSendTransport
        receiveTransport = nextReceiveTransport

        debugLog("[WebRTC] Transports created: send=\(producerTransportParams.id), recv=\(consumerTransportParams.id)")
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
        guard let sendTransport = sendTransport else {
            throw WebRTCError.noTransport
        }

        try await ensureMicrophonePermission()
        try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try audioSession.setActive(true)

        let audioConstraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: [
                "googEchoCancellation": "true",
                "googAutoGainControl": "true",
                "googNoiseSuppression": "true"
            ]
        )

        let source = Self.factory.audioSource(with: audioConstraints)
        let track = Self.factory.audioTrack(with: source, trackId: "audio0")
        track.isEnabled = true

        let appData = try encodeJSONString(ProducerAppData(type: ProducerType.webcam.rawValue, paused: false))
        let producer = try sendTransport.createProducer(
            for: track,
            encodings: nil,
            codecOptions: nil,
            codec: nil,
            appData: appData
        )
        producer.delegate = self
        producer.resume()

        audioSource = source
        rtcLocalAudioTrack = track
        audioProducer = producer
        localAudioEnabled = true

        debugLog("[WebRTC] Audio producer created: \(producer.id)")
    }

    private func ensureMicrophonePermission() async throws {
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

    func startProducingVideo() async throws {
        guard let sendTransport = sendTransport else {
            throw WebRTCError.noTransport
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

        let source = Self.factory.videoSource()
        let capturer = RTCCameraVideoCapturer(delegate: source)
        videoSource = source
        videoCapturer = capturer

        do {
            try startCameraCapture()

            let track = Self.factory.videoTrack(with: source, trackId: "video0")
            track.isEnabled = true

            let appData = try encodeJSONString(ProducerAppData(type: ProducerType.webcam.rawValue, paused: false))
            let producer = try sendTransport.createProducer(
                for: track,
                encodings: nil,
                codecOptions: nil,
                codec: nil,
                appData: appData
            )
            producer.delegate = self
            producer.resume()

            rtcLocalVideoTrack = track
            videoProducer = producer
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

        let format = selectFormat(for: camera, targetWidth: 1280, targetHeight: 720)
        let fps = selectFPS(for: format, targetFPS: 30)

        capturer.startCapture(with: camera, format: format, fps: Int(fps))
    }

    func getCameraDevice(position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        let discoverySession = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .builtInDualCamera, .builtInTrueDepthCamera],
            mediaType: .video,
            position: position
        )
        return discoverySession.devices.first
    }

    func selectFormat(for device: AVCaptureDevice, targetWidth: Int32, targetHeight: Int32) -> AVCaptureDevice.Format {
        let formats = RTCCameraVideoCapturer.supportedFormats(for: device)

        var selectedFormat = formats.first!
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

    func selectFPS(for format: AVCaptureDevice.Format, targetFPS: Float64) -> Float64 {
        var maxFrameRate: Float64 = 0
        for range in format.videoSupportedFrameRateRanges {
            maxFrameRate = max(maxFrameRate, range.maxFrameRate)
        }
        return min(targetFPS, maxFrameRate)
    }

    // MARK: - Consume Remote Media

    func consumeProducer(producerId: String, producerUserId: String, producerType: String = "webcam") async throws {
        guard let socket = socketManager,
              let rtpCaps = serverRtpCapabilities,
              let receiveTransport = receiveTransport,
              let receiveTransportId = receiveTransportId else {
            throw WebRTCError.notConfigured
        }

        let response = try await socket.consume(
            producerId: producerId,
            rtpCapabilities: rtpCaps,
            transportId: receiveTransportId
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

        // A user can produce a webcam AND a screen-share at once — store them
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
            let consumerIds = consumers.filter { $0.value.userId == userId }.map { $0.key }
            for id in consumerIds {
                consumers[id]?.consumer.close()
                consumers.removeValue(forKey: id)
                videoFreezeStats.removeValue(forKey: id)
            }
        } else if let entry = consumers.first(where: { $0.value.producerId == producerId }) {
            entry.value.consumer.close()
            consumers.removeValue(forKey: entry.key)
            videoFreezeStats.removeValue(forKey: entry.key)
            // Only video consumers populate remoteVideoTracks. Screen audio uses
            // the same producer type as screen video but must not clear the
            // visible screen-share tile when its audio producer closes.
            let key = entry.value.trackKey.isEmpty ? entry.value.userId : entry.value.trackKey
            if entry.value.kind == "video", !key.isEmpty {
                remoteVideoTracks.removeValue(forKey: key)
            }
        }

        // User left entirely (empty producerId path) — clear both their slots.
        if producerId.isEmpty, !userId.isEmpty {
            remoteVideoTracks.removeValue(forKey: userId)
            remoteVideoTracks.removeValue(forKey: "\(userId)-screen")
        }
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

        let previous = localAudioEnabled
        do {
            if enabled {
                producer.resume()
            } else {
                producer.pause()
            }
            try await socket.toggleMute(producerId: producer.id, paused: !enabled)
            rtcLocalAudioTrack?.isEnabled = enabled
            localAudioEnabled = enabled
        } catch {
            if previous {
                producer.resume()
            } else {
                producer.pause()
            }
            rtcLocalAudioTrack?.isEnabled = previous
            localAudioEnabled = previous
            debugLog("[WebRTC] Failed to toggle audio: \(error)")
            throw error
        }
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
                try startCameraCapture()
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

    func closeLocalVideoProducer() async {
        guard let producerId = videoProducer?.id else { return }

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

    func updateVideoQuality(_ quality: VideoQuality) {
        guard let producer = videoProducer else { return }
        let maxBitrate: Int = quality == .low ? 350_000 : 1_200_000

        producer.updateSenderParameters { parameters in
            var next = parameters
            if var encodings = next.encodings, !encodings.isEmpty {
                encodings[0].maxBitrateBps = maxBitrate
                next.encodings = encodings
            }
            return next
        }
    }

    func switchCamera() {
        currentCameraPosition = currentCameraPosition == .front ? .back : .front
        try? startCameraCapture()
    }

    // MARK: - Get Video Track for Rendering

    func getLocalVideoTrack() -> RTCVideoTrack? {
        return rtcLocalVideoTrack
    }

    // MARK: - Active Speaker (audio levels)

    /// Reads `audioLevel` (0.0-1.0, RMS-derived) from local producer and remote
    /// consumer WebRTC stats. The shared VM picks the loudest above a threshold.
    func sampleAudioLevels(localUserId: String? = nil) -> [String: Double] {
        var levels: [String: Double] = [:]
        for (_, info) in consumers
        where info.kind == "audio" && info.type == ProducerType.webcam.rawValue {
            let statsJson = info.consumer.stats
            if let level = Self.parseInboundAudioLevel(statsJson) {
                levels[info.userId] = level
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

    private var previousConnectionLossSample: (packetsLost: Double, packetsReceived: Double)?

    func sampleConnectionQuality() -> ConnectionQuality {
        var liveTransports: [any Transport] = []
        if let sendTransport, !sendTransport.closed {
            liveTransports.append(sendTransport)
        }
        if let receiveTransport, !receiveTransport.closed {
            liveTransports.append(receiveTransport)
        }
        guard !liveTransports.isEmpty else {
            previousConnectionLossSample = nil
            return .unknown
        }

        var rttMs: Double?
        var jitterMs: Double?
        var packetsLost = 0.0
        var packetsReceived = 0.0
        var foundStats = false

        for transport in liveTransports {
            guard let sample = Self.parseConnectionStats(transport.stats) else { continue }
            foundStats = true
            if let sampleRtt = sample.rttMs {
                rttMs = max(rttMs ?? 0, sampleRtt)
            }
            if let sampleJitter = sample.jitterMs {
                jitterMs = max(jitterMs ?? 0, sampleJitter)
            }
            packetsLost += sample.packetsLost
            packetsReceived += sample.packetsReceived
        }

        guard foundStats else {
            previousConnectionLossSample = nil
            return .unknown
        }

        var packetLoss: Double?
        if let previous = previousConnectionLossSample {
            let deltaLost = max(0, packetsLost - previous.packetsLost)
            let deltaReceived = max(0, packetsReceived - previous.packetsReceived)
            let deltaTotal = deltaLost + deltaReceived
            packetLoss = deltaTotal > 0 ? deltaLost / deltaTotal : 0
        }
        previousConnectionLossSample = (packetsLost, packetsReceived)

        return Self.deriveConnectionQuality(rttMs: rttMs, packetLoss: packetLoss, jitterMs: jitterMs)
    }

    private static func parseConnectionStats(_ statsJson: String) -> (
        rttMs: Double?,
        jitterMs: Double?,
        packetsLost: Double,
        packetsReceived: Double
    )? {
        guard let data = statsJson.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return nil
        }

        var rttMs: Double?
        var candidatePairRttMs: Double?
        var jitterMs: Double?
        var packetsLost = 0.0
        var packetsReceived = 0.0
        var foundMetric = false

        for obj in array {
            switch obj["type"] as? String {
            case "candidate-pair":
                let nominated = (obj["nominated"] as? Bool) == true || (obj["state"] as? String) == "succeeded"
                if nominated, let rtt = statsNumber(obj, "currentRoundTripTime") {
                    candidatePairRttMs = max(candidatePairRttMs ?? 0, rtt * 1000)
                    foundMetric = true
                }
            case "inbound-rtp":
                if let jitter = statsNumber(obj, "jitter") {
                    jitterMs = max(jitterMs ?? 0, jitter * 1000)
                    foundMetric = true
                }
                if let lost = statsNumber(obj, "packetsLost") {
                    packetsLost += max(0, lost)
                    foundMetric = true
                }
                if let received = statsNumber(obj, "packetsReceived") {
                    packetsReceived += max(0, received)
                    foundMetric = true
                }
            case "remote-inbound-rtp":
                if let rtt = statsNumber(obj, "roundTripTime") {
                    rttMs = max(rttMs ?? 0, rtt * 1000)
                    foundMetric = true
                }
                if let jitter = statsNumber(obj, "jitter") {
                    jitterMs = max(jitterMs ?? 0, jitter * 1000)
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
        return (rttMs, jitterMs, packetsLost, packetsReceived)
    }

    private static func deriveConnectionQuality(rttMs: Double?, packetLoss: Double?, jitterMs: Double?) -> ConnectionQuality {
        if rttMs == nil && packetLoss == nil && jitterMs == nil {
            return .unknown
        }

        if (rttMs ?? 0) >= 500 || (packetLoss ?? 0) >= 0.08 || (jitterMs ?? 0) >= 60 {
            return .poor
        }
        if (rttMs ?? 0) >= 250 || (packetLoss ?? 0) >= 0.03 || (jitterMs ?? 0) >= 30 {
            return .fair
        }
        return .good
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
    /// a stale frame — request a keyframe (PLI) so it un-freezes. A frozen decoder
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
                // Still frozen — request a keyframe. Do NOT reset the stall
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

        for (_, info) in consumers {
            info.consumer.close()
        }
        consumers.removeAll()
        videoFreezeStats.removeAll()
        previousConnectionLossSample = nil

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
        // now-nil producer — silently producing nothing (inaudible / black tile,
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

    func resolveIceServersJSON() -> String? {
        let env = ProcessInfo.processInfo.environment

        let urlsRaw =
            env["TURN_URLS"] ??
            env["TURN_URL"] ??
            (Bundle.main.object(forInfoDictionaryKey: "TURN_URLS") as? String) ??
            (Bundle.main.object(forInfoDictionaryKey: "TURN_URL") as? String)

        let urls = (urlsRaw ?? "")
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        guard !urls.isEmpty else { return nil }

        let username =
            env["TURN_USERNAME"] ??
            (Bundle.main.object(forInfoDictionaryKey: "TURN_USERNAME") as? String)

        let credential =
            env["TURN_PASSWORD"] ??
            env["TURN_CREDENTIAL"] ??
            (Bundle.main.object(forInfoDictionaryKey: "TURN_PASSWORD") as? String) ??
            (Bundle.main.object(forInfoDictionaryKey: "TURN_CREDENTIAL") as? String)

        let iceServers = [IceServer(urls: urls, username: username, credential: credential)]
        return try? encodeJSONString(iceServers)
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
                self.localAudioEnabled = false
            } else if producer.id == self.videoProducer?.id {
                self.videoProducer = nil
                self.localVideoEnabled = false
            } else if producer.id == self.screenProducer?.id {
                self.screenProducer = nil
            }
        }
    }

    nonisolated func onTransportClose(in consumer: Consumer) {
        Task { @MainActor in
            let entry = self.consumers.first { $0.value.consumer.id == consumer.id }
            if let entry {
                self.consumers.removeValue(forKey: entry.key)
                self.videoFreezeStats.removeValue(forKey: entry.key)
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
        for output in audioSession.currentRoute.outputs {
            switch output.portType {
            case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE:
                devices.append(AudioDevice(id: output.uid, label: output.portName))
            case .headphones, .usbAudio, .carAudio:
                devices.append(AudioDevice(id: output.uid, label: output.portName))
            default:
                break
            }
        }
        return devices
    }

    func currentAudioInputId() -> String? {
        audioSession.preferredInput?.uid ?? audioSession.currentRoute.inputs.first?.uid
    }

    func currentAudioOutputId() -> String? {
        guard let output = audioSession.currentRoute.outputs.first else { return "receiver" }
        switch output.portType {
        case .builtInSpeaker: return "speaker"
        case .builtInReceiver: return "receiver"
        default: return output.uid
        }
    }

    func selectAudioInput(_ deviceId: String) {
        guard let input = (audioSession.availableInputs ?? []).first(where: { $0.uid == deviceId }) else { return }
        do {
            try audioSession.setPreferredInput(input)
        } catch {
            debugLog("[WebRTC] setPreferredInput failed: \(error)")
        }
    }

    func selectAudioOutput(_ deviceId: String) {
        do {
            switch deviceId {
            case "speaker":
                try audioSession.overrideOutputAudioPort(.speaker)
            case "receiver":
                try audioSession.overrideOutputAudioPort(.none)
            default:
                // Bluetooth / wired: clear any speaker override and prefer the
                // matching input so the route follows that accessory.
                try audioSession.overrideOutputAudioPort(.none)
                if let input = (audioSession.availableInputs ?? []).first(where: { $0.uid == deviceId }) {
                    try audioSession.setPreferredInput(input)
                }
            }
        } catch {
            debugLog("[WebRTC] selectAudioOutput failed: \(error)")
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
    
    private var screenVideoCapturer: RTCVideoCapturer? {
        get { objc_getAssociatedObject(self, &screenCapturerKey) as? RTCVideoCapturer }
        set { objc_setAssociatedObject(self, &screenCapturerKey, newValue, .OBJC_ASSOCIATION_RETAIN) }
    }
    
    func startScreenSharing() async throws {
        guard let sendTransport = sendTransport else {
            throw WebRTCError.noTransport
        }
        
        let screenSource = Self.factory.videoSource()
        self.screenVideoSource = screenSource
        self.screenVideoCapturer = RTCVideoCapturer(delegate: screenSource)
        
        let screenTrack = Self.factory.videoTrack(with: screenSource, trackId: "screen0")
        screenTrack.isEnabled = true
        self.rtcScreenTrack = screenTrack

        do {
            let appData = try encodeJSONString(ProducerAppData(type: ProducerType.screen.rawValue, paused: false))
            let producer = try sendTransport.createProducer(
                for: screenTrack,
                encodings: [
                    RTCRtpEncodingParameters()
                ],
                codecOptions: nil,
                codec: nil,
                appData: appData
            )
            producer.delegate = self
            producer.resume()

            screenProducer = producer

            debugLog("[WebRTC] Screen sharing producer created: \(producer.id)")
        } catch {
            screenTrack.isEnabled = false
            rtcScreenTrack = nil
            screenVideoSource = nil
            screenVideoCapturer = nil
            screenProducer = nil
            throw error
        }
    }
    
    func stopScreenSharing() async {
        screenProducer?.close()
        screenProducer = nil
        
        rtcScreenTrack?.isEnabled = false
        rtcScreenTrack = nil
        screenVideoSource = nil
        screenVideoCapturer = nil
        
        debugLog("[WebRTC] Screen sharing stopped")
    }
    
    /// Feed a video frame from screen capture to WebRTC
    func feedScreenFrame(_ frame: RTCVideoFrame) {
        guard let source = screenVideoSource,
              let capturer = screenVideoCapturer else { return }
        source.capturer(capturer, didCapture: frame)
    }
    
    private var screenVideoSource: RTCVideoSource? {
        get { objc_getAssociatedObject(self, &screenSourceKey) as? RTCVideoSource }
        set { objc_setAssociatedObject(self, &screenSourceKey, newValue, .OBJC_ASSOCIATION_RETAIN) }
    }
    
    private var rtcScreenTrack: RTCVideoTrack? {
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
