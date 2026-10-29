#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct TypographyHapticsGalleryContractsTests {

    struct LegacyPair: Sendable, CustomTestStringConvertible {
        let size: Double
        let weight: ConclaveTextWeight
        let style: ConclaveTextStyle
        let sites: Int
        var testDescription: String { "\(size) \(weight.rawValue)" }
    }

    static let legacyPairs: [LegacyPair] = [
        LegacyPair(size: 30, weight: .bold, style: .title, sites: 2),
        LegacyPair(size: 25, weight: .medium, style: .title, sites: 1),
        LegacyPair(size: 24, weight: .bold, style: .title2, sites: 1),
        LegacyPair(size: 22, weight: .bold, style: .title2, sites: 1),
        LegacyPair(size: 21, weight: .semibold, style: .title2, sites: 2),
        LegacyPair(size: 18, weight: .bold, style: .headline, sites: 3),
        LegacyPair(size: 18, weight: .semibold, style: .headline, sites: 3),
        LegacyPair(size: 16, weight: .bold, style: .callout, sites: 1),
        LegacyPair(size: 16, weight: .medium, style: .callout, sites: 7),
        LegacyPair(size: 16, weight: .regular, style: .callout, sites: 1),
        LegacyPair(size: 16, weight: .semibold, style: .callout, sites: 4),
        LegacyPair(size: 15, weight: .bold, style: .subheadline, sites: 2),
        LegacyPair(size: 15, weight: .medium, style: .subheadline, sites: 26),
        LegacyPair(size: 15, weight: .regular, style: .subheadline, sites: 15),
        LegacyPair(size: 15, weight: .semibold, style: .subheadline, sites: 9),
        LegacyPair(size: 14, weight: .bold, style: .subheadline, sites: 2),
        LegacyPair(size: 14, weight: .medium, style: .subheadline, sites: 21),
        LegacyPair(size: 14, weight: .regular, style: .subheadline, sites: 20),
        LegacyPair(size: 14, weight: .semibold, style: .subheadline, sites: 6),
        LegacyPair(size: 13.5, weight: .medium, style: .footnote, sites: 3),
        LegacyPair(size: 13.5, weight: .regular, style: .footnote, sites: 5),
        LegacyPair(size: 13.5, weight: .semibold, style: .footnote, sites: 1),
        LegacyPair(size: 13, weight: .medium, style: .footnote, sites: 25),
        LegacyPair(size: 13, weight: .regular, style: .footnote, sites: 13),
        LegacyPair(size: 13, weight: .semibold, style: .footnote, sites: 7),
        LegacyPair(size: 12.5, weight: .medium, style: .footnote, sites: 1),
        LegacyPair(size: 12.5, weight: .regular, style: .footnote, sites: 10),
        LegacyPair(size: 12.5, weight: .semibold, style: .footnote, sites: 1),
        LegacyPair(size: 12, weight: .medium, style: .caption, sites: 20),
        LegacyPair(size: 12, weight: .regular, style: .caption, sites: 32),
        LegacyPair(size: 12, weight: .semibold, style: .caption, sites: 17),
        LegacyPair(size: 11.5, weight: .regular, style: .caption, sites: 3),
        LegacyPair(size: 11.5, weight: .semibold, style: .caption, sites: 6),
        LegacyPair(size: 11, weight: .medium, style: .caption2, sites: 8),
        LegacyPair(size: 11, weight: .regular, style: .caption2, sites: 7),
        LegacyPair(size: 11, weight: .semibold, style: .caption2, sites: 2),
        LegacyPair(size: 10.5, weight: .medium, style: .caption2, sites: 2),
        LegacyPair(size: 10.5, weight: .regular, style: .caption2, sites: 1),
        LegacyPair(size: 10, weight: .bold, style: .caption2, sites: 1),
        LegacyPair(size: 10, weight: .medium, style: .caption2, sites: 1),
        LegacyPair(size: 10, weight: .regular, style: .caption2, sites: 2),
        LegacyPair(size: 9.5, weight: .semibold, style: .caption2, sites: 2),
        LegacyPair(size: 9, weight: .semibold, style: .caption2, sites: 1),
    ]

    @Test(arguments: legacyPairs)
    func legacyTypeMappingMatchesInventory(_ pair: LegacyPair) {
        #expect(LegacyTypeMapping.style(size: pair.size, weight: pair.weight) == pair.style)
        #expect(LegacyTypeMapping.spec(size: pair.size, weight: pair.weight) == ConclaveTypeSpec(style: pair.style, weight: pair.weight))
    }

    @Test func legacyInventoryIsTheAppendixTable() {
        #expect(Self.legacyPairs.count == 43)
        #expect(Set(Self.legacyPairs.map { "\($0.size) \($0.weight.rawValue)" }).count == 43)
        #expect(Self.legacyPairs.reduce(0) { $0 + $1.sites } == 298)
    }

    @Test func legacyMappingIsMonotonicAndTiesRoundUp() {
        for weight in ConclaveTextWeight.allCases {
            var previous = 0.0
            var size = 8.0
            while size <= 40.0 {
                let points = LegacyTypeMapping.style(size: size, weight: weight).iosDefaultPoints
                #expect(points >= previous, "size \(size) \(weight.rawValue)")
                previous = points
                size += 0.5
            }
        }
        #expect(LegacyTypeMapping.style(size: 25, weight: .regular) == .title)
        #expect(LegacyTypeMapping.style(size: 21, weight: .regular) == .title2)
        #expect(LegacyTypeMapping.style(size: 18.5, weight: .regular) == .title3)
        #expect(LegacyTypeMapping.style(size: 16.5, weight: .regular) == .body)
        #expect(LegacyTypeMapping.style(size: 16.5, weight: .semibold) == .headline)
        #expect(LegacyTypeMapping.style(size: 15.5, weight: .regular) == .callout)
        #expect(LegacyTypeMapping.style(size: 14, weight: .regular) == .subheadline)
        #expect(LegacyTypeMapping.style(size: 12.5, weight: .regular) == .footnote)
        #expect(LegacyTypeMapping.style(size: 11.5, weight: .regular) == .caption)
        #expect(LegacyTypeMapping.style(size: 31, weight: .regular) == .largeTitle)
        #expect(LegacyTypeMapping.style(size: 9, weight: .bold) == .caption2)
    }

    @Test func textStyleCatalogIsCompleteAndDashFree() {
        let styles = ConclaveTextStyle.allCases
        #expect(styles.count == 11)
        #expect(Set(styles.map { $0.rawValue }).count == 11)
        #expect(ConclaveTextWeight.allCases.map { $0.numericWeight } == [400, 500, 600, 700])
        for style in styles {
            for text in [style.iosName, style.androidRole] {
                #expect(!text.isEmpty)
                #expect(!containsDash(text), "\(style.rawValue): \(text)")
            }
            #expect(style.androidRoleSp > 0)
            #expect([400, 500].contains(style.androidRoleWeight))
        }
        #expect(ConclaveTextStyle.headline.androidRole == "titleMedium" && ConclaveTextStyle.headline.androidRoleWeight == 500)
        #expect(ConclaveTextStyle.caption2.androidRole == "labelSmall" && ConclaveTextStyle.caption2.androidRoleSp == 11)
    }

    @Test func typographySourcesUseSystemTextStylesOnly() throws {
        let forbidden = ["ACMFont", "Font.custom", ".system(size:", "FontFamily("]
        var scanned = 0
        for file in try sourceFiles(under: "Sources/Conclave/DesignSystem", extensions: ["swift"])
            where !file.hasSuffix("/DesignTokens.swift") {
            let text = try source(file)
            scanned += 1
            for pattern in forbidden { #expect(!text.contains(pattern), "\(file) uses \(pattern)") }
        }

        let monospaceHelper = "internal fun TextStyle.monospaced(): TextStyle = copy(fontFamily = FontFamily.Monospace)"
        for file in try sourceFiles(under: "Sources/Conclave/Skip/ui", extensions: ["kt"])
            where !file.contains("/Skip/ui/icons/") {
            var text = try source(file)
            if file.hasSuffix("/Skip/ui/theme/ConclaveTypography.kt") {
                #expect(text.components(separatedBy: monospaceHelper).count - 1 == 1, "the monospace helper is declared once")
                text = text.replacingOccurrences(of: monospaceHelper, with: "")
            }
            scanned += 1
            for pattern in forbidden + ["fontFamily ="] { #expect(!text.contains(pattern), "\(file) uses \(pattern)") }

            if !file.hasSuffix("/NativeIconRasterFixture.kt") {
                #expect(!text.contains("LocalDensity provides"), "\(file) overrides density")
            }
        }
        #expect(scanned > 20)
        let ios = try source("Sources/Conclave/DesignSystem/iOS/ConclaveTypography+iOS.swift")
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(ios.contains("Font.system(textStyle, design: .default, weight: weight.fontWeight)"))
        let kotlin = try source("Sources/Conclave/Skip/ui/theme/ConclaveTypography.kt")
        #expect(kotlin.contains("internal val ConclaveTypography = Typography()"))
        let theme = try source("Sources/Conclave/Skip/ui/theme/HostingTheme.kt")
        #expect(theme.contains("typography = ConclaveTypography,"))
        #expect(!theme.contains("Typography()"))
    }

    @Test func feedbackHapticContractCoversEveryKindOnce() {
        let rows = FeedbackHapticContract.rows
        #expect(rows.count == 66)
        #expect(rows.map { $0.kind } == FeedbackKind.allCases)
        #expect(Set(rows.map { $0.kind.rawValue }).count == 66)
        #expect(rows.filter { !$0.kind.isAsyncOutcome }.count == 21)
        #expect(rows.filter { $0.kind.isAsyncOutcome }.count == 45)
        let iosTokens: Set<String> = ["none", "success", "warning", "error", "selection", "alignment",
                                      "impact.light", "impact.medium", "impact.heavy", "impact.soft"]
        let androidTokens: Set<String> = ["none", "CONFIRM", "REJECT", "TOGGLE_ON", "TOGGLE_OFF", "CONTEXT_CLICK",
                                          "SEGMENT_TICK", "CLOCK_TICK", "LONG_PRESS", "GESTURE_END",
                                          "GESTURE_THRESHOLD_ACTIVATE", "VIRTUAL_KEY"]
        for row in rows {
            #expect(iosTokens.contains(row.ios), "\(row.kind.rawValue) iOS \(row.ios)")
            for token in [row.android34, row.android30, row.android28] {
                #expect(androidTokens.contains(token), "\(row.kind.rawValue) Android \(token)")
            }
        }

        #expect(FeedbackHapticContract.ios(.shareStarted) == "impact.medium")
        #expect(FeedbackHapticContract.ios(.transcriptionStarted) == "impact.medium")
        #expect(FeedbackHapticContract.ios(.shareStopped) == "impact.light")
        #expect(FeedbackHapticContract.ios(.transcriptionStopped) == "impact.light")
        #expect(FeedbackHapticContract.ios(.becameHost) == "success")
        #expect(FeedbackHapticContract.android(.becameHost, api: 36) == "none")

        #expect(FeedbackHapticContract.android(.linkCopied, api: 32) == "CONFIRM")
        #expect(FeedbackHapticContract.android(.linkCopied, api: 33) == "none")
        #expect(FeedbackHapticContract.android(.linkCopied, api: 29) == "VIRTUAL_KEY")
        #expect(FeedbackHapticContract.android(.selfViewSnapped, api: 29) == "none")
        #expect(FeedbackHapticContract.android(.selfViewSnapped, api: 30) == "GESTURE_END")
    }

    @Test func iosSilentKindsMatchPlatformDocumentation() {

        let silent = FeedbackKind.allCases.filter { FeedbackHapticContract.isSilentOnIPhone($0) }
        #expect(silent == [.none, .handLoweredByHost, .shareStoppedBySystem, .recapPostingStarted, .connectionRestored,
                           .longPress, .hostDenied, .hostRemoved, .hostPolicyChanged, .lostHost])
        #expect(FeedbackHapticContract.rows.allSatisfy { $0.ios != "start" && $0.ios != "stop" })
        #expect(!FeedbackHapticContract.isSilentOnIPhone(.selfViewSnapped))
        #expect(FeedbackHapticContract.iPhoneSilentTokens == ["none", "start", "stop"])

        #expect(FeedbackKind.allCases.filter { FeedbackHapticContract.isSilentOnAndroid($0, api: 34) }.count == 16)
        #expect(FeedbackKind.allCases.filter { FeedbackHapticContract.isSilentOnAndroid($0, api: 33) }.count == 16)
        #expect(FeedbackKind.allCases.filter { FeedbackHapticContract.isSilentOnAndroid($0, api: 30) }.count == 15)
        #expect(FeedbackKind.allCases.filter { FeedbackHapticContract.isSilentOnAndroid($0, api: 28) }.count == 16)
        let gallery = try? source("Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift")
        #expect(gallery?.contains("FeedbackHapticContract.isSilentOnIPhone(") == true)
    }

    @Test func iosMapperSourceMatchesContractTable() throws {
        let text = try source("Sources/Conclave/DesignSystem/iOS/ConclaveFeedback+iOS.swift")
        let start = try #require(text.range(of: "static func sensoryMapping(_ kind: FeedbackKind) -> (token: String, feedback: SensoryFeedback?) {"))
        let end = try #require(text.range(of: "@MainActor", range: start.upperBound..<text.endIndex))
        let body = String(text[start.upperBound..<end.lowerBound])
        #expect(normalized(text).contains("static func sensory(_ kind: FeedbackKind) -> SensoryFeedback? { sensoryMapping(kind).feedback }"))
        #expect(mapperMismatches(body).isEmpty, "\(mapperMismatches(body))")

        let heavy = "return (\"impact.heavy\", .impact(weight: .heavy))"
        #expect(body.components(separatedBy: heavy).count == 2)
        let wrongValue = body.replacingOccurrences(of: heavy, with: "return (\"impact.heavy\", .impact(weight: .light))")
        #expect(mapperMismatches(wrongValue) == ["tapValid: token impact.heavy, value impact.light"])
        let wrongWeight = body.replacingOccurrences(of: heavy, with: "return (\"impact.light\", .impact(weight: .light))")
        #expect(mapperMismatches(wrongWeight) == ["tapValid: mapper impact.light, contract impact.heavy"])
    }

    private func mapperMismatches(_ body: String) -> [String] {
        let values = [".impact(weight: .light)": "impact.light", ".impact(weight: .medium)": "impact.medium",
                      ".impact(weight: .heavy)": "impact.heavy", ".impact(flexibility: .soft)": "impact.soft",
                      ".selection": "selection", ".alignment": "alignment", ".success": "success",
                      ".error": "error", ".warning": "warning", ".start": "start", ".stop": "stop", "nil": "none"]
        var problems: [String] = []
        var mapped: [String: String] = [:]
        for match in regexMatches(#"case ([^:]+):\s*return \("([^"]+)", ([^\n]+)\)\n"#, in: body) {
            let token = match[1]
            let value = values[match[2].trimmingCharacters(in: .whitespaces)] ?? "unknown value \(match[2])"
            for name in match[0].components(separatedBy: ",") {
                let kind = name.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ".", with: "")
                if value != token { problems.append("\(kind): token \(token), value \(value)") }
                if mapped[kind] != nil { problems.append("\(kind): mapped twice") }
                mapped[kind] = token
            }
        }
        for row in FeedbackHapticContract.rows {
            guard let token = mapped[row.kind.rawValue] else {
                problems.append("\(row.kind.rawValue): missing")
                continue
            }
            if token != row.ios { problems.append("\(row.kind.rawValue): mapper \(token), contract \(row.ios)") }
        }
        if mapped.count != 66 { problems.append("\(mapped.count) kinds mapped") }
        return problems
    }

    @Test func galleryHapticSelfCheckComparesMapperTokens() throws {
        let gallery = try source("Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift")
        #expect(!withoutComments(gallery).contains("SensoryFeedback"))
        #expect(!gallery.contains("ConclaveFeedback.sensory("))
        #expect(normalized(gallery).contains(
            "FeedbackHapticContract.rows.filter { ConclaveFeedback.sensoryMapping($0.kind).token == $0.ios }.count"))
        #expect(normalized(gallery).contains(
            "\"Mapper %@, contract %@\", ConclaveFeedback.sensoryMapping(kind).token, FeedbackHapticContract.ios(kind)"))
    }

    @Test func hapticSourcesRespectSystemSettings() throws {
        var kotlin = try sourceFiles(under: "Sources/Conclave/Skip/ui", extensions: ["kt"])
        kotlin += try sourceFiles(under: "Sources/Conclave/Skip", extensions: ["kt"], recursive: false)
        #expect(kotlin.count > 30)
        for file in kotlin {
            let text = try source(file)
            for pattern in ["FLAG_IGNORE", "LocalHapticFeedback", "Vibrator", "VibratorManager"] {
                #expect(!text.contains(pattern), "\(file) uses \(pattern)")
            }
        }
        let haptics = try source("Sources/Conclave/Skip/ui/theme/ConclaveHaptics.kt")
        let calls = regexMatches(#"performHapticFeedback\(([^)]*)\)"#, in: haptics)
        #expect(calls.count == 1)
        #expect(calls.allSatisfy { !$0[0].contains(",") })
        let gesture = try source("Sources/Conclave/Skip/ui/theme/ConclaveGestureHaptics.kt")
        #expect(gesture.contains("ConclaveHaptics.perform(view, kind)"))
        #expect(!gesture.contains("performHapticFeedback("))
        let modifier = try source("Sources/Conclave/DesignSystem/iOS/ConclaveGestureFeedback+iOS.swift")
        #expect(modifier.hasPrefix("#if os(iOS) && !SKIP\n"))
        #expect(modifier.contains("ConclaveFeedback.isEnabled"))
        #expect(modifier.contains("applicationState"))
        #expect(modifier.contains("guard !kind.isAsyncOutcome"))
    }

    @Test func contrastRatioMatchesArchivedCalculations() {
        func ratio(_ foreground: Int64, _ background: Int64) -> Double {
            ContrastRatio.wcag(foreground: foreground, background: background)
        }
        #expect(abs(ratio(DesignTokens.ink, DesignTokens.coral) - 6.374) < 0.001)
        #expect(abs(ratio(DesignTokens.neutralWhite, DesignTokens.coral) - 3.105) < 0.001)
        #expect(abs(ratio(DesignTokens.coralBright, DesignTokens.neutralZinc700) - 4.166) < 0.001)
        #expect(abs(ratio(DesignTokens.coralDeep, DesignTokens.neutralLight4) - 4.551) < 0.001)

        #expect(abs(ratio(DesignTokens.iosInCallTextTertiary, DesignTokens.ink) - 6.279) < 0.001)

        let dark = ratio(DesignTokens.neutralWhite, DesignTokens.coralBright)
        let darkHigh = ratio(DesignTokens.neutralWhite, DesignTokens.coralBrightHighContrast)
        #expect(abs(dark - 2.507) < 0.001 && abs(darkHigh - 2.268) < 0.001)
        #expect(ContrastRatio.meets(dark, .forbiddenText) && !ContrastRatio.meets(dark, .nonText))
        #expect(ContrastRatio.meets(darkHigh, .forbiddenText) && !ContrastRatio.meets(darkHigh, .nonText))

        #expect(ratio(DesignTokens.coral, DesignTokens.ink) == ratio(DesignTokens.ink, DesignTokens.coral))
        #expect(ContrastRatio.composite(DesignTokens.coral, over: DesignTokens.ink) == DesignTokens.coral)
        #expect(ContrastRatio.composite(DesignTokens.neutralTransparent, over: DesignTokens.ink) == DesignTokens.ink)
        #expect(abs(ratio(DesignTokens.neutralBlack, DesignTokens.neutralWhite) - 21.0) < 0.0001)
        #expect(ratio(DesignTokens.coral, DesignTokens.coral) == 1.0)
    }

    @Test func galleryCatalogPairsMeetDeclaredClass() {
        let pairs = ComponentGalleryCatalog.contrastPairs

        #expect(pairs.count == 95)
        for pair in pairs {
            let ratio = pair.ratio
            #expect(abs(ratio - pair.expectedRatio) < 0.001, "\(pair.id): \(ratio) against \(pair.expectedRatio)")
            #expect(ContrastRatio.meets(ratio, pair.requirement), "\(pair.id) \(pair.requirement.rawValue): \(ratio)")
            if pair.requirement == .forbiddenText { #expect(ratio < 4.5, "\(pair.id) is labeled not for text") }
        }
        let forbidden = pairs.filter { $0.requirement == .forbiddenText }.map { $0.id }
        #expect(forbidden == ["contrast.coral.white", "contrast.accentDark.white", "contrast.accentDarkHighContrast.white",
                              "contrast.coralBright.zinc700"])

        #expect(pairs.filter { $0.requirement == .decorative }.map { $0.id } == ["contrast.inCallBorder.ink", "contrast.inCallBorderHighContrast.ink",
                                                                                  "contrast.gameBoard.squares"])
    }

    @Test func notForTextPairsNeverReadAsPassing() throws {
        for pair in ComponentGalleryCatalog.contrastPairs {
            let verdict = ContrastRatio.verdict(pair.ratio, pair.requirement)
            #expect(verdict == (pair.requirement == .forbiddenText ? .decorativeOnly : .passes), "\(pair.id): \(verdict)")
        }
        #expect(ContrastRatio.verdict(4.6, .forbiddenText) == .fails)
        #expect(ContrastRatio.verdict(4.4, .text) == .fails)
        #expect(ContrastRatio.verdict(1.2, .decorative) == .passes)
        let ios = normalized(try source("Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift"))
        #expect(ios.contains("switch ContrastRatio.verdict(ratio, requirement) {"))
        #expect(ios.contains("case .decorativeOnly: verdict = ConclaveStrings.text(\"Decorative Only\")"))
        let android = normalized(try source("Sources/Conclave/Skip/ui/hosting/NativeComponentGallery.kt"))
        #expect(android.contains("when (ContrastRatio.verdict(ratio, requirement)) {"))
        #expect(android.contains("ContrastVerdict.decorativeOnly -> conclaveString(\"native_gallery_decorative_only\")"))
        for text in [ios, android] { #expect(!text.contains("ContrastRatio.meets("), "verdict words come from ContrastRatio.verdict") }
        #expect(try androidStrings()["native_gallery_decorative_only"] == "decorative only")
    }

    @Test func galleryCatalogKeysStableUniqueAndDashFree() {
        let ids = ComponentGalleryCatalog.contrastPairs.map { $0.id }
        #expect(Set(ids).count == ids.count)
        #expect(ids.prefix(4) == ["contrast.onCoral.ink", "contrast.onCoral.black", "contrast.coral.white", "contrast.accentDark.white"])
        #expect(ids.last == "contrast.gameBoard.coralPath")
        #expect(ids.contains("contrast.lobbyCaption.android") && ids.contains("contrast.bubbleOwn.android"))
        #expect(ids.contains("contrast.warningLight.groupedLight") && ids.contains("contrast.leaveHighContrast.white"))
        #expect(ids.contains("contrast.inCallBorderHighContrast.ink"))
        var specimens = ids + ComponentGalleryCatalog.systemProminentSpecimenIDs + [ComponentGalleryCatalog.galleryToggleID]
        for style in ConclaveTextStyle.allCases {
            for weight in ConclaveTextWeight.allCases { specimens.append(ComponentGalleryCatalog.typeSpecimenID(style, weight)) }
        }
        for kind in FeedbackKind.allCases { specimens.append(ComponentGalleryCatalog.hapticSpecimenID(kind)) }

        specimens += ComponentGalleryCatalog.componentSpecimenIDs(showLoading: true)
        #expect(specimens.count == 95 + 5 + 1 + 44 + 66 + 46)
        #expect(Set(specimens).count == specimens.count)
        for id in specimens {
            #expect(id.unicodeScalars.allSatisfy { ($0.value >= 0x30 && $0.value <= 0x39) || ($0.value >= 0x41 && $0.value <= 0x5A) || ($0.value >= 0x61 && $0.value <= 0x7A) || $0 == "." }, "\(id) is not a plain ASCII key")
        }
        #expect(ComponentGalleryCatalog.typeSpecimenID(.caption2, .semibold) == "type.caption2.semibold")
        #expect(ComponentGalleryCatalog.hapticSpecimenID(.micOn) == "haptic.micOn")
        for pair in ComponentGalleryCatalog.contrastPairs { #expect(!containsDash(pair.caption), "\(pair.id)") }
    }

    @Test func gallerySourcesAreInert() throws {
        let files = ["Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift",
                     "Sources/Conclave/Skip/ui/hosting/NativeComponentGallery.kt"]
        let forbidden = ["MeetingViewModel", "WebRTC", "SocketIO", "AVAudioSession", "UIPasteboard", "Clipboard",
                         "Vibrator", "performHapticFeedback", "sensoryFeedback(", "Gradient", "gradient",
                         "Timer", "LaunchedEffect", "repeatOnLifecycle", "withFrameNanos", "infinite",
                         "URLSession", "Socket(", "AVCapture", "requestPermission"]
        for file in files {
            let text = try source(file)
            for pattern in forbidden { #expect(!text.contains(pattern), "\(file) uses \(pattern)") }
            #expect(!containsDash(text), "\(file) contains an en or em dash")
        }
        let ios = try source(files[0])
        #expect(ios.hasPrefix("#if DEBUG && os(iOS) && !SKIP\n"))

        #expect(ios.contains("ConclaveGestureFeedback.decision("))
        #expect(!ios.contains("conclaveGestureFeedback("))

        for pattern in [".lineLimit(", ".truncationMode(", ".minimumScaleFactor(", "frame(height:", "maxHeight:"] {
            #expect(!ios.contains(pattern), "iOS gallery caps text with \(pattern)")
        }
        #expect(ios.contains("TruncationProbe(id:"))
        let android = try source(files[1])
        #expect(android.contains("ConclaveGestureHaptics(view = null,"))
        #expect(!android.contains("rememberConclaveHaptics("))
        for pattern in ["maxLines", "TextOverflow.Ellipsis", "LazyColumn(", ".height(", ".size("] {
            #expect(!android.contains(pattern), "Android gallery caps text or nests a list with \(pattern)")
        }
        #expect(android.contains("hasVisualOverflow"))
    }

    @Test func iosTruncationProbeCoversEverySpecimen() throws {
        let gallery = try source("Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift")

        let stacks = [
            ("struct TypeSpecimenRow: View {", ".font(style.font(weight)) .layoutPriority(1)"),
            ("struct LiveContrastRow: View {", "Text(galleryText(caption, longText: longText)) .layoutPriority(1)"),
            ("struct TokenContrastRow: View {", "Text(galleryText(pair.caption, longText: longText)) .layoutPriority(1)"),
            ("struct HapticSpecimenRow: View {", "Text(verbatim: kind.rawValue) .layoutPriority(1)"),
            ("struct ProminentSpecimen<Specimen: View>: View {", "specimen() .accessibilityIdentifier(columnID) .layoutPriority(1)"),

            ("struct ComponentSpecimen<Specimen: View>: View {", "specimen() .layoutPriority(1)"),
            ("struct RowSpecimen<Row: View>: View {", "row() .layoutPriority(1)"),
        ]
        for (header, firstLine) in stacks {
            let start = try #require(gallery.range(of: header), "\(header)")
            let end = gallery.range(of: "\n}\n", range: start.upperBound..<gallery.endIndex)?.lowerBound ?? gallery.endIndex
            let body = String(gallery[start.upperBound..<end])
            #expect(body.components(separatedBy: ".modifier(TruncationProbe(id:").count - 1 == 1, "\(header) probe")
            #expect(body.components(separatedBy: ".layoutPriority(1)\n").count - 1 == 1, "\(header) priority count")
            #expect(normalized(body).contains(firstLine), "\(header) first line")
        }

        #expect(gallery.components(separatedBy: ".modifier(TruncationProbe(id:").count - 1 == stacks.count)
        #expect(gallery.components(separatedBy: ".layoutPriority(1)\n").count - 1 == stacks.count)
        let flat = normalized(gallery)
        #expect(flat.contains("for kind in FeedbackKind.allCases { ids.insert(ComponentGalleryCatalog.hapticSpecimenID(kind)) }"))
        #expect(flat.contains("if #available(iOS 26.0, *) { prominent += [ComponentGalleryCatalog.prominentGlassID, ComponentGalleryCatalog.prominentGlassOnCoralID] }"))
        #expect(flat.contains("for id in prominent { ids.insert(ComponentGalleryCatalog.columnID(id, inCall: inCall)) }"))

        #expect(flat.contains("@MainActor private static let idle = base.union(ComponentGalleryCatalog.componentSpecimenIDs(showLoading: false))"))
        #expect(flat.contains("@MainActor private static let withLoading = base.union(ComponentGalleryCatalog.componentSpecimenIDs(showLoading: true))"))
        #expect(flat.contains("GalleryEnvironmentReadout(probe: probe, specimenCount: GallerySpecimens.ids(showLoading: showLoading).count)"))
        #expect(flat.contains("longText ? \"long\" : \"short\", showLoading ? \"loading\" : \"idle\","))

        for (section, stack) in [("buttons", "ComponentSpecimen"), ("rows", "RowSpecimen"), ("banners", "ComponentSpecimen"), ("status", "ComponentSpecimen")] {
            let loading = section == "rows" ? "false" : "showLoading"
            #expect(flat.contains("ForEach(ComponentGalleryCatalog.specimenIDs(.\(section), showLoading: \(loading)), id: \\.self) { base in let id = ComponentGalleryCatalog.columnID(base, inCall: inCall) \(stack)(id: id, probe: probe) {"), "\(section)")
        }
        for base in ["toggleCallID", "leaveID", "badgeCountID", "compactBarID"] {
            #expect(flat.contains("let id = ComponentGalleryCatalog.columnID(ComponentGalleryCatalog.\(base), inCall: true) return ComponentSpecimen(id: id, probe: probe) {"), "\(base)")
        }

        let motion = try #require(gallery.range(of: "ConclaveBannerPresence(isPresented: showsBanner) {"))
        #expect(!gallery[motion.lowerBound...].prefix(400).contains("TruncationProbe"))
    }

    @Test func scriptReadReadoutsUseAsciiDigits() throws {

        let arabic = String(format: "%lld of %lld match", locale: Locale(identifier: "ar_EG"), 66, 66)
        #expect(!arabic.unicodeScalars.allSatisfy { $0.isASCII })
        #expect(String(format: "%lld of %lld match", locale: nil, 66, 66) == "66 of 66 match")
        let helper = normalized(try source("Sources/Conclave/DesignSystem/iOS/ConclaveStrings+iOS.swift"))
        #expect(helper.contains("static func machineReadable(_ key: String, _ arguments: CVarArg...) -> String { String(format: text(key), locale: nil, arguments: arguments) }"))
        let gallery = normalized(try source("Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift"))
        for key in ["%lld truncated, %lld of %lld specimens measured", "%lld of %lld match",
                    "Recorded %lld, suppressed %lld, outcome route %lld, silent %lld", "Bar %.1f pt of %.1f pt"] {
            #expect(gallery.contains("ConclaveStrings.machineReadable( \"\(key)\"") || gallery.contains("ConclaveStrings.machineReadable(\"\(key)\""), "\(key)")
        }

        let resources = try androidStrings()
        for name in ["native_gallery_clipped", "native_gallery_match", "native_gallery_taps"] {
            let value = try #require(resources[name])
            #expect(regexMatches(#"%[0-9]\$d"#, in: value).isEmpty && regexMatches(#"%[0-9]\$s"#, in: value).count == 3, "\(name): \(value)")
        }

        let bar = try #require(resources["native_gallery_bar_readout"])
        #expect(regexMatches(#"%[0-9]\$d"#, in: bar).isEmpty && regexMatches(#"%[0-9]\$s"#, in: bar).count == 2, "\(bar)")
        let android = normalized(try source("Sources/Conclave/Skip/ui/hosting/NativeComponentGallery.kt"))

        #expect(android.contains("val specimens = rows.specimens(state.showLoading)"))
        #expect(android.contains("conclaveString(\"native_gallery_clipped\", asciiCount(state.overflow.count(configuration, specimens)), asciiCount(state.overflow.measuredCount(configuration, specimens)), asciiCount(specimens.size))"))
        #expect(android.contains("conclaveString(\"native_gallery_bar_readout\", asciiDp(barWidthPx / density.density), asciiDp(available))"))
        #expect(android.contains("internal fun asciiDp(value: Float): String = String.format(Locale.ROOT, \"%.1f\", value)"))
        #expect(android.contains("conclaveString(\"native_gallery_taps\", asciiCount(state.controlRecorded), asciiCount(state.controlOutcomeRoute), asciiCount(state.controlSilent))"))
        #expect(android.contains("conclaveString(\"native_gallery_match\", asciiCount(verified), asciiCount(rows.haptics.size), asciiCount(rows.api))"))
        #expect(android.contains("conclaveString(\"native_gallery_taps\", asciiCount(state.recorded), asciiCount(state.outcomeRoute), asciiCount(state.silent))"))
    }

    @Test func liveGroupedRowNamesTheSystemBackground() throws {
        let gallery = normalized(try source("Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift"))
        #expect(gallery.contains("caption: ConclaveStrings.text(\"Secondary text on the system grouped background\"), foreground: HostingTheme.secondaryText, background: Color(uiColor: .systemGroupedBackground)"))
        #expect(!gallery.contains("\"Secondary text on the grouped background\""))
        let catalog = try source("Sources/Conclave/DesignSystem/ComponentGalleryCatalog.swift")
        #expect(normalized(catalog).contains("pair(\"contrast.iosSecondaryTextHighContrast.groupedLight\", \"iOS secondary text, increased contrast, on grouped background\", DesignTokens.iosAppTextSecondaryLightHighContrast, DesignTokens.iosAppLaunchBackgroundLight, .text, 8.177)"))
    }

    @Test func wp1SourcesForbidDynamicColorAndColorLiterals() throws {
        for file in try sourceFiles(under: "Sources/Conclave/Skip", extensions: ["kt"]) {
            let text = try source(file)
            #expect(!text.contains("dynamicLightColorScheme") && !text.contains("dynamicDarkColorScheme"), "\(file)")
        }

        let adapters = ["/DesignSystem/DesignTokens.swift", "/DesignSystem/iOS/HostingTheme+iOS.swift"]
        var files = try sourceFiles(under: "Sources/Conclave/DesignSystem", extensions: ["swift"])
        files += try sourceFiles(under: "Sources/Conclave/App/Hosting", extensions: ["swift"])
        files += try sourceFiles(under: "Sources/Conclave/Features/Meeting/Panels", extensions: ["swift"])
        files += try sourceFiles(under: "Sources/Conclave/Skip/ui", extensions: ["kt"])
        var scanned = 0
        for file in files where !adapters.contains(where: { file.hasSuffix($0) }) {
            scanned += 1
            let text = try source(file)
            #expect(regexMatches(#"(UIColor|Color)\(\s*(red:|\.sRGB|0x)"#, in: text).isEmpty, "\(file) builds a color from a literal")
        }
        #expect(scanned > 25)
    }

    @Test func wp1SwiftSourcesUseOnlyTheApprovedGlassSurfaces() throws {
        let glass = ["glassEffect", "GlassEffectContainer", "GlassStyle", "glassProminent", "ultraThinMaterial",
                     "thinMaterial", "regularMaterial", "thickMaterial", "ultraThickMaterial"]
        var files = try sourceFiles(under: "Sources/Conclave/DesignSystem", extensions: ["swift"])
        files += try sourceFiles(under: "Sources/Conclave/Features/Meeting/Panels", extensions: ["swift"])
        files += try sourceFiles(under: "Sources/Conclave/App/Hosting", extensions: ["swift"])

        files += try sourceFiles(under: "Sources/Conclave/Features/Meeting/Chat", extensions: ["swift"])
        files += try sourceFiles(under: "Sources/Conclave/Features/Meeting/Webinar", extensions: ["swift"])
        files += try sourceFiles(under: "Sources/Conclave/Features/Meeting/Transcript", extensions: ["swift"])

        files += try sourceFiles(under: "Sources/Conclave/Features/Lobby", extensions: ["swift"])
        files.append("Sources/Conclave/App/PlatformRoot+iOS.swift")
        let galleryFile = "Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift"

        let entries = Self.sanctionedGlassFiles
        #expect(entries == [Self.callControlFile, Self.composerGlassFile, Self.lobbyMediaToggleFile, Self.entryStatusBlockFile])
        for entry in entries { #expect(files.contains(entry), "\(entry) is outside the scanned scope") }
        var glassFiles: [String] = []
        for file in files where !entries.contains(file) {
            var text = try source(file)
            if file == galleryFile {

                let begin = "private struct GlassProminentSpecimens: View {"
                let end = "private struct ProminentSpecimen<Specimen: View>: View {"
                #expect(text.components(separatedBy: begin).count == 2 && text.components(separatedBy: end).count == 2)
                if let lower = text.range(of: begin), let upper = text.range(of: end), lower.upperBound < upper.lowerBound {
                    let block = String(text[lower.lowerBound..<upper.lowerBound])
                    #expect(block.contains(".buttonStyle(.glassProminent)"))
                    #expect(block.contains("if #available(iOS 26.0, *)"))
                    for pattern in glass where pattern != "glassProminent" { #expect(!block.contains(pattern), "\(pattern) in the specimen block") }
                    text.removeSubrange(lower.lowerBound..<upper.lowerBound)
                }
            }
            for pattern in glass where text.contains(pattern) {
                glassFiles.append(file)
                Issue.record("\(file) uses \(pattern)")
            }
        }
        #expect(glassFiles.isEmpty)

        for entry in entries {
            let expectedSurface = entry == Self.entryStatusBlockFile ? ".buttonStyle(.glassProminent)" : ".glassEffect("
            #expect(try source(entry).contains(expectedSurface), "\(entry)")
        }
        let lobby = normalized(try source(Self.lobbyMediaToggleFile))
        #expect(lobby.contains("if #available(iOS 26.0, *), allowsGlass {"))
        #expect(lobby.contains("return !reduceTransparency && contrast != .increased && !forceOpaque"))
        #expect(lobby.contains("content(allowsGlass && !prefersReducedResourceUsage)"))
        #expect(lobby.components(separatedBy: ".glassEffect(").count - 1 == 1)
        #expect(lobby.contains("} else { ConclaveCallToggle(title: title, value: value, systemImage: systemImage, state: state,"))
        #expect(lobby.contains(".accessibilityLabel(title)") && lobby.contains(".accessibilityValue(value)"))
        #expect(lobby.contains(".accessibilityAddTraits(.isToggle)") && lobby.contains(".disabled(!isEnabled)"))
    }

    @Test func labelCasingFollowsOwnerRule() throws {

        let groups: [(name: String, pattern: String, minimum: Int)] = [
            ("literal control labels", #"(?:Button|Toggle|Section|DisclosureGroup|NavigationLink|LabeledContent|Label|Picker|TextField|navigationTitle)\(\s*"([^"\\]+)""#, 15),

            ("literal title choices", #"(?:Button|navigationTitle)\(\s*[A-Za-z.]+\s*\?\s*"([^"\\]+)"\s*:\s*"([^"\\]+)""#, 2),
            ("action button labels", #"Button\(action:[^\n]*\)\s*\{\s*Text\(\s*"([^"\\]+)""#, 1),
            ("label views", #"Label\s*\{\s*Text\(\s*"([^"\\]+)""#, 2),
            ("catalog control labels", #"(?:Button|Toggle|Section|NavigationLink|LabeledContent|navigationTitle|readout)\(\s*ConclaveStrings\.text\(\s*"([^"\\]+)""#, 20),
            ("catalog titles", #"title:\s*ConclaveStrings\.text\(\s*"([^"\\]+)""#, 8),
            ("catalog title choices", #"title:\s*[A-Za-z]+\s*\?\s*ConclaveStrings\.text\(\s*"([^"\\]+)"\)\s*:\s*ConclaveStrings\.text\(\s*"([^"\\]+)"\)"#, 1),
            ("label closures", #"label:\s*\{(?:\s*//[^\n]*)?\s*Text\(\s*(?:ConclaveStrings\.text\(\s*)?"([^"\\]+)""#, 4),
        ]
        let iosFiles = ["Sources/Conclave/DesignSystem/iOS/NativeIconGallery.swift", "Sources/Conclave/App/PlatformRoot+iOS.swift",
                        "Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift"] + Self.iosComponentFiles
        let texts = try iosFiles.map { try source($0) }
        var iosLabels: [String] = []
        for group in groups {
            let found = texts.flatMap { regexMatches(group.pattern, in: $0) }.flatMap { $0 }.filter { !$0.isEmpty }
            #expect(found.count >= group.minimum, "\(group.name): \(found.count) labels")
            iosLabels += found
        }
        for expected in ["Icon Gallery", "Component Gallery", "In Call", "App", "Bordered Prominent, On Coral", "Glass Prominent, On Coral",
                         "Simulate Background or PiP", "Participants", "Reset Selection", "Captions", "Sample Text",

                         "Show Loading", "Force Opaque Controls", "Call Controls", "Status Views", "Microphone", "Use Audio Only",
                         "Full Width Bar", "Moved to More", "Control Taps"] {
            #expect(iosLabels.contains(expected), "scan missed \(expected)")
        }
        for label in iosLabels { #expect(isTitleCase(label), "iOS label is not title case: \(label)") }

        var androidLabels = try androidStrings().values.map { xmlUnescaped($0) }
        let root = try source("Sources/Conclave/Skip/ui/AppRoot.kt")

        androidLabels += regexMatches(#"Text\(\s*"([^"\\$]+)""#, in: root).map { $0[0] }
        #expect(androidLabels.count > 80)
        for label in androidLabels { #expect(isSentenceCase(label), "Android label is not sentence case: \(label)") }
        #expect(isTitleCase("Simulate Background or PiP") && !isTitleCase("Icon gallery"))
        #expect(isSentenceCase("Simulate background or PiP") && !isSentenceCase("Show Details"))
        #expect(isSentenceCase("left to right") && isSentenceCase("Appendix C %1$.3f") && !isSentenceCase("Live, In call"))

        #expect(isSentenceCase("Round %1$d of %2$d \u{00B7} Guess the word") && !isSentenceCase("Round 1 \u{00B7} Guess The word"))
        #expect(isSentenceCase("Allow access in Settings") && !isSentenceCase("Open Settings now") && !isSentenceCase("Tap to Mute"))
        #expect(isSentenceCase("Only http and https URLs are supported.") && isSentenceCase("This Wi-Fi network needs you to sign in."))
    }

    @Test func galleryStringsAreInTheStringCatalog() throws {

        let catalog = try #require(try JSONSerialization.jsonObject(with: Data(source("Sources/Conclave/Resources/Localizable.xcstrings").utf8)) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        var keys = Set<String>()

        for file in ["Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift", "Sources/Conclave/App/PlatformRoot+iOS.swift"] + Self.iosComponentFiles {
            keys.formUnion(regexMatches(#"ConclaveStrings\.(?:text|format|machineReadable)\(\s*"((?:[^"\\]|\\.)*)""#, in: try source(file)).map { $0[0] })
        }
        #expect(keys.count > 60)
        for key in ["Leave Call", "In Progress", "%lld unread", "Dismiss", "Try Again", "Loading", "Admit %@", "Deny %@", "Show Loading"] {
            #expect(keys.contains(key), "scan missed \(key)")
        }
        for key in keys {
            let entry = strings[key] as? [String: Any]
            #expect(entry != nil, "missing String Catalog key: \(key)")
            #expect(entry?["comment"] == nil, "unexpected translator prose: \(key)")
            #expect(entry?["extractionState"] as? String == "manual", "looked up by key, so manual: \(key)")
        }
        for (key, value) in strings {
            #expect(!containsDash(key), "\(key)")
            let comment = (value as? [String: Any])?["comment"] as? String ?? ""
            #expect(!containsDash(comment), "\(key) comment")
        }

        for file in ["Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift"] + Self.iosComponentFiles {
            let text = try source(file)
            #expect(regexMatches(#"(?:Text|Button|Toggle|Section|LabeledContent|NavigationLink|navigationTitle|Label|ProgressView)\(\s*""#, in: text).isEmpty, "\(file) has a literal label")
        }
        let helper = try source("Sources/Conclave/DesignSystem/iOS/ConclaveStrings+iOS.swift")
        #expect(helper.contains("Bundle.module.localizedString(forKey: key, value: nil, table: nil)"))
    }

    @Test func androidGalleryStringsAreResources() throws {

        let resources = try androidStrings()
        var used = Set<String>()

        for file in ["Sources/Conclave/Skip/ui/hosting/NativeComponentGallery.kt", "Sources/Conclave/Skip/ui/hosting/NativeSemanticsExport.kt",
                     "Sources/Conclave/Skip/ui/AppRoot.kt", "Sources/Conclave/Skip/ui/call/panels/InCallPage.kt",
                     "Sources/Conclave/Skip/ui/call/panels/CallMiniTile.kt", "Sources/Conclave/Skip/ui/call/panels/NativePanelHost.kt",

                     "Sources/Conclave/Skip/ui/call/stage/CallRoot.kt", "Sources/Conclave/Skip/ui/call/stage/StageCanvas.kt",
                     "Sources/Conclave/Skip/ui/call/stage/SlotView.kt", "Sources/Conclave/Skip/ui/call/stage/StageChrome.kt",
                     "Sources/Conclave/Skip/ui/call/stage/Reactions.kt",

                     "Sources/Conclave/Skip/ui/call/stage/NoticeLanes.kt", "Sources/Conclave/Skip/ui/call/stage/CaptionsStrip.kt",

                     "Sources/Conclave/Skip/ui/call/stage/TileMenu.kt",

                     "Sources/Conclave/Skip/ui/call/stage/MeetingDetailsPage.kt", "Sources/Conclave/Skip/ui/call/stage/AttendeeViewer.kt",

                     "Sources/Conclave/Skip/ui/call/stage/ShareZoom.kt",

                     "Sources/Conclave/Skip/ui/call/stage/ChatPreviewSnackbar.kt",

                     "Sources/Conclave/Skip/ui/people/PeopleActions.kt", "Sources/Conclave/Skip/ui/host/HostRows.kt",

                     "Sources/Conclave/Skip/ui/people/PersonRow.kt", "Sources/Conclave/Skip/ui/qa/QuestionRow.kt"]
            + Self.androidComponentFiles {
            let text = try source(file)

            used.formUnion(regexMatches(#""((?:native_(?:gallery|semantics|panel)|ds)_[a-z0-9_]+)""#, in: text).map { $0[0] })
            if !file.hasSuffix("AppRoot.kt") {

                #expect(regexMatches(#"Text\(\s*""#, in: text).isEmpty, "\(file) has a literal Text")
            }
        }
        #expect(used.count > 60)

        let plurals = try androidPlurals()
        let usedPlurals = used.intersection(Set(plurals.keys))
        used.subtract(usedPlurals)
        #expect(usedPlurals == Set(plurals.keys.filter { $0.hasPrefix("ds_") }), "plurals: \(usedPlurals.symmetricDifference(Set(plurals.keys.filter { $0.hasPrefix("ds_") })).sorted())")
        for (name, forms) in plurals {
            #expect(forms["other"] != nil, "\(name) needs an other form")

            for value in forms.values {
                #expect(!containsDash(value) && regexMatches(#"%(?![0-9]\$)"#, in: value.replacingOccurrences(of: "%%", with: "")).isEmpty, "\(name)")
            }
        }

        let appearanceNames: Set<String> = ["appearance_title", "appearance_system", "appearance_light", "appearance_dark"]
        #expect(Set(resources.keys.filter { $0.hasPrefix("appearance_") }) == appearanceNames)
        let galleryNames = Set(resources.keys.filter {
            !$0.hasPrefix("sys_") && !$0.hasPrefix("ctl_") && !$0.hasPrefix("pm_") && !$0.hasPrefix("stg_")
                && !$0.hasPrefix("ppl_") && !$0.hasPrefix("chat_") && !$0.hasPrefix("act_") && !$0.hasPrefix("gm_")
                && !$0.hasPrefix("br_") && !$0.hasPrefix("app_") && !$0.hasPrefix("set_") && !$0.hasPrefix("hst_")
                && !$0.hasPrefix("qa_") && !$0.hasPrefix("lay_") && !$0.hasPrefix("fx_") && !$0.hasPrefix("trn_")
                && !appearanceNames.contains($0)
        })
        #expect(used == galleryNames, "unused or missing resources: \(used.symmetricDifference(galleryNames).sorted())")
        for (name, value) in resources {
            #expect(name.hasPrefix("native_gallery_") || name.hasPrefix("native_semantics_") || name.hasPrefix("native_panel_")
                    || name.hasPrefix("ds_") || name.hasPrefix("sys_") || name.hasPrefix("ctl_") || name.hasPrefix("pm_")
                    || name.hasPrefix("stg_") || name.hasPrefix("ppl_") || name.hasPrefix("chat_") || name.hasPrefix("act_")
                    || name.hasPrefix("gm_") || name.hasPrefix("br_") || name.hasPrefix("app_") || name.hasPrefix("set_")
                    || name.hasPrefix("hst_") || name.hasPrefix("qa_") || name.hasPrefix("lay_") || name.hasPrefix("fx_")
                    || name.hasPrefix("trn_") || appearanceNames.contains(name), "\(name)")
            #expect(!containsDash(value), "\(name)")
            #expect(!value.contains("'"), "\(name) needs an escaped apostrophe")

            #expect(regexMatches(#"%(?![0-9]\$)"#, in: value.replacingOccurrences(of: "%%", with: "")).isEmpty,
                    "\(name) uses a non-positional argument")
        }
        let helper = try source("Sources/Conclave/Skip/ui/theme/ConclaveStrings.kt")
        #expect(helper.contains("getIdentifier(name, \"string\", context.packageName)"))

        #expect(resources["ds_leave_call"] == "Leave call")
        #expect(resources["ds_offline_title"] == "You\u{2019}re offline")
        #expect(resources["ds_more_options"] == "More options")
    }

    @Test func systemBarsHaveOneNativeOwner() throws {
        var callers: [String] = []
        for file in try sourceFiles(under: "Sources/Conclave/Skip", extensions: ["kt"]) where try source(file).contains("enableEdgeToEdge(") {
            callers.append(file)
        }
        #expect(callers == ["Sources/Conclave/Skip/ui/theme/ConclaveSystemBars.kt"])
        let theme = try source("Sources/Conclave/Skip/ui/theme/HostingTheme.kt")
        #expect(!theme.contains("SystemBarStyle") && !theme.contains("DisposableEffect"))
        let root = try source("Sources/Conclave/Skip/ui/AppRoot.kt")
        #expect(root.components(separatedBy: "ConclaveSystemBars(").count - 1 == 1)
        #expect(root.contains("SystemBarPolicy.resolve("))
    }

    @Test func iconGalleryDispositionsHold() throws {

        let gallery = normalized(try source("Sources/Conclave/DesignSystem/iOS/NativeIconGallery.swift"))

        #expect(gallery.components(separatedBy: "accessibilityIdentifier(\"icons.gallery.toggle\")").count - 1 == 1)
        let label = try #require(gallery.range(of: "} label: {"))
        #expect(gallery[label.upperBound...].prefix { $0 != "}" }.contains("Text(\"Icon Gallery\") .accessibilityIdentifier(\"icons.gallery.toggle\")"))
        #expect(!gallery.contains("DisclosureGroup(\"Icon gallery\""))

        #expect(gallery.contains("Text(specimen.detail) .font(.caption) .foregroundStyle(.secondary) .accessibilityHidden(true)"))
        let components = normalized(try source("Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift"))
        #expect(components.components(separatedBy: "accessibilityIdentifier(ComponentGalleryCatalog.galleryToggleID)").count - 1 == 1)
        #expect(components.contains("} label: { Text(ConclaveStrings.text(\"Component Gallery\")) .accessibilityIdentifier(ComponentGalleryCatalog.galleryToggleID) }"))
    }

    @Test func componentGalleryIdentifiersAreStable() {
        #expect(GallerySection.allCases.map { ComponentGalleryCatalog.sectionID($0) } == [
            "components.section.typography", "components.section.haptics", "components.section.contrast",
            "components.section.systemProminent",

            "components.section.buttons", "components.section.callControls", "components.section.rows",
            "components.section.banners", "components.section.status",
        ])
        #expect(GallerySection.allCases.filter { $0.isInCallOnly } == [.callControls])
        #expect(GallerySection.allCases.filter { $0.isIOSOnly } == [.systemProminent])
        #expect(ComponentGalleryCatalog.systemProminentSpecimenIDs == [
            "system.prominent.confirmationAction", "system.prominent.glass", "system.prominent.bordered",
            "system.prominent.glass.onCoral", "system.prominent.bordered.onCoral",
        ])
        #expect(ComponentGalleryCatalog.columnID("system.prominent.glass", inCall: true) == "system.prominent.glass.inCall")
        #expect(ComponentGalleryCatalog.columnID("system.prominent.glass", inCall: false) == "system.prominent.glass.app")
        #expect(ComponentGalleryCatalog.liveContrastID("onCoral", inCall: false) == "contrast.live.onCoral.app")
        #expect(ComponentGalleryCatalog.expanded("Long Text") == "Long Text Long Text")
        let fixed = [ComponentGalleryCatalog.galleryToggleID, ComponentGalleryCatalog.environmentID, ComponentGalleryCatalog.overflowID,
                     ComponentGalleryCatalog.longTextToggleID, ComponentGalleryCatalog.hapticVerifyID,
                     ComponentGalleryCatalog.hapticResultID, ComponentGalleryCatalog.hapticRecordID, ComponentGalleryCatalog.prominentPageLinkID,
                     ComponentGalleryCatalog.showLoadingToggleID, ComponentGalleryCatalog.forceOpaqueToggleID,
                     ComponentGalleryCatalog.controlRecordID, ComponentGalleryCatalog.compactBarProbeID,
                     ComponentGalleryCatalog.compactBarReadoutID, ComponentGalleryCatalog.compactBarMovedID,
                     ComponentGalleryCatalog.bannerMotionID, ComponentGalleryCatalog.bannerMotionToggleID,
                     ComponentGalleryCatalog.bannerAnnouncementID]
        #expect(Set(fixed).count == fixed.count)
        for id in fixed { #expect(id.unicodeScalars.allSatisfy { $0.isASCII && $0 != " " }, "\(id)") }

        #expect(ComponentGalleryCatalog.specimenIDs(.buttons, showLoading: false) == ["button.primary", "button.tonal", "button.text", "button.destructive"])
        #expect(ComponentGalleryCatalog.specimenIDs(.buttons, showLoading: true) == ["button.primary", "button.tonal", "button.text", "button.destructive", "button.primary.pending"])
        #expect(ComponentGalleryCatalog.specimenIDs(.callControls, showLoading: true) == ["toggle.call", "button.leave", "badge.count", "control.bar.compact"])
        #expect(ComponentGalleryCatalog.specimenIDs(.rows, showLoading: true) == ["row.value", "row.navigation", "row.destructive", "row.selectable", "toggle.row", "row.person", "row.person.waiting"])
        #expect(ComponentGalleryCatalog.specimenIDs(.banners, showLoading: false) == ["banner.info", "banner.warning", "banner.error", "banner.success"])
        #expect(ComponentGalleryCatalog.specimenIDs(.banners, showLoading: true) == ["banner.info", "banner.warning", "banner.error", "banner.success", "banner.reconnecting"])
        #expect(ComponentGalleryCatalog.specimenIDs(.status, showLoading: false) == ["status.error", "status.empty", "status.offline"])
        #expect(ComponentGalleryCatalog.specimenIDs(.status, showLoading: true) == ["status.loading", "status.error", "status.empty", "status.offline"])
        for section in [GallerySection.typography, .haptics, .contrast, .systemProminent] {
            #expect(ComponentGalleryCatalog.specimenIDs(section, showLoading: true).isEmpty)
        }
        let idle = ComponentGalleryCatalog.componentSpecimenIDs(showLoading: false)
        let loading = ComponentGalleryCatalog.componentSpecimenIDs(showLoading: true)
        #expect(idle.count == 40 && loading.count == 46 && Set(loading).count == 46)

        #expect(Set(loading).subtracting(idle) == ["button.primary.pending.app", "button.primary.pending.inCall", "banner.reconnecting.app",
                                                   "banner.reconnecting.inCall", "status.loading.app", "status.loading.inCall"])

        for id in loading where ["toggle.call", "button.leave", "badge.count", "control.bar.compact"].contains(where: { id.hasPrefix($0 + ".") }) {
            #expect(id.hasSuffix(".inCall"), "\(id)")
        }
        #expect(loading.filter { $0.hasSuffix(".app") }.count == 21 && loading.filter { $0.hasSuffix(".inCall") }.count == 25)

        #expect(!loading.contains(where: { $0.hasPrefix("banner.motion") }))
        #expect(ComponentGalleryCatalog.compactBarControls == ["microphone", "camera", "shareScreen", "chat", "more"])
        #expect(ComponentGalleryCatalog.compactBarMoveOrder == ["shareScreen"])
    }

    static let callControlFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveCallControl+iOS.swift"

    static let composerGlassFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveComposerGlass+iOS.swift"
    static let lobbyMediaToggleFile = "Sources/Conclave/Features/Lobby/LobbyMediaToggle+iOS.swift"
    static let entryStatusBlockFile = "Sources/Conclave/Features/Lobby/EntryStatusBlock+iOS.swift"
    static let sanctionedGlassFiles = [callControlFile, composerGlassFile, lobbyMediaToggleFile, entryStatusBlockFile]
    static let iosComponentFiles = [
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveButtons+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveRows+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveBanner+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveStatus+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveCallControl+iOS.swift",

        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveAvatar+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveFields+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveDialogs+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveStageChip+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveBadge+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveTileChrome+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveToast+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveMenus+iOS.swift",

        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveComposerGlass+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveChatBubble+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveReactionChip+iOS.swift",
        "Sources/Conclave/DesignSystem/iOS/Components/ConclaveTip+iOS.swift",
    ]
    static let androidComponentFiles = [
        "Sources/Conclave/Skip/ui/components/ConclaveButtons.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveListRows.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveBanner.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveStatus.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveCallControl.kt",

        "Sources/Conclave/Skip/ui/components/ConclaveAvatar.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveDialogs.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveFields.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveStageChrome.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveBadge.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveTileChrome.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveMenus.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveActionSheet.kt",
        "Sources/Conclave/Skip/ui/components/AudioRouteList.kt",

        "Sources/Conclave/Skip/ui/components/ConclaveChatBubble.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveReactionChip.kt",
        "Sources/Conclave/Skip/ui/components/ConclaveTipCard.kt",
    ]
    static let glassBranchCondition = "if #available(iOS 26.0, *), !reduceTransparency, !forceOpaque {"

    @Test func controlSurfaceShimIsTheOnlyGlassEntry() throws {
        let glass = ["glassEffect", "GlassEffectContainer", "GlassStyle", "glassProminent", "ultraThinMaterial",
                     "thinMaterial", "regularMaterial", "thickMaterial", "ultraThickMaterial"]
        let galleryFile = "Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift"
        var files = try sourceFiles(under: "Sources/Conclave/DesignSystem", extensions: ["swift"])
        files += try sourceFiles(under: "Sources/Conclave/Features/Meeting/Panels", extensions: ["swift"])
        files += try sourceFiles(under: "Sources/Conclave/App/Hosting", extensions: ["swift"])
        files.append("Sources/Conclave/App/PlatformRoot+iOS.swift")
        #expect(files.contains(Self.callControlFile) && files.contains(galleryFile))
        var entries: [String] = []

        for file in files where file != Self.callControlFile && file != galleryFile && file != Self.composerGlassFile {
            let text = try source(file)
            if glass.contains(where: { text.contains($0) }) { entries.append(file) }
        }
        #expect(entries.isEmpty, "glass outside the entry: \(entries)")

        let text = try source(Self.callControlFile)
        let code = withoutComments(text)

        let branches = bracedBlocks(after: Self.glassBranchCondition, in: code)
        #expect(branches.count == 3)
        var outside = code
        for range in branches.reversed() { outside.removeSubrange(range) }
        for pattern in glass { #expect(!outside.contains(pattern), "\(pattern) outside the iOS 26 branch") }
        let inside = branches.map { String(code[$0]) }.joined(separator: "\n")
        #expect(inside.components(separatedBy: ".glassEffect(").count - 1 == 1)
        #expect(normalized(inside).contains(".glassEffect(.regular.interactive(spec.isInteractive), in: ConclaveControlOutline(shape: shape))"))
        #expect(inside.contains("GlassEffectContainer(spacing: spacing)"))
        for pattern in [".clear", ".tint(", "Glass.tint", "glassProminent", "Material", "symbolColorRenderingMode(.gradient"] {
            #expect(!code.contains(pattern), "the entry uses \(pattern)")
        }

        #expect(!code.contains("#available(iOS 26.0, *) &&"))
        #expect(code.contains(".symbolColorRenderingMode(.flat)"))

        let host = try #require(text.range(of: "#if !SKIP\n"))
        let ios = try #require(text.range(of: "#if os(iOS) && !SKIP\n"))
        try #require(host.upperBound < ios.lowerBound)
        let mapping = withoutComments(String(text[host.upperBound..<ios.lowerBound]))
        #expect(mapping.contains("enum ConclaveControlState: String, CaseIterable {"))
        #expect(mapping.contains("enum ConclaveControlSurfaceMapping {"))
        for framework in ["SwiftUI", "UIKit", "Color", "CGFloat", "View"] { #expect(!mapping.contains(framework), "\(framework) in the host section") }
    }

    @Test func controlSurfaceFallbackUsesGeneratedToken() throws {
        let standard = ConclaveControlSurfaceMapping.spec(.on, glassAvailable: false, reduceTransparency: false, forceOpaque: false,
                                                          increasedContrast: false, isEnabled: true)
        #expect(standard.fill == .fallback)
        #expect(standard.fillToken == DesignTokens.iosInCallControlFallback)
        #expect(standard.strokeToken == DesignTokens.iosInCallBorder)
        #expect(standard.glyphToken == DesignTokens.iosInCallText)
        let increased = ConclaveControlSurfaceMapping.spec(.on, glassAvailable: false, reduceTransparency: false, forceOpaque: false,
                                                           increasedContrast: true, isEnabled: true)
        #expect(increased.strokeToken == DesignTokens.iosInCallBorderHighContrast)

        #expect(DesignTokens.iosInCallControlFallback == 0xFF232327)
        #expect(DesignTokens.iosInCallBorder == 0x24FAFAFA && DesignTokens.iosInCallBorderHighContrast == 0x52FAFAFA)
        #expect(abs(ContrastRatio.wcag(foreground: DesignTokens.iosInCallText, background: DesignTokens.iosInCallControlFallback) - 15.001) < 0.001)
        #expect(abs(ContrastRatio.wcag(foreground: DesignTokens.iosInCallOnControlOff, background: DesignTokens.iosInCallControlOff) - 18.960) < 0.001)

        let code = normalized(withoutComments(try source(Self.callControlFile)))
        #expect(code.contains(".background(HostingTheme.token(spec.fillToken ?? DesignTokens.iosInCallControlFallback), in: ConclaveControlOutline(shape: shape))"))
        #expect(code.contains("ConclaveControlOutline(shape: shape).strokeBorder(HostingTheme.token(token), lineWidth: 1)"))
        #expect(code.components(separatedBy: ".foregroundStyle(HostingTheme.token(spec.glyphToken))").count - 1 == 2)

        let adapter = normalized(try source("Sources/Conclave/DesignSystem/iOS/HostingTheme+iOS.swift"))
        #expect(adapter.contains("static let inCallLeave = Color(uiColor: UIColor { traits in"))
        #expect(adapter.contains("if traits.accessibilityContrast == .high { return color(DesignTokens.iosInCallLeaveHighContrast) }"))
        #expect(adapter.contains("static let statusWarning = appearancePair(light: DesignTokens.warningLight, dark: DesignTokens.warningDark)"))
    }

    @Test func controlSurfaceStateTableCoversBothBranches() throws {
        func expected(_ state: ConclaveControlState, glass: Bool, increased: Bool, enabled: Bool) -> ConclaveControlSurfaceSpec {
            let opacity = enabled ? 1.0 : 0.4
            switch state {
            case .off:
                return ConclaveControlSurfaceSpec(fill: .paper, fillToken: 0xFFFAFAFA, glyph: .off, glyphToken: 0xFF0A0A0B,
                                                  strokeToken: nil, isInteractive: false, opacity: opacity)
            case .engaged:
                return ConclaveControlSurfaceSpec(fill: .paper, fillToken: 0xFFFAFAFA, glyph: .engaged, glyphToken: 0xFF0A0A0B,
                                                  strokeToken: nil, isInteractive: false, opacity: opacity)
            case .on:
                if glass {
                    return ConclaveControlSurfaceSpec(fill: .glass, fillToken: nil, glyph: .on, glyphToken: 0xFFFAFAFA,
                                                      strokeToken: increased ? 0x52FAFAFA : nil, isInteractive: enabled, opacity: opacity)
                }
                return ConclaveControlSurfaceSpec(fill: .fallback, fillToken: 0xFF232327, glyph: .on, glyphToken: 0xFFFAFAFA,
                                                  strokeToken: increased ? 0x52FAFAFA : 0x24FAFAFA, isInteractive: false, opacity: opacity)
            }
        }
        var rows = 0
        for state in ConclaveControlState.allCases {
            for glassAvailable in [false, true] {
                for reduceTransparency in [false, true] {
                    for forceOpaque in [false, true] {
                        for increased in [false, true] {
                            for enabled in [false, true] {
                                let spec = ConclaveControlSurfaceMapping.spec(state, glassAvailable: glassAvailable,
                                                                              reduceTransparency: reduceTransparency, forceOpaque: forceOpaque,
                                                                              increasedContrast: increased, isEnabled: enabled)
                                let glass = glassAvailable && !reduceTransparency && !forceOpaque
                                #expect(spec == expected(state, glass: glass, increased: increased, enabled: enabled),
                                        "\(state.rawValue) glass \(glassAvailable) RT \(reduceTransparency) force \(forceOpaque) HC \(increased) enabled \(enabled)")
                                rows += 1
                            }
                        }
                    }
                }
            }
        }
        #expect(rows == 96)
        #expect(ConclaveControlState.allCases.map { $0.rawValue } == ["off", "on", "engaged"])
        #expect(ConclaveControlSurfaceMapping.disabledOpacity == 0.4)
        func onFill(glass: Bool, reduceTransparency: Bool, force: Bool) -> ConclaveControlFill {
            ConclaveControlSurfaceMapping.spec(.on, glassAvailable: glass, reduceTransparency: reduceTransparency, forceOpaque: force,
                                               increasedContrast: false, isEnabled: true).fill
        }
        #expect(onFill(glass: true, reduceTransparency: false, force: false) == .glass)
        #expect(onFill(glass: true, reduceTransparency: true, force: false) == .fallback)
        #expect(onFill(glass: true, reduceTransparency: false, force: true) == .fallback)
        #expect(onFill(glass: false, reduceTransparency: false, force: false) == .fallback)

        let code = withoutComments(try source(Self.callControlFile))
        let surface = try #require(bracedBlocks(after: Self.glassBranchCondition, in: code).first)
        #expect(normalized(String(code[surface])).contains("let spec = ConclaveControlSurfaceMapping.spec(state, context: context, glassAvailable: true,"))
        #expect(code.components(separatedBy: "glassAvailable: true").count - 1 == 1)
        #expect(normalized(code).contains("opaque(content, ConclaveControlSurfaceMapping.spec(state, context: context, glassAvailable: false,"))

        #expect(normalized(code).contains(".background(HostingTheme.inCallLeave, in: Circle())"))
        #expect(!code.contains("Color(uiColor: .systemRed)"))
    }

    @Test func forceFallbackOverrideIsDebugOnly() throws {
        let key = "conclaveForceOpaqueControls"
        let galleryFile = "Sources/Conclave/DesignSystem/iOS/NativeComponentGallery.swift"
        var holders: [String] = []
        for file in try sourceFiles(under: "Sources/Conclave", extensions: ["swift"]) where try source(file).contains(key) {
            holders.append(file)
        }

        let cellFile = "Sources/Conclave/Features/Meeting/Controls/CallControlCell+iOS.swift"
        #expect(holders == [Self.callControlFile, Self.composerGlassFile, Self.lobbyMediaToggleFile, galleryFile, cellFile].sorted())
        let lobby = try source(Self.lobbyMediaToggleFile)
        let lobbyRelease = withoutDebugBlocks(lobby)
        for name in [key, "forceOpaqueSetting", "ConclaveForceOpaqueControlsKey"] { #expect(!lobbyRelease.contains(name), "\(name) in the lobby Release") }
        #expect(normalized(lobby).components(separatedBy: "#if DEBUG return forceOpaqueSetting #else return false #endif").count - 1 == 1)
        #expect(!lobby.contains(".environment(\\.\(key)"))
        let cell = try source(cellFile)
        let cellRelease = withoutDebugBlocks(cell)
        for name in [key, "forceOpaqueSetting", "ConclaveForceOpaqueControlsKey"] { #expect(!cellRelease.contains(name), "\(name) in the cell Release") }
        #expect(normalized(cell).components(separatedBy: "#if DEBUG return forceOpaqueSetting #else return false #endif").count - 1 == 1)
        #expect(!cell.contains(".environment(\\.\(key)"))

        let text = try source(Self.callControlFile)
        let release = withoutDebugBlocks(text)
        for name in [key, "forceOpaqueSetting", "ConclaveForceOpaqueControlsKey"] { #expect(!release.contains(name), "\(name) in Release") }
        let composer = try source(Self.composerGlassFile)
        let composerRelease = withoutDebugBlocks(composer)
        for name in [key, "forceOpaqueSetting", "ConclaveForceOpaqueControlsKey"] { #expect(!composerRelease.contains(name), "\(name) in the composer Release") }
        #expect(normalized(composer).components(separatedBy: "#if DEBUG return forceOpaqueSetting #else return false #endif").count - 1 == 1)
        #expect(!composer.contains("ConclaveForceOpaqueControlsKey"), "the key is declared once, in the call control file")
        #expect(!composer.contains(".environment(\\.\(key)"))

        #expect(normalized(text).components(separatedBy: "#if DEBUG return forceOpaqueSetting #else return false #endif").count - 1 == 3)
        #expect(!text.contains(".environment(\\.\(key)"))

        let gallery = try source(galleryFile)
        #expect(gallery.hasPrefix("#if DEBUG && os(iOS) && !SKIP\n"))
        let uses = gallery.components(separatedBy: key).count - 1
        let setters = gallery.components(separatedBy: ".environment(\\.\(key), forceOpaque)").count - 1
        #expect(setters == 2 && uses == setters)
    }

    @Test func compactBarFitIsArithmeticOnStatedInputs() {
        let divider = [CompactBarFit.androidDividerWidth]

        #expect(!CompactBarFit.fits(targets: [48, 48, 48, 48, 48, 72], spacing: 8, padding: 8, available: 360, nonTargets: divider))
        var legacy = ComponentGalleryCatalog.compactBarControls.map { CompactBarControl(id: $0, width: 48) }
        legacy.append(CompactBarControl(id: CompactBarFit.leaveControlID, width: 72))
        #expect(CompactBarFit.overflow(controls: legacy, moveOrder: ComponentGalleryCatalog.compactBarMoveOrder, spacing: 8, padding: 8,
                                       available: 360, nonTargets: divider) == ["shareScreen"])

        #expect(CompactBarFit.fits(targets: [48, 48, 48, 48, 72], spacing: 8, padding: 8, available: 360, nonTargets: divider))

        let with = CompactBarFit.requiredWidth(targets: [48, 48, 48, 48, 72], spacing: 8, padding: 8, nonTargets: divider)
        let without = CompactBarFit.requiredWidth(targets: [48, 48, 48, 48, 72], spacing: 8, padding: 8)
        #expect(with - without == 1 + 8)
        #expect(CompactBarFit.requiredWidth(targets: [], spacing: 8, padding: 8) == 16)

        let toggles = ComponentGalleryCatalog.compactBarControls
        let order = ComponentGalleryCatalog.compactBarMoveOrder
        let narrow = CompactBarFit.androidPlan(toggleIDs: toggles, moveOrder: order, available: 360)
        #expect(narrow.targetWidth == 48 && narrow.moved == ["shareScreen"] && narrow.fits && narrow.requiredWidth <= 360)
        let phone = CompactBarFit.androidPlan(toggleIDs: toggles, moveOrder: order, available: 411)
        #expect(phone.targetWidth == 56 && phone.moved == ["shareScreen"] && phone.fits && phone.requiredWidth <= 411)
        let tablet = CompactBarFit.androidPlan(toggleIDs: toggles, moveOrder: order, available: 600)
        #expect(tablet.targetWidth == 56 && tablet.moved.isEmpty && tablet.fits)
        #expect(CompactBarFit.androidToggleWidth(available: 384.9) == 48 && CompactBarFit.androidToggleWidth(available: 385) == 56)

        #expect(!CompactBarFit.fits(targets: Array(repeating: 44, count: 6), spacing: 12, padding: 12, available: 320))
        #expect(!CompactBarFit.fits(targets: Array(repeating: 44, count: 6), spacing: 8, padding: 12, available: 320))
        #expect(CompactBarFit.fits(targets: Array(repeating: 44, count: 5), spacing: 12, padding: 12, available: 320))
        let ids = toggles + [CompactBarFit.leaveControlID]
        let compact = CompactBarFit.iosPlan(controlIDs: ids, moveOrder: order, scaledDiameter: 52, available: 320)
        #expect(compact.moved == ["shareScreen"] && compact.fits && compact.spacing == 12 && compact.requiredWidth <= 320)

        let tight = CompactBarFit.iosPlan(controlIDs: ids, moveOrder: order, scaledDiameter: 52, available: 340)
        #expect(tight.moved.isEmpty && tight.fits && tight.spacing == 8)

        let roomy = CompactBarFit.iosPlan(controlIDs: ids, moveOrder: order, scaledDiameter: 70, available: 1000)
        #expect(roomy.targetWidth == 60 && roomy.moved.isEmpty && roomy.spacing == 12)

        var width = 200.0
        while width <= 700 {
            let ios = CompactBarFit.iosPlan(controlIDs: ids, moveOrder: order, scaledDiameter: 52, available: width)
            #expect(ios.targetWidth >= CompactBarFit.iosMinimumTarget && ios.targetWidth <= CompactBarFit.iosMaximumDiameter, "\(width)")
            #expect(!ios.fits || ios.requiredWidth <= width, "\(width)")
            let android = CompactBarFit.androidPlan(toggleIDs: toggles, moveOrder: order, available: width)
            #expect(android.targetWidth >= CompactBarFit.androidMinimumTarget, "\(width)")
            #expect(!android.fits || android.requiredWidth <= width, "\(width)")
            width += 10
        }
        #expect(CompactBarFit.iosMinimumTarget == 44 && CompactBarFit.androidMinimumTarget == 48)
    }

    @Test func componentSourcesAreInert() throws {
        let forbidden = ["MeetingViewModel", "MeetingState", "WebRTC", "SocketIO", "AVAudioSession", "AVCapture", "URLSession",
                         "Socket(", "Timer", "LaunchedEffect", "repeatOnLifecycle", "withFrameNanos", "infinite", "requestPermission",
                         "Gradient", "gradient", "performHapticFeedback", "UIPasteboard", "Clipboard", "Vibrator", "Icons.Default",
                         "@Stable", "@Immutable", "FloatingToolbar", "ButtonGroup", "LoadingIndicator", "TooltipBox"]
        for file in Self.iosComponentFiles + Self.androidComponentFiles {
            let text = try source(file)
            for pattern in forbidden { #expect(!text.contains(pattern), "\(file) uses \(pattern)") }
            #expect(!containsDash(text), "\(file) contains an en or em dash")
        }
        for file in Self.iosComponentFiles where file != Self.callControlFile {
            #expect(try source(file).hasPrefix("#if os(iOS) && !SKIP\n"), "\(file)")
        }
        for file in Self.iosComponentFiles {
            let code = withoutComments(try source(file))

            #expect(!code.contains("sensoryFeedback("), "\(file)")
            #expect(!code.contains("glassProminent"), "\(file)")
            #expect(!code.contains("Image(systemName: \""), "\(file) names a raw symbol")
        }

        let buttons = withoutComments(try source("Sources/Conclave/DesignSystem/iOS/Components/ConclaveButtons+iOS.swift"))
        let prominent = buttons.components(separatedBy: ".buttonStyle(.borderedProminent)")
        #expect(prominent.count - 1 == 1)
        if prominent.count == 2 {
            #expect(normalized(String(prominent[0].suffix(300))).contains("spinnerTint: HostingTheme.onCoral) .foregroundStyle(HostingTheme.onCoral) }"))

            #expect(normalized(String(prominent[1].prefix(200))).hasPrefix(".tint(HostingTheme.coralFill) .controlSize(.large) .opacity(isEnabled ? 1 : ConclaveButtonMetrics.disabledOpacity)"))
        }
        #expect(normalized(buttons).contains("content.accessibilityValue(ConclaveStrings.text(\"In Progress\"))"))

        let rows = withoutComments(try source("Sources/Conclave/DesignSystem/iOS/Components/ConclaveRows+iOS.swift"))
        #expect(normalized(rows).contains("Toggle(title, isOn: $isOn) .accessibilityIdentifier(identifier)"))

        let control = try source(Self.callControlFile)
        for (start, end) in [("struct ConclaveCallInvoker: View {", "struct ConclaveLeaveButton: View {"), ("struct ConclaveLeaveButton: View {", "struct ConclaveControlBar<Content: View>: View {")] {
            let lower = try #require(control.range(of: start))
            let upper = try #require(control.range(of: end, range: lower.upperBound..<control.endIndex))
            let body = withoutComments(String(control[lower.lowerBound..<upper.lowerBound]))
            for name in ["gestureRoute", "conclaveGestureFeedback", "FeedbackKind", "ConclaveGestureRoute"] { #expect(!body.contains(name), "\(start) uses \(name)") }
        }
        #expect(withoutComments(control).components(separatedBy: "conclaveGestureFeedback(").count - 1 == 1)
        #expect(normalized(control).contains(".accessibilityLabel(ConclaveStrings.text(\"Leave Call\"))"))
        #expect(normalized(control).contains(".accessibilityAddTraits(.isToggle)"))
        let kotlinControl = withoutComments(try source("Sources/Conclave/Skip/ui/components/ConclaveCallControl.kt"))
        for (start, end) in [("internal fun ConclaveCallInvoker(", "internal fun conclaveBadgeLabel("), ("internal fun ConclaveLeaveButton(", "internal fun ConclaveCallControlBar(")] {
            let lower = try #require(kotlinControl.range(of: start))
            let upper = try #require(kotlinControl.range(of: end, range: lower.upperBound..<kotlinControl.endIndex))
            let body = String(kotlinControl[lower.lowerBound..<upper.lowerBound])
            for name in ["haptics", "FeedbackKind", "onGesture"] { #expect(!body.contains(name), "\(start) uses \(name)") }
        }
        let flatControl = normalized(kotlinControl)
        #expect(flatControl.contains("if (feedback != null) onGesture(feedback, haptics.gesture(feedback))"))
        #expect(flatControl.contains(".toggleable(value = checked, enabled = enabled, role = Role.Switch,"))
        #expect(flatControl.contains(".semantics { contentDescription = label; stateDescription = stateText }"))
        #expect(flatControl.contains("if (engaged) selected = true"))
        #expect(flatControl.contains(".semantics { isTraversalGroup = true }"))
        #expect(flatControl.contains("val description = conclaveString(\"ds_leave_call\")"))

        let kotlinRows = normalized(withoutComments(try source("Sources/Conclave/Skip/ui/components/ConclaveListRows.kt")))
        #expect(kotlinRows.contains("Column(modifier.testTag(identifier).selectableGroup())"))
        #expect(kotlinRows.contains(".selectable(selected = selected, role = Role.RadioButton,"))
        #expect(kotlinRows.contains(".toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange)"))
        #expect(normalized(try source("Sources/Conclave/Skip/ui/components/ConclaveBanner.kt")).contains("if (announces) liveRegion = if (isAssertive) LiveRegionMode.Assertive else LiveRegionMode.Polite"))

        for file in Self.androidComponentFiles {
            let calls = regexMatches(#"(?<![A-Za-z])Text\("#, in: withoutComments(try source(file))).count
            #expect(calls == (file.hasSuffix("/ConclaveButtons.kt") ? 1 : 0), "\(file) calls Text directly")
        }
        let kotlinButtons = normalized(try source("Sources/Conclave/Skip/ui/components/ConclaveButtons.kt"))
        #expect(kotlinButtons.contains("onTextLayout = { reporter?.report(line, it.hasVisualOverflow) })"))
        #expect(kotlinButtons.contains("internal val LocalConclaveTextReporter = staticCompositionLocalOf<ConclaveTextReporter?> { null }"))

        let gallery = normalized(try source("Sources/Conclave/Skip/ui/hosting/NativeComponentGallery.kt"))
        #expect(gallery.contains("ConclaveTextReporter { line, overflow -> state.overflow.report(configuration, row.id, line, overflow) }"))
        #expect(gallery.components(separatedBy: "CompositionLocalProvider(LocalConclaveTextReporter provides reporter)").count - 1 == 2)
        #expect(gallery.contains("ConclaveGestureHaptics(view = null, debuggable = isDebuggableApp(context))"))
        #expect(!gallery.contains("rememberConclaveHaptics("))
    }

    @Test func hostingThemeOnlyChangedTypographyAndBars() throws {
        let theme = try source("Sources/Conclave/Skip/ui/theme/HostingTheme.kt")

        #expect(regexMatches(#"= Color\(DesignTokens\.android(?:Light|Dark|InCall)[A-Za-z]+\),"#, in: theme).count == 144)
        #expect(theme.contains("typography = ConclaveTypography,"))
        #expect(!theme.contains("enableEdgeToEdge") && !theme.contains("LocalActivity"))

        let bars = normalized(try source("Sources/Conclave/Skip/ui/theme/ConclaveSystemBars.kt"))
        #expect(bars.contains("DisposableEffect(activity) { onDispose { activity?.enableEdgeToEdge() } }"))
        #expect(bars.contains("statusBarStyle = SystemBarPolicy.style(appearance.statusDark)"))
        #expect(bars.contains("navigationBarStyle = SystemBarPolicy.style(appearance.navigationDark)"))
    }

    @Test func semanticsExporterIsDebugOnlyAndBounded() throws {

        let exporter = normalized(try source("Sources/Conclave/Skip/ui/hosting/NativeSemanticsExport.kt"))
        #expect(exporter.contains("(view as? ViewRootForTest)?.semanticsOwner"))
        #expect(exporter.contains("if (!isDebuggableApp(context)) return null"))
        #expect(exporter.contains("if (!isDebuggableApp(app)) return"))
        #expect(exporter.contains("Manifest.permission.DUMP, null, ContextCompat.RECEIVER_EXPORTED)"))
        #expect(exporter.contains("val receiver = registerNativeSemanticsExportReceiver(context) { exporter.export(view, activity, \"broadcast\") } onDispose { if (receiver != null) context.unregisterReceiver(receiver) }"))
        #expect(exporter.contains("toByteArray(Charsets.US_ASCII)"))
        #expect(exporter.contains("\"fontScale\" to NativeSemanticsJson.scale(configuration.fontScale)"))
        #expect(!exporter.contains("String.format(\"") && !exporter.contains(".format(Locale.getDefault()"))
        let root = try source("Sources/Conclave/Skip/ui/AppRoot.kt")
        #expect(root.contains("NativeSemanticsExportReceiver(exporter)"))
        #expect(root.components(separatedBy: "NativeSemanticsExportReceiver(").count - 1 == 1)
    }
}

private func containsDash(_ text: String) -> Bool {
    text.contains("\u{2013}") || text.contains("\u{2014}")
}

private func withoutComments(_ text: String) -> String {
    text.replacingOccurrences(of: #"//[^\n]*"#, with: "", options: .regularExpression)
}

private func normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private let minorWords: Set<String> = ["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "nor",
                                       "of", "on", "or", "per", "the", "to", "vs", "via", "with"]

private func isTitleCase(_ label: String) -> Bool {
    let words = label.components(separatedBy: CharacterSet(charactersIn: " ,:;()/")).filter { !$0.isEmpty }
    for (index, word) in words.enumerated() {
        guard let first = word.unicodeScalars.first else { continue }
        if CharacterSet.uppercaseLetters.contains(first) || CharacterSet.decimalDigits.contains(first) { continue }
        if index > 0 && minorWords.contains(word) { continue }
        if word.unicodeScalars.dropFirst().contains(where: { CharacterSet.uppercaseLetters.contains($0) }) { continue }
        return false
    }
    return true
}

private let properNouns: Set<String> = ["Android", "iOS", "PiP", "TalkBack", "JSON", "Material", "Roboto", "Conclave",
                                        "SF", "Dynamic", "Type", "Appendix",

                                        "Klipy", "YouTube", "GIFs", "WebP",

                                        "GitHub", "Apple", "Google",

                                        "OpenAI", "Sarvam", "Conclave\u{2019}s",

                                        "White", "Black",

                                        "Wi-Fi", "URLs"]

private let quotedNames: [String] = ["in Settings", "Data Saver", "Sleep mode", "Mute and Hang up", "in Layout",
                                     "Switch to Everyone", "Ask and Minutes"]

private func isSentenceCase(_ label: String) -> Bool {
    var text = label
    for name in quotedNames {

        let masked = name.components(separatedBy: " ").map { word -> String in
            guard let initial = word.unicodeScalars.first, CharacterSet.uppercaseLetters.contains(initial) else { return word }
            return word.uppercased()
        }
        text = text.replacingOccurrences(of: name, with: masked.joined(separator: " "))
    }
    text = text.replacingOccurrences(of: " \u{00B7} ", with: ". ")
    for sentence in text.components(separatedBy: ". ") {
        let words = sentence.components(separatedBy: CharacterSet(charactersIn: " ,:;()/")).filter { !$0.isEmpty }
        guard let firstWord = words.first, let first = firstWord.unicodeScalars.first else { continue }
        let fragment = words.allSatisfy { word in
            guard let initial = word.unicodeScalars.first else { return true }
            return !CharacterSet.uppercaseLetters.contains(initial) || isAcronymOrName(word)
        }
        let opensSentence = CharacterSet.uppercaseLetters.contains(first) || CharacterSet.decimalDigits.contains(first) || first == "%"
        if !opensSentence && !fragment { return false }
        for word in words.dropFirst() {
            guard let initial = word.unicodeScalars.first, CharacterSet.uppercaseLetters.contains(initial) else { continue }
            if !isAcronymOrName(word) { return false }
        }
    }
    return true
}

private func isAcronymOrName(_ word: String) -> Bool {

    let bare = word.trimmingCharacters(in: .punctuationCharacters)
    return properNouns.contains(word) || properNouns.contains(bare)
        || !word.unicodeScalars.contains { CharacterSet.lowercaseLetters.contains($0) }
}

private func androidPlurals() throws -> [String: [String: String]] {
    let xml = try source("Android/app/src/main/res/values/strings.xml")
    var result: [String: [String: String]] = [:]
    for match in regexMatches(#"<plurals name="([a-z0-9_]+)"[^>]*>([\s\S]*?)</plurals>"#, in: xml) {
        var forms: [String: String] = [:]
        for item in regexMatches(#"<item quantity="([a-z]+)">([^<]*)</item>"#, in: match[1]) { forms[item[0]] = item[1] }
        result[match[0]] = forms
    }
    return result
}

private func xmlUnescaped(_ value: String) -> String {
    value.replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
        .replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&apos;", with: "'")
        .replacingOccurrences(of: "&amp;", with: "&")
}

private func androidStrings() throws -> [String: String] {
    let xml = try source("Android/app/src/main/res/values/strings.xml")
    var result: [String: String] = [:]
    for match in regexMatches(#"<string name="([a-z0-9_]+)"[^>]*>([^<]*)</string>"#, in: xml) {
        #expect(result[match[0]] == nil, "duplicate resource \(match[0])")
        result[match[0]] = match[1]
    }
    return result
}

private func packageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: packageRoot().appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func sourceFiles(under directory: String, extensions: Set<String>, recursive: Bool = true) throws -> [String] {
    let root = packageRoot()
    let base = root.appendingPathComponent(directory)
    var result: [String] = []
    if recursive {
        let enumerator = FileManager.default.enumerator(at: base, includingPropertiesForKeys: nil)
        while let url = enumerator?.nextObject() as? URL {
            if extensions.contains(url.pathExtension) { result.append(url.path) }
        }
    } else {
        for url in try FileManager.default.contentsOfDirectory(at: base, includingPropertiesForKeys: nil)
            where extensions.contains(url.pathExtension) {
            result.append(url.path)
        }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

private func bracedBlocks(after marker: String, in text: String) -> [Range<String.Index>] {
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

private func withoutDebugBlocks(_ text: String) -> String {
    var kept: [Substring] = []
    var skipping = false
    for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed == "#if DEBUG" {
            skipping = true
            continue
        }
        if skipping && (trimmed == "#else" || trimmed == "#endif") {
            skipping = false
            continue
        }
        if !skipping { kept.append(line) }
    }
    return kept.joined(separator: "\n")
}

private func regexMatches(_ pattern: String, in text: String) -> [[String]] {
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
