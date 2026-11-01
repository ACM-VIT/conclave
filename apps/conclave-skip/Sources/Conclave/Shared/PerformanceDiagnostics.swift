import Foundation

enum PerformanceDiagnostics {

    static func install() {
        #if SKIP
        NativePerformanceDiagnostics.install()
        #else
        logger.debug("perf install")
        #endif
        Task { @MainActor in
            CallDiagnostics.shared.install()
        }
    }

    static func event(_ name: String, details: String = "") {
        #if SKIP
        NativePerformanceDiagnostics.event(name, details: details)
        #else

        if details.isEmpty {
            logger.debug("perf event \(name, privacy: .public)")
        } else {
            logger.debug("perf event \(name, privacy: .public) \(details, privacy: .private)")
        }
        #endif
    }

    static func state(_ name: String, old: String, new: String) {
        guard old != new else { return }
        #if SKIP
        NativePerformanceDiagnostics.state(name, oldValue: old, newValue: new)
        #else
        logger.debug("perf state \(name, privacy: .public) \(old, privacy: .private)->\(new, privacy: .private)")
        #endif
    }

    static func render(_ name: String, details: () -> String = { "" }) {
        #if SKIP
        guard NativePerformanceDiagnostics.enabled() else { return }
        NativePerformanceDiagnostics.render(name, details: details())
        #else
        let resolvedDetails = details()
        logger.debug("perf render \(name, privacy: .public) \(resolvedDetails, privacy: .private)")
        #endif
    }

    static func timing(_ name: String, startedAt: Date, details: String = "") {
        recordJoinMilestone(name)
        #if SKIP
        guard NativePerformanceDiagnostics.enabled() else { return }
        let durationMs = Date().timeIntervalSince(startedAt) * 1000.0
        NativePerformanceDiagnostics.measurement(name, durationMs: durationMs, details: details)
        #else
        let durationMs = Date().timeIntervalSince(startedAt) * 1000.0
        logger.debug("perf timing \(name, privacy: .public) ms=\(durationMs) \(details, privacy: .private)")
        #endif
    }

    static func memory(_ name: String) {
        #if SKIP
        NativePerformanceDiagnostics.memory(name)
        #else
        logger.debug("perf memory \(name, privacy: .public)")
        #endif
    }

    private static func recordJoinMilestone(_ name: String) {
        guard let milestone = DiagnosticsTimingBridge.milestone(forTiming: name) else { return }
        let at = DiagnosticsClock.monotonicMillis()
        Task { @MainActor in
            CallDiagnostics.shared.milestone(milestone.rawValue, callSession: -1, atMillis: at)
        }
    }
}
