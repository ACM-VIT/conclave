import Foundation

// S70 0.5 CallPresence contract types (SYS-1). Transpiled to Kotlin, so String raw-value enums and scalar structs
// only; every system adapter (CallKit on iOS, the CallStyle notification service on Android) and the Debug readout
// read the one snapshot below.

enum CallPresencePhase: String, CaseIterable, Equatable {
    case idle, waiting, connecting, live, recovering, onHold, ending
}

enum CallSystemSurfaceKind: String, CaseIterable, Equatable {
    case none, callKit, androidNotification, androidTelecom
}

/// `blocked`: the Android notification channel or permission is off.
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

/// S20 slot bounds plus the decoded frame size of the PiP target (R70-10). Window px on Android, pt on iOS; the frame
/// size is 0 until the target's first frame.
struct PipTargetFrame: Equatable {
    let slotId: String
    let left: Double
    let top: Double
    let right: Double
    let bottom: Double
    let videoWidth: Int
    let videoHeight: Int

    /// The slot is laid out (a target behind an activity or past the cap keeps zero bounds: no source rectangle).
    var hasBounds: Bool { right > left && bottom > top }

    /// The target renderer reported its first decoded frame (S70 R70-10).
    var hasVideoSize: Bool { videoWidth > 0 && videoHeight > 0 }

    /// A share is shown fit, a camera fill (S20 13 d).
    var isShare: Bool { slotId.hasPrefix("share:") }
}

/// S70 8 c, 8 d and 0.5 (SYS-8; RECONCILE R25, S70 R70-5): whether the camera keeps capturing while the person is
/// outside Conclave. It drives the S40 D23 camera line, so the line disappears by itself once continuity exists.
/// iOS: multitasking camera access is enabled and PiP is eligible or showing (3 c). Android: the call service holds
/// the `camera` foreground-service type (1 d). Never with the camera off (an attendee has no camera).
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

    /// The S40 D23 line "Your camera pauses while you're outside Conclave.": only with the camera on and no
    /// continuity (S70 8 f: camera off never shows it; camera on with continuity never shows it).
    static func showsCameraLine(isCameraOn: Bool, cameraContinuesInBackground: Bool) -> Bool {
        isCameraOn && !cameraContinuesInBackground
    }
}

struct CallPresenceSnapshot: Equatable {
    let revision: Int
    /// CallPresence's own counter: it increments when the phase leaves `idle` and is kept across a same-room server
    /// redirect, so the CallKit UUID and every posted Android intent stay valid. Every system command carries it.
    let presenceSession: Int
    /// The S1 call session, for diagnostics only.
    let callSession: Int
    let phase: CallPresencePhase
    /// The S1 room label (WP7 adds the webinar title).
    let title: String
    let roomId: String
    /// 0 until live; stable across recovery rejoins of one call.
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
    /// Drives the S40 D23 camera line (S70 8).
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

    /// True while a system surface should show a call (every phase but `idle`).
    var isActive: Bool { phase != .idle }

    /// The snapshot with a new revision; everything else unchanged.
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

/// `system`: task removal or app termination.
enum SystemCallSource: String, CaseIterable, Equatable {
    case callKit, notification, pictureInPicture, headset, telecom, system
}

/// Adapters fulfill on `dispatched` and `alreadyInEffect` and fail otherwise.
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

/// What the core pushes into `CallPresence.apply(_:)` (S70 0.5 inputs table, S1C 3.2 format). Built by the view model
/// from the S1 session snapshot (`MeetingShellPresenter.session`) and the media fields; the route owner, the PiP
/// adapters and the stage report the rest through `CallPresence.report*` (SY3, SY7, S20).
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
    /// A mute owns the microphone guard (or an unmute is in flight): an unmute command is then a duplicate.
    let isMicrophonePending: Bool
    let isAppActive: Bool
    let multitaskingCameraAccessEnabled: Bool
    /// Set by the redirect path before the new call session starts (R70-11): presence keeps its session and UUID.
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

/// S70 0.5 phase mapping from the S1 session phase.
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

    /// Phases in which a call is still being joined or held (not idle and not ending).
    static func isCallInProgress(_ phase: CallPresencePhase) -> Bool {
        switch phase {
        case .waiting, .connecting, .live, .recovering, .onHold:
            return true
        case .idle, .ending:
            return false
        }
    }
}

/// S70 0.5 command table: one result for every system source, before anything is dispatched.
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
            // Every CallKit echo of an in-app mute lands here. A mute is never dropped (WP2-S1c).
            if snapshot.isMuted { return .alreadyInEffect }
            return CallPresencePhasePolicy.isCallInProgress(phase) ? .dispatched : .unavailable
        case .unmute:
            if !snapshot.isMuted { return .alreadyInEffect }
            guard CallPresencePhasePolicy.isCallInProgress(phase) else { return .unavailable }
            if snapshot.isAttendee { return .unavailable }
            // Interim until S10 0.8 C1 (setEntryMediaIntent) lands with ENT-1: the lobby toggle is the only place
            // that turns the microphone on before admission, so a system unmute fails back (fail closed).
            if phase == .waiting || phase == .connecting { return .unavailable }
            // A mute owns the guard: fail closed, the system stays muted.
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
