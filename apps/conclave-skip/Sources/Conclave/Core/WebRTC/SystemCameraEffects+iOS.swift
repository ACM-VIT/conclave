#if os(iOS) && !SKIP
import AVFoundation
import Foundation
import UIKit

// S60 0.8 C6-21 (SET-6, WP3 capture owner): the iOS system camera effects the Effects panel defers to (4 c, D22) and
// the Portrait and background blocks that keep a system effect and an app effect from stacking. It reads, never owns,
// the camera: the core attaches the camera the call captures from (`attach(facing:)`), and the owner publishes one
// `SystemCameraEffects` (shared, transpiled; all false on Android) through `onChange`. Per-device state is key-value
// observed (`isCenterStageActive`, `isPortraitEffectActive`, iOS 18 `isBackgroundReplacementActive`); the class
// settings a person changes in Control Center (`AVCaptureDevice.isCenterStageEnabled`, `isStudioLightEnabled`) are
// re-read whenever the app becomes active again, which is exactly when Control Center hands focus back, and after our
// own Center Stage write. Center Stage is written only under `centerStageControlMode = .cooperative`, so Control Center
// keeps working and its changes flow back into the switch (C6-21). Portrait and Studio Light apply to the WebRTC
// capture only with `NSCameraPortraitEffectEnabled` and `NSCameraStudioLightEnabled` in Darwin/Info.plist (HD request
// B7-T2 R8, forwarded by CTL-4 as HD/requests/B8-T6.md) [Unverified with the WebRTC capture path, S30 Q7]. CTL-4 (S30
// CC11) adds the two system modules: `showSystemVideoEffects()` ("Video Effects…" in More, the Camera shortcut and the
// Effects panel) and `showSystemMicrophoneModes()` ("Mic Mode…" in the Mic shortcut), both through
// `AVCaptureDevice.showSystemUserInterface(_:)` (iOS 15, non-blocking: it deep links into Control Center's module and
// returns at once), and `canShowSystemVideoEffects(isCaptureRunning:)`, which the core feeds into the controls and the
// Effects inputs so the video effects entry exists only while the call camera captures [Unverified with the WebRTC
// capture and the `.voiceChat` session; physical-device cell].

@MainActor
final class SystemCameraEffectsOwner {
    static let shared = SystemCameraEffectsOwner()

    /// The latest reading; `SystemCameraEffects.none` while no camera is attached.
    private(set) var snapshot: SystemCameraEffects = SystemCameraEffects.none
    /// Called on the main actor after the reading changed (the core refreshes the Effects inputs).
    var onChange: (() -> Void)? = nil
    /// Diagnostics: Center Stage writes made through the panel (S60 4 l8 on a device).
    private(set) var centerStageWriteCount = 0
    /// Diagnostics (CTL-4): the system modules opened through this owner (S30 2 l, physical-device cell).
    private(set) var videoEffectsShownCount = 0
    private(set) var microphoneModesShownCount = 0

    private var device: AVCaptureDevice? = nil
    private var observations: [NSKeyValueObservation] = []
    private var activationToken: NSObjectProtocol? = nil

    init() {}

    /// The core attaches the camera the call captures from after a start or a flip (the built-in wide-angle camera at
    /// that position, the same `AVCaptureDevice` instance the WebRTC capturer configures).
    func attach(facing: LocalCameraFacing) {
        let position: AVCaptureDevice.Position = facing == .front ? .front : .back
        attach(device: AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position))
    }

    func attach(device next: AVCaptureDevice?) {
        if next?.uniqueID == device?.uniqueID && (next == nil || !observations.isEmpty) {
            refresh()
            return
        }
        stopObserving()
        device = next
        if let next {
            observe(next)
        }
        refresh()
    }

    /// The call camera stopped (or the call ended): nothing to read.
    func detach() {
        stopObserving()
        device = nil
        refresh()
    }

    /// Re-reads the attached camera and the class settings; publishes only a change.
    func refresh() {
        let next = SystemCameraEffectsOwner.read(device)
        guard next != snapshot else { return }
        snapshot = next
        onChange?()
    }

    /// Center Stage on or off for a camera that supports it (cooperative control, C6-21).
    func setCenterStage(_ on: Bool) {
        guard snapshot.centerStageSupported else { return }
        if AVCaptureDevice.centerStageControlMode != .cooperative {
            AVCaptureDevice.centerStageControlMode = .cooperative
        }
        if AVCaptureDevice.isCenterStageEnabled != on {
            AVCaptureDevice.isCenterStageEnabled = on
            centerStageWriteCount += 1
        }
        refresh()
    }

    // MARK: System modules (S30 CC11, CTL-4)

    /// S30 CC11: the video effects module is offered only while the call camera captures. iOS 15 API, always available on
    /// the iOS 17 target, so the capture state is the whole gate.
    static func canShowSystemVideoEffects(isCaptureRunning: Bool) -> Bool {
        isCaptureRunning
    }

    /// Opens Control Center's Video Effects module (Center Stage, Portrait, Studio Light, reactions; S30 Q7, Q14).
    /// Returns at once; true when the request was made.
    @discardableResult
    func showSystemVideoEffects() -> Bool {
        AVCaptureDevice.showSystemUserInterface(.videoEffects)
        videoEffectsShownCount += 1
        return true
    }

    /// Opens Control Center's Mic Mode module (Standard, Voice Isolation, Wide Spectrum; S30 Q7). Returns at once; true when
    /// the request was made.
    @discardableResult
    func showSystemMicrophoneModes() -> Bool {
        AVCaptureDevice.showSystemUserInterface(.microphoneModes)
        microphoneModesShownCount += 1
        return true
    }

    /// The pure reading of one camera (nil reads as no effects).
    static func read(_ device: AVCaptureDevice?) -> SystemCameraEffects {
        guard let device else { return SystemCameraEffects.none }
        let format = device.activeFormat
        var backgroundReplacement = false
        if #available(iOS 18.0, *) {
            backgroundReplacement = device.isBackgroundReplacementActive
        }
        return SystemCameraEffects.make(
            centerStageSupported: format.isCenterStageSupported,
            centerStageOn: AVCaptureDevice.isCenterStageEnabled,
            studioLightSupported: format.isStudioLightSupported,
            studioLightOn: AVCaptureDevice.isStudioLightEnabled,
            portraitActive: device.isPortraitEffectActive,
            backgroundReplacementActive: backgroundReplacement
        )
    }

    // MARK: Observation

    private func observe(_ device: AVCaptureDevice) {
        let changed: @Sendable () -> Void = { [weak self] in
            Task { @MainActor in self?.refresh() }
        }
        observations.append(device.observe(\.isCenterStageActive, options: [.new]) { _, _ in changed() })
        observations.append(device.observe(\.isPortraitEffectActive, options: [.new]) { _, _ in changed() })
        observations.append(device.observe(\.activeFormat, options: [.new]) { _, _ in changed() })
        if #available(iOS 18.0, *) {
            observations.append(device.observe(\.isBackgroundReplacementActive, options: [.new]) { _, _ in changed() })
        }
        activationToken = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification,
                                                                 object: nil, queue: .main) { _ in changed() }
    }

    private func stopObserving() {
        for observation in observations {
            observation.invalidate()
        }
        observations = []
        if let token = activationToken {
            NotificationCenter.default.removeObserver(token)
            activationToken = nil
        }
    }
}
#endif
