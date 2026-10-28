#if !SKIP
import Foundation
import Testing
@testable import Conclave

@MainActor
struct ACT9BrowserStageTests {
    private final class Recorder {
        var commands: [BrowserStageCommand] = []
        var ended: [String] = []

        func kinds() -> [String] {
            return commands.map { $0.kind.rawValue }
        }
    }

    private static let base = "https://browser.example/vnc.html?path=websockify"
    private static let video = "shared-browser-video:room-1"

    private func make() -> (BrowserStagePresenter, Recorder) {
        let presenter = BrowserStagePresenter()

        presenter.sleep = { _ in try? await Task.sleep(nanoseconds: 3_600_000_000_000) }
        let recorder = Recorder()
        presenter.onCommand = { [recorder] command in recorder.commands.append(command) }
        presenter.onSessionEnded = { [recorder] id in recorder.ended.append(id) }
        return (presenter, recorder)
    }

    private func inputs(controller: Bool = true, host: Bool = true, attendee: Bool = false, video: Bool = true,
                        noVnc: Bool = true, provider: String = "chromium", audio: Bool = true, muted: Bool = false,
                        navigating: Bool = false, reconnecting: Bool = false, session: Int = 1, active: Bool = true,
                        url: String = "https://www.example.com/docs") -> BrowserStageInputs {
        return BrowserStageInputs.make(
            callSession: session, isActive: active, isHost: host, isAttendee: attendee, url: url,
            inputBaseURL: noVnc ? Self.base : "", controllerName: controller ? "You" : "Avery", isYouController: controller,
            provider: provider, hasAudio: audio, isAudioMuted: muted, isNavigating: navigating,
            videoUserId: video ? Self.video : "", videoTrackKey: video ? "track-1" : "", isReconnecting: reconnecting)
    }

    @Test func inputURLAppendsTheFourParametersExactlyOnce() {
        let suffix = "autoconnect=true&resize=scale&quality=0&compression=9"
        #expect(BrowserInputURLPolicy.inputURL("https://b.example/vnc.html") == "https://b.example/vnc.html?" + suffix)
        #expect(BrowserInputURLPolicy.inputURL("https://b.example/vnc.html?path=websockify&token=abc")
                == "https://b.example/vnc.html?path=websockify&token=abc&" + suffix)
        #expect(BrowserInputURLPolicy.inputURL("https://b.example/vnc.html?") == "https://b.example/vnc.html?" + suffix)
        #expect(BrowserInputURLPolicy.inputURL("https://b.example/vnc.html?a=1&") == "https://b.example/vnc.html?a=1&" + suffix)
        #expect(BrowserInputURLPolicy.inputURL("https://b.example/vnc.html#view") == "https://b.example/vnc.html?" + suffix + "#view")
        #expect(BrowserInputURLPolicy.inputURL("  ") == "")

        #expect(BrowserInputURLPolicy.inputURL("https://b.example/vnc.html?autoconnect=1&Quality=6")
                == "https://b.example/vnc.html?autoconnect=1&Quality=6&resize=scale&compression=9")
        let full = "https://b.example/vnc.html?" + suffix
        #expect(BrowserInputURLPolicy.inputURL(full) == full)
        let once = BrowserInputURLPolicy.inputURL("https://b.example/vnc.html?path=websockify")
        #expect(BrowserInputURLPolicy.inputURL(once) == once)
        for parameter in BrowserInputURLPolicy.parameters {
            #expect(once.components(separatedBy: parameter).count == 2, "\(parameter) appears exactly once")
        }
    }

    @Test func hostLabelAndProviderRules() {
        #expect(BrowserHostLabelPolicy.hostLabel("https://www.Example.com/docs?q=1") == "example.com")
        #expect(BrowserHostLabelPolicy.hostLabel("https://docs.example.com") == "docs.example.com")
        #expect(BrowserHostLabelPolicy.hostLabel("") == "")
        #expect(BrowserHostLabelPolicy.hostLabel("not a url") == "")
        #expect(BrowserProviderPolicy.isKitesurf(" Kitesurf "))
        #expect(!BrowserProviderPolicy.isKitesurf("chromium"))
        #expect(BrowserProviderPolicy.isChromium("") && BrowserProviderPolicy.isChromium("local") && BrowserProviderPolicy.isChromium("Chromium"))
        #expect(!BrowserProviderPolicy.isChromium("kitesurf"))
    }

    @Test func timeoutsMatchTheWebClient() throws {
        #expect(SharedBrowserTimeouts.capabilitiesAckMillis == 22000)
        #expect(SharedBrowserTimeouts.commandAckMillis == 45000)
        #expect(SharedBrowserTimeouts.capabilitiesRefreshMillis == 30000)
        #expect(SharedBrowserTimeouts.heartbeatMillis == 30000)
        #expect(SharedBrowserTimeouts.firstFrameMillis == 20000)
        #expect(SharedBrowserTimeouts.seconds(22000) == 22.0)
        #expect(BrowserStagePresenter.hostActionSafetyMillis > Double(SharedBrowserTimeouts.commandAckMillis))
        let web = act9Normalized(try act9Repo("apps/web/src/app/hooks/useSharedBrowser.ts"))
        #expect(web.contains("const BROWSER_COMMAND_TIMEOUT_MS = 45000;"))
        #expect(web.contains("const BROWSER_CAPABILITIES_TIMEOUT_MS = 22000;"))
    }

    @Test func capabilityAndHeartbeatRules() throws {
        #expect(BrowserCapabilityPolicy.shouldProbe(isJoined: true, isHost: true, isAttendee: false))
        #expect(!BrowserCapabilityPolicy.shouldProbe(isJoined: true, isHost: false, isAttendee: false))
        #expect(!BrowserCapabilityPolicy.shouldProbe(isJoined: false, isHost: true, isAttendee: false))
        #expect(!BrowserCapabilityPolicy.shouldProbe(isJoined: true, isHost: true, isAttendee: true))
        #expect(!BrowserCapabilityPolicy.isAvailable(nil))
        #expect(!BrowserCapabilityPolicy.isAvailable(BrowserCapabilitiesResponse(available: false)))
        #expect(!BrowserCapabilityPolicy.isAvailable(BrowserCapabilitiesResponse(available: nil)))
        #expect(BrowserCapabilityPolicy.isAvailable(BrowserCapabilitiesResponse(available: true, provider: "kitesurf")))
        #expect(BrowserHeartbeatPolicy.shouldSend(isActive: true, isJoined: true, isHost: true, isAttendee: false))
        #expect(!BrowserHeartbeatPolicy.shouldSend(isActive: true, isJoined: true, isHost: false, isAttendee: false))
        #expect(!BrowserHeartbeatPolicy.shouldSend(isActive: false, isJoined: true, isHost: true, isAttendee: false))
        #expect(!BrowserHeartbeatPolicy.shouldSend(isActive: true, isJoined: true, isHost: true, isAttendee: true))

        let available = try JSONDecoder().decode(BrowserCapabilitiesResponse.self, from: Data(
            #"{"available":true,"provider":"kitesurf","audio":false,"video":false,"agentic":true}"#.utf8))
        #expect(available.available == true && available.provider == "kitesurf" && available.video == false && available.agentic == true)
        let unavailable = try JSONDecoder().decode(BrowserCapabilitiesResponse.self, from: Data(#"{"available":false}"#.utf8))
        #expect(unavailable.available == false && unavailable.provider == nil)
    }

    @Test func theProbeIsAckOnlyWithNoPayloadOnBothClients() throws {
        let ios = act9Normalized(try act9Source("Sources/Conclave/Core/Networking/SocketIOManager.swift"))
        let kotlin = act9Normalized(try act9Source("Sources/Conclave/Skip/SocketIOManager+Android.kt"))
        let android = try act9Source("Sources/Conclave/Core/Networking/SocketIOManager+Android.swift")
        let mac = try act9Source("Sources/Conclave/Core/Networking/SocketIOManager+macOS.swift")
        #expect(ios.contains("emitAckOnly(event: SocketEvent.browserGetCapabilities, timeoutSeconds: SharedBrowserTimeouts.seconds(SharedBrowserTimeouts.capabilitiesAckMillis))"))
        #expect(!ios.contains("emit(event: SocketEvent.browserGetCapabilities"))
        #expect(ios.contains("func emitAckOnly(event: String, timeoutSeconds: TimeInterval = 30)"))
        #expect(ios.contains("socket.emitWithAck(event).timingOut(after: timeoutSeconds)"))
        #expect(kotlin.contains("emitAckOnly(SocketEvent.browserGetCapabilities, timeoutMs = SharedBrowserTimeouts.capabilitiesAckMillis.toLong())"))
        #expect(!kotlin.contains("emit(SocketEvent.browserGetCapabilities"))
        #expect(kotlin.contains("private suspend fun emitAckOnly(event: String, timeoutMs: Long = ACK_TIMEOUT_MS): Data"))
        #expect(kotlin.contains("withAckTimeout(event, timeoutMs)"))

        for event in ["browserLaunch", "browserNavigate"] {
            #expect(ios.contains("emit(event: SocketEvent.\(event), payload: request, timeoutSeconds: SharedBrowserTimeouts.seconds(SharedBrowserTimeouts.commandAckMillis))"))
            #expect(kotlin.contains("emit(SocketEvent.\(event), request, timeoutMs = SharedBrowserTimeouts.commandAckMillis.toLong())"))
        }
        #expect(ios.contains("emitAckOnly(event: SocketEvent.browserClose, timeoutSeconds: SharedBrowserTimeouts.seconds(SharedBrowserTimeouts.commandAckMillis))"))
        #expect(kotlin.contains("emitAckOnly(SocketEvent.browserClose, timeoutMs = SharedBrowserTimeouts.commandAckMillis.toLong())"))
        #expect(android.contains("func getBrowserCapabilities() async throws -> BrowserCapabilitiesResponse"))
        #expect(mac.contains("func getBrowserCapabilities() async throws -> BrowserCapabilitiesResponse"))

        let sfu = act9Normalized(try act9Repo("packages/sfu/server/socket/handlers/sharedBrowserHandlers.ts"))
        #expect(sfu.contains("\"browser:getCapabilities\", async ( callback: ("))
        let web = act9Normalized(try act9Repo("apps/web/src/app/hooks/useSharedBrowser.ts"))
        #expect(web.contains("browser:getCapabilities"))

        #expect(SfuClientEvent.browserGetCapabilities.rawValue == "browser:getCapabilities")
    }

    @Test func theViewModelProbesHostsAndSendsHeartbeatsFromAdminsOnly() throws {
        let viewModel = act9Normalized(try act9Source("Sources/Conclave/Features/Meeting/MeetingViewModel.swift"))
        let state = act9Normalized(try act9Source("Sources/Conclave/Core/State/MeetingState.swift"))
        #expect(viewModel.contains("isBrowserAvailable: state.isBrowserAvailable,"))
        #expect(!viewModel.contains("isBrowserAvailable: true,"))
        #expect(viewModel.contains("BrowserCapabilityPolicy.shouldProbe(isJoined: state.connectionState == .joined, isHost: state.isAdmin, isAttendee: state.isWebinarAttendee)"))
        #expect(viewModel.contains("try await socketManager.getBrowserCapabilities()"))
        #expect(viewModel.components(separatedBy: "startBrowserCapabilityLoop()").count >= 3, "probe after join and after recovery")
        #expect(viewModel.contains("stopBrowserCapabilityLoop() isBrowserCapabilityProbeInFlight = false state.isBrowserAvailable = false"))
        #expect(viewModel.contains("BrowserHeartbeatPolicy.shouldSend(isActive: self.state.isBrowserActive"))
        #expect(viewModel.contains("activitySession.browser.onCommand = { [weak self] command in"))
        #expect(viewModel.contains("activitySession.browser.apply(makeBrowserStageInputs())"))
        #expect(viewModel.contains("activitySession.browser.navigateFailed()"))
        #expect(viewModel.contains("activitySession.browser.closeFailed()"))
        #expect(viewModel.contains("activitySession.browser.commandRejected(BrowserStageCommandKind.navigate)"))
        #expect(viewModel.contains("webRTCClient.remoteVideoTrack(forUserId: producer.producerUserId + \"-screen\")"))
        #expect(state.contains("var isBrowserAvailable: Bool = false {"))
        #expect(state.contains("var browserNoVncURL: String? { didSet { onActivityInputChanged?() } }"))
    }

    @Test func theControllerGetsTheInputLayerOverTheVideo() {
        let (presenter, _) = make()
        presenter.apply(inputs())
        let model = presenter.model
        #expect(model.isActive && !model.browserSessionId.isEmpty)
        #expect(model.surface == BrowserSurfaceKind.video && model.webViewRole == BrowserWebViewRole.input)
        #expect(model.inputURL == Self.base + "&autoconnect=true&resize=scale&quality=0&compression=9")
        #expect(model.wantsWebView && model.inputInteractive && model.canControl && model.showsAddressRow && model.canClose)
        #expect(model.load == BrowserLoadState.starting && !model.hasSurface)
        #expect(model.hostLabel == "example.com" && model.isYouSharing && model.pageURL == "https://www.example.com/docs")
        #expect(model.videoUserId == Self.video && model.videoTrackKey == "track-1")
        #expect(presenter.hasFirstFrameTimer)
        #expect(BrowserStagePresenter.aspectRatio(width: 0, height: 0) == 16.0 / 9.0)

        presenter.videoFrameArrived(width: 1280, height: 800)
        #expect(presenter.model.load == BrowserLoadState.live && presenter.model.hasSurface)
        #expect(presenter.model.framebufferWidth == 1280 && presenter.model.framebufferHeight == 800)
        #expect(BrowserStagePresenter.aspectRatio(width: 1280, height: 800) == 1.6)
        #expect(!presenter.hasFirstFrameTimer)

        let id = presenter.model.browserSessionId
        presenter.webViewLoadStarted(browserSessionId: id, reloadSerial: 0)
        #expect(presenter.model.load == BrowserLoadState.loading)
        presenter.webViewLoadFinished(browserSessionId: id, reloadSerial: 0)
        #expect(presenter.model.load == BrowserLoadState.live)

        let revision = presenter.model.revision
        presenter.apply(inputs())
        presenter.videoFrameArrived(width: 1280, height: 800)
        #expect(presenter.model.revision == revision, "equal inputs and frame sizes publish nothing")
    }

    @Test func viewersRenderOnlyTheVideoAndHoldNoWebView() {
        let (presenter, _) = make()
        presenter.apply(inputs(controller: false, host: false))
        let model = presenter.model
        #expect(model.surface == BrowserSurfaceKind.video && model.webViewRole == BrowserWebViewRole.none)
        #expect(!model.wantsWebView && model.inputURL.isEmpty && !model.inputInteractive)
        #expect(!model.canControl && !model.showsAddressRow && !model.canClose && !model.canNavigate)
        #expect(model.sharedByName == "Avery" && !model.isYouSharing)
        #expect(presenter.navigate("example.org") == ActivityTapResult.explained)
        #expect(presenter.focusKeyboard() == ActivityTapResult.explained)
        #expect(presenter.confirmClose() == ActivityTapResult.explained)

        let host = make().0
        host.apply(inputs(controller: false, host: true))
        #expect(host.model.canNavigate && host.model.canClose && !host.model.canControl && !host.model.showsAddressRow)
        #expect(host.model.webViewRole == BrowserWebViewRole.none)

        let (moving, _) = make()
        moving.apply(inputs())
        #expect(moving.model.wantsWebView)
        moving.apply(inputs(controller: false))
        #expect(!moving.model.wantsWebView && moving.model.webViewRole == BrowserWebViewRole.none)
    }

    @Test func kitesurfShowsTheLiveViewPageWithoutAudio() {
        let (presenter, _) = make()
        presenter.apply(inputs(video: false, provider: "kitesurf", audio: true))
        let model = presenter.model
        #expect(model.isKitesurf && model.surface == BrowserSurfaceKind.liveView && model.webViewRole == BrowserWebViewRole.liveView)
        #expect(model.inputURL == Self.base, "the visible page loads as is")
        #expect(!model.showsAudioControl && model.hasAudio)
        #expect(presenter.toggleAudio() == ActivityTapResult.explained)
        let id = model.browserSessionId
        presenter.webViewLoadFinished(browserSessionId: id, reloadSerial: 0)
        #expect(presenter.model.load == BrowserLoadState.live && presenter.model.hasSurface)

        let (viewer, _) = make()
        viewer.apply(inputs(controller: false, host: false, video: false, provider: "kitesurf"))
        #expect(viewer.model.wantsWebView && viewer.model.webViewRole == BrowserWebViewRole.liveView && !viewer.model.inputInteractive)
    }

    @Test func startingTimesOutIntoTheFailureStateAndTryAgainRefreshes() {
        let (presenter, recorder) = make()
        presenter.apply(inputs(video: false, noVnc: false))
        #expect(presenter.model.load == BrowserLoadState.starting && presenter.model.surface == BrowserSurfaceKind.none)
        #expect(!presenter.model.wantsWebView && presenter.hasFirstFrameTimer)
        let id = presenter.model.browserSessionId
        presenter.fireFirstFrameTimeout(browserSessionId: "browser-stale", reloadSerial: 0)
        #expect(presenter.model.load == BrowserLoadState.starting)
        presenter.fireFirstFrameTimeout(browserSessionId: id, reloadSerial: 0)
        #expect(presenter.model.load == BrowserLoadState.failed)
        #expect(presenter.model.failure == BrowserFailure.timedOut && presenter.model.issue == BrowserLoadIssue.videoTimedOut)
        #expect(presenter.retryLoad() == ActivityTapResult.dispatched)
        #expect(recorder.kinds() == ["refresh"])
        #expect(presenter.model.load == BrowserLoadState.starting && presenter.model.reloadSerial == 1)
        #expect(presenter.hasFirstFrameTimer)
        #expect(presenter.retryLoad() == ActivityTapResult.ignored)
    }

    @Test func pageTLSAndRendererFailuresShareTheFailureStateAndStaleReportsChangeNothing() {
        for issue in [BrowserLoadIssue.pageFailed, BrowserLoadIssue.sslFailed, BrowserLoadIssue.rendererGone] {
            let (presenter, _) = make()
            presenter.apply(inputs())
            let id = presenter.model.browserSessionId
            presenter.webViewFailed(browserSessionId: id, reloadSerial: 7, issue: issue)
            presenter.webViewFailed(browserSessionId: "browser-other", reloadSerial: 0, issue: issue)
            #expect(presenter.model.load == BrowserLoadState.starting)
            presenter.webViewFailed(browserSessionId: id, reloadSerial: 0, issue: issue)
            #expect(presenter.model.load == BrowserLoadState.failed && presenter.model.issue == issue)
            #expect(presenter.model.failure == BrowserFailure.loadFailed)
            #expect(!presenter.model.wantsWebView && !presenter.model.inputInteractive, "the failed web view is released")
            #expect(!presenter.hasFirstFrameTimer)
            presenter.webViewFailed(browserSessionId: id, reloadSerial: 0, issue: BrowserLoadIssue.pageFailed)
            #expect(presenter.model.issue == issue, "the first failure is the one shown")
            presenter.retryLoad()
            #expect(presenter.model.wantsWebView && presenter.model.reloadSerial == 1)
        }

        let (page, _) = make()
        page.apply(inputs(video: false, provider: "kitesurf"))
        let id = page.model.browserSessionId
        page.webViewFailed(browserSessionId: id, reloadSerial: 0, issue: BrowserLoadIssue.rendererGone)
        page.retryLoad()
        page.webViewLoadFinished(browserSessionId: id, reloadSerial: 0)
        #expect(!page.model.hasSurface && page.model.load == BrowserLoadState.starting)
        page.webViewLoadFinished(browserSessionId: id, reloadSerial: 1)
        #expect(page.model.hasSurface && page.model.load == BrowserLoadState.live)
    }

    @Test func reconnectingKeepsTheFrameDisablesInputAndWaitsOutTheTimeout() {
        let (presenter, _) = make()
        presenter.apply(inputs())
        presenter.videoFrameArrived(width: 1920, height: 1080)
        presenter.apply(inputs(reconnecting: true))
        #expect(presenter.model.load == BrowserLoadState.reconnecting && !presenter.model.inputInteractive)
        #expect(presenter.model.hasSurface && presenter.model.wantsWebView)
        #expect(presenter.focusKeyboard() == ActivityTapResult.explained)
        presenter.apply(inputs())
        #expect(presenter.model.load == BrowserLoadState.live && presenter.model.inputInteractive)

        let (waiting, _) = make()
        waiting.apply(inputs(video: false, noVnc: false, reconnecting: true))
        waiting.fireFirstFrameTimeout(browserSessionId: waiting.model.browserSessionId, reloadSerial: 0)
        #expect(waiting.model.load == BrowserLoadState.reconnecting, "a recovery is not a load failure")
    }

    @Test func navigateValidatesAndStaysPendingUntilTheCoreAnswers() {
        let (presenter, recorder) = make()
        presenter.apply(inputs())
        #expect(presenter.navigate("  ") == ActivityTapResult.explained)
        #expect(presenter.model.validation == BrowserValidation.empty && recorder.commands.isEmpty)
        #expect(presenter.navigate("example .com") == ActivityTapResult.explained)
        #expect(presenter.model.validation == BrowserValidation.spaces)
        #expect(presenter.navigate("ftp://example.com") == ActivityTapResult.explained)
        #expect(presenter.model.validation == BrowserValidation.scheme)
        presenter.clearValidation()
        #expect(presenter.model.validation == BrowserValidation.none)

        #expect(presenter.navigate(" example.org ") == ActivityTapResult.dispatched)
        #expect(recorder.commands.last == BrowserStageCommand.make(BrowserStageCommandKind.navigate, text: "example.org"))
        #expect(presenter.model.navigatePending)
        #expect(presenter.navigate("example.net") == ActivityTapResult.ignored)
        presenter.apply(inputs(navigating: true))
        presenter.apply(inputs(navigating: false))
        #expect(!presenter.model.navigatePending)

        let token = presenter.feedbackState.token.sequence
        presenter.navigate("example.org")
        presenter.navigateFailed()
        #expect(!presenter.model.navigatePending && presenter.model.commandFailure == BrowserFailure.navigateFailed)
        #expect(presenter.feedbackState.token.kind == FeedbackKind.hostActionFailed && presenter.feedbackState.token.sequence == token + 1)
        presenter.clearValidation()
        #expect(presenter.model.commandFailure == BrowserFailure.none)

        presenter.navigate("example.org")
        presenter.commandRejected(BrowserStageCommandKind.navigate)
        #expect(!presenter.model.navigatePending && presenter.feedbackState.token.sequence == token + 1, "a refused command is silent")

        presenter.apply(inputs(navigating: true))
        #expect(presenter.model.navigatePending)
    }

    @Test func closeIsHostOnlyDuplicateGuardedAndAudioIsLocal() {
        let (presenter, recorder) = make()
        presenter.apply(inputs())
        #expect(presenter.confirmClose() == ActivityTapResult.dispatched)
        #expect(presenter.confirmClose() == ActivityTapResult.ignored)
        #expect(presenter.model.closePending)
        presenter.closeFailed()
        #expect(!presenter.model.closePending && presenter.feedbackState.token.kind == FeedbackKind.hostActionFailed)
        presenter.confirmClose()
        presenter.apply(inputs(active: false))
        #expect(!presenter.model.isActive && !presenter.model.closePending)

        let (audio, audioRecorder) = make()
        audio.apply(inputs(audio: true))
        let sequence = audio.feedbackState.token.sequence
        #expect(audio.model.showsAudioControl)
        #expect(audio.toggleAudio() == ActivityTapResult.dispatched)
        #expect(audioRecorder.kinds() == ["toggleAudio"] && audio.feedbackState.token.sequence == sequence)
        audio.apply(inputs(audio: true, muted: true))
        #expect(audio.model.isAudioMuted)
        let (silent, _) = make()
        silent.apply(inputs(audio: false))
        #expect(!silent.model.showsAudioControl)
        #expect(recorder.kinds() == ["close", "close"])
    }

    @Test func keyboardFocusIsTheControllersOnly() {
        let (presenter, _) = make()
        presenter.apply(inputs())
        #expect(presenter.focusKeyboard() == ActivityTapResult.explained, "no surface yet")
        presenter.videoFrameArrived(width: 1280, height: 720)
        #expect(presenter.focusKeyboard() == ActivityTapResult.dispatched)
        #expect(presenter.model.keyboardSerial == 1)
        #expect(BrowserInputScripts.focusKeyboard.contains("noVNC_keyboardinput"))
        #expect(BrowserInputScripts.installHiddenCanvas.contains("opacity: 0 !important"))
        #expect(!BrowserInputScripts.focusKeyboard.contains("$") && !BrowserInputScripts.installHiddenCanvas.contains("$"))
    }

    @Test func attendeesNeverSeeItAndSessionsEndCleanly() {
        let (attendee, _) = make()
        attendee.apply(inputs(attendee: true))
        #expect(!attendee.model.isActive && !attendee.model.wantsWebView && attendee.model.surface == BrowserSurfaceKind.none)

        let (presenter, recorder) = make()
        presenter.apply(inputs())
        let first = presenter.model.browserSessionId
        presenter.apply(inputs(active: false))
        #expect(recorder.ended == [first] && presenter.model.browserSessionId.isEmpty && !presenter.hasFirstFrameTimer)
        presenter.apply(inputs())
        let second = presenter.model.browserSessionId
        #expect(!second.isEmpty && second != first, "a new activation gets a fresh web view")

        presenter.navigate("example.org")
        presenter.apply(inputs(session: 2))
        #expect(recorder.ended == [first, second] && !presenter.model.navigatePending)
        let third = presenter.model.browserSessionId
        presenter.reset()
        #expect(recorder.ended == [first, second, third] && !presenter.model.isActive && presenter.model.load == BrowserLoadState.starting)
    }

    @Test func loadIssuesMapFromEachPlatformsErrors() {
        #expect(BrowserLoadIssuePolicy.urlErrorDomain == NSURLErrorDomain)
        #expect(BrowserLoadIssuePolicy.urlErrorCancelled == NSURLErrorCancelled)
        #expect(BrowserLoadIssuePolicy.urlErrorTLSLast == NSURLErrorSecureConnectionFailed)
        #expect(BrowserLoadIssuePolicy.urlErrorTLSFirst == NSURLErrorClientCertificateRequired)
        #expect(BrowserLoadIssuePolicy.errorIssue(domain: NSURLErrorDomain, code: NSURLErrorCancelled) == BrowserLoadIssue.none)
        #expect(BrowserLoadIssuePolicy.errorIssue(domain: NSURLErrorDomain, code: NSURLErrorServerCertificateUntrusted) == BrowserLoadIssue.sslFailed)
        #expect(BrowserLoadIssuePolicy.errorIssue(domain: NSURLErrorDomain, code: NSURLErrorServerCertificateHasBadDate) == BrowserLoadIssue.sslFailed)
        #expect(BrowserLoadIssuePolicy.errorIssue(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet) == BrowserLoadIssue.pageFailed)
        #expect(BrowserLoadIssuePolicy.errorIssue(domain: NSURLErrorDomain, code: NSURLErrorTimedOut) == BrowserLoadIssue.pageFailed)
        #expect(BrowserLoadIssuePolicy.errorIssue(domain: "WebKitErrorDomain", code: 102) == BrowserLoadIssue.none)
        #expect(BrowserLoadIssuePolicy.errorIssue(domain: "WebKitErrorDomain", code: 101) == BrowserLoadIssue.pageFailed)
        #expect(BrowserLoadIssuePolicy.androidErrorIssue(-11) == BrowserLoadIssue.sslFailed)
        #expect(BrowserLoadIssuePolicy.androidErrorIssue(-2) == BrowserLoadIssue.pageFailed)
        #expect(BrowserLoadIssuePolicy.httpIssue(404) == BrowserLoadIssue.pageFailed)
        #expect(BrowserLoadIssuePolicy.httpIssue(200) == BrowserLoadIssue.none)
        #expect(BrowserNavigationPolicy.allows(scheme: "HTTPS") && BrowserNavigationPolicy.allows(scheme: "about"))
        for scheme in ["intent", "javascript", "file", "conclave", "data", ""] {
            #expect(!BrowserNavigationPolicy.allows(scheme: scheme), "\(scheme) is blocked")
        }
        #expect(BrowserStagePresenter.load(issue: BrowserLoadIssue.none, isReconnecting: false, hasSurface: true, isPageLoading: false) == BrowserLoadState.live)
        #expect(BrowserStagePresenter.load(issue: BrowserLoadIssue.sslFailed, isReconnecting: true, hasSurface: true, isPageLoading: true) == BrowserLoadState.failed)
        #expect(BrowserStagePresenter.webViewRole(surface: BrowserSurfaceKind.video, canControl: false) == BrowserWebViewRole.none)
        #expect(BrowserStagePresenter.surface(isActive: true, videoUserId: "", inputBaseURL: "", usesFixturePage: true) == BrowserSurfaceKind.liveView)
    }

    @Test func fixturesScriptEachStateWithoutTheNetwork() {
        for state in BrowserStageFixtureState.allCases {
            let presenter = BrowserStagePresenter()
            presenter.sleep = { _ in try? await Task.sleep(nanoseconds: 3_600_000_000_000) }
            let owner = BrowserFixtureOwner()
            BrowserStageFixtures.apply(named: state.rawValue, presenter: presenter, owner: owner)
            let model = presenter.model
            #expect(model.isActive && presenter.showsDebugReadouts)
            #expect(model.inputURL.isEmpty, "\(state.rawValue) never loads a remote page")
            switch state {
            case .controller:
                #expect(model.load == BrowserLoadState.live && model.inputInteractive && model.showsAddressRow && model.usesFixturePage)
                presenter.navigate("example.org")
                #expect(owner.commands == ["navigate example.org"] && owner.readout() == "1 last=navigate example.org")
            case .viewer:
                #expect(model.load == BrowserLoadState.live && !model.inputInteractive && !model.showsAddressRow)
            case .starting:
                #expect(model.load == BrowserLoadState.starting && !model.wantsWebView && presenter.hasFirstFrameTimer)
            case .failed:
                #expect(model.load == BrowserLoadState.failed && model.issue == BrowserLoadIssue.sslFailed)
            case .rendererGone:
                #expect(model.load == BrowserLoadState.failed && model.issue == BrowserLoadIssue.rendererGone)
            case .reconnecting:
                #expect(model.load == BrowserLoadState.reconnecting && !model.inputInteractive)
            case .kitesurf:
                #expect(model.isKitesurf && !model.showsAudioControl)
            }
        }
        let stage = BrowserStageFixtures.stageInputs(named: "browser-reconnecting", base: StageInputs.make(callSession: 1, isInCall: true))
        #expect(stage.isBrowserActive && stage.isRecovering && stage.activeAppId.isEmpty && !stage.isGameActive)
        #expect(BrowserStageFixtures.isFixture("browser-kitesurf") && !BrowserStageFixtures.isFixture("app-opening"))
        #expect(!BrowserFixturePage.html.contains("http") && !BrowserFixturePage.html.contains("<script"))
    }

    @Test func iosSurfaceKeepsTheInputLayerContract() throws {
        let ios = try act9Source("Sources/Conclave/Features/Meeting/Activities/BrowserSurface+iOS.swift")
        let flat = act9Normalized(ios)
        #expect(ios.hasPrefix("#if os(iOS) && !SKIP\n") && ios.hasSuffix("#endif\n"))
        for needle in ["WKWebsiteDataStore.nonPersistent()", "webViewWebContentProcessDidTerminate", "didFailProvisionalNavigation",
                       "decidePolicyFor navigationResponse", "BrowserLoadIssuePolicy.errorIssue(domain: nsError.domain, code: nsError.code)",
                       "BrowserLoadIssuePolicy.httpIssue(response.statusCode)", "webView.isOpaque = false", "webView.alpha = 1",
                       "webView.backgroundColor = .clear", "WKUserScript(source: BrowserInputScripts.installHiddenCanvas",
                       "evaluateJavaScript(BrowserInputScripts.focusKeyboard", ".keyboardType(.URL)", ".textInputAutocapitalization(.never)",
                       ".autocorrectionDisabled()", ".submitLabel(.go)", ".onSubmit(go)", "StageVideoSurface(", "contentMode: .fit",
                       "slotId: BrowserStagePresenter.videoSlotId", "presenter.onSessionEnded = { [weak self] endedId in",
                       "accessibilityElementsHidden = true", "UIAccessibility.post(notification: .announcement"] {
            #expect(flat.contains(act9Normalized(needle)), "BrowserSurface+iOS.swift lacks \(needle)")
        }
        for forbidden in ["NativeWebView", "MeetingViewModel", "Image(systemName: \"", "print(", "debugLog(", "NSLog(", "callAsyncJavaScript(",
                          "addScriptMessageHandler", "userContentController.add(", "\u{2013}", "\u{2014}"] {
            #expect(!ios.contains(forbidden), "BrowserSurface+iOS.swift uses \(forbidden)")
        }
        #expect(!ios.lowercased().contains("gradient"))
        let stage = act9Normalized(try act9Source("Sources/Conclave/Features/Meeting/Stage/ActivityStage+iOS.swift"))
        #expect(stage.contains("BrowserStageBody(browser: session.browser, stage: stage, onShowVideo: { stage.setShowsVideoOverActivity(true) })"))
        #expect(stage.contains("BrowserStageMenu(browser: session.browser)"))
        #expect(stage.contains("status: BrowserCopy.headerStatus(session.browser.model)"))
    }

    @Test func androidSurfaceKeepsTheLoadStateContract() throws {
        let surface = try act9Source("Sources/Conclave/Skip/ui/browser/BrowserSurface.kt")
        let registry = try act9Source("Sources/Conclave/Skip/ui/browser/BrowserWebViewRegistry.kt")
        let copy = try act9Source("Sources/Conclave/Skip/ui/browser/BrowserCopy.kt")
        let flat = act9Normalized(surface + registry)
        for needle in ["KeyboardType.Uri", "capitalization = KeyboardCapitalization.None", "autoCorrectEnabled = false", "imeAction = ImeAction.Go",
                       "override fun onRenderProcessGone", "return true", "override fun onReceivedSslError", "handler?.cancel()",
                       "BrowserLoadIssue.sslFailed", "override fun onReceivedHttpError", "BrowserLoadIssuePolicy.httpIssue(errorResponse.statusCode)",
                       "BrowserLoadIssuePolicy.androidErrorIssue(error.errorCode)", "request?.isForMainFrame != true",
                       "android.graphics.Color.TRANSPARENT", "BrowserInputScripts.installHiddenCanvas", "allowFileAccess = false",
                       "allowContentAccess = false", "setSupportMultipleWindows(false)", "AndroidView(", "onRelease",
                       "rendererKey = \"stage:\" + BrowserStagePresenter.videoSlotId", "Modifier.aspectRatio(ratio)",
                       "presenter.onSessionEnded = { endedId -> release(endedId) }", "IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS",
                       "liveRegion = LiveRegionMode.Polite", "role = Role.Switch"] {
            #expect(flat.contains(act9Normalized(needle)), "the Android browser surface lacks \(needle)")
        }
        for (name, text) in [("surface", surface), ("registry", registry), ("copy", copy)] {
            for forbidden in ["SharedBrowserWebView", "NativePerformanceDiagnostics", "android.util.Log", "Log.d(", "Log.i(", "Log.w(",
                              "Log.e(", "println(", "MeetingViewModel", "addJavascriptInterface(",
                              "Text(\"", "Color(0x", "\u{2013}", "\u{2014}"] {
                #expect(!text.contains(forbidden), "\(name) uses \(forbidden)")
            }
            #expect(!text.lowercased().contains("gradient"), "\(name) mentions a gradient")
        }
        let stage = act9Normalized(try act9Source("Sources/Conclave/Skip/ui/call/stage/ActivityStage.kt"))
        #expect(stage.contains("BrowserStageBody(session.browser, stage, onShowVideo = { stage.setShowsVideoOverActivity(true) })"))
        #expect(stage.contains("BrowserStageMenu(session.browser)"))
        #expect(stage.contains("browserHeaderStatus(session.browser.model)"))
    }

    @Test func legacyWebViewsStayOffTheNativePath() throws {
        let root = act9PackageRoot().appendingPathComponent("Sources/Conclave")
        let enumerator = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        var nativeWebViewUsers: [String] = []
        var sharedBrowserWebViewUsers: [String] = []
        for case let url as URL in enumerator where url.pathExtension == "swift" || url.pathExtension == "kt" {
            let text = try String(contentsOf: url, encoding: .utf8)
            let name = url.lastPathComponent
            if text.contains("NativeWebView(") && name != "NativeWebView.swift" { nativeWebViewUsers.append(name) }
            if text.contains("SharedBrowserWebView(") && name != "SharedBrowserWebView.kt" { sharedBrowserWebViewUsers.append(name) }
        }
        #expect(nativeWebViewUsers == ["SharedBrowserLayoutView.swift"])
        #expect(sharedBrowserWebViewUsers == ["NativeWebView.swift"])
    }

    @Test func browserStringsAreInBothCatalogs() throws {
        let catalogData = try Data(contentsOf: act9PackageRoot().appendingPathComponent("Sources/Conclave/Resources/Localizable.xcstrings"))
        let catalog = try #require(try JSONSerialization.jsonObject(with: catalogData) as? [String: Any])
        let strings = try #require(catalog["strings"] as? [String: Any])
        let ios = try act9Source("Sources/Conclave/Features/Meeting/Activities/BrowserSurface+iOS.swift")
        let pattern = try NSRegularExpression(pattern: #"ConclaveStrings\.(?:text|format)\("((?:[^"\\]|\\.)+)""#)
        var keys = Set<String>()
        for match in pattern.matches(in: ios, range: NSRange(ios.startIndex..., in: ios)) {
            if let range = Range(match.range(at: 1), in: ios) { keys.insert(String(ios[range])) }
        }
        #expect(keys.count >= 20)
        for key in keys { #expect(strings[key] != nil, "missing iOS key \(key)") }
        let xml = try String(contentsOf: act9PackageRoot().appendingPathComponent("Android/app/src/main/res/values/strings.xml"), encoding: .utf8)
        let kotlin = try act9Source("Sources/Conclave/Skip/ui/browser/BrowserCopy.kt") + act9Source("Sources/Conclave/Skip/ui/browser/BrowserSurface.kt")
        let names = try NSRegularExpression(pattern: #""((?:br|act|stg|ds)_[a-z0-9_]+)""#)
        var found = 0
        for match in names.matches(in: kotlin, range: NSRange(kotlin.startIndex..., in: kotlin)) {
            guard let range = Range(match.range(at: 1), in: kotlin) else { continue }
            found += 1
            let name = String(kotlin[range])
            #expect(xml.contains("name=\"" + name + "\""), "missing Android resource \(name)")
        }
        #expect(found >= 30)
    }
}

private func act9PackageRoot() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

private func act9Source(_ packageRelativePath: String) throws -> String {
    try String(contentsOf: act9PackageRoot().appendingPathComponent(packageRelativePath), encoding: .utf8)
}

private func act9Repo(_ repoRelativePath: String) throws -> String {
    let repo = act9PackageRoot().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: repo.appendingPathComponent(repoRelativePath), encoding: .utf8)
}

private func act9Normalized(_ text: String) -> String {
    return text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" || $0 == "\r" }).joined(separator: " ")
}
#endif
