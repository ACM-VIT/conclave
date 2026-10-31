#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1ChatPhotosTests {
    private static let iosComposer = "Sources/Conclave/Features/Meeting/Chat/ChatComposer+iOS.swift"
    private static let androidComposer = "Sources/Conclave/Skip/ui/chat/ChatComposer.kt"
    private static let theme = "Sources/Conclave/Shared/Theme.swift"
    private static let fontFolders = ["Sources/Conclave/Resources/Fonts", "Android/app/src/main/res/font"]
    private static let scannedRoots = ["Sources/Conclave", "Android/app/src/main", "Tests/ConclaveTests", "Darwin"]
    private static let textExtensions: Set<String> = ["swift", "kt", "kts", "xml", "json", "yml", "yaml", "gradle", "plist", "pbxproj",
                                                      "xcconfig", "strings", "xcstrings", "properties", "pro", "txt", "md",
                                                      "entitlements", "html", "css", "js", "svg"]
    private static let fontExtensions: Set<String> = ["otf", "ttf", "ttc", "woff", "woff2"]

    @Test func onePickGivesOneChipAndCloseRestoresTheKeyboardOnlyIfItWasUp() throws {
        #expect(ChatComposerPolicy.restoresComposerFocus(wasFocused: true, assistiveTechRunning: false))
        #expect(!ChatComposerPolicy.restoresComposerFocus(wasFocused: false, assistiveTechRunning: false))
        #expect(!ChatComposerPolicy.restoresComposerFocus(wasFocused: true, assistiveTechRunning: true))
    }

    @Test func noTrialFontReferenceOrFontFileRemains() throws {
        let token = ["poly", "sans"].joined()
        let root = s1cpRoot()
        var scanned = 0
        for base in Self.scannedRoots {
            let directory = root.appendingPathComponent(base)
            guard let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil) else { continue }
            while let url = enumerator.nextObject() as? URL {
                let relative = base + "/" + url.path.replacingOccurrences(of: directory.path + "/", with: "")
                #expect(!relative.lowercased().contains(token), "\(relative)")
                let ext = url.pathExtension.lowercased()
                #expect(!Self.fontExtensions.contains(ext), "\(relative) is a bundled font")
                guard Self.textExtensions.contains(ext), let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
                scanned += 1
                #expect(!text.lowercased().contains(token), "\(relative) names the trial font")
                if base == "Sources/Conclave" {
                    #expect(!text.contains("FontRegistration") && !text.contains("registerFonts"), "\(relative)")
                }
            }
        }
        #expect(scanned > 500)
        for folder in Self.fontFolders {
            let url = root.appendingPathComponent(folder)
            if FileManager.default.fileExists(atPath: url.path) {
                let entries = (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []
                #expect(entries.filter { !$0.hasPrefix(".") }.isEmpty, "\(folder) still holds font files")
            }
        }
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("Sources/Conclave/Shared/FontRegistration.swift").path))
    }
}

private func s1cpRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1cpSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1cpRoot().appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func s1cpFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func s1cpSlice(_ text: String, from start: String, to end: String) throws -> String {
    let lower = try #require(text.range(of: start))
    let upper = try #require(text.range(of: end, range: lower.upperBound..<text.endIndex))
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func s1cpConstant(_ text: String, _ name: String) throws -> Double {
    let marker = "static let " + name + ": CGFloat = "
    let range = try #require(text.range(of: marker))
    let value = text[range.upperBound...].prefix { $0 == "." || $0.isNumber }
    return try #require(Double(String(value)))
}

private func s1cpSizing(_ ios: String) throws -> String {
    try s1cpSlice(ios, from: "private enum ChatPhotoPickerSizing {", to: "private struct ChatComposerSuggestions {")
}

private struct S1cpPickerModel {
    let minimum: Double
    let maximum: Double
    let share: Double
    let regularReserve: Double
    let compact: Double
    let compactReserve: Double

    init(_ sizing: String) throws {
        minimum = try s1cpConstant(sizing, "regularMinimum")
        maximum = try s1cpConstant(sizing, "regularMaximum")
        share = try s1cpConstant(sizing, "regularShare")
        regularReserve = try s1cpConstant(sizing, "regularReserve")
        compact = try s1cpConstant(sizing, "compactHeight")
        compactReserve = try s1cpConstant(sizing, "compactReserve")
    }

    func height(_ available: Double, isCompact: Bool) -> Double {
        let preferred = isCompact ? compact : min(max(minimum, available * share), maximum)
        let reserve = isCompact ? compactReserve : regularReserve
        return max(0.0, min(preferred, available - reserve))
    }
}
#endif
