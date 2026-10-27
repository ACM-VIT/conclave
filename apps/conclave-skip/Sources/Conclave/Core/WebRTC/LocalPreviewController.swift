import Foundation
#if os(iOS) && !SKIP
import AVFoundation
#endif

// ENT-3 (S10 0.5 "Preview capture" row, 6 k, Q16; S60 0.8 C6-8; RECONCILE R22): the one WP3 local camera preview
// owner, shared by the lobby card, the S60 Settings preview and the promotion lobby. Screens never own capture: they
// ask for it through the premeeting presenter's hooks and draw the platform surface (`LocalPreviewSurface`).
//
// Publish latch: the preview is local only and never handed to a producer. It has no track, no capturer and no
// producer API; frames go to the preview layer alone. When the call takes the camera (`handOffToCall()`, or Android's
// WebRTC client releasing the CameraX preview) the latch closes: the capture stops, the layer keeps its last frame as
// the hand-off still (Q16 option B) and nothing restarts the preview until `resetLatch()` (a new lobby after the
// call). The state machine is `LocalPreviewPolicy` (shared, host-tested).
//
// On Android `Skip/LocalPreviewController.kt` replaces this file's transpiled output (same base name): it implements
// the same members with CameraX. Keep the member names and labels identical on both sides, and keep every other
// type out of this file (the Kotlin file would hide it).
//
// STG-3 (S20 SC8, S60 C6-2, S20 6 f): the controller is also the one owner of the camera facing and of the call
// camera's system pause. The call's camera reports its facing after a flip or a start (`adoptCallFacing(_:)`) and its
// interruptions (`noteCallCameraInterruption(_:)`, iOS from the capture session notifications here, Android from the
// WebRTC client's camera events); `onCallCameraChange` tells the core, which mirrors both into `MeetingState` once so
// the stage's mirror, its flip value, the "Camera paused" caption and the Settings facing control change in one publish.
// None of this starts, stops or restarts a capture while the latch is closed.

@MainActor
final class LocalPreviewController {
    static let shared = LocalPreviewController()

    /// Called on the main actor after every state, session or facing change (the production wiring pushes it to the
    /// premeeting presenter).
    var onChange: (() -> Void)? = nil
    /// STG-3: called on the main actor after the facing or the call camera's pause changes (the core mirrors both into
    /// `MeetingState`, S20 SC8, S60 C6-2).
    var onCallCameraChange: (() -> Void)? = nil

    private(set) var machine = LocalPreviewMachine.initial
    private(set) var facing: LocalCameraFacing = .front
    /// Debug counters for the renderer and latch checks (S10 6 l7, l13; S60 C6-8 "zero producerCreate").
    private(set) var startCount = 0
    private(set) var stopCount = 0
    private(set) var handOffCount = 0

    var state: PreviewState { machine.state }
    var sessionId: Int { machine.sessionId }
    var isPublishLatched: Bool { machine.isLatched }
    var interruption: PreviewInterruption { machine.interruption }

    /// STG-3 (S20 6 f): why the system holds the call's camera right now; none while it runs.
    private(set) var callCameraInterruption: PreviewInterruption = .none
    var isCallCameraPaused: Bool { LocalCameraPublication.isPaused(callCameraInterruption) }

    #if os(iOS) && !SKIP
    /// The capture session the iOS preview surface attaches its layer to. Configured and run on `sessionQueue`.
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

    // MARK: - Requests from the lobby

    /// Starts the preview with this facing (no-op while latched, starting or live with the same facing).
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

    /// Front to back and back (S20 SC8 is the same delta, implemented once here).
    func flip() {
        facing = facing.next
        if LocalPreviewPolicy.mayCapture(machine) {
            restartCapture()
        }
        publish()
        onCallCameraChange?()
    }

    // MARK: - The call's camera (STG-3: S20 SC8, S60 C6-2, S20 6 f)

    /// The call's camera reports the facing it resolved after a flip or a start, so the lobby after the call, the
    /// Settings preview and the stage all read one facing. Equal reports publish nothing. While the latch is closed the
    /// capture is untouched; an open, running preview follows the new facing.
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

    /// The system took (or, with `.none`, returned) the call's camera. Main actor; equal reports publish nothing.
    func noteCallCameraInterruption(_ reason: PreviewInterruption) {
        guard reason != callCameraInterruption else { return }
        callCameraInterruption = reason
        onCallCameraChange?()
    }

    func noteCallCameraResumed() {
        noteCallCameraInterruption(.none)
    }

    /// The call ended or your camera turned off: no pause carries into the next call or the next camera start.
    func resetCallCamera() {
        noteCallCameraInterruption(.none)
    }

    /// The publish latch closes: the call owns the camera. The capture stops; the layer keeps its last frame.
    func handOffToCall() {
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

    /// A new lobby after the call: the latch reopens and the preview may start again.
    func resetLatch() {
        let next = LocalPreviewPolicy.next(machine, event: .resetLatch)
        guard next != machine else { return }
        machine = next
        publish()
    }

    // MARK: - Private

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
                    // Stopped or handed off while configuring: never leave a capture running.
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

    /// STG-3 (S20 6 f): the call's camera is the other capture session (the WebRTC capturer's). Its interruptions
    /// (another app, Split View or Slide Over, the background) and their end reach `noteCallCameraInterruption(_:)`;
    /// this controller's own session is excluded. The core reads the pause only while your camera is on in a call and
    /// resets it when the call ends.
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
    // macOS host and the transpile pass: no capture device; a start reports the camera as unavailable.
    private func beginCapture() {
        apply(.failed)
    }

    private func endCapture() {
    }
    #endif
}
