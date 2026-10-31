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
    static let primingFile = "Sources/Conclave/Features/Lobby/PermissionPrimingRow+iOS.swift"
    static let cardFile = "Sources/Conclave/Features/Lobby/LobbyPreviewCard+iOS.swift"
    static let barFile = "Sources/Conclave/DesignSystem/iOS/Components/ConclaveFloatingActionBar+iOS.swift"
    static let themeFile = "Sources/Conclave/DesignSystem/iOS/HostingTheme+iOS.swift"
    static let iosStatusFiles = [lobbyFile, entryFile, rowsFile, primingFile, cardFile]
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

    @Test func iosStatusFilesUseOneQuietGrammar() throws {
        for file in Self.iosStatusFiles {
            let text = try s1blsSource(file)
            for banned in ["exclamationmarkOctagonFill", "exclamationmarkTriangleFill", "exclamationmarkCircleFill", "statusWarning",
                           "systemRed", "ConclaveFieldError("] {
                #expect(!text.contains(banned), "\(file) uses \(banned)")
            }
            #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}"), "\(file)")
        }
        let lobby = try s1blsSource(Self.lobbyFile)
        let bar = try s1blsBlock(lobby, from: "private struct LobbyBottomBar: ViewModifier {", to: "enum LobbyPrimaryCopy {")
        let entryText = try s1blsSource(Self.entryFile)
        let rowsText = try s1blsSource(Self.rowsFile)
        for (name, text) in [("entry", entryText), ("rows", rowsText), ("bar", bar)] {
            #expect(s1blsMatches(#"(?<![A-Za-z])Divider\(\)"#, in: text).isEmpty, "\(name) draws a hairline")
        }
        #expect(!lobby.contains("LobbyIssueSection") && !lobby.contains("LobbyIssueCopy"))

        let raw = try s1blsSource(Self.rowsFile)
        let rows = s1blsFlat(raw)
        let section = s1blsFlat(try s1blsBlock(raw, from: "struct LobbyStatusSection: View {", to: "struct LobbyStatusRow: View {"))
        #expect(section.contains("VStack(alignment: .leading, spacing: 4) {") && section.contains(".padding(.horizontal, 32)"))
        #expect(section.contains(".onChange(of: rows) { previous, next in guard settled else { return } for row in next where !previous.contains(row) { EntryStatusAnnouncer.announce(LobbyStatusCopy.text(row)) } }"),
                "one announcement owner, armed only after the lobby settles")
        #expect(section.contains("@State private var settled = false private static let settleMillis = 300"))
        #expect(section.contains(".task { try? await Task.sleep(for: .milliseconds(Self.settleMillis)) if Task.isCancelled { return } settled = true }"),
                "the first permission push after appearance is not announced")
        #expect(section.components(separatedBy: ".task").count - 1 == 1 && !section.contains(".task(id:"))
        #expect(rows.contains("let layout = dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(alignment: .center, spacing: 12))"))
        #expect(rows.contains("Label { Text(LobbyStatusCopy.text(model)) .font(.footnote) .fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: LobbyStatusCopy.symbol(model)) .font(.footnote) .accessibilityHidden(true) } .foregroundStyle(HostingTheme.secondaryText)"))
        #expect(rows.contains("Button(action: onAction) { Text(LobbyStatusCopy.actionTitle(model.action)) .frame(minHeight: 44) .contentShape(Rectangle()) } .buttonStyle(.borderless) .tint(HostingTheme.coralText) .font(.footnote) .accessibilityHint(LobbyStatusCopy.hint(model))"),
                "the 44 pt frame is the real hit area and the hint sits on the button")
        #expect(rows.components(separatedBy: "Button(").count - 1 == 1, "at most one trailing action")
        for identifier in ["\"lobby.issue\"", "\"lobby.media.permission\"", "\"lobby.camera.denied\"", "PermissionPrimingCopy.identifier(.microphone)",
                           "PermissionPrimingCopy.identifier(.camera)"] {
            #expect(rows.contains(identifier), "missing \(identifier)")
        }
        #expect(rows.contains("ConclaveSymbols.infoCircle") && rows.contains("PermissionPrimingCopy.symbol(.camera)")
                && rows.contains("PermissionPrimingCopy.symbol(.microphone)"))
        for pattern in ["withAnimation", ".animation(", ".transition(", "ConclaveMotion", ".task(id:", "onAppear", "lineLimit(", "//"] {
            #expect(!raw.contains(pattern), "the status rows use \(pattern)")
        }
        let rowView = try s1blsBlock(raw, from: "struct LobbyStatusRow: View {", to: "struct LobbyStatusLineText: Equatable {")
        #expect(!rowView.contains(".task") && !rowView.contains(".onChange("), "a row never announces itself")
        let priming = try s1blsSource(Self.primingFile)
        #expect(priming.contains("enum PermissionPrimingCopy {") && !priming.contains("struct PermissionPrimingSection")
                && !priming.contains("struct PermissionPrimingRow"))
    }

    @Test func theLineGrammarAndSymbolsFollowTheDesign() throws {
        let rows = s1blsFlat(try s1blsSource(Self.rowsFile))
        #expect(rows.contains("case .offline, .waitingOffline: return ConclaveSymbols.wifiSlash"))
        #expect(rows.contains("case .stillConnecting, .failedNetwork: return ConclaveSymbols.wifiExclamationmark"))
        #expect(rows.contains("case .updateRequired, .roomNotFound, .failedMedia, .failedServerBusy, .failedServerText, .failedUnknown: return ConclaveSymbols.infoCircle"))
        #expect(rows.contains("case .none, .nameMissing, .signInRequired, .waitingStandard, .waitingLocked, .waitingNoHost, .waitingHostAvailable, .waitingReconnecting, .waitingServerRestarting: return \"\""))
        #expect(rows.contains("Label(line.text, systemImage: line.symbol) .labelStyle(.titleAndIcon)"))
        #expect(rows.contains("case .nameMissing: return LobbyPrimaryCopy.reason(status.primaryReason) ?? \"\""))
        #expect(rows.contains("case .failedServerText: return LobbyStatusPolicy.serverLine(status.issueServerText)"))
        #expect(rows.contains("return status.waitingText.isEmpty ? ConclaveStrings.text(\"Server is restarting\") : LobbyStatusPolicy.serverLine(status.waitingText)"))
        #expect(rows.contains("return status.intent == .newMeeting ? ConclaveStrings.text(\"Couldn\\u{2019}t start\") : ConclaveStrings.text(\"Couldn\\u{2019}t join\")"))
        let section = s1blsFlat(try s1blsBlock(try s1blsSource(Self.rowsFile), from: "struct LobbyStatusSection: View {", to: "struct LobbyStatusRow: View {"))
        #expect(section.contains("let inSlot = dynamicTypeSize.isAccessibilitySize"))
        #expect(section.contains("let reserved = inSlot && nameFocused ? LobbyPrimaryCopy.reason(nameReason.rawValue) : nil"))
        #expect(section.contains("LobbyStatusLineLabel(line: line) .font(.footnote) .foregroundStyle(HostingTheme.secondaryText) .fixedSize(horizontal: false, vertical: true) .frame(maxWidth: .infinity, alignment: .leading) .opacity(current == nil ? 0 : 1) .accessibilityHidden(current == nil) .accessibilityIdentifier(line.identifier)"),
                "at accessibility sizes the line is the first status row, with no line limit")
    }

    @Test func theBarHasOneMainActionAndOneLine() throws {
        let raw = try s1blsSource(Self.entryFile)
        let entry = s1blsFlat(raw)
        #expect(entry.components(separatedBy: "ConclaveFloatingActionButton(").count - 1 == 1)
        #expect(!raw.contains("ConclaveButton("))
        #expect(raw.contains(".accessibilityFocused($isRetryFocused)"))
        #expect(entry.contains("isEnabled: isPending || LobbyStatusPolicy.primaryEnabled(status: status, isSignedIn: isSignedIn),"))
        #expect(entry.contains("identifier: isFailed ? \"lobby.retry\" : \"lobby.primary\")"))
        #expect(entry.contains("if isFailed { premeeting.retryJoin() } else { premeeting.startOrJoin() }"))
        #expect(entry.contains("guard let identity = premeeting.lobbyIdentity, identity.routeId == routeId else { return false } return identity.isSignedIn"))
        #expect(entry.contains(".foregroundStyle(HostingTheme.floatingBarSecondaryText) .multilineTextAlignment(.center) .lineLimit(LobbyStatusPolicy.lineMaxLines)"))
        #expect(raw.components(separatedBy: "lineLimit(").count - 1 == 1)
        let lineStart = try #require(raw.range(of: "if !dynamicTypeSize.isAccessibilitySize, let line ="))
        let limit = try #require(raw.range(of: "lineLimit("))
        #expect(lineStart.lowerBound < limit.lowerBound, "the line limit applies only outside accessibility sizes")
        #expect(entry.contains("case .connecting, .waiting: switch LobbyStatusPolicy.pendingKind(status: status) { case .reconnecting: return ConclaveStrings.text(\"Reconnecting\\u{2026}\") case .asking: return ConclaveStrings.text(\"Asking to Join\") case .joining, .starting, .none: return pendingTitle(status.intent) }"))
        #expect(entry.contains("case .failed: return ConclaveStrings.text(\"Try Again\")"))
        #expect(entry.contains("case .connecting, .waiting, .failed: return \"\" case .editing: return LobbyPresenceCopy.text(presence)"),
                "no navigation subtitle while connecting")
        #expect(entry.contains("static func failureBody(_ issue: LobbyIssue) -> String {") && entry.contains("static func pendingTitle(_ intent: LobbyIntent) -> String {"))
        for removed in ["EntryConnectingBlock", "EntryWaitingBlock", "EntryFailedBlock", "EditingBlock", "failureTitle", "waitingBody",
                        "failureBody(_ status:", "exclamationmark", "Divider()", "\"Couldn\\u{2019}t join\"", "//"] {
            #expect(!raw.contains(removed), "EntryStatusBlock+iOS.swift keeps \(removed)")
        }
    }

    @Test func theFailedTaskFocusesTryAgainBeforeItAnnouncesTheLine() throws {
        let entry = s1blsFlat(try s1blsSource(Self.entryFile))
        #expect(entry.contains(".task(id: status.mode) { guard status.mode == .failed else { return } isRetryFocused = true EntryStatusAnnouncer.announce(LobbyStatusCopy.line(status: status, isSignedIn: isSignedIn)?.text ?? \"\") }"))
        #expect(entry.contains("if current.mode == .failed && previous.mode != .failed { return }"), "the line change is quiet when entering failed")
        #expect(entry.contains("guard LobbyStatusCopy.announcesLine(current.kind, mode: current.mode) else { return }"))
        #expect(!entry.contains("LobbyStatusPolicy.announcesLine("), "the announcer reads the mode-aware rule")
        #expect(entry.contains("case .editing, .waiting, .failed: break"), "the failed transition no longer posts a fixed sentence")
    }

    @Test func serverTextIsAReasonLineOnlyWhileEditing() throws {
        let rows = s1blsFlat(try s1blsSource(Self.rowsFile))
        #expect(rows.contains("static func lineIdentifier(_ kind: LobbyStatusLineKind, mode: LobbyMode) -> String { mode == .editing && kind == .failedServerText ? \"lobby.primary.reason\" : LobbyStatusPolicy.lineIdentifier(kind) }"),
                "the editing server text is found as lobby.primary.reason, the failed one as lobby.status")
        #expect(rows.contains("static func announcesLine(_ kind: LobbyStatusLineKind, mode: LobbyMode) -> Bool { LobbyStatusPolicy.announcesLine(kind) && (kind != .failedServerText || mode == .editing) }"),
                "server text is announced in editing only, like every other failure line")
        #expect(rows.contains("return LobbyStatusLineText(kind: kind, text: text, symbol: lineSymbol(kind), identifier: lineIdentifier(kind, mode: status.mode))"))
        #expect(rows.components(separatedBy: "LobbyStatusPolicy.lineIdentifier(").count - 1 == 2,
                "the mode-aware helper and the reserved name line are the only direct reads")

        let editing = status(issue: .failedServerText, serverText: "You are not allowed to join this meeting.")
        let failed = status(mode: .failed, issue: .failedServerText, serverText: "Ended.", enabled: false)
        #expect(LobbyStatusPolicy.line(status: editing, isSignedIn: false) == .failedServerText)
        #expect(LobbyStatusPolicy.line(status: failed, isSignedIn: false) == .failedServerText,
                "both modes share one kind, so the call sites resolve the identifier and the announcement by mode")
        #expect(LobbyStatusPolicy.lineIdentifier(.failedServerText) == "lobby.status" && LobbyStatusPolicy.announcesLine(.failedServerText))
    }

    @Test func everyLobbyStatusAnnouncementIsLowPriority() throws {
        let entry = s1blsFlat(try s1blsSource(Self.entryFile))
        #expect(entry.contains("@MainActor static func announce(_ text: String) { guard !text.isEmpty else { return } var announcement = AttributedString(text) announcement.accessibilitySpeechAnnouncementPriority = .low AccessibilityNotification.Announcement(announcement).post() }"))
        #expect(entry.components(separatedBy: "AccessibilityNotification.Announcement(").count - 1 == 3,
                "the two connecting announcements stay as they were; every new one goes through announce")
        for file in [Self.rowsFile, Self.lobbyFile] {
            let text = try s1blsSource(file)
            #expect(!text.contains("AccessibilityNotification.Announcement("), "\(file) posts through EntryStatusAnnouncer.announce")
            #expect(!text.contains(".high"), "\(file)")
        }
        let lobby = try s1blsSource(Self.lobbyFile)
        #expect(lobby.contains("if isWrong { EntryStatusAnnouncer.announce(LobbyInviteCopy.invalid) }"))
    }

    @Test func theWrongCodeIsAnnouncedEvenWhenTheFieldAppearsAlreadyInvalid() throws {
        let raw = try s1blsSource(Self.lobbyFile)
        let column = s1blsFlat(try s1blsBlock(raw, from: "private struct LobbyControlsColumn: View {", to: "private struct LobbyAudioSection: View {"))
        #expect(column.hasSuffix("} .modifier(LobbyInviteAnnouncement(premeeting: premeeting, isPromotion: isPromotion)) } }"),
                "the observer sits on the always-present column, outside every conditional")
        let field = try s1blsBlock(raw, from: "private struct LobbyInviteCodeSection: View {", to: "private struct LobbyInviteAnnouncement: ViewModifier {")
        #expect(!field.contains("EntryStatusAnnouncer") && !field.contains("inviteCodeInvalid) {"),
                "an observer inside the field branch misses a field that is created already invalid")
        let announcer = s1blsFlat(try s1blsBlock(raw, from: "private struct LobbyInviteAnnouncement: ViewModifier {", to: "enum LobbyInviteCopy {"))
        #expect(announcer.contains("let wrongCode = !isPromotion && identity?.needsInviteCode == true && identity?.inviteCodeInvalid == true content .onChange(of: wrongCode) { _, isWrong in if isWrong { EntryStatusAnnouncer.announce(LobbyInviteCopy.invalid) } }"))
        #expect(raw.components(separatedBy: "EntryStatusAnnouncer.announce(").count - 1 == 1, "one wrong-code announcement")

        let classified = LobbyIssuePolicy.classify(formError: PremeetingFixtureScript.formError(for: .lobbyInviteInvalid), enteredInviteCode: "")
        #expect(classified.needsInviteCode && classified.inviteCodeInvalid, "the field and the wrong-code state arrive together")
        let steps = PremeetingFixtureScript.steps(for: .lobbyInviteInvalid)
        #expect(steps.first?.delayMillis == 0 && steps.last?.delayMillis == PremeetingFixtureScript.delayedStepMillis,
                "the fixture shows the field after the lobby is on screen, so the cell hears the phrase")
    }

    @Test func theColourRolesMapExistingTokens() throws {
        let theme = s1blsFlat(try s1blsSource(Self.themeFile))
        #expect(theme.contains("static let floatingBarSecondaryText = Color(uiColor: UIColor { traits in if traits.userInterfaceStyle == .dark { return .secondaryLabel } return color(DesignTokens.iosAppTextSecondaryLightHighContrast) })"))
        #expect(theme.contains("static let floatingActionLabel = Color(uiColor: UIColor { traits in if traits.userInterfaceStyle == .dark { return color(traits.accessibilityContrast == .high ? DesignTokens.coralBrightHighContrast : DesignTokens.coralBright) } return color(DesignTokens.coralDeepHighContrast) })"))
        let bar = s1blsFlat(try s1blsSource(Self.barFile))
        #expect(bar.contains("ProgressView().tint(HostingTheme.floatingActionLabel).accessibilityHidden(true)"))
        #expect(bar.contains(".foregroundStyle(HostingTheme.floatingActionLabel) .opacity(isEnabled ? 1 : ConclaveButtonMetrics.disabledOpacity)"))
        #expect(!bar.contains(".foregroundStyle(HostingTheme.coralText)"))
        #expect(bar.contains(".tint(HostingTheme.coralText)"), "the glass tint is unchanged")
        #expect(abs(ContrastRatio.wcag(foreground: DesignTokens.coralDeepHighContrast, background: 0xFFE3E3E6) - 5.65) < 0.01,
                "the glass label on the sampled light glass")
        #expect(abs(ContrastRatio.wcag(foreground: DesignTokens.iosAppTextSecondaryLightHighContrast, background: 0xFFC4C4C8) - 5.25) < 0.01,
                "the bar line on the light band")
    }

    @Test func theTileAndTheInviteFieldSayItInPlace() throws {
        let card = try s1blsSource(Self.cardFile)
        let cameraOff = s1blsFlat(try s1blsBlock(card, from: "private struct LobbyCameraOffContent: View {", to: "private struct LobbyToggleStrip: View {"))
        let avatar = try #require(cameraOff.range(of: "layout { avatar unavailableLabel"))
        let fits = try #require(cameraOff.range(of: "ViewThatFits(in: .vertical) {"))
        #expect(fits.lowerBound < avatar.lowerBound, "the label follows the face inside ViewThatFits")
        #expect(cameraOff.contains(".dynamicTypeSize(...DynamicTypeSize.xxxLarge)"))
        #expect(cameraOff.contains("if media.cameraIsUnavailable && media.preview != .starting {"), "camera off by choice says nothing")
        let video = s1blsFlat(try s1blsBlock(card, from: "private struct LobbyPreviewVideo: View {", to: "private struct LobbyCameraOffContent: View {"))
        #expect(video.contains(".accessibilityElement(children: .ignore) .accessibilityLabel(ConclaveStrings.text(\"Your Preview\")) .accessibilityValue(previewValue)"))
        var captions: [String] = []
        for file in try s1blsFiles(under: "Sources/Conclave", extensions: ["swift", "kt"]) where try s1blsSource(file).contains("LobbyPreviewCaption") {
            captions.append(file)
        }
        #expect(captions.isEmpty, "no caption under the card: \(captions)")

        let lobby = s1blsFlat(try s1blsSource(Self.lobbyFile))
        #expect(lobby.contains("LobbyGroupedSection(footer: identity.inviteCodeInvalid ? LobbyInviteCopy.invalid : ConclaveStrings.text(\"Enter the invite code from the host.\"), footerIdentifier: identity.inviteCodeInvalid ? \"lobby.invite.error\" : \"lobby.invite.footer\") {"))
        #expect(lobby.contains("enum LobbyInviteCopy { static var invalid: String { ConclaveStrings.text(\"That code didn\\u{2019}t work\") } }"))
        #expect(lobby.contains("case .offline: return ConclaveStrings.text(\"You\\u{2019}re offline\")"))
        #expect(lobby.contains(".scrollDismissesKeyboard(.interactively) .accessibilityIdentifier(\"lobby\")"),
                "the root identifier sits on the scroll view, so the bar keeps its own identifiers")
        #expect(lobby.components(separatedBy: ".accessibilityIdentifier(\"lobby\")").count - 1 == 1)
        #expect(lobby.contains("Button(ConclaveStrings.text(\"Cancel\"), role: .cancel) { premeeting.cancelJoin() } .accessibilityIdentifier(\"lobby.cancel\")"),
                "the toolbar Cancel is the one Cancel while connecting and waiting")
    }

    @Test func theSharedPolicyStaysTranspilable() throws {
        let text = try s1blsSource(Self.policyFile)
        #expect(!text.contains("import SwiftUI") && !text.contains("import UIKit"))
        #expect(s1blsMatches(#"\.(?:map|compactMap|flatMap)\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*\)"#, in: text).isEmpty)
        #expect(!text.contains(".isLetter"))
        #expect(!text.contains("\u{2013}") && !text.contains("\u{2014}") && !text.contains("//"))
        let model = try s1blsBlock(text, from: "struct LobbyStatusRowModel: Equatable {", to: "}")
        #expect(!model.contains("var "), "let-only fields")
        #expect(text.contains("PermissionPrimingPolicy.model(kind: .microphone"), "the priming policy is read, not copied")
        for unedited in ["Sources/Conclave/Features/Lobby/PermissionPrimingPolicy.swift", "Sources/Conclave/Features/Lobby/EntryStatusPolicy.swift",
                         "Sources/Conclave/Features/Lobby/LobbyPolicies.swift", "Sources/Conclave/Features/Lobby/LobbyContracts.swift"] {
            #expect(!(try s1blsSource(unedited)).contains("LobbyStatusPolicy"), "\(unedited)")
        }
    }

    static let newIOSKeys = [
        "You\u{2019}re offline", "Still connecting", "Couldn\u{2019}t reach Conclave", "Audio and video didn\u{2019}t connect",
        "Server is busy", "Couldn\u{2019}t start", "Update Conclave to join", "Meeting not found", "Sign in to join",
        "Reconnecting\u{2026}", "Hang tight.", "This meeting is locked", "No one can let you in yet", "A host is here",
        "Reconnecting, you\u{2019}ll keep your place", "You\u{2019}re offline, you\u{2019}ll keep your place", "Server is restarting",
        "No Microphone or Camera Access", "Microphone Access Is Restricted", "Camera Access Is Restricted",
        "Microphone and Camera Restricted", "Your Phone Paused Conclave", "That code didn\u{2019}t work",
        "Allow microphone and camera access in Settings."
    ]
    static let deletedIOSKeys = [
        "You\u{2019}re offline. Connect to the internet to join.", "No meeting found with this code. Check it and try again.",
        "Couldn\u{2019}t Join", "Couldn\u{2019}t Start", "Still connecting. Check your connection.",
        "You\u{2019}re offline. Waiting for a connection.", "You\u{2019}ll join as soon as someone lets you in.",
        "This meeting is locked. The host will review your request.", "No one is here to let you in yet. You can keep waiting.",
        "A host is here and can let you in.", "Reconnecting. You\u{2019}ll keep your place.",
        "You\u{2019}re offline. You\u{2019}ll keep your place when you\u{2019}re back."
    ]
    static let androidPairs: [(String, String)] = [
        ("ds_offline_title", "You\u{2019}re offline"), ("pm_status_still_connecting", "Still connecting"),
        ("pm_status_fail_network", "Couldn\u{2019}t reach Conclave"), ("pm_status_fail_media", "Audio and video didn\u{2019}t connect"),
        ("pm_status_fail_server_busy", "Server is busy"), ("pm_couldnt_start", "Couldn\u{2019}t start"),
        ("pm_status_update_required", "Update Conclave to join"), ("pm_status_room_not_found", "Meeting not found"),
        ("pm_status_sign_in_required", "Sign in to join"), ("pm_reconnecting", "Reconnecting\u{2026}"),
        ("pm_status_wait_standard", "Hang tight."), ("pm_status_wait_locked", "This meeting is locked"),
        ("pm_status_wait_no_host", "No one can let you in yet"), ("pm_status_wait_host_available", "A host is here"),
        ("pm_status_wait_reconnecting", "Reconnecting, you\u{2019}ll keep your place"),
        ("pm_status_wait_offline", "You\u{2019}re offline, you\u{2019}ll keep your place"),
        ("pm_status_wait_server_restart", "Server is restarting"), ("pm_status_media_off", "No mic or camera access"),
        ("pm_status_mic_restricted", "Microphone access is restricted"), ("pm_status_camera_restricted", "Camera access is restricted"),
        ("pm_status_media_restricted", "Microphone and camera restricted"), ("pm_status_app_suspended", "Your phone paused Conclave"),
        ("pm_invite_code_wrong", "That code didn\u{2019}t work")
    ]
    static let deletedAndroidNames = [
        "pm_offline", "pm_room_not_found", "pm_still_connecting", "pm_offline_waiting", "pm_wait_standard", "pm_wait_locked",
        "pm_wait_no_host", "pm_wait_host_available", "pm_wait_reconnecting", "pm_wait_offline", "pm_wait_server_restart"
    ]

    @Test func lobbyStatusStringsAreInBothCatalogs() throws {
        let data = try #require(try s1blsSource("Sources/Conclave/Resources/Localizable.xcstrings").data(using: .utf8))
        let catalog = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        for key in Self.newIOSKeys {
            #expect(strings[key] != nil, "missing iOS key \(key)")
        }
        for key in Self.deletedIOSKeys {
            #expect(strings[key] == nil, "stale iOS key \(key)")
        }
        for key in ["You\u{2019}re offline", "Reconnecting\u{2026}"] {
            let entry = try #require(strings[key] as? [String: Any], "\(key)")
            #expect(entry["generatesSymbol"] as? Bool == false, "\(key) would share a generated symbol with its twin")
            #expect(entry["extractionState"] as? String == "manual", "\(key)")
        }
        for twin in ["You\u{2019}re Offline", "Reconnecting", "The meeting server is restarting. You\u{2019}ll be reconnected automatically."] {
            #expect(strings[twin] != nil, "kept iOS key \(twin)")
        }
        let xml = try s1blsSource("Android/app/src/main/res/values/strings.xml")
        for (name, value) in Self.androidPairs {
            #expect(xml.contains("<string name=\"\(name)\">\(value)</string>"), "\(name) is \(value)")
        }
        for name in Self.deletedAndroidNames {
            #expect(!xml.contains("<string name=\"\(name)\""), "stale Android name \(name)")
        }
        for name in ["pm_invite_invalid", "pm_sign_in_required", "pm_app_suspended", "pm_update_body", "pm_fail_network", "ds_not_now"] {
            #expect(xml.contains("<string name=\"\(name)\""), "kept Android name \(name)")
        }
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

private func s1blsPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func s1blsSource(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: s1blsPackageRoot().appendingPathComponent(packageRelativePath).standardizedFileURL, encoding: .utf8)
}

private func s1blsFlat(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private struct S1bLobbyStatusBlockMissing: Error {}

private func s1blsBlock(_ text: String, from start: String, to end: String) throws -> String {
    guard let lower = text.range(of: start), let upper = text.range(of: end, range: lower.upperBound..<text.endIndex) else {
        throw S1bLobbyStatusBlockMissing()
    }
    return String(text[lower.lowerBound..<upper.lowerBound])
}

private func s1blsFiles(under directory: String, extensions: Set<String>) throws -> [String] {
    let root = s1blsPackageRoot()
    var result: [String] = []
    let enumerator = FileManager.default.enumerator(at: root.appendingPathComponent(directory), includingPropertiesForKeys: nil)
    while let url = enumerator?.nextObject() as? URL {
        if extensions.contains(url.pathExtension) { result.append(url.path) }
    }
    let prefix = root.path + "/"
    return result.map { $0.hasPrefix(prefix) ? String($0.dropFirst(prefix.count)) : $0 }.sorted()
}

private func s1blsMatches(_ pattern: String, in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [pattern] }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]) }
    }
}
#endif
