#if DEBUG && os(iOS) && !SKIP
import SwiftUI

enum PeopleFixtureLaunch {
    static func state(environment: [String: String] = NativeRuntimeConfig.debugLaunchEnvironment()) -> PeopleFixtureState? {
        NativeFixtureLaunch.iOSPeopleState(environment["CONCLAVE_PEOPLE_FIXTURE"])
    }

    static func qaState(environment: [String: String] = NativeRuntimeConfig.debugLaunchEnvironment()) -> PeopleWebinarFixtureState? {
        NativeFixtureLaunch.iOSPeopleQaState(environment["CONCLAVE_PEOPLE_FIXTURE"])
    }
}

struct PeopleFixtureView: View {
    @State private var session: PeopleFixtureSession
    @State private var qaSession: PeopleWebinarFixtureSession?

    init(state: PeopleFixtureState, qaState: PeopleWebinarFixtureState? = nil,
         pattern: RendererProbePattern = StageFixtureLaunch.pattern(),
         forceScreenReader: Bool = StageFixtureLaunch.forcesScreenReader()) {
        let qa = qaState.map { PeopleWebinarFixtureSession(state: $0) }
        _qaSession = State(initialValue: qa)
        _session = State(initialValue: qa?.base ?? PeopleFixtureSession(state: state, pattern: pattern, forceScreenReader: forceScreenReader))
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
            if let qaSession {
                qaSession.people.openQuestionsAndAnswers()
                return
            }

            session.open(destination: PeopleFixtureScript.openDestination(for: session.state))
            if session.state == PeopleFixtureState.lostHost {
                try? await Task.sleep(for: .milliseconds(Int(PeopleFixtureScript.lostHostDelayMillis)))
                if Task.isCancelled { return }
                session.loseHost()
            }
            if session.state == PeopleFixtureState.hostWaitingLate {
                try? await Task.sleep(for: .milliseconds(Int(PeopleFixtureScript.lateWaitingDelayMillis)))
                if Task.isCancelled { return }
                session.deliverLateWaiting()
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

            readout(session.actionsReadout(), identifier: "people.actions")
            readout(session.noticesReadout(), identifier: "stage.notices")
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
