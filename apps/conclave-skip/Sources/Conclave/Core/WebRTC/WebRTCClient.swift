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

enum WebcamVideoCodecPolicy {
    static func googleStartBitrateKbps(
        quality: VideoQuality,
        connectionQuality: ConnectionQuality
    ) -> Int {
        switch connectionQuality {
        case .emergency:
            return 65
        case .poor:
            return 90
        case .fair:
            return 350
        case .good, .unknown:
            return quality == .standard ? 1_800 : 300
        }
    }
}

/// VP8 camera publishing intentionally uses spatial-only adaptation. A single
/// temporal layer avoids the extra encoder/pacer dependencies that can inflate
/// receive jitter after mediasoup switches between simulcast spatial layers.
enum WebcamTemporalLayerPolicy {
    static let temporalLayerCount = 1
    static let receiveTemporalLayer = 0
}

#if !SKIP
struct ConsumerGenerationIdentity: Hashable, Sendable {
    let consumerId: String
    let generation: Int
}

/// Removal must prove ownership of both the consumer map slot and the rendered
/// track slot. During an overlapping handoff, predecessor and successor share
/// a producer/participant track key, so key-only cleanup can erase the live
/// successor when the predecessor's asynchronous close callback arrives.
enum ConsumerGenerationRemovalPolicy {
    static func ownsConsumerSlot(
        expected: ConsumerGenerationIdentity,
        current: ConsumerGenerationIdentity?
    ) -> Bool {
        current == expected
    }

    static func ownsTrackSlot(
        expected: ConsumerGenerationIdentity,
        current: ConsumerGenerationIdentity?
    ) -> Bool {
        current == expected
    }
}

enum ConsumerGenerationLifecycleRole: String, Sendable {
    case current
    case staged
    case displaced

    var acceptsPeriodicControls: Bool { self == .current }
}

enum PlannedConsumerResetCoordinatorOwnershipPolicy {
    static func ownsCompletion(
        ownerToken: Int,
        activeOwnerToken: Int?
    ) -> Bool {
        activeOwnerToken == ownerToken
    }

    static func shouldWake(
        candidateRemoved: Bool,
        activeCandidateMatches: Bool
    ) -> Bool {
        candidateRemoved || activeCandidateMatches
    }
}

enum PlannedWebcamConsumerResetOutcome: String, Sendable {
    case promoted
    case promotedPredecessorCloseUnconfirmed = "promoted_predecessor_close_unconfirmed"
    case rolledBack = "rolled_back"
    case rollbackUnconfirmed = "rollback_unconfirmed"
    case startupDeadlineExpired = "startup_deadline_expired"
    case contextChanged = "context_changed"
    case ineligibleSuccessor = "ineligible_successor"
    case attemptsExhausted = "attempts_exhausted"
}

/// Pure policy for the native planned receive-generation reset. Runtime code
/// deliberately feeds it only consume-response/RTP facts, never publisher
/// declarations or UI assumptions.
enum PlannedWebcamConsumerResetPolicy {
    static let topLayerSustainMilliseconds: Int64 = 1_250
    static let startupDeadlineMilliseconds: Int64 = 15_000
    static let minimumAttemptBudgetMilliseconds: Int64 = 5_200
    static let perAttemptDeadlineMilliseconds: Int64 = 6_500
    static let signalingAcknowledgementTimeoutMilliseconds = 900
    static let firstFrameTimeoutMilliseconds = 3_200
    static let closeAcknowledgementTimeoutMilliseconds = 1_000
    static let retryDelayMilliseconds: Int64 = 200
    static let candidateStaggerMilliseconds: Int64 = 350
    static let maxAttempts = 2

    static func normalizedRoomId(_ roomId: String?) -> String? {
        let normalized = roomId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return normalized.isEmpty ? nil : normalized
    }

    static func actualVideoCodecMimeType(_ rtpParameters: RtpParameters) -> String? {
        rtpParameters.codecs.first { codec in
            let mimeType = codec.mimeType.lowercased()
            return mimeType.hasPrefix("video/") &&
                mimeType != "video/rtx" &&
                mimeType != "video/red" &&
                mimeType != "video/ulpfec" &&
                mimeType != "video/flexfec-03"
        }?.mimeType
    }

    static func derivedMaxSpatialLayer(
        explicit: Int?,
        encodings: [RtpEncodingParameters]?
    ) -> Int? {
        if let explicit, explicit >= 0 {
            return explicit
        }
        guard let encodings, !encodings.isEmpty else { return nil }
        var maximum = encodings.count > 1 ? encodings.count - 1 : nil
        for mode in encodings.compactMap(\.scalabilityMode) {
            let upper = mode.uppercased()
            guard upper.first == "L" || upper.first == "S",
                  let temporalIndex = upper.firstIndex(of: "T"),
                  temporalIndex > upper.startIndex else { continue }
            let countStart = upper.index(after: upper.startIndex)
            guard let layerCount = Int(upper[countStart..<temporalIndex]), layerCount > 0 else { continue }
            maximum = max(maximum ?? 0, layerCount - 1)
        }
        return maximum
    }

    static func isEligible(
        kind: String,
        producerType: String,
        consumerType: String?,
        actualVideoCodecMimeType: String?,
        maxSpatialLayer: Int?
    ) -> Bool {
        kind.lowercased() == "video" &&
            producerType.lowercased() == ProducerType.webcam.rawValue &&
            consumerType?.lowercased() == "simulcast" &&
            actualVideoCodecMimeType?.lowercased() == "video/vp8" &&
            (maxSpatialLayer ?? 0) > 0
    }

    static func isAtTopLayer(currentSpatialLayer: Int?, maxSpatialLayer: Int?) -> Bool {
        guard let currentSpatialLayer, let maxSpatialLayer, maxSpatialLayer > 0 else { return false }
        return currentSpatialLayer >= maxSpatialLayer
    }

    static func hasSustainedTopLayer(
        firstObservedAtMs: Int64,
        nowMs: Int64
    ) -> Bool {
        nowMs >= firstObservedAtMs &&
            nowMs - firstObservedAtMs >= topLayerSustainMilliseconds
    }

    static func canStartAttempt(nowMs: Int64, startupDeadlineMs: Int64) -> Bool {
        startupDeadlineMs >= nowMs &&
            startupDeadlineMs - nowMs >= minimumAttemptBudgetMilliseconds
    }

    static func contextsMatch(
        expectedRoomId: String,
        actualRoomId: String?,
        expectedLifecycleGeneration: Int,
        actualLifecycleGeneration: Int,
        expectedConfigurationGeneration: Int,
        actualConfigurationGeneration: Int,
        expectedProducerClosureGeneration: Int,
        actualProducerClosureGeneration: Int,
        expectedAdaptivePolicyRevision: Int,
        actualAdaptivePolicyRevision: Int
    ) -> Bool {
        normalizedRoomId(expectedRoomId) == normalizedRoomId(actualRoomId) &&
            expectedLifecycleGeneration == actualLifecycleGeneration &&
            expectedConfigurationGeneration == actualConfigurationGeneration &&
            expectedProducerClosureGeneration == actualProducerClosureGeneration &&
            expectedAdaptivePolicyRevision == actualAdaptivePolicyRevision
    }
}
#endif

#if !SKIP
enum NativeReceiveCapabilitiesPolicy {
    static func decodeLoadedDeviceCapabilities(_ json: String) throws -> RtpCapabilities {
        try JSONDecoder().decode(RtpCapabilities.self, from: Data(json.utf8))
    }
}
#endif

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
    let consumerGeneration: Int

    @Published var rtcVideoTrack: RTCVideoTrack?

    @Published var isEnabled: Bool = true

    init(
        id: String,
        userId: String,
        isLocal: Bool,
        track: RTCVideoTrack? = nil,
        consumerGeneration: Int = 0
    ) {
        self.id = id
        self.userId = userId
        self.isLocal = isLocal
        self.rtcVideoTrack = track
        self.consumerGeneration = consumerGeneration
    }

    func setTrack(_ track: RTCVideoTrack?) {
        self.rtcVideoTrack = track
        self.isEnabled = track?.isEnabled ?? false
    }
}

private actor FirstDecodedVideoFrameSignal {
    private var didDecode = false
    private var isCancelled = false
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]

    func wait() async throws {
        if didDecode {
            return
        }
        if isCancelled {
            throw CancellationError()
        }

        let waiterId = UUID()
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { continuation in
                if didDecode {
                    continuation.resume()
                } else if isCancelled || Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    waiters[waiterId] = continuation
                }
            }
        } onCancel: {
            Task {
                await self.cancelWaiter(waiterId)
            }
        }
    }

    func markDecoded() {
        guard !didDecode, !isCancelled else { return }
        didDecode = true
        let pending = waiters.values
        waiters.removeAll()
        for continuation in pending {
            continuation.resume()
        }
    }

    func cancel() {
        guard !isCancelled else { return }
        isCancelled = true
        let pending = waiters.values
        waiters.removeAll()
        for continuation in pending {
            continuation.resume(throwing: CancellationError())
        }
    }

    private func cancelWaiter(_ waiterId: UUID) {
        waiters.removeValue(forKey: waiterId)?.resume(throwing: CancellationError())
    }
}

/// A sink on the decoded `RTCVideoTrack`, not on the UI renderer. It latches
/// exactly one decoded frame even when the tile is off-screen, then detaches so
/// steady-state rendering and bandwidth behavior are unchanged.
private final class FirstDecodedVideoFrameRenderer: NSObject, RTCVideoRenderer {
    private let lock = NSLock()
    private weak var track: RTCVideoTrack?
    private let signal: FirstDecodedVideoFrameSignal
    private var isFinished = false

    init(track: RTCVideoTrack, signal: FirstDecodedVideoFrameSignal) {
        self.track = track
        self.signal = signal
        super.init()
    }

    func setSize(_ size: CGSize) { }

    func renderFrame(_ frame: RTCVideoFrame?) {
        guard frame != nil else { return }
        let trackToDetach: RTCVideoTrack?
        lock.lock()
        if isFinished {
            trackToDetach = nil
        } else {
            isFinished = true
            trackToDetach = track
            track = nil
        }
        lock.unlock()

        guard let trackToDetach else { return }
        trackToDetach.remove(self)
        Task {
            await signal.markDecoded()
        }
    }

    func cancel() {
        let trackToDetach: RTCVideoTrack?
        lock.lock()
        if isFinished {
            trackToDetach = nil
        } else {
            isFinished = true
            trackToDetach = track
            track = nil
        }
        lock.unlock()

        trackToDetach?.remove(self)
        Task {
            await signal.cancel()
        }
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
    var onPlannedConsumerResetOutcome: ((String) -> Void)?

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
        let generation: Int
        let roomId: String
        let meetingLifecycleGeneration: Int
        let createdAtMonotonicMs: Int64
        let consumerType: String?
        let actualVideoCodecMimeType: String?
        let maxSpatialLayer: Int?
        var isConsumerPaused: Bool
        var isProducerPaused: Bool
        var isAdaptivelyPaused: Bool
        var lifecycleRole: ConsumerGenerationLifecycleRole
        var plannedResetCompleted: Bool
        // Key under which the video track is stored in remoteVideoTracks:
        // "{userId}" for webcam, "{userId}-screen" for a screen-share - so a
        // user's webcam and screen tracks coexist instead of overwriting.
        var trackKey: String = ""
    }

    var consumers: [String: ConsumerInfo] = [:]
    private var nextConsumerGeneration = 0
    private var firstDecodedVideoFrameSignals: [ConsumerGenerationIdentity: FirstDecodedVideoFrameSignal] = [:]
    private var firstDecodedVideoFrameRenderers: [ConsumerGenerationIdentity: FirstDecodedVideoFrameRenderer] = [:]
    private var remoteProducerClosureGenerations: [String: Int] = [:]
    private var remoteConsumerPreferenceSignatures: [String: String] = [:]
    private var remoteConsumerLayerPreferenceUnsupportedIds: Set<String> = []
    private var remoteConsumerPreferenceInFlightIds: Set<String> = []
    private var remoteConsumerPreferenceRetryTask: Task<Void, Never>?
    private var remoteConsumerPreferencePolicyRevision = 0
    private var remoteVideoReceiveEnabled = true
    private struct PlannedConsumerResetCandidate {
        let predecessor: ConsumerGenerationIdentity
        let producerId: String
        let userId: String
        let roomId: String
        let meetingLifecycleGeneration: Int
        let configurationGeneration: Int
        let producerClosureGeneration: Int
        let adaptivePolicyRevision: Int
        let firstTopLayerAtMs: Int64
        let readyAtMs: Int64
        let startupDeadlineMs: Int64
        let sequence: Int
    }
    private var plannedConsumerResetCandidates: [String: PlannedConsumerResetCandidate] = [:]
    private var plannedConsumerResetCoordinatorTask: Task<Void, Never>?
    private var plannedConsumerResetCoordinatorOwnerToken: Int?
    private var nextPlannedConsumerResetCoordinatorOwnerToken = 0
    private var plannedConsumerResetActivePredecessorId: String?
    private var plannedConsumerResetActiveOwnerToken: Int?
    private var plannedConsumerResetSequence = 0
    private var activeConsumerResetRoomId: String?
    private var activeConsumerResetLifecycleGeneration: Int?
    private static let maxRemoteConsumerPreferenceUpdatesPerCycle = 8
    private static let remoteConsumerPreferenceEmitSpacingNanoseconds: UInt64 = 75_000_000
    private static let remoteConsumerPreferenceRetryDelayNanoseconds: UInt64 = 1_000_000_000

    /// The consumer id we hold for a remote producer (the consumers map is keyed
    /// by consumer id, not producer id). Used by the producer-sync safety net to
    /// re-assert resume on a consumer that may have been left server-paused.
    func consumerId(forProducer producerId: String) -> String? {
        consumers
            .filter {
                $0.value.producerId == producerId &&
                    $0.value.lifecycleRole.acceptsPeriodicControls
            }
            .max { $0.value.generation < $1.value.generation }?
            .key
    }

    /// Presence check for producer-sync de-duplication. Unlike
    /// consumerId(forProducer:), this intentionally counts staged/displaced
    /// overlap generations without exposing either to periodic controls.
    func hasConsumerGeneration(forProducer producerId: String) -> Bool {
        consumers.values.contains { $0.producerId == producerId }
    }

    /// Await a decoded frame from the exact currently registered consumer.
    /// A timeout returns `false`; task cancellation and consumer removal throw
    /// `CancellationError`. The one-frame renderer is installed before resume,
    /// so a fast decoder cannot beat observation registration.
    func waitForFirstDecodedVideoFrame(
        consumerId: String,
        timeoutMilliseconds: Int
    ) async throws -> Bool {
        guard let info = consumers[consumerId], info.kind == "video" else {
            throw WebRTCError.notConfigured
        }
        let identity = ConsumerGenerationIdentity(
            consumerId: consumerId,
            generation: info.generation
        )
        guard let signal = firstDecodedVideoFrameSignals[identity] else {
            throw WebRTCError.notConfigured
        }
        guard timeoutMilliseconds > 0 else { return false }

        let didDecode = try await withThrowingTaskGroup(of: Bool.self) { group in
            group.addTask {
                try await signal.wait()
                return true
            }
            group.addTask {
                try await Task.sleep(
                    nanoseconds: UInt64(timeoutMilliseconds) * 1_000_000
                )
                return false
            }
            defer { group.cancelAll() }
            return try await group.next() ?? false
        }
        guard didDecode else { return false }
        try Task.checkCancellation()
        let currentIdentity = consumers[consumerId].map {
            ConsumerGenerationIdentity(
                consumerId: consumerId,
                generation: $0.generation
            )
        }
        guard ConsumerGenerationRemovalPolicy.ownsConsumerSlot(
            expected: identity,
            current: currentIdentity
        ) else {
            throw CancellationError()
        }
        return true
    }

    func cancelFirstDecodedVideoFrameObservation(consumerId: String) {
        guard let info = consumers[consumerId] else { return }
        cancelFirstDecodedVideoFrameObservation(
            identity: ConsumerGenerationIdentity(
                consumerId: consumerId,
                generation: info.generation
            )
        )
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
        guard var info = consumers[notification.consumerId],
              info.producerId == notification.producerId else { return }
        if !info.roomId.isEmpty,
           PlannedWebcamConsumerResetPolicy.normalizedRoomId(notification.roomId) != info.roomId {
            return
        }

        if notification.event == "closed" {
            removeConsumer(
                consumerId: notification.consumerId,
                info: info,
                closeConsumer: true,
                notifyServer: false
            )
            return
        }

        info.isConsumerPaused = notification.paused
        info.isProducerPaused = notification.producerPaused
        consumers[notification.consumerId] = info

        if info.lifecycleRole.acceptsPeriodicControls {
            remoteConsumerPreferenceSignatures[notification.consumerId] = RemoteConsumerPreference(
                spatialLayer: notification.preferredLayers?.spatialLayer,
                temporalLayer: notification.preferredLayers?.temporalLayer,
                priority: notification.priority,
                paused: notification.paused
            ).signature
        }

        if notification.paused || notification.producerPaused {
            videoFreezeStats.removeValue(forKey: notification.consumerId)
            invalidatePlannedConsumerResetCandidate(
                consumerId: notification.consumerId
            )
        } else {
            observePlannedConsumerResetLayer(
                consumerId: notification.consumerId,
                roomId: notification.roomId ?? "",
                currentSpatialLayer: notification.currentLayers?.spatialLayer
            )
        }
    }

    private static func monotonicMilliseconds() -> Int64 {
        Int64(ProcessInfo.processInfo.systemUptime * 1_000)
    }

    /// Cancel the current wait/attempt without clearing its owner slot. The
    /// owner's completion path always reschedules queued work, including after
    /// cancellation; its token prevents an older completion from clearing a
    /// newer coordinator installed during teardown/reconfiguration.
    private func wakePlannedConsumerResetCoordinator() {
        if let plannedConsumerResetCoordinatorTask {
            plannedConsumerResetCoordinatorTask.cancel()
        } else {
            schedulePlannedConsumerResetCoordinator()
        }
    }

    private func invalidatePlannedConsumerResetCandidate(
        consumerId: String
    ) {
        let removed = plannedConsumerResetCandidates.removeValue(
            forKey: consumerId
        ) != nil
        let active = plannedConsumerResetActivePredecessorId == consumerId
        if PlannedConsumerResetCoordinatorOwnershipPolicy.shouldWake(
            candidateRemoved: removed,
            activeCandidateMatches: active
        ) {
            wakePlannedConsumerResetCoordinator()
        }
    }

    private func invalidatePlannedConsumerResets(
        producerId: String
    ) {
        var removed = false
        for (consumerId, candidate) in Array(plannedConsumerResetCandidates)
            where candidate.producerId == producerId {
            plannedConsumerResetCandidates.removeValue(forKey: consumerId)
            removed = true
        }
        let active = plannedConsumerResetActivePredecessorId.flatMap {
            consumers[$0]?.producerId
        } == producerId
        if PlannedConsumerResetCoordinatorOwnershipPolicy.shouldWake(
            candidateRemoved: removed,
            activeCandidateMatches: active
        ) {
            wakePlannedConsumerResetCoordinator()
        }
    }

    private func updatePlannedConsumerResetContext(
        roomId: String,
        meetingLifecycleGeneration: Int
    ) {
        guard !roomId.isEmpty else { return }
        if let activeRoomId = activeConsumerResetRoomId,
           activeRoomId != roomId ||
            activeConsumerResetLifecycleGeneration != meetingLifecycleGeneration {
            plannedConsumerResetCoordinatorTask?.cancel()
            plannedConsumerResetCandidates.removeAll()
        }
        activeConsumerResetRoomId = roomId
        activeConsumerResetLifecycleGeneration = meetingLifecycleGeneration
    }

    private func observePlannedConsumerResetLayer(
        consumerId: String,
        roomId: String,
        currentSpatialLayer: Int?
    ) {
        guard var info = consumers[consumerId],
              info.lifecycleRole == .current,
              !info.plannedResetCompleted,
              !info.isConsumerPaused,
              !info.isProducerPaused,
              !info.isAdaptivelyPaused,
              remoteVideoReceiveEnabled,
              !info.roomId.isEmpty,
              info.roomId == PlannedWebcamConsumerResetPolicy.normalizedRoomId(roomId),
              PlannedWebcamConsumerResetPolicy.isEligible(
                kind: info.kind,
                producerType: info.type,
                consumerType: info.consumerType,
                actualVideoCodecMimeType: info.actualVideoCodecMimeType,
                maxSpatialLayer: info.maxSpatialLayer
              ) else {
            invalidatePlannedConsumerResetCandidate(consumerId: consumerId)
            return
        }

        guard PlannedWebcamConsumerResetPolicy.isAtTopLayer(
            currentSpatialLayer: currentSpatialLayer,
            maxSpatialLayer: info.maxSpatialLayer
        ) else {
            if currentSpatialLayer != nil {
                invalidatePlannedConsumerResetCandidate(consumerId: consumerId)
            }
            return
        }
        guard plannedConsumerResetCandidates[consumerId] == nil else { return }

        let now = Self.monotonicMilliseconds()
        let startupDeadline = info.createdAtMonotonicMs +
            PlannedWebcamConsumerResetPolicy.startupDeadlineMilliseconds
        guard now < startupDeadline else {
            info.plannedResetCompleted = true
            consumers[consumerId] = info
            emitPlannedConsumerResetOutcome(
                .startupDeadlineExpired,
                producerId: info.producerId,
                predecessorId: consumerId,
                successorId: nil,
                attempt: 0,
                startedAtMs: now
            )
            return
        }

        plannedConsumerResetSequence += 1
        let candidate = PlannedConsumerResetCandidate(
            predecessor: ConsumerGenerationIdentity(
                consumerId: consumerId,
                generation: info.generation
            ),
            producerId: info.producerId,
            userId: info.userId,
            roomId: info.roomId,
            meetingLifecycleGeneration: info.meetingLifecycleGeneration,
            configurationGeneration: configurationGeneration,
            producerClosureGeneration: remoteProducerClosureGenerations[info.producerId, default: 0],
            adaptivePolicyRevision: remoteConsumerPreferencePolicyRevision,
            firstTopLayerAtMs: now,
            readyAtMs: now + PlannedWebcamConsumerResetPolicy.topLayerSustainMilliseconds,
            startupDeadlineMs: startupDeadline,
            sequence: plannedConsumerResetSequence
        )
        plannedConsumerResetCandidates[consumerId] = candidate
        schedulePlannedConsumerResetCoordinator()
    }

    private func schedulePlannedConsumerResetCoordinator() {
        guard plannedConsumerResetCoordinatorTask == nil,
              !plannedConsumerResetCandidates.isEmpty else { return }
        nextPlannedConsumerResetCoordinatorOwnerToken += 1
        let ownerToken = nextPlannedConsumerResetCoordinatorOwnerToken
        plannedConsumerResetCoordinatorOwnerToken = ownerToken
        plannedConsumerResetCoordinatorTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.runPlannedConsumerResetCoordinator(
                ownerToken: ownerToken
            )
        }
    }

    private func runPlannedConsumerResetCoordinator(
        ownerToken: Int
    ) async {
        defer {
            if PlannedConsumerResetCoordinatorOwnershipPolicy.ownsCompletion(
                ownerToken: ownerToken,
                activeOwnerToken: plannedConsumerResetCoordinatorOwnerToken
            ) {
                if PlannedConsumerResetCoordinatorOwnershipPolicy.ownsCompletion(
                    ownerToken: ownerToken,
                    activeOwnerToken: plannedConsumerResetActiveOwnerToken
                ) {
                    plannedConsumerResetActiveOwnerToken = nil
                    plannedConsumerResetActivePredecessorId = nil
                }
                plannedConsumerResetCoordinatorTask = nil
                plannedConsumerResetCoordinatorOwnerToken = nil
                if !plannedConsumerResetCandidates.isEmpty {
                    schedulePlannedConsumerResetCoordinator()
                }
            }
        }

        while !Task.isCancelled {
            pruneInvalidPlannedConsumerResetCandidates()
            guard let candidate = plannedConsumerResetCandidates.values.min(by: {
                if $0.readyAtMs != $1.readyAtMs { return $0.readyAtMs < $1.readyAtMs }
                return $0.sequence < $1.sequence
            }) else { return }

            let now = Self.monotonicMilliseconds()
            if now < candidate.readyAtMs {
                do {
                    try await Task.sleep(
                        nanoseconds: UInt64(candidate.readyAtMs - now) * 1_000_000
                    )
                } catch {
                    return
                }
                continue
            }
            guard PlannedWebcamConsumerResetPolicy.hasSustainedTopLayer(
                firstObservedAtMs: candidate.firstTopLayerAtMs,
                nowMs: now
            ) else { continue }

            plannedConsumerResetCandidates.removeValue(
                forKey: candidate.predecessor.consumerId
            )
            plannedConsumerResetActiveOwnerToken = ownerToken
            plannedConsumerResetActivePredecessorId =
                candidate.predecessor.consumerId
            await performPlannedConsumerReset(candidate)
            if PlannedConsumerResetCoordinatorOwnershipPolicy.ownsCompletion(
                ownerToken: ownerToken,
                activeOwnerToken: plannedConsumerResetActiveOwnerToken
            ) {
                plannedConsumerResetActiveOwnerToken = nil
                plannedConsumerResetActivePredecessorId = nil
            }
            if Task.isCancelled { return }
            if !plannedConsumerResetCandidates.isEmpty {
                try? await Task.sleep(
                    nanoseconds: UInt64(
                        PlannedWebcamConsumerResetPolicy.candidateStaggerMilliseconds
                    ) * 1_000_000
                )
            }
        }
    }

    private func pruneInvalidPlannedConsumerResetCandidates() {
        let now = Self.monotonicMilliseconds()
        for (consumerId, candidate) in Array(plannedConsumerResetCandidates) {
            guard isPlannedConsumerResetCandidateCurrent(candidate) else {
                plannedConsumerResetCandidates.removeValue(forKey: consumerId)
                continue
            }
            if !PlannedWebcamConsumerResetPolicy.canStartAttempt(
                nowMs: now,
                startupDeadlineMs: candidate.startupDeadlineMs
            ) {
                plannedConsumerResetCandidates.removeValue(forKey: consumerId)
                markPlannedConsumerResetCompleted(candidate.predecessor)
                emitPlannedConsumerResetOutcome(
                    .startupDeadlineExpired,
                    producerId: candidate.producerId,
                    predecessorId: consumerId,
                    successorId: nil,
                    attempt: 0,
                    startedAtMs: candidate.firstTopLayerAtMs
                )
            }
        }
    }

    private func isPlannedConsumerResetCandidateCurrent(
        _ candidate: PlannedConsumerResetCandidate,
        requiredRole: ConsumerGenerationLifecycleRole = .current
    ) -> Bool {
        guard let info = consumers[candidate.predecessor.consumerId],
              info.generation == candidate.predecessor.generation,
              info.producerId == candidate.producerId,
              info.lifecycleRole == requiredRole,
              !info.isConsumerPaused,
              !info.isProducerPaused,
              !info.isAdaptivelyPaused,
              remoteVideoReceiveEnabled,
              !info.plannedResetCompleted else { return false }
        return PlannedWebcamConsumerResetPolicy.contextsMatch(
            expectedRoomId: candidate.roomId,
            actualRoomId: activeConsumerResetRoomId,
            expectedLifecycleGeneration: candidate.meetingLifecycleGeneration,
            actualLifecycleGeneration: activeConsumerResetLifecycleGeneration ?? -1,
            expectedConfigurationGeneration: candidate.configurationGeneration,
            actualConfigurationGeneration: configurationGeneration,
            expectedProducerClosureGeneration: candidate.producerClosureGeneration,
            actualProducerClosureGeneration: remoteProducerClosureGenerations[candidate.producerId, default: 0],
            expectedAdaptivePolicyRevision: candidate.adaptivePolicyRevision,
            actualAdaptivePolicyRevision: remoteConsumerPreferencePolicyRevision
        )
    }

    private func performPlannedConsumerReset(
        _ candidate: PlannedConsumerResetCandidate
    ) async {
        var attempt = 0
        while attempt < PlannedWebcamConsumerResetPolicy.maxAttempts {
            attempt += 1
            let attemptStartedAt = Self.monotonicMilliseconds()
            guard PlannedWebcamConsumerResetPolicy.canStartAttempt(
                nowMs: attemptStartedAt,
                startupDeadlineMs: candidate.startupDeadlineMs
            ) else {
                markPlannedConsumerResetCompleted(candidate.predecessor)
                emitPlannedConsumerResetOutcome(
                    .startupDeadlineExpired,
                    producerId: candidate.producerId,
                    predecessorId: candidate.predecessor.consumerId,
                    successorId: nil,
                    attempt: attempt,
                    startedAtMs: candidate.firstTopLayerAtMs
                )
                return
            }
            guard isPlannedConsumerResetCandidateCurrent(candidate),
                  var predecessorInfo = consumers[candidate.predecessor.consumerId] else {
                emitPlannedConsumerResetOutcome(
                    .contextChanged,
                    producerId: candidate.producerId,
                    predecessorId: candidate.predecessor.consumerId,
                    successorId: nil,
                    attempt: attempt,
                    startedAtMs: attemptStartedAt
                )
                return
            }

            predecessorInfo.lifecycleRole = .displaced
            consumers[candidate.predecessor.consumerId] = predecessorInfo
            let attemptDeadline = min(
                candidate.startupDeadlineMs,
                attemptStartedAt + PlannedWebcamConsumerResetPolicy.perAttemptDeadlineMilliseconds
            )
            var successorIdentity: ConsumerGenerationIdentity?
            let handoffRequestId = UUID().uuidString.lowercased()
            var rollbackWasAlreadyAcknowledged = true
            var failureWasIneligibleSuccessor = false
            var failureWasContextChange = false

            do {
                try Task.checkCancellation()
                let registeredSuccessor = try await registerConsumerGeneration(
                    producerId: candidate.producerId,
                    producerUserId: predecessorInfo.userId,
                    producerKind: predecessorInfo.kind,
                    producerType: predecessorInfo.type,
                    preferHighWebcamLayer: true,
                    initialReceiveConnectionQuality: .good,
                    roomId: candidate.roomId,
                    meetingLifecycleGeneration: candidate.meetingLifecycleGeneration,
                    visibility: .staged,
                    plannedResetCompleted: true,
                    plannedHandoffRequestId: handoffRequestId,
                    plannedHandoffPredecessorConsumerId:
                        candidate.predecessor.consumerId,
                    signalingTimeoutMilliseconds:
                        PlannedWebcamConsumerResetPolicy.signalingAcknowledgementTimeoutMilliseconds
                )
                successorIdentity = registeredSuccessor
                guard isPlannedConsumerResetCandidateCurrent(
                    candidate,
                    requiredRole: .displaced
                ) else {
                    throw PlannedConsumerResetFailure.contextChanged
                }
                guard let successorInfo = consumers[registeredSuccessor.consumerId],
                      successorInfo.generation == registeredSuccessor.generation,
                      !successorInfo.isConsumerPaused,
                      !successorInfo.isProducerPaused,
                      PlannedWebcamConsumerResetPolicy.isEligible(
                        kind: successorInfo.kind,
                        producerType: successorInfo.type,
                        consumerType: successorInfo.consumerType,
                        actualVideoCodecMimeType: successorInfo.actualVideoCodecMimeType,
                        maxSpatialLayer: successorInfo.maxSpatialLayer
                      ) else {
                    throw PlannedConsumerResetFailure.ineligibleSuccessor
                }

                let remainingForFrame = attemptDeadline - Self.monotonicMilliseconds() -
                    Int64(PlannedWebcamConsumerResetPolicy.closeAcknowledgementTimeoutMilliseconds) - 100
                guard remainingForFrame > 0 else {
                    throw PlannedConsumerResetFailure.firstFrameTimeout
                }
                let frameTimeout = min(
                    PlannedWebcamConsumerResetPolicy.firstFrameTimeoutMilliseconds,
                    Int(remainingForFrame)
                )
                let decoded = try await waitForFirstDecodedVideoFrame(
                    consumerId: registeredSuccessor.consumerId,
                    timeoutMilliseconds: frameTimeout
                )
                guard decoded else {
                    throw PlannedConsumerResetFailure.firstFrameTimeout
                }
                try Task.checkCancellation()
                guard Self.monotonicMilliseconds() <= attemptDeadline,
                      isPlannedConsumerResetCandidateCurrent(
                        candidate,
                        requiredRole: .displaced
                      ),
                      promoteStagedConsumer(
                        successor: registeredSuccessor,
                        predecessor: candidate.predecessor
                      ) else {
                    throw PlannedConsumerResetFailure.contextChanged
                }

                cancelFirstDecodedVideoFrameObservation(
                    identity: registeredSuccessor
                )
                let predecessorCloseConfirmed = await retirePromotedPredecessor(
                    candidate.predecessor
                )
                emitPlannedConsumerResetOutcome(
                    predecessorCloseConfirmed
                        ? .promoted
                        : .promotedPredecessorCloseUnconfirmed,
                    producerId: candidate.producerId,
                    predecessorId: candidate.predecessor.consumerId,
                    successorId: registeredSuccessor.consumerId,
                    attempt: attempt,
                    startedAtMs: attemptStartedAt
                )
                return
            } catch {
                if let plannedFailure = error as? PlannedConsumerResetFailure {
                    switch plannedFailure {
                    case .ineligibleSuccessor:
                        failureWasIneligibleSuccessor = true
                    case .contextChanged:
                        failureWasContextChange = true
                    case .firstFrameTimeout:
                        break
                    }
                }
                if let registrationError = error as? ConsumerGenerationRegistrationError {
                    rollbackWasAlreadyAcknowledged = registrationError.rollbackAcknowledged
                } else if error.localizedDescription.lowercased().contains("timed out") ||
                            error.localizedDescription.lowercased().contains("timeout") {
                    // A consume ACK timeout can hide a server-created generation
                    // whose id never reached us. Retrying would be unsafe.
                    rollbackWasAlreadyAcknowledged = false
                }
            }

            var rollbackConfirmed = rollbackWasAlreadyAcknowledged
            if let successorIdentity {
                rollbackConfirmed = await rollbackStagedConsumer(
                    successorIdentity,
                    predecessor: candidate.predecessor,
                    producerId: candidate.producerId,
                    handoffRequestId: handoffRequestId
                )
            } else {
                restoreDisplacedPredecessor(candidate.predecessor)
            }

            let contextChanged = Task.isCancelled ||
                !isPlannedConsumerResetCandidateCurrent(candidate) || {
                    failureWasContextChange
                }()

            if contextChanged {
                emitPlannedConsumerResetOutcome(
                    .contextChanged,
                    producerId: candidate.producerId,
                    predecessorId: candidate.predecessor.consumerId,
                    successorId: successorIdentity?.consumerId,
                    attempt: attempt,
                    startedAtMs: attemptStartedAt
                )
                return
            }
            if failureWasIneligibleSuccessor {
                markPlannedConsumerResetCompleted(candidate.predecessor)
                emitPlannedConsumerResetOutcome(
                    .ineligibleSuccessor,
                    producerId: candidate.producerId,
                    predecessorId: candidate.predecessor.consumerId,
                    successorId: successorIdentity?.consumerId,
                    attempt: attempt,
                    startedAtMs: attemptStartedAt
                )
                return
            }
            if !PlannedConsumerHandoffAbortRetryPolicy.permitsConsumerResetRetry(
                rollbackConfirmed: rollbackConfirmed
            ) {
                markPlannedConsumerResetCompleted(candidate.predecessor)
                emitPlannedConsumerResetOutcome(
                    .rollbackUnconfirmed,
                    producerId: candidate.producerId,
                    predecessorId: candidate.predecessor.consumerId,
                    successorId: successorIdentity?.consumerId,
                    attempt: attempt,
                    startedAtMs: attemptStartedAt
                )
                return
            }

            emitPlannedConsumerResetOutcome(
                .rolledBack,
                producerId: candidate.producerId,
                predecessorId: candidate.predecessor.consumerId,
                successorId: successorIdentity?.consumerId,
                attempt: attempt,
                startedAtMs: attemptStartedAt
            )
            if attempt < PlannedWebcamConsumerResetPolicy.maxAttempts {
                do {
                    try await Task.sleep(
                        nanoseconds: UInt64(
                            PlannedWebcamConsumerResetPolicy.retryDelayMilliseconds
                        ) * 1_000_000
                    )
                } catch {
                    return
                }
            }
        }

        markPlannedConsumerResetCompleted(candidate.predecessor)
        emitPlannedConsumerResetOutcome(
            .attemptsExhausted,
            producerId: candidate.producerId,
            predecessorId: candidate.predecessor.consumerId,
            successorId: nil,
            attempt: PlannedWebcamConsumerResetPolicy.maxAttempts,
            startedAtMs: candidate.firstTopLayerAtMs
        )
    }

    private func promoteStagedConsumer(
        successor: ConsumerGenerationIdentity,
        predecessor: ConsumerGenerationIdentity
    ) -> Bool {
        guard var successorInfo = consumers[successor.consumerId],
              successorInfo.generation == successor.generation,
              successorInfo.lifecycleRole == .staged,
              !successorInfo.isConsumerPaused,
              !successorInfo.isProducerPaused,
              !successorInfo.isAdaptivelyPaused,
              var predecessorInfo = consumers[predecessor.consumerId],
              predecessorInfo.generation == predecessor.generation,
              predecessorInfo.lifecycleRole == .displaced,
              !predecessorInfo.isConsumerPaused,
              !predecessorInfo.isProducerPaused,
              !predecessorInfo.isAdaptivelyPaused,
              successorInfo.producerId == predecessorInfo.producerId,
              successorInfo.trackKey == predecessorInfo.trackKey,
              let videoTrack = successorInfo.consumer.track as? RTCVideoTrack else {
            return false
        }
        let visibleIdentity = remoteVideoTracks[predecessorInfo.trackKey].map {
            ConsumerGenerationIdentity(
                consumerId: $0.id,
                generation: $0.consumerGeneration
            )
        }
        guard visibleIdentity == predecessor else { return false }

        successorInfo.lifecycleRole = .current
        successorInfo.plannedResetCompleted = true
        predecessorInfo.lifecycleRole = .displaced
        consumers[successor.consumerId] = successorInfo
        consumers[predecessor.consumerId] = predecessorInfo
        remoteVideoTracks[successorInfo.trackKey] = VideoTrackWrapper(
            id: successor.consumerId,
            userId: successorInfo.trackKey,
            isLocal: false,
            track: videoTrack,
            consumerGeneration: successor.generation
        )
        return true
    }

    private func rollbackStagedConsumer(
        _ successor: ConsumerGenerationIdentity,
        predecessor: ConsumerGenerationIdentity,
        producerId: String,
        handoffRequestId: String
    ) async -> Bool {
        if let info = consumers[successor.consumerId],
           info.generation == successor.generation {
            removeConsumer(
                consumerId: successor.consumerId,
                info: info,
                closeConsumer: true,
                notifyServer: false
            )
        }
        let confirmed: Bool
        if let socketManager {
            confirmed = await abortServerConsumerHandoffAndConfirm(
                requestId: handoffRequestId,
                producerId: producerId,
                predecessorConsumerId: predecessor.consumerId,
                socket: socketManager
            )
        } else {
            confirmed = false
        }
        restoreDisplacedPredecessor(predecessor)
        return confirmed
    }

    private func restoreDisplacedPredecessor(
        _ predecessor: ConsumerGenerationIdentity
    ) {
        guard var info = consumers[predecessor.consumerId],
              info.generation == predecessor.generation else { return }
        info.lifecycleRole = .current
        consumers[predecessor.consumerId] = info
    }

    private func retirePromotedPredecessor(
        _ predecessor: ConsumerGenerationIdentity
    ) async -> Bool {
        let confirmed: Bool
        if let socketManager {
            confirmed = await closeServerConsumerGenerationAndConfirm(
                consumerId: predecessor.consumerId,
                socket: socketManager
            )
        } else {
            confirmed = false
        }
        if let info = consumers[predecessor.consumerId],
           info.generation == predecessor.generation {
            removeConsumer(
                consumerId: predecessor.consumerId,
                info: info,
                closeConsumer: true,
                notifyServer: false
            )
        }
        return confirmed
    }

    private func markPlannedConsumerResetCompleted(
        _ identity: ConsumerGenerationIdentity
    ) {
        guard var info = consumers[identity.consumerId],
              info.generation == identity.generation else { return }
        info.plannedResetCompleted = true
        consumers[identity.consumerId] = info
    }

    private func emitPlannedConsumerResetOutcome(
        _ outcome: PlannedWebcamConsumerResetOutcome,
        producerId: String,
        predecessorId: String,
        successorId: String?,
        attempt: Int,
        startedAtMs: Int64
    ) {
        let elapsedMs = max(0, Self.monotonicMilliseconds() - startedAtMs)
        let report = [
            "outcome=\(outcome.rawValue)",
            "producerId=\(producerId)",
            "predecessorId=\(predecessorId)",
            "successorId=\(successorId ?? "-")",
            "attempt=\(attempt)",
            "elapsedMs=\(elapsedMs)",
            // Decoder proof is not UI-render proof. Keep this explicitly
            // unmeasured until the visible renderer supplies timestamps.
            "visibleInterruptionMs=unmeasured"
        ].joined(separator: " ")
        debugLog("[WebRTC][consumer-reset] \(report)")
        onPlannedConsumerResetOutcome?(report)
    }

    private func removeConsumer(
        consumerId: String,
        info: ConsumerInfo,
        closeConsumer: Bool,
        notifyServer: Bool = true
    ) {
        let expectedIdentity = ConsumerGenerationIdentity(
            consumerId: consumerId,
            generation: info.generation
        )
        let currentIdentity = consumers[consumerId].map {
            ConsumerGenerationIdentity(
                consumerId: consumerId,
                generation: $0.generation
            )
        }
        guard ConsumerGenerationRemovalPolicy.ownsConsumerSlot(
            expected: expectedIdentity,
            current: currentIdentity
        ), consumers[consumerId]?.consumer === info.consumer else {
            return
        }

        if closeConsumer {
            info.consumer.close()
            if notifyServer {
                socketManager?.closeConsumer(consumerId: consumerId)
            }
        }
        consumers.removeValue(forKey: consumerId)
        if plannedConsumerResetCandidates.removeValue(forKey: consumerId) != nil {
            wakePlannedConsumerResetCoordinator()
        }
        videoFreezeStats.removeValue(forKey: consumerId)
        remoteConsumerPreferenceSignatures.removeValue(forKey: consumerId)
        remoteConsumerLayerPreferenceUnsupportedIds.remove(consumerId)
        remoteConsumerPreferenceInFlightIds.remove(consumerId)
        cancelFirstDecodedVideoFrameObservation(identity: expectedIdentity)

        let key = info.trackKey.isEmpty ? info.userId : info.trackKey
        if info.kind == "video", !key.isEmpty {
            let currentTrackIdentity = remoteVideoTracks[key].map {
                ConsumerGenerationIdentity(
                    consumerId: $0.id,
                    generation: $0.consumerGeneration
                )
            }
            if ConsumerGenerationRemovalPolicy.ownsTrackSlot(
                expected: expectedIdentity,
                current: currentTrackIdentity
            ) {
                remoteVideoTracks.removeValue(forKey: key)
            }
        }
    }

    private func cancelFirstDecodedVideoFrameObservation(
        identity: ConsumerGenerationIdentity
    ) {
        firstDecodedVideoFrameRenderers.removeValue(forKey: identity)?.cancel()
        if let signal = firstDecodedVideoFrameSignals.removeValue(forKey: identity) {
            Task {
                await signal.cancel()
            }
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
        let consumerGeneration: Int
        let policyRevision: Int
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
                    temporalLayer: WebcamTemporalLayerPolicy.receiveTemporalLayer,
                    priority: 180
                )
            case .fair:
                return InitialConsumerPreference(
                    spatialLayer: 1,
                    temporalLayer: WebcamTemporalLayerPolicy.receiveTemporalLayer,
                    priority: 150
                )
            case .poor:
                return InitialConsumerPreference(
                    spatialLayer: 0,
                    temporalLayer: WebcamTemporalLayerPolicy.receiveTemporalLayer,
                    priority: 120
                )
            case .emergency:
                return InitialConsumerPreference(
                    spatialLayer: 0,
                    temporalLayer: WebcamTemporalLayerPolicy.receiveTemporalLayer,
                    priority: 145
                )
            case .unknown:
                break
            }
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
            temporalLayer: WebcamTemporalLayerPolicy.receiveTemporalLayer,
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

    private func recordAppliedRemoteConsumerPreference(
        _ preference: RemoteConsumerPreference,
        signature: String,
        consumerId: String,
        consumerGeneration: Int,
        policyRevision: Int
    ) {
        guard remoteConsumerPreferencePolicyRevision == policyRevision,
              var info = consumers[consumerId],
              info.generation == consumerGeneration else { return }
        info.isConsumerPaused = preference.paused
        consumers[consumerId] = info
        if preference.paused {
            invalidatePlannedConsumerResetCandidate(consumerId: consumerId)
        }
        if info.lifecycleRole.acceptsPeriodicControls {
            remoteConsumerPreferenceSignatures[consumerId] = signature
        }
    }

    private func scheduleRemoteConsumerPreferenceRetry(
        focusedUserIds: Set<String>,
        visibleUserIds: Set<String>,
        connectionQuality: ConnectionQuality,
        videoQuality: VideoQuality,
        expectedPolicyRevision: Int
    ) {
        guard remoteConsumerPreferencePolicyRevision == expectedPolicyRevision,
              remoteConsumerPreferenceRetryTask == nil else { return }

        remoteConsumerPreferenceRetryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: WebRTCClient.remoteConsumerPreferenceRetryDelayNanoseconds)
            guard let self, !Task.isCancelled else { return }
            guard self.remoteConsumerPreferencePolicyRevision == expectedPolicyRevision else {
                self.remoteConsumerPreferenceRetryTask = nil
                return
            }
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
        remoteConsumerPreferenceRetryTask?.cancel()
        remoteConsumerPreferenceRetryTask = nil
        remoteConsumerPreferencePolicyRevision += 1
        let policyRevision = remoteConsumerPreferencePolicyRevision
        remoteVideoReceiveEnabled = receiveVideo
        // Policy generations are part of reset ownership. Cancel a sleeping or
        // in-flight reset immediately so stale top-layer evidence cannot cross
        // a receive-disable or adaptive downgrade boundary.
        wakePlannedConsumerResetCoordinator()
        guard let socketManager else { return }

        let shouldReceiveVideo = receiveVideo
        let consumerSnapshot = consumers.filter {
            $0.value.lifecycleRole.acceptsPeriodicControls
        }
        let consumerTransitionInProgress = consumers.values.contains {
            !$0.lifecycleRole.acceptsPeriodicControls
        }
        let emergencyKeepWebcamUserId: String? = {
            guard connectionQuality == .emergency else { return nil }
            let webcamInfos = consumers.values
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
        for consumerId in Array(consumers.keys) {
            guard var info = consumers[consumerId],
                  info.kind == "video",
                  info.type == ProducerType.webcam.rawValue else { continue }
            info.isAdaptivelyPaused = remoteConsumerPreference(
                for: info,
                focusedUserIds: focusedUserIds,
                visibleUserIds: visibleUserIds,
                emergencyKeepWebcamUserId: emergencyKeepWebcamUserId,
                connectionQuality: connectionQuality,
                videoQuality: videoQuality,
                receiveVideo: shouldReceiveVideo
            )?.paused ?? false
            consumers[consumerId] = info
        }
        var pendingUpdates: [PendingRemoteConsumerPreferenceUpdate] = []
        var skippedInFlightConsumer = false
        for (consumerId, info) in consumerSnapshot {
            guard consumers[consumerId]?.lifecycleRole.acceptsPeriodicControls == true else { continue }
            guard let preference = remoteConsumerPreference(
                for: info,
                focusedUserIds: focusedUserIds,
                visibleUserIds: visibleUserIds,
                emergencyKeepWebcamUserId: emergencyKeepWebcamUserId,
                connectionQuality: connectionQuality,
                videoQuality: videoQuality,
                receiveVideo: shouldReceiveVideo
            ) else { continue }
            guard !remoteConsumerPreferenceInFlightIds.contains(consumerId) else {
                skippedInFlightConsumer = true
                continue
            }

            let effectivePreference = remoteConsumerLayerPreferenceUnsupportedIds.contains(consumerId)
                ? preference.withoutLayerPreference
                : preference
            let previousSignature = remoteConsumerPreferenceSignatures[consumerId]
            let signature = effectivePreference.signature
            guard previousSignature != signature else { continue }

            pendingUpdates.append(PendingRemoteConsumerPreferenceUpdate(
                consumerId: consumerId,
                consumerGeneration: info.generation,
                policyRevision: policyRevision,
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
        if pendingUpdates.count > updatesToSend.count ||
            skippedInFlightConsumer ||
            consumerTransitionInProgress {
            scheduleRemoteConsumerPreferenceRetry(
                focusedUserIds: focusedUserIds,
                visibleUserIds: visibleUserIds,
                connectionQuality: connectionQuality,
                videoQuality: videoQuality,
                expectedPolicyRevision: policyRevision
            )
        }

        for (index, update) in updatesToSend.enumerated() {
            if Task.isCancelled { return }
            if index > 0 {
                try? await Task.sleep(nanoseconds: Self.remoteConsumerPreferenceEmitSpacingNanoseconds)
            }
            guard remoteConsumerPreferencePolicyRevision == policyRevision else { return }

            let consumerId = update.consumerId
            guard let currentInfo = consumers[consumerId],
                  currentInfo.generation == update.consumerGeneration,
                  update.policyRevision == policyRevision,
                  currentInfo.lifecycleRole.acceptsPeriodicControls else { continue }
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
                recordAppliedRemoteConsumerPreference(
                    update.effectivePreference,
                    signature: update.signature,
                    consumerId: consumerId,
                    consumerGeneration: update.consumerGeneration,
                    policyRevision: update.policyRevision
                )
            } catch {
                if isConsumerControlRateLimitError(error) {
                    scheduleRemoteConsumerPreferenceRetry(
                        focusedUserIds: focusedUserIds,
                        visibleUserIds: visibleUserIds,
                        connectionQuality: connectionQuality,
                        videoQuality: videoQuality,
                        expectedPolicyRevision: policyRevision
                    )
                    continue
                }

                if update.effectivePreference.hasLayerPreference,
                   isUnsupportedConsumerLayerPreferenceError(error) {
                    guard remoteConsumerPreferencePolicyRevision == policyRevision,
                          let fallbackInfo = consumers[consumerId],
                          fallbackInfo.generation == update.consumerGeneration,
                          fallbackInfo.lifecycleRole.acceptsPeriodicControls else { continue }
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
                        recordAppliedRemoteConsumerPreference(
                            fallbackPreference,
                            signature: fallbackPreference.signature,
                            consumerId: consumerId,
                            consumerGeneration: update.consumerGeneration,
                            policyRevision: update.policyRevision
                        )
                    } catch {
                        if isConsumerControlRateLimitError(error) {
                            scheduleRemoteConsumerPreferenceRetry(
                                focusedUserIds: focusedUserIds,
                                visibleUserIds: visibleUserIds,
                                connectionQuality: connectionQuality,
                                videoQuality: videoQuality,
                                expectedPolicyRevision: policyRevision
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
                temporalLayer: WebcamTemporalLayerPolicy.receiveTemporalLayer,
                priority: 8,
                paused: true
            )
        }

        if !isVisible && (isPoor || videoQuality == .low) {
            return RemoteConsumerPreference(
                spatialLayer: 0,
                temporalLayer: WebcamTemporalLayerPolicy.receiveTemporalLayer,
                priority: 8,
                paused: true
            )
        }

        if isFocused {
            return RemoteConsumerPreference(
                spatialLayer: isEmergency ? 0 : (isConstrained ? 1 : 2),
                temporalLayer: WebcamTemporalLayerPolicy.receiveTemporalLayer,
                priority: isEmergency ? 145 : (isConstrained ? 150 : 180),
                paused: false
            )
        }

        if isVisible {
            return RemoteConsumerPreference(
                spatialLayer: isConstrained ? 0 : 1,
                temporalLayer: WebcamTemporalLayerPolicy.receiveTemporalLayer,
                priority: isEmergency ? 70 : (isConstrained ? 80 : 105),
                paused: false
            )
        }

        return RemoteConsumerPreference(
            spatialLayer: 0,
            temporalLayer: WebcamTemporalLayerPolicy.receiveTemporalLayer,
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
    private var webcamProducerTopology: WebcamProducerTopology = .other
    private var webcamReceiverCapacityRoomId: String?
    private var webcamReceiverCapacityAuthorityAvailable = false
    private var webcamReceiverCapacityProofCache = WebcamReceiverCapacityProofCache()
    private var webcamTopologyTransitionState = WebcamTopologyTransitionState.initial()
    private var pendingWebcamTopologyCommand: WebcamTopologyReplacementCommand?
    private var webcamTopologyCommandTask: Task<Void, Never>?
    private var webcamTopologyWakeTask: Task<Void, Never>?
    private var webcamTopologyControlGeneration = 0
    private var intentionalLocalVideoProducerCloseIds: Set<String> = []
    private var lastWebcamProducerSignalingError: Error?
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

    private struct WebcamVideoCodecOptions: Encodable {
        let videoGoogleStartBitrate: Int
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
        plannedConsumerResetCoordinatorTask?.cancel()
        plannedConsumerResetCandidates.removeAll()
        activeConsumerResetRoomId = nil
        activeConsumerResetLifecycleGeneration = nil
        resetWebcamTopologyControl()
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
                    codecOptions: try webcamVideoCodecOptionsJSON(
                        quality: currentVideoQuality,
                        connectionQuality: currentLocalBandwidthQuality
                    ),
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
            webcamProducerTopology = .vp8Simulcast
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
                WebcamEncodingSpec(rid: "q", scaleResolutionDownBy: 4, maxBitrateBps: 80_000, maxFramerate: 12),
                WebcamEncodingSpec(rid: "h", scaleResolutionDownBy: 2, maxBitrateBps: 220_000, maxFramerate: 20),
                WebcamEncodingSpec(rid: "f", scaleResolutionDownBy: 1, maxBitrateBps: 1_650_000, maxFramerate: 30)
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
            encoding.numTemporalLayers = NSNumber(value: WebcamTemporalLayerPolicy.temporalLayerCount)
            encoding.networkPriority = spec.rid == "f" ? .low : .veryLow
            return encoding
        }
    }

    /// A true mediasoup simple producer: one VP8 encoding, no RID fan-out, and
    /// the same full-resolution camera track already feeding the predecessor.
    private func webcamSingleReceiverEncodings() -> [RTCRtpEncodingParameters] {
        let encoding = RTCRtpEncodingParameters()
        encoding.isActive = true
        encoding.scaleResolutionDownBy = NSNumber(value: 1.0)
        encoding.maxBitrateBps = NSNumber(value: 1_650_000)
        encoding.maxFramerate = NSNumber(value: 30.0)
        encoding.numTemporalLayers = NSNumber(value: WebcamTemporalLayerPolicy.temporalLayerCount)
        encoding.networkPriority = .low
        return [encoding]
    }

    /// The compensating topology is always the known-good standard VP8 ladder.
    /// Adaptive sender updates may constrain it later without changing topology.
    private func restoredAdaptiveWebcamEncodings() -> [RTCRtpEncodingParameters] {
        webcamEncodings(for: .standard, connectionQuality: .good)
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

    private enum ConsumerRegistrationVisibility {
        case currentVisible
        case staged
    }

    private struct ConsumerGenerationRegistrationError: LocalizedError {
        let underlying: Error
        let rollbackAcknowledged: Bool

        var errorDescription: String? { underlying.localizedDescription }
    }

    private enum PlannedConsumerResetFailure: Error {
        case firstFrameTimeout
        case ineligibleSuccessor
        case contextChanged
    }

    func consumeProducer(
        producerId: String,
        producerUserId: String,
        producerKind: String? = nil,
        producerType: String = "webcam",
        preferHighWebcamLayer: Bool = false,
        initialReceiveConnectionQuality: ConnectionQuality = .unknown,
        roomId: String? = nil,
        meetingLifecycleGeneration: Int = 0
    ) async throws {
        let normalizedRoomId = PlannedWebcamConsumerResetPolicy.normalizedRoomId(roomId) ?? ""
        updatePlannedConsumerResetContext(
            roomId: normalizedRoomId,
            meetingLifecycleGeneration: meetingLifecycleGeneration
        )
        _ = try await registerConsumerGeneration(
            producerId: producerId,
            producerUserId: producerUserId,
            producerKind: producerKind,
            producerType: producerType,
            preferHighWebcamLayer: preferHighWebcamLayer,
            initialReceiveConnectionQuality: initialReceiveConnectionQuality,
            roomId: normalizedRoomId,
            meetingLifecycleGeneration: meetingLifecycleGeneration,
            visibility: .currentVisible,
            plannedResetCompleted: false
        )
    }

    private func registerConsumerGeneration(
        producerId: String,
        producerUserId: String,
        producerKind: String?,
        producerType: String,
        preferHighWebcamLayer: Bool,
        initialReceiveConnectionQuality: ConnectionQuality,
        roomId: String,
        meetingLifecycleGeneration: Int,
        visibility: ConsumerRegistrationVisibility,
        plannedResetCompleted: Bool,
        plannedHandoffRequestId: String? = nil,
        plannedHandoffPredecessorConsumerId: String? = nil,
        signalingTimeoutMilliseconds: Int? = nil
    ) async throws -> ConsumerGenerationIdentity {
        let consumeConfigurationGeneration = configurationGeneration
        let producerClosureGeneration = remoteProducerClosureGenerations[producerId, default: 0]
        try await createReceiveTransportIfNeeded()
        guard let socket = socketManager,
              let device,
              let receiveTransport = receiveTransport,
              let receiveTransportId = receiveTransportId else {
            throw WebRTCError.notConfigured
        }

        let rtpCaps = try NativeReceiveCapabilitiesPolicy.decodeLoadedDeviceCapabilities(
            try device.rtpCapabilities()
        )

        let initialPreference = initialConsumerPreference(
            producerKind: producerKind,
            producerType: producerType,
            preferHighWebcamLayer: preferHighWebcamLayer,
            initialReceiveConnectionQuality: initialReceiveConnectionQuality
        )

        let response: ConsumeResponse
        do {
            response = try await socket.consume(
                producerId: producerId,
                rtpCapabilities: rtpCaps,
                transportId: receiveTransportId,
                preferredSpatialLayer: initialPreference.spatialLayer,
                preferredTemporalLayer: initialPreference.temporalLayer,
                priority: initialPreference.priority,
                plannedHandoffRequestId: plannedHandoffRequestId,
                plannedHandoffPredecessorConsumerId:
                    plannedHandoffPredecessorConsumerId,
                timeoutMilliseconds: signalingTimeoutMilliseconds
            )
        } catch {
            let rollbackAcknowledged = await abortPlannedHandoffIfNeeded(
                requestId: plannedHandoffRequestId,
                producerId: producerId,
                predecessorConsumerId: plannedHandoffPredecessorConsumerId,
                socket: socket
            )
            throw ConsumerGenerationRegistrationError(
                underlying: error,
                rollbackAcknowledged: rollbackAcknowledged
            )
        }

        if let plannedHandoffRequestId,
           response.plannedConsumerHandoffRequestId?.caseInsensitiveCompare(
            plannedHandoffRequestId
           ) != .orderedSame {
            let rollbackAcknowledged = await abortPlannedHandoffIfNeeded(
                requestId: plannedHandoffRequestId,
                producerId: producerId,
                predecessorConsumerId: plannedHandoffPredecessorConsumerId,
                socket: socket
            )
            throw ConsumerGenerationRegistrationError(
                underlying: WebRTCError.staleConfiguration,
                rollbackAcknowledged: rollbackAcknowledged
            )
        }

        let kind: MediaKind = response.kind == "video" ? .video : .audio
        let rtpParameters: String
        let consumer: Consumer
        do {
            rtpParameters = try encodeJSONString(response.rtpParameters)
            consumer = try receiveTransport.consume(
                consumerId: response.id,
                producerId: response.producerId,
                kind: kind,
                rtpParameters: rtpParameters,
                appData: nil
            )
        } catch {
            let rollbackAcknowledged = await rollbackServerConsumerGenerationAndConfirm(
                consumerId: response.id,
                producerId: producerId,
                plannedHandoffRequestId: plannedHandoffRequestId,
                plannedHandoffPredecessorConsumerId:
                    plannedHandoffPredecessorConsumerId,
                socket: socket
            )
            throw ConsumerGenerationRegistrationError(
                underlying: error,
                rollbackAcknowledged: rollbackAcknowledged
            )
        }
        consumer.delegate = self
        consumer.resume()

        // A user can produce a webcam AND a screen-share at once - store them
        // under distinct keys so one never overwrites the other.
        let isScreenVideo = (producerType == "screen" && response.kind == "video")
        let trackKey = isScreenVideo ? "\(producerUserId)-screen" : producerUserId
        nextConsumerGeneration += 1
        let consumerGeneration = nextConsumerGeneration
        let consumerIdentity = ConsumerGenerationIdentity(
            consumerId: response.id,
            generation: consumerGeneration
        )
        let actualVideoCodecMimeType = PlannedWebcamConsumerResetPolicy.actualVideoCodecMimeType(
            response.rtpParameters
        )
        let maxSpatialLayer = PlannedWebcamConsumerResetPolicy.derivedMaxSpatialLayer(
            explicit: response.maxSpatialLayer,
            encodings: response.rtpParameters.encodings
        )
        let firstFrameSignal: FirstDecodedVideoFrameSignal?
        let firstFrameRenderer: FirstDecodedVideoFrameRenderer?
        if response.kind == "video", let videoTrack = consumer.track as? RTCVideoTrack {
            let signal = FirstDecodedVideoFrameSignal()
            let renderer = FirstDecodedVideoFrameRenderer(
                track: videoTrack,
                signal: signal
            )
            firstFrameSignal = signal
            firstFrameRenderer = renderer
            videoTrack.add(renderer)
        } else {
            firstFrameSignal = nil
            firstFrameRenderer = nil
        }

        let isResetEligible = PlannedWebcamConsumerResetPolicy.isEligible(
            kind: response.kind,
            producerType: producerType,
            consumerType: response.consumerType,
            actualVideoCodecMimeType: actualVideoCodecMimeType,
            maxSpatialLayer: maxSpatialLayer
        )
        consumers[response.id] = ConsumerInfo(
            consumer: consumer,
            producerId: response.producerId,
            userId: producerUserId,
            kind: response.kind,
            type: producerType,
            generation: consumerGeneration,
            roomId: roomId,
            meetingLifecycleGeneration: meetingLifecycleGeneration,
            createdAtMonotonicMs: Self.monotonicMilliseconds(),
            consumerType: response.consumerType,
            actualVideoCodecMimeType: actualVideoCodecMimeType,
            maxSpatialLayer: maxSpatialLayer,
            isConsumerPaused: response.paused ?? false,
            isProducerPaused: response.producerPaused ?? false,
            isAdaptivelyPaused: false,
            lifecycleRole: visibility == .currentVisible ? .current : .staged,
            plannedResetCompleted: plannedResetCompleted || !isResetEligible,
            trackKey: trackKey
        )

        if let firstFrameSignal, let firstFrameRenderer {
            firstDecodedVideoFrameSignals[consumerIdentity] = firstFrameSignal
            firstDecodedVideoFrameRenderers[consumerIdentity] = firstFrameRenderer
        }

        // Request a keyframe on the initial video consume so the decoder gets a
        // fresh IDR immediately instead of showing nothing/garbage until the
        // producer's next natural keyframe.
        if visibility == .currentVisible,
           response.kind == "video",
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
        do {
            try await socket.resumeConsumer(
                consumerId: response.id,
                requestKeyFrame: response.kind == "video",
                timeoutMilliseconds: signalingTimeoutMilliseconds
            )
            if var resumedInfo = consumers[response.id],
               resumedInfo.generation == consumerGeneration {
                resumedInfo.isConsumerPaused = false
                consumers[response.id] = resumedInfo
            }
        } catch {
            // A consumer is not usable until the SFU has resumed its server
            // half. Do not leave a locally registered, server-paused track
            // behind: MeetingViewModel must be able to retry this producer.
            if let info = consumers[response.id] {
                removeConsumer(
                    consumerId: response.id,
                    info: info,
                    closeConsumer: true,
                    notifyServer: false
                )
            }
            let rollbackAcknowledged = await rollbackServerConsumerGenerationAndConfirm(
                consumerId: response.id,
                producerId: producerId,
                plannedHandoffRequestId: plannedHandoffRequestId,
                plannedHandoffPredecessorConsumerId:
                    plannedHandoffPredecessorConsumerId,
                socket: socket
            )
            throw ConsumerGenerationRegistrationError(
                underlying: error,
                rollbackAcknowledged: rollbackAcknowledged
            )
        }

        guard configurationGeneration == consumeConfigurationGeneration,
              remoteProducerClosureGenerations[producerId, default: 0] == producerClosureGeneration else {
            if let info = consumers[response.id] {
                removeConsumer(
                    consumerId: response.id,
                    info: info,
                    closeConsumer: true,
                    notifyServer: false
                )
            }
            let rollbackAcknowledged = await rollbackServerConsumerGenerationAndConfirm(
                consumerId: response.id,
                producerId: producerId,
                plannedHandoffRequestId: plannedHandoffRequestId,
                plannedHandoffPredecessorConsumerId:
                    plannedHandoffPredecessorConsumerId,
                socket: socket
            )
            throw ConsumerGenerationRegistrationError(
                underlying: WebRTCError.staleConfiguration,
                rollbackAcknowledged: rollbackAcknowledged
            )
        }

        if visibility == .currentVisible,
           response.kind == "video",
           let videoTrack = consumer.track as? RTCVideoTrack {
            let trackWrapper = VideoTrackWrapper(
                id: response.id,
                userId: trackKey,
                isLocal: false,
                track: videoTrack,
                consumerGeneration: consumerGeneration
            )
            remoteVideoTracks[trackKey] = trackWrapper
        }

        if visibility == .currentVisible,
           let currentSpatialLayer = response.currentLayers?.spatialLayer {
            observePlannedConsumerResetLayer(
                consumerId: response.id,
                roomId: roomId,
                currentSpatialLayer: currentSpatialLayer
            )
        }

        debugLog("[WebRTC] Consuming \(producerType) producer \(producerId) for user \(producerUserId)")
        return consumerIdentity
    }

    private func abortPlannedHandoffIfNeeded(
        requestId: String?,
        producerId: String,
        predecessorConsumerId: String?,
        socket: SocketIOManager
    ) async -> Bool {
        guard let requestId else { return true }
        guard let predecessorConsumerId else { return false }
        return await abortServerConsumerHandoffAndConfirm(
            requestId: requestId,
            producerId: producerId,
            predecessorConsumerId: predecessorConsumerId,
            socket: socket
        )
    }

    private func rollbackServerConsumerGenerationAndConfirm(
        consumerId: String,
        producerId: String,
        plannedHandoffRequestId: String?,
        plannedHandoffPredecessorConsumerId: String?,
        socket: SocketIOManager
    ) async -> Bool {
        if let plannedHandoffRequestId,
           let plannedHandoffPredecessorConsumerId {
            return await abortServerConsumerHandoffAndConfirm(
                requestId: plannedHandoffRequestId,
                producerId: producerId,
                predecessorConsumerId:
                    plannedHandoffPredecessorConsumerId,
                socket: socket
            )
        }
        return await closeServerConsumerGenerationAndConfirm(
            consumerId: consumerId,
            socket: socket
        )
    }

    private func abortServerConsumerHandoffAndConfirm(
        requestId: String,
        producerId: String,
        predecessorConsumerId: String,
        socket: SocketIOManager
    ) async -> Bool {
        // Run cleanup in an unstructured MainActor task so cancellation of the
        // reset coordinator cannot cancel the bounded abort-ACK retry sequence
        // that fences a late consume completion. The caller still waits for
        // the result before another consumer-reset attempt can begin.
        let confirmation = Task { @MainActor in
            do {
                _ = try await socket.abortConsumerHandoffAndWait(
                    requestId: requestId,
                    producerId: producerId,
                    predecessorConsumerId: predecessorConsumerId,
                    timeoutMilliseconds:
                        PlannedWebcamConsumerResetPolicy.closeAcknowledgementTimeoutMilliseconds
                )
                return true
            } catch {
                return false
            }
        }
        return await confirmation.value
    }

    private func closeServerConsumerGenerationAndConfirm(
        consumerId: String,
        socket: SocketIOManager
    ) async -> Bool {
        do {
            try await socket.closeConsumerAndWait(
                consumerId: consumerId,
                timeoutMilliseconds: PlannedWebcamConsumerResetPolicy.closeAcknowledgementTimeoutMilliseconds
            )
            return true
        } catch {
            socket.closeConsumer(consumerId: consumerId)
            return false
        }
    }

    func closeConsumer(producerId: String, userId: String) {
        if !producerId.isEmpty {
            remoteProducerClosureGenerations[producerId, default: 0] += 1
            invalidatePlannedConsumerResets(producerId: producerId)
        }
        if producerId.isEmpty {
            let consumerIds = consumers
                .filter { consumerMatchesUser($0.value, userId: userId) }
                .map { $0.key }
            for id in consumerIds {
                if let info = consumers[id] {
                    removeConsumer(consumerId: id, info: info, closeConsumer: true)
                }
            }
        } else {
            let matchingConsumers = consumers.filter {
                $0.value.producerId == producerId
            }
            for (consumerId, info) in matchingConsumers {
                removeConsumer(
                    consumerId: consumerId,
                    info: info,
                    closeConsumer: true
                )
            }
        }

        // User left entirely (empty producerId path) - clear both their slots.
        if producerId.isEmpty, !userId.isEmpty {
            for key in Array(remoteVideoTracks.keys) where trackKeyMatchesUser(key, userId: userId) {
                remoteVideoTracks.removeValue(forKey: key)
            }
        }
    }

    /// Close one exact consumer generation without invalidating the producer.
    /// This is the predecessor-close primitive required by a future overlapping
    /// consumer handoff after its successor has decoded a frame.
    func closeConsumer(consumerId: String) {
        guard let info = consumers[consumerId] else { return }
        removeConsumer(
            consumerId: consumerId,
            info: info,
            closeConsumer: true
        )
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

    /// Applies a privacy-critical local mute immediately while the signaling
    /// connection is unavailable. The user's intent is republished by the
    /// meeting view model after recovery; no socket acknowledgement is needed
    /// (or possible) here.
    func suspendLocalAudioForRecovery() {
        audioCaptureReassertionTask?.cancel()
        audioCaptureReassertionTask = nil
        audioCaptureRestartTask?.cancel()
        audioCaptureRestartTask = nil
        audioProducer?.pause()
        rtcLocalAudioTrack?.isEnabled = false
        localAudioEnabled = false
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
            evaluateWebcamTopologyTransition()

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

    /// Stops local camera capture without touching signaling. Capture the old
    /// capturer before suspension so replacement media cannot be stopped if
    /// reconnect setup completes while `stopCapture()` is awaiting.
    func suspendLocalVideoForRecovery() async {
        invalidateWebcamReceiverCapacityAuthority()
        let capturer = videoCapturer
        videoProducer?.pause()
        rtcLocalVideoTrack?.isEnabled = false
        localVideoTrack?.isEnabled = false
        localVideoEnabled = false
        await capturer?.stopCapture()
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

        resetWebcamTopologyControl()

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
        resetWebcamTopologyControl()
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
            resetWebcamTopologyControl()
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

    private func webcamVideoCodecOptionsJSON(
        quality: VideoQuality,
        connectionQuality: ConnectionQuality
    ) throws -> String {
        try encodeJSONString(
            WebcamVideoCodecOptions(
                videoGoogleStartBitrate: WebcamVideoCodecPolicy.googleStartBitrateKbps(
                    quality: quality,
                    connectionQuality: connectionQuality
                )
            )
        )
    }

    func handleWebcamReceiverCapacityProof(
        _ notification: WebcamReceiverCapacityProofNotification,
        expectedRoomId: String
    ) {
        guard notification.roomId == expectedRoomId else { return }
        if webcamReceiverCapacityRoomId != expectedRoomId {
            let existingTopology = webcamProducerTopology
            resetWebcamTopologyControl()
            webcamReceiverCapacityRoomId = expectedRoomId
            webcamReceiverCapacityProofCache.reset(roomId: expectedRoomId)
            webcamProducerTopology = videoProducer == nil ? .other : existingTopology
        }
        let now = Self.webcamTopologyMonotonicMs()
        guard webcamReceiverCapacityProofCache.apply(
            notification,
            expectedRoomId: expectedRoomId,
            nowMonotonicMs: now
        ) else { return }
        webcamReceiverCapacityAuthorityAvailable = true
        evaluateWebcamTopologyTransition(nowMonotonicMs: now)
    }

    func invalidateWebcamReceiverCapacityAuthority() {
        webcamReceiverCapacityAuthorityAvailable = false
        webcamReceiverCapacityProofCache.reset(roomId: webcamReceiverCapacityRoomId)
        evaluateWebcamTopologyTransition()
    }

    /// The SFU may broadcast predecessor closure before the new produce call
    /// returns. Consume the marker before MeetingViewModel clears camera state
    /// or schedules recovery; the successor reference is committed separately.
    func consumeIntentionalLocalVideoProducerClose(producerId: String) -> Bool {
        intentionalLocalVideoProducerCloseIds.remove(producerId) != nil
    }

    private static func webcamTopologyMonotonicMs() -> Double {
        ProcessInfo.processInfo.systemUptime * 1_000.0
    }

    private func resetWebcamTopologyControl() {
        webcamTopologyControlGeneration += 1
        webcamTopologyCommandTask?.cancel()
        webcamTopologyCommandTask = nil
        webcamTopologyWakeTask?.cancel()
        webcamTopologyWakeTask = nil
        pendingWebcamTopologyCommand = nil
        webcamReceiverCapacityRoomId = nil
        webcamReceiverCapacityAuthorityAvailable = false
        webcamReceiverCapacityProofCache.reset()
        webcamTopologyTransitionState = .initial(
            nowMonotonicMs: Self.webcamTopologyMonotonicMs()
        )
        webcamProducerTopology = .other
        intentionalLocalVideoProducerCloseIds.removeAll()
        lastWebcamProducerSignalingError = nil
    }

    private var hardSingleReceiverConditionsMet: Bool {
        webcamReceiverCapacityAuthorityAvailable &&
            currentVideoQuality == .standard &&
            currentLocalBandwidthQuality == .good &&
            localVideoEnabled &&
            rtcLocalVideoTrack?.isEnabled == true &&
            videoProducer?.closed == false &&
            screenProducer == nil
    }

    private func webcamTopologyTransitionInput(
        nowMonotonicMs: Double
    ) -> WebcamTopologyTransitionInput {
        guard let roomId = webcamReceiverCapacityRoomId else {
            return WebcamTopologyTransitionInput(
                nowMonotonicMs: nowMonotonicMs,
                producerId: videoProducer?.id,
                producerTopology: webcamProducerTopology,
                hardSingleReceiverConditionsMet: false,
                sourceProofActive: false,
                sourceRevocationReason: nil,
                replacementOffer: nil,
                successorProof: nil,
                currentSingleProofActive: false,
                currentSingleProofRevocationReason: nil
            )
        }

        let producerId = videoProducer?.id
        let sourceProducerId = webcamTopologyTransitionState.fromProducerId ?? producerId
        let sourceProof = webcamReceiverCapacityProofCache.activeProof(
            roomId: roomId,
            producerId: sourceProducerId,
            nowMonotonicMs: nowMonotonicMs
        )
        let currentProof = webcamReceiverCapacityProofCache.activeProof(
            roomId: roomId,
            producerId: producerId,
            nowMonotonicMs: nowMonotonicMs
        )
        let successorProof: ActiveWebcamReceiverCapacityProof?
        if let fromProducerId = webcamTopologyTransitionState.fromProducerId,
           let nonce = webcamTopologyTransitionState.nonce {
            successorProof = webcamReceiverCapacityProofCache.stagedSuccessor(
                roomId: roomId,
                fromProducerId: fromProducerId,
                nonce: nonce,
                nowMonotonicMs: nowMonotonicMs
            )
        } else {
            successorProof = nil
        }
        let currentTransitionProofMatches =
            currentProof?.basis == .singleLayerTransition &&
            currentProof?.replacesProducerId == webcamTopologyTransitionState.fromProducerId &&
            currentProof?.transitionNonce == webcamTopologyTransitionState.nonce
        let currentSingleProofActive =
            currentProof?.basis == .singleLayer || currentTransitionProofMatches

        return WebcamTopologyTransitionInput(
            nowMonotonicMs: nowMonotonicMs,
            producerId: producerId,
            producerTopology: webcamProducerTopology,
            hardSingleReceiverConditionsMet: hardSingleReceiverConditionsMet,
            sourceProofActive: sourceProof?.basis == .simulcastFullLayer,
            sourceRevocationReason: webcamReceiverCapacityProofCache.revocation(
                roomId: roomId,
                producerId: sourceProducerId
            )?.reason,
            replacementOffer: sourceProof?.basis == .simulcastFullLayer
                ? sourceProof?.replacementOffer
                : nil,
            successorProof: successorProof,
            currentSingleProofActive: currentSingleProofActive,
            currentSingleProofRevocationReason: webcamReceiverCapacityProofCache.revocation(
                roomId: roomId,
                producerId: producerId
            )?.reason
        )
    }

    private func evaluateWebcamTopologyTransition(
        nowMonotonicMs suppliedNowMonotonicMs: Double? = nil
    ) {
        let nowMonotonicMs = suppliedNowMonotonicMs ?? Self.webcamTopologyMonotonicMs()
        guard webcamReceiverCapacityRoomId != nil else {
            webcamTopologyWakeTask?.cancel()
            webcamTopologyWakeTask = nil
            return
        }
        let input = webcamTopologyTransitionInput(nowMonotonicMs: nowMonotonicMs)
        let step = WebcamTopologyTransitionMachine.advance(
            state: webcamTopologyTransitionState,
            input: input
        )
        webcamTopologyTransitionState = step.state
        if let command = step.command {
            enqueueWebcamTopologyCommand(command)
        }
        scheduleWebcamTopologyWake(nowMonotonicMs: nowMonotonicMs)
    }

    private func scheduleWebcamTopologyWake(nowMonotonicMs: Double) {
        webcamTopologyWakeTask?.cancel()
        webcamTopologyWakeTask = nil

        let input = webcamTopologyTransitionInput(nowMonotonicMs: nowMonotonicMs)
        let currentSingleProofExpiresAtMonotonicMs: Double?
        if let roomId = webcamReceiverCapacityRoomId,
           let proof = webcamReceiverCapacityProofCache.activeProof(
                roomId: roomId,
                producerId: videoProducer?.id,
                nowMonotonicMs: nowMonotonicMs
           ) {
            currentSingleProofExpiresAtMonotonicMs = proof.expiresAtMonotonicMs
        } else {
            currentSingleProofExpiresAtMonotonicMs = nil
        }

        guard let dueAt = WebcamTopologyWakePolicy.nextWakeAt(
            state: webcamTopologyTransitionState,
            input: input,
            currentSingleProofExpiresAtMonotonicMs: currentSingleProofExpiresAtMonotonicMs
        ) else { return }
        let generation = webcamTopologyControlGeneration
        let delayMs = max(1.0, dueAt - nowMonotonicMs)
        webcamTopologyWakeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delayMs * 1_000_000.0))
            guard let self,
                  !Task.isCancelled,
                  self.webcamTopologyControlGeneration == generation else { return }
            self.webcamTopologyWakeTask = nil
            self.evaluateWebcamTopologyTransition()
        }
    }

    private func enqueueWebcamTopologyCommand(
        _ command: WebcamTopologyReplacementCommand
    ) {
        pendingWebcamTopologyCommand = WebcamTopologyTransitionMachine.latestPending(
            pendingWebcamTopologyCommand,
            command
        )
        guard webcamTopologyCommandTask == nil else { return }
        let generation = webcamTopologyControlGeneration
        webcamTopologyCommandTask = Task { @MainActor [weak self] in
            await self?.drainWebcamTopologyCommands(generation: generation)
        }
    }

    private func drainWebcamTopologyCommands(generation: Int) async {
        while let command = pendingWebcamTopologyCommand {
            guard !Task.isCancelled,
                  webcamTopologyControlGeneration == generation else { break }
            pendingWebcamTopologyCommand = nil
            let result = await applyWebcamTopologyReplacement(
                command,
                topologyGeneration: generation
            )
            guard !Task.isCancelled,
                  webcamTopologyControlGeneration == generation else { break }
            let now = Self.webcamTopologyMonotonicMs()
            let step = WebcamTopologyTransitionMachine.settle(
                state: webcamTopologyTransitionState,
                command: command,
                result: result,
                input: webcamTopologyTransitionInput(nowMonotonicMs: now)
            )
            webcamTopologyTransitionState = step.state
            if let command = step.command {
                pendingWebcamTopologyCommand = WebcamTopologyTransitionMachine.latestPending(
                    pendingWebcamTopologyCommand,
                    command
                )
            }
            scheduleWebcamTopologyWake(nowMonotonicMs: now)
        }
        guard webcamTopologyControlGeneration == generation else { return }
        webcamTopologyCommandTask = nil
        if pendingWebcamTopologyCommand != nil {
            let command = pendingWebcamTopologyCommand
            pendingWebcamTopologyCommand = nil
            if let command { enqueueWebcamTopologyCommand(command) }
        }
    }

    private func applyWebcamTopologyReplacement(
        _ command: WebcamTopologyReplacementCommand,
        topologyGeneration: Int
    ) async -> WebcamTopologyReplacementResult {
        let targetTopology: WebcamProducerTopology = command.target == .singleReceiver
            ? .vp8SingleLayer
            : .vp8Simulcast
        guard let oldProducer = videoProducer,
              oldProducer.id == command.expectedProducerId else {
            if videoProducer?.id == command.expectedProducerId,
               webcamProducerTopology == targetTopology {
                return WebcamTopologyReplacementResult(
                    status: .noop,
                    producerId: videoProducer?.id,
                    topology: webcamProducerTopology,
                    retryable: false,
                    ambiguousOrPostCommit: false
                )
            }
            return WebcamTopologyReplacementResult(
                status: .failed,
                producerId: videoProducer?.id,
                topology: webcamProducerTopology,
                retryable: true,
                ambiguousOrPostCommit: false
            )
        }
        if webcamProducerTopology == targetTopology && !command.forceReplacement {
            return WebcamTopologyReplacementResult(
                status: .noop,
                producerId: oldProducer.id,
                topology: webcamProducerTopology,
                retryable: false,
                ambiguousOrPostCommit: false
            )
        }
        guard let socketManager,
              let sendTransport,
              !sendTransport.closed,
              let track = rtcLocalVideoTrack,
              track.isEnabled,
              localVideoEnabled else {
            return WebcamTopologyReplacementResult(
                status: .failed,
                producerId: oldProducer.id,
                topology: webcamProducerTopology,
                retryable: true,
                ambiguousOrPostCommit: false
            )
        }
        if command.target == .singleReceiver {
            guard command.transition?.fromProducerId == oldProducer.id,
                  command.transition?.nonce.isEmpty == false else {
                return WebcamTopologyReplacementResult(
                    status: .failed,
                    producerId: oldProducer.id,
                    topology: webcamProducerTopology,
                    retryable: false,
                    ambiguousOrPostCommit: false
                )
            }
        }

        let configurationGeneration = self.configurationGeneration
        var pendingProducer: Producer?
        lastWebcamProducerSignalingError = nil
        do {
            let appData = try encodeJSONString(
                ProducerAppData(
                    type: ProducerType.webcam.rawValue,
                    paused: false,
                    webcamReceiverCapacityTransition: command.target == .singleReceiver
                        ? command.transition
                        : nil
                )
            )
            if intentionalLocalVideoProducerCloseIds.count >= 32 {
                intentionalLocalVideoProducerCloseIds.removeAll()
            }
            // Must precede createProducer: server replacement can broadcast the
            // predecessor close before the callback returns its successor id.
            intentionalLocalVideoProducerCloseIds.insert(oldProducer.id)
            let producer = try requireRegisteredProducer(
                sendTransport.createProducer(
                    for: track,
                    encodings: command.target == .singleReceiver
                        ? webcamSingleReceiverEncodings()
                        : restoredAdaptiveWebcamEncodings(),
                    codecOptions: try webcamVideoCodecOptionsJSON(
                        quality: .standard,
                        connectionQuality: .good
                    ),
                    codec: preferredVideoCodecJSON(),
                    appData: appData
                ),
                label: command.target == .singleReceiver
                    ? "single-receiver camera"
                    : "adaptive camera recovery"
            )
            pendingProducer = producer
            producer.delegate = self
            producer.resume()
            if targetTopology == .vp8Simulcast {
                try? producer.setMaxSpatialLayer(2)
            }

            guard self.webcamTopologyControlGeneration == topologyGeneration,
                  self.configurationGeneration == configurationGeneration,
                  self.sendTransport?.id == sendTransport.id,
                  self.rtcLocalVideoTrack === track,
                  track.isEnabled,
                  localVideoEnabled else {
                throw WebRTCError.staleConfiguration
            }

            // Commit successor first. Any queued predecessor notification now
            // cannot clear this producer even if its intentional marker was used.
            videoProducer = producer
            webcamProducerTopology = targetTopology
            localVideoTrack = VideoTrackWrapper(
                id: producer.id,
                userId: "local",
                isLocal: true,
                track: track
            )
            pendingProducer = nil

            do {
                try await socketManager.closeProducer(producerId: oldProducer.id)
            } catch {
                debugLog("[WebRTC] Predecessor camera close after topology handoff: \(error)")
            }
            oldProducer.close()
            lastAppliedLocalBandwidthSignature = nil
            return WebcamTopologyReplacementResult(
                status: .applied,
                producerId: producer.id,
                topology: targetTopology,
                retryable: false,
                ambiguousOrPostCommit: false
            )
        } catch {
            if let pendingProducer {
                do {
                    try await socketManager.closeProducer(producerId: pendingProducer.id)
                } catch {
                    debugLog("[WebRTC] Failed to close uncommitted topology producer: \(error)")
                }
                pendingProducer.close()
            }
            let signalingError = lastWebcamProducerSignalingError ?? error
            let ambiguous = pendingProducer != nil || isAmbiguousWebcamTopologyError(signalingError)
            if !ambiguous {
                intentionalLocalVideoProducerCloseIds.remove(oldProducer.id)
            }
            return WebcamTopologyReplacementResult(
                status: .failed,
                producerId: videoProducer?.id,
                topology: webcamProducerTopology,
                retryable: ambiguous,
                ambiguousOrPostCommit: ambiguous
            )
        }
    }

    private func isAmbiguousWebcamTopologyError(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        let definitiveRejections = [
            "invalid webcam receiver-capacity transition",
            "codec policy changed",
            "transition invalid",
            "transition expired",
            "transition already used",
            "producer not current"
        ]
        return !definitiveRejections.contains { message.contains($0) }
    }

    func updateVideoQuality(_ quality: VideoQuality) {
        currentVideoQuality = quality
        evaluateWebcamTopologyTransition()
        lastAppliedLocalBandwidthSignature = nil
        applyLocalBandwidthProfile(connectionQuality: currentLocalBandwidthQuality)
    }

    func applyLocalBandwidthProfile(connectionQuality: ConnectionQuality) {
        let signature = "\(currentVideoQuality.rawValue):\(connectionQuality.rawValue)"
        guard lastAppliedLocalBandwidthSignature != signature else { return }
        currentLocalBandwidthQuality = connectionQuality
        lastAppliedLocalBandwidthSignature = signature
        evaluateWebcamTopologyTransition()

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

        if let producer = videoProducer,
           webcamProducerTopology != .vp8SingleLayer {
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
                        encodings[index].numTemporalLayers = WebcamTemporalLayerPolicy.temporalLayerCount
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

        let publishTransportQuality = hasPublishStats ? RTCConnectionQualityPolicy.transportQuality(
            rttMs: publish.rttMs,
            packetLoss: publishPacketLoss,
            jitterMs: publish.jitterMs
        ) : .unknown
        let publishMediaPressureQuality = hasPublishStats ? RTCConnectionQualityPolicy.publishMediaPressureQuality(
            packetLoss: publishPacketLoss,
            jitterMs: publish.jitterMs
        ) : .unknown
        let receiveTransportQuality = hasReceiveStats ? RTCConnectionQualityPolicy.transportQuality(
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
            publishMediaPressureQuality,
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
            overallQuality: Self.worstConnectionQuality(
                publishTransportQuality,
                publishQuality,
                receiveQuality
            ),
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
        for (consumerId, info) in consumers where
            info.kind == "video" && info.lifecycleRole.acceptsPeriodicControls {
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

    func cleanup(
        notifyLocalState: Bool = true,
        preserveCallAudioRouting: Bool = false
    ) async {
        configurationGeneration += 1
        let consumerResetTask = plannedConsumerResetCoordinatorTask
        consumerResetTask?.cancel()
        await consumerResetTask?.value
        plannedConsumerResetCoordinatorTask = nil
        plannedConsumerResetCoordinatorOwnerToken = nil
        plannedConsumerResetActiveOwnerToken = nil
        plannedConsumerResetActivePredecessorId = nil
        plannedConsumerResetCandidates.removeAll()
        activeConsumerResetRoomId = nil
        activeConsumerResetLifecycleGeneration = nil
        resetWebcamTopologyControl()
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
        for identity in Array(firstDecodedVideoFrameSignals.keys) {
            cancelFirstDecodedVideoFrameObservation(identity: identity)
        }
        consumers.removeAll()
        remoteProducerClosureGenerations.removeAll()
        videoFreezeStats.removeAll()
        remoteConsumerPreferenceSignatures.removeAll()
        remoteConsumerLayerPreferenceUnsupportedIds.removeAll()
        remoteConsumerPreferenceInFlightIds.removeAll()
        remoteConsumerPreferenceRetryTask?.cancel()
        remoteConsumerPreferenceRetryTask = nil
        remoteConsumerPreferencePolicyRevision += 1
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

        if !preserveCallAudioRouting {
            try? audioSession.setActive(false)
        }

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
                    paused: appDataPayload?.paused ?? false,
                    webcamReceiverCapacityTransition: appDataPayload?.webcamReceiverCapacityTransition
                )
                callback(producerId)
            } catch {
                if kind == .video,
                   (try? self.decodeJSONString(appData, as: ProducerAppData.self))?.type == ProducerType.webcam.rawValue {
                    self.lastWebcamProducerSignalingError = error
                }
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
                self.resetWebcamTopologyControl()
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
                self.evaluateWebcamTopologyTransition()
            }
        }
    }

    nonisolated func onTransportClose(in consumer: Consumer) {
        Task { @MainActor in
            let entry = self.consumers.first { $0.value.consumer === consumer }
            if let entry {
                self.removeConsumer(
                    consumerId: entry.key,
                    info: entry.value,
                    closeConsumer: false,
                    notifyServer: false
                )
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
            evaluateWebcamTopologyTransition()

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
        evaluateWebcamTopologyTransition()
        
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
