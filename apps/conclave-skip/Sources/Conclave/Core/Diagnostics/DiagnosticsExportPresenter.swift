import Foundation
import Observation

@MainActor
@Observable
final class DiagnosticsExportPresenter {
    static let shared = DiagnosticsExportPresenter(diagnostics: CallDiagnostics.shared)

    private(set) var phase: DiagnosticsExportPhase = DiagnosticsExportPhase.idle

    private(set) var readyRevision = 0

    private(set) var failureRevision = 0

    let diagnostics: CallDiagnostics

    @ObservationIgnored private(set) var filePath = ""
    @ObservationIgnored private var sharedRevision = 0
    @ObservationIgnored private var shownFailureRevision = 0

    @ObservationIgnored private(set) var exportCount = 0

    init(diagnostics: CallDiagnostics) {
        self.diagnostics = diagnostics
    }

    func export() {
        guard begin() else { return }
        Task { @MainActor in
            await self.finish()
        }
    }

    func exportAndWait() async {
        guard begin() else { return }
        await finish()
    }

    func takePendingShare() -> String {
        guard readyRevision > sharedRevision, !filePath.isEmpty else { return "" }
        sharedRevision = readyRevision
        return filePath
    }

    func takePendingFailure() -> Bool {
        guard failureRevision > shownFailureRevision else { return false }
        shownFailureRevision = failureRevision
        return true
    }

    func shareFinished() {
        if phase == DiagnosticsExportPhase.ready {
            phase = DiagnosticsExportPhase.idle
        }
    }

    func shareFailed() {
        phase = DiagnosticsExportPhase.failed
        failureRevision += 1
    }

    private func begin() -> Bool {
        if phase == DiagnosticsExportPhase.exporting { return false }
        phase = DiagnosticsExportPhase.exporting
        exportCount += 1
        return true
    }

    private func finish() async {
        do {
            let url = try await diagnostics.exportRedacted()
            filePath = url.path
            phase = DiagnosticsExportPhase.ready
            readyRevision += 1
        } catch {
            filePath = ""
            phase = DiagnosticsExportPhase.failed
            failureRevision += 1
        }
    }
}
