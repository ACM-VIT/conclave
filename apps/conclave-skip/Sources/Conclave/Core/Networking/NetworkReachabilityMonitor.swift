import Foundation
#if canImport(Network) && !SKIP
import Network
#endif

// The core's one device-conditions source, started with the view model and stopped with it: reachability and the
// quality hint (CE H6 to H10), plus SYS-6 (S70 6 c, 6 d, SY22, O10): the captive-portal flag (Android only) and
// the system pressure inputs (thermal level and Low Power Mode). Each callback fires on the main actor and only when
// its value changes, except the reachability pair, which keeps its per-path cadence.
//
// On Android `Skip/NetworkReachabilityMonitor.kt` replaces this file's transpiled output (same base name): keep the
// member names and types identical on both sides, and keep every other type out of this file (the Kotlin file would
// hide it; the shared policies live in `Core/Call/LifecycleRefreshPolicy.swift` and `Core/WebRTC/MediaQualitySettings.swift`).

@MainActor
final class NetworkReachabilityMonitor {
    var onStatusChanged: ((Bool) -> Void)?
    var onQualityHintChanged: ((ConnectionQuality) -> Void)?
    /// S70 SY22 (S20 10 f banner 2): the active network needs a sign-in. iOS has no captive-portal signal, so this
    /// side never calls it and the offline banner stays (the core's flag keeps its default, false).
    var onCaptivePortalChanged: ((Bool) -> Void)?
    /// S70 6 c (O10): `ProcessInfo.thermalState`, published once on start and then on every level change.
    var onThermalLevelChanged: ((SystemThermalLevel) -> Void)?
    /// S70 6 c (O10): Low Power Mode, published once on start and then on every change.
    var onLowPowerModeChanged: ((Bool) -> Void)?

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
            Task { @MainActor in
                self?.onStatusChanged?(isOffline)
                self?.onQualityHintChanged?(qualityHint)
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
    /// S70 6 c: `ProcessInfo.ThermalState` to the shared level. A state a later SDK adds counts as fair (no
    /// ceiling) until it is mapped on purpose.
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

    // MARK: - System pressure (iOS only; the macOS host registers nothing, so host tests drive the core directly)

    private func startSystemPressureObservers() {
        #if os(iOS) && !SKIP
        guard thermalObserver == nil else { return }
        // The thermal notification is delivered only after the property was read once (NSProcessInfo.h).
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
