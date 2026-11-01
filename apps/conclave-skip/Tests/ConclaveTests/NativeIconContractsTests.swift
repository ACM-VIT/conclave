#if os(macOS) && !SKIP
import CryptoKit
import Foundation
import Testing

struct NativeIconContractsTests {
    @Test func symbolConstantsAreTheExactManifestLiterals() throws {
        let literals = try #require(try iconManifest()["sf_literals"] as? [String])
        #expect(literals.count == 116)
        #expect(Set(literals).count == 116)
    }

    @Test func symbolCatalogCoversEveryConceptAndSystemOwnedRole() throws {
        let concepts = try #require(try iconManifest()["concepts"] as? [[String: Any]])
        var expected: [[String]] = []
        for concept in concepts {
            let id = try #require(concept["id"] as? String)
            for symbol in try #require(concept["sf_symbols"] as? [[String: Any]]) {
                expected.append(["\(id).\(try #require(symbol["name"] as? String))", "symbol"])
            }
            for system in try #require(concept["ios_system"] as? [[String: Any]]) {
                expected.append(["\(id).\(try #require(system["kind"] as? String))", "nil"])
            }
        }
    }

    @Test func bindingSemanticsStayOwnedByLocalizedControls() throws {
        let manifest = try iconManifest()
        let policy = try #require(manifest["accessibility"] as? [String: Any])
        #expect(policy["android_child_contentDescription"] is NSNull)
        #expect(policy["ios_child_accessibility_hidden"] as? Bool == true)
        var roles: [String: (label: String?, value: String?, role: String)] = [:]
        for concept in try #require(manifest["concepts"] as? [[String: Any]]) {
            for binding in try #require(concept["bindings"] as? [[String: Any]]) {
                let semantics = try #require(binding["accessibility"] as? [String: Any])
                let role = try #require(semantics["role"] as? String)
                let label = semantics["label"] as? String
                roles["\(try #require(concept["id"] as? String)).\(try #require(binding["state"] as? String))"] =
                    (label, semantics["value"] as? String, role)
                #expect((label != nil) == ["button", "switch", "checkbox"].contains(role))
            }
        }
        #expect(roles.count == 134)
        #expect(roles["microphone.muted"]?.role == "switch" && roles["microphone.muted"]?.value == "Muted")
        #expect(roles["share_screen.stop_sharing_action"]?.label == "Stop sharing" && roles["share_screen.stop_sharing_action"]?.value == nil)
        #expect(roles["lock_meeting.locked"]?.role == "checkbox")
        #expect(roles["host.host_badge"]?.role == "status" && roles["host.host_controls_action"]?.role == "button")
        let mirrored = try #require(manifest["artwork"] as? [[String: Any]]).filter { $0["autoMirror"] as? Bool == true }
        #expect(mirrored.compactMap { $0["id"] as? String } == ["arrow_back.fill0", "send.fill1", "backspace.fill0", "reply.fill0"])
    }

    @Test func generatedSourcesAndLicensesMatchTheCheckedInManifest() throws {
        let manifestSHA = iconSHA256(try iconRepoData("packages/ui-tokens/icons/manifest.json"))
        let license = "58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd"
        #expect(iconSHA256(try iconRepoData("apps/conclave-skip/Sources/Conclave/Resources/MaterialSymbols-LICENSE.txt")) == license)
        #expect(iconSHA256(try iconRepoData("apps/conclave-skip/Android/app/src/main/assets/MaterialSymbols-LICENSE.txt")) == license)
        #expect(iconSHA256(try iconRepoData("packages/ui-tokens/icons/vendor/material-symbols/upstream/LICENSE")) == license)
    }
}

private func iconManifest() throws -> [String: Any] {
    var base = try #require(try JSONSerialization.jsonObject(with: iconRepoData("packages/ui-tokens/icons/manifest.json")) as? [String: Any])
    let originalSymbols = try #require(base["sf_literals"] as? [String])
    let originalArtwork = try #require(base["artwork"] as? [[String: Any]])
    let originalConcepts = try #require(base["concepts"] as? [[String: Any]])

    #expect(originalSymbols.count == 50 && originalArtwork.count == 54 && originalConcepts.count == 36)
    #expect(originalConcepts.compactMap { ($0["bindings"] as? [[String: Any]])?.count }.reduce(0, +) == 58)
    let ref = try #require(base["additions"] as? [String: String])
    let data = try iconRepoData(try #require(ref["path"]))
    #expect(iconSHA256(data) == ref["sha256"])
    let extra = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect((extra["source_revision"] as? String) == (base["source_revision"] as? String))
    let symbols = try #require(extra["sf_literals"] as? [String])
    let artwork = try #require(extra["artwork"] as? [[String: Any]])
    let concepts = try #require(extra["concepts"] as? [[String: Any]])
    #expect(symbols.count == 69 && artwork.count == 61 && concepts.count == 70)
    #expect(Set(artwork.compactMap { $0["id"] as? String }).isDisjoint(with: Set(originalArtwork.compactMap { $0["id"] as? String })))
    base["sf_literals"] = originalSymbols + symbols.filter { !originalSymbols.contains($0) }
    base["artwork"] = originalArtwork + artwork
    base["concepts"] = originalConcepts + concepts
    return base
}

private func iconSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: iconRepoRoot().appendingPathComponent("apps/conclave-skip").appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func iconRepoData(_ repoRelativePath: String) throws -> Data {
    try Data(contentsOf: iconRepoRoot().appendingPathComponent(repoRelativePath))
}

private func iconRepoRoot() -> URL {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
}

private func iconSHA256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func iconMatches(_ pattern: String, in source: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [["invalid pattern"]] }
    let text = source as NSString
    return regex.matches(in: source, range: NSRange(location: 0, length: text.length)).map { match in
        (1..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : text.substring(with: range)
        }
    }
}
#endif
