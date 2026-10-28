/// Which native container hosts a panel (PS 6.2). Shared and transpiled: String raw values so Kotlin
/// readouts can print them, scalar structs, arrays of enums, no associated values.
enum PanelPlatform: String, Equatable {
    case iOS, android
}

enum PanelHostStyle: String, Equatable {
    case sheet, inspector, overlay, bottomSheet, sidePane
}

/// `short` is a content-measured height (RECONCILE R9, S60 R6-10): the iOS host maps it to `.height(shortHeight)`
/// with the height the content reports, so Effects keeps the self video visible while choosing.
enum PanelDetent: String, Equatable {
    case short, medium, large
}

enum PanelAppearance: String, Equatable {
    case system, inCall
}

enum PanelStageCoverage: String, Equatable {
    case none, partial, full
}

/// Logical points on iOS, dp on Android. Regularity is platform-derived: size classes on iOS, the Material
/// window-class thresholds below on Android (`androidWindow`).
struct PanelWindow: Equatable {
    let width: Double
    let height: Double
    let horizontalRegular: Bool
    let verticalRegular: Bool
}

struct PanelPresentation: Equatable {
    let style: PanelHostStyle
    /// iOS `.sheet` only; empty for every other style.
    let detents: [PanelDetent]
    /// nil unless `.sheet`.
    let initialDetent: PanelDetent?
    let appearance: PanelAppearance
    /// true only for the Android `.overlay`, which covers the stage.
    let showsMiniTile: Bool
    /// 0 unless `.inspector` or `.sidePane`.
    let paneWidth: Double
    let hasBottomComposer: Bool
}

/// Pure presentation policy. Style is a function of window class and platform only, so phone rotation never
/// migrates style, and host state never decides it.
enum PanelPresentationPolicy {
    /// Android expanded width class.
    static let regularMinWidth = 840.0
    /// Android non-compact height class.
    static let regularMinHeight = 480.0
    static let paneWidth = 360.0
    /// The default for the parameter below (plan amendment A2). WP1-3b2 turned side styles on: an iPad or an
    /// expanded Android window shows the inspector or the side pane. Tests pass the parameter explicitly, so both
    /// branches stay covered.
    static let sideStylesEnabled = true
    /// Android reads accessibility text sizes from the font scale (S60 R6-10); iOS reads
    /// `dynamicTypeSize.isAccessibilitySize`.
    static let androidAccessibilityFontScale = 1.5
    /// The short detent's height until the content reports its own (S60 4 c: Effects measures 222 pt at the
    /// default text size).
    static let defaultShortDetentHeight = 222.0
    /// WP1-3c (SET-5, S60 3 b, 4 b): the Android Layout and Effects bottom sheet never grows wider than 640 dp, so a
    /// 600 to 839 dp window (tablet portrait, unfolded foldable) keeps the stage visible at both sides of it.
    static let bottomSheetMaxWidth = 640.0

    /// An Android window measured by the host's own constraints, in dp.
    static func androidWindow(width: Double, height: Double) -> PanelWindow {
        PanelWindow(width: width, height: height,
                    horizontalRegular: width >= PanelPresentationPolicy.regularMinWidth,
                    verticalRegular: height >= PanelPresentationPolicy.regularMinHeight)
    }

    /// The Android accessibility-size input of `resolve` (font scale 1.5 and up).
    static func androidIsAccessibilitySize(fontScale: Double) -> Bool {
        fontScale >= PanelPresentationPolicy.androidAccessibilityFontScale
    }

    /// Side styles only on regular x regular windows (owner default Q8 2); otherwise the iOS sheet, and on Android the
    /// WP1-3c bottom sheet for Layout and Effects (SET-5 absorbs WP1-3c: PLAN-next 3.7, PS 8.6, S60 3 d, 4 d) or the
    /// full overlay for every content panel. Compact and medium Android windows therefore show Layout and Effects
    /// as a partial `ModalBottomSheet` over the live stage; the expanded side pane keeps them beside it.
    static func style(window: PanelWindow, platform: PanelPlatform, panel: MeetingPanel,
                      sideStylesEnabled: Bool = PanelPresentationPolicy.sideStylesEnabled) -> PanelHostStyle {
        if sideStylesEnabled && window.horizontalRegular && window.verticalRegular {
            return platform == PanelPlatform.iOS ? PanelHostStyle.inspector : PanelHostStyle.sidePane
        }
        if platform == PanelPlatform.iOS {
            return PanelHostStyle.sheet
        }
        return PanelPresentationPolicy.usesAndroidBottomSheet(panel) ? PanelHostStyle.bottomSheet : PanelHostStyle.overlay
    }

    /// The panels the Android bottom sheet hosts outside the side pane (PS 8.6): Layout and Effects, the two in-call
    /// panels whose effect is watched on the stage. Content panels keep the full overlay (owner default Q8 3).
    static func usesAndroidBottomSheet(_ panel: MeetingPanel) -> Bool {
        panel == MeetingPanel.layout || panel == MeetingPanel.effects
    }

    /// Whether the Android bottom sheet skips its partially expanded state (S60 3 d, 4 d; RECONCILE R9): Effects
    /// opens expanded at its content height (`skipPartiallyExpanded = true`, it carries its own preview), Layout opens
    /// partially expanded with the live controls first, and both open expanded at accessibility text sizes
    /// (`isAccessibilitySize`, font scale 1.5 and up), where the partial state would hold almost nothing.
    static func bottomSheetSkipsPartialState(_ panel: MeetingPanel, isAccessibilitySize: Bool = false) -> Bool {
        if panel == MeetingPanel.effects { return true }
        return isAccessibilitySize
    }

    /// `isAccessibilitySize` is a policy input because the shared policy cannot see view-level scaled metrics: at
    /// accessibility text sizes Layout and Effects open large (RECONCILE R9, S60 R6-10).
    static func resolve(_ request: PanelRequest, window: PanelWindow, platform: PanelPlatform,
                        isAccessibilitySize: Bool = false,
                        sideStylesEnabled: Bool = PanelPresentationPolicy.sideStylesEnabled) -> PanelPresentation {
        let hostStyle = PanelPresentationPolicy.style(window: window, platform: platform, panel: request.panel,
                                                      sideStylesEnabled: sideStylesEnabled)
        let isSheet = hostStyle == PanelHostStyle.sheet
        let isPane = hostStyle == PanelHostStyle.inspector || hostStyle == PanelHostStyle.sidePane
        var detents: [PanelDetent] = []
        var initialDetent: PanelDetent? = nil
        if isSheet {
            detents = PanelPresentationPolicy.sheetDetents(request.panel)
            initialDetent = PanelPresentationPolicy.initialSheetDetent(request.panel, isAccessibilitySize: isAccessibilitySize)
        }
        return PanelPresentation(
            style: hostStyle,
            detents: detents,
            initialDetent: initialDetent,
            appearance: PanelPresentationPolicy.appearance(request.panel, invoker: request.invoker),
            showsMiniTile: hostStyle == PanelHostStyle.overlay,
            paneWidth: isPane ? PanelPresentationPolicy.paneWidth : 0.0,
            hasBottomComposer: PanelPresentationPolicy.hasBottomComposer(request.panel)
        )
    }

    /// Composer panels are large-only, so the keyboard never meets a medium sheet (Q8.4). Effects sits at a short,
    /// content-measured detent below large (R9).
    static func sheetDetents(_ panel: MeetingPanel) -> [PanelDetent] {
        if PanelPresentationPolicy.hasBottomComposer(panel) {
            return [PanelDetent.large]
        }
        if panel == MeetingPanel.effects {
            return [PanelDetent.short, PanelDetent.large]
        }
        return [PanelDetent.medium, PanelDetent.large]
    }

    /// Medium keeps the stage visible where the user watches its effect; settings and host controls open at
    /// today's large geometry, which the accepted L2 cells measured. Effects opens short and Layout medium, and
    /// both open large at accessibility text sizes (R9).
    static func initialSheetDetent(_ panel: MeetingPanel, isAccessibilitySize: Bool = false) -> PanelDetent {
        switch panel {
        case .effects:
            return isAccessibilitySize ? PanelDetent.large : PanelDetent.short
        case .layout:
            return isAccessibilitySize ? PanelDetent.large : PanelDetent.medium
        case .participants, .activities, .meetingInfo:
            return PanelDetent.medium
        case .chat, .transcript, .webinarQA, .hostControls, .settings:
            return PanelDetent.large
        }
    }

    static func hasBottomComposer(_ panel: MeetingPanel) -> Bool {
        switch panel {
        case .chat, .transcript, .webinarQA:
            return true
        case .participants, .activities, .effects, .hostControls, .settings, .meetingInfo, .layout:
            return false
        }
    }

    /// Layout and Effects take the dark in-call appearance for every invoker (owner default Q8.6, S60 R6-10,
    /// RECONCILE R9); every content panel follows the system appearance. The invoker stays a parameter so the
    /// call sites keep one shape.
    static func appearance(_ panel: MeetingPanel, invoker: PanelInvoker) -> PanelAppearance {
        if panel == MeetingPanel.layout || panel == MeetingPanel.effects {
            return PanelAppearance.inCall
        }
        return PanelAppearance.system
    }

    /// How much of the stage a shown panel covers. A sheet at short or medium is partial and at large full; a nil
    /// detent reads as the presentation's initial detent. The Android bottom sheet is partial (PS 6.2): it never
    /// hides the stage from accessibility, and the call root suspends the toast lane under it (RECONCILE R3).
    static func coverage(_ presentation: PanelPresentation, detent: PanelDetent?) -> PanelStageCoverage {
        switch presentation.style {
        case .sheet:
            let selected = detent ?? presentation.initialDetent ?? PanelDetent.large
            if selected != PanelDetent.large && presentation.detents.contains(selected) {
                return PanelStageCoverage.partial
            }
            return PanelStageCoverage.full
        case .inspector, .sidePane:
            return PanelStageCoverage.none
        case .overlay:
            return PanelStageCoverage.full
        case .bottomSheet:
            return PanelStageCoverage.partial
        }
    }

    /// The detent up through which the stage stays interactive behind a sheet (owner default Q8.1, R9): medium
    /// for the medium panels, short for Effects, nil for a large-only sheet and every other style. Text focus
    /// promotion (PS 7.3) lives in one place, `NativePanelHostAdapter.promoteToLarge()`.
    static func stageInteractiveDetent(_ presentation: PanelPresentation) -> PanelDetent? {
        guard presentation.style == PanelHostStyle.sheet else { return nil }
        if presentation.detents.contains(PanelDetent.short) {
            return PanelDetent.short
        }
        if presentation.detents.contains(PanelDetent.medium) {
            return PanelDetent.medium
        }
        return nil
    }

    /// One compact-height rule for every in-call panel (RECONCILE R10): in compact height (iPhone landscape) an iOS
    /// sheet stays a sheet, `.presentationCompactAdaptation(horizontal: .automatic, vertical: .sheet)`, instead of
    /// the system's full-screen adaptation, which risks the same stage renderer detach as `.fullScreenCover`.
    static func keepsSheetInCompactHeight(_ presentation: PanelPresentation) -> Bool {
        presentation.style == PanelHostStyle.sheet
    }
}
