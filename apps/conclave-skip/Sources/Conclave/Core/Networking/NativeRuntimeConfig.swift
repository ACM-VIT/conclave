import Foundation

enum NativeRuntimeConfig {
    #if DEBUG && !SKIP
    /// Some device launchers forward app arguments but not target-process environment variables.
    /// Keep existing environment values authoritative, including an explicitly empty route list.
    static func debugLaunchValue(
        forKey key: String,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        arguments: [String] = ProcessInfo.processInfo.arguments
    ) -> String? {
        if let value = environment[key] {
            return value
        }
        let argumentKeys = ["CONCLAVE_NATIVE_ROUTES", "CONCLAVE_PREMEETING_FIXTURE", "SFU_JOIN_URL", "CONCLAVE_AUTH_BASE_URL"]
        guard argumentKeys.contains(key) else { return nil }
        let prefix = "--conclave-config=\(key)="
        for argument in arguments.dropFirst() where argument.hasPrefix(prefix) {
            if let value = normalizedString(String(argument.dropFirst(prefix.count))) {
                return value
            }
        }
        return nil
    }
    #endif

    static func isCurrentAppSuspendedBySystem() -> Bool {
        #if SKIP
        return AndroidRuntimeConfig.isCurrentPackageSuspended()
        #else
        return false
        #endif
    }

    static func bundledString(forKey key: String) -> String? {
        #if SKIP
        if let value = AndroidRuntimeConfig.metadataValue(forKey: key),
           let normalized = normalizedString(value) {
            return normalized
        }
        #endif

        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
            return nil
        }
        return normalizedString(value)
    }

    private static func normalizedString(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
