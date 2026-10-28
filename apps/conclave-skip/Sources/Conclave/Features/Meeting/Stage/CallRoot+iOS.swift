#if os(iOS) && !SKIP
import SwiftUI

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

    var people: PeoplePresenter? = nil
    let renderers: StageRendererProvider

    var forceScreenReader: Bool = false

    var activitySession: ActivitySession? = nil

    var webinarLinkProvider: MeetingDetailsWebinarLinkProvider? = nil
    @State private var panelHost = NativePanelHostAdapter()

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

                .peopleStageConfirmations(people)
                .accessibilitySortPriority(3)

            StagePipAnchor(stage: stage)
            AttendeeWaitingLayer(stage: stage)
                .accessibilitySortPriority(3)

            AttendeeRoleLayer(stage: stage)
            ReactionBurstLayer(stage: stage)
            StageChromeLayer(shell: shell, stage: stage, chrome: chromeVisibility, forceScreenReader: forceScreenReader)

            NoticeLanesLayer(stage: stage, forceScreenReader: forceScreenReader, installsSound: !renderers.usesProbes)
            NoticeLaneSuspensionReporter(stage: stage, panels: shell.panels, window: window)
            StageVisibilityReporter(stage: stage, panels: shell.panels, adapter: panelHost, chrome: chromeVisibility,
                                    window: window)
        }
        .accessibilityElement(children: .contain)

        .environment(\.rendererFrameSizes, stage.frameSizes)

        .environment(\.activitySession, activitySession)
        .background { HostingTheme.token(DesignTokens.iosInCallStage).ignoresSafeArea() }

        .ignoresSafeArea(.keyboard)
        .environment(\.colorScheme, .dark)
        .onGeometryChange(for: CGSize.self) { proxy in proxy.size } action: { size in rootSize = size }
        .modifier(NativePanelInspectorHost(coordinator: shell.panels, adapter: panelHost, window: window) { presentation, resolved in
            CallPanelContent(shell: shell, people: people, adapter: panelHost, presentation: presentation, resolved: resolved,
                             activitySession: activitySession, stage: stage,
                             webinarLinkProvider: CallRootWebinarLink.provider(webinarLinkProvider, people: people))
        })
        .modifier(NativePanelSheetHost(coordinator: shell.panels, adapter: panelHost, window: window) { presentation, resolved in
            CallPanelContent(shell: shell, people: people, adapter: panelHost, presentation: presentation, resolved: resolved,
                             activitySession: activitySession, stage: stage,
                             webinarLinkProvider: CallRootWebinarLink.provider(webinarLinkProvider, people: people))
        })
        .conclaveCallAppearance()

        .accessibilityAction(.magicTap) { shell.toggleMicrophone() }
        .accessibilityIdentifier("stage.root")
    }
}

struct CallPanelContent: View {
    let shell: MeetingShellPresenter
    let people: PeoplePresenter?
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    var activitySession: ActivitySession? = nil

    var stage: StagePresenter? = nil
    var webinarLinkProvider: MeetingDetailsWebinarLinkProvider? = nil
    @Environment(\.conclaveSystemColorScheme) private var systemScheme

    var body: some View {
        if presentation.request.panel == .meetingInfo, let stage {

            MeetingDetailsPanel(stage: stage, shell: shell, people: people, adapter: adapter, presentation: presentation,
                                resolved: resolved, webinarLinkProvider: webinarLinkProvider)
        } else if presentation.request.panel == .chat {

            ChatPanelHost(chat: shell.chat, panels: shell.panels, presentation: presentation, resolved: resolved,
                          onPromoteToLarge: { adapter.promoteToLarge() })
        } else if presentation.request.panel == .participants, let people {

            ParticipantsPanel(people: people, shell: shell, adapter: adapter, presentation: presentation, resolved: resolved)
        } else if presentation.request.panel == .hostControls, let people {

            HostControlsPanel(people: people, shell: shell, adapter: adapter, presentation: presentation, resolved: resolved)
        } else if presentation.request.panel == .webinarQA, let people {

            QaPanel(people: people, shell: shell, adapter: adapter, presentation: presentation, resolved: resolved)
        } else if presentation.request.panel == .settings {

            SettingsPanel(settings: shell.settings, shell: shell, people: people, adapter: adapter, presentation: presentation,
                          resolved: resolved)
        } else if presentation.request.panel == .activities, let activitySession {

            ActivitiesPanel(session: activitySession, adapter: adapter, presentation: presentation, resolved: resolved)
        } else if presentation.request.panel == .layout, let stage {

            LayoutPanel(layout: stage.layoutPanel, shell: shell, adapter: adapter, presentation: presentation, resolved: resolved)
        } else if presentation.request.panel == .effects, let stage,
                  EffectsAvailabilityPolicy.showsPanelEntry(stage.effects.snapshot.availability) {

            EffectsPanel(effects: stage.effects, shell: shell, adapter: adapter, presentation: presentation, resolved: resolved)
        } else if presentation.request.panel == .transcript {

            TranscriptPanel(transcript: shell.transcript, panels: shell.panels, presentation: presentation, resolved: resolved,
                            onPromoteToLarge: { adapter.promoteToLarge() })
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

enum CallRootWebinarLink {
    static func provider(_ override: MeetingDetailsWebinarLinkProvider?, people: PeoplePresenter?) -> MeetingDetailsWebinarLinkProvider? {
        if let override { return override }
        guard let people else { return nil }
        return { await people.host.ensureWebinarLink() }
    }
}

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

        let _ = stage.frameSizes.revision

        let pipTarget = PipTargetPolicy.frame(choice: choice, frames: frames, canvasWidth: viewport.width, originX: 0, originY: 0,
                                              scale: 1, isRightToLeft: layoutDirection == .rightToLeft,
                                              frameSize: stage.frameSizes.size(slotId: choice.slotId))
        let report = StageVisibilityPolicy.report(frames: frames, slots: layout.slots, viewport: viewport, kind: layout.kind,
                                                  coverage: coverage, chromeHidden: chrome.state.isHidden, isInPip: PipWindowState.shared.isShowing,
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
