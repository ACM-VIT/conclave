import Foundation
import Observation

/// One system adapter: CallKit, the Android call notification service, keep awake, PiP, or a recording fake.
/// Adapters never observe the snapshot (the Android service, PiP manager and action receiver are not composables);
/// each diffs the fields it uses in `presenceDidChange`.
@MainActor
final class CallPresenceAdapter {
    let name: String
    let presenceDidChange: (CallPresenceSnapshot, CallPresenceSnapshot) -> Void

    init(name: String, presenceDidChange: @escaping (CallPresenceSnapshot, CallPresenceSnapshot) -> Void) {
        self.name = name
        self.presenceDidChange = presenceDidChange
    }
}

/// The adapter set the platform installs once (S70 0.5 fan-out). A class of closures rather than a protocol: the
/// transpiled shared code has no protocols (S1C 3.6), and handwritten Kotlin builds the set with lambdas.
@MainActor
final class CallPresenceAdapters {
    let adapters: [CallPresenceAdapter]

    init(_ adapters: [CallPresenceAdapter]) {
        self.adapters = adapters
    }

    static func none() -> CallPresenceAdapters {
        CallPresenceAdapters([])
    }

    /// One adapter (handwritten Kotlin builds its set with this instead of a Skip array).
    static func single(_ adapter: CallPresenceAdapter) -> CallPresenceAdapters {
        CallPresenceAdapters([adapter])
    }

    func presenceDidChange(from old: CallPresenceSnapshot, to new: CallPresenceSnapshot) {
        for adapter in adapters {
            adapter.presenceDidChange(old, new)
        }
    }
}

/// S70 0.5 `CallPresence` (SYS-1): one session-owned service that replaces the implicit presence gate with one
/// snapshot and one entry for commands from system surfaces. It follows the S1 pattern: pushed inputs, `apply(_:)`
/// equality-guarded, no self-observation, String raw-value enums and scalar structs for Kotlin.
///
/// No view reads `snapshot`; presenters get the one or two fields they need as their own inputs (F00 P2, P3).
/// `apply(_:)` and the `report*` calls compute the next snapshot; if it differs they bump `revision`, store it and
/// synchronously call `adapters.presenceDidChange(from:to:)` once.
@MainActor
@Observable
final class CallPresence {
    private(set) var snapshot: CallPresenceSnapshot = CallPresenceSnapshot.idle
    /// No-op set until the platform installs its set once; adapters never observe.
    @ObservationIgnored var adapters: CallPresenceAdapters = CallPresenceAdapters.none()
    /// Core only: receives every command that returned `dispatched` (S1 `toggleMicrophone()`, `leave()`, the hold
    /// rules, `returnToCall`). Never called for any other result.
    @ObservationIgnored var onCommand: ((SystemCallCommand) -> Void)? = nil
    @ObservationIgnored private var inputs = CallPresenceInputs.make()
    @ObservationIgnored private var surface: CallSystemSurfaceKind = .none
    @ObservationIgnored private var surfaceStatus: CallSurfaceStatus = .inactive
    @ObservationIgnored private var interruption: AudioInterruptionKind = .none
    @ObservationIgnored private var pip: PipAvailability = .unsupported
    @ObservationIgnored private var isInPictureInPicture = false
    @ObservationIgnored private var foregroundServiceHoldsCamera = false
    @ObservationIgnored private var foregroundServiceHoldsMicrophone = false
    /// S20 SC11 / S70 R70-10: the stage's PiP target (slot bounds plus the decoded frame size), reported by the view
    /// model from each changed `StageVisibilityReport`.
    @ObservationIgnored private var pipTarget: PipTargetFrame? = nil
    @ObservationIgnored private var presenceSessionCounter = 0
    @ObservationIgnored private var endReason: CallEndReason = .none
    @ObservationIgnored private var recentCommands: [String] = []
    @ObservationIgnored private var fanOutCount = 0
    @ObservationIgnored private var isFanningOut = false
    @ObservationIgnored private var needsRecompute = false

    /// The last five commands as `kind:source:result` (the `sys.commands` Debug readout, S70 SX1).
    var commandLog: [String] { recentCommands }

    /// How many times the adapters were notified (tests).
    var adapterFanOutCount: Int { fanOutCount }

    /// Whether the Android call service holds the microphone type (S70 1 d; diagnostics).
    var holdsMicrophoneServiceType: Bool { foregroundServiceHoldsMicrophone }

    // MARK: - Core

    func apply(_ next: CallPresenceInputs) {
        guard next != inputs else { return }
        inputs = next
        recompute()
    }

    /// With the S1 reset (S1C 3.3 TEAR): back to idle, keeping the session counter so an old intent stays stale.
    func reset() {
        inputs = CallPresenceInputs.make()
        interruption = .none
        isInPictureInPicture = false
        pipTarget = nil
        foregroundServiceHoldsCamera = false
        foregroundServiceHoldsMicrophone = false
        recompute()
    }

    // MARK: - System adapters

    @discardableResult
    func handle(_ command: SystemCallCommand) -> SystemCommandResult {
        let result = SystemCallCommandPolicy.result(
            command,
            snapshot: snapshot,
            isMicrophonePending: inputs.isMicrophonePending
        )
        recordCommand(command, result: result)
        guard result == .dispatched else { return result }
        switch command.kind {
        case .hold:
            interruption = .held
            recompute()
        case .resume:
            if interruption == .held {
                interruption = .none
                recompute()
            }
        case .mute, .unmute, .leave, .returnToCall:
            break
        }
        onCommand?(command)
        return result
    }

    /// The convenience overload every call site uses.
    @discardableResult
    func handle(_ kind: SystemCallCommandKind, source: SystemCallSource, presenceSession: Int) -> SystemCommandResult {
        handle(SystemCallCommand(kind: kind, source: source, presenceSession: presenceSession))
    }

    func reportSurface(_ kind: CallSystemSurfaceKind, status: CallSurfaceStatus) {
        guard surface != kind || surfaceStatus != status else { return }
        surface = kind
        surfaceStatus = status
        recompute()
    }

    /// Android call service only, after each `startForeground`.
    func reportForegroundServiceTypes(microphone: Bool, camera: Bool) {
        guard foregroundServiceHoldsMicrophone != microphone || foregroundServiceHoldsCamera != camera else { return }
        foregroundServiceHoldsMicrophone = microphone
        foregroundServiceHoldsCamera = camera
        recompute()
    }

    /// Route owner only (S70 5).
    func reportInterruption(_ kind: AudioInterruptionKind) {
        guard interruption != kind else { return }
        interruption = kind
        recompute()
    }

    /// PiP adapters only.
    func reportPictureInPicture(active: Bool, availability: PipAvailability) {
        guard isInPictureInPicture != active || pip != availability else { return }
        isInPictureInPicture = active
        pip = availability
        recompute()
    }

    /// The stage's PiP target (S70 0.5 inputs table: `pipTarget`); equality guarded, so an unchanged frame fans out
    /// nothing. Android params (3 d) and the iOS `preferredContentSize` (3 c) read it.
    func reportPipTarget(_ target: PipTargetFrame?) {
        guard pipTarget != target else { return }
        pipTarget = target
        recompute()
    }

    // MARK: - Snapshot

    /// Adapters may report back (a surface status, an echo) while they handle a change. Such a report is applied
    /// after the fan-out finishes, so every adapter sees the changes in order.
    private func recompute() {
        if isFanningOut {
            needsRecompute = true
            return
        }
        computeAndFanOut()
        while needsRecompute {
            needsRecompute = false
            computeAndFanOut()
        }
    }

    private func computeAndFanOut() {
        let current = snapshot
        var phase = CallPresencePhasePolicy.phase(sessionPhase: inputs.sessionPhase, interruption: interruption)
        let wasInProgress = CallPresencePhasePolicy.isCallInProgress(current.phase)
        if inputs.isRedirectContinuation && wasInProgress && !CallPresencePhasePolicy.isCallInProgress(phase) {
            // A same-room server redirect keeps the system call (R70-11): no end and restart, no timer flicker.
            phase = .connecting
        }
        let isInProgress = CallPresencePhasePolicy.isCallInProgress(phase)

        var presenceSession = current.presenceSession
        if isInProgress && !wasInProgress {
            presenceSessionCounter += 1
            presenceSession = presenceSessionCounter
            endReason = .none
        }
        if wasInProgress && !isInProgress {
            // Set before teardown, from the phase the call was in (S70 0.5 end-reason table).
            endReason = CallEndReasonPolicy.reason(outcome: inputs.outcome, phaseBeforeTeardown: current.phase)
        }
        if phase == .idle && interruption != .none {
            interruption = .none
        }

        var title = inputs.roomLabel
        if title.isEmpty && isInProgress && wasInProgress {
            // The redirect teardown clears the room id before the new join writes it.
            title = current.title
        }
        let joinedAtMillis = isInProgress ? inputs.joinedAtMillis : current.joinedAtMillis
        let isCameraOn = !inputs.isCameraOff
        // S70 8 c, 8 d: iOS needs multitasking camera access AND an eligible (or showing) PiP window; Android the
        // camera foreground-service type.
        let cameraContinues = CameraContinuityPolicy.continuesInBackground(
            isCameraOn: isCameraOn,
            multitaskingCameraAccessEnabled: inputs.multitaskingCameraAccessEnabled,
            pip: pip,
            foregroundServiceHoldsCamera: foregroundServiceHoldsCamera
        )

        let next = CallPresenceSnapshot(
            revision: current.revision,
            presenceSession: presenceSession,
            callSession: inputs.callSession,
            phase: phase,
            title: title,
            roomId: title,
            joinedAtMillis: joinedAtMillis,
            isMuted: inputs.isMuted,
            isCameraOn: isCameraOn,
            isPresenting: inputs.isScreenSharing,
            isAttendee: inputs.isWebinarAttendee,
            surface: surface,
            surfaceStatus: surfaceStatus,
            interruption: interruption,
            pip: pip,
            isInPictureInPicture: isInPictureInPicture,
            pipTarget: isInProgress ? pipTarget : nil,
            keepsScreenAwake: isInProgress,
            proximityArmed: false,
            cameraContinuesInBackground: cameraContinues,
            endReason: endReason
        )
        guard next != current else { return }
        let stored = next.withRevision(current.revision + 1)
        snapshot = stored
        fanOutCount += 1
        isFanningOut = true
        adapters.presenceDidChange(from: current, to: stored)
        isFanningOut = false
    }

    private func recordCommand(_ command: SystemCallCommand, result: SystemCommandResult) {
        recentCommands.append("\(command.kind.rawValue):\(command.source.rawValue):\(result.rawValue)")
        while recentCommands.count > 5 {
            recentCommands.removeFirst()
        }
    }
}
