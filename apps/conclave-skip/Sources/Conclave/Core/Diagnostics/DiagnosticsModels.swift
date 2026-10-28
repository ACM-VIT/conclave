import Foundation

// S70 15 (SYS-15), 0.6 SX7, 0.7 SY16: the CallDiagnostics vocabulary. Transpiled (Skip Lite): String raw-value enums,
// scalar structs and arrays of structs only. Redaction is structural (S70 15 j): the store accepts only codes, enums,
// counts and durations, so no type here carries free text. Never stored: credentials, tokens, room links or codes,
// participant names, chat, transcripts, keys, game secrets, SDP (S70R 20). Remote upload stays off (S70 O8).

/// The intervals of S70 15 c: OSSignposter intervals on iOS, async trace sections on Android (API 29; paired synchronous
/// marks on API 28). One open span per kind and call session.
enum DiagnosticsSpanKind: String, CaseIterable, Equatable {
    /// Join intent to live (or to the waiting room, or to the end that abandoned the attempt).
    case join
    /// Mute intent to commit.
    case mute
    /// Route request to commit.
    case route
    /// PiP start to stop.
    case pip
    /// Recovery start to end.
    case recovery
    /// Terminal cleanup (ending to idle).
    case cleanup
}

/// The instants inside a join (S70 15 c). Each records the time since its call session's join span began, so the
/// first-frame and connect times read straight from the export (AC-SI18-3).
enum DiagnosticsMilestone: String, CaseIterable, Equatable {
    case tokenFetched, socketConnected, transportConfigured, transportConnected, producerCreated, joinedResponse
    case firstDecodedFrame, firstDisplayedFrame
}

/// What one breadcrumb is.
enum DiagnosticsEventKind: String, CaseIterable, Equatable {
    case event, spanStart, spanEnd, milestone
}

/// The `Logger` categories of S70 15 c under subsystem `com.acmvit.conclave` (CE O3); Android logs the same names.
enum DiagnosticsLogCategory: String, CaseIterable, Equatable {
    case call, audio, pip, recovery, links, share
}

/// Where a stored payload came from (S70 15 c MetricKit diagnostics, 15 d Android exit reasons).
enum DiagnosticsPayloadKind: String, CaseIterable, Equatable {
    case crash, hang, cpuException, diskWriteException, appLaunch, exitReason
}

/// The Settings row's state (S70 15 f): ready (idle), exporting, the file is ready to share, or the export failed.
enum DiagnosticsExportPhase: String, CaseIterable, Equatable {
    case idle, exporting, ready, failed
}

/// Why an export was refused (S70 15 f, D20). Never shown as text: every case shows the one failure line.
enum DiagnosticsExportFailure: String, CaseIterable, Equatable {
    /// No failure (a written file).
    case none
    /// The redaction check failed: the export is refused and no file is written.
    case redactionCheckFailed
    /// The file could not be written.
    case writeFailed
}

/// The error `CallDiagnostics.exportRedacted()` throws.
struct DiagnosticsExportError: Error, Equatable {
    let failure: DiagnosticsExportFailure
}

/// One ring entry (S70 15 c): a diagnostic code, the call phase, monotonic milliseconds and the opaque attempt (the S1
/// call session number, never a room or a person). `durationMillis` is -1 except on a span end (the span's length) and
/// a milestone (the time since its join span began, -1 without one). `detail` is "" or a second code: the outcome of
/// a span end, or the `MeetingErrorContext` raw value of a classified failure.
struct DiagnosticsBreadcrumb: Codable, Equatable {
    let code: String
    let phase: String
    let kind: String
    let atMillis: Double
    let attempt: Int
    let durationMillis: Double
    let detail: String
}

/// The persisted ring, written only on background (S70 15 c); the next launch reads it back as the previous process's
/// events, so a crash or an ANR still has its last 200 events.
struct DiagnosticsBreadcrumbFile: Codable, Equatable {
    let version: Int
    let writtenAtMillis: Double
    let events: [DiagnosticsBreadcrumb]
}

/// One scalar of a stored payload: a number, or a short version-like token (an OS version, an architecture, an exit
/// reason name). Texts pass `DiagnosticsRedactionPolicy.isAllowedFieldText` or the field is not stored.
struct DiagnosticsField: Codable, Equatable {
    let key: String
    let isNumber: Bool
    let number: Double
    let text: String
}

/// One MetricKit diagnostic (iOS) or process exit record (Android API 30). `detailJSON` is platform JSON without free
/// text (a MetricKit call stack tree, the sanitized frames of an ANR trace) or "".
struct DiagnosticsStoredPayload: Codable, Equatable {
    let kind: String
    let createdAtMillis: Double
    let fields: [DiagnosticsField]
    let detailJSON: String
}

/// An open span. `id` 0 is the inert token (an unknown name): ending it does nothing.
struct DiagnosticsSpanToken: Equatable {
    let id: Int
    let kind: String
    let callSession: Int
    let startedAtMillis: Double

    var isInert: Bool { id == 0 }

    static let inert = DiagnosticsSpanToken(id: 0, kind: "", callSession: 0, startedAtMillis: 0.0)
}

/// A count for the export and the Debug readouts (`sys.diagListeners`, `sys.diagBuffer`, slow frames, ...).
struct DiagnosticsCounter: Equatable {
    let key: String
    let value: Double
}

/// The export metadata (S70 15 f): written in every file, even with no events.
struct DiagnosticsPlatformInfo: Equatable {
    let platform: String
    let appVersion: String
    let osVersion: String
    let deviceClass: String

    static let host = DiagnosticsPlatformInfo(platform: "host", appVersion: "", osVersion: "", deviceClass: "host")
}

/// One stored payload file, as the retention policy sees it.
struct DiagnosticsStoredRecord: Equatable {
    let name: String
    let createdAtMillis: Double
    let byteCount: Int
}

/// A payload read back from the store.
struct DiagnosticsLoadedPayload: Equatable {
    let name: String
    let byteCount: Int
    let payload: DiagnosticsStoredPayload
}

/// Everything one export needs, captured on the main actor before the detached write.
struct DiagnosticsExportInput: Equatable {
    let info: DiagnosticsPlatformInfo
    let exportedAtMillis: Double
    let launchedAtMillis: Double
    let monotonicNowMillis: Double
    let events: [DiagnosticsBreadcrumb]
    let previousEvents: [DiagnosticsBreadcrumb]
    let previousWrittenAtMillis: Double
    let openSpans: [DiagnosticsSpanToken]
    let counters: [DiagnosticsCounter]
    /// Export-time redaction markers (room code, names, ids); never written anywhere.
    let markers: [String]
    /// Debug-only (S70 15 l5): the Settings fixture forces a failed redaction check.
    let forcesRedactionFailure: Bool
}

/// The detached export's answer: the written file's path with `failure` `.none`, or "" with the failure.
struct DiagnosticsExportOutcome: Equatable {
    let path: String
    let failure: DiagnosticsExportFailure
}

/// S70 SX1 Debug readout keys (AC-SI18-2: `sys.diagListeners` reads 1, `sys.diagBuffer` stays at or under its cap).
enum DiagnosticsReadout {
    static let listenersKey = "sys.diagListeners"
    static let bufferKey = "sys.diagBuffer"
    static let openSpansKey = "sys.diagSpans"
}

/// The bounds of S70 15 c, k.
enum DiagnosticsLimits {
    /// The breadcrumb ring (S70 15 c).
    static let breadcrumbCapacity = 200
    /// Open spans kept at once; the oldest is dropped (and recorded) past this.
    static let maxOpenSpans = 32
    /// The local store keeps 7 days or 2 MB, oldest dropped first (S70 15 c).
    static let retentionMillis: Double = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0
    static let maxStoreBytes = 2 * 1024 * 1024
    static let maxCodeLength = 64
    static let maxFieldTextLength = 64
    /// The first 64 KB of an ANR trace (S70 15 d).
    static let anrTraceBytes = 64 * 1024
    /// Shorter redaction markers are ignored (a two-letter name would match ordinary words).
    static let minimumMarkerLength = 3
    /// The persisted breadcrumb file format.
    static let fileVersion = 1
}
