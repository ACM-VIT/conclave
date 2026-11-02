#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S1bPostChatLandingTests {
    private static let menuFile = "Sources/Conclave/Features/Meeting/Chat/MessageActions+iOS.swift"
    private static let chipFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveReactionChip+iOS.swift"
    private static let chatRowFile = "Sources/Conclave/Features/Meeting/Chat/ChatRow+iOS.swift"
    private static let assistantRowFile = "Sources/Conclave/Features/Meeting/Chat/AssistantRow+iOS.swift"
    private static let helperCall = "Toggle(isOn: Binding(get: { isMine(emoji) }, set: { _ in toggleAfterMenuDismiss(emoji) })) {"

}

private func s1bpclRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1bpclSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1bpclRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1bpclFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1bpclSlice(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func s1bpclCount(_ text: String, _ needle: String) -> Int {
    text.components(separatedBy: needle).count - 1
}

private func s1bpclMatches(_ pattern: String, in text: String) -> [[String]] {
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
