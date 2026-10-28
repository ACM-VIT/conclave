

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

    private var isCallActive = false
    private var routeReassertionHandler: (() -> Void)?
    private var categoryOptionsProvider: (() -> AVAudioSession.CategoryOptions)?

    var routeStateProvider: (() -> AudioRoutePlatformState?)?

    var routeApplier: (() -> Void)?

    private(set) var surface: CallSystemSurfaceKind = .none
    private(set) var surfaceStatus: CallSurfaceStatus = .inactive

    private(set) var isCallKitSessionActive = false

    private(set) var selfActivationCount = 0

    private(set) var lastPlan: [AudioSessionStep] = []
    private var isSelfActivated = false

    private var activationWanted = false
    private var servicesResetTask: Task<Void, Never>?
    private var activationRetryTask: Task<Void, Never>?

    private init() {
        prepareWebRTCManualAudio()
    }

    nonisolated static func voiceCallCategoryOptions(defaultToSpeaker: Bool = true) -> AVAudioSession.CategoryOptions {
        var options: AVAudioSession.CategoryOptions = [

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

    nonisolated static func configureCallCategory(on session: AVAudioSession, options: AVAudioSession.CategoryOptions) throws {
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
        try? session.setAllowHapticsAndSystemSoundsDuringRecording(true)
    }

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

    func begin() {
        isCallActive = true
        perform(AudioActivationPolicy.steps(site: .callBegin, surface: surface, status: surfaceStatus), label: "begin")
        startObserving()
        AudioRouteOwner.shared.callAudioDidStart()
    }

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

    func handleCallKitActivation() {
        isCallKitSessionActive = true
        activationWanted = false
        prepareWebRTCManualAudio()
        perform(AudioActivationPolicy.callKitDidActivateSteps(), label: "callKitDidActivate")
    }

    func handleCallKitDeactivation() {
        isCallKitSessionActive = false
        perform(AudioActivationPolicy.callKitDidDeactivateSteps(), label: "callKitDidDeactivate")
    }

    func maintainBackgroundCall() {
        guard isCallActive else { return }
        perform(AudioActivationPolicy.steps(site: .background, surface: surface, status: surfaceStatus), label: "background")
    }

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

    func prepareWebRTCManualAudio() {
        guard AudioActivationPolicy.usesManualWebRTCAudio else { return }
        #if canImport(WebRTC)
        let rtc = RTCAudioSession.sharedInstance()
        guard !rtc.useManualAudio else { return }
        rtc.useManualAudio = true
        rtc.isAudioEnabled = isCallKitSessionActive || isSelfActivated
        #endif
    }

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

        perform(AudioActivationPolicy.steps(site: .surfaceRefused, surface: new.surface, status: new.surfaceStatus), label: "surfaceRefused")
    }

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

            AudioRouteOwner.shared.reportInterruptionEvent(AudioInterruptionPolicy.beganEvent(reasonRawValue: reasonValue))
        case .ended:

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

        guard reason != .categoryChange else { return }
        guard let state = routeStateProvider?() else { return }
        let action = AudioRouteOwner.shared.handleRouteChange(reason, previousId: previousId, state: state)
        if action.restartsCapture {

            routeReassertionHandler?()
        }
    }

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
