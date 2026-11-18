#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct SYS9DeepLinkTests {
    private static let hosts: Set<String> = ["conclave.acmvit.in", "www.conclave.acmvit.in"]

    private static let meetingPaths = [
        "/rose-sora-luffy",
        "/brave-otter-4821",
        "/w/abc123",
        "/w/team-all-hands",
        "/sched-1a2b3c4d",
        "/sched-ule-room",
    ]

    private static let browserPaths = [
        "/", "/acme", "/standup", "/rose-sora", "/w",
        "/sign-in", "/sign-in/callback", "/privacy", "/delete-account", "/sfu-admin", "/schedule", "/schedule/team",
        "/book/ishaan/intro", "/api/sfu/join",
    ]

    private static let webOnlyExcludedPaths = [
        "/book/ishaan/30-min-chat", "/schedule/team-sync-call", "/_next/static/chunks/main-app-1a2b.js",
        "/transcript-pcm-processor.js",
    ]

    @Test func aasaHandsOnlyMeetingPathsToTheApp() throws {
        let components = try sys9AASAComponents()
        for path in Self.meetingPaths {
            #expect(sys9AASAHandles(path, components: components), "\(path) must open the app")
        }
        for path in Self.browserPaths + Self.webOnlyExcludedPaths {
            #expect(!sys9AASAHandles(path, components: components), "\(path) must stay in the browser")
        }
    }

    @Test func androidHandsOnlyMeetingPathsToTheApp() throws {
        let filters = sys9AppLinkFilters(try sys9Source("Android/app/src/main/AndroidManifest.xml"))
        for host in Self.hosts.sorted() {
            for path in Self.meetingPaths {
                #expect(sys9AndroidCaptures(path, host: host, filters: filters), "\(host)\(path) must open the app")
            }
            for path in Self.browserPaths {
                #expect(!sys9AndroidCaptures(path, host: host, filters: filters), "\(host)\(path) must stay in the browser")
            }
            #expect(!sys9AndroidCaptures("/rose-sora-luffy", host: "example.com", filters: filters))
        }
    }

    @Test func androidExcludesAllFourFormerWebOnlyCaptures() throws {
        let filters = sys9AppLinkFilters(try sys9Source("Android/app/src/main/AndroidManifest.xml"))
        for host in Self.hosts {
            for path in Self.webOnlyExcludedPaths {
                #expect(!sys9AndroidCaptures(path, host: host, filters: filters), "\(host)\(path)")
                #expect(NativeJoinLinkParser.classify("https://\(host)\(path)") == .webOnly)
            }
        }
    }

    @Test func androidAdvancedGlobsRejectNestedDottedAndMalformedCodes() throws {
        let filters = sys9AppLinkFilters(try sys9Source("Android/app/src/main/AndroidManifest.xml"))
        let rejected = [
            "/a-b-c/d", "/a/b-c-d", "/a-b-c.js", "/a-b-c/", "/a--c", "/-b-c", "/a-b-", "/a-b-c-d",
            "/w/", "/w/a/b", "/w/a.js", "/w/-", "/w/" + String(repeating: "a", count: 33),
            "/sched-", "/sched-1234567", "/sched-123456789", "/sched-ghijklmn", "/sched-12345678/file",
            "/a-b-c%2Fd", "/a-b-c%2Ejs", "/w/a%2Fb", "/w/a%2Ejs",
        ]
        for path in rejected {
            #expect(!sys9AndroidCaptures(path, host: "conclave.acmvit.in", filters: filters), "\(path)")
        }
        for path in ["/A1-b2-C3", "/w/a", "/w/" + String(repeating: "a", count: 32), "/sched-Ab12Cd34"] {
            #expect(sys9AndroidCaptures(path, host: "conclave.acmvit.in", filters: filters), "\(path)")
            #expect(!NativeJoinLinkParser.parse("https://conclave.acmvit.in\(path)").roomId.isEmpty)
        }
    }

    @Test func bothPlatformsHandTheSameMeetingPathsToTheApp() throws {
        let components = try sys9AASAComponents()
        let filters = sys9AppLinkFilters(try sys9Source("Android/app/src/main/AndroidManifest.xml"))
        for host in Self.hosts.sorted() {
            for path in Self.meetingPaths + Self.browserPaths {
                #expect(
                    sys9AASAHandles(path, components: components) == sys9AndroidCaptures(path, host: host, filters: filters),
                    "\(host)\(path) differs between iOS and Android"
                )
            }
        }
    }

    @Test func parserAndAssociationFilesAgreeOnWebOnlyPaths() throws {
        let prefixes = try sys9ParserWebOnlyPrefixes()

        for segment in ["book", "api", "sign-in", "privacy", "delete-account", "sfu-admin", "schedule"] {
            #expect(prefixes.contains(segment), "\(segment) is missing from webOnlyConclavePathPrefixes")
        }
        let components = try sys9AASAComponents()
        let filters = sys9AppLinkFilters(try sys9Source("Android/app/src/main/AndroidManifest.xml"))
        var webOnlyPaths: [String] = []
        for segment in prefixes.sorted() {
            webOnlyPaths += ["/\(segment)", "/\(segment)/rose-sora-luffy", "/\(segment)/a-b-c"]
        }

        webOnlyPaths += ["/transcript-pcm-processor.js", "/.well-known/apple-app-site-association", "/og.png"]
        for path in webOnlyPaths {
            #expect(!sys9AASAHandles(path, components: components), "\(path) is web-only but opens the app on iOS")
            #expect(!sys9AndroidCaptures(path, host: "conclave.acmvit.in", filters: filters), "\(path) is web-only but opens the app on Android")
            let target = NativeJoinLinkParser.parse("https://conclave.acmvit.in\(path)", allowRoomCreationForURLs: true)
            #expect(target.roomId.isEmpty, "\(path) is excluded by the AASA but the parser makes a room of it")
        }
    }

    @Test func everyPathTheOperatingSystemHandsOverParsesAsAJoinTarget() throws {
        for host in Self.hosts.sorted() {
            for path in Self.meetingPaths {
                let target = NativeJoinLinkParser.parse("https://\(host)\(path)", allowRoomCreationForURLs: true)
                #expect(!target.roomId.isEmpty, "\(host)\(path)")
                let expectedMode: JoinMode = path.hasPrefix("/w/") ? .webinarAttendee : .meeting
                #expect(target.joinMode == expectedMode, "\(host)\(path)")
            }

            let scheduled = NativeJoinLinkParser.parse("https://\(host)/sched-1a2b3c4d", allowRoomCreationForURLs: true)
            #expect(scheduled.roomId == "sched-1a2b3c4d")
        }
    }
}

private let sys9AASAPath = "apps/web/public/.well-known/apple-app-site-association"

private func sys9PackagePath(_ packageRelativePath: String) -> String {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent(packageRelativePath)
        .path
}

private func sys9RepoPath(_ repoRelativePath: String) -> String {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent(repoRelativePath)
        .path
}

private func sys9Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: URL(fileURLWithPath: sys9PackagePath(packageRelativePath)), encoding: .utf8)
}

private func sys9RepoSource(_ repoRelativePath: String) throws -> String {
    try String(contentsOf: URL(fileURLWithPath: sys9RepoPath(repoRelativePath)), encoding: .utf8)
}

private func sys9Matches(_ pattern: String, in text: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [["invalid pattern"]] }
    let ns = text as NSString
    return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
        (1..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
    }
}

private func sys9FullMatch(_ pattern: String, _ text: String) -> Bool {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else { return false }
    return regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
}

private struct SYS9Component {
    let path: String
    let exclude: Bool
    let comment: String
    let keys: Set<String>
}

private func sys9AASAComponents() throws -> [SYS9Component] {
    let text = try sys9RepoSource(sys9AASAPath)
    let root = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    let applinks = try #require(root["applinks"] as? [String: Any])
    let details = try #require(applinks["details"] as? [[String: Any]])
    let detail = try #require(details.first)
    let raw = try #require(detail["components"] as? [[String: Any]])
    return raw.map { entry in
        SYS9Component(
            path: entry["/"] as? String ?? "",
            exclude: entry["exclude"] as? Bool ?? false,
            comment: entry["comment"] as? String ?? "",
            keys: Set(entry.keys)
        )
    }
}

private func sys9AASAHandles(_ path: String, components: [SYS9Component]) -> Bool {
    for component in components where sys9FullMatch(sys9AASAGlobRegex(component.path), path) {
        return !component.exclude
    }
    return false
}

private func sys9AASAGlobRegex(_ pattern: String) -> String {
    var regex = "^"
    for character in pattern {
        switch character {
        case "*": regex += ".*"
        case "?": regex += "."
        default: regex += NSRegularExpression.escapedPattern(for: String(character))
        }
    }
    return regex + "$"
}

private struct SYS9AppLinkFilter {
    let actions: [String]
    let categories: [String]
    let data: [[String: String]]

    var hosts: Set<String> { Set(data.compactMap { $0["host"] }) }
    var schemes: Set<String> { Set(data.compactMap { $0["scheme"] }) }
    var pathSpecs: Set<String> {
        var specs: Set<String> = []
        for element in data {
            for (key, value) in element where key.hasPrefix("path") {
                specs.insert("\(key)=\(value)")
            }
        }
        return specs
    }
}

private func sys9AppLinkFilters(_ manifest: String) -> [SYS9AppLinkFilter] {
    sys9Matches(#"<intent-filter android:autoVerify="true">([\s\S]*?)</intent-filter>"#, in: manifest).map { groups in
        let body = groups[0]
        let data = sys9Matches(#"<data\s+([^>]*?)/>"#, in: body).map { element -> [String: String] in
            var attributes: [String: String] = [:]
            for pair in sys9Matches(#"android:(\w+)="([^"]*)""#, in: element[0]) {
                attributes[pair[0]] = pair[1]
            }
            return attributes
        }
        return SYS9AppLinkFilter(
            actions: sys9Matches(#"<action android:name="([^"]+)""#, in: body).map { $0[0] },
            categories: sys9Matches(#"<category android:name="([^"]+)""#, in: body).map { $0[0] },
            data: data
        )
    }
}

private func sys9AndroidCaptures(_ path: String, host: String, filters: [SYS9AppLinkFilter], aliasEnabled: Bool = true) -> Bool {
    guard aliasEnabled else { return false }
    let decoded = path.removingPercentEncoding ?? path
    for filter in filters where filter.hosts.contains(host) && filter.schemes.contains("https") {
        for element in filter.data {
            if let pattern = element["pathAdvancedPattern"], sys9AndroidAdvancedGlobMatches(pattern, decoded) { return true }
        }
    }
    return false
}

private func sys9AndroidAdvancedGlobMatches(_ pattern: String, _ path: String) -> Bool {
    let bytes = Array(pattern.utf8)
    let input = Array(path.utf8)
    var p = 0
    var i = 0
    while p < bytes.count {
        var allowed: Set<UInt8> = []
        if bytes[p] == 91 {
            p += 1
            while p < bytes.count && bytes[p] != 93 {
                if p + 2 < bytes.count && bytes[p + 1] == 45 && bytes[p + 2] != 93 {
                    guard bytes[p] <= bytes[p + 2] else { return false }
                    allowed.formUnion(bytes[p]...bytes[p + 2])
                    p += 3
                } else {
                    guard bytes[p] != 94 && bytes[p] != 92 else { return false }
                    allowed.insert(bytes[p])
                    p += 1
                }
            }
            guard p < bytes.count && !allowed.isEmpty else { return false }
            p += 1
        } else {
            guard ![46, 42, 43, 123, 125, 92, 93].contains(bytes[p]) else { return false }
            allowed.insert(bytes[p])
            p += 1
        }
        var minimum = 1
        var maximum = 1
        if p < bytes.count && (bytes[p] == 43 || bytes[p] == 42) {
            minimum = bytes[p] == 43 ? 1 : 0
            maximum = input.count
            p += 1
        } else if p < bytes.count && bytes[p] == 123 {
            p += 1
            let start = p
            while p < bytes.count && bytes[p] != 125 { p += 1 }
            guard p < bytes.count else { return false }
            let pieces = String(decoding: bytes[start..<p], as: UTF8.self).split(separator: ",", omittingEmptySubsequences: false)
            guard (1...2).contains(pieces.count), let lower = Int(pieces[0]), lower >= 0 else { return false }
            minimum = lower
            if pieces.count == 1 {
                maximum = lower
            } else {
                guard let upper = Int(pieces[1]), upper >= lower else { return false }
                maximum = upper
            }
            p += 1
        }
        var consumed = 0
        while i < input.count && consumed < maximum && allowed.contains(input[i]) {
            i += 1
            consumed += 1
        }
        guard consumed >= minimum else { return false }
    }
    return i == input.count
}

private func sys9ParserWebOnlyPrefixes() throws -> Set<String> {
    let source = try sys9Source("Sources/Conclave/Core/Networking/NativeJoinLinkParser.swift")
    let body = try #require(
        sys9Matches(#"webOnlyConclavePathPrefixes[^=\n]*=\s*\[([^\]]*)\]"#, in: source).first?.first,
        "webOnlyConclavePathPrefixes moved; update sys9ParserWebOnlyPrefixes"
    )
    let prefixes = Set(sys9Matches(#""([^"]+)""#, in: body).map { $0[0] })
    #expect(!prefixes.isEmpty)
    return prefixes
}

private struct SYS9Setting {
    let name: String
    let conditions: String
    let value: String
}

private func sys9Resolve(_ name: String, configuration: String, settings: [SYS9Setting], depth: Int = 0) -> String? {
    var base: String?
    var conditional: String?
    for setting in settings where setting.name == name {
        if setting.conditions.isEmpty {
            base = setting.value
        } else if setting.conditions == "[config=\(configuration)]" {
            conditional = setting.value
        }
    }
    guard let value = conditional ?? base else { return nil }
    return sys9Expand(value, configuration: configuration, settings: settings, depth: depth + 1)
}

private func sys9Expand(_ value: String, configuration: String, settings: [SYS9Setting], depth: Int = 0) -> String {
    guard depth < 5,
          let regex = try? NSRegularExpression(pattern: #"\$\(([A-Za-z_][A-Za-z0-9_]*)\)"#),
          let match = regex.firstMatch(in: value, range: NSRange(location: 0, length: (value as NSString).length)) else {
        return value
    }
    let ns = value as NSString
    let name = ns.substring(with: match.range(at: 1))
    let replacement = sys9Resolve(name, configuration: configuration, settings: settings, depth: depth + 1) ?? ""
    let expanded = ns.replacingCharacters(in: match.range, with: replacement)
    return sys9Expand(expanded, configuration: configuration, settings: settings, depth: depth + 1)
}
#endif
