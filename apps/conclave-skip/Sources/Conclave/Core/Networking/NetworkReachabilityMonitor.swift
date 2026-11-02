import Foundation
#if canImport(Network) && !SKIP
import Network
#endif

@MainActor
final class NetworkReachabilityMonitor {
    var onStatusChanged: ((Bool) -> Void)?
    var onQualityHintChanged: ((ConnectionQuality) -> Void)?

    var onCaptivePortalChanged: ((Bool) -> Void)?

    var onThermalLevelChanged: ((SystemThermalLevel) -> Void)?

    var onLowPowerModeChanged: ((Bool) -> Void)?

    var onSystemDataSaverChanged: ((Bool) -> Void)?
    private var lastSystemDataSaver: Bool?

    #if canImport(Network) && !SKIP
    private var monitor: NWPathMonitor?
    private let queue = DispatchQueue(label: "com.acmvit.conclave.network")
    #endif

    #if os(iOS) && !SKIP
    private var thermalObserver: NSObjectProtocol?
    private var powerStateObserver: NSObjectProtocol?
    private var lastThermalLevel: SystemThermalLevel?
    private var lastLowPowerMode: Bool?
    #endif

    func start() {
        startSystemPressureObservers()
        #if canImport(Network) && !SKIP
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        self.monitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            let isOffline = path.status != .satisfied
            let qualityHint = Self.qualityHint(for: path)
            let isConstrained = path.status == .satisfied && path.isConstrained
            Task { @MainActor in
                self?.onStatusChanged?(isOffline)
                self?.onQualityHintChanged?(qualityHint)
                self?.publishSystemDataSaver(isConstrained)
            }
        }
        monitor.start(queue: queue)
        #else
        onStatusChanged?(false)
        onQualityHintChanged?(.unknown)
        #endif
    }

    func stop() {
        #if canImport(Network) && !SKIP
        monitor?.cancel()
        monitor = nil
        lastSystemDataSaver = nil
        #endif
        stopSystemPressureObservers()
    }

    #if canImport(Network) && !SKIP
    nonisolated private static func qualityHint(for path: NWPath) -> ConnectionQuality {
        guard path.status == .satisfied else { return .unknown }
        if path.isConstrained && path.isExpensive { return .emergency }
        if path.isConstrained { return .poor }
        return .good
    }
    #endif

    #if !SKIP

    nonisolated static func thermalLevel(for state: ProcessInfo.ThermalState) -> SystemThermalLevel {
        switch state {
        case .nominal:
            return SystemThermalLevel.nominal
        case .fair:
            return SystemThermalLevel.fair
        case .serious:
            return SystemThermalLevel.serious
        case .critical:
            return SystemThermalLevel.critical
        @unknown default:
            return SystemThermalLevel.fair
        }
    }
    #endif

    private func publishSystemDataSaver(_ isOn: Bool) {
        guard isOn != lastSystemDataSaver else { return }
        lastSystemDataSaver = isOn
        onSystemDataSaverChanged?(isOn)
    }

    private func startSystemPressureObservers() {
        #if os(iOS) && !SKIP
        guard thermalObserver == nil else { return }

        _ = ProcessInfo.processInfo.thermalState
        let center = NotificationCenter.default
        thermalObserver = center.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.publishSystemPressure()
            }
        }
        powerStateObserver = center.addObserver(
            forName: .NSProcessInfoPowerStateDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.publishSystemPressure()
            }
        }
        publishSystemPressure()
        #endif
    }

    private func stopSystemPressureObservers() {
        #if os(iOS) && !SKIP
        let center = NotificationCenter.default
        if let thermalObserver {
            center.removeObserver(thermalObserver)
        }
        if let powerStateObserver {
            center.removeObserver(powerStateObserver)
        }
        thermalObserver = nil
        powerStateObserver = nil
        lastThermalLevel = nil
        lastLowPowerMode = nil
        #endif
    }

    #if os(iOS) && !SKIP
    private func publishSystemPressure() {
        let level = Self.thermalLevel(for: ProcessInfo.processInfo.thermalState)
        if level != lastThermalLevel {
            lastThermalLevel = level
            onThermalLevelChanged?(level)
        }
        let isLowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        if isLowPowerMode != lastLowPowerMode {
            lastLowPowerMode = isLowPowerMode
            onLowPowerModeChanged?(isLowPowerMode)
        }
    }
    #endif
}
