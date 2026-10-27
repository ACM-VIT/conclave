#if !SKIP
import Foundation
import Testing

/// SYS-14 localization infrastructure (S70 14 c, d and l 1, 2, 6; S70 0.7 SY12, SY13; S70 16 c, d and l 5;
/// S10 0.8 C12, purpose strings part). Every check reads the shipped source file, so a regenerated project,
/// manifest or catalog is checked as it will build.
struct SYS14LocalizationInfraTests {
    // S70 16 c: the only purpose strings the app declares, with their final copy (S10 7 c for camera and microphone).
    private static let purposeStrings: [String: String] = [
        "NSCameraUsageDescription": "Conclave uses your camera so people in your meeting can see you.",
        "NSMicrophoneUsageDescription": "Conclave uses your microphone so people in your meeting can hear you.",
        "NSLocalNetworkUsageDescription": "Conclave uses the local network to connect your meeting\u{2019}s audio and video.",
        "NSPhotoLibraryAddUsageDescription": "Conclave saves images to your photo library only when you choose to save them.",
    ]

    // S70 16 d: the full allowed uses-permission set (SY5's Telecom pair is spike-branch only).
    private static let androidPermissions: Set<String> = [
        "INTERNET", "ACCESS_NETWORK_STATE", "RECORD_AUDIO", "CAMERA", "MODIFY_AUDIO_SETTINGS", "VIBRATE",
        "BLUETOOTH", "BLUETOOTH_CONNECT", "FOREGROUND_SERVICE", "FOREGROUND_SERVICE_MICROPHONE",
        "FOREGROUND_SERVICE_CAMERA", "FOREGROUND_SERVICE_MEDIA_PLAYBACK", "FOREGROUND_SERVICE_MEDIA_PROJECTION",
        "WAKE_LOCK", "POST_NOTIFICATIONS",
    ]

    // S70 16 l 5 and SY12: Info.plist declares only the purpose strings the app uses, in final copy, and no voip mode.
    @Test func appInfoPlistDeclaresOnlyTheUsedPurposeStrings() throws {
        let plist = try sys14Plist("Darwin/Info.plist")
        let declared = Set(plist.keys.filter { $0.hasSuffix("UsageDescription") || $0.hasSuffix("UsageDescriptionDictionary") })
        #expect(declared == Set(Self.purposeStrings.keys), "\(declared.symmetricDifference(Set(Self.purposeStrings.keys)).sorted())")
        for (key, copy) in Self.purposeStrings {
            let value = plist[key] as? String
            #expect(value == copy, "\(key)")
            // Sentence case, one sentence, resolved text (S70 16 g; S70 14 g).
            #expect(value?.hasPrefix("Conclave ") == true && value?.hasSuffix(".") == true, "\(key)")
            #expect(value?.dropLast().contains(Character(".")) == false, "\(key) must be one sentence")
            #expect(value?.contains("$(") == false, "\(key)")
        }
        #expect(plist["NSUserNotificationsUsageDescription"] == nil)
        #expect(plist["NSLocationTemporaryUsageDescriptionDictionary"] == nil)
        #expect(plist["UIBackgroundModes"] as? [String] == ["audio"])
        #expect(plist["CFBundleDisplayName"] as? String == "Conclave")
        // CFBundleDevelopmentRegion stays English (CE N12) and the bundle claims no other localization.
        #expect(plist["CFBundleDevelopmentRegion"] as? String == "$(DEVELOPMENT_LANGUAGE)")
        if let localizations = plist["CFBundleLocalizations"] as? [String] {
            #expect(localizations == ["en"])
        }
        #expect(try sys14Source("Package.swift").contains("defaultLocalization: \"en\""))
    }

    // S70 14 c and SY12: Darwin/InfoPlist.xcstrings is the single source for the purpose strings and the display name.
    @Test func infoPlistCatalogLocalizesEveryPurposeStringAndTheDisplayName() throws {
        let plist = try sys14Plist("Darwin/Info.plist")
        let catalog = try sys14JSON("Darwin/InfoPlist.xcstrings")
        #expect(catalog["sourceLanguage"] as? String == "en")
        #expect(catalog["version"] as? String == "1.0")
        let strings = try #require(catalog["strings"] as? [String: Any])
        var expected = Set(Self.purposeStrings.keys)
        expected.insert("CFBundleDisplayName")
        #expect(Set(strings.keys) == expected, "\(Set(strings.keys).symmetricDifference(expected).sorted())")
        for key in expected.sorted() {
            let entry = try #require(strings[key] as? [String: Any], "missing \(key)")
            #expect((entry["comment"] as? String)?.isEmpty == false, "uncommented \(key)")
            #expect(entry["extractionState"] as? String == "manual", "\(key)")
            let localizations = try #require(entry["localizations"] as? [String: Any], "\(key)")
            // Shipped languages only: English until a real translation ships (S70 14 c).
            #expect(Array(localizations.keys) == ["en"], "\(key) claims \(localizations.keys.sorted())")
            let unit = (localizations["en"] as? [String: Any])?["stringUnit"] as? [String: Any]
            #expect(unit?["state"] as? String == "translated", "\(key)")
            // The plist value is the fallback; it must never disagree with the catalog.
            #expect(unit?["value"] as? String == plist[key] as? String, "\(key) differs from Darwin/Info.plist")
        }
    }

    // S70 14 c and l 2: the app target ships the catalog and the project claims only English.
    @Test func xcodeProjectShipsTheInfoPlistCatalogAndClaimsOnlyEnglish() throws {
        let project = try sys14Source("Darwin/Conclave.xcodeproj/project.pbxproj")
        #expect(project.contains("/* InfoPlist.xcstrings */ = {isa = PBXFileReference; lastKnownFileType = text.json.xcstrings; path = InfoPlist.xcstrings; sourceTree = \"<group>\"; };"))
        #expect(project.components(separatedBy: "/* InfoPlist.xcstrings */ = {isa = PBXFileReference;").count - 1 == 1)
        #expect(project.components(separatedBy: "/* InfoPlist.xcstrings in Resources */").count - 1 == 2)
        let appResources = try sys14Block(after: "499CD43E2AC5B799001AE8D8 /* Resources */ = {", in: project)
        #expect(appResources.contains("/* InfoPlist.xcstrings in Resources */,"))
        let extensionResources = try sys14Block(after: "D8437152ED65B65BAD66390E /* Resources */ = {", in: project)
        #expect(!extensionResources.contains("InfoPlist.xcstrings"), "the broadcast extension gets its own catalog (S70 10 c)")
        #expect(project.contains("developmentRegion = en;"))
        let regions = try sys14Block(after: "knownRegions = (", in: project, until: ");")
            .split(whereSeparator: { $0 == "," || $0.isWhitespace })
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
            .filter { !$0.isEmpty }
        #expect(regions == ["en", "Base"])
        // Pseudolanguage launch arguments (Default Q14) are available in the shared scheme and off by default.
        let scheme = try sys14Source("Darwin/Conclave.xcodeproj/xcshareddata/xcschemes/Conclave App.xcscheme")
        let arguments = sys14Matches(#"argument = "([^"]+)"\s*isEnabled = "(YES|NO)""#, in: scheme)
        #expect(arguments.map { $0[0] } == ["-NSDoubleLocalizedStrings YES", "-AppleTextDirection YES", "-NSForceRightToLeftWritingDirection YES"])
        #expect(arguments.allSatisfy { $0[1] == "NO" })
    }

    // S70 14 c: the template translations are gone, so neither platform claims a language it does not ship.
    @Test func catalogsAndResourcesClaimOnlyShippedLanguages() throws {
        var iosLanguages = Set<String>()
        for path in ["Sources/Conclave/Resources/Localizable.xcstrings", "Darwin/InfoPlist.xcstrings"] {
            let catalog = try sys14JSON(path)
            #expect(catalog["sourceLanguage"] as? String == "en", "\(path)")
            let strings = try #require(catalog["strings"] as? [String: Any], "\(path)")
            for (key, value) in strings {
                let localizations = ((value as? [String: Any])?["localizations"] as? [String: Any]) ?? [:]
                for language in localizations.keys where language != "en" {
                    iosLanguages.insert(String(language.prefix(while: { $0 != "-" && $0 != "_" })))
                    Issue.record("\(path): \(key) claims \(language)")
                }
            }
        }
        var androidLanguages = Set<String>()
        for folder in try FileManager.default.contentsOfDirectory(atPath: sys14PackagePath("Android/app/src/main/res"))
            where folder.hasPrefix("values") {
            for qualifier in folder.split(separator: "-").dropFirst() {
                let text = String(qualifier)
                if text.hasPrefix("b+") {
                    androidLanguages.insert(String(text.dropFirst(2).prefix(while: { $0 != "+" })))
                } else if text.count == 2, text.allSatisfy({ $0.isASCII && $0.isLowercase }) {
                    androidLanguages.insert(text)
                }
            }
        }
        // English only until translations ship; a shipped translation lands on both platforms in one change.
        #expect(iosLanguages.isEmpty)
        #expect(androidLanguages.isEmpty, "\(androidLanguages.sorted())")
        #expect(androidLanguages == iosLanguages)
    }

    // S70 14 d and SY13: AGP generates android:localeConfig from res/values*; English is the unqualified locale.
    @Test func androidGeneratesTheLocaleConfigFromShippedResources() throws {
        let gradle = sys14Normalized(try sys14Source("Android/app/build.gradle.kts"))
        #expect(gradle.contains("androidResources { generateLocaleConfig = true }"))
        #expect(gradle.components(separatedBy: "generateLocaleConfig").count - 1 == 1)
        // OD WP1-2a: en-XA and ar-XB on debug builds only (also pinned by DesignContractsTests).
        #expect(gradle.contains("buildTypes { debug { isPseudoLocalesEnabled = true } release {"))
        let properties = try sys14Source("Android/app/src/main/res/resources.properties")
            .split(whereSeparator: { $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespaces) }
        #expect(properties.contains("unqualifiedResLocale=en-US"))
        let manifest = try sys14Source("Android/app/src/main/AndroidManifest.xml")
        // The manifest merger rejects a hand-written localeConfig while generation is on.
        #expect(!manifest.contains("android:localeConfig="))
        #expect(!FileManager.default.fileExists(atPath: sys14PackagePath("Android/app/src/main/res/xml/locales_config.xml")))
        #expect(manifest.contains("android:supportsRtl=\"true\""))
        // A per-app language change recomposes instead of recreating the activity (CE N11).
        let changes = try #require(sys14Matches(#"android:configChanges="([^"]+)""#, in: manifest).first?.first)
        let kinds = Set(changes.split(separator: "|").map { String($0) })
        #expect(kinds.isSuperset(of: ["locale", "layoutDirection"]))
    }

    // S70 16 l 5 and SY13: the uses-permission set equals the 16 d list and the two storage removals stay.
    @Test func androidManifestPermissionsMatchTheReleaseDeclarationList() throws {
        let manifest = try sys14Source("Android/app/src/main/AndroidManifest.xml")
        let entries = sys14Matches(#"<uses-permission\s+android:name="android\.permission\.([A-Z_]+)"([^>]*)/>"#, in: manifest)
        let removed = Set(entries.filter { $0[1].contains("tools:node=\"remove\"") }.map { $0[0] })
        let declared = entries.filter { !$0[1].contains("tools:node=\"remove\"") }.map { $0[0] }
        #expect(declared.count == Set(declared).count, "duplicate uses-permission")
        #expect(Set(declared) == Self.androidPermissions, "\(Set(declared).symmetricDifference(Self.androidPermissions).sorted())")
        #expect(removed == ["READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE"])
        let bluetooth = try #require(entries.first(where: { $0[0] == "BLUETOOTH" }))
        #expect(bluetooth[1].contains("android:maxSdkVersion=\"30\""))
        for forbidden in ["READ_PHONE_STATE", "USE_FULL_SCREEN_INTENT", "MANAGE_OWN_CALLS", "FOREGROUND_SERVICE_PHONE_CALL"] {
            #expect(!manifest.contains("android.permission.\(forbidden)\""), "\(forbidden)")
        }
    }

    // SY12: the build phase copies privacy manifests only and never writes purpose strings into built plists.
    @Test func privacyMetadataPhaseNeverWritesPurposeStrings() throws {
        let script = try sys14Source("Darwin/Scripts/apply-embedded-privacy-metadata.sh")
        #expect(script.hasPrefix("#!/bin/sh\nset -eu\n"))
        for pattern in ["UsageDescription", "PlistBuddy", "plutil", "defaults write", "Info.plist\"", "*.bundle", "PlugIns", ".appex"] {
            #expect(!sys14Code(script).contains(pattern), "the script still touches \(pattern)")
        }
        for (framework, manifest) in [("Conclave", "ConclaveFramework"), ("WebRTC", "WebRTCFramework"), ("Mediasoup", "MediasoupFramework")] {
            #expect(script.contains("apply_framework_privacy_manifest \"\(framework).framework\" \"\(manifest).xcprivacy\""))
            #expect(FileManager.default.fileExists(atPath: sys14PackagePath("Darwin/PrivacyManifests/\(manifest).xcprivacy")))
        }
        #expect(script.contains("cp \"${manifest_path}\" \"${framework_path}/PrivacyInfo.xcprivacy\""))
        #expect(script.contains("resign_code_bundle_if_needed \"${framework_path}\""))
        #expect(script.contains("--preserve-metadata=identifier,entitlements,flags"))
        let project = try sys14Source("Darwin/Conclave.xcodeproj/project.pbxproj")
        #expect(project.contains("DED5F813849FF18CBE9AFB5A /* Embed App Extensions */,\n\t\t\t\t8D0E0D6B2E5A4A71B57E90C1 /* Apply embedded privacy metadata */,"))
        #expect(project.contains("shellScript = \"sh \\\"${SRCROOT}/Scripts/apply-embedded-privacy-metadata.sh\\\"\\n\";"))
    }

    // S70 14 l 6 (dash half; casing stays with labelCasingFollowsOwnerRule): no en or em dash in any catalog,
    // resource or declaration file this slice owns or creates.
    @Test func catalogsResourcesAndDeclarationsAreDashFree() throws {
        var files = [
            "Darwin/Info.plist", "Darwin/InfoPlist.xcstrings", "Darwin/Scripts/apply-embedded-privacy-metadata.sh",
            "Darwin/Conclave.xcodeproj/project.pbxproj", "Darwin/Conclave.xcodeproj/xcshareddata/xcschemes/Conclave App.xcscheme",
            "Sources/Conclave/Resources/Localizable.xcstrings", "Android/app/build.gradle.kts",
            "Android/app/src/main/AndroidManifest.xml", "Android/app/src/main/res/resources.properties",
        ]
        for folder in try FileManager.default.contentsOfDirectory(atPath: sys14PackagePath("Android/app/src/main/res"))
            where folder.hasPrefix("values") {
            let path = "Android/app/src/main/res/\(folder)/strings.xml"
            if FileManager.default.fileExists(atPath: sys14PackagePath(path)) { files.append(path) }
        }
        for file in files {
            let text = try sys14Source(file)
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file) contains an en or em dash")
        }
    }
}

// MARK: SYS-14 source helpers

private func sys14PackagePath(_ packageRelativePath: String) -> String {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent(packageRelativePath)
        .path
}

private func sys14Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: URL(fileURLWithPath: sys14PackagePath(packageRelativePath)), encoding: .utf8)
}

private func sys14Plist(_ packageRelativePath: String) throws -> [String: Any] {
    let data = try Data(contentsOf: URL(fileURLWithPath: sys14PackagePath(packageRelativePath)))
    return try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
}

private func sys14JSON(_ packageRelativePath: String) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: Data(sys14Source(packageRelativePath).utf8)) as? [String: Any])
}

/// The text after `start` up to the first `until`, so a check reads one pbxproj section only.
private func sys14Block(after start: String, in source: String, until end: String = "};") throws -> String {
    let startRange = try #require(source.range(of: start), "missing \(start)")
    let endRange = try #require(source.range(of: end, range: startRange.upperBound..<source.endIndex), "missing \(end) after \(start)")
    return String(source[startRange.upperBound..<endRange.lowerBound])
}

/// Shell source with `#` comment lines removed, so a scan reads commands only.
private func sys14Code(_ script: String) -> String {
    script.split(separator: "\n", omittingEmptySubsequences: false)
        .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("#") }
        .joined(separator: "\n")
}

/// Collapses every run of whitespace to one space, so pins fail only when the code changes.
private func sys14Normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func sys14Matches(_ pattern: String, in text: String) -> [[String]] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [["invalid pattern"]] }
    let ns = text as NSString
    return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
        (1..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
    }
}
#endif
