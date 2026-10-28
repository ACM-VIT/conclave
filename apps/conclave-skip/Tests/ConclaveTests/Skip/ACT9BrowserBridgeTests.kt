package conclave.module

import android.webkit.WebViewClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import skip.foundation.Data
import skip.foundation.JSONDecoder

/**
 * ACT-9 through the transpiled browser contract and presenter plus the handwritten Android helpers (the Swift half is
 * T/ACT9BrowserStageTests.swift): BrowserInputURLPolicy, the C6-20 timeouts and capability rules, the probe answer through
 * the Android JSON path, the load-issue mapping against the platform's own SSL error code, the presenter's controller and
 * viewer modes over one load-state contract, the registry refusing a WebView to viewers, the fixtures, and every copy name
 * the card asks for. No composition and no WebView (Robolectric has no WebView provider).
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class ACT9BrowserBridgeTests {
    private val base = "https://browser.example/vnc.html?path=websockify"

    private fun inputs(
        controller: Boolean = true, host: Boolean = true, video: Boolean = true, noVnc: Boolean = true, provider: String = "chromium",
        audio: Boolean = true, reconnecting: Boolean = false, navigating: Boolean = false, active: Boolean = true,
    ): BrowserStageInputs = BrowserStageInputs.make(
        callSession = 1, isActive = active, isHost = host, url = "https://www.example.com/docs",
        inputBaseURL = if (noVnc) base else "", controllerName = if (controller) "You" else "Avery", isYouController = controller,
        provider = provider, hasAudio = audio, isNavigating = navigating,
        videoUserId = if (video) "shared-browser-video:room-1" else "", videoTrackKey = if (video) "track-1" else "",
        isReconnecting = reconnecting,
    )

    @Test fun inputUrlPolicyAppendsTheFourParametersOnceLikeSwift() {
        val suffix = "autoconnect=true&resize=scale&quality=0&compression=9"
        assertEquals("https://b.example/vnc.html?$suffix", BrowserInputURLPolicy.inputURL("https://b.example/vnc.html"))
        assertEquals("https://b.example/vnc.html?path=websockify&token=abc&$suffix",
            BrowserInputURLPolicy.inputURL("https://b.example/vnc.html?path=websockify&token=abc"))
        assertEquals("https://b.example/vnc.html?$suffix", BrowserInputURLPolicy.inputURL("https://b.example/vnc.html?"))
        assertEquals("https://b.example/vnc.html?$suffix#view", BrowserInputURLPolicy.inputURL("https://b.example/vnc.html#view"))
        assertEquals("https://b.example/vnc.html?autoconnect=1&Quality=6&resize=scale&compression=9",
            BrowserInputURLPolicy.inputURL("https://b.example/vnc.html?autoconnect=1&Quality=6"))
        val once = BrowserInputURLPolicy.inputURL(base)
        assertEquals(once, BrowserInputURLPolicy.inputURL(once))
        assertEquals("", BrowserInputURLPolicy.inputURL("  "))
        assertEquals(4, BrowserInputURLPolicy.parameters.count)
        assertEquals("example.com", BrowserHostLabelPolicy.hostLabel("https://www.Example.com/docs"))
        assertEquals("", BrowserHostLabelPolicy.hostLabel(""))
    }

    @Test fun timeoutsCapabilitiesAndTheProbeAnswerMatchSwift() {
        assertEquals(22000, SharedBrowserTimeouts.capabilitiesAckMillis)
        assertEquals(45000, SharedBrowserTimeouts.commandAckMillis)
        assertEquals(30000, SharedBrowserTimeouts.capabilitiesRefreshMillis)
        assertEquals(20000, SharedBrowserTimeouts.firstFrameMillis)
        assertTrue(BrowserCapabilityPolicy.shouldProbe(isJoined = true, isHost = true, isAttendee = false))
        assertFalse(BrowserCapabilityPolicy.shouldProbe(isJoined = true, isHost = false, isAttendee = false))
        assertFalse(BrowserCapabilityPolicy.shouldProbe(isJoined = true, isHost = true, isAttendee = true))
        assertFalse(BrowserCapabilityPolicy.isAvailable(null))
        assertFalse(BrowserCapabilityPolicy.isAvailable(BrowserCapabilitiesResponse(available = false)))
        assertTrue(BrowserCapabilityPolicy.isAvailable(BrowserCapabilitiesResponse(available = true, provider = "kitesurf")))
        assertTrue(BrowserHeartbeatPolicy.shouldSend(isActive = true, isJoined = true, isHost = true, isAttendee = false))
        assertFalse(BrowserHeartbeatPolicy.shouldSend(isActive = true, isJoined = true, isHost = false, isAttendee = false))

        val json = "{\"available\":true,\"provider\":\"kitesurf\",\"audio\":false,\"video\":false,\"agentic\":true}"
        val answer = JSONDecoder().decode(BrowserCapabilitiesResponse::class, from = Data(platformValue = json.toByteArray(Charsets.UTF_8)))
        assertEquals(true, answer.available)
        assertEquals("kitesurf", answer.provider)
        assertEquals(false, answer.video)
        val closed = JSONDecoder().decode(BrowserCapabilitiesResponse::class,
            from = Data(platformValue = "{\"available\":false}".toByteArray(Charsets.UTF_8)))
        assertFalse(BrowserCapabilityPolicy.isAvailable(closed))
    }

    @Test fun loadIssuesAndNavigationRulesUseThePlatformCodes() {
        assertEquals(WebViewClient.ERROR_FAILED_SSL_HANDSHAKE, BrowserLoadIssuePolicy.androidFailedSSLHandshake)
        assertEquals(BrowserLoadIssue.sslFailed, BrowserLoadIssuePolicy.androidErrorIssue(WebViewClient.ERROR_FAILED_SSL_HANDSHAKE))
        assertEquals(BrowserLoadIssue.pageFailed, BrowserLoadIssuePolicy.androidErrorIssue(WebViewClient.ERROR_HOST_LOOKUP))
        assertEquals(BrowserLoadIssue.pageFailed, BrowserLoadIssuePolicy.httpIssue(502))
        assertEquals(BrowserLoadIssue.none, BrowserLoadIssuePolicy.httpIssue(204))
        assertEquals(BrowserLoadIssue.sslFailed, BrowserLoadIssuePolicy.errorIssue(domain = "NSURLErrorDomain", code = -1202))
        assertEquals(BrowserLoadIssue.none, BrowserLoadIssuePolicy.errorIssue(domain = "NSURLErrorDomain", code = -999))
        assertTrue(BrowserNavigationPolicy.allows(scheme = "https"))
        assertFalse(BrowserNavigationPolicy.allows(scheme = "intent"))
        assertFalse(BrowserNavigationPolicy.allows(scheme = "javascript"))
        assertFalse(BrowserInputScripts.installHiddenCanvas.contains("$"))
        assertFalse(BrowserInputScripts.focusKeyboard.contains("$"))
    }

    @Test fun presenterControllerAndViewerMatchSwift() {
        val sent = mutableListOf<String>()
        val ended = mutableListOf<String>()
        val presenter = BrowserStagePresenter()
        presenter.onCommand = { command -> sent.add(command.kind.rawValue) }
        presenter.onSessionEnded = { id -> ended.add(id) }
        presenter.apply(inputs())
        assertEquals(BrowserSurfaceKind.video, presenter.model.surface)
        assertEquals(BrowserWebViewRole.input, presenter.model.webViewRole)
        assertEquals("$base&autoconnect=true&resize=scale&quality=0&compression=9", presenter.model.inputURL)
        assertEquals(BrowserLoadState.starting, presenter.model.load)
        assertEquals("br_starting", browserStateResource(presenter.model))
        assertEquals("br_you_sharing", browserSharerResource(presenter.model))
        assertTrue(presenter.hasFirstFrameTimer)
        presenter.videoFrameArrived(width = 1280, height = 720)
        assertEquals(BrowserLoadState.live, presenter.model.load)
        assertEquals("br_live", browserStateResource(presenter.model))
        assertEquals(1280, presenter.model.framebufferWidth)
        assertEquals(16.0 / 9.0, BrowserStagePresenter.aspectRatio(width = 1280, height = 720), 0.0001)

        val id = presenter.model.browserSessionId
        presenter.webViewFailed(browserSessionId = id, reloadSerial = 3, issue = BrowserLoadIssue.sslFailed)
        assertEquals(BrowserLoadState.live, presenter.model.load)
        presenter.webViewFailed(browserSessionId = id, reloadSerial = 0, issue = BrowserLoadIssue.rendererGone)
        assertEquals(BrowserLoadState.failed, presenter.model.load)
        assertEquals(BrowserFailure.loadFailed, presenter.model.failure)
        assertFalse(presenter.model.wantsWebView)
        assertNull(browserStateResource(presenter.model))
        assertEquals(ActivityTapResult.dispatched, presenter.retryLoad())
        assertEquals(1, presenter.model.reloadSerial)
        assertEquals(listOf("refresh"), sent)

        assertEquals(ActivityTapResult.explained, presenter.navigate("example .com"))
        assertEquals(BrowserValidation.spaces, presenter.model.validation)
        assertEquals(ActivityTapResult.dispatched, presenter.navigate("example.org"))
        assertEquals("br_navigating", browserStateResource(presenter.model))
        presenter.navigateFailed()
        assertEquals(FeedbackKind.hostActionFailed, presenter.feedbackState.token.kind)
        assertEquals(BrowserFailure.navigateFailed, presenter.model.commandFailure)
        assertEquals(ActivityTapResult.dispatched, presenter.confirmClose())
        assertEquals(ActivityTapResult.ignored, presenter.confirmClose())
        presenter.apply(inputs(active = false))
        assertFalse(presenter.model.closePending)
        assertEquals(listOf(id), ended)
        assertEquals(listOf("refresh", "navigate", "close"), sent)

        val viewer = BrowserStagePresenter()
        viewer.apply(inputs(controller = false, host = false))
        assertEquals(BrowserWebViewRole.none, viewer.model.webViewRole)
        assertFalse(viewer.model.wantsWebView)
        assertFalse(viewer.model.showsAddressRow)
        assertEquals("br_shared_by", browserSharerResource(viewer.model))
        assertEquals(ActivityTapResult.explained, viewer.focusKeyboard())
        // Viewers of a video surface never get a WebView (browser.inputViews = 0).
        assertNull(BrowserWebViewRegistry.webView(RuntimeEnvironment.getApplication(), viewer.model, viewer, 0))
        assertFalse(BrowserWebViewRegistry.hasWebView(viewer.model.browserSessionId))
        assertEquals(0, BrowserWebViewRegistry.progressFor(viewer.model.browserSessionId))

        val kitesurf = BrowserStagePresenter()
        kitesurf.apply(inputs(video = false, provider = "kitesurf", audio = true))
        assertEquals(BrowserSurfaceKind.liveView, kitesurf.model.surface)
        assertTrue(kitesurf.model.isKitesurf)
        assertFalse(kitesurf.model.showsAudioControl)
        assertEquals(base, kitesurf.model.inputURL)

        val recovering = BrowserStagePresenter()
        recovering.apply(inputs(reconnecting = true))
        assertEquals(BrowserLoadState.reconnecting, recovering.model.load)
        assertFalse(recovering.model.inputInteractive)
        assertEquals("br_reconnecting", browserStateResource(recovering.model))
    }

    @Test fun fixturesScriptEachStateWithoutTheNetwork() {
        for (state in BrowserStageFixtureState.entries) {
            val presenter = BrowserStagePresenter()
            val owner = BrowserFixtureOwner()
            BrowserStageFixtures.apply(named = state.rawValue, presenter = presenter, owner = owner)
            assertTrue(state.rawValue, presenter.model.isActive)
            assertEquals(state.rawValue, "", presenter.model.inputURL)
            when (state) {
                BrowserStageFixtureState.controller -> assertEquals(BrowserLoadState.live, presenter.model.load)
                BrowserStageFixtureState.viewer -> assertFalse(presenter.model.inputInteractive)
                BrowserStageFixtureState.starting -> assertEquals(BrowserLoadState.starting, presenter.model.load)
                BrowserStageFixtureState.failed -> assertEquals(BrowserLoadIssue.sslFailed, presenter.model.issue)
                BrowserStageFixtureState.rendererGone -> assertEquals(BrowserLoadIssue.rendererGone, presenter.model.issue)
                BrowserStageFixtureState.reconnecting -> assertEquals(BrowserLoadState.reconnecting, presenter.model.load)
                BrowserStageFixtureState.kitesurf -> assertFalse(presenter.model.showsAudioControl)
            }
        }
    }

    @Test fun everyBrowserCopyNameUsesAKnownPrefix() {
        val allowed = listOf("br_", "act_", "stg_", "ds_")
        for (name in browserStringResources) assertTrue(name, allowed.any { name.startsWith(it) })
        assertEquals(browserStringResources.size, browserStringResources.toSet().size)
        for (load in BrowserLoadState.entries) {
            val presenter = BrowserStagePresenter()
            presenter.apply(inputs(reconnecting = load == BrowserLoadState.reconnecting))
            val name = browserStateResource(presenter.model)
            if (name != null) assertTrue(name, browserStringResources.contains(name))
        }
        for (validation in BrowserValidation.entries) {
            val name = activitiesValidationResource(validation)
            if (name != null) assertTrue(name, browserStringResources.contains(name))
        }
        assertTrue(browserStringResources.contains(activitiesFailureResource(BrowserFailure.navigateFailed)!!))
    }
}
