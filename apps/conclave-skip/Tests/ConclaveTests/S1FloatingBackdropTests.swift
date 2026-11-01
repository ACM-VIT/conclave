#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct S1FloatingBackdropTests {
    static let floatingActionBarFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveFloatingActionBar+iOS.swift"
    static let floatingActionScrimFile = "Sources/Conclave/Skip/ui/components/ConclaveFloatingActionScrim.kt"
    static let legacyStreamingMarkdownFile = "Sources/Conclave/Shared/NativeStreamingMarkdown.swift"
    static let gradientAllowlist: Set<String> = [floatingActionBarFile, floatingActionScrimFile, legacyStreamingMarkdownFile]

    static let lobbyViewFile = "Sources/Conclave/Features/Lobby/LobbyView+iOS.swift"
    static let lobbyCardFile = "Sources/Conclave/Features/Lobby/LobbyPreviewCard+iOS.swift"
    static let lobbyGroupedFile = "Sources/Conclave/Features/Lobby/LobbyGroupedSection+iOS.swift"
    static let lobbyScreenFile = "Sources/Conclave/Skip/ui/lobby/LobbyScreen.kt"
    static let lobbyKotlinCardFile = "Sources/Conclave/Skip/ui/lobby/LobbyPreviewCard.kt"

    static func usesGradient(_ text: String) -> Bool {
        text.lowercased().contains("gradient") || text.contains("ShaderBrush")
    }

    @Test func gradientApisAppearOnlyInTheD1Allowlist() throws {
        var files = try s1bFiles(under: "Sources/Conclave", extensions: ["swift", "kt"])
        files += try s1bFiles(under: "Android/app/src/main", extensions: ["kt", "xml"])
        var users: Set<String> = []
        for file in files where Self.usesGradient(try s1bSource(file)) {
            users.insert(file)
        }
        #expect(users == Self.gradientAllowlist, "gradient APIs outside the D-1 allowlist: \(users.subtracting(Self.gradientAllowlist).sorted())")

        let kotlinRamps = users.filter { $0.hasSuffix(".kt") }
        #expect(kotlinRamps == [Self.floatingActionScrimFile], "the scrim is the only alpha-ramp brush in the Kotlin tree")
    }

}

private func s1bPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1bSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1bPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1bFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = s1bPackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

private func s1bFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private struct S1BlockMissing: Error {}

private func s1bBlock(_ text: String, from start: String, to end: String) throws -> String {
    guard let lower = text.range(of: start), let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else {
        throw S1BlockMissing()
    }
    return String(text[lower.lowerBound..<upper.lowerBound])
}
#endif
