import Foundation

enum DiagnosticsSpanKind: String, CaseIterable, Equatable {

    case join

    case mute

    case route

    case pip

    case recovery

    case cleanup
}

enum DiagnosticsMilestone: String, CaseIterable, Equatable {
    case tokenFetched, socketConnected, transportConfigured, transportConnected, producerCreated, joinedResponse
    case firstDecodedFrame, firstDisplayedFrame
}

enum DiagnosticsEventKind: String, CaseIterable, Equatable {
    case event, spanStart, spanEnd, milestone
}

enum DiagnosticsLogCategory: String, CaseIterable, Equatable {
    case call, audio, pip, recovery, links, share
}

enum DiagnosticsPayloadKind: String, CaseIterable, Equatable {
    case crash, hang, cpuException, diskWriteException, appLaunch, exitReason
}

enum DiagnosticsExportPhase: String, CaseIterable, Equatable {
    case idle, exporting, ready, failed
}

enum DiagnosticsExportFailure: String, CaseIterable, Equatable {

    case none

    case redactionCheckFailed

    case writeFailed
}

struct DiagnosticsExportError: Error, Equatable {
    let failure: DiagnosticsExportFailure
}

struct DiagnosticsBreadcrumb: Codable, Equatable {
    let code: String
    let phase: String
    let kind: String
    let atMillis: Double
    let attempt: Int
    let durationMillis: Double
    let detail: String
}

struct DiagnosticsBreadcrumbFile: Codable, Equatable {
    let version: Int
    let writtenAtMillis: Double
    let events: [DiagnosticsBreadcrumb]
}

struct DiagnosticsField: Codable, Equatable {
    let key: String
    let isNumber: Bool
    let number: Double
    let text: String
}

struct DiagnosticsStoredPayload: Codable, Equatable {
    let kind: String
    let createdAtMillis: Double
    let fields: [DiagnosticsField]
    let detailJSON: String
}

struct DiagnosticsSpanToken: Equatable {
    let id: Int
    let kind: String
    let callSession: Int
    let startedAtMillis: Double

    var isInert: Bool { id == 0 }

    static let inert = DiagnosticsSpanToken(id: 0, kind: "", callSession: 0, startedAtMillis: 0.0)
}

struct DiagnosticsCounter: Equatable {
    let key: String
    let value: Double
}

struct DiagnosticsPlatformInfo: Equatable {
    let platform: String
    let appVersion: String
    let osVersion: String
    let deviceClass: String

    static let host = DiagnosticsPlatformInfo(platform: "host", appVersion: "", osVersion: "", deviceClass: "host")
}

struct DiagnosticsStoredRecord: Equatable {
    let name: String
    let createdAtMillis: Double
    let byteCount: Int
}

struct DiagnosticsLoadedPayload: Equatable {
    let name: String
    let byteCount: Int
    let payload: DiagnosticsStoredPayload
}

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

    let markers: [String]

    let forcesRedactionFailure: Bool
}

struct DiagnosticsExportOutcome: Equatable {
    let path: String
    let failure: DiagnosticsExportFailure
}

enum DiagnosticsReadout {
    static let listenersKey = "sys.diagListeners"
    static let bufferKey = "sys.diagBuffer"
    static let openSpansKey = "sys.diagSpans"
}

enum DiagnosticsLimits {

    static let breadcrumbCapacity = 200

    static let maxOpenSpans = 32

    static let retentionMillis: Double = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0
    static let maxStoreBytes = 2 * 1024 * 1024
    static let maxCodeLength = 64
    static let maxFieldTextLength = 64

    static let anrTraceBytes = 64 * 1024

    static let minimumMarkerLength = 3

    static let fileVersion = 1
}
