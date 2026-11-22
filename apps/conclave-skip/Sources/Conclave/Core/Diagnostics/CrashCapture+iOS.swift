#if os(iOS) && !SKIP
import Foundation

/// Stores an uncaught Objective-C exception as a crash record before the process dies, for the next
/// launch to upload. Signal crashes (Swift traps, bad access) arrive through MetricKit instead.
enum CrashCaptureIOS {
    private static var previousHandler: (@convention(c) (NSException) -> Void)?
    private static var installed = false

    @MainActor
    static func install() {
        guard !installed else { return }
        installed = true
        previousHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler { exception in
            CrashCaptureIOS.record(exception)
            CrashCaptureIOS.previousHandler?(exception)
        }
    }

    static func record(_ exception: NSException) {
        var breadcrumbs: [String] = []
        var phase = ""
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                for event in CallDiagnostics.shared.events {
                    breadcrumbs.append(event.code)
                }
                phase = CallDiagnostics.shared.currentPhase
            }
        }
        let payload = CrashCaptureRecord.payload(
            exceptions: [CrashReportException(type: exception.name.rawValue,
                                              frames: CrashCaptureRecord.symbolFrames(exception.callStackSymbols))],
            breadcrumbs: breadcrumbs,
            phase: phase,
            createdAtMillis: DiagnosticsClock.wallMillis()
        )
        DiagnosticsFileStore.standard().writePayload(payload)
    }

    #if DEBUG
    static func debugForceCrash() {
        NSException(name: NSExceptionName.internalInconsistencyException, reason: "Conclave test crash",
                    userInfo: nil).raise()
    }
    #endif
}
#endif
