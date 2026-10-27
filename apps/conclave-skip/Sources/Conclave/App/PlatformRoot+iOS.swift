#if DEBUG && os(iOS) && !SKIP
import SwiftUI

/// Development-only native root in the real Conclave module, below the existing app delegate.
struct NativeHostingPreview: View {
    @State private var presenter: NativeHostingPresenter
    @State private var feedback: IOSFeedbackDelivery
    @State private var panelHost = NativePanelHostAdapter()
    @State private var consumerMount = 0
    @State private var stageLifetime = HostingStageLifetime()
    @State private var rootSize = CGSize.zero
    /// Debug fixture only (this file is Debug-only): forces a compact horizontal size class on the preview root,
    /// the IPAD-4 and IPAD-5 driver when no window resize is available (PS 16). It is recorded as an override.
    @State private var compactOverride = false
    /// The root control that opened the shown panel; the inspector hands VoiceOver focus back to it (PS 7.7).
    @State private var lastInvoker: HostingPanelInvoker?
    @AccessibilityFocusState private var focusedInvoker: HostingPanelInvoker?
    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    let onClose: () -> Void

    init(onClose: @escaping () -> Void) {
        let owner = NativeHostingPresenter()
        _presenter = State(initialValue: owner)
        _feedback = State(initialValue: IOSFeedbackDelivery(presenter: owner))
        self.onClose = onClose
    }

    /// Size classes from the environment, size from the root's own layout (PS 7.1). The root never branches
    /// its structure on them; only the hosts' bindings follow. The compact override wins when it is on.
    private var window: PanelWindow {
        PanelWindow(width: Double(rootSize.width), height: Double(rootSize.height),
                    horizontalRegular: !compactOverride && horizontalSizeClass == .regular,
                    verticalRegular: verticalSizeClass == .regular)
    }

    /// The size class the preview root's content sees, so SwiftUI's own inspector adaptation follows the override.
    private var contentHorizontalSizeClass: UserInterfaceSizeClass? {
        compactOverride ? .compact : horizontalSizeClass
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // L1, as amended by the WP1-3b1 review (M1): the stage is a layout sibling above the List, so a
                // medium sheet never hides it (P1.3, IOS-1); it reserves its height in the same layout and never
                // overlays the List.
                HostingStageStrip(lifetime: stageLifetime, presenter: presenter)
                    .fixedSize(horizontal: false, vertical: true)
                List {
                    Section {
                        Text("Sample people for the native hosting preview. Changes stay in this preview.")
                            .font(.subheadline)
                            .foregroundStyle(HostingTheme.secondaryText)
                        Toggle("Show Details", isOn: Binding(
                            get: { presenter.showsDetails },
                            set: { presenter.setDetailsVisible($0) }
                        ))
                        .accessibilityIdentifier("hosting.details")
                    }
                    Section("Inert Stage") {
                        Button("Participants Panel") {
                            lastInvoker = .participants
                            presenter.presentPanel(.participants, from: .call, at: hostingUptime())
                        }
                        .accessibilityIdentifier("panel.open.participants")
                        .accessibilityFocused($focusedInvoker, equals: .participants)
                        Button("Settings Panel") {
                            lastInvoker = .settings
                            presenter.presentPanel(.settings, from: .settings, at: hostingUptime())
                        }
                        .accessibilityIdentifier("panel.open.settings")
                        .accessibilityFocused($focusedInvoker, equals: .settings)
                        Button(ConclaveStrings.text("Layout Panel")) {
                            lastInvoker = .layout
                            presenter.presentPanel(.layout, from: .call, at: hostingUptime())
                        }
                        .accessibilityIdentifier("panel.open.layout")
                        .accessibilityFocused($focusedInvoker, equals: .layout)
                        Button("Rapid Replacement") {
                            lastInvoker = .rapid
                            rapidPanels(presenter)
                        }
                        .accessibilityIdentifier("panel.rapid")
                        .accessibilityFocused($focusedInvoker, equals: .rapid)
                        // The IPAD-4 and IPAD-5 driver: regular x regular shows the inspector, compact the sheet.
                        Toggle(ConclaveStrings.text("Compact Width Override"), isOn: $compactOverride)
                            .accessibilityIdentifier("panel.compactOverride")
                    }
                    Section(ConclaveStrings.text("Stage Readouts")) {
                        // Readouts live in the List, never in the stage, so refreshing them never redraws a tile.
                        HostingPanelStyleReadout(adapter: panelHost, window: window)
                        HostingRendererReadouts(presenter: presenter)
                    }
                    Section("Silent Feedback Fixture") {
                        Text("No call, audio or vibration.")
                        Text("Session \(presenter.feedbackState.session); outcomes \(presenter.feedbackState.acceptedCount); sequence \(presenter.feedbackState.token.sequence); intended \(feedback.intendedCount); \(feedback.lastKind)")
                            .accessibilityIdentifier("feedback.status")
                        Button("Complete Outcome") { presenter.completeNextFixtureAction() }
                            .accessibilityIdentifier("feedback.complete")
                        Button("Repeat Completion") { presenter.repeatLastFixtureCompletion() }
                            .accessibilityIdentifier("feedback.duplicate")
                        Button("Selection Gesture") { feedback.gesture() }
                            .accessibilityIdentifier("feedback.gesture")
                        Toggle("Haptics", isOn: Binding(get: { feedback.preferenceEnabled }, set: { feedback.setPreference($0) }))
                            .accessibilityIdentifier("feedback.preference")
                        Button(feedback.suspended ? "Resume Feedback" : "Simulate Background or PiP") {
                            feedback.setSuspended(!feedback.suspended)
                        }.accessibilityIdentifier("feedback.suspend")
                        Button("Pause, Outcome, Resume") {
                            feedback.setSuspended(true)
                            presenter.completeNextFixtureAction()
                            feedback.setSuspended(false)
                        }.accessibilityIdentifier("feedback.coalesced")
                        Button("Remount Consumer") { consumerMount += 1 }
                            .accessibilityIdentifier("feedback.remount")
                        Button("Reset Session") { presenter.resetFixtureSession() }
                            .accessibilityIdentifier("fixture.resetSession")
                    }
                    // WP2-S2b Debug session readout (S1C Q8, OWNER-DEFAULTS Q16).
                    SessionReadoutSection(shell: MeetingViewModel.shared.shell, records: FeedbackDeliveryRecords.shared)
                    Section("Icons") {
                        NativeIconGalleryDisclosure()
                    }
                    Section(ConclaveStrings.text("Components")) {
                        NativeComponentGalleryDisclosure()
                    }
                    Section("People") {
                        ForEach(presenter.rowsState.rows) { row in
                            NativeHostingPersonRow(
                                row: row,
                                showsDetails: presenter.showsDetails,
                                onSelection: { presenter.setRowSelected(id: row.id, selected: $0) }
                            )
                        }
                    }
                    Section {
                        LabeledContent("Selected", value: String(presenter.rowsState.selectedCount))
                            .accessibilityIdentifier("hosting.selectedCount")
                        Button(action: { presenter.resetSelection() }) {
                            Text("Reset Selection")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(HostingTheme.onCoral)
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(HostingTheme.coralFill)
                        .accessibilityIdentifier("hosting.reset")
                    }
                }
                .listStyle(.insetGrouped)
            }
            // PS 7.2: the inspector column attaches to the stack's root content, under the navigation bar, so the
            // stage strip narrows beside it; the sheet host stays on the stack below.
            .modifier(NativePanelInspectorHost(coordinator: presenter.panels, adapter: panelHost, window: window) { presentation, resolved in
                HostingPanelContent(presenter: presenter, feedback: feedback, adapter: panelHost, presentation: presentation,
                                    resolved: resolved, systemScheme: systemScheme)
            })
            .navigationTitle("Hosting Preview")
            .toolbar {
                // Q12: not .confirmationAction, which iOS 26 can draw as a white label on the accent fill.
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done", action: onClose)
                        .tint(HostingTheme.coralText)
                        .accessibilityIdentifier("hosting.close")
                }
            }
        }
        .environment(\.horizontalSizeClass, contentHorizontalSizeClass)
        .onGeometryChange(for: CGSize.self) { $0.size } action: { rootSize = $0 }
        // PS 7.7: when the inspector closes (not when it migrates into a sheet), VoiceOver focus returns to the
        // control that opened it. A sheet restores focus itself.
        .onChange(of: panelHost.inspectorItem == nil) { _, closed in
            guard closed, panelHost.sheetItem == nil, presenter.panels.snapshot.current == nil, let lastInvoker else { return }
            focusedInvoker = lastInvoker
        }
        .modifier(NativePanelSheetHost(coordinator: presenter.panels, adapter: panelHost, window: window) { presentation, resolved in
            HostingPanelContent(presenter: presenter, feedback: feedback, adapter: panelHost, presentation: presentation,
                                resolved: resolved, systemScheme: systemScheme)
        })
        .background {
            Color.clear.frame(width: 0, height: 0)
                .modifier(ConclaveFeedbackConsumer(delivery: feedback, mount: consumerMount))
                .id(consumerMount)
        }
    }
}

/// Root controls that open panels, for the inspector's focus return.
private enum HostingPanelInvoker: Hashable {
    case participants, settings, layout, rapid
}

private struct NativeHostingPersonRow: View {
    let row: NativeHostingRow
    let showsDetails: Bool
    let onSelection: (Bool) -> Void

    var body: some View {
        Toggle(isOn: Binding(get: { row.isSelected }, set: onSelection)) {
            VStack(alignment: .leading, spacing: 4) {
                Text(row.name).font(.body)
                if showsDetails {
                    Text(row.detail)
                        .font(.subheadline)
                        .foregroundStyle(HostingTheme.secondaryText)
                }
            }
        }
        .accessibilityLabel(row.name)
        .accessibilityValue(row.isSelected ? "Selected" : "Not selected")
        .accessibilityIdentifier("hosting.person.\(row.id)")
    }
}

/// The stage lifetime probe (S10 R12): counts stage creations so Debug tests and a stand-in call root can prove a
/// renderer host survives panel, theme and route changes (S10 10 l4). Internal, not private, so other Debug roots
/// reuse it; plain storage, never observed, so counting never redraws anything.
final class HostingStageLifetime {
    private(set) var creations = 0

    /// Records one stage creation and returns a short instance identity for the readout.
    func create() -> String {
        creations += 1
        return String(UUID().uuidString.prefix(8))
    }
}

/// The inert stage strip (PS 7.6): the original stage line plus one tile per row, each over a renderer probe.
/// It is dark through its own environment and in-call token colors, never a window override, and its tiles
/// derive from the rows, so a row mutation redraws its tile without recreating any probe.
private struct HostingStageStrip: View {
    let lifetime: HostingStageLifetime
    let presenter: NativeHostingPresenter
    @State private var identity: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Inert stage \(identity ?? "attaching"); instances \(lifetime.creations)")
                .accessibilityIdentifier("fixture.stage")
                .task { if identity == nil { identity = lifetime.create() } }
            HStack(spacing: 8) {
                ForEach(presenter.rowsState.rows) { row in
                    HostingStageTile(row: row, ledger: presenter.renderers)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
        // Sideways only: the strip sits right below the navigation bar, which must keep the system background.
        .background(HostingTheme.token(DesignTokens.iosInCallStage), ignoresSafeAreaEdges: .horizontal)
        // The whole stage keeps its dark look under Smart Invert, like the video it stands for (IOS-12).
        .accessibilityIgnoresInvertColors()
        .environment(\.colorScheme, .dark)
    }
}

/// One stage tile over its renderer probe. The name never sits in a fixed-height container (PS 7.7): the tile is
/// at least 96 pt tall (PS 7.6) and grows with its label, which stops growing at the first accessibility size,
/// like a video name label, and shows in the large content viewer. The selection badge has its own corner, so
/// the name keeps the full width.
private struct HostingStageTile: View {
    let row: NativeHostingRow
    let ledger: RendererIdentityLedger

    var body: some View {
        Text(row.name)
            .font(.subheadline.weight(.semibold))
            .dynamicTypeSize(...DynamicTypeSize.accessibility1)
            .padding(8)
            .frame(maxWidth: .infinity, minHeight: 96, alignment: .bottomLeading)
            .overlay(alignment: .topTrailing) {
                if row.isSelected {
                    Image(systemName: ConclaveSymbols.checkmark)
                        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                        .padding(8)
                        .accessibilityHidden(true)
                }
            }
            .background { RendererProbe(key: row.id, slot: .stage, ledger: ledger) }
            .background(HostingTheme.token(DesignTokens.iosInCallTile))
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.radiusTile))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(row.name)
            .accessibilityValue(row.isSelected ? "Selected" : "Not selected")
            .accessibilityShowsLargeContentViewer()
            .accessibilityIdentifier("stage.tile.\(row.id)")
            .accessibilityIgnoresInvertColors()
    }
}

/// `style=<s> detent=<d> coverage=<c>` for the shown sheet or inspector (detent `none` for the inspector).
/// Machine-read, so it is not localized.
private struct HostingPanelStyleReadout: View {
    let adapter: NativePanelHostAdapter
    let window: PanelWindow

    var body: some View {
        Text(verbatim: text)
            .font(.footnote.monospaced())
            .accessibilityIdentifier("panel.style")
    }

    private var text: String {
        guard let item = adapter.inspectorItem ?? adapter.sheetItem else { return "style=none detent=none coverage=none" }
        let resolved = PanelPresentationPolicy.resolve(item.request, window: window, platform: .iOS)
        let coverage = PanelPresentationPolicy.coverage(resolved, detent: adapter.detent)
        let detent = resolved.style == .sheet ? adapter.detent.rawValue : "none"
        return "style=\(resolved.style.rawValue) detent=\(detent) coverage=\(coverage.rawValue)"
    }
}

/// The renderer ledger and the open timer are not observable; this leaf reads them on appear and on Refresh.
private struct HostingRendererReadouts: View {
    let presenter: NativeHostingPresenter
    @State private var refresh = 0

    var body: some View {
        let _ = refresh
        Text(verbatim: presenter.renderers.summary())
            .font(.footnote.monospaced())
            .accessibilityIdentifier("stage.renderers")
        Text(verbatim: "open " + presenter.openTimer.summary())
            .font(.footnote.monospaced())
            .accessibilityIdentifier("panel.openLatency")
        Button(ConclaveStrings.text("Refresh Readouts")) { refresh += 1 }
            .accessibilityIdentifier("stage.renderers.refresh")
            .task { refresh += 1 }
    }
}

/// Debug readouts inside the panel (review m1): at the large detent the root List is not interactive, and a sheet
/// can cover the root readouts at any detent. `panel.readout.style` follows the detent live; the ledger is not
/// observable, so the renderer line reads on appear and on Refresh. Machine-read, so the values are not localized.
private struct HostingPanelReadouts: View {
    let presenter: NativeHostingPresenter
    let feedback: IOSFeedbackDelivery
    let adapter: NativePanelHostAdapter
    let resolved: PanelPresentation
    @State private var refresh = 0

    var body: some View {
        let _ = refresh
        let coverage = PanelPresentationPolicy.coverage(resolved, detent: adapter.detent)
        Text(verbatim: "style=\(resolved.style.rawValue) detent=\(adapter.detent.rawValue) coverage=\(coverage.rawValue)")
            .font(.footnote.monospaced())
            .accessibilityIdentifier("panel.readout.style")
        Text(verbatim: presenter.renderers.summary())
            .font(.footnote.monospaced())
            .accessibilityIdentifier("panel.readout.renderers")
        Text(verbatim: "Session \(presenter.feedbackState.session); outcomes \(presenter.feedbackState.acceptedCount); sequence \(presenter.feedbackState.token.sequence); intended \(feedback.intendedCount); \(feedback.lastKind)")
            .font(.footnote.monospaced())
            .accessibilityIdentifier("panel.readout.feedback")
        Button(ConclaveStrings.text("Refresh Readouts")) { refresh += 1 }
            .accessibilityIdentifier("panel.readout.refresh")
            .task { refresh += 1 }
    }
}

/// Rapid Replacement goes through the timed path, so the panel it ends on reports its open latency (review
/// ISSUE 6); the presenter drops the start of the presentation it supersedes.
@MainActor
private func rapidPanels(_ presenter: NativeHostingPresenter) {
    let now = hostingUptime()
    presenter.presentPanel(.participants, from: .call, at: now)
    presenter.presentPanel(.settings, from: .settings, at: now)
    presenter.presentPanel(.participants, from: .more, at: now)
}

/// One monotonic clock for the diagnostic open timer.
private func hostingUptime() -> Double {
    ProcessInfo.processInfo.systemUptime
}

private struct HostingPanelContent: View {
    let presenter: NativeHostingPresenter
    let feedback: IOSFeedbackDelivery
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    let systemScheme: ColorScheme

    var body: some View {
        Group {
            if presentation.request.panel == .layout {
                HostingLayoutPanel(presenter: presenter, feedback: feedback, adapter: adapter, presentation: presentation,
                                   resolved: resolved, systemScheme: systemScheme)
            } else {
                HostingSamplePanel(presenter: presenter, feedback: feedback, adapter: adapter, presentation: presentation,
                                   resolved: resolved, systemScheme: systemScheme)
            }
        }
        .task(id: presentation.id) {
            presenter.openTimer.firstFrame(presentationID: presentation.request.presentationID, at: hostingUptime())
        }
    }
}

private struct HostingSamplePanel: View {
    let presenter: NativeHostingPresenter
    let feedback: IOSFeedbackDelivery
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    let systemScheme: ColorScheme
    private var settings: Bool { presentation.request.panel == .settings }

    var body: some View {
        PanelShell(title: settings ? ConclaveStrings.text("Settings") : ConclaveStrings.text("Participants"),
                   presentation: resolved, hostStyle: resolved.style, systemScheme: systemScheme,
                   onClose: { presenter.panels.dismiss(cancelPending: true) },
                   onPromoteToLarge: { adapter.promoteToLarge() }) {
            List {
                Text("Presentation \(presentation.request.presentationID); from \(presentation.request.invoker.rawValue)")
                    .accessibilityIdentifier("panel.identity")
                LabeledContent("Selected", value: String(presenter.rowsState.selectedCount))
                    .accessibilityIdentifier("panel.selectedCount")
                if settings {
                    Text("Sample settings. Text stays in this panel.")
                    HostingSampleTextField(adapter: adapter, presentationID: presentation.request.presentationID)
                } else {
                    ForEach(presenter.rowsState.rows) { row in
                        NativeHostingPersonRow(row: row, showsDetails: presenter.showsDetails,
                            onSelection: { presenter.setRowSelected(id: row.id, selected: $0) })
                    }
                }
                Button(settings ? "Open Participants" : "Open Settings") {
                    presenter.presentPanel(settings ? .participants : .settings, from: settings ? .settings : .more, at: hostingUptime())
                }.accessibilityIdentifier("panel.replace")
                Button("Rapid Replacement") { rapidPanels(presenter) }
                    .accessibilityIdentifier("panel.rapid")
                Button("Replace Then Close") {
                    presenter.panels.present(settings ? .participants : .settings, from: .more)
                    presenter.panels.dismiss(cancelPending: true)
                }.accessibilityIdentifier("panel.cancelPending")
                Button("Reset During Replacement") {
                    presenter.panels.present(settings ? .participants : .settings, from: .more)
                    presenter.resetFixtureSession()
                }.accessibilityIdentifier("panel.resetDuringDismissal")
                Section {
                    HostingPanelReadouts(presenter: presenter, feedback: feedback, adapter: adapter, resolved: resolved)
                }
            }
        }
    }
}

/// The fixture sample text lives in the adapter's draft store, keyed by presentation, and focus promotes a
/// medium sheet to large through the shell's environment action. Runtime enters text only by Paste.
private struct HostingSampleTextField: View {
    let adapter: NativePanelHostAdapter
    let presentationID: Int
    @FocusState private var focused: Bool
    @Environment(\.panelPromoteToLargeDetent) private var promoteToLarge

    var body: some View {
        TextField("Sample Text", text: Binding(
            get: { adapter.draft(for: presentationID) },
            set: { adapter.setDraft($0, for: presentationID) }
        ))
        .focused($focused)
        .onChange(of: focused) { _, isFocused in
            if isFocused { promoteToLarge() }
        }
        .accessibilityIdentifier("panel.input")
    }
}

private enum HostingLayoutChoice: String, CaseIterable, Identifiable {
    case grid, spotlight, sidebar

    var id: String { rawValue }

    var title: String {
        switch self {
        case .grid: return ConclaveStrings.text("Grid")
        case .spotlight: return ConclaveStrings.text("Spotlight")
        case .sidebar: return ConclaveStrings.text("Sidebar")
        }
    }
}

/// Layout from the call: a medium sheet in the dark in-call appearance with one native single choice. The
/// choice stays inside the panel and changes nothing else.
private struct HostingLayoutPanel: View {
    let presenter: NativeHostingPresenter
    let feedback: IOSFeedbackDelivery
    let adapter: NativePanelHostAdapter
    let presentation: NativePanelPresentation
    let resolved: PanelPresentation
    let systemScheme: ColorScheme
    @State private var choice = HostingLayoutChoice.grid

    var body: some View {
        PanelShell(title: ConclaveStrings.text("Layout"), presentation: resolved, hostStyle: resolved.style,
                   systemScheme: systemScheme,
                   onClose: { presenter.panels.dismiss(cancelPending: true) },
                   onPromoteToLarge: { adapter.promoteToLarge() }) {
            List {
                Text("Presentation \(presentation.request.presentationID); from \(presentation.request.invoker.rawValue)")
                    .accessibilityIdentifier("panel.identity")
                Picker(ConclaveStrings.text("Layout"), selection: $choice) {
                    ForEach(HostingLayoutChoice.allCases) { option in
                        Text(option.title)
                            .tag(option)
                            .accessibilityIdentifier("panel.layout.\(option.rawValue)")
                    }
                }
                .pickerStyle(.inline)
                Section {
                    HostingPanelReadouts(presenter: presenter, feedback: feedback, adapter: adapter, resolved: resolved)
                }
            }
        }
    }
}
#endif
