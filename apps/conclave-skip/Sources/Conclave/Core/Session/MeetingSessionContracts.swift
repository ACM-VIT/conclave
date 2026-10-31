import Foundation

struct MeetingSessionIdentity: Equatable {
    let callSession: Int
    let attempt: Int
    let attemptToken: String

    static let none = MeetingSessionIdentity(callSession: 0, attempt: 0, attemptToken: "")

    var isActive: Bool { !attemptToken.isEmpty }
}

enum MeetingPhaseKind: String, CaseIterable, Equatable {
    case home, entering, waiting, inCall, recovering, leaving, outcome
}

enum MeetingNoticeKind: String, CaseIterable, Equatable {
    case none, endedByHost, roomClosed, formError, reconnecting, offline, serverRestarting, resuming, onHold
}

enum MeetingTerminalOutcomeKind: String, CaseIterable, Equatable {
    case left, endedByYou, endedByHost, roomClosed, removed, denied, joinFailed, connectionLost, serverDisconnected
}

enum MeetingEntryOrigin: String, CaseIterable, Equatable {
    case initial, recovery
}

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

enum MeetingActionDirection: String, CaseIterable, Equatable {
    case none, raise, lower
}

enum MeetingActionFailure: String, CaseIterable, Equatable {
    case none, notJoined, notConnected, ackTimedOut, socketReplaced, rejectedByServer
    case roleRequired, permissionDenied, deviceUnavailable, unknown
}

struct MeetingActionResult: Equatable {
    let kind: MeetingActionResultKind
    let failure: MeetingActionFailure

    let serverText: String?
    let direction: MeetingActionDirection

    static let completed = MeetingActionResult(kind: .completed, failure: .none, serverText: nil, direction: .none)
    static let interrupted = MeetingActionResult(kind: .interrupted, failure: .none, serverText: nil, direction: .none)
    static let cancelled = MeetingActionResult(kind: .cancelled, failure: .none, serverText: nil, direction: .none)

    static func failed(
        _ failure: MeetingActionFailure,
        serverText: String? = nil,
        direction: MeetingActionDirection = .none
    ) -> MeetingActionResult {
        MeetingActionResult(kind: .failed, failure: failure, serverText: serverText, direction: direction)
    }
}

enum MeetingDispatch: String, CaseIterable, Equatable {
    case dispatched, duplicate, unavailable
}

enum MeetingControlID: String, CaseIterable, Equatable {
    case microphone, camera, screenShare, hand, reactions, chat, participants, leave, endForEveryone
}

enum MeetingBlockedReason: String, CaseIterable, Equatable {
    case none, notJoined, reconnecting, attendee, audioOnly, remoteShareActive, unsupported, hostOnly, leaving, disabledByHost
    case offline, permissionDenied, permissionUndetermined, ending, audioInterrupted, onHold
}

enum MeetingMediaPermissionStatus: String, CaseIterable, Equatable {
    case granted, undetermined, denied
}

enum MeetingControlHint: String, CaseIterable, Equatable {
    case none, appliesAfterReconnect
}

struct MeetingControlRow: Equatable, Identifiable {

    let id: String
    let isVisible: Bool
    let isOn: Bool
    let isEnabled: Bool
    let isPending: Bool
    let blockedReason: MeetingBlockedReason
    let hint: MeetingControlHint
    let badgeCount: Int

    let failure: MeetingActionFailure

    let failureDirection: MeetingActionDirection
}

struct MeetingControlRowsState: Equatable {
    let revision: Int
    let rows: [MeetingControlRow]
}

enum MeetingConfirmationKind: String, CaseIterable, Equatable {
    case endForEveryone
}

enum MeetingConfirmationInvoker {
    static let call = "call"
    static let more = "more"
    static let hostControls = "hostControls"
}

struct MeetingConfirmation: Equatable {
    let id: Int
    let kind: MeetingConfirmationKind

    let invoker: String
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

    let hasBeenAdmittedThisSession: Bool
    let entryOrigin: MeetingEntryOrigin
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

struct MeetingShellFeedbackState: Equatable {
    let session: Int
    let token: FeedbackToken
}

enum MeetingShellCommand: String, CaseIterable, Equatable {
    case toggleMicrophone, toggleCamera, toggleScreenShare, toggleHand, leave, endForEveryone, retry, dismissOutcome
}

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

    let isRedirectContinuation: Bool
    let microphonePermission: MeetingMediaPermissionStatus
    let cameraPermission: MeetingMediaPermissionStatus

    let audioInterruption: AudioInterruptionKind

    let attendeeCanRaiseHand: Bool

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
        isTearingDown: Bool = false,
        isRedirectContinuation: Bool = false,
        microphonePermission: MeetingMediaPermissionStatus = MeetingMediaPermissionStatus.granted,
        cameraPermission: MeetingMediaPermissionStatus = MeetingMediaPermissionStatus.granted,
        audioInterruption: AudioInterruptionKind = AudioInterruptionKind.none,
        attendeeCanRaiseHand: Bool = false
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
            isTearingDown: isTearingDown,
            isRedirectContinuation: isRedirectContinuation,
            microphonePermission: microphonePermission,
            cameraPermission: cameraPermission,
            audioInterruption: audioInterruption,
            attendeeCanRaiseHand: attendeeCanRaiseHand
        )
    }

    var currentOutcome: MeetingTerminalOutcome? {
        guard let outcome = terminalOutcome, outcome.callSession == identity.callSession else { return nil }
        return outcome
    }
}
