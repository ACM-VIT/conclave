#if os(macOS) && !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
@Suite(.serialized)
struct S6CReviewRegressionTests {
    private func presenter() -> PremeetingPresenter {
        let presenter = PremeetingPresenter()
        presenter.apply(PremeetingInputs.make(accountName: "Initial Guest"))
        return presenter
    }

    @Test func coveredLobbyRetainsDraftsValidationAndAudioChoice() async throws {
        let presenter = presenter()
        let hooks = LobbyCoreHooks()
        var joins: [LobbyJoinRequest] = []
        hooks.join = { joins.append($0) }
        presenter.lobbyHooks = hooks
        presenter.handleIncomingURL("https://conclave.acmvit.in/rose-sora-luffy")
        let lobby = try #require(presenter.path.first)
        presenter.apply(PremeetingInputs.make(notice: .formError, noticeText: "This meeting requires an invite code",
                                              accountName: "Initial Guest"))
        presenter.setGuestName("Draft Guest")
        presenter.setInviteCode("private-code")
        presenter.applyAudioRoutes(outputs: [
            AudioRouteOption(id: "speaker", kind: .speaker, name: "Speaker", isConnecting: false),
            AudioRouteOption(id: "buds", kind: .bluetooth, name: "Buds", isConnecting: false)
        ], currentOutputId: "speaker", inputOptions: [], currentInputId: "")
        presenter.selectAudioOutput(kind: "bluetooth")
        presenter.openPrivacyPolicy()
        presenter.openAppSettings()
        presenter.setPath(Array(presenter.path.dropLast()))
        #expect(presenter.lobbyStatus == nil)
        presenter.setPath([lobby])
        #expect(presenter.lobbyIdentity?.guestName == "Draft Guest")
        #expect(presenter.lobbyIdentity?.needsInviteCode == true)
        #expect(presenter.lobbyAudio?.routeKind == "bluetooth")
        presenter.startOrJoin()
        #expect(joins.count == 1)
        #expect(joins.first?.displayName == "Draft Guest")
        #expect(joins.first?.meetingInviteCode == "private-code")
        presenter.setPath([])
        presenter.handleIncomingURL("https://conclave.acmvit.in/lily-zoro-iris")
        #expect(presenter.lobbyIdentity?.guestName == "Initial Guest")
        #expect(presenter.lobbyIdentity?.needsInviteCode == false)
        presenter.setPath([])
    }

    @Test func occupiedCandidatesNeverSubmitAndAnExplicitRetryCanSucceed() async {
        let presenter = presenter()
        let hooks = LobbyCoreHooks()
        var checks = 0
        var joins: [LobbyJoinRequest] = []
        var codes = 0
        presenter.generateRoomCode = { codes += 1; return "generated-\(codes)" }
        hooks.fetchPresence = { _, _ in checks += 1; return checks <= 3 ? 1 : 0 }
        hooks.join = { joins.append($0) }
        presenter.lobbyHooks = hooks
        presenter.newMeeting()
        presenter.startOrJoin()
        #expect(await settle { presenter.lobbyStatus?.isPrimaryPending == false })
        #expect(checks == 3)
        #expect(joins.isEmpty)
        #expect(presenter.lobbyStatus?.issue == .failedServerBusy)
        #expect(presenter.lobbyStatus?.mode == .editing)
        presenter.retryJoin()
        #expect(await settle { joins.count == 1 })
        #expect(joins.first?.roomId == "generated-3")
        presenter.setPath([])
    }

    @Test func unavailableCollisionLookupStillStartsTheMeeting() async {
        let presenter = presenter()
        let hooks = LobbyCoreHooks()
        var checks = 0
        hooks.fetchPresence = { _, _ in checks += 1; return nil }
        var joins: [LobbyJoinRequest] = []
        hooks.join = { joins.append($0) }
        presenter.generateRoomCode = { "generated-extra" }
        presenter.lobbyHooks = hooks
        presenter.newMeeting()
        let candidate = presenter.path.last?.roomId
        presenter.startOrJoin()
        #expect(await settle { joins.count == 1 })
        #expect(checks == 1)
        #expect(joins.first?.roomId == candidate)
        #expect(presenter.lobbyStatus?.issue != .failedServerBusy)
        presenter.setPath([])
    }

    @Test func deniedMicrophoneIsClassifiedWithMicrophoneCopy() {
        let mic = MeetingErrorClassifier.classifyMediaPermission(context: .media, device: .microphone)
        #expect(mic.category == .microphonePermission)
        #expect(MeetingErrorLegacyCopy.message(mic, device: .microphone) == "Microphone access is off. Turn it on in Settings.")
        #expect(MeetingErrorClassifier.classifyMediaPermission(context: .media, device: .camera).category == .cameraPermission)
        #expect(MeetingErrorClassifier.classifyMediaPermission(context: .screenShare, device: .screen).category == .screenCapturePermission)
    }

    private func gatedViewModel() -> MeetingViewModel {
        let viewModel = MeetingViewModel()
        viewModel.testDetachHostNetworkMonitor()
        viewModel.versionGateDefaults = UserDefaults(suiteName: "s6c.version." + UUID().uuidString)!
        viewModel.currentAppVersion = { "2.0.0" }
        _ = viewModel.applyVersionGate(.payload(MinNativeVersionPayload(ios: "9.0.0", android: "9.0.0")), source: "test")
        return viewModel
    }

    @Test func foregroundRefreshClearsACachedBlockAndIsRateLimited() async {
        let viewModel = gatedViewModel()
        var now = 100000.0
        var requests = 0
        viewModel.versionGateNowMillis = { now }
        viewModel.versionGateFetch = { requests += 1; return .payload(nil) }
        viewModel.handleAppBecameActive()
        #expect(await settle { !viewModel.versionGate.updateRequired })
        #expect(requests == 1)
        viewModel.handleAppBecameActive()
        for _ in 0..<10 { await Task.yield() }
        #expect(requests == 1)
        now += MeetingViewModel.versionGateRefreshFloorMillis
        viewModel.handleAppBecameActive()
        #expect(await settle { requests == 2 })
    }

    @Test func networkRecoveryRefreshesTheSavedGate() async {
        let viewModel = gatedViewModel()
        viewModel.versionGateFetch = { .payload(nil) }
        await viewModel.networkReachabilityChanged(true)
        #expect(viewModel.versionGate.updateRequired)
        await viewModel.networkReachabilityChanged(false)
        #expect(await settle { !viewModel.versionGate.updateRequired })
    }

    @Test func blockedPresenterActionRequestsARefresh() async {
        let viewModel = gatedViewModel()
        viewModel.versionGateFetch = { .payload(nil) }
        PremeetingAppWiring.installVersionGateRefresh(presenter: viewModel.premeeting, viewModel: viewModel)
        viewModel.premeeting.newMeeting()
        #expect(await settle { !viewModel.versionGate.updateRequired })
        #expect(viewModel.premeeting.path.isEmpty)
        #expect(!viewModel.premeeting.isUpdatePromptPresented)
        viewModel.premeeting.newMeeting()
        #expect(viewModel.premeeting.path.last?.kind == .lobby)
        viewModel.premeeting.setPath([])
    }

    @Test func blockedDirectJoinRefreshesAndSettlesTheEntryState() async {
        let viewModel = gatedViewModel()
        viewModel.versionGateFetch = { .payload(nil) }
        viewModel.state.connectionState = .joining
        viewModel.state.isEnteringMeeting = true
        viewModel.joinRoom(roomId: "rose-sora-luffy", displayName: "Guest")
        #expect(viewModel.state.connectionState == .disconnected)
        #expect(!viewModel.state.isEnteringMeeting)
        #expect(await settle { !viewModel.versionGate.updateRequired })
    }

    @Test func blockedDemotionHandoffStopsWithoutAStrandedContinuation() async {
        let call = RejoinHarness()
        #expect(await call.join())
        call.viewModel.versionGateDefaults = UserDefaults(suiteName: "s6c.demotion." + UUID().uuidString)!
        call.viewModel.currentAppVersion = { "2.0.0" }
        call.viewModel.versionGateFetch = { .unavailable }
        _ = call.viewModel.applyVersionGate(.payload(MinNativeVersionPayload(ios: "9.0.0", android: "9.0.0")), source: "test")
        call.deliverWebinarDemoted(slug: "design-week")
        call.deliverServerDisconnect()
        #expect(await settle { call.viewModel.state.connectionState == .disconnected })
        #expect(await settle { call.viewModel.shell.session.phase != .entering })
        #expect(!call.viewModel.state.isEnteringMeeting)
        #expect(call.viewModel.premeeting.home.updateRequired)
        await call.finish()
    }
}

@MainActor
@Suite(.serialized)
struct S6CAuthRegressionTests {
    @Test(arguments: [false, true])
    func cancellationDiscardsSocialAndFollowupSessionCookies(duringSession: Bool) async throws {
        try await exerciseCookieRace(duringSession: duringSession, newerSignIn: false)
    }

    @Test(arguments: [false, true])
    func supersededExchangeCannotOverwriteANewerAcceptedSignIn(duringSession: Bool) async throws {
        try await exerciseCookieRace(duringSession: duringSession, newerSignIn: true)
    }

    private func exerciseCookieRace(duringSession: Bool, newerSignIn: Bool) async throws {
        let cookieName = "better-auth.s6c-" + UUID().uuidString.lowercased()
        let latch = S6CResponseLatch()
        var sessionSawPendingCookie = false
        NativeAuthService.testAuthRequest = { request in
            let body = request.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let isSession = request.url?.path.hasSuffix("get-session") == true
            let isOld = isSession ? (request.value(forHTTPHeaderField: "Cookie")?.contains("old-session") == true) : body.contains("old-token")
            let value = isOld ? "old-session" : "new-session"
            if isSession && isOld { sessionSawPendingCookie = true }
            if isOld && isSession == duringSession { await latch.wait() }
            return NativeAuthHTTPResult(data: Data(#"{"user":{"id":"account","name":"Name"}}"#.utf8),
                statusCode: 200, setCookieHeaders: [cookieName + "=" + value + "; Path=/; HttpOnly"])
        }
        defer {
            NativeAuthService.testAuthRequest = nil
            for cookie in HTTPCookieStorage.shared.cookies ?? [] where cookie.name == cookieName {
                HTTPCookieStorage.shared.deleteCookie(cookie)
            }
        }
        let oldEpoch = NativeAuthService.beginAuthentication()
        let old = Task { @MainActor in
            do {
                _ = try await NativeAuthService.signInWithSocialToken(provider: .apple, idToken: "old-token", authenticationEpoch: oldEpoch)
                return NativeAuthErrorKind.unknown
            } catch {
                return NativeAuthService.errorKind(error)
            }
        }
        #expect(await settle { latch.isWaiting })
        #expect(!(HTTPCookieStorage.shared.cookies ?? []).contains { $0.name == cookieName })
        if newerSignIn {
            let epoch = NativeAuthService.beginAuthentication()
            _ = try await NativeAuthService.signInWithSocialToken(provider: .google, idToken: "new-token", authenticationEpoch: epoch)
            #expect((HTTPCookieStorage.shared.cookies ?? []).first { $0.name == cookieName }?.value == "new-session")
        } else {
            let appState = AppState()
            let coordinator = AccountAuthCoordinator(appState: appState, account: AccountPresenter(), premeeting: nil)
            coordinator.perform(AccountRequest.make(kind: .cancelSignIn, generation: 1))
        }
        latch.release()
        #expect(await old.value == .cancelled)
        let stored = (HTTPCookieStorage.shared.cookies ?? []).first { $0.name == cookieName }
        #expect(stored?.value == (newerSignIn ? "new-session" : nil))
        if duringSession { #expect(sessionSawPendingCookie) }
    }
}

@MainActor
private final class S6CResponseLatch {
    private var continuation: CheckedContinuation<Void, Never>?
    var isWaiting: Bool { continuation != nil }

    func wait() async {
        await withCheckedContinuation { continuation = $0 }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}
#endif
