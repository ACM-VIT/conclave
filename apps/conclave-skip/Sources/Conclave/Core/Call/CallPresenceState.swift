import Foundation

enum CallPresencePhase: String, CaseIterable, Equatable {
    case idle, waiting, connecting, live, recovering, onHold, ending
}

enum CallSystemSurfaceKind: String, CaseIterable, Equatable {
    case none, callKit, androidNotification, androidTelecom
}

enum CallSurfaceStatus: String, CaseIterable, Equatable {
    case inactive, starting, active, refused, blocked
}

enum CallEndReason: String, CaseIterable, Equatable {
    case none, userLeft, endedByHost, removed, denied, connectionLost, serverDisconnected, joinFailed, cancelledWhileWaiting
}

enum AudioInterruptionKind: String, CaseIterable, Equatable {
    case none, otherAudio, held, deviceMicMuted, servicesReset
}

enum PipAvailability: String, CaseIterable, Equatable {
    case unsupported, disabledByUser, notEligible, eligible, suppressed, active
}

struct PipTargetFrame: Equatable {
    let slotId: String
    let left: Double
    let top: Double
    let right: Double
    let bottom: Double
    let videoWidth: Int
    let videoHeight: Int

    var hasBounds: Bool { right > left && bottom > top }

    var hasVideoSize: Bool { videoWidth > 0 && videoHeight > 0 }

    var isShare: Bool { slotId.hasPrefix("share:") }
}

enum CameraContinuityPolicy {
    static func continuesInBackground(
        isCameraOn: Bool,
        multitaskingCameraAccessEnabled: Bool,
        pip: PipAvailability,
        foregroundServiceHoldsCamera: Bool
    ) -> Bool {
        if !isCameraOn { return false }
        if foregroundServiceHoldsCamera { return true }
        return multitaskingCameraAccessEnabled && (pip == .eligible || pip == .active)
    }

    static func showsCameraLine(isCameraOn: Bool, cameraContinuesInBackground: Bool) -> Bool {
        isCameraOn && !cameraContinuesInBackground
    }
}

struct CallPresenceSnapshot: Equatable {
    let revision: Int

    let presenceSession: Int

    let callSession: Int
    let phase: CallPresencePhase

    let title: String
    let roomId: String

    let joinedAtMillis: Double
    let isMuted: Bool
    let isCameraOn: Bool
    let isPresenting: Bool
    let isAttendee: Bool
    let surface: CallSystemSurfaceKind
    let surfaceStatus: CallSurfaceStatus
    let interruption: AudioInterruptionKind
    let pip: PipAvailability
    let isInPictureInPicture: Bool
    let pipTarget: PipTargetFrame?
    let keepsScreenAwake: Bool
    let proximityArmed: Bool

    let cameraContinuesInBackground: Bool
    let endReason: CallEndReason

    static let idle = CallPresenceSnapshot(
        revision: 0,
        presenceSession: 0,
        callSession: 0,
        phase: .idle,
        title: "",
        roomId: "",
        joinedAtMillis: 0,
        isMuted: true,
        isCameraOn: false,
        isPresenting: false,
        isAttendee: false,
        surface: .none,
        surfaceStatus: .inactive,
        interruption: .none,
        pip: .unsupported,
        isInPictureInPicture: false,
        pipTarget: nil,
        keepsScreenAwake: false,
        proximityArmed: false,
        cameraContinuesInBackground: false,
        endReason: .none
    )

    var isActive: Bool { phase != .idle }

    func withRevision(_ value: Int) -> CallPresenceSnapshot {
        CallPresenceSnapshot(
            revision: value, presenceSession: presenceSession, callSession: callSession, phase: phase,
            title: title, roomId: roomId, joinedAtMillis: joinedAtMillis,
            isMuted: isMuted, isCameraOn: isCameraOn, isPresenting: isPresenting, isAttendee: isAttendee,
            surface: surface, surfaceStatus: surfaceStatus, interruption: interruption,
            pip: pip, isInPictureInPicture: isInPictureInPicture, pipTarget: pipTarget,
            keepsScreenAwake: keepsScreenAwake, proximityArmed: proximityArmed,
            cameraContinuesInBackground: cameraContinuesInBackground, endReason: endReason
        )
    }
}

enum SystemCallCommandKind: String, CaseIterable, Equatable {
    case mute, unmute, leave, hold, resume, returnToCall
}

enum SystemCallSource: String, CaseIterable, Equatable {
    case callKit, notification, pictureInPicture, headset, telecom, system
}

enum SystemCommandResult: String, CaseIterable, Equatable {
    case dispatched, alreadyInEffect, duplicate, unavailable, stale

    var fulfillsSystemAction: Bool {
        self == .dispatched || self == .alreadyInEffect
    }
}

struct SystemCallCommand: Equatable {
    let kind: SystemCallCommandKind
    let source: SystemCallSource
    let presenceSession: Int
}

struct CallPresenceInputs: Equatable {
    let callSession: Int
    let sessionPhase: MeetingPhaseKind
    let outcome: MeetingTerminalOutcomeKind?
    let roomLabel: String
    let isWebinarAttendee: Bool
    let isMuted: Bool
    let isCameraOff: Bool
    let isScreenSharing: Bool
    let joinedAtMillis: Double

    let isMicrophonePending: Bool
    let isAppActive: Bool
    let multitaskingCameraAccessEnabled: Bool

    let isRedirectContinuation: Bool

    static func make(
        callSession: Int = 0,
        sessionPhase: MeetingPhaseKind = .home,
        outcome: MeetingTerminalOutcomeKind? = nil,
        roomLabel: String = "",
        isWebinarAttendee: Bool = false,
        isMuted: Bool = true,
        isCameraOff: Bool = true,
        isScreenSharing: Bool = false,
        joinedAtMillis: Double = 0,
        isMicrophonePending: Bool = false,
        isAppActive: Bool = true,
        multitaskingCameraAccessEnabled: Bool = false,
        isRedirectContinuation: Bool = false
    ) -> CallPresenceInputs {
        CallPresenceInputs(
            callSession: callSession,
            sessionPhase: sessionPhase,
            outcome: outcome,
            roomLabel: roomLabel,
            isWebinarAttendee: isWebinarAttendee,
            isMuted: isMuted,
            isCameraOff: isCameraOff,
            isScreenSharing: isScreenSharing,
            joinedAtMillis: joinedAtMillis,
            isMicrophonePending: isMicrophonePending,
            isAppActive: isAppActive,
            multitaskingCameraAccessEnabled: multitaskingCameraAccessEnabled,
            isRedirectContinuation: isRedirectContinuation
        )
    }
}

enum CallPresencePhasePolicy {
    static func phase(sessionPhase: MeetingPhaseKind, interruption: AudioInterruptionKind) -> CallPresencePhase {
        switch sessionPhase {
        case .home, .outcome:
            return .idle
        case .entering:
            return .connecting
        case .waiting:
            return .waiting
        case .inCall:
            return interruption == .held ? .onHold : .live
        case .recovering:
            return .recovering
        case .leaving:
            return .ending
        }
    }

    static func isCallInProgress(_ phase: CallPresencePhase) -> Bool {
        switch phase {
        case .waiting, .connecting, .live, .recovering, .onHold:
            return true
        case .idle, .ending:
            return false
        }
    }
}

enum SystemCallCommandPolicy {
    static func result(
        _ command: SystemCallCommand,
        snapshot: CallPresenceSnapshot,
        isMicrophonePending: Bool
    ) -> SystemCommandResult {
        guard command.presenceSession == snapshot.presenceSession else { return .stale }
        let phase = snapshot.phase
        switch command.kind {
        case .mute:

            if snapshot.isMuted { return .alreadyInEffect }
            return CallPresencePhasePolicy.isCallInProgress(phase) ? .dispatched : .unavailable
        case .unmute:
            if !snapshot.isMuted { return .alreadyInEffect }
            guard CallPresencePhasePolicy.isCallInProgress(phase) else { return .unavailable }
            if snapshot.isAttendee { return .unavailable }
            if phase == .onHold || snapshot.interruption != .none { return .unavailable }

            if phase == .waiting || phase == .connecting { return .unavailable }

            if isMicrophonePending { return .duplicate }
            return .dispatched
        case .leave:
            if phase == .idle || phase == .ending { return .alreadyInEffect }
            return .dispatched
        case .hold, .resume, .returnToCall:
            return CallPresencePhasePolicy.isCallInProgress(phase) ? .dispatched : .unavailable
        }
    }
}
