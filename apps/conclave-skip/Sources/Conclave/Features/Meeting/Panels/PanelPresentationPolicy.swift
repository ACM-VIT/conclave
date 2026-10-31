

enum PanelPlatform: String, Equatable {
    case iOS, android
}

enum PanelHostStyle: String, Equatable {
    case sheet, inspector, overlay, bottomSheet, sidePane
}

enum PanelDetent: String, Equatable {
    case short, medium, large
}

enum PanelAppearance: String, Equatable {
    case system, inCall
}

enum PanelStageCoverage: String, Equatable {
    case none, partial, full
}

struct PanelWindow: Equatable {
    let width: Double
    let height: Double
    let horizontalRegular: Bool
    let verticalRegular: Bool
}

struct PanelPresentation: Equatable {
    let style: PanelHostStyle

    let detents: [PanelDetent]

    let initialDetent: PanelDetent?
    let appearance: PanelAppearance

    let showsMiniTile: Bool

    let paneWidth: Double
    let hasBottomComposer: Bool
}

enum PanelPresentationPolicy {

    static let regularMinWidth = 840.0

    static let regularMinHeight = 480.0
    static let paneWidth = 360.0

    static let sideStylesEnabled = true

    static let androidAccessibilityFontScale = 1.5

    static let defaultShortDetentHeight = 222.0

    static let bottomSheetMaxWidth = 640.0

    static func androidWindow(width: Double, height: Double) -> PanelWindow {
        PanelWindow(width: width, height: height,
                    horizontalRegular: width >= PanelPresentationPolicy.regularMinWidth,
                    verticalRegular: height >= PanelPresentationPolicy.regularMinHeight)
    }

    static func androidIsAccessibilitySize(fontScale: Double) -> Bool {
        fontScale >= PanelPresentationPolicy.androidAccessibilityFontScale
    }

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

    static func usesAndroidBottomSheet(_ panel: MeetingPanel) -> Bool {
        panel == MeetingPanel.layout || panel == MeetingPanel.effects
    }

    static func bottomSheetSkipsPartialState(_ panel: MeetingPanel, isAccessibilitySize: Bool = false) -> Bool {
        if panel == MeetingPanel.effects { return true }
        return isAccessibilitySize
    }

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
            if request.panel == .activities && (isAccessibilitySize || window.height < 600) {
                detents = [.large]
                initialDetent = .large
            }
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

    static func sheetDetents(_ panel: MeetingPanel) -> [PanelDetent] {
        if PanelPresentationPolicy.hasBottomComposer(panel) {
            return [PanelDetent.large]
        }
        if panel == MeetingPanel.effects {
            return [PanelDetent.short, PanelDetent.large]
        }
        return [PanelDetent.medium, PanelDetent.large]
    }

    static func initialSheetDetent(_ panel: MeetingPanel, isAccessibilitySize: Bool = false) -> PanelDetent {
        switch panel {
        case .effects:
            return isAccessibilitySize ? PanelDetent.large : PanelDetent.short
        case .layout:
            return isAccessibilitySize ? PanelDetent.large : PanelDetent.medium
        case .activities:
            return isAccessibilitySize ? PanelDetent.large : PanelDetent.medium
        case .participants, .meetingInfo:
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

    static func appearance(_ panel: MeetingPanel, invoker: PanelInvoker) -> PanelAppearance {
        if panel == MeetingPanel.chat || panel == MeetingPanel.layout || panel == MeetingPanel.effects {
            return PanelAppearance.inCall
        }
        return PanelAppearance.system
    }

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

    static func keepsSheetInCompactHeight(_ presentation: PanelPresentation) -> Bool {
        presentation.style == PanelHostStyle.sheet
    }
}
