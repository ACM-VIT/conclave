#if os(iOS) && !SKIP
import SwiftUI

// S20 1 (STG-1): the native call root, always dark. One root `ZStack` is the only accessibility container: the canvas
// (renderers and the activity card in one layout), the solo invite layer, the reaction layer and the chrome layer are
// siblings, so a chrome change never invalidates a renderer. The root body reads no stage or chrome state itself (its
// evaluation count stays 1 across layout revisions); the panel hosts read the panel snapshot inside their own
// modifiers. Entry point for the native route behind the Debug `call` flag (the premeeting root mounts it; this file
// never reads the route flags) and for the stage fixture (SL14).

/// Where slot renderers come from: the fixture's counting probes (static or live test pattern) or the live WebRTC
/// surfaces (WP3 bridge, `StageLiveRenderers+iOS.swift`). Chosen once per root, so slots never change structure.
struct StageRendererProvider {
    let ledger: RendererIdentityLedger?
    let pattern: RendererProbePattern
    let usesProbes: Bool

    static func probes(ledger: RendererIdentityLedger, pattern: RendererProbePattern) -> StageRendererProvider {
        StageRendererProvider(ledger: ledger, pattern: pattern, usesProbes: true)
    }

    static let live = StageRendererProvider(ledger: nil, pattern: RendererProbePattern.none, usesProbes: false)
}

struct CallRoot: View {
    let shell: MeetingShellPresenter
    let stage: StagePresenter
    let renderers: StageRendererProvider
    /// Debug fixture override (SL14 `CONCLAVE_STAGE_FORCE_SCREEN_READER=1`).
    var forceScreenReader: Bool = false
    @State private var panelHost = NativePanelHostAdapter()
    /// View-local chrome visibility (SL8); the root holds the reference and never reads its properties.
    @State private var chromeVisibility = StageChromeVisibility()
    @State private var rootSize: CGSize = .zero
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var window: PanelWindow {
        PanelWindow(width: Double(rootSize.width), height: Double(rootSize.height),
                    horizontalRegular: horizontalSizeClass == .regular, verticalRegular: verticalSizeClass == .regular)
    }

    var body: some View {
        ZStack {
            StageCanvas(stage: stage, renderers: renderers, chrome: chromeVisibility)
                .accessibilitySortPriority(3)
            StageSoloLayer(stage: stage)
                .accessibilitySortPriority(3)
            ReactionBurstLayer(stage: stage)
            StageChromeLayer(shell: shell, stage: stage, chrome: chromeVisibility, forceScreenReader: forceScreenReader)
            StageVisibilityReporter(stage: stage, panels: shell.panels, adapter: panelHost, chrome: chromeVisibility,
                                    window: window)
        }
        .accessibilityElement(children: .contain)
        .background { HostingTheme.token(DesignTokens.iosInCallStage).ignoresSafeArea() }
        // The stage never pads for the keyboard; only activity cards and panels do (S20 1 m).
        .ignoresSafeArea(.keyboard)
        .environment(\.colorScheme, .dark)
        .conclaveCallAppearance()
        .onGeometryChange(for: CGSize.self) { proxy in proxy.size } action: { size in rootSize = size }
        .modifier(NativePanelInspectorHost(coordinator: shell.panels, adapter: panelHost, window: window) { presentation, resolved in
            CallPanelContent(shell: shell, adapter: panelHost, presentation: presentation, resolved: resolved)
        })
        .modifier(NativePanelSheetHost(coordinator: shell.panels, adapter: panelHost, window: window) { presentation, resolved in
            CallPanelContent(shell: shell, adapter: panelHost, presentation: presentation, resolved: resolved)
        })
        // The platform's call gesture: a two-finger double tap toggles the microphone (S20 1 i, iOS 14).
        .accessibilityAction(.magicTap) { shell.toggleMicrophone() }
        .accessibilityIdentifier("stage.root")
    }
}

/// Panel content inside the native call root. Content panels register here through requests as they land (CHT-1,
/// PPL-1, SET-1, ...); until then every panel opens its native shell with an empty body, which the fixture uses for
/// the open and close cells (S20 1 l5).
struct CallPanelContent: View {
    let shell: MeetingShellPresenter
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    @Environment(\.conclaveSystemColorScheme) private var systemScheme

    var body: some View {
        PanelShell(title: CallPanelTitles.title(presentation.request.panel), presentation: resolved, hostStyle: resolved.style,
                   systemScheme: systemScheme,
                   onClose: { shell.panels.dismiss(cancelPending: true) },
                   onPromoteToLarge: { adapter.promoteToLarge() }) {
            List {
                EmptyView()
            }
            .accessibilityIdentifier("call.panel." + presentation.request.panel.rawValue)
        }
    }
}

/// Panel titles on iOS (Apple title case, F00 11).
enum CallPanelTitles {
    static func title(_ panel: MeetingPanel) -> String {
        switch panel {
        case .chat: return ConclaveStrings.text("Chat")
        case .participants: return ConclaveStrings.text("Participants")
        case .transcript: return ConclaveStrings.text("Transcript")
        case .activities: return ConclaveStrings.text("Activities")
        case .effects: return ConclaveStrings.text("Effects")
        case .hostControls: return ConclaveStrings.text("Host Controls")
        case .settings: return ConclaveStrings.text("Settings")
        case .webinarQA: return ConclaveStrings.text("Q&A")
        case .meetingInfo: return ConclaveStrings.text("Meeting Details")
        case .layout: return ConclaveStrings.text("Layout")
        }
    }
}

/// SL15: computes what the stage shows from the laid-out frames, the panel coverage and the chrome state, and reports
/// it debounced by 150 ms (RR3). A zero-size leaf, so its reads never invalidate the canvas.
struct StageVisibilityReporter: View {
    let stage: StagePresenter
    let panels: PanelCoordinator
    let adapter: NativePanelHostAdapter
    let chrome: StageChromeVisibility
    let window: PanelWindow

    private var coverage: String {
        guard let current = panels.snapshot.current else { return StageVisibilityPolicy.coverageNone }
        let presentation = PanelPresentationPolicy.resolve(current, window: window, platform: PanelPlatform.iOS)
        return PanelPresentationPolicy.coverage(presentation, detent: adapter.detent).rawValue
    }

    var body: some View {
        let layout = stage.layout
        let viewport = stage.viewport
        let frames = StageLayoutPolicy.frames(viewport: viewport, kind: layout.kind, slots: layout.slots, selfCorner: layout.selfCorner)
        let report = StageVisibilityPolicy.report(frames: frames, slots: layout.slots, viewport: viewport, kind: layout.kind,
                                                  coverage: coverage, chromeHidden: chrome.state.isHidden, isInPip: false,
                                                  pipTarget: nil)
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .task(id: report) {
                try? await Task.sleep(for: .milliseconds(Int(StageVisibilityPolicy.debounceMillis)))
                if Task.isCancelled { return }
                stage.reportVisibility(report)
            }
    }
}
#endif
