

#if SKIP

enum ScreenCaptureManager {
    static var onProjectionRevoked: (() -> Void)?

    static func requestCapture() async -> Bool { fatalError() }
    static func isCaptureActive() -> Bool { fatalError() }
    static func stopCapture() { fatalError() }

    static func lastStartFailure() -> ScreenShareFailure { fatalError() }

    static func canShareDeviceAudio() -> Bool { fatalError() }
}
#endif

#if canImport(UIKit) && !SKIP
import UIKit
import ReplayKit
import WebRTC
import Combine
#endif

enum ScreenShareBroadcastLifecycleState: String {
    case idle
    case starting
    case active
    case reconnecting
    case stopped
}

enum ScreenShareLifecycleBusKeys {
    static let state = "conclave.screenShare.lifecycle.state"
    static let updatedAt = "conclave.screenShare.lifecycle.updatedAt"
    static let stopRequestedAt = "conclave.screenShare.lifecycle.stopRequestedAt"

    static let stopReason = "conclave.screenShare.lifecycle.stopReason"

    static let attemptAt = "conclave.screenShare.lifecycle.attemptAt"
}

enum ScreenCaptureReconnectPolicy {

    static let graceNanoseconds = UInt64(8_000_000_000)

    static func shouldFinalizeDisconnect(
        generation: Int,
        currentGeneration: Int,
        hasServer: Bool,
        isConnected: Bool
    ) -> Bool {
        generation == currentGeneration && hasServer && !isConnected
    }
}

#if canImport(UIKit) && !SKIP

private final class ScreenShareFrameRateGate: @unchecked Sendable {
    private let lock = NSLock()
    private var minFrameIntervalNs: UInt64 = 41_666_666
    private var lastAcceptedFrameNs: UInt64 = 0

    func update(maxFrameRate: Double) {
        let clampedFrameRate = Swift.max(1.0, Swift.min(maxFrameRate, 60.0))
        let nextInterval = UInt64(1_000_000_000.0 / clampedFrameRate)
        lock.lock()
        minFrameIntervalNs = Swift.max(1, nextInterval)
        lastAcceptedFrameNs = 0
        lock.unlock()
    }

    func reset() {
        lock.lock()
        lastAcceptedFrameNs = 0
        lock.unlock()
    }

    func shouldAcceptFrame(
        nowNanoseconds: UInt64 = DispatchTime.now().uptimeNanoseconds
    ) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        if lastAcceptedFrameNs != 0,
           nowNanoseconds - lastAcceptedFrameNs < minFrameIntervalNs {
            return false
        }

        lastAcceptedFrameNs = nowNanoseconds
        return true
    }
}

private final class ScreenShareLatestFramePump: @unchecked Sendable {
    typealias Delivery = @MainActor @Sendable (ScreenFrameBox) -> Void

    private let lock = NSLock()
    private var pendingFrame: ScreenFrameBox?
    private var deliveryScheduled = false

    func enqueue(_ frame: ScreenFrameBox, delivery: @escaping Delivery) {
        lock.lock()
        pendingFrame = frame
        let shouldSchedule = !deliveryScheduled
        if shouldSchedule {
            deliveryScheduled = true
        }
        lock.unlock()

        if shouldSchedule {
            scheduleDrain(delivery: delivery)
        }
    }

    func reset() {
        lock.lock()
        pendingFrame = nil
        lock.unlock()
    }

    private func scheduleDrain(delivery: @escaping Delivery) {
        DispatchQueue.main.async { [weak self] in
            self?.drain(delivery: delivery)
        }
    }

    @MainActor
    private func drain(delivery: @escaping Delivery) {
        lock.lock()
        guard let frame = pendingFrame else {
            deliveryScheduled = false
            lock.unlock()
            return
        }
        pendingFrame = nil
        lock.unlock()

        delivery(frame)

        lock.lock()
        let shouldContinue = pendingFrame != nil
        if !shouldContinue {
            deliveryScheduled = false
        }
        lock.unlock()

        if shouldContinue {
            scheduleDrain(delivery: delivery)
        }
    }
}

@MainActor
final class ScreenCaptureManager: NSObject {
    static let shared = ScreenCaptureManager()

    private let appGroupIdentifier = "group.com.acmvit.conclave.screenshare"
    private let broadcastExtensionBundleId = "com.acmvit.conclave.ScreenShareExtension"
    private let publishFrameRateKey = "conclave.screenShare.maxFrameRate"
    private let publishMaxWidthKey = "conclave.screenShare.maxWidth"
    private let publishMaxHeightKey = "conclave.screenShare.maxHeight"
    private let publishMaxBitrateKey = "conclave.screenShare.maxBitrateBps"
    private let publishContentHintKey = "conclave.screenShare.contentHint"

    let isCapturing = CurrentValueSubject<Bool, Never>(false)
    let captureError = PassthroughSubject<Error, Never>()

    var onBroadcastStopped: (() -> Void)?

    var onCapturePhaseChanged: ((ScreenSharePhase) -> Void)?

    var canShareDeviceAudio: Bool {
        ScreenShareCapabilityPolicy.current(platform: ScreenSharePlatform.ios, apiLevel: 0)
    }

    private weak var webRTCClient: WebRTCClient?
    private var server: ScreenShareSocketServer?
    private var connected = false
    private var hasConnectedInCurrentCapture = false
    private var startGeneration = 0
    private var pendingStartContinuation: CheckedContinuation<Void, Error>?

    private var startWindow = ScreenShareStartWindow.closed
    private var startWindowTask: Task<Void, Never>?

    private var presentedAtEpochSeconds: Double = 0
    private var stopWrittenForCurrentAttempt = false

    private var baselinePresentedController: ObjectIdentifier?
    private var reconnectGraceTask: Task<Void, Never>?
    private let frameGate = ScreenShareFrameRateGate()
    private let framePump = ScreenShareLatestFramePump()
    private var publishMaxFrameRate = 24.0
    private var publishMaxWidth = 3_840
    private var publishMaxHeight = 2_160
    private var publishMaxBitrateBps = 2_500_000
    private var publishContentHint = NativeScreenShareContentHint.detail.rawValue

    var isCaptureActive: Bool {
        server != nil && (connected || reconnectGraceTask != nil)
    }

    func updateMaxFrameRate(_ maxFrameRate: Double) {
        updatePublishProfile(
            maxFrameRate: maxFrameRate,
            maxWidth: publishMaxWidth,
            maxHeight: publishMaxHeight,
            maxBitrateBps: publishMaxBitrateBps,
            contentHint: publishContentHint
        )
    }

    func updatePublishProfile(
        maxFrameRate: Double,
        maxWidth: Int,
        maxHeight: Int,
        maxBitrateBps: Int,
        contentHint: String
    ) {
        publishMaxFrameRate = max(1.0, min(maxFrameRate, 60.0))
        publishMaxWidth = max(320, min(maxWidth, 3_840))
        publishMaxHeight = max(180, min(maxHeight, 2_160))
        publishMaxBitrateBps = max(150_000, min(maxBitrateBps, 15_000_000))
        publishContentHint = contentHint
        frameGate.update(maxFrameRate: publishMaxFrameRate)
        server?.updateMaxResolution(width: publishMaxWidth, height: publishMaxHeight)

        if let defaults = UserDefaults(suiteName: appGroupIdentifier) {
            defaults.set(publishMaxFrameRate, forKey: publishFrameRateKey)
            defaults.set(publishMaxWidth, forKey: publishMaxWidthKey)
            defaults.set(publishMaxHeight, forKey: publishMaxHeightKey)
            defaults.set(publishMaxBitrateBps, forKey: publishMaxBitrateKey)
            defaults.set(publishContentHint, forKey: publishContentHintKey)
        }
    }

    func startCapture(webRTCClient: WebRTCClient) async throws {
        if server != nil {
            await stopCapture()
        }

        guard RPScreenRecorder.shared().isAvailable else {
            throw ScreenShareStartError(failure: ScreenShareFailure.deniedBySystem)
        }

        framePump.reset()
        self.webRTCClient = webRTCClient
        self.connected = false
        self.hasConnectedInCurrentCapture = false
        updatePublishProfile(
            maxFrameRate: webRTCClient.screenShareCaptureMaxFramerate,
            maxWidth: webRTCClient.screenShareCaptureMaxWidth,
            maxHeight: webRTCClient.screenShareCaptureMaxHeight,
            maxBitrateBps: publishMaxBitrateBps,
            contentHint: publishContentHint
        )
        startGeneration &+= 1
        let generation = startGeneration

        guard let server = ScreenShareSocketServer(appGroupIdentifier: appGroupIdentifier) else {
            throw ScreenCaptureError.appGroupUnavailable
        }
        server.updateMaxResolution(width: publishMaxWidth, height: publishMaxHeight)

        let started = server.start(
            onFrame: { [weak self] box in
                self?.framePump.enqueue(box) { [weak self] latestFrame in
                    guard self?.startGeneration == generation else { return }
                    self?.webRTCClient?.feedScreenFrame(latestFrame.frame)
                }
            },
            shouldDecodeFrame: { [frameGate] in
                frameGate.shouldAcceptFrame()
            },
            onConnect: { [weak self] in
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    guard self.startGeneration == generation,
                          self.server != nil else { return }
                    self.reconnectGraceTask?.cancel()
                    self.reconnectGraceTask = nil
                    self.connected = true
                    self.hasConnectedInCurrentCapture = true
                    self.applyStartEvent(ScreenShareStartEvent.connected, nowMs: Self.nowMs())
                    self.closeStartWindow()
                    self.isCapturing.send(true)
                    self.finishPendingStart(.success(()))
                }
            },
            onDisconnect: { [weak self] in
                DispatchQueue.main.async { [weak self] in
                    guard self?.startGeneration == generation else { return }
                    self?.scheduleReconnectGrace(generation: generation)
                }
            }
        )
        guard started else {
            server.stop()
            self.webRTCClient = nil
            frameGate.reset()
            throw ScreenCaptureError.socketUnavailable
        }
        self.server = server

        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pendingStartContinuation = continuation

                if Task.isCancelled {
                    cancelPendingStart(generation: generation)
                    return
                }

                guard presentBroadcastPicker() else {
                    failPendingStart(generation: generation, failure: ScreenShareFailure.notConfigured, stopReason: nil)
                    return
                }

                openStartWindow(generation: generation)
            }
        } onCancel: { [weak self] in
            Task { @MainActor in
                self?.cancelPendingStart(generation: generation)
            }
        }
    }

    func stopCapture() async {
        requestBroadcastStop(reason: ScreenShareBroadcastStopReason.person)
        tearDownCapture()
        finishPendingStart(.failure(ScreenCaptureError.cancelled))
    }

    func reconcileBroadcastLifecycle() {
        guard server != nil, pendingStartContinuation == nil else { return }
        switch persistedBroadcastState {
        case .idle, .stopped:
            handleExternalStop()
        case .starting, .active, .reconnecting:
            if connected {
                isCapturing.send(true)
            } else if reconnectGraceTask == nil {
                scheduleReconnectGrace(generation: startGeneration)
            }
        }
    }

    nonisolated static func failure(for error: Error) -> ScreenShareFailure {
        if let startError = error as? ScreenShareStartError {
            return startError.failure
        }
        if let captureError = error as? ScreenCaptureError {
            switch captureError {
            case .cancelled:
                return ScreenShareFailure.cancelled
            case .appGroupUnavailable, .socketUnavailable:
                return ScreenShareFailure.notConfigured
            }
        }
        return ScreenShareFailure.producerFailed
    }

    private func tearDownCapture() {
        startGeneration &+= 1
        closeStartWindow()
        reconnectGraceTask?.cancel()
        reconnectGraceTask = nil
        connected = false
        hasConnectedInCurrentCapture = false
        frameGate.reset()
        framePump.reset()
        server?.stop()
        server = nil
        webRTCClient = nil
        isCapturing.send(false)
    }

    private func handleExternalStop() {
        guard server != nil else { return }
        let hadConnected = hasConnectedInCurrentCapture
        tearDownCapture()
        finishPendingStart(.failure(ScreenCaptureError.cancelled))
        if hadConnected {
            onBroadcastStopped?()
        }
    }

    private func cancelPendingStart(generation: Int) {
        guard startGeneration == generation,
              pendingStartContinuation != nil else { return }
        requestBroadcastStop(reason: ScreenShareBroadcastStopReason.person)
        tearDownCapture()
        finishPendingStart(.failure(ScreenCaptureError.cancelled))
    }

    private func failPendingStart(generation: Int, failure: ScreenShareFailure,
                                  stopReason: ScreenShareBroadcastStopReason?) {
        guard startGeneration == generation,
              pendingStartContinuation != nil else { return }
        requestBroadcastStop(reason: stopReason ?? ScreenShareBroadcastStopReason.person)
        tearDownCapture()
        finishPendingStart(.failure(ScreenShareStartError(failure: failure)))
    }

    private func finishPendingStart(_ result: Result<Void, Error>) {
        guard let continuation = pendingStartContinuation else { return }
        pendingStartContinuation = nil
        if case .success = result {
            closeStartWindow()
        }
        switch result {
        case .success:
            continuation.resume()
        case .failure(let error):
            continuation.resume(throwing: error)
        }
    }

    private func openStartWindow(generation: Int) {
        startWindowTask?.cancel()
        presentedAtEpochSeconds = Date().timeIntervalSince1970
        stopWrittenForCurrentAttempt = false
        UserDefaults(suiteName: appGroupIdentifier)?.set(presentedAtEpochSeconds,
                                                         forKey: ScreenShareLifecycleBusKeys.attemptAt)
        startWindow = ScreenShareStartWindow.closed
        applyStartEvent(ScreenShareStartEvent.presented, nowMs: Self.nowMs())
        let pollNanoseconds = UInt64(ScreenShareStartPolicy.pollIntervalMs * 1_000_000.0)
        startWindowTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: pollNanoseconds)
                guard !Task.isCancelled, let self else { return }
                guard self.startGeneration == generation,
                      self.pendingStartContinuation != nil else { return }
                if self.evaluateStartWindow(generation: generation) { return }
            }
        }
    }

    private func closeStartWindow() {
        startWindowTask?.cancel()
        startWindowTask = nil
        startWindow = ScreenShareStartWindow.closed
        baselinePresentedController = nil
    }

    private func evaluateStartWindow(generation: Int) -> Bool {
        let now = Self.nowMs()
        readExtensionLifecycleBus(nowMs: now)
        readSystemUIVisibility(nowMs: now)
        switch ScreenShareStartPolicy.decision(startWindow, nowMs: now) {
        case .wait:
            return false
        case .live:
            return true
        case .cancelSilently:

            cancelPendingStart(generation: generation)
            return true
        case .extensionTimeout:
            failPendingStart(generation: generation, failure: ScreenShareFailure.extensionTimeout,
                             stopReason: ScreenShareBroadcastStopReason.startTimeout)
            return true
        }
    }

    private func applyStartEvent(_ event: ScreenShareStartEvent, nowMs: Double) {
        let previousPhase = ScreenShareStartPolicy.phase(startWindow)
        let next = ScreenShareStartPolicy.apply(event, to: startWindow, nowMs: nowMs)
        guard next != startWindow else { return }
        startWindow = next
        let phase = ScreenShareStartPolicy.phase(next)
        if phase != previousPhase && phase != ScreenSharePhase.idle {
            onCapturePhaseChanged?(phase)
        }
    }

    private func readExtensionLifecycleBus(nowMs: Double) {
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier) else { return }
        let updatedAt = defaults.double(forKey: ScreenShareLifecycleBusKeys.updatedAt)
        guard ScreenShareStartPolicy.busRecordIsCurrent(updatedAtSeconds: updatedAt,
                                                        presentedAtSeconds: presentedAtEpochSeconds),
              let rawValue = defaults.string(forKey: ScreenShareLifecycleBusKeys.state),
              let state = ScreenShareBroadcastLifecycleState(rawValue: rawValue) else { return }
        switch state {
        case .starting, .active, .reconnecting:
            applyStartEvent(ScreenShareStartEvent.extensionStarting, nowMs: nowMs)
        case .stopped:
            applyStartEvent(ScreenShareStartEvent.extensionStopped, nowMs: nowMs)
        case .idle:
            break
        }
    }

    private func readSystemUIVisibility(nowMs: Double) {
        let sceneIsActive = UIApplication.shared.applicationState == .active
        let presented = Self.topPresentedController().map { ObjectIdentifier($0) }
        let hasNewPresentation = presented != nil && presented != baselinePresentedController
        let visible = !sceneIsActive || hasNewPresentation
        if visible != startWindow.isSystemUIVisible {
            applyStartEvent(visible ? ScreenShareStartEvent.systemUIShown : ScreenShareStartEvent.systemUIHidden,
                            nowMs: nowMs)
        }
    }

    private static func nowMs() -> Double {
        Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000.0
    }

    private func scheduleReconnectGrace(generation: Int) {
        guard startGeneration == generation, server != nil else { return }
        connected = false
        reconnectGraceTask?.cancel()
        reconnectGraceTask = Task { @MainActor [weak self] in
            let pollInterval = UInt64(250_000_000)
            let pollCount = Int(ScreenCaptureReconnectPolicy.graceNanoseconds / pollInterval)
            for _ in 0..<pollCount {
                try? await Task.sleep(nanoseconds: pollInterval)
                guard !Task.isCancelled, let self else { return }
                if self.persistedBroadcastState == .stopped {
                    self.reconnectGraceTask = nil
                    self.handleExternalStop()
                    return
                }
                if self.connected { return }
            }
            guard !Task.isCancelled,
                  let self,
                  ScreenCaptureReconnectPolicy.shouldFinalizeDisconnect(
                    generation: generation,
                    currentGeneration: self.startGeneration,
                    hasServer: self.server != nil,
                    isConnected: self.connected
                  ) else { return }
            self.reconnectGraceTask = nil
            self.handleExternalStop()
        }
    }

    private var persistedBroadcastState: ScreenShareBroadcastLifecycleState {
        guard let rawValue = UserDefaults(suiteName: appGroupIdentifier)?
            .string(forKey: ScreenShareLifecycleBusKeys.state),
              let state = ScreenShareBroadcastLifecycleState(rawValue: rawValue) else {
            return .idle
        }
        return state
    }

    private func requestBroadcastStop(reason: ScreenShareBroadcastStopReason) {
        guard presentedAtEpochSeconds > 0,
              !stopWrittenForCurrentAttempt,
              let defaults = UserDefaults(suiteName: appGroupIdentifier) else { return }

        defaults.set(reason.rawValue, forKey: ScreenShareLifecycleBusKeys.stopReason)
        defaults.set(Date().timeIntervalSince1970, forKey: ScreenShareLifecycleBusKeys.stopRequestedAt)
        stopWrittenForCurrentAttempt = true
    }

    private func presentBroadcastPicker() -> Bool {
        guard let window = Self.keyWindow else { return false }
        let picker = RPSystemBroadcastPickerView(
            frame: CGRect(x: 0, y: 0, width: 1, height: 1)
        )
        picker.preferredExtension = broadcastExtensionBundleId
        picker.showsMicrophoneButton = false

        window.addSubview(picker)

        guard let button = Self.firstButton(in: picker) else {
            picker.removeFromSuperview()
            return false
        }
        baselinePresentedController = Self.topPresentedController().map { ObjectIdentifier($0) }
        button.sendActions(for: .touchUpInside)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            picker.removeFromSuperview()
        }
        return true
    }

    private static func firstButton(in view: UIView) -> UIButton? {
        for subview in view.subviews {
            if let button = subview as? UIButton {
                return button
            }
            if let nested = firstButton(in: subview) {
                return nested
            }
        }
        return nil
    }

    private static func topPresentedController() -> UIViewController? {
        var controller = keyWindow?.rootViewController?.presentedViewController
        while let next = controller?.presentedViewController {
            controller = next
        }
        return controller
    }

    private static var keyWindow: UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
            ?? UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }
                .first
    }
}

enum ScreenCaptureError: Error, LocalizedError, Equatable {
    case appGroupUnavailable
    case socketUnavailable
    case cancelled

    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            return "Screen sharing is not configured (App Group unavailable)."
        case .socketUnavailable:
            return "Could not start screen sharing. Please try again."
        case .cancelled:
            return "Screen sharing was cancelled."
        }
    }
}

#endif
