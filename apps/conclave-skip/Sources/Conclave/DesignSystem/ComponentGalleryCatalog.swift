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

/// Collapsible sections of the component gallery. Each builds its rows only while it is expanded. WP1-2b
/// appends the component sections after the WP1-2a ones, so the earlier identifiers keep their order.
enum GallerySection: String, CaseIterable {
    case typography, haptics, contrast, systemProminent
    case buttons, callControls, rows, banners, status

    /// iOS 26 system-prominent chrome has no Android counterpart; Android draws Material 3 roles.
    var isIOSOnly: Bool { self == .systemProminent }

    /// Call controls exist only in a call (F00 C04 l1, C05), so they draw in the In call column alone; every
    /// other component section draws in both columns.
    var isInCallOnly: Bool { self == .callControls }
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

    // MARK: WP1-2b components (F00 13 index; PN 3.5; TG 4.2)

    /// "Show loading" (default off, never saved): the only way a spinner specimen appears (TG 4.1).
    static let showLoadingToggleID = "components.showLoading"
    /// iOS only: the Debug "Force Opaque Controls" switch for the R02 fallback (PN 3.5 A1).
    static let forceOpaqueToggleID = "components.forceOpaque"
    /// What the call control specimens' gesture route recorded. Leave, Chat and More never change it.
    static let controlRecordID = "components.controls.record"

    static let buttonPrimaryID = "button.primary"
    static let buttonTonalID = "button.tonal"
    static let buttonTextID = "button.text"
    static let buttonDestructiveID = "button.destructive"
    /// The pending primary button, a spinner specimen.
    static let buttonPendingID = "button.primary.pending"
    static let toggleCallID = "toggle.call"
    static let leaveID = "button.leave"
    /// The Chat control's count badge (OQ-2b-7); FND-2 extracts the standalone C06 badge later.
    static let badgeCountID = "badge.count"
    static let compactBarID = "control.bar.compact"
    /// The full-bleed bar probe: an iOS pushed page, an Android item that cancels the list padding.
    static let compactBarProbeID = "control.bar.compact.probe"
    /// "Bar W pt of A pt" (iOS) and "Bar W dp of A dp" (Android), machine-read.
    static let compactBarReadoutID = "control.bar.compact.readout"
    /// Which control the overflow decision moved off the bar, if any.
    static let compactBarMovedID = "control.bar.compact.moved"
    static let rowValueID = "row.value"
    static let rowNavigationID = "row.navigation"
    static let rowDestructiveID = "row.destructive"
    static let rowSelectableID = "row.selectable"
    static let toggleRowID = "toggle.row"
    static let rowPersonID = "row.person"
    /// The C10 waiting variant with Deny and Admit.
    static let rowPersonWaitingID = "row.person.waiting"
    static let bannerInfoID = "banner.info"
    static let bannerWarningID = "banner.warning"
    static let bannerErrorID = "banner.error"
    static let bannerSuccessID = "banner.success"
    /// The reconnecting banner carries a system spinner, so it is a spinner specimen.
    static let bannerReconnectingID = "banner.reconnecting"
    /// The animated banner (R5): it draws the banner.info component and text and is never counted.
    static let bannerMotionID = "banner.motion"
    static let bannerMotionToggleID = "banner.motion.toggle"
    /// iOS only: the announcement a production banner would post, which the silent gallery suppresses.
    static let bannerAnnouncementID = "banner.motion.announcement"
    static let statusLoadingID = "status.loading"
    static let statusErrorID = "status.error"
    static let statusEmptyID = "status.empty"
    static let statusOfflineID = "status.offline"

    /// The stated move order of the compact bar specimen (OQ-2b-3): Share Screen moves to More first, which
    /// leaves F00's phone five. The product order is CTL-1's ControlBarPolicy, not this list.
    static let compactBarMicrophone = "microphone"
    static let compactBarCamera = "camera"
    static let compactBarShareScreen = "shareScreen"
    static let compactBarChat = "chat"
    static let compactBarMore = "more"
    /// The legacy compact set before Leave (ControlsBarView.swift:241-300), in reading order.
    static let compactBarControls: [String] = [
        compactBarMicrophone, compactBarCamera, compactBarShareScreen, compactBarChat, compactBarMore,
    ]
    static let compactBarMoveOrder: [String] = [compactBarShareScreen]

    /// A sample room code for the value row; data, not copy.
    static let sampleRoomCode = "abc-defg-hij"

    /// Base specimen IDs of one section in drawing order. Spinner specimens are listed only while Show loading
    /// is on, so they are neither drawn nor counted otherwise (TG 4.1).
    static func specimenIDs(_ section: GallerySection, showLoading: Bool) -> [String] {
        var ids: [String] = []
        switch section {
        case .buttons:
            ids.append(buttonPrimaryID)
            ids.append(buttonTonalID)
            ids.append(buttonTextID)
            ids.append(buttonDestructiveID)
            if showLoading { ids.append(buttonPendingID) }
        case .callControls:
            ids.append(toggleCallID)
            ids.append(leaveID)
            ids.append(badgeCountID)
            ids.append(compactBarID)
        case .rows:
            ids.append(rowValueID)
            ids.append(rowNavigationID)
            ids.append(rowDestructiveID)
            ids.append(rowSelectableID)
            ids.append(toggleRowID)
            ids.append(rowPersonID)
            ids.append(rowPersonWaitingID)
        case .banners:
            ids.append(bannerInfoID)
            ids.append(bannerWarningID)
            ids.append(bannerErrorID)
            ids.append(bannerSuccessID)
            if showLoading { ids.append(bannerReconnectingID) }
        case .status:
            if showLoading { ids.append(statusLoadingID) }
            ids.append(statusErrorID)
            ids.append(statusEmptyID)
            ids.append(statusOfflineID)
        case .typography, .haptics, .contrast, .systemProminent:
            break
        }
        return ids
    }

    /// Every measured component specimen, as drawn: In call only for the call controls, both columns for the
    /// rest (TG 4.1 asks for both columns everywhere; the call controls are the recorded exception).
    static func componentSpecimenIDs(showLoading: Bool) -> [String] {
        var ids: [String] = []
        for section in [GallerySection.buttons, GallerySection.callControls, GallerySection.rows,
                        GallerySection.banners, GallerySection.status] {
            for inCall in [false, true] {
                if section.isInCallOnly && !inCall { continue }
                for id in specimenIDs(section, showLoading: showLoading) {
                    ids.append(columnID(id, inCall: inCall))
                }
            }
        }
        return ids
    }

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
        // WP1-2b banner and status text on their surfaces (F00 C12 i). System colors (the Leave red, system
        // grouped backgrounds) are resolved live only.
        pair("contrast.inCallWarning.surfaceRaised", "Warning on raised in-call surface", DesignTokens.iosInCallWarning, DesignTokens.iosInCallSurfaceRaised, .text, 9.380),
        pair("contrast.inCallSuccess.surfaceRaised", "Success on raised in-call surface", DesignTokens.iosInCallSuccess, DesignTokens.iosInCallSurfaceRaised, .text, 6.872),
        pair("contrast.inCallLive.surfaceRaised", "Live on raised in-call surface", DesignTokens.iosInCallLive, DesignTokens.iosInCallSurfaceRaised, .text, 6.159),
        pair("contrast.androidDark.errorSurfaceHigh", "Android dark error on surfaceContainerHigh", DesignTokens.androidDarkError, DesignTokens.androidDarkSurfaceContainerHigh, .text, 9.222),
        pair("contrast.warningLight.groupedLight", "Warning on grouped background", DesignTokens.warningLight, DesignTokens.iosAppLaunchBackgroundLight, .text, 6.354),
    ]

    private static func pair(_ id: String, _ caption: String, _ foreground: Int64, _ background: Int64,
                             _ requirement: ContrastRequirement, _ expected: Double) -> GalleryContrastPair {
        return GalleryContrastPair(id: id, caption: caption, foreground: foreground, background: background,
                                   requirement: requirement, expectedRatio: expected)
    }
}

// MARK: Compact control fit (PN 3.5 A1, TG 4.3, F00 C05)

/// One control of a stated bar composition: an ASCII identifier and its target width (pt on iOS, dp on Android).
struct CompactBarControl: Equatable {
    let id: String
    let width: Double
}

/// The result of fitting a stated composition into an available width.
struct CompactBarPlan: Equatable {
    /// The Android toggle width or the iOS circle diameter.
    let targetWidth: Double
    let spacing: Double
    /// Controls the overflow decision moved to More, in the stated move order.
    let moved: [String]
    let requiredWidth: Double
    let fits: Bool
}

/// Pure arithmetic on stated inputs: no constant here is an expected total. The recovered 321 dp reference is a
/// runtime readout target only (TG 4.3), never a unit-test constant. Targets are real controls (each at least
/// 44 pt or 48 dp); non-target items such as the Android 1 dp divider count as one more spaced item and are
/// never checked against the target minimum. The trailing `nonTargets` parameter defaults to none, so A1's call
/// shape stays valid.
enum CompactBarFit {
    static let iosMinimumTarget = 44.0
    static let iosBaseDiameter = 52.0
    static let iosMaximumDiameter = 60.0
    /// Horizontal inset on each side of the iOS bar (F00 C05 c, `space12`).
    static let iosPadding = DesignTokens.space12
    static let androidMinimumTarget = 48.0
    /// 56 dp toggles from 385 dp available width, else 48 dp (F00 C05 d).
    static let androidWideToggleWidth = 56.0
    static let androidWideToggleThreshold = 385.0
    static let androidLeaveWidth = 72.0
    static let androidDividerWidth = 1.0
    static let androidPadding = DesignTokens.space8
    static let androidSpacing = DesignTokens.space8
    /// Leave is a target that never moves to More.
    static let leaveControlID = "leave"

    static func requiredWidth(targets: [Double], spacing: Double, padding: Double, nonTargets: [Double] = []) -> Double {
        var content = 0.0
        for width in targets { content += width }
        for width in nonTargets { content += width }
        let items = targets.count + nonTargets.count
        let gaps = items > 1 ? Double(items - 1) * spacing : 0.0
        return padding * 2.0 + content + gaps
    }

    static func fits(targets: [Double], spacing: Double, padding: Double, available: Double, nonTargets: [Double] = []) -> Bool {
        return requiredWidth(targets: targets, spacing: spacing, padding: padding, nonTargets: nonTargets) <= available
    }

    /// Which controls move to More, in `moveOrder`, until the rest fits. Controls not named in the order never
    /// move; the result may still not fit when the order runs out (the caller reads `fits` again).
    static func overflow(controls: [CompactBarControl], moveOrder: [String], spacing: Double, padding: Double,
                         available: Double, nonTargets: [Double] = []) -> [String] {
        var remaining = controls
        var moved: [String] = []
        while !fits(targets: widths(remaining), spacing: spacing, padding: padding, available: available, nonTargets: nonTargets) {
            guard let next = nextToMove(moveOrder, among: ids(remaining)) else { break }
            moved.append(next)
            remaining = remaining.filter { $0.id != next }
        }
        return moved
    }

    static func androidToggleWidth(available: Double) -> Double {
        return available >= androidWideToggleThreshold ? androidWideToggleWidth : androidMinimumTarget
    }

    /// F00 C05 c: the scaled base diameter, no wider than an equal share of the row, clamped to [44, 60].
    static func iosDiameter(scaled: Double, count: Int, spacing: Double, available: Double) -> Double {
        var diameter = scaled
        if count > 0 {
            let share = (available - 2.0 * iosPadding - Double(count - 1) * spacing) / Double(count)
            // Whole points; a share that is negative or tiny clamps to the minimum below.
            let whole = share > 0.0 ? Double(Int(share)) : 0.0
            if whole < diameter { diameter = whole }
        }
        if diameter > iosMaximumDiameter { diameter = iosMaximumDiameter }
        if diameter < iosMinimumTarget { diameter = iosMinimumTarget }
        return diameter
    }

    /// iOS fit order (F00 C05 c, C04 c): every control, Leave included, is one circle of the same diameter;
    /// try `space12`, then `space8`, then move controls to More in the stated order and try again.
    static func iosPlan(controlIDs: [String], moveOrder: [String], scaledDiameter: Double, available: Double) -> CompactBarPlan {
        var remaining = controlIDs
        var moved: [String] = []
        var attempt = 0
        while attempt <= controlIDs.count {
            attempt += 1
            for spacing in [DesignTokens.space12, DesignTokens.space8] {
                let diameter = iosDiameter(scaled: scaledDiameter, count: remaining.count, spacing: spacing, available: available)
                let required = requiredWidth(targets: repeated(diameter, remaining.count), spacing: spacing, padding: iosPadding)
                if required <= available {
                    return CompactBarPlan(targetWidth: diameter, spacing: spacing, moved: moved, requiredWidth: required, fits: true)
                }
            }
            guard let next = nextToMove(moveOrder, among: remaining) else { break }
            moved.append(next)
            remaining = remaining.filter { $0 != next }
        }
        let diameter = iosDiameter(scaled: scaledDiameter, count: remaining.count, spacing: DesignTokens.space8, available: available)
        let required = requiredWidth(targets: repeated(diameter, remaining.count), spacing: DesignTokens.space8, padding: iosPadding)
        return CompactBarPlan(targetWidth: diameter, spacing: DesignTokens.space8, moved: moved, requiredWidth: required, fits: false)
    }

    /// Android fit order (F00 C05 d, OQ-2b-6): toggles at the width the threshold picks, a 72 dp Leave that never
    /// moves, the 1 dp divider (no padding of its own) as a non-target item, 8 dp padding and spacing; then the
    /// overflow move.
    static func androidPlan(toggleIDs: [String], moveOrder: [String], available: Double) -> CompactBarPlan {
        let width = androidToggleWidth(available: available)
        var controls: [CompactBarControl] = []
        for id in toggleIDs { controls.append(CompactBarControl(id: id, width: width)) }
        controls.append(CompactBarControl(id: leaveControlID, width: androidLeaveWidth))
        let divider = [androidDividerWidth]
        let moved = overflow(controls: controls, moveOrder: moveOrder, spacing: androidSpacing, padding: androidPadding,
                             available: available, nonTargets: divider)
        var targets: [Double] = []
        for control in controls {
            if !moved.contains(control.id) { targets.append(control.width) }
        }
        let required = requiredWidth(targets: targets, spacing: androidSpacing, padding: androidPadding, nonTargets: divider)
        return CompactBarPlan(targetWidth: width, spacing: androidSpacing, moved: moved, requiredWidth: required, fits: required <= available)
    }

    private static func widths(_ controls: [CompactBarControl]) -> [Double] {
        var result: [Double] = []
        for control in controls { result.append(control.width) }
        return result
    }

    private static func ids(_ controls: [CompactBarControl]) -> [String] {
        var result: [String] = []
        for control in controls { result.append(control.id) }
        return result
    }

    private static func repeated(_ value: Double, _ count: Int) -> [Double] {
        var result: [Double] = []
        var index = 0
        while index < count {
            result.append(value)
            index += 1
        }
        return result
    }

    private static func nextToMove(_ moveOrder: [String], among ids: [String]) -> String? {
        for id in moveOrder {
            if ids.contains(id) { return id }
        }
        return nil
    }
}
