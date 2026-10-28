import Foundation
import Observation

@MainActor
final class CallPresenceAdapter {
    let name: String
    let presenceDidChange: (CallPresenceSnapshot, CallPresenceSnapshot) -> Void

    init(name: String, presenceDidChange: @escaping (CallPresenceSnapshot, CallPresenceSnapshot) -> Void) {
        self.name = name
        self.presenceDidChange = presenceDidChange
    }
}

@MainActor
final class CallPresenceAdapters {
    let adapters: [CallPresenceAdapter]

    init(_ adapters: [CallPresenceAdapter]) {
        self.adapters = adapters
    }

    static func none() -> CallPresenceAdapters {
        CallPresenceAdapters([])
    }

    static func single(_ adapter: CallPresenceAdapter) -> CallPresenceAdapters {
        CallPresenceAdapters([adapter])
    }

    func presenceDidChange(from old: CallPresenceSnapshot, to new: CallPresenceSnapshot) {
        for adapter in adapters {
            adapter.presenceDidChange(old, new)
        }
    }
}

@MainActor
@Observable
final class CallPresence {
    private(set) var snapshot: CallPresenceSnapshot = CallPresenceSnapshot.idle

    @ObservationIgnored var adapters: CallPresenceAdapters = CallPresenceAdapters.none()

    @ObservationIgnored var onCommand: ((SystemCallCommand) -> Void)? = nil
    @ObservationIgnored private var inputs = CallPresenceInputs.make()
    @ObservationIgnored private var surface: CallSystemSurfaceKind = .none
    @ObservationIgnored private var surfaceStatus: CallSurfaceStatus = .inactive
    @ObservationIgnored private var interruption: AudioInterruptionKind = .none
    @ObservationIgnored private var pip: PipAvailability = .unsupported
    @ObservationIgnored private var isInPictureInPicture = false
    @ObservationIgnored private var foregroundServiceHoldsCamera = false
    @ObservationIgnored private var foregroundServiceHoldsMicrophone = false

    @ObservationIgnored private var pipTarget: PipTargetFrame? = nil

    @ObservationIgnored private var routeKind: AudioRouteKind = .unknown
    @ObservationIgnored private var presenceSessionCounter = 0
    @ObservationIgnored private var endReason: CallEndReason = .none
    @ObservationIgnored private var recentCommands: [String] = []
    @ObservationIgnored private var fanOutCount = 0
    @ObservationIgnored private var isFanningOut = false
    @ObservationIgnored private var needsRecompute = false

    var commandLog: [String] { recentCommands }

    var adapterFanOutCount: Int { fanOutCount }

    var holdsMicrophoneServiceType: Bool { foregroundServiceHoldsMicrophone }

    func apply(_ next: CallPresenceInputs) {
        guard next != inputs else { return }
        inputs = next
        recompute()
    }

    func reset() {
        inputs = CallPresenceInputs.make()
        interruption = .none
        isInPictureInPicture = false
        pipTarget = nil
        foregroundServiceHoldsCamera = false
        foregroundServiceHoldsMicrophone = false
        recompute()
    }

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

    func reportForegroundServiceTypes(microphone: Bool, camera: Bool) {
        guard foregroundServiceHoldsMicrophone != microphone || foregroundServiceHoldsCamera != camera else { return }
        foregroundServiceHoldsMicrophone = microphone
        foregroundServiceHoldsCamera = camera
        recompute()
    }

    func reportInterruption(_ kind: AudioInterruptionKind) {
        guard interruption != kind else { return }
        interruption = kind
        recompute()
    }

    func reportPictureInPicture(active: Bool, availability: PipAvailability) {
        guard isInPictureInPicture != active || pip != availability else { return }
        isInPictureInPicture = active
        pip = availability
        recompute()
    }

    func reportPipTarget(_ target: PipTargetFrame?) {
        guard pipTarget != target else { return }
        pipTarget = target
        recompute()
    }

    func reportAudioRoute(_ kind: AudioRouteKind) {
        guard routeKind != kind else { return }
        routeKind = kind
        recompute()
    }

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

            endReason = CallEndReasonPolicy.reason(outcome: inputs.outcome, phaseBeforeTeardown: current.phase)
        }
        if phase == .idle && interruption != .none {
            interruption = .none
        }

        var title = inputs.roomLabel
        if title.isEmpty && isInProgress && wasInProgress {

            title = current.title
        }
        let joinedAtMillis = isInProgress ? inputs.joinedAtMillis : current.joinedAtMillis
        let isCameraOn = !inputs.isCameraOff

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
            keepsScreenAwake: KeepAwakePolicy.keepsScreenAwake(phase: phase),

            proximityArmed: ProximityPolicy.armedInCall(
                phase: phase,
                route: routeKind,
                isCameraOn: isCameraOn,
                isPresenting: inputs.isScreenSharing,
                isInPip: isInPictureInPicture,
                isAppActive: inputs.isAppActive
            ),
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
