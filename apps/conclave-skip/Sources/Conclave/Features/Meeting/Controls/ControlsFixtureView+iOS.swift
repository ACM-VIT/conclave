#if DEBUG && os(iOS) && !SKIP
import SwiftUI

enum ControlsFixtureLaunch {
    static func state(environment: [String: String] = NativeRuntimeConfig.debugLaunchEnvironment()) -> ControlsFixtureState? {
        guard let raw = environment["CONCLAVE_STAGE_FIXTURE"] else { return nil }
        return ControlsFixtureScript.state(named: raw)
    }
}

struct ControlsFixtureView: View {
    @State private var session: ControlsFixtureSession

    init(state: ControlsFixtureState) {
        _session = State(initialValue: ControlsFixtureSession(state: state))
    }

    var body: some View {
        ZStack(alignment: .leading) {
            CallRoot(shell: session.shell, stage: session.stage,
                     renderers: StageRendererProvider.probes(ledger: session.renderers, pattern: RendererProbePattern.staticPattern))
                .environment(session.controls)
            ControlsFixtureControls(session: session)
        }
    }
}

private struct ControlsFixtureControls: View {
    let session: ControlsFixtureSession
    @State private var expanded = true
    @State private var refresh = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            fixtureButton("Fixture", identifier: "controls.fixture.toggle") { expanded.toggle() }
            if expanded {
                fixtureButton("Request End", identifier: "controls.fixture.requestEnd") {
                    session.requestEnd(from: MeetingConfirmationInvoker.call)
                    refresh += 1
                }
                fixtureButton("Confirm End", identifier: "controls.fixture.confirmEnd") {
                    if let id = session.shell.session.confirmation?.id { session.confirmEnd(id: id) }
                    refresh += 1
                }
                fixtureButton("Refresh", identifier: "controls.fixture.refresh") { refresh += 1 }
                ControlsFixtureReadouts(session: session, refresh: refresh)
            }
        }
        .padding(8)
        .frame(maxWidth: 240, alignment: .leading)
        .background(HostingTheme.inCallLabelScrim, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .padding(.leading, 8)
        .environment(\.colorScheme, .dark)
    }

    private func fixtureButton(_ title: String, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {

            Text(verbatim: title)
                .font(.caption.weight(.semibold))
                .frame(minHeight: 28)
        }
        .buttonStyle(.borderless)
        .tint(HostingTheme.inCallCoralText)
        .accessibilityIdentifier(identifier)
    }
}

private struct ControlsFixtureReadouts: View {
    let session: ControlsFixtureSession
    let refresh: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            readout(session.countersReadout(), identifier: "controls.counters")
            readout(session.barReadout(), identifier: "controls.bar")
            readout(session.compositionReadout(), identifier: "controls.composition")
            readout(session.explanationReadout(), identifier: "controls.explanation")
            readout(session.leaveReadout(), identifier: "controls.leave")

            readout(session.moreReadout(), identifier: "controls.more")
            readout(session.menuHeightReadout(), identifier: "controls.menuHeight")
            readout(session.handReadout(), identifier: "controls.hand")
            readout(session.routeReadout(), identifier: "controls.route")
            readout(session.shortcutsReadout(), identifier: "controls.shortcuts")
            readout(session.noticesReadout(), identifier: "stage.notices")
            readout(session.panelReadout(), identifier: "panel.current")
            readout(session.chromeReadout(), identifier: "chrome.transient")
            readout(session.renderersReadout(), identifier: "stage.renderers")
            readout("refresh " + String(refresh), identifier: "controls.fixture.refreshCount")
        }
    }

    private func readout(_ text: String, identifier: String) -> some View {
        Text(verbatim: text)
            .font(.caption2.monospaced())
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .lineLimit(4)
            .accessibilityIdentifier(identifier)
    }
}
#endif
