#if !SKIP
import Foundation
import Testing
@testable import Conclave

struct FND1FoundationPackTests {

    @Test func leaveHighContrastTokenIsTheApprovedValue() {
        let glyph = ContrastRatio.wcag(foreground: DesignTokens.neutralWhite, background: DesignTokens.iosInCallLeaveHighContrast)
        let boundary = ContrastRatio.wcag(foreground: DesignTokens.iosInCallLeaveHighContrast, background: DesignTokens.iosInCallStage)
        #expect(abs(glyph - 4.555) < 0.001 && glyph >= 4.5)
        #expect(abs(boundary - 4.344) < 0.001 && boundary >= 3.0)
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
}
#endif
