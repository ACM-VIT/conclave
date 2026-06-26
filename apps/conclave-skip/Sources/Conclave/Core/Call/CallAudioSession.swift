//  iOS audio-session lifecycle for an in-progress call: keeps .playAndRecord
//  active in the background and RE-ACTIVATES it after an interruption (an
//  incoming phone call, Siri, an alarm, another app grabbing audio). Without
//  this, audio stays dead after a competing interruption ends.
#if os(iOS) && !SKIP
import Foundation
import AVFoundation

@MainActor
final class CallAudioSession {
    static let shared = CallAudioSession()

    private var isObserving = false
    /// Set while a call is active so we only re-activate audio when in a call.
    private var isCallActive = false
    private var routeReassertionHandler: (() -> Void)?
    private var categoryOptionsProvider: (() -> AVAudioSession.CategoryOptions)?
    private var reactivationTask: Task<Void, Never>?

    private init() {}

    nonisolated static func voiceCallCategoryOptions(defaultToSpeaker: Bool = true) -> AVAudioSession.CategoryOptions {
        var options: AVAudioSession.CategoryOptions = [
            // Prefer HFP for headset microphones, but allow output-only
            // Bluetooth earphones to play call audio while the phone mic captures.
            .allowBluetoothHFP,
            .allowBluetoothA2DP
        ]
        if defaultToSpeaker {
            options.insert(.defaultToSpeaker)
        }
        return options
    }

    nonisolated static func voiceCallCategoryOptions(for session: AVAudioSession) -> AVAudioSession.CategoryOptions {
        voiceCallCategoryOptions(
            defaultToSpeaker: CallAudioRoutePolicy.shouldDefaultToSpeaker(
                selectedOutputId: nil,
                hasExternalOutputRoute: hasExternalCallAudioOutputRoute(in: session)
            )
        )
    }

    nonisolated static func hasExternalCallAudioOutputRoute(in session: AVAudioSession) -> Bool {
        let externalOutputPorts: Set<AVAudioSession.Port> = [
            .bluetoothHFP,
            .bluetoothA2DP,
            .headphones,
            .usbAudio,
            .carAudio
        ]
        return session.currentRoute.outputs.contains { externalOutputPorts.contains($0.portType) }
    }

    // MARK: - Lifecycle

    /// Begin a call's audio lifecycle: ensure the session is configured + active
    /// and start observing interruptions.
    func begin() {
        isCallActive = true
        activateSession()
        startObserving()
    }

    /// End the call's audio lifecycle.
    func end() {
        isCallActive = false
        reactivationTask?.cancel()
        reactivationTask = nil
        categoryOptionsProvider = nil
        routeReassertionHandler = nil
        stopObserving()
        deactivateSession()
    }

    /// Called by CallKit's didActivate — re-assert our configuration so the
    /// WebRTC audio unit runs against the right category/mode.
    func handleCallKitActivation() {
        guard isCallActive else { return }
        activateSession()
    }

    func setRouteReassertionHandler(_ handler: (() -> Void)?) {
        routeReassertionHandler = handler
    }

    func setCategoryOptionsProvider(_ provider: (() -> AVAudioSession.CategoryOptions)?) {
        categoryOptionsProvider = provider
    }

    // MARK: - Session

    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: categoryOptionsProvider?() ?? Self.voiceCallCategoryOptions()
            )
            try session.setActive(true)
            routeReassertionHandler?()
        } catch {
            debugLog("[CallAudio] activate failed: \(error.localizedDescription)")
        }
    }

    private func deactivateSession() {
        reactivationTask?.cancel()
        reactivationTask = nil
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            debugLog("[CallAudio] deactivate failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Interruption handling

    private func startObserving() {
        guard !isObserving else { return }
        isObserving = true
        let center = NotificationCenter.default
        center.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleMediaServicesReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification,
            object: nil
        )
    }

    private func stopObserving() {
        guard isObserving else { return }
        isObserving = false
        let center = NotificationCenter.default
        center.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
        center.removeObserver(self, name: AVAudioSession.routeChangeNotification, object: nil)
        center.removeObserver(self, name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            debugLog("[CallAudio] interruption began")
        case .ended:
            // The interruption ended — re-activate audio if the system says we
            // should resume (and we're still in a call).
            debugLog("[CallAudio] interruption ended")
            if let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                if options.contains(.shouldResume) {
                    scheduleActivationReassertion()
                }
            } else {
                // No options provided — best-effort re-activate while in a call.
                scheduleActivationReassertion()
            }
        @unknown default:
            break
        }
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        guard isCallActive else { return }
        if let reason = routeChangeReason(from: notification),
           reason == .categoryChange {
            return
        }
        scheduleActivationReassertion()
    }

    @objc private func handleMediaServicesReset(_ notification: Notification) {
        // The media server crashed and restarted — everything needs re-arming.
        guard isCallActive else { return }
        scheduleActivationReassertion()
    }

    private func scheduleActivationReassertion() {
        reactivationTask?.cancel()
        handleCallKitActivation()
        reactivationTask = Task { @MainActor [weak self] in
            for delay in [250_000_000, 1_000_000_000, 2_500_000_000] as [UInt64] {
                try? await Task.sleep(nanoseconds: delay)
                guard let self, self.isCallActive, !Task.isCancelled else { return }
                self.handleCallKitActivation()
            }
        }
    }

    private func routeChangeReason(from notification: Notification) -> AVAudioSession.RouteChangeReason? {
        guard let reasonValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt else {
            return nil
        }
        return AVAudioSession.RouteChangeReason(rawValue: reasonValue)
    }
}
#endif
