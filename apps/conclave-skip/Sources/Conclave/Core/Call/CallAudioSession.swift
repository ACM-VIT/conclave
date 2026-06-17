//
//  CallAudioSession.swift
//  Conclave
//
//  iOS audio-session lifecycle for an in-progress call: keeps .playAndRecord
//  active in the background and RE-ACTIVATES it after an interruption (an
//  incoming phone call, Siri, an alarm, another app grabbing audio). Without
//  this, audio stays dead after a competing interruption ends.
//

#if os(iOS) && !SKIP
import Foundation
import AVFoundation

@MainActor
final class CallAudioSession {
    static let shared = CallAudioSession()

    private var isObserving = false
    /// Set while a call is active so we only re-activate audio when in a call.
    private var isCallActive = false

    private init() {}

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
        stopObserving()
        deactivateSession()
    }

    /// Called by CallKit's didActivate — re-assert our configuration so the
    /// WebRTC audio unit runs against the right category/mode.
    func handleCallKitActivation() {
        guard isCallActive else { return }
        activateSession()
    }

    // MARK: - Session

    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.defaultToSpeaker, .allowBluetoothHFP]
            )
            try session.setActive(true)
        } catch {
            debugLog("[CallAudio] activate failed: \(error.localizedDescription)")
        }
    }

    private func deactivateSession() {
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
                    Task { @MainActor in self.handleCallKitActivation() }
                }
            } else {
                // No options provided — best-effort re-activate while in a call.
                Task { @MainActor in self.handleCallKitActivation() }
            }
        @unknown default:
            break
        }
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        // Headphones unplugged / Bluetooth disconnected etc. Re-assert the
        // session so audio keeps routing somewhere sane while in a call.
        guard isCallActive else { return }
        Task { @MainActor in self.handleCallKitActivation() }
    }

    @objc private func handleMediaServicesReset(_ notification: Notification) {
        // The media server crashed and restarted — everything needs re-arming.
        guard isCallActive else { return }
        Task { @MainActor in self.handleCallKitActivation() }
    }
}
#endif
