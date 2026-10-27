import Foundation

// S70 5 c and SX11 (SYS-2): who may activate the call audio session, and in which order the session owner runs its
// steps. Transpiled and host-tested (macOS and Robolectric), so String raw-value enums and arrays of them only; no
// platform import. `CallAudioSession` (iOS) executes the plans; Android has no CallKit, so every Android surface may
// activate (its mode and focus are owned by the route owner, S70 5 d).

/// Where an activation request comes from: every self-activation site S70 5 c lists at HEAD, plus the transition
/// that hands the call to the refused fallback.
enum AudioActivationSite: String, CaseIterable, Equatable {
    /// `CallAudioSession.begin()` from `activateCallPresence()` (join).
    case callBegin
    /// `WebRTCClient.configureCallAudioSession()`: microphone start, unmute, producer reassert, route selection,
    /// bandwidth refresh, the capture ladder and `activateCallAudioSession()` (join, foreground, healthy reassert).
    case webRTCConfigure
    /// `handleAppBecameActive()`.
    case foreground
    /// `handleAppEnteredBackground()` through `maintainBackgroundCall()`.
    case background
    /// Capture recovery after a real route change.
    case routeChange
    /// `AVAudioSession.interruptionNotification` with `.ended`.
    case interruptionEnded
    /// `mediaServicesWereResetNotification`: the documented exception (the reset invalidates every activation,
    /// CallKit's included, so the owner rebuilds and activates the session itself).
    case mediaServicesReset
    /// CallKit refused the call (or became unavailable) while an activation was wanted: the fallback takes over.
    case surfaceRefused
}

/// One step of a plan, run in order by the platform session owner.
enum AudioSessionStep: String, CaseIterable, Equatable {
    /// `.playAndRecord`, `.voiceChat`, the call options, then `setAllowHapticsAndSystemSoundsDuringRecording(true)`.
    case setCategory
    /// The route owner's current target: preferred input and output override.
    case applyRoute
    /// `setActive(true)`: the refused fallback (and the media services reset) only.
    case setActive
    /// `RTCAudioSession.isAudioEnabled = true` (WebRTC manual audio).
    case enableWebRTCAudio
    /// `RTCAudioSession.audioSessionDidActivate(_:)` (CallKit activated the session for the app).
    case notifyWebRTCActivated
    /// `RTCAudioSession.audioSessionDidDeactivate(_:)` (CallKit deactivated it).
    case notifyWebRTCDeactivated
    /// `RTCAudioSession.isAudioEnabled = false`.
    case disableWebRTCAudio
    /// `setActive(false, options: .notifyOthersOnDeactivation)` at the call's end.
    case setInactive
}

enum AudioActivationPolicy {
    /// Kill switch for WebRTC manual audio (S70 5 c revision 2). The activation-order physical cell decides it; the
    /// plans below stay valid either way (the WebRTC steps are no-ops while manual audio is off).
    static let usesManualWebRTCAudio = true

    /// S70 SX11 `mayActivate(surface:status:)`: false while CallKit owns the call, including while its start
    /// transaction is pending (`starting`), because a self-activation before `provider(_:didActivate:)` defeats
    /// CallKit-owned activation (CE A35, B6). Refused, inactive and blocked mean no system call owns the session,
    /// so the app activates it itself (the refused fallback, S70 1 c, O9). Android surfaces never own activation.
    static func mayActivate(surface: CallSystemSurfaceKind, status: CallSurfaceStatus) -> Bool {
        guard surface == .callKit else { return true }
        switch status {
        case .active, .starting:
            return false
        case .inactive, .refused, .blocked:
            return true
        }
    }

    /// The ordered steps for one request from `site`. While CallKit owns the call every site is configure-only
    /// (category, mode, options and route; never `setActive(true)`), and the background re-arm is dropped
    /// altogether (CallKit keeps the session active in the background). The fallback activates and enables WebRTC
    /// audio right after the activation, or audio would stay disabled under manual audio.
    static func steps(site: AudioActivationSite, surface: CallSystemSurfaceKind, status: CallSurfaceStatus) -> [AudioSessionStep] {
        if site == .mediaServicesReset {
            return [.disableWebRTCAudio, .setCategory, .setActive, .enableWebRTCAudio, .applyRoute]
        }
        if mayActivate(surface: surface, status: status) {
            return [.setCategory, .setActive, .enableWebRTCAudio, .applyRoute]
        }
        if site == .background {
            return []
        }
        return [.setCategory, .applyRoute]
    }

    /// The activation part only, for a caller that sets the category and applies the route itself
    /// (`WebRTCClient.configureCallAudioSession()`).
    static func activationSteps(site: AudioActivationSite, surface: CallSystemSurfaceKind, status: CallSurfaceStatus) -> [AudioSessionStep] {
        let plan = steps(site: site, surface: surface, status: status)
        return plan.filter { $0 == .setActive || $0 == .enableWebRTCAudio || $0 == .disableWebRTCAudio }
    }

    /// `provider(_:didActivate:)`: re-assert configuration, then tell WebRTC the session is active before allowing
    /// its audio unit (S70 5 l7: `audioSessionDidActivate` before `isAudioEnabled = true`).
    static func callKitDidActivateSteps() -> [AudioSessionStep] {
        [.setCategory, .applyRoute, .notifyWebRTCActivated, .enableWebRTCAudio]
    }

    /// `provider(_:didDeactivate:)`: stop WebRTC's audio unit, then report the deactivation.
    static func callKitDidDeactivateSteps() -> [AudioSessionStep] {
        [.disableWebRTCAudio, .notifyWebRTCDeactivated]
    }

    /// The call's end (`CallAudioSession.end()`): WebRTC audio off, then the deactivation that lets other audio
    /// resume (CE B9).
    static func endSteps() -> [AudioSessionStep] {
        [.disableWebRTCAudio, .setInactive]
    }

    /// Self-activations in a plan (the `sys.selfActivations` readout counts the executed ones).
    static func selfActivationCount(of steps: [AudioSessionStep]) -> Int {
        steps.filter { $0 == .setActive }.count
    }

    /// True when every activation in `steps` is immediately followed by enabling WebRTC audio.
    static func everyActivationEnablesWebRTCAudio(_ steps: [AudioSessionStep]) -> Bool {
        var index = 0
        while index < steps.count {
            if steps[index] == .setActive {
                guard index + 1 < steps.count, steps[index + 1] == .enableWebRTCAudio else { return false }
            }
            index += 1
        }
        return true
    }
}

/// S70 SX1 Debug readout keys owned by SYS-2. Values: `CallAudioSession.shared.selfActivationCount` (iOS; 0 in a
/// CallKit-owned call), `AudioRouteOwnerBridge.setCommunicationDeviceCount` and the activity's
/// `volumeControlStream` (Android). The readout surface is wired by the diagnostics owner (HD/requests/B2-T4.md R7).
enum AudioRoutingReadout {
    static let selfActivationsKey = "sys.selfActivations"
    static let setCommunicationDeviceKey = "sys.setCommunicationDevice"
    static let volumeStreamKey = "sys.volumeStream"
}

/// The recording session seam of S70 5 l7: plays scripted requests through the policy and records the steps a
/// session owner would run, so host tests and Robolectric check counts and call order without AVAudioSession.
@MainActor
final class AudioActivationRecorder {
    private(set) var steps: [AudioSessionStep] = []
    private(set) var surface: CallSystemSurfaceKind = .none
    private(set) var status: CallSurfaceStatus = .inactive

    init() {}

    var selfActivations: Int { AudioActivationPolicy.selfActivationCount(of: steps) }

    func setSurface(_ kind: CallSystemSurfaceKind, status: CallSurfaceStatus) {
        surface = kind
        self.status = status
    }

    func request(_ site: AudioActivationSite) {
        steps.append(contentsOf: AudioActivationPolicy.steps(site: site, surface: surface, status: status))
    }

    func callKitDidActivate() {
        steps.append(contentsOf: AudioActivationPolicy.callKitDidActivateSteps())
    }

    func callKitDidDeactivate() {
        steps.append(contentsOf: AudioActivationPolicy.callKitDidDeactivateSteps())
    }

    func reset() {
        steps = []
    }
}
