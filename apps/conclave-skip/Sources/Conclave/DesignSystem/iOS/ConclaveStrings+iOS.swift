#if os(iOS) && !SKIP
import Foundation

/// New native strings (owner decision Q14) live in the module String Catalog, `Resources/Localizable.xcstrings`,
/// and resolve against `Bundle.module`, not `Bundle.main`, so translations and the `-NSDoubleLocalizedStrings`
/// pseudolocale reach them. A key missing from the catalog falls back to the key itself.
enum ConclaveStrings {
    static func text(_ key: String) -> String {
        Bundle.module.localizedString(forKey: key, value: nil, table: nil)
    }

    /// A catalog format key such as "%lld of %lld match"; numbers follow the current locale.
    static func format(_ key: String, _ arguments: CVarArg...) -> String {
        String(format: text(key), locale: .current, arguments: arguments)
    }

    /// A catalog format key for a readout that scripts parse (TG 4.1): the words are localized, the numbers are
    /// ASCII in every locale. With an Arabic locale `format` writes Arabic-Indic digits.
    static func machineReadable(_ key: String, _ arguments: CVarArg...) -> String {
        String(format: text(key), locale: nil, arguments: arguments)
    }
}
#endif
