import Foundation

// S70 15 (SYS-15): the pure diagnostics policies, transpiled and unit tested on both platforms (T/SYS15DiagnosticsTests,
// T/Skip/SYS15DiagnosticsBridgeTests). No platform import, no I/O.

/// S70 15 j: structural redaction. A code is `domain.detail[.detail]` with a domain from a fixed list and identifier
/// segments (letters, digits, underscore), so a room code (it has dashes), a link, a sentence or a message cannot pass;
/// phases and details come from fixed vocabularies; payload texts are short version-like tokens. A value that fails is
/// replaced by a fixed code or dropped, never stored. Redaction markers (room code, names, ids) are read only at export
/// time to withhold any platform detail blob that happens to contain one.
enum DiagnosticsRedactionPolicy {
    /// Code domains: the S70 7 classifier's (`android`, `capture`, `http`, `media`, `message`, `socket`, `task`, `url`)
    /// plus the diagnostics vocabulary.
    static let codeDomains: [String] = [
        "android", "app", "audio", "call", "capture", "crash", "diag", "exit", "frame", "hang", "http", "join",
        "lifecycle", "links", "media", "message", "metric", "phase", "pip", "recovery", "rejoin", "route", "share",
        "socket", "span", "task", "test", "url",
    ]
    /// Phases beyond `CallPresencePhase`.
    static let extraPhases: [String] = ["launch", "background", "other"]
    static let identifierCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_"
    static let fieldTextCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._()/:+,-"
    /// What a rejected code is stored as.
    static let rejectedCode = "diag.rejectedCode"
    static let otherPhase = "other"

    static func isIdentifier(_ text: String) -> Bool {
        if text.isEmpty { return false }
        for character in text {
            if !identifierCharacters.contains(character) {
                return false
            }
        }
        return true
    }

    static func isAllowedCode(_ code: String) -> Bool {
        if code.isEmpty || code.count > DiagnosticsLimits.maxCodeLength { return false }
        let segments = code.components(separatedBy: ".")
        if segments.count < 2 { return false }
        if !codeDomains.contains(segments[0]) { return false }
        for segment in segments {
            if !isIdentifier(segment) { return false }
        }
        return true
    }

    static func sanitizedCode(_ code: String) -> String {
        isAllowedCode(code) ? code : rejectedCode
    }

    static func isAllowedPhase(_ phase: String) -> Bool {
        if CallPresencePhase(rawValue: phase) != nil { return true }
        return extraPhases.contains(phase)
    }

    static func sanitizedPhase(_ phase: String) -> String {
        isAllowedPhase(phase) ? phase : otherPhase
    }

    /// A breadcrumb detail: "", a `MeetingErrorContext` raw value, or a code (a span outcome).
    static func isAllowedDetail(_ detail: String) -> Bool {
        if detail.isEmpty { return true }
        if MeetingErrorContext(rawValue: detail) != nil { return true }
        return isAllowedCode(detail)
    }

    /// A field or counter key: dot-separated identifiers, at most 64 characters.
    static func isAllowedKey(_ key: String) -> Bool {
        if key.isEmpty || key.count > DiagnosticsLimits.maxCodeLength { return false }
        for segment in key.components(separatedBy: ".") {
            if !isIdentifier(segment) { return false }
        }
        return true
    }

    /// A payload text: a short version-like token ("iPhone OS 17.5 (21F79)", "arm64e", "anr").
    static func isAllowedFieldText(_ text: String) -> Bool {
        if text.count > DiagnosticsLimits.maxFieldTextLength { return false }
        for character in text {
            if !fieldTextCharacters.contains(character) {
                return false
            }
        }
        return true
    }

    /// The text when it is an allowed field text, else "".
    static func sanitizedFieldText(_ text: String) -> String {
        isAllowedFieldText(text) ? text : ""
    }

    /// The `Logger` category for a code (S70 15 c).
    static func category(forCode code: String) -> DiagnosticsLogCategory {
        let domain = code.components(separatedBy: ".").first ?? ""
        switch domain {
        case "audio", "route", "media":
            return DiagnosticsLogCategory.audio
        case "pip":
            return DiagnosticsLogCategory.pip
        case "recovery", "rejoin":
            return DiagnosticsLogCategory.recovery
        case "links":
            return DiagnosticsLogCategory.links
        case "share", "capture":
            return DiagnosticsLogCategory.share
        default:
            return DiagnosticsLogCategory.call
        }
    }

    /// Normalized redaction markers: trimmed, lowercased, unique, at least `minimumMarkerLength` characters.
    static func markers(_ values: [String]) -> [String] {
        var result: [String] = []
        for value in values {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if trimmed.count < DiagnosticsLimits.minimumMarkerLength { continue }
            if !result.contains(trimmed) {
                result.append(trimmed)
            }
        }
        return result
    }

    /// Whether `text` contains a normalized marker (case-insensitive).
    static func containsMarker(_ text: String, markers: [String]) -> Bool {
        if markers.isEmpty || text.isEmpty { return false }
        let lowered = text.lowercased()
        for marker in markers where lowered.contains(marker) {
            return true
        }
        return false
    }

    /// A ring entry passes the structural check.
    static func isClean(_ event: DiagnosticsBreadcrumb) -> Bool {
        isAllowedCode(event.code) && isAllowedPhase(event.phase) && DiagnosticsEventKind(rawValue: event.kind) != nil
            && isAllowedDetail(event.detail)
    }

    /// A stored payload passes the structural check (kind, keys, texts). Markers never fail a payload; they withhold.
    static func isClean(_ payload: DiagnosticsStoredPayload) -> Bool {
        if DiagnosticsPayloadKind(rawValue: payload.kind) == nil { return false }
        for field in payload.fields {
            if !isAllowedKey(field.key) { return false }
            if !field.isNumber && !isAllowedFieldText(field.text) { return false }
        }
        return true
    }
}

/// The 200-event breadcrumb ring (S70 15 c). Owned by the main-actor facade; never observed.
final class DiagnosticsBreadcrumbRing {
    let capacity: Int
    private var items: [DiagnosticsBreadcrumb] = []
    /// The oldest entry's index once the ring is full.
    private var head = 0
    /// Entries overwritten since the process started (storage cap reached, oldest dropped).
    private(set) var droppedCount = 0

    init(capacity: Int) {
        self.capacity = capacity < 1 ? 1 : capacity
    }

    var count: Int { items.count }

    func append(_ item: DiagnosticsBreadcrumb) {
        if items.count < capacity {
            items.append(item)
            return
        }
        items[head] = item
        head = (head + 1) % capacity
        droppedCount += 1
    }

    /// Oldest first.
    func snapshot() -> [DiagnosticsBreadcrumb] {
        if items.count < capacity || head == 0 { return items }
        var result: [DiagnosticsBreadcrumb] = []
        var index = head
        for _ in 0..<items.count {
            result.append(items[index])
            index = (index + 1) % capacity
        }
        return result
    }
}

/// The local store's bounds (S70 15 c): 7 days or 2 MB, oldest dropped first.
enum DiagnosticsRetentionPolicy {
    /// The names to delete: every record older than the retention window, then the oldest of the rest until they fit
    /// the cap together with `reservedBytes` (the breadcrumb files). Ties break by name so the order is stable.
    static func namesToDelete(_ records: [DiagnosticsStoredRecord], nowMillis: Double, reservedBytes: Int = 0,
                              retentionMillis: Double = DiagnosticsLimits.retentionMillis,
                              maxBytes: Int = DiagnosticsLimits.maxStoreBytes) -> [String] {
        let sorted = records.sorted { lhs, rhs in
            if lhs.createdAtMillis == rhs.createdAtMillis { return lhs.name < rhs.name }
            return lhs.createdAtMillis < rhs.createdAtMillis
        }
        var deleted: [String] = []
        var kept: [DiagnosticsStoredRecord] = []
        for record in sorted {
            if nowMillis - record.createdAtMillis > retentionMillis {
                deleted.append(record.name)
            } else {
                kept.append(record)
            }
        }
        var total = reservedBytes
        for record in kept {
            total += record.byteCount
        }
        var index = 0
        while total > maxBytes && index < kept.count {
            deleted.append(kept[index].name)
            total -= kept[index].byteCount
            index += 1
        }
        return deleted
    }
}

/// UTC time stamps from epoch milliseconds without a formatter (identical output on both platforms).
enum DiagnosticsTimePolicy {
    /// `2026-10-28T14:22:33Z`.
    static func iso8601(epochMillis: Double) -> String {
        let parts = civilParts(epochMillis: epochMillis)
        return padded(parts[0], width: 4) + "-" + padded(parts[1], width: 2) + "-" + padded(parts[2], width: 2) + "T"
            + padded(parts[3], width: 2) + ":" + padded(parts[4], width: 2) + ":" + padded(parts[5], width: 2) + "Z"
    }

    /// `20261028-142233`, for the export file name.
    static func fileStamp(epochMillis: Double) -> String {
        let parts = civilParts(epochMillis: epochMillis)
        return padded(parts[0], width: 4) + padded(parts[1], width: 2) + padded(parts[2], width: 2) + "-"
            + padded(parts[3], width: 2) + padded(parts[4], width: 2) + padded(parts[5], width: 2)
    }

    /// Year, month, day, hour, minute, second (UTC). Negative or non-finite input reads as the epoch.
    static func civilParts(epochMillis: Double) -> [Int] {
        let clamped = epochMillis.isFinite && epochMillis > 0.0 ? epochMillis : 0.0
        let seconds = Int64(clamped / 1000.0)
        let days = Int(seconds / Int64(86_400))
        let secondOfDay = Int(seconds % Int64(86_400))
        // Days to the proleptic Gregorian civil date (era-based, valid for every non-negative day count).
        let shifted = days + 719_468
        let era = shifted / 146_097
        let dayOfEra = shifted - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let monthPrime = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * monthPrime + 2) / 5 + 1
        let month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9
        let year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
        return [year, month, day, secondOfDay / 3_600, (secondOfDay % 3_600) / 60, secondOfDay % 60]
    }

    static func padded(_ value: Int, width: Int) -> String {
        var text = "\(value)"
        while text.count < width {
            text = "0" + text
        }
        return text
    }
}

/// Minimal JSON emission for the export. Every string it writes is already a code, an enum raw value or an allowed
/// field text; escaping is defensive.
enum DiagnosticsJSON {
    static func string(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\t", with: "\\t")
        return "\"" + escaped + "\""
    }

    /// Whole numbers without a fraction; non-finite values as 0.
    static func number(_ value: Double) -> String {
        if !value.isFinite { return "0" }
        let rounded = value.rounded()
        if rounded == value && rounded > -9.0e15 && rounded < 9.0e15 {
            return "\(Int64(rounded))"
        }
        return "\(value)"
    }

    /// Platform JSON (an object or an array) that can be embedded as is.
    static func isRawJSON(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{") && trimmed.hasSuffix("}") { return true }
        return trimmed.hasPrefix("[") && trimmed.hasSuffix("]")
    }
}

/// Builds payload records with only allowed keys and texts (iOS MetricKit conversion, Android exit records).
enum DiagnosticsPayloadFactory {
    static func number(_ key: String, _ value: Double) -> DiagnosticsField {
        DiagnosticsField(key: key, isNumber: true, number: value.isFinite ? value : 0.0, text: "")
    }

    /// nil when the key or the text is not allowed (the field is then not stored).
    static func text(_ key: String, _ value: String) -> DiagnosticsField? {
        if !DiagnosticsRedactionPolicy.isAllowedKey(key) || value.isEmpty { return nil }
        if !DiagnosticsRedactionPolicy.isAllowedFieldText(value) { return nil }
        return DiagnosticsField(key: key, isNumber: false, number: 0.0, text: value)
    }

    /// Keeps only allowed fields; a detail that is not an object or an array is dropped.
    static func payload(kind: DiagnosticsPayloadKind, createdAtMillis: Double, fields: [DiagnosticsField],
                        detailJSON: String) -> DiagnosticsStoredPayload {
        var clean: [DiagnosticsField] = []
        for field in fields where DiagnosticsRedactionPolicy.isAllowedKey(field.key) {
            if field.isNumber || DiagnosticsRedactionPolicy.isAllowedFieldText(field.text) {
                clean.append(field)
            }
        }
        let detail = DiagnosticsJSON.isRawJSON(detailJSON) ? detailJSON : ""
        return DiagnosticsStoredPayload(kind: kind.rawValue, createdAtMillis: createdAtMillis, fields: clean,
                                        detailJSON: detail)
    }

    /// Android API 30 `ApplicationExitInfo` (S70 15 d), called from K/NativePerformanceDiagnostics.kt off the main
    /// thread: reason name, timestamp, importance, status, memory, the stamped call session and phase from
    /// `setProcessStateSummary`, and for an ANR the sanitized trace frames (`traceJSON`, or "").
    static func exitRecord(reason: String, timestampMillis: Double, importance: Int, status: Int, pssKb: Double,
                           rssKb: Double, summarySession: Int, summaryPhase: String,
                           traceJSON: String) -> DiagnosticsStoredPayload {
        var fields: [DiagnosticsField] = [
            number("importance", Double(importance)),
            number("status", Double(status)),
            number("pssKb", pssKb),
            number("rssKb", rssKb),
            number("summarySession", Double(summarySession)),
        ]
        if let reasonField = text("reason", reason) {
            fields.append(reasonField)
        }
        if DiagnosticsRedactionPolicy.isAllowedPhase(summaryPhase), let phaseField = text("summaryPhase", summaryPhase) {
            fields.append(phaseField)
        }
        return payload(kind: DiagnosticsPayloadKind.exitReason, createdAtMillis: timestampMillis, fields: fields,
                       detailJSON: traceJSON)
    }
}

/// The join milestones that the view model already times through `PerformanceDiagnostics.timing` (S70 15 c): only the
/// timing name is read, never its details (they can hold the room code).
enum DiagnosticsTimingBridge {
    static func milestone(forTiming name: String) -> DiagnosticsMilestone? {
        switch name {
        case "join_fetch_info":
            return DiagnosticsMilestone.tokenFetched
        case "join_socket_connect":
            return DiagnosticsMilestone.socketConnected
        case "join_webrtc_configure":
            return DiagnosticsMilestone.transportConfigured
        case "join_start_producing":
            return DiagnosticsMilestone.producerCreated
        case "join_socket_join_room":
            return DiagnosticsMilestone.joinedResponse
        default:
            return nil
        }
    }
}

/// The export document (S70 15 f): one JSON file with metadata (always written), counters, open spans, the ring, the
/// previous process's ring and the stored payloads. No upload, no account link (S70 O8).
enum DiagnosticsExportBuilder {
    static let format = "conclave-diagnostics"
    static let version = 1
    /// What a withheld detail reads as.
    static let withheld = "withheld"

    /// S70 15 f: the structural redaction check. Fails (export refused, no file) when any event, span, counter or
    /// payload is outside the vocabularies, or when the Debug fixture forces it (15 l5).
    static func passesRedactionCheck(_ input: DiagnosticsExportInput, payloads: [DiagnosticsStoredPayload]) -> Bool {
        if input.forcesRedactionFailure { return false }
        for event in input.events where !DiagnosticsRedactionPolicy.isClean(event) {
            return false
        }
        for event in input.previousEvents where !DiagnosticsRedactionPolicy.isClean(event) {
            return false
        }
        for span in input.openSpans where DiagnosticsSpanKind(rawValue: span.kind) == nil {
            return false
        }
        for counter in input.counters where !DiagnosticsRedactionPolicy.isAllowedKey(counter.key) {
            return false
        }
        let info = input.info
        for text in [info.platform, info.appVersion, info.osVersion, info.deviceClass] {
            if !DiagnosticsRedactionPolicy.isAllowedFieldText(text) { return false }
        }
        for payload in payloads where !DiagnosticsRedactionPolicy.isClean(payload) {
            return false
        }
        return true
    }

    /// The payload with any field text or detail that contains a marker withheld.
    static func redacted(_ payload: DiagnosticsStoredPayload, markers: [String]) -> DiagnosticsStoredPayload {
        var fields: [DiagnosticsField] = []
        for field in payload.fields {
            if !field.isNumber && DiagnosticsRedactionPolicy.containsMarker(field.text, markers: markers) {
                fields.append(DiagnosticsField(key: field.key, isNumber: false, number: 0.0,
                                               text: DiagnosticsExportBuilder.withheld))
            } else {
                fields.append(field)
            }
        }
        let withholdsDetail = DiagnosticsRedactionPolicy.containsMarker(payload.detailJSON, markers: markers)
        return DiagnosticsStoredPayload(kind: payload.kind, createdAtMillis: payload.createdAtMillis, fields: fields,
                                        detailJSON: withholdsDetail ? "" : payload.detailJSON)
    }

    /// How many payloads lose a field or their detail to a marker.
    static func withheldCount(_ payloads: [DiagnosticsStoredPayload], markers: [String]) -> Int {
        var count = 0
        for payload in payloads where redacted(payload, markers: markers) != payload {
            count += 1
        }
        return count
    }

    static func document(_ input: DiagnosticsExportInput, payloads: [DiagnosticsStoredPayload]) -> String {
        var cleanPayloads: [DiagnosticsStoredPayload] = []
        for payload in payloads {
            cleanPayloads.append(redacted(payload, markers: input.markers))
        }
        var counters = input.counters
        counters.append(DiagnosticsCounter(key: "diag.withheldPayloads",
                                           value: Double(withheldCount(payloads, markers: input.markers))))
        var out = "{\n"
        out += "  \"format\": " + DiagnosticsJSON.string(DiagnosticsExportBuilder.format) + ",\n"
        out += "  \"version\": \(DiagnosticsExportBuilder.version),\n"
        out += "  \"metadata\": " + metadata(input, payloads: cleanPayloads) + ",\n"
        out += "  \"counters\": " + counterObject(counters) + ",\n"
        out += "  \"openSpans\": " + spanList(input.openSpans, monotonicNowMillis: input.monotonicNowMillis) + ",\n"
        out += "  \"events\": " + eventList(input.events) + ",\n"
        out += "  \"previousEvents\": " + previousObject(input) + ",\n"
        out += "  \"payloads\": " + payloadList(cleanPayloads) + "\n"
        out += "}\n"
        return out
    }

    static func metadata(_ input: DiagnosticsExportInput, payloads: [DiagnosticsStoredPayload]) -> String {
        var windowStart = input.launchedAtMillis > 0.0 ? input.launchedAtMillis : input.exportedAtMillis
        if !input.previousEvents.isEmpty && input.previousWrittenAtMillis > 0.0 && input.previousWrittenAtMillis < windowStart {
            windowStart = input.previousWrittenAtMillis
        }
        for payload in payloads where payload.createdAtMillis > 0.0 && payload.createdAtMillis < windowStart {
            windowStart = payload.createdAtMillis
        }
        let info = input.info
        var parts: [String] = []
        parts.append("\"platform\": " + DiagnosticsJSON.string(DiagnosticsRedactionPolicy.sanitizedFieldText(info.platform)))
        parts.append("\"appVersion\": " + DiagnosticsJSON.string(DiagnosticsRedactionPolicy.sanitizedFieldText(info.appVersion)))
        parts.append("\"osVersion\": " + DiagnosticsJSON.string(DiagnosticsRedactionPolicy.sanitizedFieldText(info.osVersion)))
        parts.append("\"deviceClass\": " + DiagnosticsJSON.string(DiagnosticsRedactionPolicy.sanitizedFieldText(info.deviceClass)))
        parts.append("\"exportedAt\": " + DiagnosticsJSON.string(DiagnosticsTimePolicy.iso8601(epochMillis: input.exportedAtMillis)))
        parts.append("\"captureWindowStart\": " + DiagnosticsJSON.string(DiagnosticsTimePolicy.iso8601(epochMillis: windowStart)))
        parts.append("\"captureWindowEnd\": " + DiagnosticsJSON.string(DiagnosticsTimePolicy.iso8601(epochMillis: input.exportedAtMillis)))
        parts.append("\"eventCapacity\": \(DiagnosticsLimits.breadcrumbCapacity)")
        parts.append("\"retentionDays\": 7")
        parts.append("\"storeCapBytes\": \(DiagnosticsLimits.maxStoreBytes)")
        parts.append("\"remoteUpload\": false")
        return "{ " + parts.joined(separator: ", ") + " }"
    }

    static func counterObject(_ counters: [DiagnosticsCounter]) -> String {
        var parts: [String] = []
        for counter in counters where DiagnosticsRedactionPolicy.isAllowedKey(counter.key) {
            parts.append(DiagnosticsJSON.string(counter.key) + ": " + DiagnosticsJSON.number(counter.value))
        }
        return "{ " + parts.joined(separator: ", ") + " }"
    }

    static func spanList(_ spans: [DiagnosticsSpanToken], monotonicNowMillis: Double) -> String {
        var parts: [String] = []
        for span in spans {
            let age = monotonicNowMillis - span.startedAtMillis
            parts.append("{ \"name\": " + DiagnosticsJSON.string(span.kind) + ", \"attempt\": \(span.callSession), \"ageMillis\": "
                + DiagnosticsJSON.number(age > 0.0 ? age : 0.0) + " }")
        }
        if parts.isEmpty { return "[]" }
        return "[\n    " + parts.joined(separator: ",\n    ") + "\n  ]"
    }

    static func eventObject(_ event: DiagnosticsBreadcrumb) -> String {
        var text = "{ \"code\": " + DiagnosticsJSON.string(event.code) + ", \"phase\": " + DiagnosticsJSON.string(event.phase)
            + ", \"kind\": " + DiagnosticsJSON.string(event.kind) + ", \"atMillis\": " + DiagnosticsJSON.number(event.atMillis)
            + ", \"attempt\": \(event.attempt)"
        if event.durationMillis >= 0.0 {
            text += ", \"durationMillis\": " + DiagnosticsJSON.number(event.durationMillis)
        }
        if !event.detail.isEmpty {
            text += ", \"detail\": " + DiagnosticsJSON.string(event.detail)
        }
        return text + " }"
    }

    static func eventList(_ events: [DiagnosticsBreadcrumb]) -> String {
        var parts: [String] = []
        for event in events {
            parts.append(eventObject(event))
        }
        if parts.isEmpty { return "[]" }
        return "[\n    " + parts.joined(separator: ",\n    ") + "\n  ]"
    }

    static func previousObject(_ input: DiagnosticsExportInput) -> String {
        let writtenAt = input.previousEvents.isEmpty || input.previousWrittenAtMillis <= 0.0
            ? "" : DiagnosticsTimePolicy.iso8601(epochMillis: input.previousWrittenAtMillis)
        return "{ \"writtenAt\": " + DiagnosticsJSON.string(writtenAt) + ", \"events\": " + eventList(input.previousEvents) + " }"
    }

    static func payloadObject(_ payload: DiagnosticsStoredPayload) -> String {
        var fields: [String] = []
        for field in payload.fields {
            let value = field.isNumber ? DiagnosticsJSON.number(field.number) : DiagnosticsJSON.string(field.text)
            fields.append(DiagnosticsJSON.string(field.key) + ": " + value)
        }
        var detail = DiagnosticsJSON.string(DiagnosticsExportBuilder.withheld)
        if payload.detailJSON.isEmpty {
            detail = "null"
        } else if DiagnosticsJSON.isRawJSON(payload.detailJSON) {
            detail = payload.detailJSON
        }
        return "{ \"kind\": " + DiagnosticsJSON.string(payload.kind) + ", \"createdAt\": "
            + DiagnosticsJSON.string(DiagnosticsTimePolicy.iso8601(epochMillis: payload.createdAtMillis))
            + ", \"fields\": { " + fields.joined(separator: ", ") + " }, \"detail\": " + detail + " }"
    }

    static func payloadList(_ payloads: [DiagnosticsStoredPayload]) -> String {
        var parts: [String] = []
        for payload in payloads {
            parts.append(payloadObject(payload))
        }
        if parts.isEmpty { return "[]" }
        return "[\n    " + parts.joined(separator: ",\n    ") + "\n  ]"
    }
}
