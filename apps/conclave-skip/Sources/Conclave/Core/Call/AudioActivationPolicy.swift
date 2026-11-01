import Foundation

enum AudioActivationSite: String, CaseIterable, Equatable {

    case callBegin

    case webRTCConfigure

    case foreground

    case background

    case routeChange

    case interruptionEnded

    case mediaServicesReset

    case surfaceRefused
}

enum AudioSessionStep: String, CaseIterable, Equatable {

    case setCategory

    case applyRoute

    case setActive

    case enableWebRTCAudio

    case notifyWebRTCActivated

    case notifyWebRTCDeactivated

    case disableWebRTCAudio

    case setInactive
}

enum AudioActivationPolicy {

    static let usesManualWebRTCAudio = true

    static func mayActivate(surface: CallSystemSurfaceKind, status: CallSurfaceStatus) -> Bool {
        guard surface == .callKit else { return true }
        switch status {
        case .active, .starting:
            return false
        case .inactive, .refused, .blocked:
            return true
        }
    }

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

    static func activationSteps(site: AudioActivationSite, surface: CallSystemSurfaceKind, status: CallSurfaceStatus) -> [AudioSessionStep] {
        let plan = steps(site: site, surface: surface, status: status)
        return plan.filter { $0 == .setActive || $0 == .enableWebRTCAudio || $0 == .disableWebRTCAudio }
    }

    static func callKitDidActivateSteps() -> [AudioSessionStep] {
        [.setCategory, .applyRoute, .notifyWebRTCActivated, .enableWebRTCAudio]
    }

    static func callKitDidDeactivateSteps() -> [AudioSessionStep] {
        [.disableWebRTCAudio, .notifyWebRTCDeactivated]
    }

    static func endSteps() -> [AudioSessionStep] {
        [.disableWebRTCAudio, .setInactive]
    }

    static func selfActivationCount(of steps: [AudioSessionStep]) -> Int {
        steps.filter { $0 == .setActive }.count
    }

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

enum AudioRoutingReadout {
    static let selfActivationsKey = "sys.selfActivations"
    static let setCommunicationDeviceKey = "sys.setCommunicationDevice"
    static let volumeStreamKey = "sys.volumeStream"
}

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
