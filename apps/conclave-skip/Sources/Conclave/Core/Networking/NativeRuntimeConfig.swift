import Foundation

enum NativeRuntimeConfig {
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
