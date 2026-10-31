#if os(iOS) && !SKIP
import AVFoundation
import Foundation
import UIKit

@MainActor
final class SystemCameraEffectsOwner {
    static let shared = SystemCameraEffectsOwner()

    private(set) var snapshot: SystemCameraEffects = SystemCameraEffects.none

    var onChange: (() -> Void)? = nil

    private(set) var centerStageWriteCount = 0

    private(set) var videoEffectsShownCount = 0
    private(set) var microphoneModesShownCount = 0

    private var device: AVCaptureDevice? = nil
    private var observations: [NSKeyValueObservation] = []
    private var activationToken: NSObjectProtocol? = nil

    init() {}

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

    func detach() {
        stopObserving()
        device = nil
        refresh()
    }

    func refresh() {
        let next = SystemCameraEffectsOwner.read(device)
        guard next != snapshot else { return }
        snapshot = next
        onChange?()
    }

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

    static func canShowSystemVideoEffects(isCaptureRunning: Bool) -> Bool {
        isCaptureRunning
    }

    @discardableResult
    func showSystemVideoEffects() -> Bool {
        AVCaptureDevice.showSystemUserInterface(.videoEffects)
        videoEffectsShownCount += 1
        return true
    }

    @discardableResult
    func showSystemMicrophoneModes() -> Bool {
        AVCaptureDevice.showSystemUserInterface(.microphoneModes)
        microphoneModesShownCount += 1
        return true
    }

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
