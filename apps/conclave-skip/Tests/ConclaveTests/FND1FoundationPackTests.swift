#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct FND1FoundationPackTests {

    @Test func leaveHighContrastTokenIsTheApprovedValue() {
        #expect(DesignTokens.iosInCallLeaveHighContrast == 0xFFE9152D)
        let glyph = ContrastRatio.wcag(foreground: DesignTokens.neutralWhite, background: DesignTokens.iosInCallLeaveHighContrast)
        let boundary = ContrastRatio.wcag(foreground: DesignTokens.iosInCallLeaveHighContrast, background: DesignTokens.iosInCallStage)
        #expect(abs(glyph - 4.555) < 0.001 && glyph >= 4.5)
        #expect(abs(boundary - 4.344) < 0.001 && boundary >= 3.0)
        #expect(DesignTokens.avatarTongue == 0xFFFF8FB1)
        let generator = try? fndSource("../../packages/ui-tokens/scripts/gen-native-tokens.mjs")
        #expect(generator?.contains("\"leaveHighContrast\"") == true)
        #expect(generator?.contains("constant(\"avatarTongue\"") == true)
    }

    @Test func iosAdapterResolvesContrastAndAppearanceTraits() throws {
        #expect(ConclaveDisabledOpacity.ios == 0.4 && ConclaveDisabledOpacity.android == 0.38)
        #expect(ConclaveControlSurfaceMapping.disabledOpacity == ConclaveDisabledOpacity.ios)
    }

    @Test func motionDurationsAreTheNamedSpecValues() throws {
        #expect(ConclaveMotionDurations.fastMillis == 120)
        #expect(ConclaveMotionDurations.bannerTravel == 8)
        #expect(ConclaveMotionDurations.chromeFadeMillis == 200 && ConclaveMotionDurations.crossFadeMillis == 200)
        #expect(ConclaveMotionDurations.stageSwapMillis == 200 && ConclaveMotionDurations.tileReflowMillis == 220)
        #expect(ConclaveMotionDurations.zoomSnapMillis == 250 && ConclaveMotionDurations.entryExpandResponseSeconds == 0.38)
        #expect(ConclaveMotionDurations.spatialDampingRatio == 0.9 && ConclaveMotionDurations.spatialStiffness == 700)

    }

    @Test func iosReaderMappingCoversEverySetting() {
        let standard = SystemAccessibilityMapping.iosState(voiceOver: false, switchControl: false, assistiveAccess: false,
                                                           reduceMotion: false, prefersCrossFade: false, differentiateWithoutColor: false)
        #expect(standard == SystemAccessibilityState.standard)
        #expect(!standard.blocksAutoHide && standard.recommendedTimeoutMillis == 5000)
        for (voiceOver, switchControl) in [(true, false), (false, true), (true, true)] {
            let state = SystemAccessibilityMapping.iosState(voiceOver: voiceOver, switchControl: switchControl, assistiveAccess: false,
                                                            reduceMotion: false, prefersCrossFade: false, differentiateWithoutColor: false)
            #expect(state.isScreenReaderRunning && state.blocksAutoHide)
        }
        let assistive = SystemAccessibilityMapping.iosState(voiceOver: false, switchControl: false, assistiveAccess: true,
                                                            reduceMotion: false, prefersCrossFade: false, differentiateWithoutColor: false)
        #expect(!assistive.isScreenReaderRunning && assistive.blocksAutoHide)

        for (reduce, crossFade) in [(true, false), (false, true)] {
            #expect(SystemAccessibilityMapping.iosState(voiceOver: false, switchControl: false, assistiveAccess: false, reduceMotion: reduce,
                                                        prefersCrossFade: crossFade, differentiateWithoutColor: false).reduceMotion)
        }
        #expect(SystemAccessibilityMapping.iosState(voiceOver: false, switchControl: false, assistiveAccess: false, reduceMotion: false,
                                                    prefersCrossFade: false, differentiateWithoutColor: true).differentiateWithoutColor)
    }

    @Test func androidReaderMappingCoversEverySetting() {
        let base = SystemAccessibilityMapping.androidState(touchExploration: false, anyServiceEnabled: false, animatorDurationScale: 1,
                                                           recommendedTimeoutMillis: nil)
        #expect(base == SystemAccessibilityState.standard)
        #expect(SystemAccessibilityMapping.androidState(touchExploration: true, anyServiceEnabled: true, animatorDurationScale: 1,
                                                        recommendedTimeoutMillis: nil).isScreenReaderRunning)
        #expect(SystemAccessibilityMapping.androidState(touchExploration: false, anyServiceEnabled: true, animatorDurationScale: 1,
                                                        recommendedTimeoutMillis: nil).isScreenReaderRunning)

        #expect(SystemAccessibilityMapping.androidState(touchExploration: false, anyServiceEnabled: false, animatorDurationScale: 0,
                                                        recommendedTimeoutMillis: nil).reduceMotion)
        #expect(!SystemAccessibilityMapping.androidState(touchExploration: false, anyServiceEnabled: false, animatorDurationScale: 0.5,
                                                         recommendedTimeoutMillis: nil).reduceMotion)

        #expect(SystemAccessibilityMapping.androidState(touchExploration: false, anyServiceEnabled: false, animatorDurationScale: 1,
                                                        recommendedTimeoutMillis: 15000).recommendedTimeoutMillis == 15000)
        #expect(SystemAccessibilityMapping.androidState(touchExploration: false, anyServiceEnabled: false, animatorDurationScale: 1,
                                                        recommendedTimeoutMillis: 0).recommendedTimeoutMillis == 5000)
        #expect(SystemAccessibilityMapping.androidBoldText(fontWeightAdjustment: 300))
        #expect(!SystemAccessibilityMapping.androidBoldText(fontWeightAdjustment: 0))
        #expect(!SystemAccessibilityMapping.androidIncreasedContrast(contrastLevel: nil))
        #expect(!SystemAccessibilityMapping.androidIncreasedContrast(contrastLevel: 0))
        #expect(SystemAccessibilityMapping.androidIncreasedContrast(contrastLevel: 0.5))
        #expect(SystemAccessibilityMapping.androidIncreasedContrast(contrastLevel: 1))
    }

    @Test func toastTimingPersistsActionToastsUnderAScreenReader() {
        #expect(ConclaveToastTiming.durationMillis(hasAction: false, isScreenReaderRunning: false) == 4000)
        #expect(ConclaveToastTiming.durationMillis(hasAction: true, isScreenReaderRunning: false) == 8000)
        #expect(ConclaveToastTiming.durationMillis(hasAction: false, isScreenReaderRunning: true) == 4000)
        #expect(ConclaveToastTiming.durationMillis(hasAction: true, isScreenReaderRunning: true) == 0)
    }

    @Test func progressToastsWaitForTheOperationOwner() {
        for hasAction in [false, true] {
            for screenReader in [false, true] {
                #expect(ConclaveToastTiming.durationMillis(hasAction: hasAction, isScreenReaderRunning: screenReader,
                                                           isProgress: true) == 0)
            }
        }
    }

    @Test func avatarIdentityMatchesTheWebVectors() {
        let vectors: [(String, String?, String, Int, Int, Int, Int)] = [
            ("Guest", nil, "Guest", 69156280, 8, 0, 9),
            ("Avery", nil, "Avery", 63644919, 7, 3, 2),
            ("Avery", "user-1", "Avery:user-1", 524599662, 14, 2, 9),
            ("", nil, "?", 63, 15, 3, 0),
            ("Ishaan", nil, "Ishaan", 2095639760, 0, 0, 1),
            ("Zo\u{EB}", nil, "Zo\u{EB}", 90166, 6, 2, 1),
            ("\u{645}\u{631}\u{64A}\u{645}", nil, "\u{645}\u{631}\u{64A}\u{645}", 49389255, 7, 3, 6),
            ("\u{674E}\u{96F7}", "abc123", "\u{674E}\u{96F7}:abc123", 2024641087, 15, 3, 6),
        ]
        for (name, id, seed, hash, color, face, mouth) in vectors {
            let identity = ConclaveAvatarIdentity.make(name: name, id: id)
            #expect(identity.seed == seed)
            #expect(FacehashPresentation.hashValue(for: seed) == hash, "\(seed)")
            #expect(identity.paletteIndex == color && identity.faceIndex == face && identity.mouthIndex == mouth, "\(seed)")
        }

        #expect(ConclaveAvatarIdentity.make(name: "Guest", id: nil).fill == 0xFFE879F9)
        #expect(ConclaveAvatarIdentity.make(name: "", id: "u1").seed == "u1:u1")
        #expect(ConclaveAvatarSize.allCases.map { $0.diameter } == [24, 32, 40, 44, 30, 76, 96])
        #expect(ConclaveAvatarSize.allCases.filter { $0.scalesWithText } == [.mention, .chat, .row])
    }

    @Test func dialogsKeepOneConfirmAndNoCoral() throws {
        let model = ConclaveDialogModel(kind: .confirmation, title: "End", message: "", confirmTitle: "End", confirmRole: .destructive)
        #expect(model.kind == .confirmation && model.confirmRole == .destructive)
    }

    @Test func labelledToggleNeverTakesGlassOnALobbySurface() throws {
        for context in [ConclaveSurfaceContext.overVideo, .onSurface] {
            for glass in [false, true] {
                let spec = ConclaveControlSurfaceMapping.spec(.on, context: context, glassAvailable: glass, reduceTransparency: false,
                                                              forceOpaque: false, increasedContrast: false, isEnabled: true)
                #expect(spec.fill != .glass && !spec.isInteractive, "\(context.rawValue) \(glass)")
            }
        }
        #expect(!ConclaveSurfaceContext.overVideo.allowsGlass && !ConclaveSurfaceContext.onSurface.allowsGlass && ConclaveSurfaceContext.stage.allowsGlass)
    }

    @Test func foundationSpecimenIDsAreStable() {
        #expect(ComponentGalleryCatalog.foundationSpecimenIDs == [
            "button.icon", "button.close", "button.icon.toggle", "avatar.row", "avatar.chat", "avatar.tile", "avatar.lobby",
            "section.header", "section.footer", "dialog.confirm", "dialog.alert", "field.text", "field.text.error",
            "field.composer", "toggle.call.labelled",
        ])
        let all = ComponentGalleryCatalog.foundationSpecimenIDs + ComponentGalleryCatalog.inCallChromeSpecimenIDs
        #expect(Set(all).count == all.count)

        #expect(Set(all).isDisjoint(with: Set(ComponentGalleryCatalog.componentSpecimenIDs(showLoading: true).map { $0.replacingOccurrences(of: ".inCall", with: "").replacingOccurrences(of: ".app", with: "") })))
        for id in all { #expect(id.unicodeScalars.allSatisfy { $0.isASCII && $0 != " " }, "\(id)") }
    }
}

func normalizedFND(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

func fndContainsDash(_ text: String) -> Bool {
    text.contains("\u{2013}") || text.contains("\u{2014}")
}

private func fndPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

func fndSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: fndPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

func fndFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = fndPackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

func fndMatches(_ pattern: String, in text: String) -> [[String]] {
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
