import Foundation

struct CrashReportingConfig: Equatable {
    let projectKey: String
    let host: String
    let isDebugBuild: Bool
    let debugOptIn: Bool
    let userAllows: Bool
}

enum CrashReportingPolicy {
    static let projectKeyKey = "POSTHOG_PROJECT_KEY"
    static let hostKey = "POSTHOG_HOST"
    static let debugOptInKey = "CONCLAVE_CRASH_REPORTS_IN_DEBUG"
    static let defaultHost = "https://eu.i.posthog.com"
    static let batchLimit = 20

    static func endpoint(_ config: CrashReportingConfig) -> String? {
        if !config.userAllows { return nil }
        if config.projectKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        if config.isDebugBuild && !config.debugOptIn { return nil }
        var host = config.host.trimmingCharacters(in: .whitespacesAndNewlines)
        if host.isEmpty { host = defaultHost }
        while host.hasSuffix("/") {
            host = String(host.dropLast())
        }
        let lowered = host.lowercased()
        let isSecure = lowered.hasPrefix("https://") && lowered.count > 8
        let isLocalDebug = config.isDebugBuild && lowered.hasPrefix("http://") && lowered.count > 7
        if !isSecure && !isLocalDebug { return nil }
        return host + "/batch/"
    }
}

struct CrashReportContext: Equatable {
    let installId: String
    let platform: String
    let appVersion: String
    let osVersion: String
    let deviceClass: String
}

struct CrashReportFrame: Equatable {
    let function: String
    let module: String
    let filename: String
    let line: Int
    let inApp: Bool
}

struct CrashReportException: Equatable {
    let type: String
    let frames: [CrashReportFrame]
}

/// Character checks alone do not make text safe to upload, so uploads take text fields from a fixed key list
/// and reduce exception names and stack frames to code-symbol characters. A path keeps only a library or binary
/// name (`libc.so`, `UIKit.framework`, `Conclave`); anything else in it, such as a user folder, never leaves the device.
enum CrashReportPrivacy {
    static let uploadedTextKeys: [String] = [
        "reason", "summaryPhase", "appVersion", "osVersion", "appBuild", "architecture", "exceptionName", "exceptionKind",
    ]
    static let symbolCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.$:<>()[]+-#/ ,"
    static let maxSymbolLength = 160
    /// Native libraries and binaries a frame can name on iOS (`.dylib`, `.framework`) and Android (`.so`, plus the
    /// runtime's `.apk`, `.oat`, `.odex`, `.vdex`, `.jar` and `.dex` files).
    static let binarySuffixes = [".so", ".dylib", ".framework", ".apk", ".oat", ".odex", ".vdex", ".jar", ".dex"]
    static let appBinaryNames = ["Conclave"]
    static let binaryNameCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.+-"

    static func symbol(_ text: String) -> String {
        var kept = ""
        for character in withoutPaths(text) where symbolCharacters.contains(character) {
            kept += String(character)
        }
        var tokens: [String] = []
        for token in kept.components(separatedBy: " ") where !token.isEmpty {
            if !token.contains("/") {
                tokens.append(token)
                continue
            }
            let fileName = token.components(separatedBy: "/").last ?? ""
            if isBinaryName(fileName) {
                tokens.append(fileName)
            }
        }
        let joined = tokens.joined(separator: " ")
        return joined.count > maxSymbolLength ? String(joined.prefix(maxSymbolLength)) : joined
    }

    static func isBinaryName(_ name: String) -> Bool {
        if name.isEmpty { return false }
        for character in name where !binaryNameCharacters.contains(character) {
            return false
        }
        if appBinaryNames.contains(name) { return true }
        for suffix in binarySuffixes where name.count > suffix.count && name.hasSuffix(suffix) {
            return true
        }
        return false
    }

    /// Fails closed. A path can hold spaces and dots (`/Users/Jane.Doe Smith/lib.so`), so no text between its first
    /// `/` and the last `/` after it survives, and the name after that last `/` survives only when it is a library or
    /// binary (or the binary inside its `.framework`). Otherwise everything from the path on goes, because a name with
    /// a dot or a word after a space could still be a folder.
    static func withoutPaths(_ text: String) -> String {
        var characters: [String] = []
        for character in text {
            characters.append(String(character))
        }
        let nameEnders = [" ", "(", ")", "[", "]", ",", "\"", "'", ":", ";", "\t", "\n"]
        var result = ""
        var index = 0
        while index < characters.count {
            let startsPath = characters[index] == "/" && (index == 0 || !isPathWordCharacter(characters[index - 1]))
            if !startsPath {
                result += characters[index]
                index += 1
                continue
            }
            var lastSlash = index
            var previousSlash = -1
            var probe = index + 1
            while probe < characters.count {
                if characters[probe] == "/" {
                    previousSlash = lastSlash
                    lastSlash = probe
                }
                probe += 1
            }
            var nameEnd = lastSlash + 1
            var name = ""
            while nameEnd < characters.count && !nameEnders.contains(characters[nameEnd]) {
                name += characters[nameEnd]
                nameEnd += 1
            }
            var folder = ""
            if previousSlash >= 0 {
                var folderIndex = previousSlash + 1
                while folderIndex < lastSlash {
                    folder += characters[folderIndex]
                    folderIndex += 1
                }
            }
            if isBinaryName(name) {
                result += name
            } else if !name.isEmpty && folder == name + ".framework" {
                result += folder
            } else {
                break
            }
            index = nameEnd
        }
        return result
    }

    /// A `/` right after one of these continues a relative name (`lib/arm64`) rather than starting an absolute path.
    private static func isPathWordCharacter(_ character: String) -> Bool {
        binaryNameCharacters.contains(character)
    }

    static func frame(_ frame: CrashReportFrame) -> CrashReportFrame {
        CrashReportFrame(function: symbol(frame.function), module: symbol(frame.module), filename: symbol(frame.filename),
                         line: frame.line, inApp: frame.inApp)
    }
}

enum CrashReportKind: String, Equatable {
    case crash, nativeCrash, appNotResponding, hang, appExit, diagnostic
}

enum CrashReportEventBuilder {
    static let exceptionEvent = "$exception"
    static let appExitEvent = "native_app_exit"
    static let diagnosticEvent = "native_diagnostic"
    static let maxFrames = 64
    static let maxBreadcrumbs = 20

    static let reportedExitReasons: [String] = [
        "crash", "crashNative", "anr", "lowMemory", "excessiveResourceUsage", "initializationFailure",
    ]

    static func kind(of payload: DiagnosticsStoredPayload) -> CrashReportKind? {
        guard let kind = DiagnosticsPayloadKind(rawValue: payload.kind) else { return nil }
        switch kind {
        case .crash:
            return CrashReportKind.crash
        case .hang:
            return CrashReportKind.hang
        case .cpuException, .diskWriteException, .appLaunch:
            return CrashReportKind.diagnostic
        case .exitReason:
            let reason = textField(payload, "reason")
            if !reportedExitReasons.contains(reason) { return nil }
            if reason == "crashNative" { return CrashReportKind.nativeCrash }
            if reason == "anr" { return CrashReportKind.appNotResponding }
            return CrashReportKind.appExit
        }
    }

    static func event(for payload: DiagnosticsStoredPayload, eventId: String, context: CrashReportContext) -> String? {
        guard let kind = kind(of: payload) else { return nil }
        let detail = parseDetail(payload.detailJSON)
        var properties: [String] = baseProperties(payload, kind: kind, context: context)
        let breadcrumbs = breadcrumbCodes(detail)
        if !breadcrumbs.isEmpty {
            properties.append(DiagnosticsJSON.string("breadcrumbs") + ": " + stringArray(breadcrumbs))
        }
        let phase = DiagnosticsRedactionPolicy.sanitizedPhase(detail?["phase"] as? String ?? "")
        let summaryPhase = textField(payload, "summaryPhase")
        let callPhase = summaryPhase.isEmpty ? phase : summaryPhase
        if callPhase != DiagnosticsRedactionPolicy.otherPhase {
            properties.append(DiagnosticsJSON.string("call_phase") + ": " + DiagnosticsJSON.string(callPhase))
        }

        let eventName: String
        switch kind {
        case .crash, .nativeCrash, .appNotResponding, .hang:
            eventName = exceptionEvent
            let level = kind == CrashReportKind.hang ? "error" : "fatal"
            properties.append(DiagnosticsJSON.string("$exception_level") + ": " + DiagnosticsJSON.string(level))
            properties.append(DiagnosticsJSON.string("$exception_list") + ": "
                + exceptionList(exceptions(kind: kind, payload: payload, detail: detail), kind: kind,
                                lang: context.platform == "ios" ? "swift" : "java"))
        case .appExit:
            eventName = appExitEvent
        case .diagnostic:
            eventName = diagnosticEvent
        }

        return "{ " + DiagnosticsJSON.string("event") + ": " + DiagnosticsJSON.string(eventName)
            + ", " + DiagnosticsJSON.string("uuid") + ": " + DiagnosticsJSON.string(eventId)
            + ", " + DiagnosticsJSON.string("distinct_id") + ": " + DiagnosticsJSON.string(context.installId)
            + ", " + DiagnosticsJSON.string("timestamp") + ": "
            + DiagnosticsJSON.string(DiagnosticsTimePolicy.iso8601(epochMillis: payload.createdAtMillis))
            + ", " + DiagnosticsJSON.string("properties") + ": { " + properties.joined(separator: ", ") + " } }"
    }

    static func batch(projectKey: String, events: [String]) -> String {
        "{ " + DiagnosticsJSON.string("api_key") + ": " + DiagnosticsJSON.string(projectKey) + ", "
            + DiagnosticsJSON.string("batch") + ": [" + events.joined(separator: ", ") + "] }"
    }

    /// The UUID PostHog dedupes a retried upload on: the store names each payload `payload-<UUID>.json`.
    static func eventId(forPayloadName name: String) -> String {
        var stem = name
        if stem.hasPrefix(DiagnosticsFileStore.payloadPrefix) {
            stem = String(stem.dropFirst(DiagnosticsFileStore.payloadPrefix.count))
        }
        if stem.hasSuffix(".json") {
            stem = String(stem.dropLast(5))
        }
        return UUID(uuidString: stem)?.uuidString.lowercased() ?? UUID().uuidString.lowercased()
    }

    static func exceptions(kind: CrashReportKind, payload: DiagnosticsStoredPayload,
                           detail: [String: Any]?) -> [CrashReportException] {
        if let captured = capturedExceptions(detail), !captured.isEmpty {
            return captured
        }
        let frames: [CrashReportFrame]
        if let tree = detail, tree["callStacks"] != nil {
            frames = metricKitFrames(tree)
        } else {
            frames = mainThreadTraceFrames(detail)
        }
        return [CrashReportException(type: fallbackType(kind: kind, payload: payload), frames: frames)]
    }

    static func fallbackType(kind: CrashReportKind, payload: DiagnosticsStoredPayload) -> String {
        switch kind {
        case .nativeCrash:
            return "NativeCrash"
        case .appNotResponding:
            return "ApplicationNotResponding"
        case .hang:
            return "AppHang"
        default:
            let name = textField(payload, "exceptionName")
            if !name.isEmpty { return name }
            let signal = numberField(payload, "signal")
            if signal > 0.0 { return "Signal" + DiagnosticsJSON.number(signal) }
            return "Crash"
        }
    }

    static func capturedExceptions(_ detail: [String: Any]?) -> [CrashReportException]? {
        guard let list = detail?["exceptions"] as? [Any] else { return nil }
        var result: [CrashReportException] = []
        for item in list {
            guard let entry = item as? [String: Any], let type = entry["type"] as? String, !type.isEmpty else { continue }
            var frames: [CrashReportFrame] = []
            for rawFrame in entry["frames"] as? [Any] ?? [] {
                guard let frame = rawFrame as? [String: Any] else { continue }
                frames.append(CrashReportFrame(
                    function: frame["function"] as? String ?? "",
                    module: frame["module"] as? String ?? "",
                    filename: frame["filename"] as? String ?? "",
                    line: intValue(frame["line"]),
                    inApp: frame["inApp"] as? Bool ?? false
                ))
                if frames.count >= maxFrames { break }
            }
            result.append(CrashReportException(type: type, frames: frames))
        }
        return result
    }

    static func metricKitFrames(_ tree: [String: Any]) -> [CrashReportFrame] {
        guard let stacks = tree["callStacks"] as? [Any] else { return [] }
        var chosen: [String: Any]? = nil
        for item in stacks {
            guard let stack = item as? [String: Any] else { continue }
            if chosen == nil { chosen = stack }
            if stack["threadAttributed"] as? Bool == true {
                chosen = stack
                break
            }
        }
        var frames: [CrashReportFrame] = []
        var next = (chosen?["callStackRootFrames"] as? [Any])?.first as? [String: Any]
        while next != nil && frames.count < maxFrames {
            let frame = next ?? [:]
            let binary = frame["binaryName"] as? String ?? ""
            let offset = intValue(frame["offsetIntoBinaryTextSegment"])
            frames.append(CrashReportFrame(function: binary + " + " + String(offset), module: binary, filename: "",
                                           line: 0, inApp: binary == "Conclave"))
            next = (frame["subFrames"] as? [Any])?.first as? [String: Any]
        }
        return frames
    }

    static func mainThreadTraceFrames(_ detail: [String: Any]?) -> [CrashReportFrame] {
        guard let lines = detail?["traceLines"] as? [Any] else { return [] }
        var frames: [CrashReportFrame] = []
        var inMain = false
        for item in lines {
            guard let line = item as? String else { continue }
            if line.hasPrefix("\"") {
                if inMain { break }
                inMain = line.hasPrefix("\"main\"")
                continue
            }
            if !inMain { continue }
            if let frame = traceFrame(line) {
                frames.append(frame)
                if frames.count >= maxFrames { break }
            }
        }
        return frames
    }

    /// Parses `at a.b.Class.method(File.kt:12)` and `native: #00 pc ... (symbol+8)` trace lines.
    static func traceFrame(_ line: String) -> CrashReportFrame? {
        if line.hasPrefix("native: ") {
            return CrashReportFrame(function: String(line.dropFirst(8)), module: "", filename: "", line: 0, inApp: false)
        }
        guard line.hasPrefix("at ") else { return nil }
        let body = String(line.dropFirst(3))
        var qualified = body
        var location = ""
        let callParts = body.components(separatedBy: "(")
        if callParts.count >= 2 && body.hasSuffix(")") {
            qualified = callParts[0]
            location = String(callParts.dropFirst().joined(separator: "(").dropLast())
        }
        let nameParts = qualified.components(separatedBy: ".")
        let function = nameParts.last ?? qualified
        let module = nameParts.count > 1 ? nameParts.dropLast().joined(separator: ".") : ""
        let locationParts = location.components(separatedBy: ":")
        var filename = location
        var lineNumber = 0
        if locationParts.count >= 2 {
            filename = locationParts.dropLast().joined(separator: ":")
            lineNumber = Int(locationParts[locationParts.count - 1]) ?? 0
        }
        return CrashReportFrame(function: function, module: module, filename: filename, line: lineNumber,
                                inApp: module.hasPrefix("conclave."))
    }

    static func exceptionList(_ exceptions: [CrashReportException], kind: CrashReportKind, lang: String) -> String {
        let mechanism = kind == CrashReportKind.hang || kind == CrashReportKind.appNotResponding ? "freeze" : "crash"
        var parts: [String] = []
        for exception in exceptions {
            var frames: [String] = []
            for frame in exception.frames.reversed() {
                frames.append(frameObject(CrashReportPrivacy.frame(frame), lang: lang))
            }
            parts.append("{ " + DiagnosticsJSON.string("type") + ": "
                + DiagnosticsJSON.string(CrashReportPrivacy.symbol(exception.type))
                + ", " + DiagnosticsJSON.string("value") + ": " + DiagnosticsJSON.string("")
                + ", " + DiagnosticsJSON.string("mechanism") + ": { " + DiagnosticsJSON.string("type") + ": "
                + DiagnosticsJSON.string(mechanism) + ", " + DiagnosticsJSON.string("handled") + ": false, "
                + DiagnosticsJSON.string("synthetic") + ": false }"
                + ", " + DiagnosticsJSON.string("stacktrace") + ": { " + DiagnosticsJSON.string("type") + ": "
                + DiagnosticsJSON.string("raw") + ", " + DiagnosticsJSON.string("frames") + ": ["
                + frames.joined(separator: ", ") + "] } }")
        }
        return "[" + parts.joined(separator: ", ") + "]"
    }

    static func frameObject(_ frame: CrashReportFrame, lang: String) -> String {
        var fields: [String] = [
            DiagnosticsJSON.string("platform") + ": " + DiagnosticsJSON.string("custom"),
            DiagnosticsJSON.string("lang") + ": " + DiagnosticsJSON.string(lang),
            DiagnosticsJSON.string("function") + ": " + DiagnosticsJSON.string(frame.function),
            DiagnosticsJSON.string("resolved") + ": true",
            DiagnosticsJSON.string("in_app") + ": " + (frame.inApp ? "true" : "false"),
        ]
        if !frame.module.isEmpty {
            fields.append(DiagnosticsJSON.string("module") + ": " + DiagnosticsJSON.string(frame.module))
        }
        if !frame.filename.isEmpty {
            fields.append(DiagnosticsJSON.string("filename") + ": " + DiagnosticsJSON.string(frame.filename))
        }
        if frame.line > 0 {
            fields.append(DiagnosticsJSON.string("lineno") + ": " + String(frame.line))
        }
        return "{ " + fields.joined(separator: ", ") + " }"
    }

    /// The release that was running: stored with the record, or MetricKit's version and build. Empty when unknown.
    static func recordedAppVersion(_ payload: DiagnosticsStoredPayload) -> String {
        let version = textField(payload, "appVersion")
        let build = textField(payload, "appBuild")
        if version.isEmpty || build.isEmpty || version.contains("(") { return version }
        return version + " (" + build + ")"
    }

    /// MetricKit re-reports, a launch or more later, an Objective-C exception the uncaught handler already stored.
    /// The same exception name with the stored crash inside MetricKit's reporting window is the same crash.
    static func repeatsUncaughtCrash(_ payload: DiagnosticsStoredPayload, uncaught: [DiagnosticsStoredPayload]) -> Bool {
        if payload.kind != DiagnosticsPayloadKind.crash.rawValue || numberField(payload, "uncaught") > 0.0 { return false }
        let name = textField(payload, "exceptionName")
        let windowStart = numberField(payload, "windowStartMillis")
        if name.isEmpty || windowStart <= 0.0 { return false }
        for crash in uncaught where crash.createdAtMillis >= windowStart && crash.createdAtMillis <= payload.createdAtMillis {
            if capturedExceptions(parseDetail(crash.detailJSON))?.first?.type == name { return true }
        }
        return false
    }

    static func baseProperties(_ payload: DiagnosticsStoredPayload, kind: CrashReportKind,
                               context: CrashReportContext) -> [String] {
        let crashedVersion = CrashReportPrivacy.symbol(recordedAppVersion(payload))
        var properties: [String] = [
            DiagnosticsJSON.string("$lib") + ": " + DiagnosticsJSON.string("conclave-native"),
            DiagnosticsJSON.string("$process_person_profile") + ": false",
            DiagnosticsJSON.string("$geoip_disable") + ": true",
            DiagnosticsJSON.string("$os") + ": " + DiagnosticsJSON.string(context.platform == "ios" ? "iOS" : "Android"),
            DiagnosticsJSON.string("$os_version") + ": " + DiagnosticsJSON.string(context.osVersion),
            DiagnosticsJSON.string("$app_version") + ": "
                + DiagnosticsJSON.string(crashedVersion.isEmpty ? context.appVersion : crashedVersion),
            DiagnosticsJSON.string("platform") + ": " + DiagnosticsJSON.string(context.platform),
            DiagnosticsJSON.string("device_class") + ": " + DiagnosticsJSON.string(context.deviceClass),
            DiagnosticsJSON.string("report_kind") + ": " + DiagnosticsJSON.string(kind.rawValue),
            DiagnosticsJSON.string("diagnostic_kind") + ": " + DiagnosticsJSON.string(payload.kind),
        ]
        for field in payload.fields where DiagnosticsRedactionPolicy.isAllowedKey(field.key) {
            let value: String
            if field.isNumber {
                value = DiagnosticsJSON.number(field.number)
            } else if CrashReportPrivacy.uploadedTextKeys.contains(field.key)
                        && DiagnosticsRedactionPolicy.isAllowedFieldText(field.text) {
                value = DiagnosticsJSON.string(CrashReportPrivacy.symbol(field.text))
            } else {
                continue
            }
            properties.append(DiagnosticsJSON.string("diag_" + field.key) + ": " + value)
        }
        return properties
    }

    static func breadcrumbCodes(_ detail: [String: Any]?) -> [String] {
        guard let list = detail?["breadcrumbs"] as? [Any] else { return [] }
        var codes: [String] = []
        for item in list {
            guard let code = item as? String, DiagnosticsRedactionPolicy.isAllowedCode(code) else { continue }
            codes.append(code)
        }
        while codes.count > maxBreadcrumbs {
            codes.removeFirst()
        }
        return codes
    }

    static func parseDetail(_ json: String) -> [String: Any]? {
        guard DiagnosticsJSON.isRawJSON(json) else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
    }

    static func stringArray(_ values: [String]) -> String {
        var parts: [String] = []
        for value in values {
            parts.append(DiagnosticsJSON.string(value))
        }
        return "[" + parts.joined(separator: ", ") + "]"
    }

    static func textField(_ payload: DiagnosticsStoredPayload, _ key: String) -> String {
        for field in payload.fields where field.key == key && !field.isNumber {
            return field.text
        }
        return ""
    }

    static func numberField(_ payload: DiagnosticsStoredPayload, _ key: String) -> Double {
        for field in payload.fields where field.key == key && field.isNumber {
            return field.number
        }
        return 0.0
    }

    static func intValue(_ value: Any?) -> Int {
        if let number = value as? Int { return number }
        if let number = value as? Double, number.isFinite { return Int(number) }
        if let text = value as? String { return Int(text) ?? 0 }
        return 0
    }
}

/// The crash-time record both platforms' uncaught-exception handlers store, in the shape
/// `CrashReportEventBuilder.capturedExceptions` reads back on the next launch.
enum CrashCaptureRecord {
    static func detailJSON(exceptions: [CrashReportException], breadcrumbs: [String], phase: String) -> String {
        var exceptionParts: [String] = []
        for exception in exceptions {
            var frames: [String] = []
            for frame in exception.frames {
                if frames.count >= CrashReportEventBuilder.maxFrames { break }
                frames.append("{ " + DiagnosticsJSON.string("function") + ": " + DiagnosticsJSON.string(frame.function)
                    + ", " + DiagnosticsJSON.string("module") + ": " + DiagnosticsJSON.string(frame.module)
                    + ", " + DiagnosticsJSON.string("filename") + ": " + DiagnosticsJSON.string(frame.filename)
                    + ", " + DiagnosticsJSON.string("line") + ": " + String(frame.line)
                    + ", " + DiagnosticsJSON.string("inApp") + ": " + (frame.inApp ? "true" : "false") + " }")
            }
            exceptionParts.append("{ " + DiagnosticsJSON.string("type") + ": " + DiagnosticsJSON.string(exception.type)
                + ", " + DiagnosticsJSON.string("frames") + ": [" + frames.joined(separator: ", ") + "] }")
        }
        var codes: [String] = []
        for code in breadcrumbs where DiagnosticsRedactionPolicy.isAllowedCode(code) {
            codes.append(code)
        }
        while codes.count > CrashReportEventBuilder.maxBreadcrumbs {
            codes.removeFirst()
        }
        return "{ " + DiagnosticsJSON.string("exceptions") + ": [" + exceptionParts.joined(separator: ", ") + "], "
            + DiagnosticsJSON.string("breadcrumbs") + ": " + CrashReportEventBuilder.stringArray(codes) + ", "
            + DiagnosticsJSON.string("phase") + ": "
            + DiagnosticsJSON.string(DiagnosticsRedactionPolicy.sanitizedPhase(phase)) + " }"
    }

    /// Parses `callStackSymbols` lines such as `3   Conclave   0x0000000104a2b1c8 symbol + 120`.
    static func symbolFrames(_ symbols: [String]) -> [CrashReportFrame] {
        var result: [CrashReportFrame] = []
        for line in symbols {
            var parts: [String] = []
            for part in line.components(separatedBy: " ") where !part.isEmpty {
                parts.append(part)
            }
            if parts.count < 4 { continue }
            let binary = parts[1]
            var symbolParts: [String] = Array(parts.dropFirst(3))
            if symbolParts.count >= 3 && symbolParts[symbolParts.count - 2] == "+" {
                symbolParts.removeLast(2)
            }
            result.append(CrashReportFrame(function: symbolParts.joined(separator: " "), module: binary, filename: "",
                                           line: 0, inApp: binary.hasPrefix("Conclave")))
        }
        return result
    }

    static func payload(exceptions: [CrashReportException], breadcrumbs: [String], phase: String,
                        createdAtMillis: Double, appVersion: String = "") -> DiagnosticsStoredPayload {
        var fields: [DiagnosticsField] = [DiagnosticsPayloadFactory.number("uncaught", 1.0)]
        if let version = DiagnosticsPayloadFactory.text("appVersion", appVersion) {
            fields.append(version)
        }
        return DiagnosticsPayloadFactory.payload(kind: DiagnosticsPayloadKind.crash, createdAtMillis: createdAtMillis,
                                          fields: fields,
                                          detailJSON: detailJSON(exceptions: exceptions, breadcrumbs: breadcrumbs,
                                                                 phase: phase))
    }
}

struct CrashReportLedgerFile: Codable, Equatable {
    let names: [String]
}

final class CrashReportLedger {
    static let fileName = "reported-payloads.json"

    let store: DiagnosticsFileStore

    init(store: DiagnosticsFileStore) {
        self.store = store
    }

    func reportedNames() -> [String] {
        guard let data = try? Data(contentsOf: store.fileURL(CrashReportLedger.fileName)),
              let file = try? JSONDecoder().decode(CrashReportLedgerFile.self, from: data) else { return [] }
        return file.names
    }

    @discardableResult
    func record(_ names: [String], present: [String]) -> Bool {
        var kept: [String] = []
        for name in reportedNames() where present.contains(name) && !kept.contains(name) {
            kept.append(name)
        }
        for name in names where !kept.contains(name) {
            kept.append(name)
        }
        guard store.ensureDirectory(store.directoryPath),
              let data = try? JSONEncoder().encode(CrashReportLedgerFile(names: kept)) else { return false }
        do {
            try data.write(to: store.fileURL(CrashReportLedger.fileName), options: Data.WritingOptions.atomic)
            return true
        } catch {
            return false
        }
    }
}

struct CrashReportBatch: Equatable {
    let body: String
    let names: [String]
}

enum CrashReportPlanner {
    /// `skipped` lists payloads with nothing worth reporting, so the ledger stops reconsidering them.
    static func plan(_ loaded: [DiagnosticsLoadedPayload], reported: [String], projectKey: String,
                     context: CrashReportContext) -> CrashReportPlan {
        var batches: [CrashReportBatch] = []
        var skipped: [String] = []
        var events: [String] = []
        var names: [String] = []
        var uncaught: [DiagnosticsStoredPayload] = []
        for item in loaded where CrashReportEventBuilder.numberField(item.payload, "uncaught") > 0.0 {
            uncaught.append(item.payload)
        }
        for item in loaded where !reported.contains(item.name) {
            if CrashReportEventBuilder.repeatsUncaughtCrash(item.payload, uncaught: uncaught) {
                skipped.append(item.name)
                continue
            }
            guard let event = CrashReportEventBuilder.event(
                for: item.payload,
                eventId: CrashReportEventBuilder.eventId(forPayloadName: item.name),
                context: context
            ) else {
                skipped.append(item.name)
                continue
            }
            events.append(event)
            names.append(item.name)
            if events.count >= CrashReportingPolicy.batchLimit {
                batches.append(CrashReportBatch(body: CrashReportEventBuilder.batch(projectKey: projectKey, events: events),
                                                names: names))
                events = []
                names = []
            }
        }
        if !events.isEmpty {
            batches.append(CrashReportBatch(body: CrashReportEventBuilder.batch(projectKey: projectKey, events: events),
                                            names: names))
        }
        return CrashReportPlan(batches: batches, skipped: skipped)
    }
}

struct CrashReportPlan: Equatable {
    let batches: [CrashReportBatch]
    let skipped: [String]
}
