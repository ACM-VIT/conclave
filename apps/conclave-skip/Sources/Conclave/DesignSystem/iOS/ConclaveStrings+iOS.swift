#if os(iOS) && !SKIP
import Foundation

enum ConclaveStrings {
    static func text(_ key: String) -> String {
        Bundle.module.localizedString(forKey: key, value: nil, table: nil)
    }

    static func format(_ key: String, _ arguments: CVarArg...) -> String {
        String(format: text(key), locale: .current, arguments: arguments)
    }

    static func machineReadable(_ key: String, _ arguments: CVarArg...) -> String {
        String(format: text(key), locale: nil, arguments: arguments)
    }
}
#endif
