#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1MoreLargeTextTests {
    static let actionSheetFile = "Sources/Conclave/Skip/ui/components/ConclaveActionSheet.kt"
    static let moreSheetFile = "Sources/Conclave/Features/Meeting/Controls/MoreSheet+iOS.swift"
    static let moreMenuFile = "Sources/Conclave/Features/Meeting/Controls/MoreMenu+iOS.swift"
    static let shortcutMenuFile = "Sources/Conclave/Features/Meeting/Controls/MediaShortcutMenu+iOS.swift"
    static let transcriptPageFile = "Sources/Conclave/Skip/ui/transcript/TranscriptPage.kt"
    static let inCallPageFile = "Sources/Conclave/Skip/ui/call/panels/InCallPage.kt"
    static let transcriptPanelFile = "Sources/Conclave/Features/Meeting/Transcript/TranscriptPanel+iOS.swift"
    static let floatingBarFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveFloatingActionBar+iOS.swift"
    static let catalogFile = "Sources/Conclave/Resources/Localizable.xcstrings"
    static let androidStringsFile = "Android/app/src/main/res/values/strings.xml"

    @Test func iosCaptionsRowStacksAtAccessibilitySizes() throws {
        let captions = try #require(ControlsFixtureSession(state: .guest).controls.more.item(MoreItemID.captions))
        #expect(MoreMenuPolicy.hasSubtitle(captions), "the captions row always reserves its subtitle line")
    }

    @Test func iosMicrophoneChooserTitleFitsOneMenuLine() throws {
        let title = "Microphone\u{2026}"

        #expect(title.count <= "Audio Settings".count, "no longer than the sibling item that renders on one line in the same menu")
        #expect(title.hasPrefix("Microphone") && !title.contains("Mic "), "no abbreviation")

        let catalog = try s1mSource(Self.catalogFile)
        #expect(catalog.contains("\"" + title + "\""))
        #expect(catalog.contains("\"Choose Microphone\""))
        #expect(!catalog.contains("\"Choose Microphone\u{2026}\""))
        let data = try #require(catalog.data(using: .utf8))
        let root = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let strings = try #require(root["strings"] as? [String: Any])
        let entry = try #require(strings[title] as? [String: Any])
        #expect(entry["generatesSymbol"] as? Bool == false, "Microphone and Microphone\u{2026} must not generate the same symbol")
    }

    @Test func theKeyScopeLineStaysOnBothPlatforms() throws {
        let line = "Your key is only used for this meeting."
        #expect(try s1mSource(Self.catalogFile).contains("\"" + line + "\""))
        #expect(try s1mSource(Self.androidStringsFile).contains("<string name=\"trn_coverage_keys\">" + line + "</string>"))
    }
}

private func s1mPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1mSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1mPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1mFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1mMatches(_ pattern: String, in text: String) -> [[String]] {
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
