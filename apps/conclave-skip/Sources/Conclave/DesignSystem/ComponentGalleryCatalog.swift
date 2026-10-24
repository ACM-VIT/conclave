/// A token-based contrast pair for the component gallery (TG 4.2, Appendix C). `expectedRatio` is the
/// archived design calculation; the gallery shows the live ratio next to it.
struct GalleryContrastPair: Equatable {
    let id: String
    let caption: String
    let foreground: Int64
    let background: Int64
    let requirement: ContrastRequirement
    let expectedRatio: Double

    var ratio: Double { ContrastRatio.wcag(foreground: foreground, background: background) }
}

/// Collapsible sections of the component gallery. Each builds its rows only while it is expanded.
enum GallerySection: String, CaseIterable {
    case typography, haptics, contrast, systemProminent

    /// iOS 26 system-prominent chrome has no Android counterpart; Android draws Material 3 roles.
    var isIOSOnly: Bool { self == .systemProminent }
}

/// Stable specimen identifiers and immutable catalog data shared by both Debug galleries. Identifiers are
/// ASCII and machine-read by runtime scripts, so renaming one is a contract change.
enum ComponentGalleryCatalog {
    static let galleryToggleID = "components.gallery.toggle"
    static let environmentID = "components.environment"
    static let overflowID = "components.overflow"
    static let longTextToggleID = "components.longText"
    static let hapticVerifyID = "components.haptics.verify"
    static let hapticResultID = "components.haptics.result"
    static let hapticRecordID = "components.haptics.record"

    static func sectionID(_ section: GallerySection) -> String {
        return "components.section." + section.rawValue
    }

    static func typeSpecimenID(_ style: ConclaveTextStyle, _ weight: ConclaveTextWeight) -> String {
        return "type." + style.rawValue + "." + weight.rawValue
    }

    static func hapticSpecimenID(_ kind: FeedbackKind) -> String {
        return "haptic." + kind.rawValue
    }

    /// A live pair resolves platform colors at run time, so it carries the column it was resolved in.
    static func liveContrastID(_ name: String, inCall: Bool) -> String {
        return columnID("contrast.live." + name, inCall: inCall)
    }

    /// Specimens drawn in both appearance columns: "App" follows the system, "In call" is always dark.
    static func columnID(_ id: String, inCall: Bool) -> String {
        return id + (inCall ? ".inCall" : ".app")
    }

    /// The Debug long-text specimens double every string, the way `-NSDoubleLocalizedStrings` does.
    static func expanded(_ text: String) -> String {
        return text + " " + text
    }

    /// iOS only: how system-prominent chrome renders against the coral AccentColor (A17, Q12). Each base ID
    /// is drawn in both columns through `columnID`.
    static let prominentConfirmationActionID = "system.prominent.confirmationAction"
    static let prominentGlassID = "system.prominent.glass"
    static let prominentBorderedID = "system.prominent.bordered"
    static let prominentGlassOnCoralID = "system.prominent.glass.onCoral"
    static let prominentBorderedOnCoralID = "system.prominent.bordered.onCoral"
    /// The row that opens the confirmation-action page, whose Done button carries the specimen ID.
    static let prominentPageLinkID = "system.prominent.confirmationAction.open"
    static let systemProminentSpecimenIDs: [String] = [
        prominentConfirmationActionID, prominentGlassID, prominentBorderedID,
        prominentGlassOnCoralID, prominentBorderedOnCoralID,
    ]

    /// White on the iOS AccentColor in each appearance, for the system-prominent readouts.
    static let accentLight: Int64 = DesignTokens.coralDeep
    static let accentLightHighContrast: Int64 = DesignTokens.coralDeepHighContrast
    static let accentDark: Int64 = DesignTokens.coralBright
    static let accentDarkHighContrast: Int64 = DesignTokens.coralBrightHighContrast

    static let contrastPairs: [GalleryContrastPair] = [
        pair("contrast.onCoral.ink", "Ink on coral (onCoral)", DesignTokens.ink, DesignTokens.coral, .text, 6.374),
        pair("contrast.onCoral.black", "Black on coral (onCoral, increased contrast)", DesignTokens.iosAppOnCoralHighContrast, DesignTokens.coral, .text, 6.764),
        pair("contrast.coral.white", "White on coral", DesignTokens.neutralWhite, DesignTokens.coral, .forbiddenText, 3.105),
        pair("contrast.accentDark.white", "White on the dark AccentColor", DesignTokens.neutralWhite, accentDark, .forbiddenText, 2.507),
        pair("contrast.accentDarkHighContrast.white", "White on the dark AccentColor, increased contrast", DesignTokens.neutralWhite, accentDarkHighContrast, .forbiddenText, 2.268),
        pair("contrast.accentLight.white", "White on the light AccentColor", DesignTokens.neutralWhite, accentLight, .text, 5.366),
        pair("contrast.accentLightHighContrast.white", "White on the light AccentColor, increased contrast", DesignTokens.neutralWhite, accentLightHighContrast, .text, 7.236),
        pair("contrast.coralDeep.white", "Coral deep on white", DesignTokens.coralDeep, DesignTokens.neutralWhite, .text, 5.366),
        pair("contrast.coralDeep.groupedLight", "Coral deep on grouped background", DesignTokens.coralDeep, DesignTokens.iosAppLaunchBackgroundLight, .text, 4.809),
        pair("contrast.coralDeep.light4", "Coral deep on light 4 (R03 reference)", DesignTokens.coralDeep, DesignTokens.neutralLight4, .text, 4.551),
        pair("contrast.coralDeepHighContrast.white", "Coral deep, increased contrast, on white", DesignTokens.coralDeepHighContrast, DesignTokens.neutralWhite, .text, 7.236),
        pair("contrast.coralDeepHighContrast.groupedLight", "Coral deep, increased contrast, on grouped background", DesignTokens.coralDeepHighContrast, DesignTokens.iosAppLaunchBackgroundLight, .text, 6.485),
        pair("contrast.coralBright.black", "Coral bright on black", DesignTokens.coralBright, DesignTokens.neutralBlack, .text, 8.377),
        pair("contrast.coralBright.ink", "Coral bright on ink", DesignTokens.coralBright, DesignTokens.ink, .text, 7.895),
        pair("contrast.coralBright.surfaceRaised", "Coral bright on raised surface", DesignTokens.coralBright, DesignTokens.neutralSurfaceRaised, .text, 6.246),
        pair("contrast.coralBrightHighContrast.ink", "Coral bright, increased contrast, on ink", DesignTokens.coralBrightHighContrast, DesignTokens.ink, .text, 8.726),
        pair("contrast.coralBrightHighContrast.surfaceRaised", "Coral bright, increased contrast, on raised surface", DesignTokens.coralBrightHighContrast, DesignTokens.neutralSurfaceRaised, .text, 6.904),
        pair("contrast.coralBright.zinc700", "Coral bright on zinc 700 (R03)", DesignTokens.coralBright, DesignTokens.neutralZinc700, .forbiddenText, 4.166),
        pair("contrast.androidLight.onPrimary", "Android light onPrimary on primary", DesignTokens.androidLightOnPrimary, DesignTokens.androidLightPrimary, .text, 5.366),
        pair("contrast.androidDark.onPrimary", "Android dark onPrimary on primary", DesignTokens.androidDarkOnPrimary, DesignTokens.androidDarkPrimary, .text, 7.895),
        pair("contrast.androidLight.primarySurfaceContainerHigh", "Android light primary on surfaceContainerHigh", DesignTokens.androidLightPrimary, DesignTokens.androidLightSurfaceContainerHigh, .text, 4.715),
        pair("contrast.tonalDark", "Tonal button, dark", DesignTokens.androidDarkOnSecondaryContainer, DesignTokens.androidDarkSecondaryContainer, .text, 10.006),
        pair("contrast.tonalLight", "Tonal button, light", DesignTokens.androidLightOnSecondaryContainer, DesignTokens.androidLightSecondaryContainer, .text, 13.963),
        pair("contrast.androidLight.onSurfaceVariant", "Android light onSurfaceVariant on surface", DesignTokens.androidLightOnSurfaceVariant, DesignTokens.androidLightSurface, .text, 7.730),
        pair("contrast.androidDark.onSurfaceVariant", "Android dark onSurfaceVariant on surface", DesignTokens.androidDarkOnSurfaceVariant, DesignTokens.androidDarkSurface, .text, 7.722),
        pair("contrast.androidDark.onSurfaceVariantRaised", "Android dark onSurfaceVariant on raised surface", DesignTokens.androidDarkOnSurfaceVariant, DesignTokens.neutralSurfaceRaised, .text, 6.109),
        pair("contrast.iosSecondaryText.white", "iOS secondary text on white", DesignTokens.iosAppTextSecondaryLight, DesignTokens.neutralWhite, .text, 5.988),
        pair("contrast.iosSecondaryText.groupedLight", "iOS secondary text on grouped background", DesignTokens.iosAppTextSecondaryLight, DesignTokens.iosAppLaunchBackgroundLight, .text, 5.366),
        // The fixed launch color. The iOS live row draws the system grouped background instead, which Increase
        // Contrast darkens (7.68 on iOS 27.1, accepted), so its value is not compared with this pair.
        pair("contrast.iosSecondaryTextHighContrast.groupedLight", "iOS secondary text, increased contrast, on grouped background", DesignTokens.iosAppTextSecondaryLightHighContrast, DesignTokens.iosAppLaunchBackgroundLight, .text, 8.177),
        pair("contrast.inCallSecondary.ink", "In-call secondary text on stage", DesignTokens.iosInCallTextSecondary, DesignTokens.iosInCallStage, .text, 10.420),
        pair("contrast.inCallSecondary.tile", "In-call secondary text on tile", DesignTokens.iosInCallTextSecondary, DesignTokens.iosInCallTile, .text, 9.985),
        pair("contrast.inCallTertiary.ink", "In-call tertiary text on stage", DesignTokens.iosInCallTextTertiary, DesignTokens.iosInCallStage, .text, 6.279),
        pair("contrast.inCallText.surfaceRaised", "In-call text on raised surface", DesignTokens.iosInCallText, DesignTokens.iosInCallSurfaceRaised, .text, 15.001),
        pair("contrast.inCallLabelScrim.white", "In-call label on scrim over white video", DesignTokens.paper, ContrastRatio.composite(DesignTokens.iosInCallLabelScrim, over: DesignTokens.neutralWhite), .text, 6.407),
        pair("contrast.inCallLabelScrimHighContrast.white", "In-call label on scrim over white video, increased contrast", DesignTokens.paper, ContrastRatio.composite(DesignTokens.iosInCallLabelScrimHighContrast, over: DesignTokens.neutralWhite), .text, 12.105),
        pair("contrast.toggleOff", "Call toggle off", DesignTokens.androidExtendedOnToggleOff, DesignTokens.androidExtendedToggleOffContainer, .text, 7.663),
        pair("contrast.toggleOn", "Call toggle on", DesignTokens.androidExtendedOnToggleOn, DesignTokens.androidExtendedToggleOnContainer, .text, 12.940),
        pair("contrast.toggleEngaged", "Call toggle engaged", DesignTokens.androidExtendedOnToggleEngaged, DesignTokens.androidExtendedToggleEngagedContainer, .text, 16.118),
        pair("contrast.iosControlOff", "iOS control off", DesignTokens.iosInCallOnControlOff, DesignTokens.iosInCallControlOff, .text, 18.960),
        pair("contrast.callEnd.white", "White on call end (glyph or large text only)", DesignTokens.androidExtendedOnCallEnd, DesignTokens.androidExtendedCallEnd, .largeText, 3.923),
        pair("contrast.androidLight.error", "Android light error on white", DesignTokens.androidLightError, DesignTokens.neutralWhite, .text, 6.461),
        pair("contrast.androidDark.error", "Android dark error on ink", DesignTokens.androidDarkError, DesignTokens.ink, .text, 11.656),
        pair("contrast.androidLight.errorContainer", "Android light onErrorContainer on errorContainer", DesignTokens.androidLightOnErrorContainer, DesignTokens.androidLightErrorContainer, .text, 7.239),
        pair("contrast.androidDark.errorContainer", "Android dark onErrorContainer on errorContainer", DesignTokens.androidDarkOnErrorContainer, DesignTokens.androidDarkErrorContainer, .text, 7.239),
        pair("contrast.successLight", "Success on white", DesignTokens.successLight, DesignTokens.neutralWhite, .text, 7.130),
        pair("contrast.successDark", "Success on ink", DesignTokens.successDark, DesignTokens.ink, .text, 8.685),
        pair("contrast.warningLight", "Warning on white", DesignTokens.warningLight, DesignTokens.neutralWhite, .text, 7.090),
        pair("contrast.warningDark", "Warning on ink", DesignTokens.warningDark, DesignTokens.ink, .text, 11.855),
        pair("contrast.liveLight", "Live on white", DesignTokens.liveLight, DesignTokens.neutralWhite, .text, 6.702),
        pair("contrast.liveDark", "Live on ink", DesignTokens.liveDark, DesignTokens.ink, .text, 7.784),
        pair("contrast.outline.white", "Outline on white", DesignTokens.androidLightOutline, DesignTokens.neutralWhite, .nonText, 4.833),
        pair("contrast.outline.ink", "Outline on ink", DesignTokens.androidDarkOutline, DesignTokens.ink, .nonText, 4.095),
        pair("contrast.coralFill.white", "Coral fill on white", DesignTokens.coral, DesignTokens.neutralWhite, .nonText, 3.105),
        pair("contrast.coralFill.ink", "Coral fill on ink", DesignTokens.coral, DesignTokens.ink, .nonText, 6.374),
        pair("contrast.inCallBorder.ink", "In-call border on stage", DesignTokens.iosInCallBorder, DesignTokens.iosInCallStage, .decorative, 1.419),
        pair("contrast.inCallBorderHighContrast.ink", "In-call border, increased contrast, on stage", DesignTokens.iosInCallBorderHighContrast, DesignTokens.iosInCallStage, .decorative, 2.742),
    ]

    private static func pair(_ id: String, _ caption: String, _ foreground: Int64, _ background: Int64,
                             _ requirement: ContrastRequirement, _ expected: Double) -> GalleryContrastPair {
        return GalleryContrastPair(id: id, caption: caption, foreground: foreground, background: background,
                                   requirement: requirement, expectedRatio: expected)
    }
}
