import Foundation
import Observation

/// S70 SX1 system fixture states: `CONCLAVE_SYSTEM_FIXTURE=<state>` (iOS launch environment) and the intent extra
/// `conclave.systemFixture` (Android, Debug only, `FLAG_DEBUGGABLE` checked like `conclave.hostingPreview`).
enum SystemFixtureState: String, CaseIterable, Equatable {
    case presenceWaiting = "presence-waiting"
    case presenceConnecting = "presence-connecting"
    case presenceLive = "presence-live"
    case presenceLiveMuted = "presence-live-muted"
    case presenceLiveCamera = "presence-live-camera"
    case presenceRecovering = "presence-recovering"
    case presenceOnHold = "presence-on-hold"
    case presenceAttendee = "presence-attendee"
    case presenceEnded = "presence-ended"
    /// SYS-4 (S70 SX1, 3 l2, 3 l3, 8 l2): a live call with a portrait remote speaker as the PiP target.
    case pipSpeaker = "pip-speaker"
}

/// SX1 provider mode on iOS: `fake` drives the scripted cells, `real` uses the real `CXProvider` and
/// `CXCallController` with no media (the 1 l7 physical cell, the only way the lock-screen pill appears).
enum SystemFixtureProviderMode: String, CaseIterable, Equatable {
    case fake, real
}

/// Scripted inputs per fixture state. Pure, so host tests and the transpiled Robolectric suite read the same script.
enum SystemFixtureScript {
    static let roomLabel = "lily-zoro-iris"
    /// A fixed start time so the chronometer reads the same in every run (2026-10-27 12:00 UTC).
    static let joinedAtMillis: Double = 1793102400000.0

    static func state(named raw: String) -> SystemFixtureState? {
        SystemFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// The inputs a fixture applies, in order. A state that needs a prior phase (live after connecting) lists both,
    /// so adapters see the same transitions a real call produces.
    static func inputs(for state: SystemFixtureState) -> [CallPresenceInputs] {
        let connecting = CallPresenceInputs.make(callSession: 1, sessionPhase: .entering, roomLabel: roomLabel)
        switch state {
        case .presenceWaiting:
            return [CallPresenceInputs.make(callSession: 1, sessionPhase: .waiting, roomLabel: roomLabel)]
        case .presenceConnecting:
            return [connecting]
        case .presenceLive:
            return [connecting, live(isMuted: false, isCameraOff: true)]
        case .presenceLiveMuted:
            return [connecting, live(isMuted: true, isCameraOff: true)]
        case .presenceLiveCamera:
            return [connecting, live(isMuted: false, isCameraOff: false)]
        case .presenceRecovering:
            return [
                connecting,
                live(isMuted: false, isCameraOff: true),
                CallPresenceInputs.make(callSession: 1, sessionPhase: .recovering, roomLabel: roomLabel,
                                        isMuted: false, joinedAtMillis: joinedAtMillis)
            ]
        case .presenceOnHold:
            return [connecting, live(isMuted: true, isCameraOff: true)]
        case .presenceAttendee:
            return [
                connecting,
                CallPresenceInputs.make(callSession: 1, sessionPhase: .inCall, roomLabel: roomLabel,
                                        isWebinarAttendee: true, joinedAtMillis: joinedAtMillis)
            ]
        case .presenceEnded:
            return [
                connecting,
                live(isMuted: true, isCameraOff: true),
                CallPresenceInputs.make(callSession: 1, sessionPhase: .home, outcome: .endedByHost, roomLabel: roomLabel)
            ]
        case .pipSpeaker:
            return [connecting, live(isMuted: true, isCameraOff: true)]
        }
    }

    /// `pip-speaker`: a portrait remote speaker as the PiP target (720 x 1280 decoded, bounds in window px).
    static let pipTarget = PipTargetFrame(slotId: "p:fixture-speaker", left: 0, top: 0, right: 1080, bottom: 1920,
                                          videoWidth: 720, videoHeight: 1280)

    /// States that end with a system hold (the hold command, not an input).
    static func holdsAfterInputs(_ state: SystemFixtureState) -> Bool {
        state == .presenceOnHold
    }

    private static func live(isMuted: Bool, isCameraOff: Bool) -> CallPresenceInputs {
        CallPresenceInputs.make(
            callSession: 1,
            sessionPhase: .inCall,
            roomLabel: roomLabel,
            isMuted: isMuted,
            isCameraOff: isCameraOff,
            joinedAtMillis: joinedAtMillis
        )
    }
}

/// SX1 Debug readouts. Each key is one element of the fixture overlay with that `accessibilityIdentifier` or
/// `testTag` and an ASCII machine-readable value.
enum SystemFixtureReadout {
    static let presenceKey = "sys.presence"
    static let commandsKey = "sys.commands"

    /// `phase/surface/status/presenceSession`.
    static func presence(_ snapshot: CallPresenceSnapshot) -> String {
        "\(snapshot.phase.rawValue)/\(snapshot.surface.rawValue)/\(snapshot.surfaceStatus.rawValue)/\(snapshot.presenceSession)"
    }

    /// The last five `kind:source:result`, newest last, comma separated ("none" when empty).
    static func commands(_ log: [String]) -> String {
        log.isEmpty ? "none" : log.joined(separator: ",")
    }
}

/// A standalone `CallPresence` with scripted phases and commands for the system fixture. It drives the real
/// adapters and never WebRTC, audio, capture or the network: commands are recorded, never dispatched to a call.
/// The root hook that starts it is the Debug seam in `ConclaveApp.swift` and `Main.kt` (HD request B1-T2).
@MainActor
@Observable
final class SystemFixtureSession {
    let presence = CallPresence()
    let state: SystemFixtureState
    let providerMode: SystemFixtureProviderMode
    private(set) var presenceReadout = "idle/none/inactive/0"
    private(set) var commandsReadout = "none"
    @ObservationIgnored private(set) var dispatchedCommands: [SystemCallCommand] = []

    init(state: SystemFixtureState, providerMode: SystemFixtureProviderMode = .fake) {
        self.state = state
        self.providerMode = providerMode
    }

    /// Applies the script. Call after the platform adapters are installed on `presence`.
    func start() {
        presence.onCommand = { [weak self] command in
            self?.dispatchedCommands.append(command)
        }
        for step in SystemFixtureScript.inputs(for: state) {
            presence.apply(step)
        }
        if SystemFixtureScript.holdsAfterInputs(state) {
            presence.handle(.hold, source: .system, presenceSession: presence.snapshot.presenceSession)
        }
        if state == .pipSpeaker {
            presence.reportPipTarget(SystemFixtureScript.pipTarget)
        }
        refreshReadouts()
    }

    /// A scripted system command (fixture buttons), keyed on the current presence session.
    @discardableResult
    func send(_ kind: SystemCallCommandKind, source: SystemCallSource) -> SystemCommandResult {
        let result = presence.handle(kind, source: source, presenceSession: presence.snapshot.presenceSession)
        refreshReadouts()
        return result
    }

    func refreshReadouts() {
        let presenceValue = SystemFixtureReadout.presence(presence.snapshot)
        if presenceValue != presenceReadout {
            presenceReadout = presenceValue
        }
        let commandsValue = SystemFixtureReadout.commands(presence.commandLog)
        if commandsValue != commandsReadout {
            commandsReadout = commandsValue
        }
    }
}
