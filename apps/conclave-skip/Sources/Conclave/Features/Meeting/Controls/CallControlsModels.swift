import Foundation

enum ControlBarComposition: String, CaseIterable, Equatable {
    case compact, wide, attendee
}

enum ControlBarAxis: String, CaseIterable, Equatable {
    case horizontal, vertical
}

enum CallControlKind: String, CaseIterable, Equatable {
    case microphone, camera, screenShare, hand, chat, participants, qa, more, leave
}

enum CallControlVisual: String, CaseIterable, Equatable {
    case off, on, engaged
}

enum ControlBlockedReason: String, CaseIterable, Equatable {
    case none, notJoined, reconnecting, offline, attendee, audioOnly, remoteShareActive, unsupported
    case hostOnly, leaving, disabledByHost, permissionDenied, permissionUndetermined, ending
    case audioInterrupted, onHold
}

struct CallControlModel: Equatable, Identifiable {

    let id: String
    let kind: CallControlKind

    let isOn: Bool

    let visual: CallControlVisual

    let isBlocked: Bool

    let isPending: Bool

    let reason: ControlBlockedReason

    let reasonName: String

    let appliesAfterReconnect: Bool

    let badgeCount: Int

    let showsDot: Bool

    let hasShortcut: Bool
}

struct ControlBarSnapshot: Equatable {
    let revision: Int
    let composition: ControlBarComposition
    let axis: ControlBarAxis

    let controls: [CallControlModel]

    static let empty = ControlBarSnapshot(revision: 0, composition: ControlBarComposition.compact,
                                          axis: ControlBarAxis.horizontal, controls: [])

    func withRevision(_ next: Int) -> ControlBarSnapshot {
        ControlBarSnapshot(revision: next, composition: composition, axis: axis, controls: controls)
    }

    func control(_ kind: CallControlKind) -> CallControlModel? {
        for model in controls {
            if model.kind == kind { return model }
        }
        return nil
    }
}

enum ControlTapResult: String, CaseIterable, Equatable {
    case dispatched, explained, ignored
}

enum LeavePhase: String, CaseIterable, Equatable {
    case idle, leaving
}

enum EndPhase: String, CaseIterable, Equatable {
    case idle, confirming, ending, failed, postingRecap
}

struct LeaveSnapshot: Equatable {
    let revision: Int

    let canEndForEveryone: Bool
    let leavePhase: LeavePhase
    let endPhase: EndPhase

    let confirmationId: Int

    let confirmationInvoker: String

    let offersRecap: Bool

    let endFailure: String

    let showsEndForEveryone: Bool

    let endBlockedReason: ControlBlockedReason

    static let idle = LeaveSnapshot(revision: 0, canEndForEveryone: false, leavePhase: LeavePhase.idle, endPhase: EndPhase.idle,
                                    confirmationId: 0, confirmationInvoker: "", offersRecap: false, endFailure: "none",
                                    showsEndForEveryone: false, endBlockedReason: ControlBlockedReason.none)

    func withRevision(_ next: Int) -> LeaveSnapshot {
        LeaveSnapshot(revision: next, canEndForEveryone: canEndForEveryone, leavePhase: leavePhase, endPhase: endPhase,
                      confirmationId: confirmationId, confirmationInvoker: confirmationInvoker, offersRecap: offersRecap,
                      endFailure: endFailure, showsEndForEveryone: showsEndForEveryone, endBlockedReason: endBlockedReason)
    }
}

enum ControlsWindowClass: String, CaseIterable, Equatable {
    case compact, regular
}

struct ControlBarLayout: Equatable {
    let composition: ControlBarComposition
    let axis: ControlBarAxis
}

struct ControlExplanation: Equatable {
    let id: Int
    let kind: CallControlKind
    let reason: ControlBlockedReason
    let reasonName: String
    let actionId: String
}

enum ControlPermissionKind: String, CaseIterable, Equatable {
    case microphone, camera
}

struct ControlPermissionPrompt: Equatable {
    let id: Int
    let kind: ControlPermissionKind
}

enum CallControlsCommand: String, CaseIterable, Equatable {
    case requestMicrophonePermission, requestCameraPermission
}

enum CallControlsRequestKind: String, CaseIterable, Equatable {
    case sendReaction, setCaptions, setLayoutMode, flipCamera, setRoomLock, showSystemVideoEffects, showSystemMicrophoneModes
}

struct CallControlsRequest: Equatable {
    let kind: CallControlsRequestKind
    let value: String

    static let on = "on"
    static let off = "off"

    static func make(_ kind: CallControlsRequestKind, value: String = "") -> CallControlsRequest {
        CallControlsRequest(kind: kind, value: value)
    }
}

struct CallControlsInputs: Equatable {
    let callSession: Int

    let rows: [MeetingControlRow]
    let phase: MeetingPhaseKind
    let notice: MeetingNoticeKind
    let isLocalHost: Bool
    let isWebinarAttendee: Bool
    let canEndForEveryone: Bool

    let confirmationId: Int
    let confirmationInvoker: String
    let roomLabel: String
    let roomId: String

    let currentPanel: String

    let presenterName: String

    let isMicDisabledByHost: Bool
    let isCameraDisabledByHost: Bool

    let isWebinarQaEnabled: Bool
    let webinarQaUnseen: Int

    let attendeeCanRaiseHand: Bool

    let moreAttention: Bool

    let isRoomLocked: Bool
    let isWebinarEnabled: Bool
    let isBrowserActive: Bool
    let activeAppId: String
    let hasOpenVote: Bool
    let layoutMode: String

    let meetingLink: String

    let captionsOn: Bool
    let liveNotes: LiveNotesState

    let isGameActive: Bool
    let gameName: String

    let canFlipCamera: Bool
    let isFlipInFlight: Bool

    let effectsPanelAvailable: Bool
    let canShowSystemVideoEffects: Bool

    let isRoomLockPending: Bool
    let roomLockRequestedOn: Bool

    static func make(
        callSession: Int = 0,
        rows: [MeetingControlRow] = [],
        phase: MeetingPhaseKind = MeetingPhaseKind.home,
        notice: MeetingNoticeKind = MeetingNoticeKind.none,
        isLocalHost: Bool = false,
        isWebinarAttendee: Bool = false,
        canEndForEveryone: Bool = false,
        confirmationId: Int = 0,
        confirmationInvoker: String = "",
        roomLabel: String = "",
        roomId: String = "",
        currentPanel: String = "",
        presenterName: String = "",
        isMicDisabledByHost: Bool = false,
        isCameraDisabledByHost: Bool = false,
        isWebinarQaEnabled: Bool = false,
        webinarQaUnseen: Int = 0,
        attendeeCanRaiseHand: Bool = false,
        moreAttention: Bool = false,
        isRoomLocked: Bool = false,
        isWebinarEnabled: Bool = false,
        isBrowserActive: Bool = false,
        activeAppId: String = "",
        hasOpenVote: Bool = false,
        layoutMode: String = "auto",
        meetingLink: String = "",
        captionsOn: Bool = false,
        liveNotes: LiveNotesState = LiveNotesState.off,
        isGameActive: Bool = false,
        gameName: String = "",
        canFlipCamera: Bool = false,
        isFlipInFlight: Bool = false,
        effectsPanelAvailable: Bool = false,
        canShowSystemVideoEffects: Bool = false,
        isRoomLockPending: Bool = false,
        roomLockRequestedOn: Bool = false
    ) -> CallControlsInputs {
        CallControlsInputs(callSession: callSession, rows: rows, phase: phase, notice: notice, isLocalHost: isLocalHost,
                           isWebinarAttendee: isWebinarAttendee, canEndForEveryone: canEndForEveryone,
                           confirmationId: confirmationId, confirmationInvoker: confirmationInvoker, roomLabel: roomLabel,
                           roomId: roomId, currentPanel: currentPanel, presenterName: presenterName,
                           isMicDisabledByHost: isMicDisabledByHost, isCameraDisabledByHost: isCameraDisabledByHost,
                           isWebinarQaEnabled: isWebinarQaEnabled, webinarQaUnseen: webinarQaUnseen,
                           attendeeCanRaiseHand: attendeeCanRaiseHand, moreAttention: moreAttention,
                           isRoomLocked: isRoomLocked, isWebinarEnabled: isWebinarEnabled, isBrowserActive: isBrowserActive,
                           activeAppId: activeAppId, hasOpenVote: hasOpenVote, layoutMode: layoutMode,
                           meetingLink: meetingLink, captionsOn: captionsOn, liveNotes: liveNotes, isGameActive: isGameActive,
                           gameName: gameName, canFlipCamera: canFlipCamera, isFlipInFlight: isFlipInFlight,
                           effectsPanelAvailable: effectsPanelAvailable, canShowSystemVideoEffects: canShowSystemVideoEffects,
                           isRoomLockPending: isRoomLockPending, roomLockRequestedOn: roomLockRequestedOn)
    }

    @MainActor
    static func fromShell(
        _ shell: MeetingShellPresenter,
        presenterName: String = "",
        isMicDisabledByHost: Bool = false,
        isCameraDisabledByHost: Bool = false,
        isWebinarQaEnabled: Bool = false,
        webinarQaUnseen: Int = 0,
        attendeeCanRaiseHand: Bool = false,
        moreAttention: Bool = false,
        isRoomLocked: Bool = false,
        isWebinarEnabled: Bool = false,
        isBrowserActive: Bool = false,
        activeAppId: String = "",
        hasOpenVote: Bool = false,
        layoutMode: String = "auto",
        meetingLink: String = "",
        captionsOn: Bool = false,
        liveNotes: LiveNotesState = LiveNotesState.off,
        isGameActive: Bool = false,
        gameName: String = "",
        canFlipCamera: Bool = false,
        isFlipInFlight: Bool = false,
        effectsPanelAvailable: Bool = false,
        canShowSystemVideoEffects: Bool = false,
        isRoomLockPending: Bool = false,
        roomLockRequestedOn: Bool = false
    ) -> CallControlsInputs {
        let session = shell.session
        let confirmation = session.confirmation
        return make(callSession: session.identity.callSession, rows: shell.controls.rows, phase: session.phase,
                    notice: session.notice, isLocalHost: session.isLocalHost, isWebinarAttendee: session.isWebinarAttendee,
                    canEndForEveryone: session.canEndForEveryone, confirmationId: confirmation?.id ?? 0,
                    confirmationInvoker: confirmation?.invoker ?? "", roomLabel: session.roomLabel,
                    roomId: shell.entry.roomId, currentPanel: shell.panels.currentPanelName, presenterName: presenterName,
                    isMicDisabledByHost: isMicDisabledByHost, isCameraDisabledByHost: isCameraDisabledByHost,
                    isWebinarQaEnabled: isWebinarQaEnabled, webinarQaUnseen: webinarQaUnseen,
                    attendeeCanRaiseHand: attendeeCanRaiseHand, moreAttention: moreAttention, isRoomLocked: isRoomLocked,
                    isWebinarEnabled: isWebinarEnabled, isBrowserActive: isBrowserActive, activeAppId: activeAppId,
                    hasOpenVote: hasOpenVote, layoutMode: layoutMode, meetingLink: meetingLink, captionsOn: captionsOn,
                    liveNotes: liveNotes, isGameActive: isGameActive, gameName: gameName, canFlipCamera: canFlipCamera,
                    isFlipInFlight: isFlipInFlight, effectsPanelAvailable: effectsPanelAvailable,
                    canShowSystemVideoEffects: canShowSystemVideoEffects, isRoomLockPending: isRoomLockPending,
                    roomLockRequestedOn: roomLockRequestedOn)
    }

    @MainActor
    func refreshed(from shell: MeetingShellPresenter) -> CallControlsInputs {
        CallControlsInputs.fromShell(shell, presenterName: presenterName, isMicDisabledByHost: isMicDisabledByHost,
                                     isCameraDisabledByHost: isCameraDisabledByHost, isWebinarQaEnabled: isWebinarQaEnabled,
                                     webinarQaUnseen: webinarQaUnseen, attendeeCanRaiseHand: attendeeCanRaiseHand,
                                     moreAttention: moreAttention, isRoomLocked: isRoomLocked, isWebinarEnabled: isWebinarEnabled,
                                     isBrowserActive: isBrowserActive, activeAppId: activeAppId, hasOpenVote: hasOpenVote,
                                     layoutMode: layoutMode, meetingLink: meetingLink, captionsOn: captionsOn, liveNotes: liveNotes,
                                     isGameActive: isGameActive, gameName: gameName, canFlipCamera: canFlipCamera,
                                     isFlipInFlight: isFlipInFlight, effectsPanelAvailable: effectsPanelAvailable,
                                     canShowSystemVideoEffects: canShowSystemVideoEffects, isRoomLockPending: isRoomLockPending,
                                     roomLockRequestedOn: roomLockRequestedOn)
    }

    func row(_ id: MeetingControlID) -> MeetingControlRow? {
        for row in rows {
            if row.id == id.rawValue { return row }
        }
        return nil
    }
}
