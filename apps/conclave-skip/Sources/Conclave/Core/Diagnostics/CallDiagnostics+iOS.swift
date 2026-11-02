#if os(iOS) && !SKIP
import Foundation
import MetricKit
import os
import UIKit

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

            Thread.sleep(forTimeInterval: Double(millis) / 1000.0)
        }
        hooks.debugLaunchForcesRedactionFailure = {
            CallDiagnosticsIOS.launchForcesRedactionFailure()
        }
        return hooks
    }

    static func launchForcesRedactionFailure() -> Bool {
        #if DEBUG
        return ProcessInfo.processInfo.environment["CONCLAVE_DIAG_FORCE_REDACTION_FAILURE"] == "1"
        #else
        return false
        #endif
    }

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

@MainActor
final class CallDiagnosticsSignposts {
    private let signposter = OSSignposter(subsystem: CallDiagnosticsIOS.subsystem, category: "call")
    private var signpostSession = -1
    private var signpostId = OSSignpostID.invalid

    private var states: [Int: OSSignpostIntervalState] = [:]

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

    private static func tree(_ tree: MXCallStackTree) -> String {
        String(data: tree.jsonRepresentation(), encoding: .utf8) ?? ""
    }
}

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
