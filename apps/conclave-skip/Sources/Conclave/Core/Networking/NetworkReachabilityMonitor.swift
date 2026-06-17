import Foundation
#if canImport(Network) && !SKIP
import Network
#endif

@MainActor
final class NetworkReachabilityMonitor {
    var onStatusChanged: ((Bool) -> Void)?

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
            Task { @MainActor in
                self?.onStatusChanged?(isOffline)
            }
        }
        monitor.start(queue: queue)
        #else
        onStatusChanged?(false)
        #endif
    }

    func stop() {
        #if canImport(Network) && !SKIP
        monitor?.cancel()
        monitor = nil
        #endif
    }
}
