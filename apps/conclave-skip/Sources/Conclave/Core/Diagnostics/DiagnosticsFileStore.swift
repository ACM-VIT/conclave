import Foundation

/// S70 15 c, k: the bounded local diagnostics store and the export writer. Transpiled. Every method does blocking file
/// I/O, so callers run it off the main thread (detached tasks in `CallDiagnostics`, the MetricKit delivery queue, the
/// Android exit-reason thread). Each record is one atomically written file, so concurrent writers never share a file;
/// the store holds no mutable state.
///
/// Layout: `<Application Support>/ConclaveDiagnostics/` keeps `payload-<uuid>.json` (one MetricKit diagnostic or exit
/// record), `breadcrumbs.json` (the ring, written on background) and `breadcrumbs-previous.json` (the last process's
/// ring, rotated at launch). Exports go to `<Caches>/exports/diagnostics/` (the Android FileProvider `exports` path in
/// res/xml/conclave_file_paths.xml covers it); only the newest export is kept.
final class DiagnosticsFileStore {
    static let payloadPrefix = "payload-"
    static let breadcrumbsName = "breadcrumbs.json"
    static let previousBreadcrumbsName = "breadcrumbs-previous.json"
    static let exportPrefix = "conclave-diagnostics-"
    static let directoryName = "ConclaveDiagnostics"

    let directoryPath: String
    let exportDirectoryPath: String

    init(directoryPath: String, exportDirectoryPath: String) {
        self.directoryPath = directoryPath
        self.exportDirectoryPath = exportDirectoryPath
    }

    /// The app's store (Application Support is the Android files directory; Caches is the Android cache directory).
    static func standard() -> DiagnosticsFileStore {
        let base = URL.applicationSupportDirectory.appendingPathComponent(DiagnosticsFileStore.directoryName,
                                                                           isDirectory: true)
        let exports = URL.cachesDirectory
            .appendingPathComponent("exports", isDirectory: true)
            .appendingPathComponent("diagnostics", isDirectory: true)
        return DiagnosticsFileStore(directoryPath: base.path, exportDirectoryPath: exports.path)
    }

    /// `conclave-diagnostics-20261028-142233.json`: a time stamp only, never a room or a name.
    static func exportName(epochMillis: Double) -> String {
        DiagnosticsFileStore.exportPrefix + DiagnosticsTimePolicy.fileStamp(epochMillis: epochMillis) + ".json"
    }

    func fileURL(_ name: String) -> URL {
        URL(fileURLWithPath: directoryPath).appendingPathComponent(name)
    }

    func ensureDirectory(_ path: String) -> Bool {
        do {
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: nil)
            return true
        } catch {
            return false
        }
    }

    // MARK: Payloads

    /// Stores one payload (structurally clean ones only) and applies the retention policy. Returns false when nothing
    /// was written.
    @discardableResult
    func writePayload(_ payload: DiagnosticsStoredPayload) -> Bool {
        guard DiagnosticsRedactionPolicy.isClean(payload) else { return false }
        guard ensureDirectory(directoryPath), let data = try? JSONEncoder().encode(payload) else { return false }
        let name = DiagnosticsFileStore.payloadPrefix + UUID().uuidString + ".json"
        do {
            try data.write(to: fileURL(name), options: Data.WritingOptions.atomic)
        } catch {
            return false
        }
        prune(nowMillis: DiagnosticsClock.wallMillis())
        return true
    }

    /// Every readable payload, oldest first. A file that no longer decodes is deleted.
    func loadPayloads() -> [DiagnosticsLoadedPayload] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directoryPath) else { return [] }
        var result: [DiagnosticsLoadedPayload] = []
        for name in names where name.hasPrefix(DiagnosticsFileStore.payloadPrefix) && name.hasSuffix(".json") {
            guard let data = try? Data(contentsOf: fileURL(name)) else { continue }
            if let payload = try? JSONDecoder().decode(DiagnosticsStoredPayload.self, from: data) {
                result.append(DiagnosticsLoadedPayload(name: name, byteCount: data.count, payload: payload))
            } else {
                try? FileManager.default.removeItem(at: fileURL(name))
            }
        }
        return result.sorted { lhs, rhs in
            if lhs.payload.createdAtMillis == rhs.payload.createdAtMillis { return lhs.name < rhs.name }
            return lhs.payload.createdAtMillis < rhs.payload.createdAtMillis
        }
    }

    /// Applies 7 days or 2 MB (the breadcrumb files count toward the cap) and returns what is kept, oldest first.
    @discardableResult
    func prune(nowMillis: Double) -> [DiagnosticsLoadedPayload] {
        let loaded = loadPayloads()
        var records: [DiagnosticsStoredRecord] = []
        for item in loaded {
            records.append(DiagnosticsStoredRecord(name: item.name, createdAtMillis: item.payload.createdAtMillis,
                                                   byteCount: item.byteCount))
        }
        let doomed = DiagnosticsRetentionPolicy.namesToDelete(records, nowMillis: nowMillis, reservedBytes: breadcrumbBytes())
        var kept: [DiagnosticsLoadedPayload] = []
        for item in loaded {
            if doomed.contains(item.name) {
                try? FileManager.default.removeItem(at: fileURL(item.name))
            } else {
                kept.append(item)
            }
        }
        return kept
    }

    // MARK: Breadcrumbs

    /// The ring, flushed on background.
    @discardableResult
    func writeBreadcrumbs(_ file: DiagnosticsBreadcrumbFile) -> Bool {
        guard ensureDirectory(directoryPath), let data = try? JSONEncoder().encode(file) else { return false }
        do {
            try data.write(to: fileURL(DiagnosticsFileStore.breadcrumbsName), options: Data.WritingOptions.atomic)
            return true
        } catch {
            return false
        }
    }

    func readBreadcrumbs(_ name: String) -> DiagnosticsBreadcrumbFile? {
        guard let data = try? Data(contentsOf: fileURL(name)) else { return nil }
        return try? JSONDecoder().decode(DiagnosticsBreadcrumbFile.self, from: data)
    }

    /// At launch (off the main thread): the last process's ring becomes `breadcrumbs-previous.json`, the store is
    /// pruned, and the previous ring is returned unless it is older than the retention window (then it is deleted).
    func launchHousekeeping(nowMillis: Double) -> DiagnosticsBreadcrumbFile? {
        let current = fileURL(DiagnosticsFileStore.breadcrumbsName)
        let previous = fileURL(DiagnosticsFileStore.previousBreadcrumbsName)
        if FileManager.default.fileExists(atPath: current.path) {
            try? FileManager.default.removeItem(at: previous)
            try? FileManager.default.moveItem(at: current, to: previous)
        }
        prune(nowMillis: nowMillis)
        guard let file = readBreadcrumbs(DiagnosticsFileStore.previousBreadcrumbsName) else { return nil }
        if nowMillis - file.writtenAtMillis > DiagnosticsLimits.retentionMillis {
            try? FileManager.default.removeItem(at: previous)
            return nil
        }
        return file
    }

    private func breadcrumbBytes() -> Int {
        var total = 0
        for name in [DiagnosticsFileStore.breadcrumbsName, DiagnosticsFileStore.previousBreadcrumbsName] {
            if let data = try? Data(contentsOf: fileURL(name)) {
                total += data.count
            }
        }
        return total
    }

    // MARK: Export

    /// S70 15 f: prunes, runs the redaction check (refused: no file is written), writes one JSON file and keeps only the
    /// newest export. Always writes the metadata, even with no events.
    func export(_ input: DiagnosticsExportInput) -> DiagnosticsExportOutcome {
        let kept = prune(nowMillis: input.exportedAtMillis)
        var payloads: [DiagnosticsStoredPayload] = []
        for item in kept {
            payloads.append(item.payload)
        }
        guard DiagnosticsExportBuilder.passesRedactionCheck(input, payloads: payloads) else {
            return DiagnosticsExportOutcome(path: "", failure: DiagnosticsExportFailure.redactionCheckFailed)
        }
        let document = DiagnosticsExportBuilder.document(input, payloads: payloads)
        guard ensureDirectory(exportDirectoryPath), let data = document.data(using: String.Encoding.utf8) else {
            return DiagnosticsExportOutcome(path: "", failure: DiagnosticsExportFailure.writeFailed)
        }
        removeExports()
        let target = URL(fileURLWithPath: exportDirectoryPath)
            .appendingPathComponent(DiagnosticsFileStore.exportName(epochMillis: input.exportedAtMillis))
        do {
            try data.write(to: target, options: Data.WritingOptions.atomic)
        } catch {
            return DiagnosticsExportOutcome(path: "", failure: DiagnosticsExportFailure.writeFailed)
        }
        return DiagnosticsExportOutcome(path: target.path, failure: DiagnosticsExportFailure.none)
    }

    /// Deletes earlier diagnostics exports (never another feature's files in the shared exports folder).
    func removeExports() {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: exportDirectoryPath) else { return }
        for name in names where name.hasPrefix(DiagnosticsFileStore.exportPrefix) {
            try? FileManager.default.removeItem(at: URL(fileURLWithPath: exportDirectoryPath).appendingPathComponent(name))
        }
    }
}
