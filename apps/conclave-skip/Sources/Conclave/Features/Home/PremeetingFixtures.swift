import Foundation
import Observation

enum PremeetingFixtureState: String, CaseIterable, Equatable {

    case home

    case empty
    case noticeEndedByHost = "notice-ended-by-host"
    case noticeInvalidLink = "notice-invalid-link"
    case noticeMovedToAudience = "notice-moved-to-audience"

    case updateRequired = "update-required"

    case connecting

    case waiting

    case resume

    case connectingToCall = "connecting-to-call"

    case inCall
    case outcomeRemoved = "outcome-removed"
    case outcomeConnectionLost = "outcome-connection-lost"

    case joinFailed = "join-failed"

    case lobby

    case lobbyNameMissing = "lobby-name-missing"

    case lobbyNewMeeting = "lobby-new-meeting"

    case lobbyPermissionsUndetermined = "lobby-permissions-undetermined"
    case lobbyMicRationale = "lobby-mic-rationale"
    case lobbyCameraRationale = "lobby-camera-rationale"
    case lobbyPermissionsDenied = "lobby-permissions-denied"
    case lobbyPermissionsRestricted = "lobby-permissions-restricted"

    case accountSignedOut = "account-signed-out"
    case accountSignedIn = "account-signed-in"
    case accountSignInCancel = "account-sign-in-cancel"
    case accountSignInFailure = "account-sign-in-failure"
    case accountExpired = "account-expired"
    case accountDeleteFailure = "account-delete-failure"
    case accountGoogleOnly = "account-google-only"
    case accountAppleOnly = "account-apple-only"
    case accountProvidersFailed = "account-providers-failed"

    case failedNetwork = "failed-network"

    case failedServerBusy = "failed-server-busy"

    case retryAfter = "retry-after"

    case recoveringBeforeAdmission = "recovering-before-admission"

    case waitingLocked = "waiting-locked"
    case waitingNoHost = "waiting-no-host"
    case waitingHostAvailable = "waiting-host-available"
    case waitingReconnecting = "waiting-reconnecting"
    case waitingOffline = "waiting-offline"
    case waitingServerRestarting = "waiting-server-restarting"

    case waitingToAdmitted = "waiting-to-admitted"

    case waitingDenied = "waiting-denied"

    case outcomeDenied = "outcome-denied"
    case outcomeServerDisconnected = "outcome-server-disconnected"
    case outcomeRejoinFailed = "outcome-rejoin-failed"

    case noticeRoomClosed = "notice-room-closed"

    case homeRejoin = "home-rejoin"

    case webinarLoading = "webinar-loading"

    case webinarEarly = "webinar-early"

    case webinarEarlyOneMinute = "webinar-early-one-minute"

    case webinarEarlyShort = "webinar-early-short"

    case webinarNoCalendar = "webinar-no-calendar"

    case webinarOpen = "webinar-open"

    case webinarNameNeeded = "webinar-name-needed"

    case webinarInviteCode = "webinar-invite-code"

    case webinarJoining = "webinar-joining"

    case webinarAlmostThere = "webinar-almost-there"

    case webinarToCall = "webinar-to-call"

    case webinarWaitingHost = "webinar-waiting-host"
    case webinarLocked = "webinar-locked"
    case webinarFull = "webinar-full"
    case webinarUnavailable = "webinar-unavailable"
    case webinarEnded = "webinar-ended"
    case webinarCancelled = "webinar-cancelled"

    case webinarFailed = "webinar-failed"
}

struct PremeetingFixtureStep: Equatable {
    let delayMillis: Int
    let shell: MeetingShellInputs
    let base: PremeetingInputs
}

enum PremeetingFixtureScript {
    static let roomLabel = "rose-sora-luffy"
    static let selfCheckMillis = 10000
    static let selfCheckKey = "premeeting.fixture.selfCheck"

    static let entryAnchorKey = "premeeting.fixture.entryAnchor"
    static let stateKey = "premeeting.fixture.state"

    static func state(named raw: String) -> PremeetingFixtureState? {
        PremeetingFixtureState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static let identity = MeetingSessionIdentity(callSession: 1, attempt: 1, attemptToken: "fixture-1")

    static func base(updateRequired: Bool = false, resumeInFlight: Bool = false, guestName: String = "",
                     isNetworkOffline: Bool = false, rejoinRoomId: String = "", serverRestartText: String = "",
                     joinFailureCategory: String = "", joinFailureCode: String = "") -> PremeetingInputs {
        PremeetingInputs.make(
            currentRoomId: roomLabel,
            currentJoinMode: .meeting,
            accountName: guestName,
            isNetworkOffline: isNetworkOffline,
            isAppActive: true,
            resumeInFlight: resumeInFlight,
            resumeRoomId: resumeInFlight ? roomLabel : "",
            updateRequired: updateRequired,
            storeURL: updateRequired ? "https://apps.apple.com/app/id0" : "",
            rejoinRoomId: rejoinRoomId,
            serverRestartText: serverRestartText,
            joinFailureCategory: joinFailureCategory,
            joinFailureCode: joinFailureCode
        )
    }

    static func waiting(message: String? = nil, isRecoveringConnection: Bool = false) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity,
                                connectionState: isRecoveringConnection ? ConnectionState.reconnecting : ConnectionState.waiting,
                                isRecoveringConnection: isRecoveringConnection, waitingMessage: message,
                                roomId: roomLabel, displayName: "Avery")
    }

    static func recovering() -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity, connectionState: .reconnecting, isRecoveringConnection: true,
                                roomId: roomLabel, displayName: "Avery")
    }

    static let restartSentence = "Conclave is updating. Hang on for a moment."

    static let rejoinMicOn = true
    static let rejoinCameraOn = false

    static func connecting(isMuted: Bool = true, isCameraOff: Bool = true) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity, connectionState: .connecting, roomId: roomLabel, displayName: "Avery",
                                isMuted: isMuted, isCameraOff: isCameraOff)
    }

    static func joined() -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity, connectionState: .joined, roomId: roomLabel, displayName: "Avery")
    }

    static func ended(_ kind: MeetingTerminalOutcomeKind, connectionState: ConnectionState) -> MeetingShellInputs {
        let outcome = MeetingTerminalOutcome(id: 1, callSession: identity.callSession, kind: kind, serverText: "")
        return MeetingShellInputs.make(identity: identity, connectionState: connectionState, roomId: roomLabel,
                                       displayName: "Avery", terminalOutcome: outcome)
    }

    static func home() -> MeetingShellInputs {
        MeetingShellInputs.make()
    }

    static func steps(for state: PremeetingFixtureState) -> [PremeetingFixtureStep] {
        let plain = base()
        switch state {
        case .home, .empty, .noticeInvalidLink, .noticeMovedToAudience,
             .accountSignedOut, .accountSignedIn, .accountSignInCancel, .accountSignInFailure, .accountExpired,
             .accountDeleteFailure, .accountGoogleOnly, .accountAppleOnly, .accountProvidersFailed:
            return [PremeetingFixtureStep(delayMillis: 0, shell: home(), base: plain)]
        case .noticeEndedByHost:
            let notice = MeetingShellInputs.make(meetingEndedNoticeMessage: "The host ended the meeting.")
            return [PremeetingFixtureStep(delayMillis: 0, shell: notice, base: plain)]
        case .updateRequired:
            return [PremeetingFixtureStep(delayMillis: 0, shell: home(), base: base(updateRequired: true))]
        case .connecting:
            return [PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain)]
        case .waiting:
            let waiting = MeetingShellInputs.make(identity: identity, connectionState: .waiting, roomId: roomLabel,
                                                  displayName: "Avery")
            return [PremeetingFixtureStep(delayMillis: 0, shell: waiting, base: plain)]
        case .resume:

            return [PremeetingFixtureStep(delayMillis: 0, shell: connecting(isMuted: true, isCameraOff: true),
                                          base: base(resumeInFlight: true))]
        case .connectingToCall:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 3000, shell: joined(), base: plain)
            ]
        case .inCall:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: joined(), base: plain)
            ]
        case .outcomeRemoved:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: joined(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: ended(.removed, connectionState: .error), base: plain)
            ]
        case .outcomeConnectionLost:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: joined(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: ended(.connectionLost, connectionState: .error),
                                      base: base(rejoinRoomId: roomLabel))
            ]
        case .joinFailed:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: ended(.joinFailed, connectionState: .error), base: plain)
            ]
        case .lobby, .lobbyNewMeeting, .lobbyPermissionsUndetermined, .lobbyMicRationale, .lobbyCameraRationale,
             .lobbyPermissionsDenied, .lobbyPermissionsRestricted:
            return [PremeetingFixtureStep(delayMillis: 0, shell: home(), base: base(guestName: lobbyGuestName))]
        case .lobbyNameMissing:
            return [PremeetingFixtureStep(delayMillis: 0, shell: home(), base: plain)]
        case .failedNetwork:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: ended(.joinFailed, connectionState: .error),
                                      base: base(joinFailureCategory: MeetingErrorCategory.serverUnreachable.rawValue,
                                                 joinFailureCode: "url.unreachable"))
            ]
        case .failedServerBusy:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 2000, shell: ended(.joinFailed, connectionState: .error),
                                      base: base(joinFailureCategory: MeetingErrorCategory.serverBusy.rawValue,
                                                 joinFailureCode: "http.503"))
            ]
        case .retryAfter:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 2000, shell: joined(), base: plain)
            ]
        case .recoveringBeforeAdmission:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: recovering(), base: plain)
            ]
        case .waitingLocked:
            return [PremeetingFixtureStep(delayMillis: 0,
                                          shell: waiting(message: "This meeting is locked. Waiting for the host to let you in."),
                                          base: plain)]
        case .waitingNoHost:
            return [PremeetingFixtureStep(delayMillis: 0, shell: waiting(message: "No one to let you in."), base: plain)]
        case .waitingHostAvailable:
            return [PremeetingFixtureStep(delayMillis: 0, shell: waiting(message: "A host is available to let you in."),
                                          base: plain)]
        case .waitingReconnecting:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: waiting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: recovering(), base: plain)
            ]
        case .waitingOffline:
            return [PremeetingFixtureStep(delayMillis: 0, shell: waiting(), base: base(isNetworkOffline: true))]
        case .waitingServerRestarting:
            return [PremeetingFixtureStep(delayMillis: 0, shell: waiting(),
                                          base: base(serverRestartText: restartSentence))]
        case .waitingToAdmitted:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: waiting(), base: plain),
                PremeetingFixtureStep(delayMillis: 3000, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 1000, shell: joined(), base: plain)
            ]
        case .waitingDenied:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: waiting(), base: plain),
                PremeetingFixtureStep(delayMillis: 3000, shell: ended(.denied, connectionState: .error), base: plain)
            ]
        case .outcomeDenied:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: waiting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: ended(.denied, connectionState: .error), base: plain)
            ]
        case .outcomeServerDisconnected:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: joined(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: ended(.serverDisconnected, connectionState: .disconnected),
                                      base: base(rejoinRoomId: roomLabel))
            ]
        case .outcomeRejoinFailed:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: joined(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: recovering(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: ended(.joinFailed, connectionState: .error),
                                      base: base(rejoinRoomId: roomLabel,
                                                 joinFailureCategory: MeetingErrorCategory.offline.rawValue,
                                                 joinFailureCode: "url.offline"))
            ]
        case .noticeRoomClosed:
            return [
                PremeetingFixtureStep(delayMillis: 0, shell: connecting(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: joined(), base: plain),
                PremeetingFixtureStep(delayMillis: 0, shell: ended(.roomClosed, connectionState: .error), base: plain)
            ]
        case .homeRejoin:
            return [PremeetingFixtureStep(delayMillis: 0, shell: home(), base: base(rejoinRoomId: roomLabel))]
        case .webinarLoading, .webinarEarly, .webinarEarlyOneMinute, .webinarEarlyShort, .webinarNoCalendar, .webinarOpen,
             .webinarNameNeeded, .webinarInviteCode, .webinarJoining, .webinarAlmostThere, .webinarToCall,
             .webinarWaitingHost, .webinarLocked, .webinarFull, .webinarUnavailable, .webinarEnded, .webinarCancelled,
             .webinarFailed:

            return [PremeetingFixtureStep(delayMillis: 0, shell: home(),
                                          base: WebinarLandingFixtureScript.base(guestName: WebinarLandingFixtureScript.guestName(for: state)))]
        }
    }

    static let lobbyGuestName = "Avery"

    static let newMeetingCode = "lily-zoro-iris"

    static let presenceCount = 2

    static func lobbyLink(for state: PremeetingFixtureState) -> String {
        state == .lobby || state == .lobbyNameMissing || PermissionPrimingFixture.permissions(forState: state.rawValue) != nil
            ? "https://conclave.acmvit.in/" + roomLabel : ""
    }

    static func opensNewMeeting(for state: PremeetingFixtureState) -> Bool {
        state == .lobbyNewMeeting
    }

    static func isLobbyFixture(_ state: PremeetingFixtureState) -> Bool {
        state == .lobby || state == .lobbyNameMissing || state == .lobbyNewMeeting
            || PermissionPrimingFixture.permissions(forState: state.rawValue) != nil
    }

    static func cameraPermission(for state: PremeetingFixtureState) -> MediaPermissionState {
        state == .lobbyNewMeeting ? MediaPermissionState.unavailable : MediaPermissionState.denied
    }

    static func micPermission(for state: PremeetingFixtureState) -> MediaPermissionState {
        MediaPermissionState.granted
    }

    static let lobbyRoutes: [AudioRouteOption] = [
        AudioRouteOption(id: "fixture-speaker", kind: .speaker, name: "", isConnecting: false),
        AudioRouteOption(id: "fixture-receiver", kind: .receiver, name: "", isConnecting: false)
    ]

    static func recents(for state: PremeetingFixtureState, nowMillis: Double) -> [RecentMeetingRecord] {
        if state == .empty { return [] }
        let minute = 60.0 * 1000.0
        let day = 24.0 * 60.0 * minute
        return [
            RecentMeetingRecord(id: RecentMeetingsPolicy.recordId(roomId: "rose-sora-luffy", joinMode: .meeting),
                                roomId: "rose-sora-luffy", title: "rose-sora-luffy", joinMode: JoinMode.meeting.rawValue,
                                role: RecentRole.participant.rawValue, lastJoinedAtMillis: nowMillis - 40.0 * minute,
                                endedAtMillis: nowMillis - 3.0 * minute, end: RecentEnd.left.rawValue),
            RecentMeetingRecord(id: RecentMeetingsPolicy.recordId(roomId: "lily-zoro-iris", joinMode: .meeting),
                                roomId: "lily-zoro-iris", title: "lily-zoro-iris", joinMode: JoinMode.meeting.rawValue,
                                role: RecentRole.host.rawValue, lastJoinedAtMillis: nowMillis - day,
                                endedAtMillis: nowMillis - day + 30.0 * minute, end: RecentEnd.endedByYou.rawValue),
            RecentMeetingRecord(id: RecentMeetingsPolicy.recordId(roomId: "maple-goku-tulip", joinMode: .meeting),
                                roomId: "maple-goku-tulip", title: "maple-goku-tulip", joinMode: JoinMode.meeting.rawValue,
                                role: RecentRole.participant.rawValue, lastJoinedAtMillis: nowMillis - 3.0 * day,
                                endedAtMillis: nowMillis - 3.0 * day + 45.0 * minute, end: RecentEnd.left.rawValue),
            RecentMeetingRecord(id: RecentMeetingsPolicy.recordId(roomId: WebinarLandingFixtureScript.slug, joinMode: .webinarAttendee),
                                roomId: WebinarLandingFixtureScript.slug, title: WebinarLandingFixtureScript.title,
                                joinMode: JoinMode.webinarAttendee.rawValue, role: RecentRole.attendee.rawValue,
                                lastJoinedAtMillis: nowMillis - 6.0 * day, endedAtMillis: nowMillis - 6.0 * day + 60.0 * minute,
                                end: RecentEnd.left.rawValue)
        ]
    }

    static func localNotice(for state: PremeetingFixtureState) -> HomeNoticeKind {
        switch state {
        case .noticeInvalidLink:
            return .invalidLink
        case .noticeMovedToAudience:
            return .movedToAudience
        default:
            return .none
        }
    }
}

@MainActor
@Observable
final class PremeetingFixtureSession {
    let shell = MeetingShellPresenter()
    let premeeting = PremeetingPresenter()
    let state: PremeetingFixtureState

    private(set) var selfCheckReadout = "pending"
    @ObservationIgnored private var timeline: Task<Void, Never>? = nil
    @ObservationIgnored private var appliedSteps = 0
    @ObservationIgnored private var baselineShellPublishes = 0
    @ObservationIgnored private var baselineInputs = PremeetingInputs.make()
    @ObservationIgnored private var lastBase = PremeetingInputs.make()
    @ObservationIgnored private var lastShell = MeetingShellInputs.make()
    @ObservationIgnored private var failed = false
    @ObservationIgnored private var started = false

    @ObservationIgnored private var webinarTapTask: Task<Void, Never>? = nil
    @ObservationIgnored private var webinarOutcomeTask: Task<Void, Never>? = nil
    @ObservationIgnored private var webinarOutcomeId = 0

    init(state: PremeetingFixtureState) {
        self.state = state
    }

    func start() {

        guard !started else { return }
        started = true
        let now = premeeting.nowMillis()
        premeeting.bootstrap(user: nil, recents: PremeetingFixtureScript.recents(for: state, nowMillis: now))
        premeeting.onCommand = { [weak self] command in
            self?.answer(command)
        }
        let notice = PremeetingFixtureScript.localNotice(for: state)
        if notice != .none {
            premeeting.showHomeNotice(notice)
        }

        premeeting.lobbyHooks = makeLobbyHooks()
        let steps = PremeetingFixtureScript.steps(for: state)
        var remaining: [PremeetingFixtureStep] = []
        var scheduling = false
        for step in steps {
            if !scheduling && step.delayMillis == 0 {
                apply(step)
            } else {
                scheduling = true
                remaining.append(step)
            }
        }
        if PremeetingFixtureScript.isLobbyFixture(state) {
            openLobby()
        }
        if WebinarLandingFixtureScript.isWebinarFixture(state) {
            openWebinarLanding(startedAtMillis: now)
        }
        timeline?.cancel()
        timeline = Task { @MainActor [weak self] in
            for step in remaining {
                try? await Task.sleep(nanoseconds: UInt64(Double(step.delayMillis) * 1_000_000.0))
                guard !Task.isCancelled, let self else { return }
                self.verifyStep()
                self.apply(step)
            }
            try? await Task.sleep(nanoseconds: UInt64(Double(PremeetingFixtureScript.selfCheckMillis) * 1_000_000.0))
            guard !Task.isCancelled, let self else { return }
            self.verifyStep()
        }

        AccountFixtureScript.install(fixtureState: state.rawValue, account: premeeting.account, premeeting: premeeting)
    }

    func stop() {
        timeline?.cancel()
        timeline = nil
        webinarTapTask?.cancel()
        webinarTapTask = nil
        webinarOutcomeTask?.cancel()
        webinarOutcomeTask = nil
    }

    func handleIncomingURL(_ raw: String) {
        premeeting.handleIncomingURL(raw)
    }

    private func apply(_ step: PremeetingFixtureStep) {
        lastBase = step.base
        lastShell = step.shell
        shell.apply(step.shell)
        premeeting.apply(PremeetingInputs.from(session: shell.session, base: step.base))
        appliedSteps += 1
        recordBaseline()
    }

    private func openLobby() {
        premeeting.generateRoomCode = { PremeetingFixtureScript.newMeetingCode }
        if let priming = PermissionPrimingFixture.permissions(forState: state.rawValue) {

            premeeting.applyPermissions(microphone: priming.microphone, camera: priming.camera,
                                        canAskAgainMicrophone: priming.canAskAgainMicrophone,
                                        canAskAgainCamera: priming.canAskAgainCamera)
        } else {
            premeeting.applyPermissions(microphone: PremeetingFixtureScript.micPermission(for: state),
                                        camera: PremeetingFixtureScript.cameraPermission(for: state),
                                        canAskAgainMicrophone: false, canAskAgainCamera: false)
        }
        premeeting.applyAudioRoutes(outputs: PremeetingFixtureScript.lobbyRoutes, currentOutputId: "fixture-speaker",
                                    inputOptions: [], currentInputId: "")
        let link = PremeetingFixtureScript.lobbyLink(for: state)
        if !link.isEmpty {
            premeeting.handleIncomingURL(link)
        }
        if PremeetingFixtureScript.opensNewMeeting(for: state) {
            premeeting.newMeeting()
        }
    }

    private func makeLobbyHooks() -> LobbyCoreHooks {
        let hooks = LobbyCoreHooks()
        hooks.setEntryMediaIntent = { [weak self] mic, camera in
            self?.applyMediaIntent(mic: mic, camera: camera)
        }
        hooks.join = { [weak self] _ in
            self?.scriptJoin()
        }
        hooks.fetchPresence = { _, _ in
            PremeetingFixtureScript.presenceCount
        }
        hooks.resolvedClientId = {
            MeetingLinkBuilder.defaultClientId
        }
        return hooks
    }

    private func applyMediaIntent(mic: Bool, camera: Bool) {
        apply(PremeetingFixtureStep(delayMillis: 0, shell: lastShell,
                                    base: lastBase.withMediaIntent(micIntentOn: mic, cameraIntentOn: camera)))
    }

    private func scriptJoin() {
        apply(PremeetingFixtureStep(delayMillis: 0,
                                    shell: PremeetingFixtureScript.connecting(isMuted: !lastBase.micIntentOn,
                                                                              isCameraOff: !lastBase.cameraIntentOn),
                                    base: lastBase))
    }

    private func openWebinarLanding(startedAtMillis: Double) {
        premeeting.webinarCalendarResolverDisabled = WebinarLandingFixtureScript.disablesCalendarResolver(state)
        premeeting.webinarHooks = makeWebinarHooks(startedAtMillis: startedAtMillis)
        premeeting.handleIncomingURL(WebinarLandingFixtureScript.link)
        guard WebinarLandingFixtureScript.join(for: state) != WebinarFixtureJoin.none else { return }
        webinarTapTask?.cancel()
        webinarTapTask = Task { @MainActor [weak self] in
            var attempt = 0
            while attempt < WebinarLandingFixtureScript.tapAttempts {
                attempt += 1
                try? await Task.sleep(nanoseconds: UInt64(Double(WebinarLandingFixtureScript.tapIntervalMillis) * 1_000_000.0))
                guard !Task.isCancelled, let self else { return }
                if self.premeeting.webinarJoinRequestCount > 0 {
                    return
                }
                self.premeeting.startWatching()
            }
        }
    }

    private func makeWebinarHooks(startedAtMillis: Double) -> WebinarLandingHooks {
        let hooks = WebinarLandingHooks()
        let fixtureState = state
        hooks.lookup = { _, _ in
            let delay = WebinarLandingFixtureScript.lookupDelayMillis(for: fixtureState)
            if delay > 0.0 {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000.0))
            }
            return WebinarLandingFixtureScript.answer(for: fixtureState, startedAtMillis: startedAtMillis)
        }
        hooks.join = { [weak self] _ in
            self?.scriptWebinarJoin()
        }
        return hooks
    }

    private func scriptWebinarJoin() {
        let join = WebinarLandingFixtureScript.join(for: state)
        let name = WebinarLandingFixtureScript.guestName(for: state)
        apply(PremeetingFixtureStep(delayMillis: 0, shell: WebinarLandingFixtureScript.connecting(guestName: name),
                                    base: WebinarLandingFixtureScript.base(guestName: name,
                                                                           socketConnected: join == WebinarFixtureJoin.almostThere)))
        guard join == WebinarFixtureJoin.call || WebinarLandingFixtureScript.endsInFailure(join) else { return }
        webinarOutcomeTask?.cancel()
        let delay = join == WebinarFixtureJoin.call ? WebinarLandingFixtureScript.callDelayMillis
            : WebinarLandingFixtureScript.outcomeDelayMillis
        webinarOutcomeId += 1
        let outcomeId = webinarOutcomeId
        webinarOutcomeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Double(delay) * 1_000_000.0))
            guard !Task.isCancelled, let self else { return }
            self.webinarOutcomeTask = nil
            if join == WebinarFixtureJoin.call {
                self.apply(PremeetingFixtureStep(delayMillis: 0, shell: WebinarLandingFixtureScript.joined(guestName: name),
                                                 base: WebinarLandingFixtureScript.base(guestName: name, socketConnected: true)))
            } else {
                self.apply(PremeetingFixtureStep(
                    delayMillis: 0,
                    shell: WebinarLandingFixtureScript.failed(guestName: name, serverText: WebinarLandingFixtureScript.serverText(join),
                                                              outcomeId: outcomeId),
                    base: WebinarLandingFixtureScript.base(guestName: name,
                                                           joinFailureCategory: WebinarLandingFixtureScript.failureCategory(join),
                                                           joinFailureCode: WebinarLandingFixtureScript.failureCode(join))))
            }
        }
    }

    private func answer(_ command: PremeetingCommand) {
        switch command {
        case .leave, .dismissOutcome:

            webinarOutcomeTask?.cancel()
            webinarOutcomeTask = nil
            apply(PremeetingFixtureStep(delayMillis: 0, shell: PremeetingFixtureScript.home(), base: lastBase))
        case .joinAsSpeaker, .cancelPromotion:

            break
        case .rejoinLastMeeting:

            let mic = PremeetingFixtureScript.rejoinMicOn
            let camera = PremeetingFixtureScript.rejoinCameraOn
            apply(PremeetingFixtureStep(delayMillis: 0,
                                        shell: PremeetingFixtureScript.connecting(isMuted: !mic, isCameraOff: !camera),
                                        base: lastBase.withMediaIntent(micIntentOn: mic, cameraIntentOn: camera)))
        }
    }

    private func recordBaseline() {
        baselineShellPublishes = shell.snapshotPublishCount
        baselineInputs = premeeting.currentInputs
    }

    private func verifyStep() {
        let held = shell.snapshotPublishCount == baselineShellPublishes && premeeting.currentInputs == baselineInputs
        if !held {
            failed = true
        }
        let value = (failed ? "overwritten step=" : "ok step=") + String(appliedSteps)
        if value != selfCheckReadout {
            selfCheckReadout = value
        }
    }
}
