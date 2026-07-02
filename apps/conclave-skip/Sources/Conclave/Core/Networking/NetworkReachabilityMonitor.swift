import Foundation
#if canImport(Network) && !SKIP
import Network
#endif

@MainActor
final class NetworkReachabilityMonitor {
    var onStatusChanged: ((Bool) -> Void)?
    var onQualityHintChanged: ((ConnectionQuality) -> Void)?

    #if canImport(Network) && !SKIP
    private var monitor: NWPathMonitor?
    private let queue = DispatchQueue(label: "com.acmvit.conclave.network")
    #endif

    func start() {
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
    }

    #if canImport(Network) && !SKIP
    nonisolated private static func qualityHint(for path: NWPath) -> ConnectionQuality {
        guard path.status == .satisfied else { return .unknown }
        if path.isConstrained && path.isExpensive { return .emergency }
        if path.isConstrained { return .poor }
        return .good
    }
    #endif
}
