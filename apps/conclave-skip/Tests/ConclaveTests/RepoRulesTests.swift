#if !SKIP
import Foundation
import Testing

struct RepoRulesTests {

    static let roots = ["Sources/Conclave", "Darwin", "Android/app/src/main"]

    static let textExtensions: Set<String> = [
        "swift", "kt", "xml", "xcstrings", "strings", "stringsdict", "plist", "json", "svg", "entitlements", "xcconfig",
    ]

    @Test func noEnOrEmDashShipsInSourcesOrResources() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        var scanned = 0
        var offenders: [String] = []
        for base in Self.roots {
            let directory = root.appendingPathComponent(base)
            guard let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil) else { continue }
            while let url = enumerator.nextObject() as? URL {
                guard Self.textExtensions.contains(url.pathExtension.lowercased()),
                      let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
                scanned += 1
                if text.unicodeScalars.contains(where: { $0.value == 0x2013 || $0.value == 0x2014 }) {
                    offenders.append(url.path.replacingOccurrences(of: root.path + "/", with: ""))
                }
            }
        }
        #expect(scanned > 500)
        #expect(offenders.isEmpty, "en or em dash in: \(offenders.sorted())")
    }
}
#endif
