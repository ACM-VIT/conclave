#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S1bMenuSystemTests {
    static let menusFile = "Sources/Conclave/Skip/ui/components/ConclaveMenus.kt"
    static let fieldsFile = "Sources/Conclave/Skip/ui/components/ConclaveFields.kt"
    static let hostingThemeFile = "Sources/Conclave/Skip/ui/theme/HostingTheme.kt"
    static let skipUIDirectory = "Sources/Conclave/Skip/ui"
    static let menuComponentFiles: Set<String> = [menusFile, fieldsFile]
    static let toastHostFile = "Sources/Conclave/Skip/ui/components/ConclaveToastHost.kt"
    static let shadowSites: [String: String] = [
        toastHostFile: "3.dp",
    ]
    static let flatShadowValues: Set<String> = ["0.dp", "conclaveMenuShadowElevation()"]
    static let rawMenuPattern = #"(?<![A-Za-z])DropdownMenu\("#

    static let slotOverload = "internal fun ConclaveDropdownMenu( expanded: Boolean, onDismissRequest: () -> Unit, identifier: String, modifier: Modifier = Modifier, offset: DpOffset = DpOffset(0.dp, 0.dp), properties: PopupProperties = PopupProperties(focusable = true), content: @Composable ColumnScope.() -> Unit, ) {"
    static let modelOverload = "internal fun ConclaveDropdownMenu( expanded: Boolean, onDismissRequest: () -> Unit, sections: List<MenuSectionModel>, identifier: String, onSelect: (MenuItemModel) -> Unit, modifier: Modifier = Modifier, icon: (MenuItemModel) -> ImageVector? = { conclaveMenuIcon(it.concept) }, offset: DpOffset = DpOffset(0.dp, 0.dp), header: (@Composable () -> Unit)? = null, ) {"
    static let menuItem = "internal fun ConclaveMenuItem( title: String, identifier: String, onClick: () -> Unit, modifier: Modifier = Modifier, role: ConclaveMenuRole = ConclaveMenuRole.Plain, leadingIcon: ImageVector? = null, leadingContent: (@Composable () -> Unit)? = null, supporting: String? = null, enabled: Boolean = true, ) {"
    static let menuHeader = "internal fun ConclaveMenuHeader(title: String, identifier: String, avatar: ConclaveAvatarIdentity? = null) {"
    static let containerLine = "tonalElevation = 0.dp, shadowElevation = conclaveMenuShadowElevation(), border = BorderStroke(1.dp, scheme.outlineVariant),"

    static func shadowOffenders(file: String, source: String) -> [String] {
        var preexistingSiteSeen = false
        var offenders: [String] = []
        for value in menuSystemShadowArguments(in: source) where !flatShadowValues.contains(value) {
            if !preexistingSiteSeen, let allowed = shadowSites[file], value == allowed {
                preexistingSiteSeen = true
            } else {
                offenders.append("\(file): \(value.isEmpty ? "missing value" : value)")
            }
        }
        return offenders
    }
}

private func menuSystemPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func menuSystemSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: menuSystemPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func menuSystemFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = menuSystemPackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

private func menuSystemFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func menuSystemMatches(_ pattern: String, in text: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [["invalid pattern"]] }
    let ns = text as NSString
    return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
        (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
    }
}

private func menuSystemShadowArguments(in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: #"(?<![A-Za-z0-9_])shadowElevation\s*=(?!=)"#) else { return ["invalid pattern"] }
    let units = Array(text.utf16)
    let whitespace: Set<UInt16> = [9, 10, 13, 32]
    let openers: Set<UInt16> = [40, 91, 123]
    let closers: Set<UInt16> = [41, 93, 125]
    let continuations: Set<UInt16> = [37, 38, 42, 43, 45, 46, 47, 63, 124]
    return regex.matches(in: text, range: NSRange(location: 0, length: units.count)).map { match -> String in
        var start = match.range.location + match.range.length
        while start < units.count, whitespace.contains(units[start]) { start += 1 }
        var end = start
        var depth = 0
        scan: while end < units.count {
            let unit = units[end]
            if openers.contains(unit) {
                depth += 1
            } else if closers.contains(unit) {
                if depth == 0 { break scan }
                depth -= 1
            } else if unit == 44, depth == 0 {
                break scan
            } else if unit == 10, depth == 0 {
                var next = end + 1
                while next < units.count, whitespace.contains(units[next]) { next += 1 }
                if next >= units.count || !continuations.contains(units[next]) { break scan }
            }
            end += 1
        }
        return menuSystemFlat(String(decoding: units[start..<end], as: UTF16.self))
    }
}

private struct MenuSystemBlockMissing: Error {}

private func menuSystemBlock(_ text: String, from start: String, to end: String) throws -> String {
    guard let lower = text.range(of: start), let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else {
        throw MenuSystemBlockMissing()
    }
    return String(text[lower.lowerBound..<upper.lowerBound])
}
#endif
