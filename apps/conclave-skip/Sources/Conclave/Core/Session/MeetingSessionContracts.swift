import Foundation

// WP2-S1 session contract (contract-wp2-first-slice 3.2). Everything here crosses into handwritten Kotlin, so it is
// String raw-value enums and structs of scalars: no associated values, no tuples, no protocols (S1C 3.6).

/// The public identity of one call. `callSession` bumps only for a new meeting intent (a fresh New or Join, or a
/// server redirect); `attempt` mirrors the view model's lifecycle generation and `attemptToken` its join attempt id,
/// so a recovery rejoin or an admission changes the attempt but keeps the call session.
struct MeetingSessionIdentity: Equatable {
    let callSession: Int
    let attempt: Int
    let attemptToken: String

    static let none = MeetingSessionIdentity(callSession: 0, attempt: 0, attemptToken: "")

    var isActive: Bool { !attemptToken.isEmpty }
}

/// R08 route phase. The initial connect and the admission wait stay in the lobby (`entering`, `waiting`); only a
/// recovery keeps the stage (`recovering`).
enum MeetingPhaseKind: String, CaseIterable, Equatable {
    case home, entering, waiting, inCall, recovering, leaving, outcome
}

enum MeetingNoticeKind: String, CaseIterable, Equatable {
    case none, endedByHost, roomClosed, formError, reconnecting, offline, serverRestarting, resuming
}

enum MeetingTerminalOutcomeKind: String, CaseIterable, Equatable {
    case left, endedByYou, endedByHost, roomClosed, removed, denied, joinFailed, connectionLost
}

/// Recorded by the view model at each terminal site before the phase write (S1C 3.4 E7). `id` is a view model serial
/// that dedupes outcome feedback across intermediate publishes; `serverText` is the legacy or server text, which
/// native copy never shows (it localizes by kind).
struct MeetingTerminalOutcome: Equatable {
    let id: Int
    let callSession: Int
    let kind: MeetingTerminalOutcomeKind
    let serverText: String
}

enum MeetingActionKind: String, CaseIterable, Equatable {
    case microphone, camera, screenShare, hand, leave, endForEveryone
}

struct MeetingActionTicket: Equatable {
    let id: Int
    let kind: MeetingActionKind
    let identity: MeetingSessionIdentity
}

enum MeetingActionResultKind: String, CaseIterable, Equatable {
    case completed, failed, interrupted, cancelled
}

enum MeetingActionFailure: String, CaseIterable, Equatable {
    case none, notJoined, notConnected, ackTimedOut, socketReplaced, rejectedByServer
    case roleRequired, permissionDenied, deviceUnavailable, unknown
}

struct MeetingActionResult: Equatable {
    let kind: MeetingActionResultKind
    let failure: MeetingActionFailure
    let serverText: String?

    static let completed = MeetingActionResult(kind: .completed, failure: .none, serverText: nil)
    static let interrupted = MeetingActionResult(kind: .interrupted, failure: .none, serverText: nil)
    static let cancelled = MeetingActionResult(kind: .cancelled, failure: .none, serverText: nil)

    static func failed(_ failure: MeetingActionFailure, serverText: String? = nil) -> MeetingActionResult {
        MeetingActionResult(kind: .failed, failure: failure, serverText: serverText)
    }
}

/// The synchronous answer to an intent. `duplicate` dispatched nothing and published nothing; `unavailable` means
/// the row is hidden or blocked.
enum MeetingDispatch: String, CaseIterable, Equatable {
    case dispatched, duplicate, unavailable
}

/// Every control row, in the one fixed order the rows always use (S1C ROW).
enum MeetingControlID: String, CaseIterable, Equatable {
    case microphone, camera, screenShare, hand, reactions, chat, participants, leave, endForEveryone
}

enum MeetingBlockedReason: String, CaseIterable, Equatable {
    case none, notJoined, reconnecting, attendee, audioOnly, remoteShareActive, unsupported, hostOnly, leaving, disabledByHost
}

enum MeetingControlHint: String, CaseIterable, Equatable {
    case none, appliesAfterReconnect
}

struct MeetingControlRow: Equatable, Identifiable {
    /// `MeetingControlID.rawValue`; ids and order are stable through recovery.
    let id: String
    let isVisible: Bool
    let isOn: Bool
    let isEnabled: Bool
    let isPending: Bool
    let blockedReason: MeetingBlockedReason
    let hint: MeetingControlHint
    let badgeCount: Int
    /// The last accepted failure of this row in this call session; cleared by the next dispatch.
    let failure: MeetingActionFailure
}

struct MeetingControlRowsState: Equatable {
    let revision: Int
    let rows: [MeetingControlRow]
}

enum MeetingConfirmationKind: String, CaseIterable, Equatable {
    case endForEveryone
}

struct MeetingConfirmation: Equatable {
    let id: Int
    let kind: MeetingConfirmationKind
    let invoker: PanelInvoker
}

struct MeetingSessionSnapshot: Equatable {
    let revision: Int
    let identity: MeetingSessionIdentity
    let phase: MeetingPhaseKind
    let notice: MeetingNoticeKind
    let noticeText: String?
    let outcome: MeetingTerminalOutcome?
    let roomLabel: String
    let isLocalHost: Bool
    let isWebinarAttendee: Bool
    let canEndForEveryone: Bool
    let confirmation: MeetingConfirmation?
}

struct MeetingEntrySnapshot: Equatable {
    let roomId: String
    let displayName: String
    let micIntentOn: Bool
    let cameraIntentOn: Bool
    let formError: String?
    let showsEntryOverlayIntent: Bool
    let entryAction: MeetingEntryAction?
}

/// Same shape as `NativeHostingFeedbackState` minus the fixture counter. S1 publishes tokens and delivers none
/// (delivery is WP2-S2b).
struct MeetingShellFeedbackState: Equatable {
    let session: Int
    let token: FeedbackToken
}

enum MeetingShellCommand: String, CaseIterable, Equatable {
    case toggleMicrophone, toggleCamera, toggleScreenShare, toggleHand, leave, endForEveryone, retry, dismissOutcome
}

/// The schema boundary between the core and the presenter (S1C 3.2). The view model builds it from `MeetingState`
/// and its own guards and pushes it through `MeetingShellPresenter.apply(_:)`; the presenter never observes the core.
/// It never carries `errorMessage`, the active speaker, connection quality, audio levels, chat arrays or tile data.
struct MeetingShellInputs: Equatable {
    let identity: MeetingSessionIdentity
    let connectionState: ConnectionState
    let isRecoveringConnection: Bool
    let isResumingFromBackground: Bool
    let isNetworkOffline: Bool
    let serverRestartNotice: String?
    let waitingMessage: String?
    let joinFormErrorMessage: String?
    let meetingEndedNoticeMessage: String?
    let isEnteringMeeting: Bool
    let meetingEntryAction: MeetingEntryAction?
    let roomId: String
    let displayName: String
    let isAdmin: Bool
    let isWebinarAttendee: Bool
    let isMuted: Bool
    let isCameraOff: Bool
    let isAudioOnlyMode: Bool
    let isScreenSharing: Bool
    let isHandRaised: Bool
    let hasActiveRemoteScreenShare: Bool
    let isScreenShareSupported: Bool
    let unreadChatCount: Int
    let isChatOpen: Bool
    let pendingUsersCount: Int
    let isReactionsDisabled: Bool
    let terminalOutcome: MeetingTerminalOutcome?
    let micToggleInFlight: Bool
    let cameraToggleInFlight: Bool
    let screenShareToggleInFlight: Bool
    let handToggleInFlight: Bool
    let isTearingDown: Bool

    /// Every field defaulted, so tests (Swift and the transpiled Kotlin) name only what a scenario needs.
    static func make(
        identity: MeetingSessionIdentity = MeetingSessionIdentity.none,
        connectionState: ConnectionState = ConnectionState.disconnected,
        isRecoveringConnection: Bool = false,
        isResumingFromBackground: Bool = false,
        isNetworkOffline: Bool = false,
        serverRestartNotice: String? = nil,
        waitingMessage: String? = nil,
        joinFormErrorMessage: String? = nil,
        meetingEndedNoticeMessage: String? = nil,
        isEnteringMeeting: Bool = false,
        meetingEntryAction: MeetingEntryAction? = nil,
        roomId: String = "",
        displayName: String = "",
        isAdmin: Bool = false,
        isWebinarAttendee: Bool = false,
        isMuted: Bool = true,
        isCameraOff: Bool = true,
        isAudioOnlyMode: Bool = false,
        isScreenSharing: Bool = false,
        isHandRaised: Bool = false,
        hasActiveRemoteScreenShare: Bool = false,
        isScreenShareSupported: Bool = true,
        unreadChatCount: Int = 0,
        isChatOpen: Bool = false,
        pendingUsersCount: Int = 0,
        isReactionsDisabled: Bool = false,
        terminalOutcome: MeetingTerminalOutcome? = nil,
        micToggleInFlight: Bool = false,
        cameraToggleInFlight: Bool = false,
        screenShareToggleInFlight: Bool = false,
        handToggleInFlight: Bool = false,
        isTearingDown: Bool = false
    ) -> MeetingShellInputs {
        MeetingShellInputs(
            identity: identity,
            connectionState: connectionState,
            isRecoveringConnection: isRecoveringConnection,
            isResumingFromBackground: isResumingFromBackground,
            isNetworkOffline: isNetworkOffline,
            serverRestartNotice: serverRestartNotice,
            waitingMessage: waitingMessage,
            joinFormErrorMessage: joinFormErrorMessage,
            meetingEndedNoticeMessage: meetingEndedNoticeMessage,
            isEnteringMeeting: isEnteringMeeting,
            meetingEntryAction: meetingEntryAction,
            roomId: roomId,
            displayName: displayName,
            isAdmin: isAdmin,
            isWebinarAttendee: isWebinarAttendee,
            isMuted: isMuted,
            isCameraOff: isCameraOff,
            isAudioOnlyMode: isAudioOnlyMode,
            isScreenSharing: isScreenSharing,
            isHandRaised: isHandRaised,
            hasActiveRemoteScreenShare: hasActiveRemoteScreenShare,
            isScreenShareSupported: isScreenShareSupported,
            unreadChatCount: unreadChatCount,
            isChatOpen: isChatOpen,
            pendingUsersCount: pendingUsersCount,
            isReactionsDisabled: isReactionsDisabled,
            terminalOutcome: terminalOutcome,
            micToggleInFlight: micToggleInFlight,
            cameraToggleInFlight: cameraToggleInFlight,
            screenShareToggleInFlight: screenShareToggleInFlight,
            handToggleInFlight: handToggleInFlight,
            isTearingDown: isTearingDown
        )
    }

    /// The terminal outcome of this call session only. An outcome left over from an earlier call session is never
    /// published with the new identity (S1C SES coherence).
    var currentOutcome: MeetingTerminalOutcome? {
        guard let outcome = terminalOutcome, outcome.callSession == identity.callSession else { return nil }
        return outcome
    }
}
