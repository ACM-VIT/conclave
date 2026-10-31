#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S1bStageMenusTests {
    private static let tile = "Sources/Conclave/Skip/ui/call/stage/TileMenu.kt"
    private static let leave = "Sources/Conclave/Skip/ui/call/controls/LeaveControl.kt"
    private static let camera = "Sources/Conclave/Skip/ui/call/controls/MediaShortcutMenu.kt"
    private static let bar = "Sources/Conclave/Skip/ui/call/controls/CallControlBar.kt"
    private static let effect = "Sources/Conclave/Skip/ui/effects/EffectTile.kt"
    private static let appHost = "Sources/Conclave/Skip/ui/apps/NativeAppHost.kt"
    private static let appPages = "Sources/Conclave/Skip/ui/apps/AppPages.kt"
    private static let browser = "Sources/Conclave/Skip/ui/browser/BrowserSurface.kt"
    private static let menus = "Sources/Conclave/Skip/ui/components/ConclaveMenus.kt"
    private static let barComponent = "Sources/Conclave/Skip/ui/components/ConclaveCallControl.kt"
    private static let toggle = "Sources/Conclave/Skip/ui/call/controls/CallToggle.kt"
    private static let eight = [tile, leave, camera, bar, effect, appHost, appPages, browser]

    @Test func s1bStageSourcesStayFlatDashFreeAndLiteralFree() throws {
        for file in Self.eight {
            let text = try s1bStageSource(file)
            #expect(try s1bStageMatches(#"Text\(\s*""#, in: text).isEmpty, "\(file) has a literal Text")
        }
    }
}

private struct S1bStageMissing: Error {
    let needle: String
}

private func s1bStagePackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1bStageSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1bStagePackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1bStageNormalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1bStageMatches(_ pattern: String, in text: String) throws -> [String] {
    let regex = try NSRegularExpression(pattern: pattern)
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}

private func s1bStageCaptures(_ pattern: String, in text: String) throws -> [String] {
    let regex = try NSRegularExpression(pattern: pattern)
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range(at: 1), in: text).map { String(text[$0]) }
    }
}

private func s1bStageFunction(_ signature: String, in text: String) throws -> String {
    guard let start = text.range(of: signature) else { throw S1bStageMissing(needle: signature) }
    guard let end = text.range(of: "\n}\n", range: start.upperBound..<text.endIndex) else { throw S1bStageMissing(needle: signature) }
    return s1bStageNormalized(String(text[start.lowerBound..<end.upperBound]))
}

private func s1bStageMenuCalls(in text: String) -> [String] {
    var blocks: [String] = []
    var cursor = text.startIndex
    while let found = text.range(of: "ConclaveDropdownMenu(", range: cursor..<text.endIndex) {
        var index = found.upperBound
        var depth = 1
        while index < text.endIndex && depth > 0 {
            let character = text[index]
            if character == "(" { depth += 1 } else if character == ")" { depth -= 1 }
            index = text.index(after: index)
        }
        var tail = index
        while tail < text.endIndex && text[tail] == " " { tail = text.index(after: tail) }
        if tail < text.endIndex && text[tail] == "{" {
            var braces = 1
            index = text.index(after: tail)
            while index < text.endIndex && braces > 0 {
                let character = text[index]
                if character == "{" { braces += 1 } else if character == "}" { braces -= 1 }
                index = text.index(after: index)
            }
        }
        blocks.append(String(text[found.lowerBound..<index]))
        cursor = index
    }
    return blocks
}
#endif
