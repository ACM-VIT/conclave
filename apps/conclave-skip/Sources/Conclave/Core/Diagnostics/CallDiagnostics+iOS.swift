#if os(iOS) && !SKIP
import Foundation
import MetricKit
import os
import UIKit

// S70 15 c (SYS-15) on iOS: the platform parts behind `DiagnosticsPlatformHooks`.
// - Spans: OSSignposter intervals (iOS 15), one signpost id per call session; milestones are signpost events. Names
//   are literals (OSSignposter requires static strings), one switch case per span kind and milestone.
// - Logs: `Logger` categories call, audio, pip, recovery, links and share under subsystem com.acmvit.conclave (CE O3).
//   Only codes and phases are interpolated, both `.public`; nothing else is logged.
// - MetricKit: one `MXMetricManagerSubscriber` added once at launch. Crash, hang, CPU exception, disk write exception
//   and app launch diagnostics (immediate delivery from iOS 15) become structural payloads in the local store (7 days
//   or 2 MB): versions, numeric codes, durations and the call stack tree. No message text (the Objective-C exception's
//   composed message and arguments are never read).
// - The ring is flushed on `didEnterBackgroundNotification` inside a background task, off the main thread.

enum CallDiagnosticsIOS {
    static let subsystem = "com.acmvit.conclave"

    @MainActor
    static func makeHooks() -> DiagnosticsPlatformHooks {
        let signposts = CallDiagnosticsSignposts()
        let hooks = DiagnosticsPlatformHooks()
        hooks.beginInterval = { name, spanId, callSession in
            signposts.begin(name, spanId: spanId, callSession: callSession)
        }
        hooks.endInterval = { name, spanId, _ in
            signposts.end(name, spanId: spanId)
        }
        hooks.emitEvent = { name, callSession in
            signposts.event(name, callSession: callSession)
        }
        hooks.log = { category, code, phase in
            CallDiagnosticsLog.write(category: category, code: code, phase: phase)
        }
        hooks.installListeners = { store in
            CallDiagnosticsMetricSubscriber.install(store: store)
            CallDiagnosticsBackgroundFlush.install()
        }
        hooks.counters = {
            [DiagnosticsCounter(key: AudioRoutingReadout.selfActivationsKey,
                                value: Double(CallAudioSession.shared.selfActivationCount))]
        }
        hooks.info = {
            CallDiagnosticsIOS.platformInfo()
        }
        hooks.monotonicMillis = {
            ProcessInfo.processInfo.systemUptime * 1000.0
        }
        hooks.debugBlockMainThread = { millis in
            // AC-SI18-1: Debug only (the facade checks the build); MetricKit reports hangs over 250 ms.
            Thread.sleep(forTimeInterval: Double(millis) / 1000.0)
        }
        hooks.debugLaunchForcesRedactionFailure = {
            CallDiagnosticsIOS.launchForcesRedactionFailure()
        }
        return hooks
    }

    /// S70 15 l5 (Debug only): `CONCLAVE_DIAG_FORCE_REDACTION_FAILURE=1` in the launch environment.
    static func launchForcesRedactionFailure() -> Bool {
        #if DEBUG
        return ProcessInfo.processInfo.environment["CONCLAVE_DIAG_FORCE_REDACTION_FAILURE"] == "1"
        #else
        return false
        #endif
    }

    /// App version with build, OS version and the device class only (no model, no name, no identifier).
    @MainActor
    static func platformInfo() -> DiagnosticsPlatformInfo {
        let bundle = Bundle.main
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        let appVersion = build.isEmpty ? version : version + " (" + build + ")"
        let deviceClass = UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "phone"
        return DiagnosticsPlatformInfo(platform: "ios", appVersion: appVersion,
                                       osVersion: "iOS " + UIDevice.current.systemVersion, deviceClass: deviceClass)
    }
}

/// OSSignposter intervals and events (S70 15 c; they also feed the PLAN performance protocol, S70 16 k).
@MainActor
final class CallDiagnosticsSignposts {
    private let signposter = OSSignposter(subsystem: CallDiagnosticsIOS.subsystem, category: "call")
    private var signpostSession = -1
    private var signpostId = OSSignpostID.invalid
    /// Open interval states by span id (bounded by the facade's 32 open spans).
    private var states: [Int: OSSignpostIntervalState] = [:]

    /// One signpost id per call session.
    private func signpost(for callSession: Int) -> OSSignpostID {
        if callSession != signpostSession {
            signpostSession = callSession
            signpostId = signposter.makeSignpostID()
        }
        return signpostId
    }

    func begin(_ name: String, spanId: Int, callSession: Int) {
        guard let kind = DiagnosticsSpanKind(rawValue: name) else { return }
        let id = signpost(for: callSession)
        let state: OSSignpostIntervalState
        switch kind {
        case .join:
            state = signposter.beginInterval("join", id: id)
        case .mute:
            state = signposter.beginInterval("mute", id: id)
        case .route:
            state = signposter.beginInterval("route", id: id)
        case .pip:
            state = signposter.beginInterval("pip", id: id)
        case .recovery:
            state = signposter.beginInterval("recovery", id: id)
        case .cleanup:
            state = signposter.beginInterval("cleanup", id: id)
        }
        states[spanId] = state
    }

    func end(_ name: String, spanId: Int) {
        guard let state = states.removeValue(forKey: spanId), let kind = DiagnosticsSpanKind(rawValue: name) else { return }
        switch kind {
        case .join:
            signposter.endInterval("join", state)
        case .mute:
            signposter.endInterval("mute", state)
        case .route:
            signposter.endInterval("route", state)
        case .pip:
            signposter.endInterval("pip", state)
        case .recovery:
            signposter.endInterval("recovery", state)
        case .cleanup:
            signposter.endInterval("cleanup", state)
        }
    }

    func event(_ name: String, callSession: Int) {
        guard let milestone = DiagnosticsMilestone(rawValue: name) else { return }
        let id = signpost(for: callSession)
        switch milestone {
        case .tokenFetched:
            signposter.emitEvent("tokenFetched", id: id)
        case .socketConnected:
            signposter.emitEvent("socketConnected", id: id)
        case .transportConfigured:
            signposter.emitEvent("transportConfigured", id: id)
        case .transportConnected:
            signposter.emitEvent("transportConnected", id: id)
        case .producerCreated:
            signposter.emitEvent("producerCreated", id: id)
        case .joinedResponse:
            signposter.emitEvent("joinedResponse", id: id)
        case .firstDecodedFrame:
            signposter.emitEvent("firstDecodedFrame", id: id)
        case .firstDisplayedFrame:
            signposter.emitEvent("firstDisplayedFrame", id: id)
        }
    }
}

/// The six `Logger` categories (S70 15 c). Codes and phases are vocabulary values, so they are logged `.public`.
enum CallDiagnosticsLog {
    static let call = Logger(subsystem: CallDiagnosticsIOS.subsystem, category: "call")
    static let audio = Logger(subsystem: CallDiagnosticsIOS.subsystem, category: "audio")
    static let pip = Logger(subsystem: CallDiagnosticsIOS.subsystem, category: "pip")
    static let recovery = Logger(subsystem: CallDiagnosticsIOS.subsystem, category: "recovery")
    static let links = Logger(subsystem: CallDiagnosticsIOS.subsystem, category: "links")
    static let share = Logger(subsystem: CallDiagnosticsIOS.subsystem, category: "share")

    static func logger(for category: String) -> Logger {
        switch DiagnosticsLogCategory(rawValue: category) ?? DiagnosticsLogCategory.call {
        case .call:
            return call
        case .audio:
            return audio
        case .pip:
            return pip
        case .recovery:
            return recovery
        case .links:
            return links
        case .share:
            return share
        }
    }

    static func write(category: String, code: String, phase: String) {
        logger(for: category).info("\(code, privacy: .public) phase=\(phase, privacy: .public)")
    }
}

/// The one MetricKit subscriber per process (S70 15 c, k). Payloads arrive off the main thread and go straight to the
/// store; nothing prompts the person (S70 15 f: a crash payload arrives on the next launch and is stored silently).
final class CallDiagnosticsMetricSubscriber: NSObject, MXMetricManagerSubscriber {
    private static var installed: CallDiagnosticsMetricSubscriber?
    private let store: DiagnosticsFileStore

    init(store: DiagnosticsFileStore) {
        self.store = store
        super.init()
    }

    @MainActor
    static func install(store: DiagnosticsFileStore) {
        guard installed == nil else { return }
        let subscriber = CallDiagnosticsMetricSubscriber(store: store)
        installed = subscriber
        MXMetricManager.shared.add(subscriber)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for record in CallDiagnosticsMetricPayloads.records(from: payloads) {
            store.writePayload(record)
        }
    }
}

/// MetricKit diagnostics to structural payloads: versions, numeric codes, durations and the call stack tree only.
enum CallDiagnosticsMetricPayloads {
    static func records(from payloads: [MXDiagnosticPayload]) -> [DiagnosticsStoredPayload] {
        var result: [DiagnosticsStoredPayload] = []
        for payload in payloads {
            let createdAt = payload.timeStampEnd.timeIntervalSince1970 * 1000.0
            for crash in payload.crashDiagnostics ?? [] {
                var fields = baseFields(crash)
                if let value = crash.exceptionType {
                    fields.append(DiagnosticsPayloadFactory.number("exceptionType", value.doubleValue))
                }
                if let value = crash.exceptionCode {
                    fields.append(DiagnosticsPayloadFactory.number("exceptionCode", value.doubleValue))
                }
                if let value = crash.signal {
                    fields.append(DiagnosticsPayloadFactory.number("signal", value.doubleValue))
                }
                if let reason = crash.exceptionReason {
                    // The exception's name and type only; its composed message and arguments can carry free text.
                    if let field = DiagnosticsPayloadFactory.text("exceptionName", reason.exceptionName) {
                        fields.append(field)
                    }
                    if let field = DiagnosticsPayloadFactory.text("exceptionKind", reason.exceptionType) {
                        fields.append(field)
                    }
                }
                result.append(DiagnosticsPayloadFactory.payload(kind: .crash, createdAtMillis: createdAt, fields: fields,
                                                                detailJSON: tree(crash.callStackTree)))
            }
            for hang in payload.hangDiagnostics ?? [] {
                var fields = baseFields(hang)
                fields.append(DiagnosticsPayloadFactory.number("hangDurationMillis",
                                                               hang.hangDuration.converted(to: .milliseconds).value))
                result.append(DiagnosticsPayloadFactory.payload(kind: .hang, createdAtMillis: createdAt, fields: fields,
                                                                detailJSON: tree(hang.callStackTree)))
            }
            for cpu in payload.cpuExceptionDiagnostics ?? [] {
                var fields = baseFields(cpu)
                fields.append(DiagnosticsPayloadFactory.number("totalCPUTimeMillis",
                                                               cpu.totalCPUTime.converted(to: .milliseconds).value))
                fields.append(DiagnosticsPayloadFactory.number("totalSampledTimeMillis",
                                                               cpu.totalSampledTime.converted(to: .milliseconds).value))
                result.append(DiagnosticsPayloadFactory.payload(kind: .cpuException, createdAtMillis: createdAt,
                                                                fields: fields, detailJSON: tree(cpu.callStackTree)))
            }
            for disk in payload.diskWriteExceptionDiagnostics ?? [] {
                var fields = baseFields(disk)
                fields.append(DiagnosticsPayloadFactory.number("totalWritesBytes",
                                                               disk.totalWritesCaused.converted(to: .bytes).value))
                result.append(DiagnosticsPayloadFactory.payload(kind: .diskWriteException, createdAtMillis: createdAt,
                                                                fields: fields, detailJSON: tree(disk.callStackTree)))
            }
            for launch in payload.appLaunchDiagnostics ?? [] {
                var fields = baseFields(launch)
                fields.append(DiagnosticsPayloadFactory.number("launchDurationMillis",
                                                               launch.launchDuration.converted(to: .milliseconds).value))
                result.append(DiagnosticsPayloadFactory.payload(kind: .appLaunch, createdAtMillis: createdAt,
                                                                fields: fields, detailJSON: tree(launch.callStackTree)))
            }
        }
        return result
    }

    /// App version, OS version, build and architecture (MXMetaData's region format and device type are not read).
    private static func baseFields(_ diagnostic: MXDiagnostic) -> [DiagnosticsField] {
        var fields: [DiagnosticsField] = []
        let candidates = [
            ("appVersion", diagnostic.applicationVersion),
            ("osVersion", diagnostic.metaData.osVersion),
            ("appBuild", diagnostic.metaData.applicationBuildVersion),
            ("architecture", diagnostic.metaData.platformArchitecture),
        ]
        for (key, value) in candidates {
            if let field = DiagnosticsPayloadFactory.text(key, value) {
                fields.append(field)
            }
        }
        return fields
    }

    /// The call stack tree's JSON (binary names, UUIDs, offsets and sample counts).
    private static func tree(_ tree: MXCallStackTree) -> String {
        String(data: tree.jsonRepresentation(), encoding: .utf8) ?? ""
    }
}

/// S70 15 c: the ring is flushed when the app goes to the background, inside a background task so the write finishes.
@MainActor
enum CallDiagnosticsBackgroundFlush {
    private static var observer: NSObjectProtocol?

    static func install() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
                                                          object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                CallDiagnosticsBackgroundFlush.flushInBackgroundTask()
            }
        }
    }

    static func flushInBackgroundTask() {
        let task = CallDiagnosticsBackgroundTask()
        task.identifier = UIApplication.shared.beginBackgroundTask(withName: "ConclaveDiagnosticsFlush") {
            task.finish()
        }
        CallDiagnostics.shared.applicationDidEnterBackground {
            task.finish()
        }
    }
}

@MainActor
final class CallDiagnosticsBackgroundTask {
    var identifier = UIBackgroundTaskIdentifier.invalid

    func finish() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}
#endif
