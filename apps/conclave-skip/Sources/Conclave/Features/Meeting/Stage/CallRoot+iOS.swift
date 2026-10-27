#if os(iOS) && !SKIP
import SwiftUI

// S20 1 (STG-1): the native call root, always dark. One root `ZStack` is the only accessibility container: the canvas
// (renderers and the activity card in one layout), the solo invite layer, the reaction layer, the chrome layer and the
// STG-5 notice lanes are siblings, so a chrome or notice change never invalidates a renderer. The root body reads no stage or chrome state itself (its
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
    /// S50 0.5: the session's People presenter; nil keeps the empty native shell for Participants (STG-1 fixtures).
    var people: PeoplePresenter? = nil
    let renderers: StageRendererProvider
    /// Debug fixture override (SL14 `CONCLAVE_STAGE_FORCE_SCREEN_READER=1`).
    var forceScreenReader: Bool = false
    /// S60 (ACT-1, ACT-2, STG-9): the activity presenters for the card and the Activities panel; nil in fixtures without them.
    var activitySession: ActivitySession? = nil
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
            // STG-7 (S20 13 j): the one stable PiP anchor; it takes no touches and is hidden from accessibility.
            StagePipAnchor(stage: stage)
            StageSoloLayer(stage: stage)
                .accessibilitySortPriority(3)
            ReactionBurstLayer(stage: stage)
            StageChromeLayer(shell: shell, stage: stage, chrome: chromeVisibility, forceScreenReader: forceScreenReader)
            // STG-5: banner, captions and toast lanes over the chrome (they never move tiles or follow chrome); the
            // notice sound output is installed only on the live route, never with the fixture's probes.
            NoticeLanesLayer(stage: stage, forceScreenReader: forceScreenReader, installsSound: !renderers.usesProbes)
            NoticeLaneSuspensionReporter(stage: stage, panels: shell.panels, window: window)
            StageVisibilityReporter(stage: stage, panels: shell.panels, adapter: panelHost, chrome: chromeVisibility,
                                    window: window)
        }
        .accessibilityElement(children: .contain)
        // STG-7 (S20 SC11): the renderers report decoded frame sizes into the stage's store.
        .environment(\.rendererFrameSizes, stage.frameSizes)
        // STG-9: the activity card and the Activities panel read the session from the environment.
        .environment(\.activitySession, activitySession)
        .background { HostingTheme.token(DesignTokens.iosInCallStage).ignoresSafeArea() }
        // The stage never pads for the keyboard; only activity cards and panels do (S20 1 m).
        .ignoresSafeArea(.keyboard)
        .environment(\.colorScheme, .dark)
        .conclaveCallAppearance()
        .onGeometryChange(for: CGSize.self) { proxy in proxy.size } action: { size in rootSize = size }
        .modifier(NativePanelInspectorHost(coordinator: shell.panels, adapter: panelHost, window: window) { presentation, resolved in
            CallPanelContent(shell: shell, people: people, adapter: panelHost, presentation: presentation, resolved: resolved,
                             activitySession: activitySession)
        })
        .modifier(NativePanelSheetHost(coordinator: shell.panels, adapter: panelHost, window: window) { presentation, resolved in
            CallPanelContent(shell: shell, people: people, adapter: panelHost, presentation: presentation, resolved: resolved,
                             activitySession: activitySession)
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
    let people: PeoplePresenter?
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    var activitySession: ActivitySession? = nil
    @Environment(\.conclaveSystemColorScheme) private var systemScheme

    var body: some View {
        if presentation.request.panel == .chat {
            // CHT-1 (S40 1, R40-9): the chat host owns its PanelShell with the chat's own path.
            ChatPanelHost(chat: shell.chat, panels: shell.panels, presentation: presentation, resolved: resolved,
                          onPromoteToLarge: { adapter.promoteToLarge() })
        } else if presentation.request.panel == .participants, let people {
            // PPL-1 (S50 1): the native Participants panel with its own PanelShell and R50-2 path binding.
            ParticipantsPanel(people: people, shell: shell, adapter: adapter, presentation: presentation, resolved: resolved)
        } else if presentation.request.panel == .activities, let activitySession {
            // ACT-1 (S60 7): the Activities launcher with its own PanelShell and page path.
            ActivitiesPanel(session: activitySession, adapter: adapter, presentation: presentation, resolved: resolved)
        } else {
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

/// RECONCILE R3: a compact-width sheet at any detent suspends the toast lane (events queue, failures wait, previews for an
/// open Chat drop); the regular-width inspector keeps it. A zero-size leaf that reads only the panel snapshot.
struct NoticeLaneSuspensionReporter: View {
    let stage: StagePresenter
    let panels: PanelCoordinator
    let window: PanelWindow

    private var suspends: Bool {
        guard let current = panels.snapshot.current else { return false }
        let presentation = PanelPresentationPolicy.resolve(current, window: window, platform: PanelPlatform.iOS)
        return MeetingNoticePolicy.suspendsToastLane(style: presentation.style)
    }

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onChange(of: suspends, initial: true) { _, value in stage.setToastLaneSuspended(value) }
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
    @Environment(\.layoutDirection) private var layoutDirection

    private var coverage: String {
        guard let current = panels.snapshot.current else { return StageVisibilityPolicy.coverageNone }
        let presentation = PanelPresentationPolicy.resolve(current, window: window, platform: PanelPlatform.iOS)
        return PanelPresentationPolicy.coverage(presentation, detent: adapter.detent).rawValue
    }

    var body: some View {
        let layout = stage.layout
        let viewport = stage.viewport
        let frames = StageLayoutPolicy.frames(viewport: viewport, kind: layout.kind, slots: layout.slots, selfCorner: layout.selfCorner)
        let choice = stage.pipTarget
        // Re-evaluates once per decoded size change; an unchanged size never bumps the revision (R70-10).
        let _ = stage.frameSizes.revision
        // iOS points; the canvas is full bleed, so canvas coordinates are window coordinates. `isInPip` stays false until
        // SYS-4 builds the iOS window (STG-7, HD request B4-T6 R6).
        let pipTarget = PipTargetPolicy.frame(choice: choice, frames: frames, canvasWidth: viewport.width, originX: 0, originY: 0,
                                              scale: 1, isRightToLeft: layoutDirection == .rightToLeft,
                                              frameSize: stage.frameSizes.size(slotId: choice.slotId))
        let report = StageVisibilityPolicy.report(frames: frames, slots: layout.slots, viewport: viewport, kind: layout.kind,
                                                  coverage: coverage, chromeHidden: chrome.state.isHidden, isInPip: false,
                                                  pipTarget: pipTarget)
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
