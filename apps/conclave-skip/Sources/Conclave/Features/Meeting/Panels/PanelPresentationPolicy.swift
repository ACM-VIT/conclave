/// Which native container hosts a panel (PS 6.2). Shared and transpiled: String raw values so Kotlin
/// readouts can print them, scalar structs, arrays of enums, no associated values.
enum PanelPlatform: String, Equatable {
    case iOS, android
}

enum PanelHostStyle: String, Equatable {
    case sheet, inspector, overlay, bottomSheet, sidePane
}

enum PanelDetent: String, Equatable {
    case medium, large
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
    /// WP1-3b1 default for the parameter below (plan amendment A2); WP1-3b2 flips it to true. Tests pass the
    /// parameter explicitly, so both branches stay covered after the flip.
    static let sideStylesEnabled = false

    /// An Android window measured by the host's own constraints, in dp.
    static func androidWindow(width: Double, height: Double) -> PanelWindow {
        PanelWindow(width: width, height: height,
                    horizontalRegular: width >= PanelPresentationPolicy.regularMinWidth,
                    verticalRegular: height >= PanelPresentationPolicy.regularMinHeight)
    }

    /// Side styles only on regular x regular windows; otherwise the iOS sheet or the Android full overlay. The
    /// Android bottom sheet for Layout and Effects waits for WP1-3c (deferred to WP6), so `panel` does not
    /// change the result yet.
    static func style(window: PanelWindow, platform: PanelPlatform, panel: MeetingPanel,
                      sideStylesEnabled: Bool = PanelPresentationPolicy.sideStylesEnabled) -> PanelHostStyle {
        if sideStylesEnabled && window.horizontalRegular && window.verticalRegular {
            return platform == PanelPlatform.iOS ? PanelHostStyle.inspector : PanelHostStyle.sidePane
        }
        return platform == PanelPlatform.iOS ? PanelHostStyle.sheet : PanelHostStyle.overlay
    }

    static func resolve(_ request: PanelRequest, window: PanelWindow, platform: PanelPlatform,
                        sideStylesEnabled: Bool = PanelPresentationPolicy.sideStylesEnabled) -> PanelPresentation {
        let hostStyle = PanelPresentationPolicy.style(window: window, platform: platform, panel: request.panel,
                                                      sideStylesEnabled: sideStylesEnabled)
        let isSheet = hostStyle == PanelHostStyle.sheet
        let isPane = hostStyle == PanelHostStyle.inspector || hostStyle == PanelHostStyle.sidePane
        var detents: [PanelDetent] = []
        var initialDetent: PanelDetent? = nil
        if isSheet {
            detents = PanelPresentationPolicy.sheetDetents(request.panel)
            initialDetent = PanelPresentationPolicy.initialSheetDetent(request.panel)
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

    /// Composer panels are large-only, so the keyboard never meets a medium sheet (Q8.4).
    static func sheetDetents(_ panel: MeetingPanel) -> [PanelDetent] {
        if PanelPresentationPolicy.hasBottomComposer(panel) {
            return [PanelDetent.large]
        }
        return [PanelDetent.medium, PanelDetent.large]
    }

    /// Medium keeps the stage visible where the user watches its effect; settings and host controls open at
    /// today's large geometry, which the accepted L2 cells measured.
    static func initialSheetDetent(_ panel: MeetingPanel) -> PanelDetent {
        switch panel {
        case .participants, .activities, .effects, .meetingInfo, .layout:
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

    /// Invoker-scoped: Layout and Effects opened from the call take the dark in-call appearance (R07, owner
    /// default Q8.6); from More or Settings, and every content panel, they follow the system appearance.
    static func appearance(_ panel: MeetingPanel, invoker: PanelInvoker) -> PanelAppearance {
        if invoker == PanelInvoker.call && (panel == MeetingPanel.layout || panel == MeetingPanel.effects) {
            return PanelAppearance.inCall
        }
        return PanelAppearance.system
    }

    /// How much of the stage a shown panel covers. A sheet at medium is partial and at large full; a nil
    /// detent reads as the presentation's initial detent.
    static func coverage(_ presentation: PanelPresentation, detent: PanelDetent?) -> PanelStageCoverage {
        switch presentation.style {
        case .sheet:
            let selected = detent ?? presentation.initialDetent
            if selected == PanelDetent.medium && presentation.detents.contains(PanelDetent.medium) {
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

    /// Owner default Q8.1: a sheet that can sit at medium keeps the stage interactive up through medium. Text
    /// focus promotion (PS 7.3) lives in one place, `NativePanelHostAdapter.promoteToLarge()`.
    static func stageInteractiveUpThroughMedium(_ presentation: PanelPresentation) -> Bool {
        presentation.style == PanelHostStyle.sheet && presentation.detents.contains(PanelDetent.medium)
    }
}
