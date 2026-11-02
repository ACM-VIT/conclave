#if os(iOS) && !SKIP
import SwiftUI

struct SystemFixtureView: View {
    @State private var session: SystemFixtureSession
    @State private var adapter: CallKitPresenceAdapter
    @State private var started = false

    init(state: SystemFixtureState, providerMode: SystemFixtureProviderMode) {
        let session = SystemFixtureSession(state: state, providerMode: providerMode)
        let provider: CallProviding = providerMode == .real ? CallKitManager.shared : FakeCallProvider()
        let adapter = CallKitPresenceAdapter(provider: provider)
        session.presence.adapters = CallPresenceAdapters([
            adapter.makeAdapter(for: session.presence),

            CallScreenAwake.makePresenceAdapter(),

            CallDiagnostics.shared.makePresenceAdapter()
        ])
        _session = State(initialValue: session)
        _adapter = State(initialValue: adapter)
    }

    var body: some View {
        Group {
            if let share = session.share {
                shareBody(share)
            } else {
                fixtureList
            }
        }
        .task {

            guard !started else { return }
            started = true
            session.start()
        }
    }

    private func shareBody(_ share: SystemShareFixtureRig) -> some View {
        ZStack(alignment: .topLeading) {
            CallRoot(shell: share.shell, stage: share.stage,
                     renderers: StageRendererProvider.probes(ledger: share.renderers, pattern: RendererProbePattern.staticPattern))
                .environment(share.controls)
            SystemShareFixtureReadouts(session: session)
        }
    }

    private var fixtureList: some View {
        List {
            Section(ConclaveStrings.text("System Fixture")) {
                LabeledContent(ConclaveStrings.text("Presence"), value: session.presenceReadout)
                    .accessibilityIdentifier(SystemFixtureReadout.presenceKey)
                LabeledContent(ConclaveStrings.text("Commands"), value: session.commandsReadout)
                    .accessibilityIdentifier(SystemFixtureReadout.commandsKey)
                LabeledContent(ConclaveStrings.text("Keep Awake"), value: CallScreenAwakeState.shared.awakeReadout)
                    .accessibilityIdentifier(CallScreenAwakeReadout.awakeKey)
                LabeledContent(ConclaveStrings.text("Proximity"), value: CallScreenAwakeState.shared.proximityReadout)
                    .accessibilityIdentifier(CallScreenAwakeReadout.proximityKey)
                Text(verbatim: VideoCallPictureInPicture.shared.readout)
                    .accessibilityIdentifier("sys.pip")
            }
            Section(ConclaveStrings.text("System Commands")) {
                Button(ConclaveStrings.text("Mute")) { session.send(.mute, source: .callKit) }
                Button(ConclaveStrings.text("Unmute")) { session.send(.unmute, source: .callKit) }
                Button(ConclaveStrings.text("Hold")) { session.send(.hold, source: .callKit) }
                Button(ConclaveStrings.text("Resume")) { session.send(.resume, source: .callKit) }
                Button(ConclaveStrings.text("Leave Call")) { session.send(.leave, source: .callKit) }
                Button(ConclaveStrings.text("iPhone")) { session.setAudioRoute(.receiver) }
                Button(ConclaveStrings.text("Speaker")) { session.setAudioRoute(.speaker) }
            }
            #if DEBUG

            DiagnosticsFixtureSection()
            #endif
        }
    }
}

private struct SystemShareFixtureReadouts: View {
    let session: SystemFixtureSession

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            readout(session.presenceReadout, identifier: SystemFixtureReadout.presenceKey)
            readout(session.shareReadout, identifier: SystemFixtureReadout.shareKey)
            readout(session.shareWindowReadout, identifier: SystemFixtureReadout.shareWindowKey)
            readout(session.shareNoticeReadout, identifier: SystemFixtureReadout.shareNoticeKey)
            readout(session.shareCommandsReadout, identifier: SystemFixtureReadout.shareCommandsKey)
            if session.share?.phase == ShareFixturePhase.failed {
                Button {
                    session.repostShareFailure()
                } label: {
                    Text(verbatim: "Show failure again")
                        .font(.caption.weight(.semibold))
                        .frame(minHeight: 28)
                }
                .buttonStyle(.borderless)
                .tint(HostingTheme.inCallCoralText)
                .accessibilityIdentifier(SystemFixtureReadout.shareRepostKey)
            }
        }
        .padding(8)
        .frame(maxWidth: 240, alignment: .leading)
        .background(HostingTheme.inCallLabelScrim, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .padding(.leading, 8)
        .padding(.top, 8)
        .environment(\.colorScheme, .dark)
    }

    private func readout(_ text: String, identifier: String) -> some View {
        Text(verbatim: text)
            .font(.caption2.monospaced())
            .foregroundStyle(HostingTheme.token(DesignTokens.iosInCallText))
            .lineLimit(4)
            .accessibilityIdentifier(identifier)
    }
}

enum SystemFixtureLaunch {

    static func state(environment: [String: String] = ProcessInfo.processInfo.environment) -> SystemFixtureState? {
        #if DEBUG
        guard let raw = environment["CONCLAVE_SYSTEM_FIXTURE"] else { return nil }
        return SystemFixtureScript.state(named: raw)
        #else
        return nil
        #endif
    }

    static func providerMode(environment: [String: String] = ProcessInfo.processInfo.environment) -> SystemFixtureProviderMode {
        environment["CONCLAVE_SYSTEM_FIXTURE_PROVIDER"] == SystemFixtureProviderMode.real.rawValue ? .real : .fake
    }
}
#endif
