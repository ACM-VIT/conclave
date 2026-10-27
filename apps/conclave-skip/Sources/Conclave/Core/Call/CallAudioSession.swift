//  iOS audio-session owner for an in-progress call (S70 5 c, SYS-2). It runs the `AudioActivationPolicy` plans:
//  while CallKit owns the call every site is configure-only and `setActive(true)` happens only through CallKit's
//  `provider(_:didActivate:)`; the refused fallback (CallKit refused or unavailable, S70 1 c, O9) and the media
//  services rebuild are the only self-activations. It drives WebRTC manual audio (`RTCAudioSession`), reports
//  interruptions to the route owner (never changing mute intent) and hands real route changes to
//  `AudioRouteOwner`, which follows explicit intent instead of re-applying the app's own selection on a timer.
#if os(iOS) && !SKIP
import Foundation
import AVFoundation
#if canImport(WebRTC)
import WebRTC
#endif

@MainActor
final class CallAudioSession {
    static let shared = CallAudioSession()

    private var isObserving = false
    /// Set while a call is active (from `begin()` to `end()`).
    private var isCallActive = false
    private var routeReassertionHandler: (() -> Void)?
    private var categoryOptionsProvider: (() -> AVAudioSession.CategoryOptions)?
    /// The routes present now (installed by the iOS `WebRTCClient`).
    var routeStateProvider: (() -> AudioRoutePlatformState?)?
    /// Applies the route owner's current target (preferred input, output override) without activating anything.
    var routeApplier: (() -> Void)?
    /// The call's system surface, from the `CallPresence` fan-out (`makePresenceAdapter()`).
    private(set) var surface: CallSystemSurfaceKind = .none
    private(set) var surfaceStatus: CallSurfaceStatus = .inactive
    /// CallKit activated the session and has not deactivated it.
    private(set) var isCallKitSessionActive = false
    /// `sys.selfActivations` (S70 SX1 readout): every `setActive(true)` this app made. 0 in a CallKit-owned call.
    private(set) var selfActivationCount = 0
    /// The last plan run (Debug readout).
    private(set) var lastPlan: [AudioSessionStep] = []
    private var isSelfActivated = false
    /// A configure-only decision was made while CallKit's start transaction was pending: if CallKit then refuses,
    /// the fallback activates once.
    private var activationWanted = false
    private var servicesResetTask: Task<Void, Never>?
    private var activationRetryTask: Task<Void, Never>?

    private init() {
        prepareWebRTCManualAudio()
    }

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

    /// The call category on `session` (configure only, never activation): `.playAndRecord`, `.voiceChat`, the call
    /// options, then haptics and system sounds allowed while recording (TG 3.7 R-H1; without it iOS suppresses
    /// in-call haptics while the microphone records). CallKit's `perform CXStartCallAction` uses it too.
    nonisolated static func configureCallCategory(on session: AVAudioSession, options: AVAudioSession.CategoryOptions) throws {
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
        try? session.setAllowHapticsAndSystemSoundsDuringRecording(true)
    }

    /// The route owner's id for a route: the device's own speaker and receiver are "speaker" and "receiver" (the
    /// ids the legacy picker already uses), anything else is its port UID.
    nonisolated static func routeId(for route: AVAudioSessionRouteDescription) -> String {
        guard let output = route.outputs.first else { return "" }
        switch output.portType {
        case .builtInSpeaker:
            return "speaker"
        case .builtInReceiver:
            return "receiver"
        default:
            return output.uid
        }
    }

    // MARK: - Lifecycle

    /// Begin a call's audio lifecycle: configure (activate only in the fallback) and start observing.
    func begin() {
        isCallActive = true
        perform(AudioActivationPolicy.steps(site: .callBegin, surface: surface, status: surfaceStatus), label: "begin")
        startObserving()
        AudioRouteOwner.shared.callAudioDidStart()
    }

    /// End the call's audio lifecycle.
    func end() {
        isCallActive = false
        activationWanted = false
        servicesResetTask?.cancel()
        servicesResetTask = nil
        activationRetryTask?.cancel()
        activationRetryTask = nil
        categoryOptionsProvider = nil
        routeReassertionHandler = nil
        stopObserving()
        perform(AudioActivationPolicy.endSteps(), label: "end")
        AudioRouteOwner.shared.callAudioDidEnd()
    }

    /// CallKit's `provider(_:didActivate:)`: the system activated the shared session for the call. Re-assert the
    /// configuration, then tell WebRTC before allowing its audio unit (manual audio). Runs even before the call is
    /// joined: CallKit starts at connecting (S70 O3), and WebRTC must learn about that activation.
    func handleCallKitActivation() {
        isCallKitSessionActive = true
        activationWanted = false
        prepareWebRTCManualAudio()
        perform(AudioActivationPolicy.callKitDidActivateSteps(), label: "callKitDidActivate")
    }

    /// CallKit's `provider(_:didDeactivate:)` (wired by request R6 in HD/requests/B2-T4.md).
    func handleCallKitDeactivation() {
        isCallKitSessionActive = false
        perform(AudioActivationPolicy.callKitDidDeactivateSteps(), label: "callKitDidDeactivate")
    }

    /// Keep the call audio armed while the app moves to the background. Dropped while CallKit owns the call
    /// (CallKit keeps the session active in the background); the fallback re-activates as before. No-op outside a
    /// call.
    func maintainBackgroundCall() {
        guard isCallActive else { return }
        perform(AudioActivationPolicy.steps(site: .background, surface: surface, status: surfaceStatus), label: "background")
    }

    /// `WebRTCClient.configureCallAudioSession()`: the caller sets the category and applies the route itself; this
    /// runs only the activation part of the plan (none while CallKit owns the call). Throws like the activation it
    /// replaces, so a failed fallback activation still fails a microphone start.
    func activateIfAllowed(site: AudioActivationSite) throws {
        let plan = AudioActivationPolicy.activationSteps(site: site, surface: surface, status: surfaceStatus)
        if plan.isEmpty {
            if surface == .callKit && surfaceStatus == .starting {
                activationWanted = true
            }
            return
        }
        try run(plan)
    }

    func setRouteReassertionHandler(_ handler: (() -> Void)?) {
        routeReassertionHandler = handler
    }

    func setCategoryOptionsProvider(_ provider: (() -> AVAudioSession.CategoryOptions)?) {
        categoryOptionsProvider = provider
    }

    /// WebRTC manual audio (S70 5 c revision 2): set before the first peer connection, so WebRTC starts its audio
    /// unit only once the session is active (CallKit's activation or the fallback's).
    func prepareWebRTCManualAudio() {
        guard AudioActivationPolicy.usesManualWebRTCAudio else { return }
        #if canImport(WebRTC)
        let rtc = RTCAudioSession.sharedInstance()
        guard !rtc.useManualAudio else { return }
        rtc.useManualAudio = true
        rtc.isAudioEnabled = isCallKitSessionActive || isSelfActivated
        #endif
    }

    // MARK: - CallPresence adapter

    /// The adapter the platform installs in the iOS `CallPresence` set (request R2): it tracks the surface for the
    /// activation policy and hands the call to the fallback when CallKit refuses it.
    func makePresenceAdapter() -> CallPresenceAdapter {
        CallPresenceAdapter(name: "audioSession") { [weak self] old, new in
            self?.presenceDidChange(from: old, to: new)
        }
    }

    func presenceDidChange(from old: CallPresenceSnapshot, to new: CallPresenceSnapshot) {
        surface = new.surface
        surfaceStatus = new.surfaceStatus
        guard new.surface == .callKit,
              new.surfaceStatus == .refused,
              old.surfaceStatus != .refused,
              CallPresencePhasePolicy.isCallInProgress(new.phase),
              isCallActive || activationWanted else { return }
        activationWanted = false
        // CallKit refused the call after the session was configured for it: the fallback activates (S70 1 c).
        perform(AudioActivationPolicy.steps(site: .surfaceRefused, surface: new.surface, status: new.surfaceStatus), label: "surfaceRefused")
    }

    // MARK: - Plans

    private func perform(_ steps: [AudioSessionStep], label: String) {
        do {
            try run(steps)
        } catch {
            debugLog("[CallAudio] \(label) failed: \(error.localizedDescription)")
        }
    }

    private func run(_ steps: [AudioSessionStep]) throws {
        lastPlan = steps
        let session = AVAudioSession.sharedInstance()
        for step in steps {
            switch step {
            case .setCategory:
                try Self.configureCallCategory(
                    on: session,
                    options: categoryOptionsProvider?() ?? Self.voiceCallCategoryOptions(for: session)
                )
            case .applyRoute:
                routeApplier?()
            case .setActive:
                try performFallbackActivation(session)
            case .enableWebRTCAudio:
                setWebRTCAudioEnabled(true)
            case .notifyWebRTCActivated:
                notifyWebRTC(activated: true, session: session)
            case .notifyWebRTCDeactivated:
                notifyWebRTC(activated: false, session: session)
            case .disableWebRTCAudio:
                setWebRTCAudioEnabled(false)
            case .setInactive:
                deactivateSession(session)
            }
        }
    }

    /// The refused fallback (and the media services rebuild): the only `setActive(true)` in the app (S70 5 l6).
    private func performFallbackActivation(_ session: AVAudioSession) throws {
        try session.setActive(true)
        isSelfActivated = true
        selfActivationCount += 1
    }

    private func deactivateSession(_ session: AVAudioSession) {
        isSelfActivated = false
        do {
            try session.setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            debugLog("[CallAudio] deactivate failed: \(error.localizedDescription)")
        }
    }

    private func setWebRTCAudioEnabled(_ enabled: Bool) {
        guard AudioActivationPolicy.usesManualWebRTCAudio else { return }
        #if canImport(WebRTC)
        let rtc = RTCAudioSession.sharedInstance()
        if !rtc.useManualAudio {
            prepareWebRTCManualAudio()
        }
        rtc.isAudioEnabled = enabled
        #endif
    }

    private func notifyWebRTC(activated: Bool, session: AVAudioSession) {
        guard AudioActivationPolicy.usesManualWebRTCAudio else { return }
        #if canImport(WebRTC)
        let rtc = RTCAudioSession.sharedInstance()
        if activated {
            rtc.audioSessionDidActivate(session)
        } else {
            rtc.audioSessionDidDeactivate(session)
        }
        #endif
    }

    /// Runs `site`'s plan; a failed fallback activation is retried at 250 ms and 1 s (an activation right after an
    /// interruption can fail while the other audio winds down). This retries activation only; it never re-selects
    /// a route.
    private func performWithActivationRetry(_ site: AudioActivationSite) {
        activationRetryTask?.cancel()
        activationRetryTask = nil
        do {
            try run(AudioActivationPolicy.steps(site: site, surface: surface, status: surfaceStatus))
        } catch {
            debugLog("[CallAudio] \(site.rawValue) failed: \(error.localizedDescription)")
            activationRetryTask = Task { @MainActor [weak self] in
                for delay in [250_000_000, 1_000_000_000] as [UInt64] {
                    try? await Task.sleep(nanoseconds: delay)
                    guard let self, self.isCallActive, !Task.isCancelled else { return }
                    do {
                        try self.run(AudioActivationPolicy.steps(site: site, surface: self.surface, status: self.surfaceStatus))
                        return
                    } catch {
                        debugLog("[CallAudio] \(site.rawValue) retry failed: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    // MARK: - Notifications

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

    // AVAudioSession posts these on a secondary thread: read the payload there, then hop to the main actor.

    @objc nonisolated private func handleInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt else {
            return
        }
        let reasonValue = Int((info[AVAudioSessionInterruptionReasonKey] as? UInt) ?? 0)
        Task { @MainActor in
            self.processInterruption(typeValue: typeValue, reasonValue: reasonValue)
        }
    }

    @objc nonisolated private func handleRouteChange(_ notification: Notification) {
        let rawReason = Int((notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0)
        var previousId = ""
        if let previous = notification.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription {
            previousId = Self.routeId(for: previous)
        }
        let previousRouteId = previousId
        Task { @MainActor in
            self.processRouteChange(rawReason: rawReason, previousId: previousRouteId)
        }
    }

    @objc nonisolated private func handleMediaServicesReset(_ notification: Notification) {
        Task { @MainActor in
            self.processMediaServicesReset()
        }
    }

    private func processInterruption(typeValue: UInt, reasonValue: Int) {
        guard isCallActive, let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
        switch type {
        case .began:
            // `.default` is another call, Siri or an alarm; `.builtInMicMuted` is an iPad cover. During a CallKit
            // hold the owner keeps `.held`. Mute intent is never touched.
            AudioRouteOwner.shared.reportInterruptionEvent(AudioInterruptionPolicy.beganEvent(reasonRawValue: reasonValue))
        case .ended:
            // Reclaim the call audio (`shouldResume` is advisory and often absent after Siri and alarms): configure
            // only while CallKit owns the call (CallKit reactivates), the fallback activates. Capture recovery is kept.
            performWithActivationRetry(.interruptionEnded)
            routeReassertionHandler?()
            AudioRouteOwner.shared.reportInterruptionEvent(.ended)
        @unknown default:
            break
        }
    }

    private func processRouteChange(rawReason: Int, previousId: String) {
        guard isCallActive else { return }
        let reason = AudioRouteChangeReason.fromIOSRawValue(rawReason)
        // S70 5 c: a category change is ignored (kept).
        guard reason != .categoryChange else { return }
        guard let state = routeStateProvider?() else { return }
        let action = AudioRouteOwner.shared.handleRouteChange(reason, previousId: previousId, state: state)
        if action.restartsCapture {
            // Capture recovery after a real change (CE B16, B21), once; the route is the owner's decision.
            routeReassertionHandler?()
        }
    }

    /// The media server restarted: rebuild the session and WebRTC's audio unit, keep intent, and show nothing
    /// unless it is still broken after 2 s (S70 5 c).
    private func processMediaServicesReset() {
        guard isCallActive else { return }
        servicesResetTask?.cancel()
        servicesResetTask = nil
        if rebuildAfterMediaServicesReset() {
            AudioRouteOwner.shared.reportInterruptionEvent(.servicesRecovered)
            return
        }
        servicesResetTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard let self, !Task.isCancelled, self.isCallActive else { return }
            AudioRouteOwner.shared.reportInterruptionEvent(.servicesReset)
            if self.rebuildAfterMediaServicesReset() {
                AudioRouteOwner.shared.reportInterruptionEvent(.servicesRecovered)
            }
        }
    }

    private func rebuildAfterMediaServicesReset() -> Bool {
        do {
            try run(AudioActivationPolicy.steps(site: .mediaServicesReset, surface: surface, status: surfaceStatus))
            routeReassertionHandler?()
            return true
        } catch {
            debugLog("[CallAudio] media services rebuild failed: \(error.localizedDescription)")
            return false
        }
    }
}
#endif
