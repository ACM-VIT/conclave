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

/// `onHold` (WP2-S2a, S70 R70-6): CallKit "Hold and Accept" holds the call (the S20 banner carries Resume).
enum MeetingNoticeKind: String, CaseIterable, Equatable {
    case none, endedByHost, roomClosed, formError, reconnecting, offline, serverRestarting, resuming, onHold
}

/// `serverDisconnected` (WP2-S2a, S10 0.8 C4, R6 d): the server ended the connection without a restart notice; it
/// maps to the outcome phase and the `connectionLost` token.
enum MeetingTerminalOutcomeKind: String, CaseIterable, Equatable {
    case left, endedByYou, endedByHost, roomClosed, removed, denied, joinFailed, connectionLost, serverDisconnected
}

/// S10 R6 c: how the current entry into this call session started. `initial` until the session, once in the call,
/// starts a recovery (or continues through a server redirect); a join failure then is a rejoin failure (S10 10 f).
enum MeetingEntryOrigin: String, CaseIterable, Equatable {
    case initial, recovery
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

/// S30 CC3: which way a toggle went, so a failed lower maps to its own copy ("Couldn't lower your hand."). Only the
/// hand reports it today; every other result carries `none`.
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
    /// Only clean server text (S70 7 c); never raw transport text.
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

/// The synchronous answer to an intent. `duplicate` dispatched nothing and published nothing; `unavailable` means
/// the row is hidden or blocked.
enum MeetingDispatch: String, CaseIterable, Equatable {
    case dispatched, duplicate, unavailable
}

/// Every control row, in the one fixed order the rows always use (S1C ROW).
enum MeetingControlID: String, CaseIterable, Equatable {
    case microphone, camera, screenShare, hand, reactions, chat, participants, leave, endForEveryone
}

/// WP2-S2a adds `offline`, `permissionDenied`, `permissionUndetermined`, `ending` (S30 CC2) and the microphone-only
/// `audioInterrupted` and `onHold` (R70-6, RECONCILE R29). Rows keep their place; a reason never hides a row.
enum MeetingBlockedReason: String, CaseIterable, Equatable {
    case none, notJoined, reconnecting, attendee, audioOnly, remoteShareActive, unsupported, hostOnly, leaving, disabledByHost
    case offline, permissionDenied, permissionUndetermined, ending, audioInterrupted, onHold
}

/// The operating-system permission for a local device, as the S1 rows need it (WP2-S2a). The WP3 permission provider
/// feeds it; until then the view model passes `granted`, so rows match the legacy bar.
enum MeetingMediaPermissionStatus: String, CaseIterable, Equatable {
    case granted, undetermined, denied
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
    /// The last accepted failure of this row in this call session; cleared by the next dispatch. Microphone and
    /// camera failures are typed through `MeetingErrorClassifier` (WP2-S2a, PLAN-next 7 item 4).
    let failure: MeetingActionFailure
    /// The direction of that failure (S30 CC3): `raise` or `lower` for the hand, `none` otherwise.
    let failureDirection: MeetingActionDirection
}

struct MeetingControlRowsState: Equatable {
    let revision: Int
    let rows: [MeetingControlRow]
}

enum MeetingConfirmationKind: String, CaseIterable, Equatable {
    case endForEveryone
}

/// The surface that asked for a confirmation (S50 PH17, R09): the dialog belongs to it, so the Host Controls End
/// dialog shows in Host Controls, never on the bar. S30 `LeaveSnapshot.confirmationInvoker` is the same String.
enum MeetingConfirmationInvoker {
    static let call = "call"
    static let more = "more"
    static let hostControls = "hostControls"
}

struct MeetingConfirmation: Equatable {
    let id: Int
    let kind: MeetingConfirmationKind
    /// A `MeetingConfirmationInvoker` value.
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
    /// S10 R6 c: true once this call session reached the call (`inCall`), kept through recovery and a server redirect;
    /// the root keeps the call root for `recovering` only while it is true (S10 0.4).
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
    /// S70 R70-11: set by the redirect path before the new call session starts; the session keeps its admission.
    let isRedirectContinuation: Bool
    let microphonePermission: MeetingMediaPermissionStatus
    let cameraPermission: MeetingMediaPermissionStatus
    /// From `CallPresence` (S70 5): `held` is the CallKit hold, `otherAudio` another call or app holds the audio.
    let audioInterruption: AudioInterruptionKind

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
        isTearingDown: Bool = false,
        isRedirectContinuation: Bool = false,
        microphonePermission: MeetingMediaPermissionStatus = MeetingMediaPermissionStatus.granted,
        cameraPermission: MeetingMediaPermissionStatus = MeetingMediaPermissionStatus.granted,
        audioInterruption: AudioInterruptionKind = AudioInterruptionKind.none
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
            audioInterruption: audioInterruption
        )
    }

    /// The terminal outcome of this call session only. An outcome left over from an earlier call session is never
    /// published with the new identity (S1C SES coherence).
    var currentOutcome: MeetingTerminalOutcome? {
        guard let outcome = terminalOutcome, outcome.callSession == identity.callSession else { return nil }
        return outcome
    }
}
