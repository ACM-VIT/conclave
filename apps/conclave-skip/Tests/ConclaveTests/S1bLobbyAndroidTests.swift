#if !SKIP
import Foundation
import Testing

struct S1bLobbyAndroidTests {
    static let rowsFile = "Sources/Conclave/Skip/ui/lobby/LobbyStatusRow.kt"
    static let entryFile = "Sources/Conclave/Skip/ui/lobby/EntryStatusBlock.kt"
    static let primingFile = "Sources/Conclave/Skip/ui/lobby/PermissionPrimingRow.kt"
    static let cardFile = "Sources/Conclave/Skip/ui/lobby/LobbyPreviewCard.kt"
    static let screenFile = "Sources/Conclave/Skip/ui/lobby/LobbyScreen.kt"
    static let scrimFile = "Sources/Conclave/Skip/ui/components/ConclaveFloatingActionScrim.kt"
    static let lobbyFiles = [rowsFile, entryFile, primingFile, cardFile, screenFile]

    @Test func theLobbyLeavesTheBannerTheRationaleAndRedBehind() throws {
        for file in Self.lobbyFiles {
            let text = try s1blaSource(file)
            for banned in ["ConclaveBanner(", "ConclaveBannerKind", "pm_mic_rationale", "pm_camera_rationale", "ds_not_now", "notNow",
                           "scheme.error", "ErrorFill1", "\"pm_offline\"", "\"pm_offline_waiting\"", "microphoneDismissed",
                           "cameraDismissed", "LobbyIssueBanner", "PermissionPrimingRows(", "pm_announce_couldnt_join",
                           "statusWarning", "AccountCircleFill0"] {
                #expect(!text.contains(banned), "\(file) still uses \(banned)")
            }
        }
    }

    @Test func lobbyStatusFilesStayFlatQuietAndResolve() throws {
        let resources = try s1blaSource("Android/app/src/main/res/values/strings.xml")
        for file in Self.lobbyFiles + [Self.scrimFile] {
            let text = try s1blaSource(file)
            #expect(s1blaMatches(#"Text\(\s*""#, in: text).isEmpty, "\(file) has a literal Text")
            #expect(s1blaMatches(#"Color\(\s*0x"#, in: text).isEmpty, "\(file) builds a colour from a literal")
            for match in s1blaMatches(#"conclaveString\("[a-z0-9_]+""#, in: text) {
                let name = String(match.dropFirst("conclaveString(\"".count).dropLast())
                #expect(resources.contains("<string name=\"\(name)\""), "\(file): missing Android resource \(name)")
            }
        }
        for (name, value) in [("pm_status_allow_mic_label", "Allow the microphone so people can hear you"),
                              ("pm_status_allow_camera_label", "Allow the camera so people can see you")] {
            #expect(resources.contains("<string name=\"\(name)\">\(value)</string>"), "\(name)")
        }
        for gone in ["pm_mic_rationale", "pm_camera_rationale", "pm_subtitle_joining", "pm_subtitle_reconnecting", "pm_announce_couldnt_join"] {
            #expect(!resources.contains("<string name=\"\(gone)\""), "\(gone) is still in strings.xml")
        }
    }
}

private func s1blaPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1blaSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1blaPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1blaFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private struct S1bLobbyBlockMissing: Error {}

private func s1blaBlock(_ text: String, from start: String, to end: String) throws -> String {
    guard let lower = text.range(of: start), let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else {
        throw S1bLobbyBlockMissing()
    }
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func s1blaMatches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}
#endif
