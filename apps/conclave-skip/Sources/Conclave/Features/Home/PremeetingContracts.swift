import Foundation

enum PremeetingRouteKind: String, CaseIterable, Equatable {
    case lobby, webinarLanding, account, privacyPolicy, settings
}

struct PremeetingRoute: Hashable {
    let id: Int
    let kind: PremeetingRouteKind
    let roomId: String

    static let recentRouteIdBase = 100000
}

enum LobbyIntent: String, CaseIterable, Equatable {
    case join, newMeeting, rejoin, resume, promotion
}

enum LobbyMode: String, CaseIterable, Equatable {
    case editing, connecting, waiting, failed
}

enum LobbyIssue: String, CaseIterable, Equatable {
    case none, offline, nameMissing, roomNotFound, inviteCodeRequired, inviteCodeInvalid, signInRequired,
         appSuspended, failedNetwork, failedMedia, failedServerBusy, failedServerText, failedUnknown,
         updateRequired
}

enum WaitingKind: String, CaseIterable, Equatable {
    case standard, locked, noHost, hostAvailable, reconnecting, offline, serverRestarting
}

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

    let waitingText: String
}

enum HomeNoticeKind: String, CaseIterable, Equatable {
    case none, endedByHost, roomClosed, invalidLink, sessionExpired, movedToAudience
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
    let avatarSeed: String
    let code: String
}

enum RecentMeetingRowPolicy {
    static func avatarSeed(roomId: String) -> String {
        roomId.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func code(title: String, roomId: String) -> String {
        let code = avatarSeed(roomId: roomId)
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if code.isEmpty || name.lowercased() == code.lowercased() {
            return ""
        }
        return code
    }
}

struct RejoinCard: Equatable {
    let recentId: String
    let title: String

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

    let updateRequired: Bool
    let storeURL: String

    static let empty = HomeSnapshot(revision: 0, noticeKind: .none, noticeText: "", rejoin: nil, recents: [],
                                    isSignedIn: false, accountName: "", accountSeed: "", updateRequired: false,
                                    storeURL: "")
}

struct RoomSwitchPrompt: Equatable {
    let id: Int

    let currentLabel: String

    let targetLabel: String
}

enum OutcomeVariant: String, CaseIterable, Equatable {
    case removed, denied, connectionLost, serverDisconnected, rejoinFailed
}

enum OutcomeAction: String, CaseIterable, Equatable {
    case rejoin, tryAgain, backHome, none
}

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

enum PremeetingRootKind: String, CaseIterable, Equatable {
    case premeeting, call
}

struct PremeetingRootDecision: Equatable {
    let root: PremeetingRootKind

    let lobbyMode: LobbyMode?

    let pushesLobby: Bool

    let showsReconnecting: Bool

    let showsOutcome: Bool

    static let home = PremeetingRootDecision(root: .premeeting, lobbyMode: nil, pushesLobby: false,
                                             showsReconnecting: false, showsOutcome: false)
    static let call = PremeetingRootDecision(root: .call, lobbyMode: nil, pushesLobby: false,
                                             showsReconnecting: false, showsOutcome: false)
}

enum PremeetingRootPolicy {

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

enum PremeetingCommand: String, CaseIterable, Equatable {

    case leave

    case dismissOutcome

    case rejoinLastMeeting

    case joinAsSpeaker

    case cancelPromotion
}

struct PremeetingInputs: Equatable {

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

    let currentRoomId: String
    let roomAliases: [String]
    let currentJoinMode: JoinMode

    let isSignedIn: Bool
    let accountName: String
    let accountSeed: String
    let isSigningIn: Bool

    let isNetworkOffline: Bool
    let isAppActive: Bool

    let micIntentOn: Bool
    let cameraIntentOn: Bool

    let resumeInFlight: Bool
    let resumeRoomId: String

    let updateRequired: Bool
    let storeURL: String

    let rejoinRoomId: String

    let serverRestartText: String

    let joinFailureCategory: String
    let joinFailureCode: String

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
