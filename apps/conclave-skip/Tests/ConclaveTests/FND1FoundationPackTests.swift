#if !SKIP
import Foundation
import Testing
@testable import Conclave

/// FND-1, foundation pack 1 (OUT/PLAN-screens.md section 5): the adapter and token additions (F00 2.6 A1 to A7,
/// owner OQ4), motion constants (A5; S10 R3; S20 SR2), the system accessibility readers (S70 13), plurals (S10 R11),
/// tabular digits (S60 R6-13), the entry components C02, C07, C11, C18, C19 and the C04 labelled toggle, and the
/// stage lifetime probes (S10 R12). iOS-only and Kotlin sources are not compiled by this macOS host, so their rules
/// are read from the sources; the Kotlin half runs in T/Skip/FND1FND2BridgeTests.kt.
struct FND1FoundationPackTests {
    // MARK: Tokens (A2, OQ4) and the avatar tongue

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

    // MARK: Adapter members (A1 to A3, A6)

    @Test func iosAdapterResolvesContrastAndAppearanceTraits() throws {
        let adapter = normalizedFND(try fndSource("Sources/Conclave/DesignSystem/iOS/HostingTheme+iOS.swift"))
        let pairs: [(String, String, String)] = [
            ("inCallTextSecondary", "iosInCallTextSecondary", "iosInCallTextSecondaryHighContrast"),
            ("inCallTextTertiary", "iosInCallTextTertiary", "iosInCallTextTertiaryHighContrast"),
            ("inCallBorder", "iosInCallBorder", "iosInCallBorderHighContrast"),
            ("inCallBorderStrong", "iosInCallBorderStrong", "iosInCallBorderStrongHighContrast"),
            ("inCallLabelScrim", "iosInCallLabelScrim", "iosInCallLabelScrimHighContrast"),
            ("inCallOnCoral", "iosInCallOnCoral", "iosInCallOnCoralHighContrast"),
            ("inCallCoralText", "iosInCallCoralText", "iosInCallCoralTextHighContrast"),
        ]
        for (member, standard, high) in pairs {
            #expect(adapter.contains("static let \(member) = contrastPair(DesignTokens.\(standard), DesignTokens.\(high))"), "\(member)")
        }
        #expect(adapter.contains("color(traits.accessibilityContrast == .high ? highContrast : standard)"))
        // A2: dynamic system red at standard contrast, the approved fixed fill under Increase Contrast.
        #expect(adapter.contains("if traits.accessibilityContrast == .high { return color(DesignTokens.iosInCallLeaveHighContrast) }"))
        #expect(adapter.contains("return UIColor.systemRed.resolvedColor(with: traits)"))
        // A3: light and dark status tokens.
        for (member, light, dark) in [("statusSuccess", "successLight", "successDark"), ("statusWarning", "warningLight", "warningDark"),
                                      ("statusLive", "liveLight", "liveDark")] {
            #expect(adapter.contains("static let \(member) = appearancePair(light: DesignTokens.\(light), dark: DesignTokens.\(dark))"), "\(member)")
        }
        // A6.
        #expect(adapter.contains("static let disabledOpacity = ConclaveDisabledOpacity.ios"))
        #expect(ConclaveDisabledOpacity.ios == 0.4 && ConclaveDisabledOpacity.android == 0.38)
        #expect(ConclaveControlSurfaceMapping.disabledOpacity == ConclaveDisabledOpacity.ios)
    }

    @Test func androidExtendedColorsComeFromTheTheme() throws {
        let colors = try fndSource("Sources/Conclave/Skip/ui/theme/ConclaveExtendedColors.kt")
        #expect(colors.contains("internal val LocalConclaveExtendedColors = staticCompositionLocalOf { ConclaveExtendedColorsLight }"))
        #expect(fndMatches(#"Color\(\s*0x"#, in: colors).isEmpty)
        for role in ["success", "warning", "live", "onWarning", "onLive", "handRaised", "speaking", "callEnd", "onCallEnd", "stage",
                     "tile", "labelScrim", "toolbar", "toggleOnContainer", "onToggleOn", "toggleOffContainer", "onToggleOff",
                     "toggleEngagedContainer", "onToggleEngaged", "border"] {
            #expect(colors.contains("val \(role): Color,"), "\(role)")
        }
        let theme = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/theme/HostingTheme.kt"))
        #expect(theme.contains("CompositionLocalProvider(LocalConclaveExtendedColors provides if (dark) ConclaveExtendedColorsDark else ConclaveExtendedColorsLight)"))
    }

    // MARK: Call appearance (A7)

    @Test func callAppearanceOwnsTheDarkRootAndPublishesTheSystemScheme() throws {
        let text = try fndSource("Sources/Conclave/DesignSystem/iOS/CallAppearance+iOS.swift")
        #expect(text.hasPrefix("#if os(iOS) && !SKIP\n"))
        let flat = normalizedFND(text)
        #expect(flat.contains("if #available(iOS 27.0, *) { content.toolbarColorScheme(.dark, for: .statusBar) } else { content.preferredColorScheme(.dark) }"))
        #expect(flat.contains(".environment(\\.conclaveSystemColorScheme, sceneScheme ?? inheritedScheme)"))
        #expect(flat.contains("scene.registerForTraitChanges([UITraitUserInterfaceStyle.self], target: self,"))
        // A nested in-call region never touches the window or the status bar.
        #expect(flat.contains("func conclaveInCallRegion() -> some View { environment(\\.colorScheme, .dark) }"))
    }

    // MARK: Motion (A5; S10 R3; S20 SR2)

    @Test func motionDurationsAreTheNamedSpecValues() throws {
        #expect(ConclaveMotionDurations.fastMillis == 120)
        #expect(ConclaveMotionDurations.bannerTravel == 8)
        #expect(ConclaveMotionDurations.chromeFadeMillis == 200 && ConclaveMotionDurations.crossFadeMillis == 200)
        #expect(ConclaveMotionDurations.stageSwapMillis == 200 && ConclaveMotionDurations.tileReflowMillis == 220)
        #expect(ConclaveMotionDurations.zoomSnapMillis == 250 && ConclaveMotionDurations.entryExpandResponseSeconds == 0.38)
        #expect(ConclaveMotionDurations.spatialDampingRatio == 0.9 && ConclaveMotionDurations.spatialStiffness == 700)
        let ios = normalizedFND(try fndSource("Sources/Conclave/DesignSystem/iOS/ConclaveMotion+iOS.swift"))
        for name in ["fast", "chromeFade", "snap", "entryExpand", "crossFade", "tileReflow", "stageSwap", "zoomSnap"] {
            #expect(ios.contains("static let \(name) = "), "\(name)")
        }
        #expect(ios.contains("if reduceMotion { return .opacity }"))
        let kotlin = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/theme/ConclaveMotion.kt"))
        for name in ["fast", "chromeFade", "spatialDefault", "crossFade", "tileReflow", "stageSwap", "zoomSnap"] {
            #expect(kotlin.contains("fun <T> \(name)()"), "\(name)")
        }
        #expect(kotlin.contains("easing = CubicBezierEasing(0.2f, 0f, 0f, 1f)"))
        // The banner motion reads the shared durations on both platforms.
        #expect(try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveBanner+iOS.swift").contains("ConclaveMotionDurations.fastMillis"))
        #expect(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveBanner.kt").contains("ConclaveMotionDurations.fastMillis"))
    }

    // MARK: System accessibility readers (S70 13)

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
        // Reduce Motion and Prefer Cross-Fade Transitions both remove travel.
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
        // Remove animations is an animator duration scale of 0, nothing else.
        #expect(SystemAccessibilityMapping.androidState(touchExploration: false, anyServiceEnabled: false, animatorDurationScale: 0,
                                                        recommendedTimeoutMillis: nil).reduceMotion)
        #expect(!SystemAccessibilityMapping.androidState(touchExploration: false, anyServiceEnabled: false, animatorDurationScale: 0.5,
                                                         recommendedTimeoutMillis: nil).reduceMotion)
        // API 29 recommendation, else the 5 s base; a nonsense value keeps the base.
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

    @Test func readersAreLiveAndOnePerSetting() throws {
        let ios = try fndSource("Sources/Conclave/DesignSystem/iOS/SystemAccessibility+iOS.swift")
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP\n"))
        for key in ["accessibilityVoiceOverEnabled", "accessibilitySwitchControlEnabled", "accessibilityReduceMotion",
                    "accessibilityDifferentiateWithoutColor", "accessibilityAssistiveAccessEnabled", "accessibilityReduceTransparency",
                    "colorSchemeContrast", "legibilityWeight", "accessibilityDimFlashingLights", "accessibilityPlayAnimatedImages"] {
            #expect(ios.contains("@Environment(\\.\(key))"), "\(key)")
        }
        #expect(ios.contains("UIAccessibility.prefersCrossFadeTransitionsStatusDidChange"))
        #expect(normalizedFND(ios).contains("if #available(iOS 18.0, *) { content.modifier(AssistiveAccessProbe(isRunning: $isRunning)) } else { content }"))
        let android = try fndSource("Sources/Conclave/Skip/ui/theme/SystemAccessibility.kt")
        for call in ["addTouchExplorationStateChangeListener", "addAccessibilityStateChangeListener", "ANIMATOR_DURATION_SCALE",
                     "getRecommendedTimeoutMillis(base, CONCLAVE_TIMEOUT_FLAGS)", "configuration.fontWeightAdjustment",
                     "addContrastChangeListener", "Lifecycle.Event.ON_RESUME"] {
            #expect(android.contains(call), "\(call)")
        }
        // Version-gated calls live in their own objects.
        for gate in ["@RequiresApi(29)", "@RequiresApi(31)", "@RequiresApi(34)"] { #expect(android.contains(gate), "\(gate)") }
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

    // MARK: Plurals (S10 R11) and tabular digits (S60 R6-13)

    @Test func pluralsAndTabularDigitsHaveOneHelperEach() throws {
        let strings = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/theme/ConclaveStrings.kt"))
        #expect(strings.contains("internal fun conclavePlural(name: String, count: Int, vararg formatArgs: Any): String"))
        #expect(strings.contains("internal fun conclavePluralOf(context: Context, name: String, count: Int, vararg formatArgs: Any): String"))
        #expect(strings.contains("context.resources.getIdentifier(name, \"plurals\", context.packageName)"))
        #expect(strings.contains("pluralStringResource(id, count, *formatArgs)"))
        let typography = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/theme/ConclaveTypography.kt"))
        #expect(typography.contains("internal fun TextStyle.tabular(): TextStyle = copy(fontFeatureSettings = \"tnum\")"))
        #expect(typography.contains("internal fun rememberTabular(style: TextStyle): TextStyle = remember(style) { style.tabular() }"))
        // Nothing else sets the feature by hand.
        for file in try fndFiles(under: "Sources/Conclave/Skip/ui", extensions: ["kt"]) where !file.hasSuffix("/ConclaveTypography.kt") {
            #expect(!(try fndSource(file)).contains("fontFeatureSettings"), "\(file)")
        }
    }

    // MARK: Avatar (C07)

    /// F00 C07 l: vectors computed from the web `facehash` hash; the same face on every platform.
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
        // "Guest" is magenta on every platform (the legacy Android avatar drew teal).
        #expect(ConclaveAvatarIdentity.make(name: "Guest", id: nil).fill == 0xFFE879F9)
        #expect(ConclaveAvatarIdentity.make(name: "", id: "u1").seed == "u1:u1")
        #expect(ConclaveAvatarSize.allCases.map { $0.diameter } == [24, 32, 40, 44, 30, 76, 96])
        #expect(ConclaveAvatarSize.allCases.filter { $0.scalesWithText } == [.mention, .chat, .row])
    }

    @Test func avatarSourcesStayFlatAndDecorative() throws {
        let ios = normalizedFND(try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveAvatar+iOS.swift"))
        #expect(ios.contains(".fill(HostingTheme.token(identity.fill))"))
        #expect(ios.contains("Circle().strokeBorder(HostingTheme.token(DesignTokens.avatarRing), lineWidth: 1)"))
        #expect(ios.contains(".fill(HostingTheme.token(DesignTokens.avatarTongue))"))
        #expect(ios.contains(".accessibilityIgnoresInvertColors()"))
        #expect(!ios.contains("FacehashPresentation.color(") && !ios.contains("FacehashPresentation.tongue"))
        let android = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveAvatar.kt"))
        #expect(android.contains("val identity = remember(name, id) { ConclaveAvatarIdentity.make(name = name, id = id) }"))
        #expect(android.contains("Modifier.semantics { hideFromAccessibility() }"))
        #expect(android.contains("drawWithCache"))
        for word in ["Brush", "blink", "infinite", "LaunchedEffect"] { #expect(!android.contains(word), "\(word)") }
    }

    // MARK: Entry components (C02, C11, C18, C19) and the labelled toggle (C04 f)

    @Test func closeAndBackFollowThePlatform() throws {
        let ios = normalizedFND(try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveButtons+iOS.swift"))
        #expect(ios.contains("if #available(iOS 26.0, *) { Button(role: .close, action: action) } else { Button(action: action) { Image(systemName: ConclaveSymbols.xmark) .accessibilityHidden(true) } }"))
        #expect(ios.contains(".keyboardShortcut(.cancelAction) .accessibilityLabel(label)"))
        #expect(ios.contains("if let title { return ConclaveStrings.format(\"Close %@\", title) } return ConclaveStrings.text(\"Close\")"))
        let android = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveButtons.kt"))
        #expect(android.contains("if (title != null) conclaveString(\"ds_close_title\", title) else conclaveString(\"ds_close\")"))
        #expect(android.contains("if (toCall) conclaveString(\"ds_back_to_call\") else conclaveString(\"ds_back\")"))
        #expect(android.contains("ConclaveIconButton(description, ConclaveIcons.ArrowBackFill0, identifier, onClick, modifier)"))
    }

    @Test func sectionHeadersAreHeadingsWithTheirCount() throws {
        let ios = normalizedFND(try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveRows+iOS.swift"))
        #expect(ios.contains("Text(count, format: .number) .monospacedDigit()"))
        #expect(ios.contains(".accessibilityElement(children: .combine) .accessibilityAddTraits(.isHeader)"))
        let android = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveListRows.kt"))
        #expect(android.contains(".semantics(mergeDescendants = true) { heading() }"))
        #expect(android.contains("style = rememberTabular(style)"))
    }

    @Test func dialogsKeepOneConfirmAndNoCoral() throws {
        let ios = normalizedFND(try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveDialogs+iOS.swift"))
        #expect(ios.components(separatedBy: "role: model.confirmRole == .destructive ? .destructive : nil").count - 1 == 2)
        #expect(ios.contains("content.confirmationDialog(model.title, isPresented: $isPresented, titleVisibility: .visible)"))
        #expect(ios.contains("Button(ConclaveStrings.text(\"Cancel\"), role: .cancel, action: onCancel)"))
        #expect(ios.contains("Button(ConclaveStrings.text(\"Not Now\"), role: .cancel, action: onCancel)"))
        let android = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveDialogs.kt"))
        #expect(android.contains("if (destructive) ButtonDefaults.textButtonColors(contentColor = scheme.error) else ButtonDefaults.textButtonColors()"))
        #expect(!android.contains("primaryContainer"))
        let model = ConclaveDialogModel(kind: .confirmation, title: "End", message: "", confirmTitle: "End", confirmRole: .destructive)
        #expect(model.kind == .confirmation && model.confirmRole == .destructive)
    }

    @Test func fieldsKeepTextLocalAndSendLabelled() throws {
        let ios = normalizedFND(try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveFields+iOS.swift"))
        #expect(ios.contains("TextField(prompt, text: $text, axis: .vertical) .lineLimit(1...6)"))
        #expect(ios.contains(".accessibilityLabel(ConclaveStrings.text(\"Send\"))"))
        #expect(ios.contains(".accessibilityLabel(ConclaveStrings.format(\"%lld of %lld Characters\", count, limit))"))
        #expect(!ios.contains("glassEffect") && !ios.contains("GlassEffectContainer"))
        let android = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveFields.kt"))
        #expect(android.contains("Icon(ConclaveIcons.SendFill1, contentDescription = conclaveString(\"ds_send\"),"))
        #expect(android.contains("event.key == Key.Enter && !event.isShiftPressed"))
        #expect(android.contains("maxLines = 6"))
        for file in ["Sources/Conclave/DesignSystem/iOS/Components/ConclaveFields+iOS.swift", "Sources/Conclave/Skip/ui/components/ConclaveFields.kt"] {
            #expect(!(try fndSource(file)).contains("MeetingViewModel"), "\(file)")
        }
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
        let control = normalizedFND(try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveCallControl+iOS.swift"))
        #expect(control.contains("self.context = context == .stage ? .onSurface : context"))
        #expect(control.contains("struct ConclaveLabelledCallToggle: View {"))
        let android = normalizedFND(try fndSource("Sources/Conclave/Skip/ui/components/ConclaveCallControl.kt"))
        #expect(android.contains("internal fun ConclaveLabelledCallToggle("))
        #expect(android.contains("val caption = Modifier.clearAndSetSemantics { }"))
    }

    // MARK: Stage lifetime probes (S10 R12)

    @Test func stageLifetimeProbesAreExposed() throws {
        let ios = try fndSource("Sources/Conclave/App/PlatformRoot+iOS.swift")
        #expect(ios.contains("\nfinal class HostingStageLifetime {\n"))
        #expect(!ios.contains("private final class HostingStageLifetime"))
        #expect(ios.contains("private(set) var creations = 0"))
        let android = try fndSource("Sources/Conclave/Skip/ui/AppRoot.kt")
        #expect(android.contains("\ninternal class NativeHostingStageLifetime {\n"))
        #expect(!android.contains("private class NativeHostingStageLifetime"))
    }

    // MARK: Catalog and shared models

    @Test func foundationSpecimenIDsAreStable() {
        #expect(ComponentGalleryCatalog.foundationSpecimenIDs == [
            "button.icon", "button.close", "button.icon.toggle", "avatar.row", "avatar.chat", "avatar.tile", "avatar.lobby",
            "section.header", "section.footer", "dialog.confirm", "dialog.alert", "field.text", "field.text.error",
            "field.composer", "toggle.call.labelled",
        ])
        let all = ComponentGalleryCatalog.foundationSpecimenIDs + ComponentGalleryCatalog.inCallChromeSpecimenIDs
        #expect(Set(all).count == all.count)
        // No clash with the WP1-2b component specimens.
        #expect(Set(all).isDisjoint(with: Set(ComponentGalleryCatalog.componentSpecimenIDs(showLoading: true).map { $0.replacingOccurrences(of: ".inCall", with: "").replacingOccurrences(of: ".app", with: "") })))
        for id in all { #expect(id.unicodeScalars.allSatisfy { $0.isASCII && $0 != " " }, "\(id)") }
    }

    @Test func sharedModelsStayInsideSkipLite() throws {
        let text = try fndSource("Sources/Conclave/DesignSystem/iOS/Components/ConclaveComponentModels.swift")
        #expect(!text.contains("#if"))
        // String raw-value enums only, no associated values, no tuples, no function references in maps.
        #expect(fndMatches(#"case [a-z][A-Za-z]*\("#, in: text).isEmpty)
        #expect(fndMatches(#"-> \("#, in: text).isEmpty)
        #expect(fndMatches(#"\.map\([A-Za-z.]+\)"#, in: text).isEmpty && !text.contains("compactMap"))
        for word in ["Gradient", "gradient", "SwiftUI", "UIKit", "MeetingViewModel"] { #expect(!text.contains(word), "\(word)") }
        #expect(!fndContainsDash(text))
    }
}

// MARK: Helpers

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
