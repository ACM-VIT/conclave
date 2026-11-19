#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct S1bLobbyStatusTests {
    static let policyFile = "Sources/Conclave/Features/Lobby/LobbyStatusPolicy.swift"
    static let rowsFile = "Sources/Conclave/Features/Lobby/LobbyStatusRow+iOS.swift"
    static let entryFile = "Sources/Conclave/Features/Lobby/EntryStatusBlock+iOS.swift"
    static let lobbyFile = "Sources/Conclave/Features/Lobby/LobbyView+iOS.swift"
    static let link = "https://conclave.acmvit.in/rose-sora-luffy"

    static let permissionConfigs: [(MediaPermissionState, Bool)] = [
        (.granted, false), (.notDetermined, true), (.denied, true), (.denied, false), (.restricted, false), (.unavailable, false)
    ]

    private func status(mode: LobbyMode = .editing, intent: LobbyIntent = .join, issue: LobbyIssue = .none,
                        serverText: String = "", enabled: Bool = true, reason: LobbyPrimaryReason = .none,
                        slow: Bool = false, waiting: WaitingKind = .standard, pending: Bool = false,
                        waitingText: String = "") -> LobbyStatusSnapshot {
        LobbyStatusSnapshot(routeId: 1, intent: intent, mode: mode, issue: issue, issueServerText: serverText,
                            isPrimaryEnabled: enabled, primaryReason: LobbyPrimaryPolicy.snapshotValue(reason),
                            showsSlowNotice: slow, waitingKind: waiting, isPrimaryPending: pending, waitingText: waitingText)
    }

    private func media(_ microphone: MediaPermissionState, _ camera: MediaPermissionState, askMicrophone: Bool = false,
                       askCamera: Bool = false) -> LobbyMediaSnapshot {
        let device = LobbyDeviceInputs.initial.withPermissions(microphone: microphone, camera: camera,
                                                               canAskAgainMicrophone: askMicrophone, canAskAgainCamera: askCamera)
        return LobbySnapshotPolicy.media(routeId: 1, micIntentOn: false, cameraIntentOn: false, device: device,
                                         avatarName: "Avery", avatarSeed: "")
    }

    private func row(_ kind: LobbyStatusRowKind, _ action: LobbyStatusRowAction, restricted: Bool = false,
                     mediaKind: LobbyMediaKind = .microphone, issue: LobbyIssue = .none) -> LobbyStatusRowModel {
        LobbyStatusRowModel(kind: kind, issue: issue, mediaKind: mediaKind, restricted: restricted, action: action)
    }

    private func rows(_ media: LobbyMediaSnapshot, android: Bool, status: LobbyStatusSnapshot? = nil) -> [LobbyStatusRowModel] {
        LobbyStatusPolicy.rows(status: status, media: media, supportsRationale: android, offersAppInfo: android)
    }

    private func expectedAction(_ priming: PermissionPrimingKind) -> LobbyStatusRowAction {
        switch priming {
        case .rationale: return .allow
        case .openSettings: return .openSettings
        case .none, .restricted: return .none
        }
    }

    @Test func rowsFollowTheMergeRuleForEveryPrimingPairOnBothPlatforms() {
        for android in [true, false] {
            for (micPermission, micAsk) in Self.permissionConfigs {
                for (cameraPermission, cameraAsk) in Self.permissionConfigs {
                    let snapshot = media(micPermission, cameraPermission, askMicrophone: micAsk, askCamera: cameraAsk)
                    let result = rows(snapshot, android: android)
                    let label = "\(android) \(micPermission) \(micAsk) \(cameraPermission) \(cameraAsk)"
                    let mic = PermissionPrimingPolicy.priming(permission: micPermission, canAskAgain: micAsk,
                                                              supportsRationale: android, rationaleDismissed: false)
                    let camera = PermissionPrimingPolicy.priming(permission: cameraPermission, canAskAgain: cameraAsk,
                                                                 supportsRationale: android, rationaleDismissed: false)
                    var expected: [LobbyStatusRowModel] = []
                    if mic == camera && (mic == .openSettings || mic == .restricted) {
                        expected = [row(.media, mic == .restricted ? .none : .openSettings, restricted: mic == .restricted)]
                    } else if expectedAction(mic) != LobbyStatusRowAction.none {
                        expected = [row(.microphone, expectedAction(mic))]
                    } else if expectedAction(camera) != LobbyStatusRowAction.none {
                        expected = [row(.camera, expectedAction(camera), mediaKind: .camera)]
                    } else if mic == .restricted {
                        expected = [row(.microphone, .none, restricted: true)]
                    } else if camera == .restricted {
                        expected = [row(.camera, .none, restricted: true, mediaKind: .camera)]
                    }
                    #expect(result == expected, "\(label)")
                    #expect(result.count <= 1, "\(label): one media row at most")
                    if mic == .rationale || camera == .rationale {
                        #expect(!result.contains { $0.kind == .media }, "\(label): no merged row when either priming is askable")
                    }
                    if (mic == .restricted && camera == .openSettings) || (mic == .openSettings && camera == .restricted) {
                        #expect(result.first?.restricted == false && result.first?.action == .openSettings,
                                "\(label): a restricted permission never shares a row with a Settings fix")
                    }
                    if !android {
                        #expect(!result.contains { $0.action == .allow }, "\(label): iOS has no Allow")
                    }
                }
            }
        }
    }

    @Test func rowVectorsForTheOwnerStates() {
        #expect(rows(media(.denied, .denied), android: false) == [row(.media, .openSettings)])
        #expect(rows(media(.denied, .denied, askMicrophone: true, askCamera: true), android: false) == [row(.media, .openSettings)],
                "iOS has no rationale, so both denied always merge")
        #expect(rows(media(.denied, .denied, askMicrophone: true, askCamera: true), android: true) == [row(.microphone, .allow)],
                "Allow asks for the microphone alone")
        #expect(rows(media(.denied, .denied, askMicrophone: false, askCamera: true), android: true) == [row(.microphone, .openSettings)])
        #expect(rows(media(.denied, .denied, askMicrophone: true, askCamera: false), android: true) == [row(.microphone, .allow)])
        #expect(rows(media(.granted, .denied), android: false) == [row(.camera, .openSettings, mediaKind: .camera)])
        #expect(rows(media(.notDetermined, .denied, askCamera: true), android: true) == [row(.camera, .allow, mediaKind: .camera)])
        #expect(rows(media(.restricted, .denied), android: false) == [row(.camera, .openSettings, mediaKind: .camera)])
        #expect(rows(media(.restricted, .restricted), android: true) == [row(.media, .none, restricted: true)])
        #expect(rows(media(.restricted, .notDetermined), android: false) == [row(.microphone, .none, restricted: true)])
        #expect(rows(media(.granted, .restricted), android: false) == [row(.camera, .none, restricted: true, mediaKind: .camera)])
        #expect(rows(media(.granted, .unavailable), android: false).isEmpty, "camera unavailable is the tile's label, not a row")
        #expect(rows(media(.notDetermined, .notDetermined, askMicrophone: true, askCamera: true), android: true).isEmpty,
                "the toggle asks; nothing is said before")
        #expect(LobbyStatusPolicy.rows(status: nil, media: nil, supportsRationale: true, offersAppInfo: true).isEmpty)
    }

    @Test func theIssueRowShowsOnlyInEditingForASuspendedApp() {
        let suspended = status(issue: .appSuspended)
        let both = media(.denied, .denied)
        #expect(rows(both, android: true, status: suspended)
                == [row(.issue, .openSettings, issue: .appSuspended), row(.media, .openSettings)])
        #expect(rows(both, android: false, status: suspended)
                == [row(.issue, .none, issue: .appSuspended), row(.media, .openSettings)])
        #expect(rows(both, android: true, status: suspended).count == LobbyStatusPolicy.maxRows)
        #expect(!rows(both, android: true, status: status(mode: .connecting, issue: .appSuspended)).contains { $0.kind == .issue })
        for issue in LobbyIssue.allCases where issue != .appSuspended {
            #expect(!rows(both, android: true, status: status(issue: issue)).contains { $0.kind == .issue }, "\(issue)")
        }
        for mode in LobbyMode.allCases {
            for issue in LobbyIssue.allCases {
                for (micPermission, micAsk) in Self.permissionConfigs {
                    let value = rows(media(micPermission, .denied, askMicrophone: micAsk), android: true,
                                     status: status(mode: mode, issue: issue))
                    #expect(value.count <= LobbyStatusPolicy.maxRows)
                }
            }
        }
    }

    @Test func theLineFollowsItsPrecedenceInEveryMode() {
        func line(_ value: LobbyStatusSnapshot, signedIn: Bool = false) -> LobbyStatusLineKind {
            LobbyStatusPolicy.line(status: value, isSignedIn: signedIn)
        }
        #expect(line(status()) == LobbyStatusLineKind.none)
        #expect(line(status(issue: .updateRequired, enabled: false, reason: .updateRequired)) == .updateRequired)
        #expect(line(status(enabled: false, reason: .offline)) == .offline)
        #expect(line(status(issue: .offline)) == .offline, "a form error the classifier reads as offline")
        #expect(line(status(issue: .signInRequired)) == .signInRequired)
        #expect(line(status(issue: .signInRequired), signedIn: true) == LobbyStatusLineKind.none)
        #expect(line(status(issue: .signInRequired, enabled: false, reason: .nameMissingJoin)) == .signInRequired)
        #expect(line(status(enabled: false, reason: .nameMissingJoin)) == .nameMissing)
        #expect(line(status(intent: .newMeeting, enabled: false, reason: .nameMissingStart)) == .nameMissing)
        #expect(line(status(issue: .roomNotFound, enabled: false, reason: .nameMissingJoin)) == .nameMissing)
        #expect(line(status(issue: .roomNotFound)) == .roomNotFound)
        #expect(line(status(issue: .roomNotFound, enabled: false, reason: .offline)) == .offline, "offline masks a room issue")
        #expect(line(status(issue: .failedServerText, serverText: "You are not allowed to join this meeting.")) == .failedServerText)
        #expect(line(status(issue: .failedServerText)) == LobbyStatusLineKind.none, "no line without server text")
        #expect(line(status(issue: .appSuspended)) == LobbyStatusLineKind.none, "the suspension is a row")
        #expect(line(status(issue: .inviteCodeInvalid)) == LobbyStatusLineKind.none, "the wrong code is the field's footer")
        #expect(line(status(issue: .inviteCodeRequired)) == LobbyStatusLineKind.none)

        #expect(line(status(mode: .connecting, enabled: false)) == LobbyStatusLineKind.none)
        #expect(line(status(mode: .connecting, enabled: false, slow: true)) == .stillConnecting)
        #expect(line(status(mode: .connecting, issue: .offline, enabled: false, reason: .offline, slow: true)) == .offline)

        #expect(line(status(mode: .failed, issue: .updateRequired, enabled: false, reason: .updateRequired)) == .updateRequired)
        #expect(line(status(mode: .failed, issue: .failedNetwork, enabled: false, reason: .offline)) == .offline)
        #expect(line(status(mode: .failed, issue: .failedNetwork, enabled: false, reason: .nameMissingJoin)) == .nameMissing)
        #expect(line(status(mode: .failed, issue: .failedNetwork, enabled: false)) == .failedNetwork)
        #expect(line(status(mode: .failed, issue: .failedMedia, enabled: false)) == .failedMedia)
        #expect(line(status(mode: .failed, issue: .failedServerBusy, enabled: false)) == .failedServerBusy)
        #expect(line(status(mode: .failed, issue: .failedServerText, serverText: "Ended.", enabled: false)) == .failedServerText)
        #expect(line(status(mode: .failed, issue: .failedServerText, enabled: false)) == .failedUnknown)
        #expect(line(status(mode: .failed, issue: .failedUnknown, enabled: false)) == .failedUnknown)

        let waiting: [(WaitingKind, LobbyStatusLineKind)] = [
            (.standard, .waitingStandard), (.locked, .waitingLocked), (.noHost, .waitingNoHost),
            (.hostAvailable, .waitingHostAvailable), (.reconnecting, .waitingReconnecting), (.offline, .waitingOffline),
            (.serverRestarting, .waitingServerRestarting)
        ]
        #expect(waiting.count == WaitingKind.allCases.count)
        for (kind, expected) in waiting {
            #expect(line(status(mode: .waiting, enabled: false, waiting: kind)) == expected, "\(kind)")
        }
    }

    @Test func primaryEnabledMatchesWhatTheMainActionCanDo() {
        func enabled(_ value: LobbyStatusSnapshot, signedIn: Bool = false) -> Bool {
            LobbyStatusPolicy.primaryEnabled(status: value, isSignedIn: signedIn)
        }
        #expect(enabled(status()))
        #expect(!enabled(status(enabled: false, reason: .nameMissingJoin)))
        #expect(!enabled(status(issue: .signInRequired)), "Sign in to join disables Join")
        #expect(enabled(status(issue: .signInRequired), signedIn: true), "signing in enables Join; the next Join clears the issue")
        #expect(enabled(status(issue: .roomNotFound)), "a room can open later")
        #expect(enabled(status(mode: .failed, issue: .failedNetwork, enabled: false)))
        #expect(!enabled(status(mode: .failed, issue: .failedNetwork, enabled: false, reason: .offline)), "Try Again waits for a connection")
        #expect(!enabled(status(mode: .failed, issue: .failedNetwork, enabled: false, reason: .nameMissingJoin)))
        #expect(!enabled(status(mode: .failed, issue: .failedNetwork, enabled: false, pending: true)))
        #expect(!enabled(status(mode: .connecting, enabled: true)))
        #expect(!enabled(status(mode: .waiting, enabled: true)))
    }

    @Test func pendingKindNamesThePendingControl() {
        #expect(LobbyStatusPolicy.pendingKind(status: status(mode: .connecting)) == .joining)
        #expect(LobbyStatusPolicy.pendingKind(status: status(mode: .connecting, intent: .newMeeting)) == .starting)
        #expect(LobbyStatusPolicy.pendingKind(status: status(mode: .connecting, waiting: .reconnecting)) == .reconnecting)
        #expect(LobbyStatusPolicy.pendingKind(status: status(mode: .connecting, intent: .newMeeting, waiting: .reconnecting)) == .reconnecting)
        #expect(LobbyStatusPolicy.pendingKind(status: status(mode: .waiting)) == .asking)
        #expect(LobbyStatusPolicy.pendingKind(status: status(pending: true)) == LobbyPendingKind.none, "the collision check keeps its own title")
        #expect(LobbyStatusPolicy.pendingKind(status: status(mode: .failed)) == LobbyPendingKind.none)
    }

    @Test func announcementsIdentifiersAndServerText() {
        let announced: Set<LobbyStatusLineKind> = [
            .offline, .stillConnecting, .updateRequired, .signInRequired, .roomNotFound, .failedServerText,
            .waitingStandard, .waitingLocked, .waitingNoHost, .waitingHostAvailable, .waitingReconnecting, .waitingOffline,
            .waitingServerRestarting
        ]
        for kind in LobbyStatusLineKind.allCases {
            #expect(LobbyStatusPolicy.announcesLine(kind) == announced.contains(kind), "\(kind)")
        }
        #expect(LobbyStatusLineKind.allCases.count == 19)
        for kind in [LobbyStatusLineKind.nameMissing, .offline, .updateRequired, .signInRequired, .roomNotFound] {
            #expect(LobbyStatusPolicy.lineIdentifier(kind) == "lobby.primary.reason", "\(kind)")
        }
        #expect(LobbyStatusPolicy.lineIdentifier(.stillConnecting) == "lobby.slowNotice")
        for kind in [LobbyStatusLineKind.failedNetwork, .failedMedia, .failedServerBusy, .failedServerText, .failedUnknown] {
            #expect(LobbyStatusPolicy.lineIdentifier(kind) == "lobby.status", "\(kind)")
        }
        for kind in [LobbyStatusLineKind.waitingStandard, .waitingLocked, .waitingNoHost, .waitingHostAvailable,
                     .waitingReconnecting, .waitingOffline, .waitingServerRestarting] {
            #expect(LobbyStatusPolicy.lineIdentifier(kind) == "lobby.waiting.body", "\(kind)")
        }
        #expect(LobbyStatusPolicy.serverLine("Ended.") == "Ended")
        #expect(LobbyStatusPolicy.serverLine("Wait...") == "Wait..", "one trailing full stop only")
        #expect(LobbyStatusPolicy.serverLine("Hold on\u{2026}") == "Hold on\u{2026}")
        #expect(LobbyStatusPolicy.serverLine("Really?") == "Really?")
        #expect(LobbyStatusPolicy.serverLine("  Ended.  ") == "Ended")
        #expect(LobbyStatusPolicy.serverLine("") == "")
        #expect(LobbyStatusPolicy.maxRows == 2 && LobbyStatusPolicy.lineMaxLines == 2)
        #expect(!LobbyStatusPolicy.platformOffersAppInfo, "iOS offers no app info page for the suspension row")
        #expect(LobbyStatusRowKind.allCases.count == 4 && LobbyStatusRowAction.allCases.count == 3
                && LobbyPendingKind.allCases.count == 5)
    }

    private func drive(_ state: PremeetingFixtureState) -> PremeetingPresenter {
        let shell = MeetingShellPresenter()
        let premeeting = PremeetingPresenter()
        premeeting.nowMillis = { 1793102400000.0 }
        premeeting.bootstrap(user: nil, recents: [])
        let steps = PremeetingFixtureScript.steps(for: state)
        var index = 0
        while index < steps.count && steps[index].delayMillis == 0 {
            shell.apply(steps[index].shell)
            premeeting.apply(PremeetingInputs.from(session: shell.session, base: steps[index].base))
            index += 1
        }
        if PremeetingFixtureScript.isLobbyFixture(state) {
            premeeting.generateRoomCode = { PremeetingFixtureScript.newMeetingCode }
            if let priming = PermissionPrimingFixture.permissions(forState: state.rawValue) {
                premeeting.applyPermissions(microphone: priming.microphone, camera: priming.camera,
                                            canAskAgainMicrophone: priming.canAskAgainMicrophone,
                                            canAskAgainCamera: priming.canAskAgainCamera)
            } else {
                premeeting.applyPermissions(microphone: PremeetingFixtureScript.micPermission(for: state),
                                            camera: PremeetingFixtureScript.cameraPermission(for: state),
                                            canAskAgainMicrophone: PremeetingFixtureScript.canAskAgainMicrophone(for: state),
                                            canAskAgainCamera: PremeetingFixtureScript.canAskAgainCamera(for: state))
            }
            let link = PremeetingFixtureScript.lobbyLink(for: state)
            if !link.isEmpty {
                premeeting.handleIncomingURL(link)
            }
            if PremeetingFixtureScript.opensNewMeeting(for: state) {
                premeeting.newMeeting()
            }
        }
        while index < steps.count {
            shell.apply(steps[index].shell)
            premeeting.apply(PremeetingInputs.from(session: shell.session, base: steps[index].base))
            index += 1
        }
        return premeeting
    }

    private func lineKind(_ premeeting: PremeetingPresenter) -> LobbyStatusLineKind {
        guard let status = premeeting.lobbyStatus else { return .none }
        return LobbyStatusPolicy.line(status: status, isSignedIn: premeeting.lobbyIdentity?.isSignedIn ?? false)
    }

    private func enabled(_ premeeting: PremeetingPresenter) -> Bool {
        guard let status = premeeting.lobbyStatus else { return false }
        return LobbyStatusPolicy.primaryEnabled(status: status, isSignedIn: premeeting.lobbyIdentity?.isSignedIn ?? false)
    }

    private func fixtureRows(_ premeeting: PremeetingPresenter, android: Bool) -> [LobbyStatusRowModel] {
        LobbyStatusPolicy.rows(status: premeeting.lobbyStatus, media: premeeting.lobbyMedia, supportsRationale: android,
                               offersAppInfo: android)
    }

    @Test func theDriveMatchesTheFixtureSessionForImmediateStates() {
        for state in PremeetingFixtureState.allCases where PremeetingFixtureScript.steps(for: state).allSatisfy({ $0.delayMillis == 0 })
            && !WebinarLandingFixtureScript.isWebinarFixture(state) {
            let session = PremeetingFixtureSession(state: state)
            session.start()
            defer { session.stop() }
            let driven = drive(state)
            #expect(session.premeeting.lobbyStatus?.mode == driven.lobbyStatus?.mode, "\(state)")
            #expect(session.premeeting.lobbyStatus?.issue == driven.lobbyStatus?.issue, "\(state)")
            #expect(session.premeeting.lobbyStatus?.primaryReason == driven.lobbyStatus?.primaryReason, "\(state)")
            #expect(session.premeeting.lobbyStatus?.intent == driven.lobbyStatus?.intent, "\(state)")
            #expect(session.premeeting.lobbyMedia?.micPermission == driven.lobbyMedia?.micPermission, "\(state)")
            #expect(session.premeeting.lobbyMedia?.cameraPermission == driven.lobbyMedia?.cameraPermission, "\(state)")
        }
    }

    @Test func everyFailedFixtureCanTryAgainUnlessOffline() {
        let failed: [(PremeetingFixtureState, LobbyStatusLineKind)] = [
            (.failedNetwork, .failedNetwork), (.failedServerBusy, .failedServerBusy), (.joinFailed, .failedUnknown),
            (.failedMedia, .failedMedia), (.failedServerText, .failedServerText), (.failedOffline, .offline),
            (.failedNewMeeting, .failedUnknown)
        ]
        for (state, line) in failed {
            for step in PremeetingFixtureScript.steps(for: state) {
                #expect(step.base.accountName == PremeetingFixtureScript.lobbyGuestName, "\(state): every step carries the guest name")
            }
            let premeeting = drive(state)
            #expect(premeeting.lobbyStatus?.mode == .failed, "\(state)")
            #expect(lineKind(premeeting) == line, "\(state)")
            if state == .failedOffline {
                #expect(!enabled(premeeting), "Try Again is disabled while offline")
            } else {
                #expect(premeeting.lobbyStatus?.primaryReason == "", "\(state)")
                #expect(enabled(premeeting), "\(state)")
            }
        }
        let newMeeting = drive(.failedNewMeeting)
        #expect(newMeeting.lobbyStatus?.intent == .newMeeting, "the new-meeting failure reads Couldn\u{2019}t start")
        let serverText = drive(.failedServerText)
        #expect(LobbyStatusPolicy.serverLine(serverText.lobbyStatus?.issueServerText ?? "") == "This meeting has been ended by the host")
    }

    @Test func theOwnerShotFixturesShowTheirRows() {
        let offline = drive(.lobbyOffline)
        #expect(lineKind(offline) == .offline)
        #expect(!enabled(offline))
        #expect(fixtureRows(offline, android: true) == [row(.microphone, .allow)], "shot 1 on Android")
        #expect(fixtureRows(offline, android: false) == [row(.microphone, .openSettings)], "shot 1 on iOS")
        #expect(!fixtureRows(offline, android: true).contains { $0.kind == .camera })

        let askable = drive(.lobbyMediaAskable)
        #expect(fixtureRows(askable, android: true) == [row(.microphone, .allow)])
        #expect(fixtureRows(askable, android: false) == [row(.media, .openSettings)])

        let mixed = drive(.lobbyMediaMixed)
        #expect(fixtureRows(mixed, android: true) == [row(.microphone, .openSettings)])
        #expect(fixtureRows(mixed, android: false) == [row(.media, .openSettings)])

        let noCamera = drive(.lobbyCameraUnavailable)
        #expect(fixtureRows(noCamera, android: false) == [row(.microphone, .openSettings)], "shot 2")
        #expect(noCamera.lobbyMedia?.preview == .unavailable)

        #expect(fixtureRows(drive(.lobbyMicRestricted), android: false) == [row(.microphone, .none, restricted: true)])
        #expect(fixtureRows(drive(.lobbyCameraRestricted), android: true)
                == [row(.camera, .none, restricted: true, mediaKind: .camera)])
        #expect(fixtureRows(drive(.lobbyPermissionsDenied), android: false) == [row(.media, .openSettings)])
        #expect(fixtureRows(drive(.lobbyPermissionsRestricted), android: false) == [row(.media, .none, restricted: true)])
        #expect(fixtureRows(drive(.lobbyPermissionsUndetermined), android: true).isEmpty)
        #expect(fixtureRows(drive(.lobby), android: false) == [row(.camera, .openSettings, mediaKind: .camera)])
        #expect(lineKind(drive(.lobbyNameMissing)) == .nameMissing)
    }

    @Test func eachDelayedLobbyFixtureReachesItsLine() {
        for state in [PremeetingFixtureState.lobbyRoomNotFound, .lobbySignInRequired, .lobbyServerText, .lobbyAppSuspended,
                      .lobbyInviteInvalid, .lobbyUpdateRequired] {
            let steps = PremeetingFixtureScript.steps(for: state)
            #expect(steps.count == 2 && steps[1].delayMillis == PremeetingFixtureScript.delayedStepMillis, "\(state)")
            #expect(PremeetingFixtureScript.isLobbyFixture(state) && !PremeetingFixtureScript.lobbyLink(for: state).isEmpty, "\(state)")
        }
        let notFound = drive(.lobbyRoomNotFound)
        #expect(notFound.lobbyStatus?.issue == .roomNotFound && lineKind(notFound) == .roomNotFound && enabled(notFound))

        let signIn = drive(.lobbySignInRequired)
        #expect(signIn.lobbyStatus?.issue == .signInRequired && lineKind(signIn) == .signInRequired && !enabled(signIn))

        let serverText = drive(.lobbyServerText)
        #expect(lineKind(serverText) == .failedServerText && enabled(serverText))
        #expect(LobbyStatusPolicy.serverLine(serverText.lobbyStatus?.issueServerText ?? "") == "You are not allowed to join this meeting")

        let suspended = drive(.lobbyAppSuspended)
        #expect(lineKind(suspended) == LobbyStatusLineKind.none)
        #expect(fixtureRows(suspended, android: true).first == row(.issue, .openSettings, issue: .appSuspended))
        #expect(fixtureRows(suspended, android: false).first == row(.issue, .none, issue: .appSuspended))

        let invite = drive(.lobbyInviteInvalid)
        #expect(invite.lobbyIdentity?.inviteCodeInvalid == true && invite.lobbyIdentity?.needsInviteCode == true)
        #expect(lineKind(invite) == LobbyStatusLineKind.none)

        let update = drive(.lobbyUpdateRequired)
        #expect(lineKind(update) == .updateRequired && !enabled(update))
    }

    @Test func signingInClearsTheSignInLineAndEnablesJoin() {
        let premeeting = drive(.lobbySignInRequired)
        #expect(lineKind(premeeting) == .signInRequired && !enabled(premeeting))
        premeeting.apply(premeeting.currentInputs.withIdentity(isSignedIn: true, accountName: "Avery Chen", accountSeed: "avery"))
        #expect(premeeting.lobbyStatus?.issue == .signInRequired, "signing in does not clear the form issue")
        #expect(premeeting.lobbyIdentity?.isSignedIn == true)
        #expect(lineKind(premeeting) == LobbyStatusLineKind.none)
        #expect(enabled(premeeting))
    }

    @Test func connectingAndWaitingFixturesReachTheirLine() {
        #expect(lineKind(drive(.connectingOffline)) == .offline)
        #expect(lineKind(drive(.connecting)) == LobbyStatusLineKind.none)
        let recovering = drive(.recoveringBeforeAdmission)
        #expect(recovering.lobbyStatus.map { LobbyStatusPolicy.pendingKind(status: $0) } == .reconnecting)
        let waiting: [(PremeetingFixtureState, LobbyStatusLineKind)] = [
            (.waiting, .waitingStandard), (.waitingLocked, .waitingLocked), (.waitingNoHost, .waitingNoHost),
            (.waitingHostAvailable, .waitingHostAvailable), (.waitingReconnecting, .waitingReconnecting),
            (.waitingOffline, .waitingOffline), (.waitingServerRestarting, .waitingServerRestarting)
        ]
        for (state, line) in waiting {
            let premeeting = drive(state)
            #expect(lineKind(premeeting) == line, "\(state)")
            #expect(premeeting.lobbyStatus.map { LobbyStatusPolicy.pendingKind(status: $0) } == .asking, "\(state)")
        }
    }

    @Test func allowAsksForTheMicrophoneOnlyAndLeavesTheCameraOff() {
        let recorder = S1bLobbyHookRecorder()
        let presenter = PremeetingPresenter()
        presenter.nowMillis = { 1793102400000.0 }
        presenter.apply(PremeetingInputs.make(accountName: "Avery"))
        presenter.lobbyHooks = recorder.hooks
        presenter.handleIncomingURL(Self.link)
        presenter.applyPermissions(microphone: PremeetingFixtureScript.micPermission(for: .lobbyMediaAskable),
                                   camera: PremeetingFixtureScript.cameraPermission(for: .lobbyMediaAskable),
                                   canAskAgainMicrophone: PremeetingFixtureScript.canAskAgainMicrophone(for: .lobbyMediaAskable),
                                   canAskAgainCamera: PremeetingFixtureScript.canAskAgainCamera(for: .lobbyMediaAskable))
        let shown = LobbyStatusPolicy.rows(status: presenter.lobbyStatus, media: presenter.lobbyMedia, supportsRationale: true,
                                           offersAppInfo: true)
        #expect(shown == [row(.microphone, .allow)])
        presenter.setMicIntent(true)
        #expect(recorder.permissionRequests == ["microphone"])
        #expect(recorder.intents == ["true:false"], "the camera intent stays off")
    }

    @Test func serverTextIsAReasonLineOnlyWhileEditing() throws {
        let editing = status(issue: .failedServerText, serverText: "You are not allowed to join this meeting.")
        let failed = status(mode: .failed, issue: .failedServerText, serverText: "Ended.", enabled: false)
        #expect(LobbyStatusPolicy.line(status: editing, isSignedIn: false) == .failedServerText)
        #expect(LobbyStatusPolicy.line(status: failed, isSignedIn: false) == .failedServerText,
                "both modes share one kind, so the call sites resolve the identifier and the announcement by mode")
        #expect(LobbyStatusPolicy.lineIdentifier(.failedServerText) == "lobby.status" && LobbyStatusPolicy.announcesLine(.failedServerText))
    }

    @Test func theWrongCodeIsAnnouncedEvenWhenTheFieldAppearsAlreadyInvalid() throws {
        let classified = LobbyIssuePolicy.classify(formError: PremeetingFixtureScript.formError(for: .lobbyInviteInvalid), enteredInviteCode: "")
        #expect(classified.needsInviteCode && classified.inviteCodeInvalid, "the field and the wrong-code state arrive together")
        let steps = PremeetingFixtureScript.steps(for: .lobbyInviteInvalid)
        #expect(steps.first?.delayMillis == 0 && steps.last?.delayMillis == PremeetingFixtureScript.delayedStepMillis,
                "the fixture shows the field after the lobby is on screen, so the cell hears the phrase")
    }

    @Test func theColourRolesMapExistingTokens() throws {
        #expect(abs(ContrastRatio.wcag(foreground: DesignTokens.coralDeepHighContrast, background: 0xFFE3E3E6) - 5.65) < 0.01,
                "the glass label on the sampled light glass")
        #expect(abs(ContrastRatio.wcag(foreground: DesignTokens.iosAppTextSecondaryLightHighContrast, background: 0xFFC4C4C8) - 5.25) < 0.01,
                "the bar line on the light band")
    }
}

@MainActor
private final class S1bLobbyHookRecorder {
    let hooks = LobbyCoreHooks()
    var intents: [String] = []
    var permissionRequests: [String] = []

    init() {
        hooks.setEntryMediaIntent = { [weak self] mic, camera in
            self?.intents.append("\(mic):\(camera)")
        }
        hooks.requestPermission = { [weak self] kind in
            self?.permissionRequests.append(kind)
        }
    }
}
#endif
