import Foundation

enum NativeRuntimeConfig {
    #if DEBUG && !SKIP
    private static let debugArgumentKeys = [
        "CONCLAVE_NATIVE_ROUTES", "CONCLAVE_PREMEETING_FIXTURE", "SFU_JOIN_URL", "CONCLAVE_AUTH_BASE_URL",
        "CONCLAVE_HOSTING_PREVIEW", "CONCLAVE_SYSTEM_FIXTURE", "CONCLAVE_SYSTEM_FIXTURE_PROVIDER",
        "CONCLAVE_STAGE_FIXTURE", "CONCLAVE_STAGE_FIXTURE_PATTERN", "CONCLAVE_STAGE_FORCE_SCREEN_READER",
        "CONCLAVE_PEOPLE_FIXTURE", "CONCLAVE_CHAT_FIXTURE", "CONCLAVE_TRANSCRIPT_FIXTURE"
    ]

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
        guard debugArgumentKeys.contains(key) else { return nil }
        let prefix = "--conclave-config=\(key)="
        for argument in arguments.dropFirst() where argument.hasPrefix(prefix) {
            if let value = normalizedString(String(argument.dropFirst(prefix.count))) {
                return value
            }
        }
        return nil
    }

    /// Resolve process launch input once at a fixture's default-argument boundary. A reader passed an explicit
    /// environment keeps that dictionary unchanged, including an empty dictionary or an empty selector value.
    static func debugLaunchEnvironment(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        arguments: [String] = ProcessInfo.processInfo.arguments
    ) -> [String: String] {
        var resolved = environment
        for key in debugArgumentKeys where resolved[key] == nil {
            if let value = debugLaunchValue(forKey: key, environment: environment, arguments: arguments) {
                resolved[key] = value
            }
        }
        return resolved
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
