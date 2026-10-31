import Foundation
#if os(iOS) && !SKIP
import AVFoundation
#endif

@MainActor
final class LocalPreviewController {
    static let shared = LocalPreviewController()

    var onChange: (() -> Void)? = nil

    var onCallCameraChange: (() -> Void)? = nil

    var onScopedPreviewChange: (() -> Void)? = nil

    private(set) var isScopedPreviewActive = false

    private(set) var scopedStartCount = 0
    private(set) var scopedStopCount = 0

    private(set) var mirrorsSelfView = true
    private var scopedReopenedLatch = false

    private(set) var machine = LocalPreviewMachine.initial
    private(set) var facing: LocalCameraFacing = .front

    private(set) var startCount = 0
    private(set) var stopCount = 0
    private(set) var handOffCount = 0

    var state: PreviewState { machine.state }
    var sessionId: Int { machine.sessionId }
    var isPublishLatched: Bool { machine.isLatched }
    var interruption: PreviewInterruption { machine.interruption }

    private(set) var callCameraInterruption: PreviewInterruption = .none
    var isCallCameraPaused: Bool { LocalCameraPublication.isPaused(callCameraInterruption) }

    #if os(iOS) && !SKIP

    let captureSession = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.acmvit.conclave.localPreview", qos: .userInitiated)
    private var captureGeneration = 0
    private var notificationTokens: [NSObjectProtocol] = []
    #endif

    init() {
        #if os(iOS) && !SKIP
        observeInterruptions()
        observeCallCaptureInterruptions()
        #endif
    }

    func start(facing requested: LocalCameraFacing) {
        let facingChanged = requested != facing
        facing = requested
        if facingChanged {
            onCallCameraChange?()
        }
        if machine.state == .live || machine.state == .starting || machine.state == .interrupted {
            if facingChanged {
                restartCapture()
            }
            return
        }
        let next = LocalPreviewPolicy.next(machine, event: .start)
        guard next != machine else { return }
        machine = next
        startCount += 1
        publish()
        beginCapture()
    }

    func stop() {
        let wasCapturing = LocalPreviewPolicy.mayCapture(machine)
        let next = LocalPreviewPolicy.next(machine, event: .stop)
        if next != machine {
            machine = next
            publish()
        }
        if wasCapturing {
            stopCount += 1
            endCapture()
        }
    }

    func flip() {
        facing = facing.next
        if LocalPreviewPolicy.mayCapture(machine) {
            restartCapture()
        }
        publish()
        onCallCameraChange?()
    }

    @discardableResult
    func adoptCallFacing(_ reported: LocalCameraFacing) -> Bool {
        guard LocalCameraPublication.publishes(current: facing, reported: reported) else { return false }
        facing = reported
        if LocalPreviewPolicy.mayCapture(machine) {
            restartCapture()
        }
        publish()
        onCallCameraChange?()
        return true
    }

    func noteCallCameraInterruption(_ reason: PreviewInterruption) {
        guard reason != callCameraInterruption else { return }
        callCameraInterruption = reason
        onCallCameraChange?()
    }

    func noteCallCameraResumed() {
        noteCallCameraInterruption(.none)
    }

    func resetCallCamera() {
        noteCallCameraInterruption(.none)
    }

    func startScopedPreview(facing requested: LocalCameraFacing) {
        if isScopedPreviewActive && LocalPreviewPolicy.mayCapture(machine) {
            if requested != facing {
                start(facing: requested)
            }
            return
        }
        if machine.isLatched {
            scopedReopenedLatch = true
            machine = LocalPreviewPolicy.next(machine, event: .resetLatch)
        } else {
            scopedReopenedLatch = false
        }
        isScopedPreviewActive = true
        scopedStartCount += 1
        start(facing: requested)
        publish()
    }

    func stopScopedPreview() {
        guard isScopedPreviewActive else { return }
        isScopedPreviewActive = false
        scopedStopCount += 1
        stop()
        if scopedReopenedLatch {
            scopedReopenedLatch = false
            machine = LocalPreviewPolicy.next(machine, event: .handOff)
        }
        publish()
    }

    func releaseScopedPreviewForCallCamera() {
        guard isScopedPreviewActive else { return }
        handOffToCall()
        publish()
    }

    func setMirrorPreference(_ on: Bool) {
        guard on != mirrorsSelfView else { return }
        mirrorsSelfView = on
        publish()
    }

    func handOffToCall() {
        isScopedPreviewActive = false
        scopedReopenedLatch = false
        let wasCapturing = LocalPreviewPolicy.mayCapture(machine)
        let next = LocalPreviewPolicy.next(machine, event: .handOff)
        guard next != machine || wasCapturing else { return }
        machine = next
        handOffCount += 1
        if wasCapturing {
            endCapture()
        }
        publish()
    }

    func resetLatch() {
        let next = LocalPreviewPolicy.next(machine, event: .resetLatch)
        guard next != machine else { return }
        machine = next
        publish()
    }

    private func apply(_ event: LocalPreviewEvent, interruption: PreviewInterruption = .none) {
        let next = LocalPreviewPolicy.next(machine, event: event, interruption: interruption)
        guard next != machine else { return }
        let wasCapturing = LocalPreviewPolicy.mayCapture(machine)
        machine = next
        if wasCapturing && !LocalPreviewPolicy.mayCapture(next) {
            endCapture()
        }
        publish()
    }

    private func publish() {
        onChange?()
        onScopedPreviewChange?()
    }

    private func restartCapture() {
        endCapture()
        beginCapture()
    }

    #if os(iOS) && !SKIP
    private func beginCapture() {
        captureGeneration += 1
        let generation = captureGeneration
        let session = captureSession
        let position: AVCaptureDevice.Position = facing == .front ? .front : .back
        let fallback: AVCaptureDevice.Position = facing == .front ? .back : .front
        sessionQueue.async { [weak self] in
            let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
                ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: fallback)
            var bound = false
            if let device, let input = try? AVCaptureDeviceInput(device: device) {
                session.beginConfiguration()
                session.sessionPreset = .medium
                for existing in session.inputs {
                    session.removeInput(existing)
                }
                if session.canAddInput(input) {
                    session.addInput(input)
                    bound = true
                }
                session.commitConfiguration()
                if bound && !session.isRunning {
                    session.startRunning()
                }
            }
            let resolvedFront = device?.position != .back
            Task { @MainActor in
                guard let self, self.captureGeneration == generation else { return }
                guard LocalPreviewPolicy.mayCapture(self.machine) else {

                    self.endCapture()
                    return
                }
                if bound {
                    let resolved = LocalCameraFacing.from(isFront: resolvedFront)
                    let facingChanged = LocalCameraPublication.publishes(current: self.facing, reported: resolved)
                    self.facing = resolved
                    self.apply(.bound)
                    if facingChanged {
                        self.onCallCameraChange?()
                    }
                } else {
                    self.apply(.failed)
                }
            }
        }
    }

    private func endCapture() {
        captureGeneration += 1
        let session = captureSession
        sessionQueue.async {
            if session.isRunning {
                session.stopRunning()
            }
        }
    }

    private func observeInterruptions() {
        let center = NotificationCenter.default
        notificationTokens.append(center.addObserver(forName: AVCaptureSession.wasInterruptedNotification,
                                                     object: captureSession, queue: .main) { [weak self] note in
            let raw = (note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? NSNumber)?.intValue ?? -1
            let reason = LocalPreviewController.previewInterruption(rawReason: raw)
            MainActor.assumeIsolated {
                self?.apply(.interrupted, interruption: reason)
            }
        })
        notificationTokens.append(center.addObserver(forName: AVCaptureSession.interruptionEndedNotification,
                                                     object: captureSession, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.apply(.interruptionEnded)
            }
        })
        notificationTokens.append(center.addObserver(forName: AVCaptureSession.runtimeErrorNotification,
                                                     object: captureSession, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.apply(.failed)
            }
        })
    }

    private func observeCallCaptureInterruptions() {
        let center = NotificationCenter.default
        let own = ObjectIdentifier(captureSession)
        notificationTokens.append(center.addObserver(forName: AVCaptureSession.wasInterruptedNotification,
                                                     object: nil, queue: .main) { [weak self] note in
            guard let session = note.object as? AVCaptureSession, ObjectIdentifier(session) != own else { return }
            let raw = (note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? NSNumber)?.intValue ?? -1
            let reason = LocalPreviewController.previewInterruption(rawReason: raw)
            MainActor.assumeIsolated {
                self?.noteCallCameraInterruption(reason)
            }
        })
        notificationTokens.append(center.addObserver(forName: AVCaptureSession.interruptionEndedNotification,
                                                     object: nil, queue: .main) { [weak self] note in
            guard let session = note.object as? AVCaptureSession, ObjectIdentifier(session) != own else { return }
            MainActor.assumeIsolated {
                self?.noteCallCameraResumed()
            }
        })
    }

    nonisolated private static func previewInterruption(rawReason: Int) -> PreviewInterruption {
        guard let reason = AVCaptureSession.InterruptionReason(rawValue: rawReason) else { return .cameraError }
        switch reason {
        case .videoDeviceInUseByAnotherClient:
            return .inUseByAnotherClient
        case .videoDeviceNotAvailableWithMultipleForegroundApps:
            return .multipleForegroundApps
        case .videoDeviceNotAvailableInBackground:
            return .background
        default:
            return .cameraError
        }
    }
    #else

    private func beginCapture() {
        apply(.failed)
    }

    private func endCapture() {
    }
    #endif
}
