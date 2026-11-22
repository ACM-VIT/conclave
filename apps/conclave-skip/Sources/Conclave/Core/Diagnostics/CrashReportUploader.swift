import Foundation

protocol CrashReportTransport {
    func send(endpoint: String, body: String) async -> Bool
}

#if SKIP
private struct AndroidCrashReportHTTPResponse: Decodable {
    let statusCode: Int
    let body: String
}
#endif

struct CrashReportHTTPTransport: CrashReportTransport {
    func send(endpoint: String, body: String) async -> Bool {
        #if SKIP
        do {
            let raw: String = try await withCheckedThrowingContinuation { continuation in
                var didResume = false
                AndroidNativeHttpClient.requestJson(
                    method: "POST",
                    url: endpoint,
                    body: body,
                    accept: "application/json",
                    contentType: "application/json",
                    origin: nil,
                    clientId: nil,
                    cookieHeader: nil
                ) { response, errorMessage in
                    guard !didResume else { return }
                    didResume = true
                    if let response, errorMessage == nil {
                        continuation.resume(returning: response)
                    } else {
                        continuation.resume(throwing: SfuJoinErrorResponse(message: errorMessage ?? "Crash report upload failed."))
                    }
                }
            }
            let envelope = try JSONDecoder().decode(AndroidCrashReportHTTPResponse.self, from: Data(raw.utf8))
            return envelope.statusCode >= 200 && envelope.statusCode <= 299
        } catch {
            return false
        }
        #else
        guard let url = URL(string: endpoint) else { return false }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(body.utf8)
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            return statusCode >= 200 && statusCode <= 299
        } catch {
            return false
        }
        #endif
    }
}

enum CrashReporting {
    static let installIdKey = "conclave.crashReports.installId"
    static let launchDelayMillis = 5_000

    static func currentConfig(defaults: UserDefaults = UserDefaults.standard) -> CrashReportingConfig {
        let isDebug = DiagnosticsBuild.isDebug
        return CrashReportingConfig(
            projectKey: configuredValue(CrashReportingPolicy.projectKeyKey) ?? "",
            host: configuredValue(CrashReportingPolicy.hostKey) ?? "",
            isDebugBuild: isDebug,
            debugOptIn: NativeRuntimeConfig.isDebugViewerProfileEnabled(
                configuredValue: configuredValue(CrashReportingPolicy.debugOptInKey),
                debugEligible: isDebug
            ),
            userAllows: SettingsPreferences.shareCrashReports(defaults: defaults)
        )
    }

    static func configuredValue(_ key: String) -> String? {
        #if DEBUG && !SKIP
        if let value = NativeRuntimeConfig.debugLaunchValue(forKey: key) {
            return value
        }
        #endif
        return NativeRuntimeConfig.bundledString(forKey: key)
    }

    /// Random and never tied to an account; it only lets PostHog count affected installs.
    static func installId(defaults: UserDefaults = UserDefaults.standard) -> String {
        if let existing = defaults.string(forKey: installIdKey), !existing.isEmpty {
            return existing
        }
        let created = UUID().uuidString.lowercased()
        defaults.set(created, forKey: installIdKey)
        return created
    }

    static func context(info: DiagnosticsPlatformInfo, installId: String) -> CrashReportContext {
        CrashReportContext(
            installId: installId,
            platform: DiagnosticsRedactionPolicy.sanitizedFieldText(info.platform),
            appVersion: DiagnosticsRedactionPolicy.sanitizedFieldText(info.appVersion),
            osVersion: DiagnosticsRedactionPolicy.sanitizedFieldText(info.osVersion),
            deviceClass: DiagnosticsRedactionPolicy.sanitizedFieldText(info.deviceClass)
        )
    }

    static func scheduleUpload(diagnostics: CallDiagnostics? = nil, afterMillis: Int = CrashReporting.launchDelayMillis) {
        Task { @MainActor in
            if CrashReportingPolicy.endpoint(currentConfig()) == nil { return }
            try? await Task.sleep(nanoseconds: UInt64(Double(afterMillis) * 1_000_000.0))
            let target = diagnostics ?? CallDiagnostics.shared
            await CrashReportUploader.shared.upload(
                store: target.store,
                config: currentConfig(),
                context: context(info: target.hooks.info(), installId: installId()),
                transport: CrashReportHTTPTransport(),
                allowsSending: { SettingsPreferences.shareCrashReports() }
            )
        }
    }
}

@MainActor
final class CrashReportUploader {
    static let shared = CrashReportUploader()

    private var isUploading = false
    private var rerunRequested = false
    private(set) var sentCount = 0

    init() {
    }

    /// A trigger that lands mid-upload reruns the pass afterwards; consent is re-read before every batch.
    @discardableResult
    func upload(store: DiagnosticsFileStore, config: CrashReportingConfig, context: CrashReportContext,
                transport: CrashReportTransport, allowsSending: () -> Bool = { true }) async -> Int {
        guard let endpoint = CrashReportingPolicy.endpoint(config) else { return 0 }
        if isUploading {
            rerunRequested = true
            return 0
        }
        isUploading = true
        defer { isUploading = false }
        var total = 0
        while true {
            rerunRequested = false
            total += await uploadPass(store: store, endpoint: endpoint, projectKey: config.projectKey, context: context,
                                      transport: transport, allowsSending: allowsSending)
            if !rerunRequested || !allowsSending() { break }
        }
        return total
    }

    private func uploadPass(store: DiagnosticsFileStore, endpoint: String, projectKey: String, context: CrashReportContext,
                            transport: CrashReportTransport, allowsSending: () -> Bool) async -> Int {
        let ledger = CrashReportLedger(store: store)
        let prepared = await Task.detached(priority: TaskPriority.utility) {
            let loaded = store.loadPayloads()
            var present: [String] = []
            for item in loaded {
                present.append(item.name)
            }
            let plan = CrashReportPlanner.plan(loaded, reported: ledger.reportedNames(), projectKey: projectKey,
                                               context: context)
            return CrashReportPreparedUpload(plan: plan, present: present)
        }.value

        var sent = 0
        var recorded = prepared.plan.skipped
        for batch in prepared.plan.batches {
            if !allowsSending() { break }
            let delivered = await transport.send(endpoint: endpoint, body: batch.body)
            if !delivered { break }
            sent += batch.names.count
            recorded.append(contentsOf: batch.names)
        }
        if !recorded.isEmpty {
            let names = recorded
            let present = prepared.present
            _ = await Task.detached(priority: TaskPriority.utility) {
                ledger.record(names, present: present)
            }.value
        }
        sentCount += sent
        return sent
    }
}

struct CrashReportPreparedUpload: Equatable {
    let plan: CrashReportPlan
    let present: [String]
}
