//
//  ScreenCaptureManager.swift
//  Conclave
//
//  Coordinates whole-device screen sharing via a ReplayKit Broadcast Upload
//  Extension (NOT in-app RPScreenRecorder, which can only capture this app's own
//  window). Standing up an App-Group socket server, then presenting the system
//  broadcast picker, lets the user share ANY app / their whole screen - the
//  extension streams JPEG frames back over the socket, which we decode and feed
//  into the WebRTC screen producer. Mirrors the working react-native-webrtc flow.
//
//  SYS-10 (S70 10 c, SY20): the start window is lifecycle-bound
//  (`ScreenShareStartPolicy`, replacing the single 12 s timer from presentation):
//  nothing times out while the system sheet is up; back in the app with no
//  extension `starting` within N s is a silent cancel; `starting` with no socket
//  connect within the 8 s grace is `extensionTimeout`. The capture phase
//  (choosing, starting) is reported to the view model, which publishes the
//  `ScreenShareSnapshot`.
//

#if SKIP
// The Android bridge is the handwritten Kotlin object `K/ScreenCaptureManager.kt` (it replaces this file's
// transpiled output); these declarations only let the view model's `#if SKIP` branch type-check.
enum ScreenCaptureManager {
    static var onProjectionRevoked: (() -> Void)?

    static func requestCapture() async -> Bool { fatalError() }
    static func isCaptureActive() -> Bool { fatalError() }
    static func stopCapture() { fatalError() }
    /// SYS-10 (S70 10 d): why the last `requestCapture()` returned false; `cancelled` is silent.
    static func lastStartFailure() -> ScreenShareFailure { fatalError() }
    /// SY23 (RECONCILE R43): whether this device can share device audio with a screen share.
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
    /// `ScreenShareBroadcastStopReason` raw value written with `stopRequestedAt`, so the extension's system alert
    /// says why the broadcast finished (S70 10 c, g).
    static let stopReason = "conclave.screenShare.lifecycle.stopReason"
}

enum ScreenCaptureReconnectPolicy {
    // The extension retries for six seconds. Leave enough room for scheduling
    // jitter when the main app transitions between foreground and background.
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

/// Coalesces ReplayKit frames before they cross onto the main queue. JPEG
/// decoding can outpace both the MainActor and WebRTC's encoder, especially
/// for portrait device frames. Keeping only the newest pending frame prevents
/// an unbounded queue of retained pixel buffers while preserving the freshest
/// screen contents.
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

/// Manages screen capture coordination between the broadcast extension and WebRTC.
@MainActor
final class ScreenCaptureManager: NSObject {
    static let shared = ScreenCaptureManager()

    // MARK: - Configuration
    private let appGroupIdentifier = "group.com.acmvit.conclave.screenshare"
    private let broadcastExtensionBundleId = "com.acmvit.conclave.ScreenShareExtension"
    private let publishFrameRateKey = "conclave.screenShare.maxFrameRate"
    private let publishMaxWidthKey = "conclave.screenShare.maxWidth"
    private let publishMaxHeightKey = "conclave.screenShare.maxHeight"
    private let publishMaxBitrateKey = "conclave.screenShare.maxBitrateBps"
    private let publishContentHintKey = "conclave.screenShare.contentHint"

    // MARK: - Publishers
    let isCapturing = CurrentValueSubject<Bool, Never>(false)
    let captureError = PassthroughSubject<Error, Never>()

    /// Invoked when the broadcast ends from OUTSIDE the app (Control Center /
    /// status bar / the extension's own timeout) so the meeting can tear down
    /// its producer and reset UI state. Set by MeetingViewModel.
    var onBroadcastStopped: (() -> Void)?

    /// SYS-10 (S70 10 j): the capture side of the phase, reported on transitions only: `choosing` once the system
    /// sheet was asked to present, `starting` at the extension's starting event (or its connect). The view model
    /// owns `live`, `stopping` and the end (after the producer, and with the stop source).
    var onCapturePhaseChanged: ((ScreenSharePhase) -> Void)?

    /// SY23 (RECONCILE R43): iOS keeps device audio off until the extension audio path passes a physical cell.
    var canShareDeviceAudio: Bool {
        ScreenShareCapabilityPolicy.current(platform: ScreenSharePlatform.ios, apiLevel: 0)
    }

    // MARK: - Properties
    private weak var webRTCClient: WebRTCClient?
    private var server: ScreenShareSocketServer?
    private var connected = false
    private var hasConnectedInCurrentCapture = false
    private var startGeneration = 0
    private var pendingStartContinuation: CheckedContinuation<Void, Error>?
    /// S70 10 c: the lifecycle-bound start window and the task that evaluates it while a start is pending.
    private var startWindow = ScreenShareStartWindow.closed
    private var startWindowTask: Task<Void, Never>?
    /// Epoch seconds of the presentation: the extension's lifecycle bus counts only when written after it.
    private var presentedAtEpochSeconds: Double = 0
    /// The controller presented over the call before the picker was tapped (nil for none), so a newly presented
    /// system sheet reads as "the system UI is up" even if the scene never resigns active.
    private var baselinePresentedController: ObjectIdentifier?
    private var reconnectGraceTask: Task<Void, Never>?
    private let frameGate = ScreenShareFrameRateGate()
    private let framePump = ScreenShareLatestFramePump()
    private var publishMaxFrameRate = 24.0
    private var publishMaxWidth = 3_840
    private var publishMaxHeight = 2_160
    private var publishMaxBitrateBps = 2_500_000
    private var publishContentHint = NativeScreenShareContentHint.detail.rawValue

    // MARK: - Public Methods

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

    /// Stand up the socket server and present the system broadcast picker. The
    /// share becomes live once the user confirms the picker and the extension
    /// connects (frames then flow in via the server). Returns only after that
    /// connection is established, so callers do not mark the meeting as
    /// sharing when the user cancels the system sheet.
    ///
    /// Throws `ScreenCaptureError.cancelled` for a silent cancel (the sheet was closed, a newer start or stop, task
    /// cancellation), and `ScreenShareStartError` for the S70 10 f failures that show one toast (`deniedBySystem`,
    /// `notConfigured` without the picker's button, `extensionTimeout`).
    func startCapture(webRTCClient: WebRTCClient) async throws {
        if server != nil {
            await stopCapture()
        }

        // S70 10 f: a Screen Time or MDM block (the view model normally hides Share with the unsupported reason).
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

                // S70 10 c: the guarded programmatic path. Without the picker's inner button the start fails with
                // notConfigured (one toast, diagnostics code) instead of waiting on a sheet that never shows.
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

    /// Tear down from the app side (the in-app Share toggle). The stop request on the lifecycle bus makes the
    /// extension finish with "Screen sharing stopped." (S70 10 c, g); closing the socket backs it up.
    func stopCapture() async {
        requestBroadcastStop(reason: ScreenShareBroadcastStopReason.person)
        tearDownCapture()
        finishPendingStart(.failure(ScreenCaptureError.cancelled))
    }

    /// Reconcile the app's in-memory state with the extension-owned lifecycle
    /// record whenever iOS moves the app between foreground and background.
    /// Socket callbacks remain authoritative while connected; the shared record
    /// covers extension termination while the app was suspended.
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

    /// SYS-10: the typed failure behind an error `startCapture` threw, for the view model's toast rule (S70 10 f).
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

    // MARK: - Private

    /// Everything a stop, an external stop, a cancel and a failed start share: invalidate the generation, stop the
    /// timers, the socket server and the frame path, close the start window.
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
        tearDownCapture()
        finishPendingStart(.failure(ScreenCaptureError.cancelled))
    }

    /// A start that will show one toast. `stopReason` asks a broadcast that did start to finish with the matching
    /// system alert text.
    private func failPendingStart(generation: Int, failure: ScreenShareFailure,
                                  stopReason: ScreenShareBroadcastStopReason?) {
        guard startGeneration == generation,
              pendingStartContinuation != nil else { return }
        if let stopReason {
            requestBroadcastStop(reason: stopReason)
        }
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

    // MARK: - Start window (S70 10 c)

    private func openStartWindow(generation: Int) {
        startWindowTask?.cancel()
        presentedAtEpochSeconds = Date().timeIntervalSince1970
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

    /// Reads the extension's lifecycle bus and the system UI, then acts on the policy's decision. Returns true once
    /// the start reached a terminal decision (the socket connect finishes a live start itself).
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
            // The person closed the sheet (or stopped the broadcast before it connected): no toast.
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

    /// The system UI is up while the scene is not active (the sheet, Control Center, the app in the background) or
    /// while a controller that was not there before the tap is presented over the call. [Unverified on device:
    /// whether the broadcast sheet resigns the scene or presents in process; either signal holds the window.]
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

    // MARK: - Reconnect grace

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
        guard server != nil,
              let defaults = UserDefaults(suiteName: appGroupIdentifier) else { return }
        // The reason first: the extension reads it once it sees the newer stop request.
        defaults.set(reason.rawValue, forKey: ScreenShareLifecycleBusKeys.stopReason)
        defaults.set(Date().timeIntervalSince1970, forKey: ScreenShareLifecycleBusKeys.stopRequestedAt)
    }

    // MARK: - Picker

    /// Presents the system broadcast sheet through a throwaway `RPSystemBroadcastPickerView` (iPhone: Share Screen is
    /// a More item and cannot host the picker itself). Returns false when the picker has no inner button to tap.
    private func presentBroadcastPicker() -> Bool {
        guard let window = Self.keyWindow else { return false }
        let picker = RPSystemBroadcastPickerView(
            frame: CGRect(x: 0, y: 0, width: 1, height: 1)
        )
        picker.preferredExtension = broadcastExtensionBundleId
        picker.showsMicrophoneButton = false

        // The picker must be in the view hierarchy to present its system sheet.
        window.addSubview(picker)

        // The only private-hierarchy touch (CE P14), guarded by a runtime check that the button exists.
        guard let button = Self.firstButton(in: picker) else {
            picker.removeFromSuperview()
            return false
        }
        baselinePresentedController = Self.topPresentedController().map { ObjectIdentifier($0) }
        button.sendActions(for: .touchUpInside)

        // Remove the throwaway picker shortly after; the system sheet is its own
        // presentation and outlives this view.
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

// MARK: - Errors
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
