import Foundation

// S30 0.5 shared controls contract (CTL-1). Everything here crosses into handwritten Kotlin, so it follows the S1C 3.6
// rules: String raw-value enums, scalar structs and arrays of structs, no associated values, no tuples, no protocols.
// Views read only these snapshots, never `MeetingState` or `MeetingViewModel` (F00 P1). Later slices extend the set:
// CTL-2 added the host menu facts to `LeaveSnapshot` (LeaveControlPolicy.swift reads them), CTL-3 the route snapshot,
// CTL-5 the More snapshot, menu metrics and keyboard commands (MoreMenuPolicy.swift), CTL-6 the reaction palette
// (ReactionPalettePolicy.swift); both add the More inputs below and the `CallControlsRequest` core requests.

/// Which controls the bar shows (S30 0.6): compact five on phones, wide eight from medium width (RECONCILE R7), the
/// webinar attendee three.
enum ControlBarComposition: String, CaseIterable, Equatable {
    case compact, wide, attendee
}

/// The vertical axis is the iPhone compact-height trailing stack only (S30 D27); Android keeps the bottom toolbar.
enum ControlBarAxis: String, CaseIterable, Equatable {
    case horizontal, vertical
}

enum CallControlKind: String, CaseIterable, Equatable {
    case microphone, camera, screenShare, hand, chat, participants, qa, more, leave
}

/// CL1: the transpiled twin of the iOS-only `ConclaveControlState` (PN A1); Android maps it to the R01 roles. Drawing
/// only: toggles bind to `isOn`, never to the visual.
enum CallControlVisual: String, CaseIterable, Equatable {
    case off, on, engaged
}

/// CL2: typed blocked reasons (S1 `MeetingBlockedReason` plus the CC2 and RECONCILE R29 cases, same raw values); the
/// copy is resolved per platform from the S30 7 table.
enum ControlBlockedReason: String, CaseIterable, Equatable {
    case none, notJoined, reconnecting, offline, attendee, audioOnly, remoteShareActive, unsupported
    case hostOnly, leaving, disabledByHost, permissionDenied, permissionUndetermined, ending
    case audioInterrupted, onHold
}

/// One bar control (S30 0.5, F00 C04 j).
struct CallControlModel: Equatable, Identifiable {
    /// `CallControlKind.rawValue`; stable across states.
    let id: String
    let kind: CallControlKind
    /// S1 `MeetingControlRow.isOn`: mic live, camera on, hand raised, sharing; invokers: their panel is current
    /// (CC18). Toggles bind to this, never to `visual`.
    let isOn: Bool
    /// Drawing only (`ControlBarPolicy.visual`): Mic and Camera on or off; Hand and Share engaged or on (never off,
    /// CL20); Chat, Participants and Q&A engaged while their panel is current; More and Leave on.
    let visual: CallControlVisual
    /// Disabled treatment; a tap explains instead of dispatching (S30 Q11, CL6). The control stays hit-testable.
    let isBlocked: Bool
    /// S1 row `isPending` (ledger ticket or view model in-flight flag).
    let isPending: Bool
    /// The reason the control is blocked or paused; `none` otherwise. A live microphone keeps `audioInterrupted` or
    /// `onHold` without being blocked (the value reads "Paused" or "On hold"; a tap toward muted still applies, R29).
    let reason: ControlBlockedReason
    /// The presenter's name for `remoteShareActive`; empty otherwise.
    let reasonName: String
    /// S1 `MeetingControlHint.appliesAfterReconnect`: media intent recorded during recovery or offline.
    let appliesAfterReconnect: Bool
    /// 0 hides: Chat unread; waiting count on Participants (wide) or More (compact); new questions on Q&A.
    let badgeCount: Int
    /// More only: something new behind it (unseen Q&A, an open vote, live notes needing attention).
    let showsDot: Bool
    /// Mic and Camera long press (CTL-4) and the host Leave menu (CTL-2).
    let hasShortcut: Bool
}

struct ControlBarSnapshot: Equatable {
    let revision: Int
    let composition: ControlBarComposition
    let axis: ControlBarAxis
    /// Fixed order per composition (S30 1 c); Leave always last.
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

/// Views play a gesture haptic only on `dispatched` (S30 1 h).
enum ControlTapResult: String, CaseIterable, Equatable {
    case dispatched, explained, ignored
}

enum LeavePhase: String, CaseIterable, Equatable {
    case idle, leaving
}

enum EndPhase: String, CaseIterable, Equatable {
    case idle, confirming, ending, failed, postingRecap
}

/// Read only by the Leave control, the host Leave menu and the End dialog (CTL-2). `leaveState`, never `leave`: a
/// stored `leave` next to `func leave()` is an invalid redeclaration (S30 0.5).
struct LeaveSnapshot: Equatable {
    let revision: Int
    /// S1 `session.canEndForEveryone`: a host who is not an attendee, joined and not recovering.
    let canEndForEveryone: Bool
    let leavePhase: LeavePhase
    let endPhase: EndPhase
    /// S1 `MeetingConfirmation.id`; 0 when none.
    let confirmationId: Int
    /// `MeetingConfirmationInvoker` value ("call", "more" or "hostControls"); the dialog belongs to that surface (R09,
    /// S50 PH17).
    let confirmationInvoker: String
    /// CC8; false until WP8 ships the recap (S30 Q6). TRN-2 (CC8) turns it on with the recap dialog variant.
    let offersRecap: Bool
    /// S1 `MeetingActionFailure` raw value of the End row; "none" when idle.
    let endFailure: String
    /// CTL-2: the host's End row exists (the S1 `endForEveryone` row is visible: a host who is not an attendee), so the
    /// host Leave menu and the More row show, even while End itself is blocked (S30 4 f Recovering row). False for
    /// guests and attendees.
    let showsEndForEveryone: Bool
    /// CTL-2: why End cannot be asked for right now, the S1 End row reason in the controls vocabulary: `none` when it
    /// can; `ending` while the End ticket is in flight; `reconnecting` or `offline` (S30 4 f, 7); `leaving`.
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

/// The window classes the view reports (`setWindow`): iOS size classes; Android 600 dp wide and 480 dp tall (Q13).
enum ControlsWindowClass: String, CaseIterable, Equatable {
    case compact, regular
}

/// The composition and axis the policy picks for a window.
struct ControlBarLayout: Equatable {
    let composition: ControlBarComposition
    let axis: ControlBarAxis
}

/// A blocked bar tap's explanation (CL6, S30 7 reason copy). One-shot: `id` grows per explanation and never resets, so
/// the same reason twice still reads as a change. The toast lane (STG-5, CC7) shows it; `actionId` is the S20
/// `NoticeAction` id the toast offers ("turnOffAudioOnly" for audio-only, "" for none).
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

/// A permission-denied tap opens the S10 7 alert ("Camera Access Is Off", Open Settings, Not Now) on the invoking
/// control instead of a toast (S30 7, 1 f). One-shot by `id`; the view dismisses it.
struct ControlPermissionPrompt: Equatable {
    let id: Int
    let kind: ControlPermissionKind
}

/// Core commands the controls cannot perform through S1 (the S1 `onCommand` pattern). A not-yet-determined permission
/// asks the system in context (S10 7 priming) once the WP3 permission provider reports the status.
enum CallControlsCommand: String, CaseIterable, Equatable {
    case requestMicrophonePermission, requestCameraPermission
}

/// CTL-5 and CTL-6: local actions the controls hand to the core with one value (the S30 0.5 mapping table). Kept apart
/// from `CallControlsCommand` so the core's exhaustive command switch is unaffected. `value` is the reaction wire value
/// (`sendReaction`), "on" or "off" (`setCaptions`, `setRoomLock`), a `MeetingViewMode` raw value (`setLayoutMode`), or ""
/// (`flipCamera`, `showSystemVideoEffects`).
enum CallControlsRequestKind: String, CaseIterable, Equatable {
    case sendReaction, setCaptions, setLayoutMode, flipCamera, setRoomLock, showSystemVideoEffects
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

/// The schema boundary between the core and the controls (S30 0.5, S1C 3.2 format): built by the view model's
/// `makeCallControlsInputs()` on its own refresh path (CC1) and pushed through `CallControlsPresenter.apply(_:)`. The
/// S1-derived fields come from the shell snapshots the view model just published (`fromShell`).
struct CallControlsInputs: Equatable {
    let callSession: Int
    /// S1 `controls.rows` (all nine ids, fixed order).
    let rows: [MeetingControlRow]
    let phase: MeetingPhaseKind
    let notice: MeetingNoticeKind
    let isLocalHost: Bool
    let isWebinarAttendee: Bool
    let canEndForEveryone: Bool
    /// S1 `session.confirmation`; 0 and "" when none.
    let confirmationId: Int
    let confirmationInvoker: String
    let roomLabel: String
    let roomId: String
    /// `PanelCoordinator.snapshot.current?.panel.rawValue ?? ""` (CC18): Engaged on Chat, Participants and Q&A.
    let currentPanel: String
    /// The presenter's display name for `remoteShareActive`; empty when nobody else shares.
    let presenterName: String
    /// CC10 (server policy, WP7): blocks a tap toward live with `disabledByHost`; false until the policy is published.
    let isMicDisabledByHost: Bool
    let isCameraDisabledByHost: Bool
    /// CC9 (WP7): the attendee Q&A control and its role-appropriate unseen counter (RECONCILE R18).
    let isWebinarQaEnabled: Bool
    let webinarQaUnseen: Int
    /// S20 Q10: the attendee hand capability (PPL-5); the attendee Raise Hand stays hidden until it is true.
    let attendeeCanRaiseHand: Bool
    /// More's dot (CTL-5 publishes the open vote, live notes attention and unseen Q&A); false until then.
    let moreAttention: Bool
    /// CC1 fields More reads (CTL-5): MS `isRoomLocked`, `isWebinarEnabled`, `isBrowserActive`, `activeAppId`,
    /// `gameVote != nil` and the `viewMode` raw value.
    let isRoomLocked: Bool
    let isWebinarEnabled: Bool
    let isBrowserActive: Bool
    let activeAppId: String
    let hasOpenVote: Bool
    let layoutMode: String
    /// CTL-5 (S30 5 j, RECONCILE R50): the S20 SC23 `MeetingLinkBuilder` link (`MeetingState.meetingLink(for:clientId:)`,
    /// with `?clientId=` for a non-default tenant); "" when the trimmed room id is empty, which hides Invite and Copy Link.
    let meetingLink: String
    /// CTL-5 (S20 SC13, WP8): the local captions preference and the live notes state (Captions and Transcript rows).
    let captionsOn: Bool
    let liveNotes: LiveNotesState
    /// CTL-5 (S20 SC1 E4 game hook): a game is running and its display name (the Activities status line).
    let isGameActive: Bool
    let gameName: String
    /// CTL-5 (S30 5 f row 6): the device can flip the camera (it can switch, not audio-only, publishing allowed),
    /// independent of the connection, so the row stays in place while recovering (R10); and a flip is in flight.
    let canFlipCamera: Bool
    let isFlipInFlight: Bool
    /// CTL-5 (CC11, WP8; RECONCILE OQ6 default A): the native Effects panel exists, and (iOS) the system video effects
    /// module can open while the camera runs. Both false in this push, so neither row shows.
    let effectsPanelAvailable: Bool
    let canShowSystemVideoEffects: Bool
    /// CTL-5 (S30 5 f row 18): the S50 host-actions owner's pending Lock Meeting switch and the value it asked for.
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

    /// The S1-derived fields from the snapshots the shell just published, plus the controls-only fields (CC1). The
    /// view model and the Debug fixture build their inputs through this one function, so both read S1 the same way.
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

    /// CTL-2: the same inputs with every S1-derived field re-read from the shell snapshots and the controls-only fields
    /// kept. The presenter uses it right after its own S1 intents (the End confirmation, its cancel, a dispatched End or
    /// Leave ticket), whose publishes change no core field, so the Leave control follows S1 in the same frame.
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

    /// The S1 row for a control id, or nil.
    func row(_ id: MeetingControlID) -> MeetingControlRow? {
        for row in rows {
            if row.id == id.rawValue { return row }
        }
        return nil
    }
}
