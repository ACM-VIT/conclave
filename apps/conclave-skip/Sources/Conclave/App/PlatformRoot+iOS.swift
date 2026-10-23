#if DEBUG && os(iOS) && !SKIP
import SwiftUI

/// Development-only native root in the real Conclave module, below the existing app delegate.
struct NativeHostingPreview: View {
    @State private var presenter: NativeHostingPresenter
    @State private var feedback: IOSFeedbackDelivery
    @State private var sheet = NativePanelSheetAdapter()
    @State private var consumerMount = 0
    @State private var stageLifetime = HostingStageLifetime()
    @Environment(\.colorScheme) private var systemScheme
    let onClose: () -> Void

    init(onClose: @escaping () -> Void) {
        let owner = NativeHostingPresenter()
        _presenter = State(initialValue: owner)
        _feedback = State(initialValue: IOSFeedbackDelivery(presenter: owner))
        self.onClose = onClose
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
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
                        Button("Participants Panel") { presenter.panels.present(.participants, from: .call) }
                            .accessibilityIdentifier("panel.open.participants")
                        Button("Settings Panel") { presenter.panels.present(.settings, from: .settings) }
                            .accessibilityIdentifier("panel.open.settings")
                        Button("Rapid Replacement") { rapidPanels(presenter) }
                            .accessibilityIdentifier("panel.rapid")
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
                    Section("Icons") {
                        NativeIconGalleryDisclosure()
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

                // Reserve the stage height in the same layout as the scrolling controls.
                HostingInertStage(lifetime: stageLifetime)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .navigationTitle("Hosting Preview")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onClose)
                        .tint(HostingTheme.coralText)
                        .accessibilityIdentifier("hosting.close")
                }
            }
        }
        .modifier(NativePanelSheet(coordinator: presenter.panels, adapter: sheet) { presentation in
            HostingSamplePanel(presenter: presenter, presentation: presentation)
                .preferredColorScheme(systemScheme)
        })
        .background {
            Color.clear.frame(width: 0, height: 0)
                .modifier(ConclaveFeedbackConsumer(delivery: feedback, mount: consumerMount))
                .id(consumerMount)
        }
    }
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

private final class HostingStageLifetime {
    var creations = 0
    func create() -> String {
        creations += 1
        return String(UUID().uuidString.prefix(8))
    }
}

private struct HostingInertStage: View {
    private static let stageColor = Color(.sRGB,
        red: Double((DesignTokens.iosInCallStage >> 16) & 0xFF) / 255,
        green: Double((DesignTokens.iosInCallStage >> 8) & 0xFF) / 255,
        blue: Double(DesignTokens.iosInCallStage & 0xFF) / 255, opacity: 1)
    let lifetime: HostingStageLifetime
    @State private var identity: String?
    var body: some View {
        Text("Inert stage \(identity ?? "attaching"); instances \(lifetime.creations)")
            .frame(maxWidth: .infinity, minHeight: 80)
            .foregroundStyle(.white)
            .background(Self.stageColor)
            .accessibilityIdentifier("fixture.stage")
            .task { if identity == nil { identity = lifetime.create() } }
    }
}

@MainActor
private func rapidPanels(_ presenter: NativeHostingPresenter) {
    presenter.panels.present(.participants, from: .call)
    presenter.panels.present(.settings, from: .settings)
    presenter.panels.present(.participants, from: .more)
}

private struct HostingSamplePanel: View {
    let presenter: NativeHostingPresenter
    let presentation: NativePanelPresentation
    @State private var sampleText = ""
    private var settings: Bool { presentation.request.panel == .settings }

    var body: some View {
        NavigationStack {
            List {
                Text("Presentation \(presentation.request.presentationID); from \(presentation.request.invoker.rawValue)")
                    .accessibilityIdentifier("panel.identity")
                LabeledContent("Selected", value: String(presenter.rowsState.selectedCount))
                    .accessibilityIdentifier("panel.selectedCount")
                if settings {
                    Text("Sample settings. Text stays in this panel.")
                    TextField("Sample Text", text: $sampleText)
                        .accessibilityIdentifier("panel.input")
                } else {
                    ForEach(presenter.rowsState.rows) { row in
                        NativeHostingPersonRow(row: row, showsDetails: presenter.showsDetails,
                            onSelection: { presenter.setRowSelected(id: row.id, selected: $0) })
                    }
                }
                Button(settings ? "Open Participants" : "Open Settings") {
                    presenter.panels.present(settings ? .participants : .settings, from: settings ? .settings : .more)
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
            }
            .navigationTitle(settings ? "Settings" : "Participants")
            .navigationBarTitleDisplayMode(.inline)
            .modifier(HostingSamplePanelBarMinimization())
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close") { presenter.panels.dismiss(cancelPending: true) }
                        .accessibilityIdentifier("panel.close")
                }
            }
        }
    }
}

private struct HostingSamplePanelBarMinimization: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 27.0, *) {
            content.toolbarMinimizationBehavior(.never, for: .navigationBar)
        } else {
            content
        }
    }
}
#endif
