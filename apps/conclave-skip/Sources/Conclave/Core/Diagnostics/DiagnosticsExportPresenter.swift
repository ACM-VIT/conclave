import Foundation
import Observation

/// S70 15 b, f (R70-4): the About "Export Diagnostics" row's state, shared by the call scope and the app scope (RECONCILE
/// R26) on both platforms. Transpiled. The row taps `export()`; one export runs at a time. A finished export bumps
/// `readyRevision` and the view hands the file to the system share sheet once (`takePendingShare()`); a failed one bumps
/// `failureRevision` and the view shows the D20 failure once (`takePendingFailure()`): the iOS line under the row with
/// Try Again, the Android page snackbar with Retry. Never the stage toast lane. No haptics (S70 15 h).
@MainActor
@Observable
final class DiagnosticsExportPresenter {
    static let shared = DiagnosticsExportPresenter(diagnostics: CallDiagnostics.shared)

    private(set) var phase: DiagnosticsExportPhase = DiagnosticsExportPhase.idle
    /// Bumped once per written file.
    private(set) var readyRevision = 0
    /// Bumped once per refused or failed export.
    private(set) var failureRevision = 0

    let diagnostics: CallDiagnostics
    /// The newest written file ("" after a failure).
    @ObservationIgnored private(set) var filePath = ""
    @ObservationIgnored private var sharedRevision = 0
    @ObservationIgnored private var shownFailureRevision = 0
    /// Exports started (tests and the Debug readout).
    @ObservationIgnored private(set) var exportCount = 0

    init(diagnostics: CallDiagnostics) {
        self.diagnostics = diagnostics
    }

    /// The row's tap and the failure's Try Again or Retry. Ignored while an export runs.
    func export() {
        guard begin() else { return }
        Task { @MainActor in
            await self.finish()
        }
    }

    /// The same, awaited (tests and fixtures).
    func exportAndWait() async {
        guard begin() else { return }
        await finish()
    }

    /// The path to share once per written file, or "" (nothing new to share).
    func takePendingShare() -> String {
        guard readyRevision > sharedRevision, !filePath.isEmpty else { return "" }
        sharedRevision = readyRevision
        return filePath
    }

    /// True once per failure, so the iOS line is announced once and the Android snackbar shows once.
    func takePendingFailure() -> Bool {
        guard failureRevision > shownFailureRevision else { return false }
        shownFailureRevision = failureRevision
        return true
    }

    /// The share sheet closed (shared or cancelled): the row is ready again.
    func shareFinished() {
        if phase == DiagnosticsExportPhase.ready {
            phase = DiagnosticsExportPhase.idle
        }
    }

    /// The system could not show the share sheet: shown like a failed export.
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
