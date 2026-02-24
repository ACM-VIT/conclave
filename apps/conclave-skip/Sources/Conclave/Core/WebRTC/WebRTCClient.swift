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

    private(set) var localAudioEnabled: Bool = false {
        didSet { onLocalAudioEnabledChanged?(localAudioEnabled) }
    }
    private(set) var localVideoEnabled: Bool = false {
        didSet { onLocalVideoEnabledChanged?(localVideoEnabled) }
    }
    @Published private(set) var remoteVideoTracks: [String: VideoTrackWrapper] = [:]
    @Published private(set) var connectionState: RTCPeerConnectionState = .new

    // MARK: - Mediasoup Core

    var device: Device?
    var sendTransport: SendTransport?
    var receiveTransport: ReceiveTransport?
    var sendTransportId: String?
    var receiveTransportId: String?

    var audioProducer: Producer?
    var videoProducer: Producer?
    var screenProducer: Producer?

    struct ConsumerInfo {
        let consumer: Consumer
        let producerId: String
        let userId: String
        let kind: String
    }

    var consumers: [String: ConsumerInfo] = [:]

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

    func configure(socketManager: SocketIOManager, rtpCapabilities: RtpCapabilities) {
        self.socketManager = socketManager
        self.serverRtpCapabilities = rtpCapabilities

        let device = Device(pcFactory: Self.factory)
        do {
            let capabilities = try encodeJSONString(rtpCapabilities)
            try device.load(with: capabilities)
        } catch {
            debugLog("[WebRTC] Failed to load device capabilities: \(error)")
        }
        self.device = device
    }

    // MARK: - Transport Creation

    func createTransports() async throws {
        guard let socket = socketManager,
              let device = device else {
            throw WebRTCError.notConfigured
        }

        let iceServers = resolveIceServersJSON()

        let producerTransportParams = try await socket.createProducerTransport()
        let consumerTransportParams = try await socket.createConsumerTransport()

        sendTransportId = producerTransportParams.id
        receiveTransportId = consumerTransportParams.id

        let sendTransport = try device.createSendTransport(
            id: producerTransportParams.id,
            iceParameters: try encodeJSONString(producerTransportParams.iceParameters),
            iceCandidates: try encodeJSONString(producerTransportParams.iceCandidates),
            dtlsParameters: try encodeJSONString(producerTransportParams.dtlsParameters),
            sctpParameters: nil,
            iceServers: iceServers,
            appData: nil
        )
        sendTransport.delegate = self
        self.sendTransport = sendTransport

        let receiveTransport = try device.createReceiveTransport(
            id: consumerTransportParams.id,
            iceParameters: try encodeJSONString(consumerTransportParams.iceParameters),
            iceCandidates: try encodeJSONString(consumerTransportParams.iceCandidates),
            dtlsParameters: try encodeJSONString(consumerTransportParams.dtlsParameters),
            sctpParameters: nil,
            iceServers: iceServers,
            appData: nil
        )
        receiveTransport.delegate = self
        self.receiveTransport = receiveTransport

        debugLog("[WebRTC] Transports created: send=\(producerTransportParams.id), recv=\(consumerTransportParams.id)")
    }

    // MARK: - Produce Local Media

    func startProducingAudio() async throws {
        guard let sendTransport = sendTransport else {
            throw WebRTCError.noTransport
        }

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

        audioSource = Self.factory.audioSource(with: audioConstraints)
        rtcLocalAudioTrack = Self.factory.audioTrack(with: audioSource!, trackId: "audio0")
        rtcLocalAudioTrack?.isEnabled = true

        let appData = try encodeJSONString(ProducerAppData(type: ProducerType.webcam.rawValue, paused: false))
        let producer = try sendTransport.createProducer(
            for: rtcLocalAudioTrack!,
            encodings: nil,
            codecOptions: nil,
            codec: nil,
            appData: appData
        )
        producer.delegate = self
        producer.resume()

        audioProducer = producer
        localAudioEnabled = true

        debugLog("[WebRTC] Audio producer created: \(producer.id)")
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

        videoSource = Self.factory.videoSource()
        videoCapturer = RTCCameraVideoCapturer(delegate: videoSource!)
        try startCameraCapture()

        rtcLocalVideoTrack = Self.factory.videoTrack(with: videoSource!, trackId: "video0")
        rtcLocalVideoTrack?.isEnabled = true

        let appData = try encodeJSONString(ProducerAppData(type: ProducerType.webcam.rawValue, paused: false))
        let producer = try sendTransport.createProducer(
            for: rtcLocalVideoTrack!,
            encodings: nil,
            codecOptions: nil,
            codec: nil,
            appData: appData
        )
        producer.delegate = self
        producer.resume()

        videoProducer = producer
        localVideoEnabled = true

        let trackWrapper = VideoTrackWrapper(
            id: producer.id,
            userId: "local",
            isLocal: true,
            track: rtcLocalVideoTrack
        )
        localVideoTrack = trackWrapper

        debugLog("[WebRTC] Video producer created: \(producer.id)")
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

    func consumeProducer(producerId: String, producerUserId: String) async throws {
        guard let socket = socketManager,
              let rtpCaps = serverRtpCapabilities,
              let receiveTransport = receiveTransport else {
            throw WebRTCError.notConfigured
        }

        let response = try await socket.consume(producerId: producerId, rtpCapabilities: rtpCaps)

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

        consumers[response.id] = ConsumerInfo(
            consumer: consumer,
            producerId: response.producerId,
            userId: producerUserId,
            kind: response.kind
        )

        try await socket.resumeConsumer(consumerId: response.id)

        if response.kind == "video", let videoTrack = consumer.track as? RTCVideoTrack {
            let trackWrapper = VideoTrackWrapper(
                id: response.id,
                userId: producerUserId,
                isLocal: false,
                track: videoTrack
            )
            remoteVideoTracks[producerUserId] = trackWrapper
        }

        debugLog("[WebRTC] Consuming producer \(producerId) for user \(producerUserId)")
    }

    func closeConsumer(producerId: String, userId: String) {
        if producerId.isEmpty {
            let consumerIds = consumers.filter { $0.value.userId == userId }.map { $0.key }
            for id in consumerIds {
                consumers[id]?.consumer.close()
                consumers.removeValue(forKey: id)
            }
        } else if let entry = consumers.first(where: { $0.value.producerId == producerId }) {
            entry.value.consumer.close()
            consumers.removeValue(forKey: entry.key)
            if !entry.value.userId.isEmpty {
                remoteVideoTracks.removeValue(forKey: entry.value.userId)
            }
        }

        if !userId.isEmpty {
            remoteVideoTracks.removeValue(forKey: userId)
        }
    }

    // MARK: - Media Control

    func setAudioEnabled(_ enabled: Bool) async {
        guard let socket = socketManager,
              let producer = audioProducer else { return }

        do {
            if enabled {
                producer.resume()
            } else {
                producer.pause()
            }
            try await socket.toggleMute(producerId: producer.id, paused: !enabled)
            localAudioEnabled = enabled
        } catch {
            debugLog("[WebRTC] Failed to toggle audio: \(error)")
        }
    }

    func setVideoEnabled(_ enabled: Bool) async {
        guard let socket = socketManager,
              let producer = videoProducer else { return }

        do {
            if enabled {
                producer.resume()
            } else {
                producer.pause()
            }
            try await socket.toggleCamera(producerId: producer.id, paused: !enabled)
            rtcLocalVideoTrack?.isEnabled = enabled
            localVideoEnabled = enabled
            localVideoTrack?.isEnabled = enabled

            if enabled {
                try? startCameraCapture()
            } else {
                await videoCapturer?.stopCapture()
            }
        } catch {
            debugLog("[WebRTC] Failed to toggle video: \(error)")
        }
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

    // MARK: - Cleanup

    func cleanup() async {
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

        rtcLocalVideoTrack?.isEnabled = false
        rtcLocalAudioTrack?.isEnabled = false
        rtcLocalVideoTrack = nil
        rtcLocalAudioTrack = nil

        localVideoTrack = nil
        remoteVideoTracks.removeAll()

        sendTransport?.close()
        receiveTransport?.close()
        sendTransport = nil
        receiveTransport = nil
        device = nil

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
            switch connectionState {
            case .connected, .completed:
                self.connectionState = .connected
            case .failed:
                self.connectionState = .failed
            case .disconnected:
                self.connectionState = .disconnected
            case .closed:
                self.connectionState = .closed
            case .new, .checking:
                self.connectionState = .new
            @unknown default:
                self.connectionState = .failed
            }
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
                if entry.value.kind == "video" {
                    self.remoteVideoTracks.removeValue(forKey: entry.value.userId)
                }
            }
        }
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
        
        // Create screen video source and capturer
        let screenSource = Self.factory.videoSource()
        self.screenVideoSource = screenSource
        self.screenVideoCapturer = RTCVideoCapturer(delegate: screenSource)
        
        // Create video track from source
        let screenTrack = Self.factory.videoTrack(with: screenSource, trackId: "screen0")
        screenTrack.isEnabled = true
        self.rtcScreenTrack = screenTrack
        
        // Create producer for screen
        let appData = try encodeJSONString(ProducerAppData(type: ProducerType.screen.rawValue, paused: false))
        let producer = try sendTransport.createProducer(
            for: screenTrack,
            encodings: [
                RTCRtpEncodingParameters() // HD quality for screen
            ],
            codecOptions: nil,
            codec: nil,
            appData: appData
        )
        producer.delegate = self
        producer.resume()
        
        screenProducer = producer
        
        debugLog("[WebRTC] Screen sharing producer created: \(producer.id)")
    }
    
    func stopScreenSharing() async {
        guard let producer = screenProducer else { return }
        
        producer.close()
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

enum WebRTCError: Error {
    case notConfigured
    case noTransport
    case permissionDenied
    case noCameraAvailable
    case connectionFailed(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "WebRTC client not configured"
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
