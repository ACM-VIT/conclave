#if os(iOS) && !SKIP
import SwiftUI

/// S70 SX1 Debug system fixture root (iOS). Mounted by the Debug seam in `ConclaveApp.swift` when the launch
/// environment has `CONCLAVE_SYSTEM_FIXTURE=<state>` (HD request B1-T2); `CONCLAVE_SYSTEM_FIXTURE_PROVIDER=real`
/// selects the real CallKit provider for the physical cell 1 l7. It drives a standalone `CallPresence` through the
/// real CallKit adapter and never WebRTC, audio, capture or the network. Readouts carry the SX1 keys as identifiers.
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
            // SYS-5 (S70 4, SX1): keep awake and proximity follow the fixture's snapshot.
            CallScreenAwake.makePresenceAdapter()
        ])
        _session = State(initialValue: session)
        _adapter = State(initialValue: adapter)
    }

    var body: some View {
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
        }
        .task {
            // Once per mount, never from an appearance callback that could write observed state again.
            guard !started else { return }
            started = true
            session.start()
        }
    }
}

enum SystemFixtureLaunch {
    /// The fixture state from the Debug launch environment, or nil for an ordinary launch.
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
