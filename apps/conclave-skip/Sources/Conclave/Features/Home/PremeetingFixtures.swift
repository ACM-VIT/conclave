import Foundation
import Observation

// ENT-1 (S10 0.6 L9): the Debug premeeting fixture route, `CONCLAVE_PREMEETING_FIXTURE=<state>` (iOS launch
// environment) and the intent extra `conclave.premeetingFixture` (Android, FLAG_DEBUGGABLE). It builds a standalone
// MeetingShellPresenter and PremeetingPresenter with no view model hook and no media, network or device store, hands
// them to the production roots, and applies scripted inputs and timelines. Silent-testing rules (OD Q19, PRE 24):
// nothing here joins a call, plays a sound or touches a legacy New or Join. Self-check: after each scripted step the
// fixture's inputs and the shell's publications must stay as the script left them until the next step or for 10 s,
// proving nothing real overwrites them.

enum PremeetingFixtureState: String, CaseIterable, Equatable {
    /// Recents plus a Rejoin card (left 3 minutes ago).
    case home
    /// First run: no recents, no card.
    case empty
    case noticeEndedByHost = "notice-ended-by-host"
    case noticeInvalidLink = "notice-invalid-link"
    case noticeMovedToAudience = "notice-moved-to-audience"
    /// R51: the "Update Conclave" banner; entries open the explanation.
    case updateRequired = "update-required"
    /// The lobby in Connecting (entering).
    case connecting
    /// The lobby in Waiting.
    case waiting
    /// S10 1 l5: process-death resume, previous session unmuted with the camera on; the lobby in Connecting with the
    /// resume intent (the S1 entry intent shows muted with the camera off, RECONCILE R4).
    case resume
    /// Timeline: connecting, then in call after 3 s (the call branch).
    case connectingToCall = "connecting-to-call"
    /// In call (the call branch); a deep link then shows the switch prompt (S10 4 l3).
    case inCall
    case outcomeRemoved = "outcome-removed"
    case outcomeConnectionLost = "outcome-connection-lost"
    /// An initial join failure: the lobby inline failed block (S10 0.4).
    case joinFailed = "join-failed"
    /// ENT-3 S10 6 l1: a joined-by-link lobby with an injected snapshot: camera blocked by a revoked permission,
    /// microphone allowed, guest name "Avery", two people here, no network or media.
    case lobby
    /// S10 6 l10: the same lobby with no name, so the primary is disabled with its reason.
    case lobbyNameMissing = "lobby-name-missing"
    /// S10 6 f `newMeeting`: the generated code as the title, Start Meeting, no link and no Share (Q1), no camera.
    case lobbyNewMeeting = "lobby-new-meeting"
    /// ENT-4 (S10 7 l; HD request B7-T8 R3): the permission priming states, each a joined-by-link lobby like `lobby` with
    /// the permissions `PermissionPrimingFixture` names (S/Features/Lobby/PermissionPrimingPolicy.swift). The fixture's
    /// hooks never request, so no system prompt can appear.
    case lobbyPermissionsUndetermined = "lobby-permissions-undetermined"
    case lobbyMicRationale = "lobby-mic-rationale"
    case lobbyCameraRationale = "lobby-camera-rationale"
    case lobbyPermissionsDenied = "lobby-permissions-denied"
    case lobbyPermissionsRestricted = "lobby-permissions-restricted"
    /// ENT-7 (S10 5 l): Account states. `AccountFixtureScript` (S/Features/Account/AccountFixtures.swift) scripts the
    /// identity and the answers; Home stays the root content.
    case accountSignedOut = "account-signed-out"
    case accountSignedIn = "account-signed-in"
    case accountSignInCancel = "account-sign-in-cancel"
    case accountSignInFailure = "account-sign-in-failure"
    case accountExpired = "account-expired"
    case accountDeleteFailure = "account-delete-failure"
    case accountGoogleOnly = "account-google-only"
    case accountAppleOnly = "account-apple-only"
    case accountProvidersFailed = "account-providers-failed"
    // ENT-5 (S10 8 l, 9 l): the entry states on scripted timelines (no network, no media, no VM).
    /// 8 l4: an initial failure the classifier reads as the network; the failed block with Try Again.
    case failedNetwork = "failed-network"
    /// 8 l7b: two 503 answers; after the one automatic retry the failed block says the server is restarting.
    case failedServerBusy = "failed-server-busy"
    /// 8 l7b: a 503 with Retry-After 2 then success: Connecting throughout, the call after 2 s.
    case retryAfter = "retry-after"
    /// 8 l5: a drop before the first admission stays in the lobby with "Reconnecting".
    case recoveringBeforeAdmission = "recovering-before-admission"
    /// 9 l1, l6: one fixture per waiting body.
    case waitingLocked = "waiting-locked"
    case waitingNoHost = "waiting-no-host"
    case waitingHostAvailable = "waiting-host-available"
    case waitingReconnecting = "waiting-reconnecting"
    case waitingOffline = "waiting-offline"
    case waitingServerRestarting = "waiting-server-restarting"
    /// 9 l2: waiting, admitted after 3 s (Connecting), the call 1 s later.
    case waitingToAdmitted = "waiting-to-admitted"
    /// 9 l3: waiting, declined after 3 s: the outcome screen replaces the lobby.
    case waitingDenied = "waiting-denied"
    // ENT-6 (S10 10 l): every outcome row.
    case outcomeDenied = "outcome-denied"
    case outcomeServerDisconnected = "outcome-server-disconnected"
    case outcomeRejoinFailed = "outcome-rejoin-failed"
    /// 10 f `roomClosed`: the Home notice, no outcome screen.
    case noticeRoomClosed = "notice-room-closed"
    /// 2 j, RECONCILE R4: the Rejoin card with the view model's rejoin context; Rejoin connects with the previous
    /// intent (microphone on, camera off) instead of opening an editable lobby.
    case homeRejoin = "home-rejoin"
}

/// One scripted step: shell inputs and the premeeting-only inputs, applied after `delayMillis` from the previous step.
struct PremeetingFixtureStep: Equatable {
    let delayMillis: Int
    let shell: MeetingShellInputs
    let base: PremeetingInputs
}

enum PremeetingFixtureScript {
    static let roomLabel = "rose-sora-luffy"
    static let selfCheckMillis = 10000
    static let selfCheckKey = "premeeting.fixture.selfCheck"
    /// ENT-5 (S10 8 l8): the iOS readout of the card frame the entry expansion started from.
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

    /// The waiting room with a server sentence (S10 9 f triggers).
    static func waiting(message: String? = nil, isRecoveringConnection: Bool = false) -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity,
                                connectionState: isRecoveringConnection ? ConnectionState.reconnecting : ConnectionState.waiting,
                                isRecoveringConnection: isRecoveringConnection, waitingMessage: message,
                                roomId: roomLabel, displayName: "Avery")
    }

    /// A drop before or after an admission (the shell's `recovering` phase).
    static func recovering() -> MeetingShellInputs {
        MeetingShellInputs.make(identity: identity, connectionState: .reconnecting, isRecoveringConnection: true,
                                roomId: roomLabel, displayName: "Avery")
    }

    /// A clean server restart notice while waiting (S10 9 f `serverRestarting` shows the server text when present).
    static let restartSentence = "Conclave is updating. Hang on for a moment."

    /// ENT-6 (R4): the previous session's intent the scripted rejoin restores.
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

    /// The steps of a state, in order. A state that needs a prior phase lists it first, so the presenters see the
    /// transitions a real session produces (for example, admission before a removal).
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
            // R4: a resume restores muted with the camera off whatever the previous session had.
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
        }
    }

    // MARK: Lobby fixtures (ENT-3, S10 6 l)

    static let lobbyGuestName = "Avery"
    /// The C17 code the `lobby-new-meeting` fixture generates (fixed, so screenshots are stable).
    static let newMeetingCode = "lily-zoro-iris"
    /// The scripted presence answer: "2 people here".
    static let presenceCount = 2

    /// The link a lobby fixture opens through the production intake ("" for none).
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

    /// Camera blocked by a revoked permission in the join lobbies (6 l1); no camera hardware in the new meeting lobby
    /// (the silent simulator and AVD have none).
    static func cameraPermission(for state: PremeetingFixtureState) -> MediaPermissionState {
        state == .lobbyNewMeeting ? MediaPermissionState.unavailable : MediaPermissionState.denied
    }

    static func micPermission(for state: PremeetingFixtureState) -> MediaPermissionState {
        MediaPermissionState.granted
    }

    /// Two routes, so the Android route dialog has a choice (nothing is ever routed).
    static let lobbyRoutes: [AudioRouteOption] = [
        AudioRouteOption(id: "fixture-speaker", kind: .speaker, name: "", isConnecting: false),
        AudioRouteOption(id: "fixture-receiver", kind: .receiver, name: "", isConnecting: false)
    ]

    /// Stored recents for a state (in memory only): a card candidate and two older rows.
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
                                endedAtMillis: nowMillis - 3.0 * day + 45.0 * minute, end: RecentEnd.left.rawValue)
        ]
    }

    /// The local notice a state shows (notices the session does not publish).
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

/// The standalone presenters of one fixture run. Commands from the premeeting presenter are answered by the script
/// (Leave goes Home, a dismissed outcome goes Home), never by a view model.
@MainActor
@Observable
final class PremeetingFixtureSession {
    let shell = MeetingShellPresenter()
    let premeeting = PremeetingPresenter()
    let state: PremeetingFixtureState
    /// `pending`, then `ok step=N` while every step held, or `overwritten step=N` (ASCII, scripts read it).
    private(set) var selfCheckReadout = "pending"
    @ObservationIgnored private var timeline: Task<Void, Never>? = nil
    @ObservationIgnored private var appliedSteps = 0
    @ObservationIgnored private var baselineShellPublishes = 0
    @ObservationIgnored private var baselineInputs = PremeetingInputs.make()
    @ObservationIgnored private var lastBase = PremeetingInputs.make()
    @ObservationIgnored private var lastShell = MeetingShellInputs.make()
    @ObservationIgnored private var failed = false
    @ObservationIgnored private var started = false

    init(state: PremeetingFixtureState) {
        self.state = state
    }

    /// Bootstraps synchronously (first frame), applies the zero-delay steps at once and schedules the rest plus the
    /// self-check.
    func start() {
        // Idempotent: a root may call it again when its appearance callback re-fires.
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
        // ENT-3: scripted lobby hooks (no media, no network, no call): the C1 intent and a join answered by the script.
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
        // ENT-7 (HD request B4-T3 R9): the scripted account responder for every state, so the account button never
        // reaches the network; account states also open Account. It leaves the inputs the self-check compares alone.
        AccountFixtureScript.install(fixtureState: state.rawValue, account: premeeting.account, premeeting: premeeting)
    }

    func stop() {
        timeline?.cancel()
        timeline = nil
    }

    /// A deep link into the fixture route (S10 4 l2, l3): the same intake as production.
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

    /// The lobby fixtures: the injected device snapshot (6 l1), then the lobby through the production intake.
    private func openLobby() {
        premeeting.generateRoomCode = { PremeetingFixtureScript.newMeetingCode }
        if let priming = PermissionPrimingFixture.permissions(forState: state.rawValue) {
            // ENT-4 (S10 7 l): undetermined, refused once, refused for good and restricted come from the fixture only.
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

    /// Scripted answers in place of the view model: the media intent becomes the next inputs and a join shows
    /// Connecting (Cancel then goes Home); presence answers two people. Nothing reaches media or the network.
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

    private func answer(_ command: PremeetingCommand) {
        switch command {
        case .leave, .dismissOutcome:
            // Scripted, never a view model: the session goes Home.
            apply(PremeetingFixtureStep(delayMillis: 0, shell: PremeetingFixtureScript.home(), base: lastBase))
        case .joinAsSpeaker, .cancelPromotion:
            // S50 PH20: the promotion lobby lives over the attendee viewer in the call root, never in this fixture.
            break
        case .rejoinLastMeeting:
            // ENT-6 (R4): the scripted context rejoins with the previous intent and shows Connecting; nothing joins.
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
