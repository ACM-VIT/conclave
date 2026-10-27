#if DEBUG && os(iOS) && !SKIP
import SwiftUI

// S50 PL12 (PPL-1): the iOS Debug People fixture root, layered on the S20 SL14 stage fixture. Mounted by the Debug root
// hook in `ConclaveApp.swift` when `CONCLAVE_PEOPLE_FIXTURE=<state>` is set (HD request B4-T7 R5); the stage fixture's
// `CONCLAVE_STAGE_FIXTURE_PATTERN` and `CONCLAVE_STAGE_FORCE_SCREEN_READER` apply. The native call root draws the probe
// stage with the native Participants panel; scripts and readouts sit beside the stage, never inside the panel or
// stage subtree (PS 7.6). Standalone presenters only: never `MeetingViewModel`, WebRTC, audio, capture or network.

enum PeopleFixtureLaunch {
    static func state(environment: [String: String] = ProcessInfo.processInfo.environment) -> PeopleFixtureState? {
        guard let raw = environment["CONCLAVE_PEOPLE_FIXTURE"] else { return nil }
        return PeopleFixtureScript.state(named: raw)
    }
}

struct PeopleFixtureView: View {
    @State private var session: PeopleFixtureSession

    init(state: PeopleFixtureState, pattern: RendererProbePattern = StageFixtureLaunch.pattern(),
         forceScreenReader: Bool = StageFixtureLaunch.forcesScreenReader()) {
        _session = State(initialValue: PeopleFixtureSession(state: state, pattern: pattern, forceScreenReader: forceScreenReader))
    }

    var body: some View {
        ZStack(alignment: .leading) {
            CallRoot(shell: session.shell, stage: session.stage, people: session.people,
                     renderers: StageRendererProvider.probes(ledger: session.stageSession.renderers,
                                                             pattern: session.stageSession.pattern),
                     forceScreenReader: session.stageSession.forceScreenReader)
            PeopleFixtureControls(session: session)
        }
        .task {
            // Open the way the state's cell does (the knock View for Waiting, the hand toast View for Raised Hands).
            session.open(destination: PeopleFixtureScript.openDestination(for: session.state))
            if session.state == PeopleFixtureState.lostHost {
                try? await Task.sleep(for: .milliseconds(Int(PeopleFixtureScript.lostHostDelayMillis)))
                if Task.isCancelled { return }
                session.loseHost()
            }
        }
    }
}

private struct PeopleFixtureControls: View {
    let session: PeopleFixtureSession
    @State private var expanded = true
    @State private var refresh = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            fixtureButton("Fixture", identifier: "people.fixture.toggle") { expanded.toggle() }
            if expanded {
                fixtureButton("Open", identifier: "people.fixture.open") {
                    session.open(destination: PanelDestination.none)
                    refresh += 1
                }
                fixtureButton("Knock View", identifier: "people.fixture.knockView") {
                    session.open(destination: PanelDestination.peopleWaiting)
                    refresh += 1
                }
                fixtureButton("Hand View", identifier: "people.fixture.handView") {
                    session.open(destination: PanelDestination.peopleRaisedHands)
                    refresh += 1
                }
                fixtureButton("Speakers", identifier: "people.fixture.speakers") { session.runSpeakerScript(); refresh += 1 }
                fixtureButton("Mute Row", identifier: "people.fixture.mute") { session.scriptedMute(); refresh += 1 }
                fixtureButton("Lose Host", identifier: "people.fixture.loseHost") { session.loseHost(); refresh += 1 }
                fixtureButton("Refresh", identifier: "people.fixture.refresh") { refresh += 1 }
                PeopleFixtureReadouts(session: session, refresh: refresh)
            }
        }
        .padding(8)
        .frame(maxWidth: 220, alignment: .leading)
        .background(HostingTheme.inCallLabelScrim, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .padding(.leading, 8)
        .environment(\.colorScheme, .dark)
    }

    private func fixtureButton(_ title: String, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            // Debug fixture labels are not user-facing copy (the stage fixture does the same).
            Text(verbatim: title)
                .font(.caption.weight(.semibold))
                .frame(minHeight: 28)
        }
        .buttonStyle(.borderless)
        .tint(HostingTheme.inCallCoralText)
        .accessibilityIdentifier(identifier)
    }
}

private struct PeopleFixtureReadouts: View {
    let session: PeopleFixtureSession
    let refresh: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            readout(session.revisionReadout(), identifier: "people.revision")
            readout(session.recomposeReadout(), identifier: "people.recompose")
            readout(session.focusReadout(), identifier: "people.focus")
            readout(session.countersReadout(), identifier: "people.counters")
            readout(session.panelReadout(), identifier: "panel.current")
            readout(session.renderersReadout(), identifier: "stage.renderers")
            readout("refresh " + String(refresh), identifier: "people.fixture.refreshCount")
        }
    }

    private func readout(_ text: String, identifier: String) -> some View {
        Text(verbatim: text)
            .font(.caption2)
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .lineLimit(4)
            .accessibilityIdentifier(identifier)
    }
}
#endif
