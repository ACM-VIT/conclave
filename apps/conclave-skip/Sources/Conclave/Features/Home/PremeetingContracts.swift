import Foundation

// ENT-1 (S10 0.4, 0.5): the premeeting contract shared by both native roots. Transpiled Swift: String raw-value enums,
// scalar structs and arrays of structs, no associated values, no tuples, no protocols (S1C 3.6). The six lobby
// snapshots of S10 6 (card, status, audio, identity, presence, link): the status snapshot is here (ENT-1, the 0.4
// table and the S10 4 switch rules read it); ENT-3 adds the other five in Features/Lobby/LobbyContracts.swift.

// MARK: - Navigation

/// A pushed premeeting page (S10 0.5). The Outcome screen is root content on iOS and `OutcomeKey` on Android
/// (S10 0.4), never a route. New pages add a case here, a destination in `PremeetingRoot+iOS.swift` and a key in
/// `K/ui/home/PremeetingBackStack.kt` (Lobby ENT-3 landed; Account and Privacy ENT-7, Webinar landing ENT-9).
enum PremeetingRouteKind: String, CaseIterable, Equatable {
    case lobby, webinarLanding, account, privacyPolicy, settings
}

struct PremeetingRoute: Hashable {
    let id: Int
    let kind: PremeetingRouteKind
    let roomId: String

    /// Recent rows carry route ids from this base up (their index), so an iOS `NavigationLink(value:)` that appends
    /// one is recognized in `setPath(_:)`; presenter pushes count up from 1 and never reach it.
    static let recentRouteIdBase = 100000
}

enum LobbyIntent: String, CaseIterable, Equatable {
    case join, newMeeting, rejoin, resume, promotion   // promotion: accepted webinar stage invitation (RECONCILE R30)
}

enum LobbyMode: String, CaseIterable, Equatable {
    case editing, connecting, waiting, failed
}

enum LobbyIssue: String, CaseIterable, Equatable {
    case none, offline, nameMissing, roomNotFound, inviteCodeRequired, inviteCodeInvalid, signInRequired,
         appSuspended, failedNetwork, failedMedia, failedServerBusy, failedServerText, failedUnknown,
         updateRequired                                                   // R51
}

enum WaitingKind: String, CaseIterable, Equatable {
    case standard, locked, noHost, hostAvailable, reconnecting, offline, serverRestarting   // R46
}

/// The lobby's bottom block and navigation state (S10 0.5). `primaryReason` carries a `LobbyPrimaryReason` raw value
/// ("" for none); `isPrimaryPending` shows the primary's spinner while a start is in flight (the C17 code check,
/// additive to S10 0.5).
struct LobbyStatusSnapshot: Equatable {
    let routeId: Int
    let intent: LobbyIntent
    let mode: LobbyMode
    let issue: LobbyIssue
    let issueServerText: String
    let isPrimaryEnabled: Bool
    let primaryReason: String
    let showsSlowNotice: Bool
    let waitingKind: WaitingKind
    let isPrimaryPending: Bool
    /// ENT-5 (S10 9 f `serverRestarting`): the clean server sentence for the waiting body ("" uses the S20 copy).
    let waitingText: String
}

// MARK: - Home

enum HomeNoticeKind: String, CaseIterable, Equatable {
    case none, endedByHost, roomClosed, invalidLink, sessionExpired, movedToAudience   // movedToAudience: R47
}

enum RecentRole: String, CaseIterable, Equatable {
    case participant, host, attendee
}

enum RecentEnd: String, CaseIterable, Equatable {
    case left, endedByYou, endedByHost, connectionLost, removed, denied, failed
}

struct RecentMeetingRow: Equatable, Identifiable {
    let id: String
    let roomId: String
    let routeId: Int
    let routeKind: PremeetingRouteKind
    let title: String
    let relativeTime: String
    let role: RecentRole
    let end: RecentEnd
}

struct RejoinCard: Equatable {
    let recentId: String
    let title: String
    /// The end time in the device locale ("3:42 PM"); the view composes "Left at %@" or "Connection lost at %@".
    let endedAtText: String
    let end: RecentEnd
}

struct HomeSnapshot: Equatable {
    let revision: Int
    let noticeKind: HomeNoticeKind
    let noticeText: String
    let rejoin: RejoinCard?
    let recents: [RecentMeetingRow]
    let isSignedIn: Bool
    let accountName: String
    let accountSeed: String
    /// R51 version gate (S10 1 f, 2 f; S70 16): Home shows the "Update Conclave" banner, entries open the explanation.
    let updateRequired: Bool
    let storeURL: String

    static let empty = HomeSnapshot(revision: 0, noticeKind: .none, noticeText: "", rejoin: nil, recents: [],
                                    isSignedIn: false, accountName: "", accountSeed: "", updateRequired: false,
                                    storeURL: "")
}

/// The busy-state prompt (S10 4). A newer link replaces it with a new id; the old id is dropped.
struct RoomSwitchPrompt: Equatable {
    let id: Int
    /// "" when unknown: the view shows "your current meeting" (S10 4 g).
    let currentLabel: String
    /// "" when unknown: the view shows "another meeting".
    let targetLabel: String
}

// MARK: - Outcome (S10 10 j)

enum OutcomeVariant: String, CaseIterable, Equatable {
    case removed, denied, connectionLost, serverDisconnected, rejoinFailed
}

enum OutcomeAction: String, CaseIterable, Equatable {
    case rejoin, tryAgain, backHome, none
}

/// The outcome screen model (S10 10 j). ENT-6: Rejoin and Try Again are offered while the view model keeps a rejoin
/// context (S10 0.8 C3, `OutcomeModelPolicy`). No display strings: each platform maps the variant, the actions and
/// `failure` (the S10 8 g body class of a failed rejoin, additive to S10 10 j) to its copy.
struct OutcomeModel: Equatable {
    let id: Int
    let variant: OutcomeVariant
    let primary: OutcomeAction
    let secondary: OutcomeAction
    let serverDetail: String
    let failure: LobbyIssue

    init(id: Int, variant: OutcomeVariant, primary: OutcomeAction, secondary: OutcomeAction, serverDetail: String,
         failure: LobbyIssue = LobbyIssue.none) {
        self.id = id
        self.variant = variant
        self.primary = primary
        self.secondary = secondary
        self.serverDetail = serverDetail
        self.failure = failure
    }
}

// MARK: - Root routing (S10 0.4)

enum PremeetingRootKind: String, CaseIterable, Equatable {
    case premeeting, call
}

/// One row of the S10 0.4 phase table.
struct PremeetingRootDecision: Equatable {
    let root: PremeetingRootKind
    /// The lobby mode the phase forces; nil keeps a lobby on top in `editing`.
    let lobbyMode: LobbyMode?
    /// Entering, waiting and recovering before admission push the lobby when it is not on top.
    let pushesLobby: Bool
    /// Recovering before the first admission: the lobby shows a "Reconnecting" line.
    let showsReconnecting: Bool
    /// Removal, denial, loss, server disconnect and a failed rejoin: the outcome screen is the root content.
    let showsOutcome: Bool

    static let home = PremeetingRootDecision(root: .premeeting, lobbyMode: nil, pushesLobby: false,
                                             showsReconnecting: false, showsOutcome: false)
    static let call = PremeetingRootDecision(root: .call, lobbyMode: nil, pushesLobby: false,
                                             showsReconnecting: false, showsOutcome: false)
}

enum PremeetingRootPolicy {
    /// The S10 0.4 table. `lastPreCallWasWaiting`: this call session's last pre-call phase was `waiting`.
    static func decide(
        phase: MeetingPhaseKind,
        hasBeenAdmittedThisSession: Bool,
        outcomeKind: MeetingTerminalOutcomeKind?,
        entryOrigin: MeetingEntryOrigin,
        lastPreCallWasWaiting: Bool
    ) -> PremeetingRootDecision {
        switch phase {
        case .home:
            return PremeetingRootDecision.home
        case .entering:
            return PremeetingRootDecision(root: .premeeting, lobbyMode: .connecting, pushesLobby: true,
                                          showsReconnecting: false, showsOutcome: false)
        case .waiting:
            return PremeetingRootDecision(root: .premeeting, lobbyMode: .waiting, pushesLobby: true,
                                          showsReconnecting: false, showsOutcome: false)
        case .recovering:
            if hasBeenAdmittedThisSession {
                return PremeetingRootDecision.call
            }
            return PremeetingRootDecision(root: .premeeting, lobbyMode: lastPreCallWasWaiting ? LobbyMode.waiting : LobbyMode.connecting,
                                          pushesLobby: true, showsReconnecting: true, showsOutcome: false)
        case .inCall:
            return PremeetingRootDecision.call
        case .leaving:
            // A cancel while connecting or waiting never shows the stage; leaving a call keeps it until home.
            return hasBeenAdmittedThisSession ? PremeetingRootDecision.call : PremeetingRootDecision.home
        case .outcome:
            guard let kind = outcomeKind else { return PremeetingRootDecision.home }
            switch kind {
            case .joinFailed:
                if entryOrigin == .initial {
                    return PremeetingRootDecision(root: .premeeting, lobbyMode: .failed, pushesLobby: true,
                                                  showsReconnecting: false, showsOutcome: false)
                }
                return outcomeScreen
            case .removed, .denied, .connectionLost, .serverDisconnected:
                return outcomeScreen
            case .left, .endedByYou, .endedByHost, .roomClosed:
                return PremeetingRootDecision.home
            }
        }
    }

    private static let outcomeScreen = PremeetingRootDecision(root: .premeeting, lobbyMode: nil, pushesLobby: false,
                                                              showsReconnecting: false, showsOutcome: true)

    /// The outcome variant for a terminal kind, or nil when the kind is not an outcome screen (S10 10 f).
    static func outcomeVariant(_ kind: MeetingTerminalOutcomeKind, entryOrigin: MeetingEntryOrigin) -> OutcomeVariant? {
        switch kind {
        case .removed:
            return .removed
        case .denied:
            return .denied
        case .connectionLost:
            return .connectionLost
        case .serverDisconnected:
            return .serverDisconnected
        case .joinFailed:
            return entryOrigin == .recovery ? .rejoinFailed : nil
        case .left, .endedByYou, .endedByHost, .roomClosed:
            return nil
        }
    }

    /// Home notices that come from the S1 session (R08: ended by host and room closed go to Home).
    static func homeNotice(_ notice: MeetingNoticeKind) -> HomeNoticeKind {
        switch notice {
        case .endedByHost:
            return .endedByHost
        case .roomClosed:
            return .roomClosed
        case .none, .formError, .reconnecting, .offline, .serverRestarting, .resuming, .onHold:
            return .none
        }
    }

    /// The recents end for a terminal kind (S10 2 j).
    static func recentEnd(_ kind: MeetingTerminalOutcomeKind) -> RecentEnd {
        switch kind {
        case .left:
            return .left
        case .endedByYou:
            return .endedByYou
        case .endedByHost, .roomClosed:
            return .endedByHost
        case .removed:
            return .removed
        case .denied:
            return .denied
        case .joinFailed:
            return .failed
        case .connectionLost, .serverDisconnected:
            return .connectionLost
        }
    }
}

// MARK: - Inputs and commands

/// Core-only intents of the premeeting presenter (the view model forwards them to the S1 shell). Fixture presenters
/// have no hook, so nothing reaches a call (S10 L9).
enum PremeetingCommand: String, CaseIterable, Equatable {
    /// Leave and Join (S10 4) and Cancel joining: `shell.leave()`.
    case leave
    /// Dismissing an S1 Home notice or the outcome screen: `shell.dismissOutcome()`.
    case dismissOutcome
    /// ENT-6 (S10 0.8 C3): Rejoin on Home or the outcome screen, Try Again after a failed rejoin, and Join or Try Again
    /// in a `rejoin` lobby: `MeetingViewModel.rejoinLastMeeting()` joins with the call's original room, invite codes,
    /// client id and media intent (RECONCILE R4; HD request B5-T5 R3).
    case rejoinLastMeeting
    /// S50 PH20 (PPL-7): "Join as a Speaker" in the promotion lobby: S1 ends the attendee session silently and joins
    /// the rejoin room with the same identity and the lobby's intents (`MeetingViewModel.joinAsSpeaker()`).
    case joinAsSpeaker
    /// S50 PH20: Cancel or Back in the promotion lobby: `webinar:declineStage` while still an attendee; the lobby
    /// closes and the viewer keeps playing.
    case cancelPromotion
}

/// Pushed inputs (S10 0.5 table, S1C 3.2 format). Every field is a scalar the core already owns; `apply(_:)` is
/// equality-guarded, so republishing the same inputs costs nothing.
struct PremeetingInputs: Equatable {
    // S1 session subset
    let callSession: Int
    let phase: MeetingPhaseKind
    let notice: MeetingNoticeKind
    let noticeText: String
    let outcomeId: Int
    let outcomeKind: MeetingTerminalOutcomeKind?
    let outcomeServerText: String
    let roomLabel: String
    let isLocalHost: Bool
    let isWebinarAttendee: Bool
    let hasBeenAdmittedThisSession: Bool
    let entryOrigin: MeetingEntryOrigin
    // Same-room rule (S10 4 c: ids and aliases) and the join mode of the current call
    let currentRoomId: String
    let roomAliases: [String]
    let currentJoinMode: JoinMode
    // Identity (AppState, 0.8 C8)
    let isSignedIn: Bool
    let accountName: String
    let accountSeed: String
    let isSigningIn: Bool
    // App and network
    let isNetworkOffline: Bool
    let isAppActive: Bool
    // Entry media intent (S10 0.8 C1, ENT-3): the view model's flags, or its pending entry intent while entering
    let micIntentOn: Bool
    let cameraIntentOn: Bool
    // Process-death resume (0.8 C7, a later core slice; the L9 fixture injects them)
    let resumeInFlight: Bool
    let resumeRoomId: String
    // R51 version gate (S70 16; a missing server field never gates)
    let updateRequired: Bool
    let storeURL: String
    // ENT-6 (S10 0.8 C3): the room of the view model's rejoin context ("" when there is none)
    let rejoinRoomId: String
    // ENT-5 (S10 9 f, RECONCILE R46): the server restart notice while waiting ("" when none)
    let serverRestartText: String
    // ENT-5 (S10 8 f): the classifier's category raw value and diagnostic code of the last join failure ("" when none)
    let joinFailureCategory: String
    let joinFailureCode: String
    // ENT-9 (S10 12 f): the socket connected during this attempt (`connectionState` is connected or joining), so the
    // webinar landing says "Almost There" after "Getting You In". False until the view model fills it (HD request
    // B8-T7 R1).
    let entrySocketConnected: Bool

    static func make(
        callSession: Int = 0,
        phase: MeetingPhaseKind = .home,
        notice: MeetingNoticeKind = .none,
        noticeText: String = "",
        outcomeId: Int = 0,
        outcomeKind: MeetingTerminalOutcomeKind? = nil,
        outcomeServerText: String = "",
        roomLabel: String = "",
        isLocalHost: Bool = false,
        isWebinarAttendee: Bool = false,
        hasBeenAdmittedThisSession: Bool = false,
        entryOrigin: MeetingEntryOrigin = .initial,
        currentRoomId: String = "",
        roomAliases: [String] = [],
        currentJoinMode: JoinMode = .meeting,
        isSignedIn: Bool = false,
        accountName: String = "",
        accountSeed: String = "",
        isSigningIn: Bool = false,
        isNetworkOffline: Bool = false,
        isAppActive: Bool = true,
        micIntentOn: Bool = false,
        cameraIntentOn: Bool = false,
        resumeInFlight: Bool = false,
        resumeRoomId: String = "",
        updateRequired: Bool = false,
        storeURL: String = "",
        rejoinRoomId: String = "",
        serverRestartText: String = "",
        joinFailureCategory: String = "",
        joinFailureCode: String = "",
        entrySocketConnected: Bool = false
    ) -> PremeetingInputs {
        PremeetingInputs(
            callSession: callSession,
            phase: phase,
            notice: notice,
            noticeText: noticeText,
            outcomeId: outcomeId,
            outcomeKind: outcomeKind,
            outcomeServerText: outcomeServerText,
            roomLabel: roomLabel,
            isLocalHost: isLocalHost,
            isWebinarAttendee: isWebinarAttendee,
            hasBeenAdmittedThisSession: hasBeenAdmittedThisSession,
            entryOrigin: entryOrigin,
            currentRoomId: currentRoomId,
            roomAliases: roomAliases,
            currentJoinMode: currentJoinMode,
            isSignedIn: isSignedIn,
            accountName: accountName,
            accountSeed: accountSeed,
            isSigningIn: isSigningIn,
            isNetworkOffline: isNetworkOffline,
            isAppActive: isAppActive,
            micIntentOn: micIntentOn,
            cameraIntentOn: cameraIntentOn,
            resumeInFlight: resumeInFlight,
            resumeRoomId: resumeRoomId,
            updateRequired: updateRequired,
            storeURL: storeURL,
            rejoinRoomId: rejoinRoomId,
            serverRestartText: serverRestartText,
            joinFailureCategory: joinFailureCategory,
            joinFailureCode: joinFailureCode,
            entrySocketConnected: entrySocketConnected
        )
    }

    /// The same inputs with another identity (bootstrap).
    func withIdentity(isSignedIn: Bool, accountName: String, accountSeed: String) -> PremeetingInputs {
        PremeetingInputs(
            callSession: callSession,
            phase: phase,
            notice: notice,
            noticeText: noticeText,
            outcomeId: outcomeId,
            outcomeKind: outcomeKind,
            outcomeServerText: outcomeServerText,
            roomLabel: roomLabel,
            isLocalHost: isLocalHost,
            isWebinarAttendee: isWebinarAttendee,
            hasBeenAdmittedThisSession: hasBeenAdmittedThisSession,
            entryOrigin: entryOrigin,
            currentRoomId: currentRoomId,
            roomAliases: roomAliases,
            currentJoinMode: currentJoinMode,
            isSignedIn: isSignedIn,
            accountName: accountName,
            accountSeed: accountSeed,
            isSigningIn: isSigningIn,
            isNetworkOffline: isNetworkOffline,
            isAppActive: isAppActive,
            micIntentOn: micIntentOn,
            cameraIntentOn: cameraIntentOn,
            resumeInFlight: resumeInFlight,
            resumeRoomId: resumeRoomId,
            updateRequired: updateRequired,
            storeURL: storeURL,
            rejoinRoomId: rejoinRoomId,
            serverRestartText: serverRestartText,
            joinFailureCategory: joinFailureCategory,
            joinFailureCode: joinFailureCode,
            entrySocketConnected: entrySocketConnected
        )
    }

    /// The same inputs with another entry media intent (the L9 fixture's scripted C1 answer).
    func withMediaIntent(micIntentOn mic: Bool, cameraIntentOn camera: Bool) -> PremeetingInputs {
        PremeetingInputs(
            callSession: callSession,
            phase: phase,
            notice: notice,
            noticeText: noticeText,
            outcomeId: outcomeId,
            outcomeKind: outcomeKind,
            outcomeServerText: outcomeServerText,
            roomLabel: roomLabel,
            isLocalHost: isLocalHost,
            isWebinarAttendee: isWebinarAttendee,
            hasBeenAdmittedThisSession: hasBeenAdmittedThisSession,
            entryOrigin: entryOrigin,
            currentRoomId: currentRoomId,
            roomAliases: roomAliases,
            currentJoinMode: currentJoinMode,
            isSignedIn: isSignedIn,
            accountName: accountName,
            accountSeed: accountSeed,
            isSigningIn: isSigningIn,
            isNetworkOffline: isNetworkOffline,
            isAppActive: isAppActive,
            micIntentOn: mic,
            cameraIntentOn: camera,
            resumeInFlight: resumeInFlight,
            resumeRoomId: resumeRoomId,
            updateRequired: updateRequired,
            storeURL: storeURL,
            rejoinRoomId: rejoinRoomId,
            serverRestartText: serverRestartText,
            joinFailureCategory: joinFailureCategory,
            joinFailureCode: joinFailureCode,
            entrySocketConnected: entrySocketConnected
        )
    }

    /// The session part from a published S1 snapshot; the rest copied from `base`. Used by the view model and by the
    /// L9 fixture, which feeds a standalone shell.
    static func from(session: MeetingSessionSnapshot, base: PremeetingInputs) -> PremeetingInputs {
        PremeetingInputs(
            callSession: session.identity.callSession,
            phase: session.phase,
            notice: session.notice,
            noticeText: session.noticeText ?? "",
            outcomeId: session.outcome?.id ?? 0,
            outcomeKind: session.outcome?.kind,
            outcomeServerText: session.outcome?.serverText ?? "",
            roomLabel: session.roomLabel,
            isLocalHost: session.isLocalHost,
            isWebinarAttendee: session.isWebinarAttendee,
            hasBeenAdmittedThisSession: session.hasBeenAdmittedThisSession,
            entryOrigin: session.entryOrigin,
            currentRoomId: base.currentRoomId,
            roomAliases: base.roomAliases,
            currentJoinMode: base.currentJoinMode,
            isSignedIn: base.isSignedIn,
            accountName: base.accountName,
            accountSeed: base.accountSeed,
            isSigningIn: base.isSigningIn,
            isNetworkOffline: base.isNetworkOffline,
            isAppActive: base.isAppActive,
            micIntentOn: base.micIntentOn,
            cameraIntentOn: base.cameraIntentOn,
            resumeInFlight: base.resumeInFlight,
            resumeRoomId: base.resumeRoomId,
            updateRequired: base.updateRequired,
            storeURL: base.storeURL,
            rejoinRoomId: base.rejoinRoomId,
            serverRestartText: base.serverRestartText,
            joinFailureCategory: base.joinFailureCategory,
            joinFailureCode: base.joinFailureCode,
            entrySocketConnected: base.entrySocketConnected
        )
    }
}
