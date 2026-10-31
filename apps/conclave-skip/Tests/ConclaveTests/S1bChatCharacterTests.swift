#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S1bChatCharacterTests {
    private static let iosTimeline = "Sources/Conclave/Features/Meeting/Chat/ChatTimeline+iOS.swift"
    private static let androidTimeline = "Sources/Conclave/Skip/ui/chat/ChatTimeline.kt"
    private static let iosChip = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveReactionChip+iOS.swift"
    private static let androidChip = "Sources/Conclave/Skip/ui/components/ConclaveReactionChip.kt"
    private static let iosChatRow = "Sources/Conclave/Features/Meeting/Chat/ChatRow+iOS.swift"
    private static let iosAssistantRow = "Sources/Conclave/Features/Meeting/Chat/AssistantRow+iOS.swift"
    private static let androidChatRow = "Sources/Conclave/Skip/ui/chat/ChatRow.kt"
    private static let androidAssistantRow = "Sources/Conclave/Skip/ui/chat/AssistantRow.kt"

    @Test func theRemovedGreetingLeavesBothCatalogs() throws {
        let catalog = try s1bccSource("Sources/Conclave/Resources/Localizable.xcstrings")
        #expect(!catalog.contains("\"Say hello to the room.\""))
        let strings = try s1bccSource("Android/app/src/main/res/values/strings.xml")
        #expect(!strings.contains("name=\"chat_empty_greeting\""))
        #expect(catalog.contains("\"No Messages Yet\"") && strings.contains("name=\"chat_empty_title\""))
    }

}

private func s1bccRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1bccSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1bccRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1bccFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1bccSlice(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func s1bccFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = s1bccRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

private func s1bccMatches(_ pattern: String, in text: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [["invalid pattern"]] }
    let ns = text as NSString
    return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
        (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
    }
}
#endif
