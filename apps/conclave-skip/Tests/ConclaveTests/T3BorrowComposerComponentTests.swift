#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct T3BorrowComposerComponentTests {
    static let glassFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveComposerGlass+iOS.swift"
    static let fieldsFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveFields+iOS.swift"
    static let modelsFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveContentModels.swift"
    static let kotlinFile = "Sources/Conclave/Skip/ui/components/ConclaveFields.kt"

    @Test func counterBandsFollowTheLimit() {
        let from = ConclaveComposerCounterPolicy.visibleFrom(limit: 1000)
        #expect(from == 900)
        #expect(ConclaveComposerCounterPolicy.band(count: 0, limit: 1000, visibleFrom: from) == .hidden)
        #expect(ConclaveComposerCounterPolicy.band(count: 899, limit: 1000, visibleFrom: from) == .hidden)
        #expect(ConclaveComposerCounterPolicy.band(count: 900, limit: 1000, visibleFrom: from) == .near)
        #expect(ConclaveComposerCounterPolicy.band(count: 1000, limit: 1000, visibleFrom: from) == .near)
        #expect(ConclaveComposerCounterPolicy.band(count: 1001, limit: 1000, visibleFrom: from) == .over)
        #expect(ConclaveComposerCounterPolicy.band(count: 1200, limit: 1000, visibleFrom: from) == .over)

        #expect(ConclaveComposerCounterPolicy.band(count: 0, limit: 500, visibleFrom: 0) == .near)
        #expect(ConclaveComposerCounterPolicy.band(count: 501, limit: 500, visibleFrom: 0) == .over)

        for limit in [40, 500, 1000] {
            for visibleFrom in [0, 30, ConclaveComposerCounterPolicy.visibleFrom(limit: limit)] {
                for count in stride(from: 0, through: limit + 20, by: 1) {
                    let band = ConclaveComposerCounterPolicy.band(count: count, limit: limit, visibleFrom: visibleFrom)
                    #expect((band != .hidden) == (count >= visibleFrom), "\(count) of \(limit) from \(visibleFrom)")
                    if band != .hidden {
                        #expect((band == .over) == (ConclaveComposerCounterPolicy.overflow(count: count, limit: limit) > 0))
                    }
                }
            }
        }
        #expect(ConclaveCounterBand.allCases.map { $0.rawValue } == ["hidden", "near", "over"])
    }

    @Test func counterAnnouncesOnceAtEachCrossing() {

        let expected: [String: Bool] = [
            "hidden>hidden": false, "hidden>near": true, "hidden>over": true,
            "near>hidden": false, "near>near": false, "near>over": true,
            "over>hidden": false, "over>near": true, "over>over": false,
        ]
        for previous in ConclaveCounterBand.allCases {
            for next in ConclaveCounterBand.allCases {
                let key = previous.rawValue + ">" + next.rawValue
                #expect(ConclaveComposerCounterPolicy.announces(previous: previous, next: next) == expected[key], "\(key)")
            }
        }

        var previous = ConclaveCounterBand.hidden
        var spoken: [String] = []
        for count in [0, 1200, 1210, 1250, 999, 950, 899, 0] {
            let next = ConclaveComposerCounterPolicy.band(count: count, limit: 1000, visibleFrom: 900)
            if ConclaveComposerCounterPolicy.announces(previous: previous, next: next) { spoken.append(next.rawValue) }
            previous = next
        }
        #expect(spoken == ["over", "near"])
    }

    @Test func overLimitPluralIsAnAndroidResource() throws {

        let xml = try t3cSource("Android/app/src/main/res/values/strings.xml")
        let block = try #require(t3cMatches(#"<plurals name="ds_char_over_limit">([\s\S]*?)</plurals>"#, in: xml).first, "T3B-1 strings merged")
        #expect(block[0].contains("<item quantity=\"one\">%1$d character over the limit</item>"))
        #expect(block[0].contains("<item quantity=\"other\">%1$d characters over the limit</item>"))
    }
}

private func t3cPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func t3cSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: t3cPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func t3cFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = t3cPackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

private func t3cNormalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func t3cWithoutComments(_ text: String) -> String {
    text.replacingOccurrences(of: #"//[^\n]*"#, with: "", options: .regularExpression)
}

private func t3cWithoutAnyComments(_ text: String) -> String {
    let blockless = text.replacingOccurrences(of: #"/\*[\s\S]*?\*/"#, with: "", options: .regularExpression)
    return t3cWithoutComments(blockless)
}

private func t3cSection(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func t3cMatches(_ pattern: String, in text: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [["invalid pattern"]] }
    let ns = text as NSString
    return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
        (1..<max(match.numberOfRanges, 2)).map { index in
            guard index < match.numberOfRanges else { return "" }
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
    }
}

private func t3cBracedBlocks(after marker: String, in text: String) -> [Range<String.Index>] {
    var result: [Range<String.Index>] = []
    var start = text.startIndex
    while let found = text.range(of: marker, range: start..<text.endIndex) {
        var depth = 1
        var index = found.upperBound
        while index < text.endIndex && depth > 0 {
            if text[index] == "{" { depth += 1 } else if text[index] == "}" { depth -= 1 }
            index = text.index(after: index)
        }
        result.append(found.lowerBound..<index)
        start = index
    }
    return result
}
#endif
