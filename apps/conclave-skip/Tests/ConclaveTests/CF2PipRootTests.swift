#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct CF2PipRootTests {

    @Test func theActivityPublishesTheCallShortcutGroupThroughAPublicEntry() throws {
        let strings = try cf2Source("Android/app/src/main/res/values/strings.xml")
        #expect(strings.contains("<string name=\"ctl_kb_group\">Call</string>"))
    }

}

private func cf2Source(_ packageRelativePath: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func cf2Flat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func cf2Matches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}
#endif
