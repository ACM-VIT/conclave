#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// SYS-9 (S70 9 c, d, f, l 1 to 4; S70 0.7 SY14; RECONCILE R42; S10 4 m): the operating-system link layer.
/// Every check reads the shipped file (the AASA and assetlinks.json in apps/web, the Android manifest, the
/// entitlements and the xcconfig) and matches sample paths with each platform's own rules (AASA component
/// globs on iOS, a forward-only advanced-glob model on Android). SYS9AppLinkMatcherTests also feeds the shipped
/// Android patterns to the framework matcher. Routing after intake is ENT-2 (S10 4).
@MainActor
struct SYS9DeepLinkTests {
    private static let appID = "RZGK9VX3KX.com.acmvit.conclave"
    private static let packageName = "com.acmvit.conclave"
    private static let hosts: Set<String> = ["conclave.acmvit.in", "www.conclave.acmvit.in"]

    // S70 9 c: the spec's exclusions, verbatim, and the three includes in order.
    private static let specExclusions = [
        "/book/*", "/api/*", "/sign-in*", "/privacy*", "/delete-account*", "/sfu-admin*", "/schedule*",
    ]
    private static let includes = ["/w/*", "/*-*-*", "/sched-*"]

    // SYS-9 owner policy: strict paths on API 31+, browser fallback on API 28 to 30.
    private static let androidPathSpecs: Set<String> = [
        "pathAdvancedPattern=/w/[a-zA-Z0-9][a-zA-Z0-9-]{0,31}",
        "pathAdvancedPattern=/[a-zA-Z0-9]+-[a-zA-Z0-9]+-[a-zA-Z0-9]+",
        "pathAdvancedPattern=/sched-[0-9a-fA-F]{8}",
    ]

    // Paths both platforms hand to the app; each parses as a join target (S70 9 f).
    private static let meetingPaths = [
        "/rose-sora-luffy", // three-word meeting code
        "/brave-otter-4821", // scheduled meeting code, adjective-noun-NNNN (PRE 3.1)
        "/w/abc123", // webinar attendee link
        "/w/team-all-hands",
        "/sched-1a2b3c4d", // scheduled webinar host room (SY14)
        "/sched-ule-room", // S10 4 l 6: still a room
    ]

    // Paths neither platform hands to the app: single-word, custom-tenant and two-word codes have no safe
    // pattern (S10 4 m, S70 9 f), and web-only pages stay in the browser.
    private static let browserPaths = [
        "/", "/acme", "/standup", "/rose-sora", "/w",
        "/sign-in", "/sign-in/callback", "/privacy", "/delete-account", "/sfu-admin", "/schedule", "/schedule/team",
        "/book/ishaan/intro", "/api/sfu/join",
    ]

    // Former Android false positives: these must now remain in the browser on both platforms.
    private static let webOnlyExcludedPaths = [
        "/book/ishaan/30-min-chat", "/schedule/team-sync-call", "/_next/static/chunks/main-app-1a2b.js",
        "/transcript-pcm-processor.js",
    ]

    // S70 9 d fingerprint audit (2026-10-27). FA:C6:...:3B:9C was removed: it is the public React Native
    // template debug keystore (CN=Android Debug, 2014), the one checked in at apps/mobile/android/app/debug.keystore,
    // so any APK signed with it could claim conclave.acmvit.in links. The remaining fingerprint is the one the
    // owner confirms against Play Console app signing; change this list only together with that confirmation.
    private static let auditedReleaseFingerprints = [
        "91:92:9B:89:E1:A9:35:67:4A:9F:F7:7C:9B:36:BD:B9:D4:21:07:41:D6:21:55:38:52:D3:AB:BF:08:80:E9:00",
    ]
    private static let publicDebugFingerprints: Set<String> = [
        "FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C",
    ]

    // MARK: iOS association file (S70 9 c, l 1)

    @Test func aasaUsesTheComponentsFormWithExclusionsFirst() throws {
        let text = try sys9RepoSource(sys9AASAPath)
        #expect(!text.hasPrefix("\u{FEFF}"))
        #expect(Data(text.utf8).count < 128 * 1024, "Apple rejects an AASA above 128 KB")
        // Served at the extensionless path only (Apple reads exactly this name).
        #expect(!FileManager.default.fileExists(atPath: sys9RepoPath(sys9AASAPath + ".json")))

        let root = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        #expect(Set(root.keys) == ["applinks"])
        let applinks = try #require(root["applinks"] as? [String: Any])
        // No legacy "apps" array; the components form replaces the iOS 12 "paths" form (CE J23).
        #expect(Set(applinks.keys) == ["details"])
        let details = try #require(applinks["details"] as? [[String: Any]])
        #expect(details.count == 1)
        let detail = try #require(details.first)
        #expect(Set(detail.keys) == ["appIDs", "components"])
        #expect(detail["appIDs"] as? [String] == [Self.appID])

        let components = try sys9AASAComponents()
        #expect(!components.isEmpty)
        for component in components {
            #expect(!component.path.isEmpty, "every component matches on the path")
            // No "?" or "#" keys, so invite and mode query strings still match the includes.
            #expect(component.keys.isSubset(of: ["/", "exclude", "comment"]), "\(component.keys.sorted())")
            #expect(!component.comment.isEmpty, "\(component.path) needs a comment")
        }
        let includeIndices = components.indices.filter { !components[$0].exclude }
        let excludeIndices = components.indices.filter { components[$0].exclude }
        let firstInclude = try #require(includeIndices.first)
        #expect(excludeIndices.allSatisfy { $0 < firstInclude }, "exclusions come first")
        #expect(includeIndices.map { components[$0].path } == Self.includes)
        let exclusions = excludeIndices.map { components[$0].path }
        for pattern in Self.specExclusions {
            #expect(exclusions.contains(pattern), "\(pattern) is missing")
        }
        #expect(exclusions.count == Set(exclusions).count, "duplicate exclusion")
        // No catch-all include: custom-tenant and single-word codes stay on the web (S10 4 m).
        for path in Self.includes {
            #expect(path != "*" && path != "/*" && path != "/*/*")
        }
    }

    @Test func aasaHandsOnlyMeetingPathsToTheApp() throws {
        let components = try sys9AASAComponents()
        for path in Self.meetingPaths {
            #expect(sys9AASAHandles(path, components: components), "\(path) must open the app")
        }
        for path in Self.browserPaths + Self.webOnlyExcludedPaths {
            #expect(!sys9AASAHandles(path, components: components), "\(path) must stay in the browser")
        }
    }

    // MARK: Android App Links (S70 9 d, SY14)

    @Test func androidAppLinksClaimTheSameMeetingPathsOnBothHosts() throws {
        let manifest = try sys9Source("Android/app/src/main/AndroidManifest.xml")
        let alias = try sys9AppLinkAlias(manifest)
        let filters = sys9AppLinkFilters(alias)
        #expect(filters.count == 2, "one verified filter per host")
        var verifiedHosts: Set<String> = []
        for filter in filters {
            #expect(filter.actions == ["android.intent.action.VIEW"])
            #expect(Set(filter.categories) == ["android.intent.category.DEFAULT", "android.intent.category.BROWSABLE"])
            #expect(filter.schemes == ["https"])
            #expect(filter.hosts.count == 1, "\(filter.hosts.sorted())")
            verifiedHosts.formUnion(filter.hosts)
            // Every data element carries exactly one path, so no filter captures a whole host.
            for element in filter.data {
                let pathKeys = element.keys.filter { $0.hasPrefix("path") }
                #expect(pathKeys.count == 1, "\(element)")
            }
            #expect(filter.pathSpecs == Self.androidPathSpecs, "\(filter.pathSpecs.sorted())")
        }
        #expect(verifiedHosts == Self.hosts)
        // https appears only inside the verified filters; no plain http link capture.
        let httpsCount = manifest.components(separatedBy: "android:scheme=\"https\"").count - 1
        #expect(httpsCount == filters.reduce(0) { $0 + $1.data.count })
        #expect(!manifest.contains("android:scheme=\"http\""))
        // Kept: singleTask with onNewIntent delivery (CE C30, J6) and the conclave:// scheme (CE C31).
        #expect(manifest.contains("android:launchMode=\"singleTask\""))
        #expect(manifest.contains("<data android:scheme=\"conclave\" />"))
    }

    @Test func androidHttpsAliasIsDisabledUntilApi31AndLeavesMainActivityIntact() throws {
        let manifest = try sys9Source("Android/app/src/main/AndroidManifest.xml")
        let alias = try sys9AppLinkAlias(manifest)
        #expect(alias.contains("android:targetActivity=\".MainActivity\""))
        #expect(alias.contains("android:enabled=\"@bool/conclave_verified_app_links_enabled\""))
        #expect(alias.contains("android:exported=\"true\""))
        #expect(!alias.contains("android:launchMode="), "alias inherits the target's singleTask mode")
        #expect(!alias.contains("android.intent.category.LAUNCHER"))
        let main = try #require(sys9Matches(#"<activity\s+android:name=".MainActivity"([\s\S]*?)</activity>"#, in: manifest).first?.first)
        #expect(main.contains("android:launchMode=\"singleTask\""))
        #expect(main.contains("android.intent.category.LAUNCHER"))
        #expect(main.contains("<data android:scheme=\"conclave\" />"))
        #expect(!main.contains("android:scheme=\"https\""))
        let beforeAlias = try #require(manifest.components(separatedBy: "<activity-alias").first)
        #expect(beforeAlias.contains("</activity>"), "target must precede alias")
        #expect(sys9AppLinkFilters(manifest).count == sys9AppLinkFilters(alias).count,
                "every verified filter must live on the gated alias")
        #expect(try !sys9AndroidAliasEnabled(apiLevel: 28))
        #expect(try !sys9AndroidAliasEnabled(apiLevel: 29))
        #expect(try !sys9AndroidAliasEnabled(apiLevel: 30))
        #expect(try sys9AndroidAliasEnabled(apiLevel: 31))
        #expect(try sys9AndroidAliasEnabled(apiLevel: 36))
    }

    @Test func androidNineThroughElevenKeepEveryHttpsLinkInTheBrowser() throws {
        let filters = sys9AppLinkFilters(try sys9Source("Android/app/src/main/AndroidManifest.xml"))
        for apiLevel in 28...30 {
            let enabled = try sys9AndroidAliasEnabled(apiLevel: apiLevel)
            for host in Self.hosts {
                for path in Self.meetingPaths + Self.browserPaths + Self.webOnlyExcludedPaths {
                    #expect(!sys9AndroidCaptures(path, host: host, filters: filters, aliasEnabled: enabled),
                            "API \(apiLevel): \(host)\(path) must stay in the browser")
                }
            }
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

    @Test func androidMatcherDoesNotBacktrackAcrossGreedyTokens() {
        #expect(!sys9AndroidAdvancedGlobMatches("[a-z]+b", "ab"))
        #expect(!sys9AndroidAdvancedGlobMatches("[a-z]{1,3}b", "ab"))
        #expect(sys9AndroidAdvancedGlobMatches("[a-z]+-[a-z]+", "ab-cd"))
        #expect(sys9AndroidAdvancedGlobMatches("[a-z][a-z-]{0,2}", "a"))
        #expect(!sys9AndroidAdvancedGlobMatches("[a-z][a-z-]{0,2}", "abcd"))
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

    // MARK: Parser agreement (RECONCILE R42, S10 0.8 C16; S70 9 l 4)

    @Test func parserAndAssociationFilesAgreeOnWebOnlyPaths() throws {
        let prefixes = try sys9ParserWebOnlyPrefixes()
        // R42 and C16 (ENT-2): the parser's web-only list gains schedule, matching the AASA exclusion.
        for segment in ["book", "api", "sign-in", "privacy", "delete-account", "sfu-admin", "schedule"] {
            #expect(prefixes.contains(segment), "\(segment) is missing from webOnlyConclavePathPrefixes")
        }
        let components = try sys9AASAComponents()
        let filters = sys9AppLinkFilters(try sys9Source("Android/app/src/main/AndroidManifest.xml"))
        var webOnlyPaths: [String] = []
        for segment in prefixes.sorted() {
            webOnlyPaths += ["/\(segment)", "/\(segment)/rose-sora-luffy", "/\(segment)/a-b-c"]
        }
        // The parser rejects a dotted first segment (static files); the AASA excludes paths with a dot.
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
            // SY14: the scheduled webinar host room keeps its exact code.
            let scheduled = NativeJoinLinkParser.parse("https://\(host)/sched-1a2b3c4d", allowRoomCreationForURLs: true)
            #expect(scheduled.roomId == "sched-1a2b3c4d")
        }
    }

    // MARK: Android association file (S70 9 d, l 1)

    @Test func assetLinksListOnlyTheAuditedReleaseFingerprint() throws {
        let text = try sys9RepoSource("apps/web/public/.well-known/assetlinks.json")
        let statements = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [[String: Any]])
        #expect(statements.count == 1)
        let statement = try #require(statements.first)
        #expect(Set(statement.keys) == ["relation", "target"])
        #expect(statement["relation"] as? [String] == ["delegate_permission/common.handle_all_urls"])
        let target = try #require(statement["target"] as? [String: Any])
        #expect(target["namespace"] as? String == "android_app")
        #expect(target["package_name"] as? String == Self.packageName)
        let fingerprints = try #require(target["sha256_cert_fingerprints"] as? [String])
        #expect(fingerprints == Self.auditedReleaseFingerprints)
        for fingerprint in fingerprints {
            #expect(sys9FullMatch(#"^([0-9A-F]{2}:){31}[0-9A-F]{2}$"#, fingerprint), "\(fingerprint) is not an upper-case SHA-256")
            #expect(!Self.publicDebugFingerprints.contains(fingerprint), "debug fingerprints belong on a staging host")
        }
        #expect(fingerprints.count == Set(fingerprints).count)
    }

    @Test func associationFilesNameTheShippedAppIdentity() throws {
        let env = sys9XcconfigSettings(try sys9Source("Skip.env"))
        let bundleID = try #require(sys9Resolve("PRODUCT_BUNDLE_IDENTIFIER", configuration: "Release", settings: env))
        #expect(bundleID == Self.packageName)
        // The Skip build plugin sets applicationId = ANDROID_APPLICATION_ID ?? PRODUCT_BUNDLE_IDENTIFIER
        // (Android/app/build.gradle.kts), so the package stays the bundle id while that override is unset.
        #expect(!env.contains { $0.name == "ANDROID_APPLICATION_ID" })
        #expect(Self.appID.hasSuffix(".\(bundleID)"))
    }

    // MARK: Entitlements (S70 9 c; S70R 21.2)

    @Test func entitlementsAddTheDeveloperDomainInDebugOnly() throws {
        let entitlements = try sys9Plist("Darwin/Entitlements.plist")
        #expect(Set(entitlements.keys) == [
            "com.apple.developer.applesignin", "com.apple.developer.associated-domains", "com.apple.security.application-groups",
        ])
        #expect(entitlements["com.apple.developer.applesignin"] as? [String] == ["Default"])
        #expect(entitlements["com.apple.security.application-groups"] as? [String] == ["group.com.acmvit.conclave.screenshare"])
        let domains = try #require(entitlements["com.apple.developer.associated-domains"] as? [String])
        #expect(domains == [
            "applinks:conclave.acmvit.in", "applinks:www.conclave.acmvit.in", "$(CONCLAVE_DEVELOPER_ASSOCIATED_DOMAIN)",
        ])
        #expect(domains.allSatisfy { !$0.contains("mode=") }, "the developer mode lives in the Debug setting only")

        let settings = sys9XcconfigSettings(try sys9Source("Darwin/Conclave.xcconfig"))
        // One entitlements file for every configuration; Debug differs only through the build setting.
        #expect(settings.filter { $0.name == "CODE_SIGN_ENTITLEMENTS" }.map { "\($0.conditions)=\($0.value)" } == ["=Entitlements.plist"])
        #expect(settings.filter { $0.name == "CONCLAVE_DEVELOPER_ASSOCIATED_DOMAIN" }.map { $0.conditions } == ["", "[config=Debug]"])
        #expect(settings.filter { $0.name == "CONCLAVE_DEVELOPER_APPLINKS_HOST" }.map { $0.conditions } == [""])

        let release = Set(domains.map { sys9Expand($0, configuration: "Release", settings: settings) })
        let debug = Set(domains.map { sys9Expand($0, configuration: "Debug", settings: settings) })
        let production: Set<String> = ["applinks:conclave.acmvit.in", "applinks:www.conclave.acmvit.in"]
        #expect(release == production, "\(release.sorted())")
        #expect(release.allSatisfy { !$0.contains("mode=") }, "Release never carries a developer domain")
        #expect(debug == production.union(["applinks:conclave.acmvit.in?mode=developer"]), "\(debug.sorted())")

        // The same two hosts on both platforms and in the parser's production host check.
        let entitlementHosts = Set(domains.filter { !$0.contains("$(") }.map { String($0.dropFirst("applinks:".count)) })
        #expect(entitlementHosts == Self.hosts)
        // The broadcast extension never claims links.
        let extensionEntitlements = try sys9Plist("Darwin/ScreenShareExtension/ScreenShareExtension.entitlements")
        #expect(extensionEntitlements["com.apple.developer.associated-domains"] == nil)
    }

    @Test func customSchemeStaysRegisteredOnBothPlatforms() throws {
        let info = try sys9Plist("Darwin/Info.plist")
        let types = try #require(info["CFBundleURLTypes"] as? [[String: Any]])
        let schemes = types.flatMap { ($0["CFBundleURLSchemes"] as? [String]) ?? [] }
        #expect(schemes.contains("conclave"))
        let manifest = try sys9Source("Android/app/src/main/AndroidManifest.xml")
        #expect(manifest.contains("<data android:scheme=\"conclave\" />"))
    }

    // MARK: Hygiene (HD RULES 3)

    @Test func linkFilesAreDashFree() throws {
        let texts = [
            try sys9RepoSource(sys9AASAPath),
            try sys9RepoSource("apps/web/public/.well-known/assetlinks.json"),
            try sys9Source("Android/app/src/main/AndroidManifest.xml"),
            try sys9Source("Darwin/Entitlements.plist"),
            try sys9Source("Darwin/Conclave.xcconfig"),
            try String(contentsOf: URL(fileURLWithPath: #filePath), encoding: .utf8),
        ]
        for text in texts {
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"))
        }
    }
}

// MARK: SYS-9 helpers

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

private func sys9Plist(_ packageRelativePath: String) throws -> [String: Any] {
    let data = try Data(contentsOf: URL(fileURLWithPath: sys9PackagePath(packageRelativePath)))
    return try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
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

// MARK: AASA components

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

/// Apple's component matching: the first component whose "/" pattern matches decides, an excluded match keeps
/// the link in the browser, and no match keeps it in the browser too. In a pattern, "*" is any run of
/// characters (slashes included) and "?" is one character; matching is case sensitive by default.
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

// MARK: Android App Link filters

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

private func sys9AppLinkAlias(_ manifest: String) throws -> String {
    try #require(sys9Matches(#"(<activity-alias\s+android:name=".MeetingAppLinks"[\s\S]*?</activity-alias>)"#, in: manifest).first?.first)
}

private func sys9AndroidAliasEnabled(apiLevel: Int) throws -> Bool {
    let directory = apiLevel >= 31 ? "values-v31" : "values"
    let xml = try sys9Source("Android/app/src/main/res/\(directory)/app_links.xml")
    let value = try #require(sys9Matches(#"<bool name="conclave_verified_app_links_enabled">(true|false)</bool>"#, in: xml).first?.first)
    return value == "true"
}

/// Android merges data elements inside each filter. Uri.getPath() is decoded once before framework matching.
/// The enabled resource is tested separately: API 28 to 30 does not participate in HTTPS resolution at all.
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

/// A bounded model of the shipped advanced-glob subset: ASCII literals, positive sets/ranges, +, * and {m,n}.
/// Each token greedily consumes its input and never gives characters back. This deliberately does not turn
/// the pattern into a regular expression: Android rejects [a-z]+b against ab, unlike a backtracking regex.
/// Unsupported syntax fails closed. Framework PatternMatcher/IntentFilter tests provide the Android oracle.
private func sys9AndroidAdvancedGlobMatches(_ pattern: String, _ path: String) -> Bool {
    let bytes = Array(pattern.utf8)
    let input = Array(path.utf8)
    var p = 0
    var i = 0
    while p < bytes.count {
        var allowed: Set<UInt8> = []
        if bytes[p] == 91 { // [
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
        } else if p < bytes.count && bytes[p] == 123 { // {
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

// MARK: Parser source

/// The parser's web-only first segments, read from its source so the AASA check follows ENT-2's list.
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

// MARK: xcconfig

private struct SYS9Setting {
    let name: String
    let conditions: String
    let value: String
}

private func sys9XcconfigSettings(_ text: String) -> [SYS9Setting] {
    var settings: [SYS9Setting] = []
    for rawLine in text.split(whereSeparator: { $0.isNewline }) {
        let line = rawLine.trimmingCharacters(in: .whitespaces)
        if line.hasPrefix("//") || line.hasPrefix("#") { continue }
        guard let match = sys9Matches(#"^([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]]*\])*)\s*=\s*(.*)$"#, in: line).first else {
            continue
        }
        settings.append(SYS9Setting(name: match[0], conditions: match[1], value: match[2].trimmingCharacters(in: .whitespaces)))
    }
    return settings
}

/// One setting for one configuration: a matching `[config=...]` assignment overrides the unconditional one
/// (the xcconfig lists the unconditional line first, so both of Xcode's precedence readings agree), then
/// `$(NAME)` references expand, an unknown name expanding to nothing as in Xcode.
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
